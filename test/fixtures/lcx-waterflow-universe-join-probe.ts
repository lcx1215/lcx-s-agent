import assert from "node:assert/strict";
import { execFile, type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { vi } from "vitest";
import {
  auditWorkflowHandoffs,
  readProcessOwnerSource,
  type WorkflowFieldRef,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import { recordAgentArtifact } from "../../src/agents/artifact-result-recording.js";
import {
  compactCleanupReview,
  reviewCleanupBeforeDecision,
} from "../../src/agents/central-harness/cleanup-review-handoff.js";
import { buildWorkspaceSkillSnapshot } from "../../src/agents/skills.js";
import { resolveSkillAutoCue } from "../../src/auto-reply/reply/skill-autocue.js";
import { buildGlobalEvidenceProjection } from "../../src/shared/global-evidence-projection.js";
import * as ontology from "../../src/shared/lcx-ontology.js";
import * as receipts from "../../src/shared/lcx-run-receipt.js";

const sourceRoot = path.resolve(import.meta.dirname, "../..");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type Row = Record<string, unknown>;
type OwnerRun = {
  id: string;
  ok?: boolean;
  compact: Row;
  payload?: Row;
  runReceipt: receipts.LcxRunReceipt;
};
type Review = Awaited<ReturnType<typeof reviewCleanupBeforeDecision>>["review"];
export type UniverseJoinFault = "missing_source" | "hash_conflict";

/** Native private owners and original join. Missing source is deliberately never replaced by a pass. */
export async function probeUniverseJoin(root: string, fault?: UniverseJoinFault) {
  // Reserve the original native owner's full 30s within the caller's 90s budget.
  // Preparation cannot consume the owner window; both phases still finish by 80s.
  const startedAt = performance.now();
  const preparationSignal = AbortSignal.timeout(45_000);
  let processSignal = preparationSignal;
  let ownerStartedAt: number | undefined;
  const sourceHashes: Record<string, string> = {};
  const sourceTexts: Record<string, string> = {};
  const readSource = async (relative: string) => {
    const raw = await fs.readFile(path.join(sourceRoot, relative), "utf8");
    sourceHashes[relative] = sha(raw);
    sourceTexts[relative] = raw;
    return raw;
  };
  const processes: Array<{
    command: string;
    args: string[];
    timeoutMs: number;
    pid?: number;
    closeObserved: boolean;
    stdioClosed: boolean;
    code?: number | null;
    signal?: string | null;
  }> = [];
  const denied: Array<{ script: string; args: string[]; reason: string }> = [];
  const sourceCalls: Array<{ id: string; args: string[]; stdout: string; exitCode: number }> = [];
  const execute = async (command: string, args: string[], options: ExecFileOptions = {}) => {
    processSignal.throwIfAborted();
    const script = args.find((arg) => arg.endsWith(".ts"));
    assert.ok(
      command === "git" ||
        command === "rg" ||
        (command === process.execPath &&
          script &&
          ["lcx-universe-index.ts", "lcx-change-impact-plan.ts"].includes(path.basename(script))),
      `process_not_allowlisted:${command}:${script}`,
    );
    assert.notEqual("detached" in options ? options.detached : false, true);
    const timeoutLimitMs =
      command === process.execPath && script && path.basename(script) === "lcx-universe-index.ts"
        ? 30_000
        : 20_000;
    const timeoutMs = Math.min(Number(options.timeout) || timeoutLimitMs, timeoutLimitMs);
    const observation: (typeof processes)[number] = {
      command,
      args,
      timeoutMs,
      closeObserved: false,
      stdioClosed: false,
    };
    processes.push(observation);
    let closed = Promise.resolve();
    const response = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let markClosed: () => void = () => {};
      closed = new Promise<void>((done) => {
        markClosed = done;
      });
      const child = execFile(
        command,
        args,
        {
          ...options,
          signal: options.signal ? AbortSignal.any([processSignal, options.signal]) : processSignal,
          timeout: timeoutMs,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            error.message += `\nprivate_process_stderr=${stderr.slice(-2000)}`;
            error.message += `\nprivate_process_failure=${JSON.stringify({ code: error.code, signal: error.signal, killed: error.killed, timeoutMs })}`;
            reject(Object.assign(error, { stdout, stderr }));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
      observation.pid = child.pid;
      child.once("close", (code, signal) => {
        observation.closeObserved = true;
        observation.code = code;
        observation.signal = signal;
        observation.stdioClosed = child.stdio.every(
          (stream) => stream !== undefined && (stream === null || stream.destroyed),
        );
        markClosed();
      });
    });
    try {
      return await response;
    } finally {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closed,
        new Promise<void>((done) => {
          timer = setTimeout(done, 1_000);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
  // Reuse the original phase probe body, with its lowest process transport narrowed
  // to <=20 seconds. No old result, scope or receipt is imported into this run.
  const probeSource = await readSource("test/fixtures/lcx-waterflow-universe-whole-probe.ts");
  const probeAst = ts.createSourceFile("phase-probe.ts", probeSource, ts.ScriptTarget.Latest, true);
  const probeFunction = probeAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "probeUniverseWhole",
  );
  assert.ok(probeFunction && ts.isFunctionDeclaration(probeFunction) && probeFunction.body);
  const cliBoundary = probeFunction.body.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "cliBytes",
      ),
  );
  assert.ok(cliBoundary);
  let signalPrepared: () => void = () => {};
  let releasePhase: () => void = () => {};
  const prepared = new Promise<void>((resolve) => {
    signalPrepared = resolve;
  });
  const ownerStarted = new Promise<void>((resolve) => {
    releasePhase = resolve;
  });
  const phaseBindings = {
    fs,
    path,
    ts,
    vm,
    sourceRoot,
    sourcePath: "scripts/operator/lcx-universe-index.ts",
    process: { execPath: process.execPath, env: { PATH: process.env.PATH, NODE_ENV: "test" } },
    nativeExec: execute,
    auditWorkflowHandoffs,
    sha,
    randomUUID: () =>
      receipts.createLcxRunId({
        checkedAt: new Date().toISOString(),
        owner: "offline_phase_observation",
      }),
    clone: (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown,
    waitForActualOwnerCall: async () => {
      signalPrepared();
      await ownerStarted;
    },
  };
  const offset = cliBoundary.getStart(probeAst) - probeFunction.getStart(probeAst);
  const unchangedHelper = probeFunction.getText(probeAst);
  const gatedHelper =
    unchangedHelper.slice(0, offset) +
    "await waitForActualOwnerCall();\n" +
    unchangedHelper.slice(offset);
  const phaseCode = ts.transpile(gatedHelper.replace(/^export\s+/u, ""), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  });
  const runPhase = vm.compileFunction(
    `${phaseCode}\nreturn probeUniverseWhole;`,
    Object.keys(phaseBindings),
  )(...Object.values(phaseBindings)) as (
    directory: string,
    proof: string,
  ) => Promise<{
    observed: Row;
    evidence: WorkflowHandoffEvidence;
    sourceHashes: Record<string, string>;
  }>;
  const privateRoot = path.join(root, "private");
  await fs.mkdir(privateRoot, { recursive: true });
  const phasePromise = runPhase(privateRoot, path.join(root, "phase"));
  await Promise.race([
    prepared,
    phasePromise.then(() => {
      throw new Error("original_phase_started_without_owner_call");
    }),
  ]);
  let phase: Awaited<ReturnType<typeof runPhase>> | undefined;
  const repo = path.join(privateRoot, "repo");
  const home = path.join(privateRoot, "home");
  const workspace = path.join(home, ".openclaw/workspace");
  // Replace only the private source symlink before copying original source bytes.
  // Never write through it into the shared worktree. No live state/config is copied.
  const privateSrc = path.join(repo, "src");
  assert.equal((await fs.lstat(privateSrc)).isSymbolicLink(), true);
  assert.equal(await fs.realpath(privateSrc), await fs.realpath(path.join(sourceRoot, "src")));
  await fs.unlink(privateSrc);
  const copiedArchitecture: Array<{ path: string; sha256: string }> = [];
  const hostLoopSource = await readProcessOwnerSource("host-installed:lcx-local-operator-loop.sh");
  if (hostLoopSource) {
    const privateBin = path.join(home, ".openclaw/bin");
    await fs.mkdir(privateBin, { recursive: true });
    await fs.writeFile(path.join(privateBin, "lcx-local-operator-loop.sh"), hostLoopSource);
    copiedArchitecture.push({
      path: "host-installed:lcx-local-operator-loop.sh",
      sha256: sha(hostLoopSource),
    });
  }
  const sourceAreas = [
    "src",
    "docs",
    "ops",
    "scripts",
    "test",
    ".agents",
    "skills",
    "extensions/external",
  ];
  // Copy original indexed source, not ignored dependency trees or private fixture outputs.
  const listed = await execute("git", ["ls-files", "--stage", "-z", "--", ...sourceAreas], {
    cwd: sourceRoot,
  });
  const indexed = listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\t");
      assert.ok(separator > 0, "indexed_source_metadata_missing");
      const [mode, , stage] = entry.slice(0, separator).split(" ");
      assert.equal(stage, "0", "conflicted_source_cannot_form_private_snapshot");
      return { file: entry.slice(separator + 1), symlink: mode === "120000" };
    });
  const indexedFiles = indexed.map((entry) => entry.file);
  const existingAreas: string[] = [];
  const rootFiles: string[] = [];
  for (const area of sourceAreas) {
    if (fsSync.existsSync(path.join(sourceRoot, area))) {
      await fs.mkdir(path.join(repo, area), { recursive: true });
      existingAreas.push(area);
    }
  }
  // Indexed regular files need only a byte copy, not a recursive cp per path.
  // Create each parent once; preserve actual symlinks without sharing writable inodes.
  const parents = [...new Set(indexedFiles.map((file) => path.dirname(path.join(repo, file))))];
  for (let offset = 0; offset < parents.length; offset += 32) {
    preparationSignal.throwIfAborted();
    const created = await Promise.allSettled(
      parents
        .slice(offset, offset + 32)
        .map((directory) => fs.mkdir(directory, { recursive: true })),
    );
    const failure = created.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }
  for (let offset = 0; offset < indexed.length; offset += 32) {
    preparationSignal.throwIfAborted();
    const copies = await Promise.allSettled(
      indexed.slice(offset, offset + 32).map(async ({ file, symlink }) => {
        const source = path.join(sourceRoot, file);
        const destination = path.join(repo, file);
        if (symlink && (await fs.lstat(source)).isSymbolicLink()) {
          await fs.cp(source, destination, { verbatimSymlinks: true });
        } else {
          await fs.copyFile(source, destination);
        }
      }),
    );
    const failure = copies.find((copy) => copy.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }
  for (const file of ["AGENTS.md", "README.md", "package.json", "tsconfig.json", ".gitignore"]) {
    if (fsSync.existsSync(path.join(sourceRoot, file))) {
      const bytes = await fs.readFile(path.join(sourceRoot, file));
      await fs.writeFile(path.join(repo, file), bytes);
      copiedArchitecture.push({ path: file, sha256: sha(bytes) });
      rootFiles.push(file);
      existingAreas.push(file);
    }
  }
  // Preserve copied fixture bytes independently of the host Git newline policy.
  // Windows autocrlf warnings can otherwise exhaust execFile's stderr buffer.
  // A NUL-delimited pathspec keeps exact filenames out of Windows argv limits
  // without spawning dozens of tiny Git processes. Each Git child retains 20s.
  const pathsToStage = [...indexedFiles, ...rootFiles];
  const pathspec = path.join(root, "architecture-stage-paths.bin");
  preparationSignal.throwIfAborted();
  await fs.writeFile(pathspec, pathsToStage.join("\0") + "\0", { mode: 0o600 });
  await execute(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "add",
      "--force",
      `--pathspec-from-file=${pathspec}`,
      "--pathspec-file-nul",
    ],
    { cwd: repo },
  );
  await fs.rm(pathspec);
  await execute(
    "git",
    [
      "-c",
      "user.name=Offline Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "freeze exact original architecture input bytes",
    ],
    { cwd: repo },
  );
  await fs.appendFile(
    path.join(repo, "test/changed.test.ts"),
    "// actual changed input after architecture freeze\n",
  );
  const configPath = path.join(home, ".openclaw/openclaw.json");
  const config = {
    plugins: { enabled: false },
    agents: {
      defaults: {
        workspace,
        memorySearch: {
          enabled: true,
          store: { path: path.join(workspace, "private-artifacts.sqlite") },
        },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    HOME: home,
    LCX_USER_HOME: home,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
  };
  const nativeModules: Array<{ path: string; moduleUrl: string; sha256: string }> = [];
  const isolateModule = async (relative: string, dependencies: Row, entry: string) => {
    const raw = await readSource(relative);
    const ast = ts.createSourceFile(relative, raw, ts.ScriptTarget.Latest, true);
    const statements = ast.statements.filter(
      (node) =>
        !ts.isImportDeclaration(node) &&
        !(ts.isIfStatement(node) && node.getText(ast).includes("import.meta.url")),
    );
    const moduleUrl = pathToFileURL(path.join(repo, relative)).href;
    const body = statements
      .map((node) => node.getText(ast))
      .join("\n")
      .replaceAll("import.meta.url", JSON.stringify(moduleUrl))
      .replace(/^export\s+/gmu, "");
    nativeModules.push({ path: relative, moduleUrl, sha256: sha(raw) });
    const code = ts.transpile(body, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
    return vm.compileFunction(
      `${code}\nreturn ${entry};`,
      Object.keys(dependencies),
    )(...Object.values(dependencies)) as (...args: unknown[]) => unknown;
  };
  const common = {
    fs,
    fsSync,
    path,
    ts,
    fileURLToPath,
    pathToFileURL,
    createHash,
    ...ontology,
    LCX_USER_HOME: home,
  };
  const ontologyAudit = await isolateModule(
    "scripts/operator/lcx-ontology.ts",
    common,
    "buildOntologyAudit",
  );
  const skillInputs: Array<{
    workspace: string;
    managed: string;
    bundled: string;
    personalHome: string;
  }> = [];
  const privateSkillSnapshot = (...args: Parameters<typeof buildWorkspaceSkillSnapshot>) => {
    const managed = path.join(home, ".openclaw/skills");
    const bundled = path.join(repo, "skills");
    skillInputs.push({ workspace: args[0], managed, bundled, personalHome: home });
    const homeLookup = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      return buildWorkspaceSkillSnapshot(args[0], {
        ...args[1],
        managedSkillsDir: managed,
        bundledSkillsDir: bundled,
      });
    } finally {
      homeLookup.mockRestore();
    }
  };
  const runNativeModule = async (id: string, args: string[]) => {
    const filenames: Record<string, string> = {
      mindModel: "lcx-mind-model.ts",
      flowGraph: "lcx-flow-graph.ts",
      contextRecovery: "lcx-context-recovery-exam.ts",
    };
    const filename = filenames[id];
    assert.ok(filename);
    let stdout = "";
    const localProcess = {
      argv: [process.execPath, path.join(repo, "scripts/operator", filename), ...args],
      execPath: process.execPath,
      env,
      exitCode: 0,
      stdout: {
        write: (bytes: string) => {
          stdout += bytes;
        },
      },
    };
    const childExecute = async (_command: string, childArgs: string[]) => {
      const script = childArgs.find((arg) => arg.endsWith(".ts")) ?? "missing-script";
      const childId = Object.entries(filenames).find(
        ([, name]) => name === path.basename(script),
      )?.[0];
      if (childId && childId !== "contextRecovery") {
        const returned = await runNativeModule(
          childId,
          childArgs.slice(childArgs.indexOf(script) + 1),
        );
        if (returned.exitCode !== 0) {
          throw Object.assign(new Error(`private_native_owner_failed:${childId}`), {
            stdout: returned.stdout,
            stderr: "",
          });
        }
        return { stdout: returned.stdout, stderr: "" };
      }
      if (["lcx-universe-index.ts", "lcx-change-impact-plan.ts"].includes(path.basename(script))) {
        return execute(process.execPath, childArgs, {
          cwd: repo,
          env,
          maxBuffer: 64 * 1024 * 1024,
        });
      }
      const reason = `private_child_not_allowlisted:${path.basename(script)}`;
      denied.push({ script, args: childArgs, reason });
      throw new Error(reason);
    };
    const entry = await isolateModule(
      `scripts/operator/${filename}`,
      {
        ...common,
        process: localProcess,
        buildOntologyAudit: ontologyAudit,
        buildGlobalEvidenceProjection,
        buildWorkspaceSkillSnapshot: privateSkillSnapshot,
        resolveSkillAutoCue,
        loadConfig: () => JSON.parse(fsSync.readFileSync(configPath, "utf8")) as unknown,
        CONFIG_DIR: path.join(home, ".openclaw"),
        resolveLocalOperatorLatestPath: () =>
          path.join(workspace, "state/lcx-local-operator-latest.json"),
        SELF_REPAIR_HANDS_JSONL_PATH: path.join(workspace, "state/lcx-self-repair-hands.jsonl"),
        SELF_REPAIR_HANDS_LATEST_PATH: path.join(
          workspace,
          "state/lcx-self-repair-hands-latest.json",
        ),
        SELF_REPAIR_HANDS_MARKDOWN_PATH: path.join(
          workspace,
          "state/lcx-self-repair-hands-latest.md",
        ),
        execFile: childExecute,
        promisify: () => childExecute,
      },
      "main",
    );
    await entry();
    assert.ok(stdout.trim(), `native_owner_missing_stdout:${id}`);
    const returned = { id, args, stdout, exitCode: localProcess.exitCode };
    sourceCalls.push(returned);
    return returned;
  };
  const checkedAt = new Date().toISOString();
  const git = await execute("git", ["rev-parse", "HEAD"], { cwd: repo, env });
  const branch = await execute("git", ["branch", "--show-current"], { cwd: repo, env });
  const snapshot = receipts.createLcxRunSnapshot({
    sourceCommit: git.stdout.trim(),
    sourceBranch: branch.stdout.trim(),
    observedAt: checkedAt,
    authorityOwner: "lcx-governance-autopilot",
  });
  const parentRunId = receipts.createLcxRunId({ checkedAt, owner: "lcx-governance-autopilot" });
  const callerInputs: Array<{
    id: string;
    args: string[];
    parentRunId: string;
    snapshot: receipts.LcxRunSnapshot;
  }> = [];
  const governanceSource = await readSource("scripts/operator/lcx-governance-autopilot.ts");
  const ast = ts.createSourceFile("governance.ts", governanceSource, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "recordValue",
    "arrayValue",
    "stringArray",
    "decisionIds",
    "compactOwner",
    "ownerRunStatus",
    "ownerNextAction",
    "ownerBoundary",
    "ownerEvidence",
    "buildOwnerRunReceipt",
    "ownerRunFromPayload",
    "captureOwnerRun",
    "runOwner",
  ]);
  const functions = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""),
  );
  assert.equal(functions.length, names.size);
  const commands = [
    {
      id: "universeIndex",
      script: "scripts/operator/lcx-universe-index.ts",
      args: ["--json", "--no-write"],
      required: true,
    },
    ...["mindModel", "flowGraph", "contextRecovery"].map((id) => ({
      id,
      script: `scripts/operator/${{ mindModel: "lcx-mind-model.ts", flowGraph: "lcx-flow-graph.ts", contextRecovery: "lcx-context-recovery-exam.ts" }[id]}`,
      args: id === "contextRecovery" ? ["--handoff", "--json"] : ["--json"],
      required: true,
    })),
    {
      id: "changeImpact",
      script: "scripts/operator/lcx-change-impact-plan.ts",
      args: ["--json"],
      required: true,
    },
  ];
  const ownerExecute = async (_command: string, args: string[]) => {
    if (ownerStartedAt === undefined) {
      preparationSignal.throwIfAborted();
      ownerStartedAt = performance.now();
      processSignal = AbortSignal.timeout(35_000);
    }
    const command = commands.find((item) => args.includes(item.script));
    assert.ok(command, `governance_child_not_allowlisted:${args.join(" ")}`);
    const ownerArgs = args.slice(args.indexOf(command.script) + 1);
    callerInputs.push({ id: command.id, args: ownerArgs, parentRunId, snapshot });
    if (command.id === "universeIndex") {
      releasePhase();
      phase = await phasePromise;
      Object.assign(sourceHashes, phase.sourceHashes);
      const stdout = JSON.stringify(phase.observed);
      sourceCalls.push({
        id: command.id,
        args: ownerArgs,
        stdout,
        exitCode: phase.observed.ok === true ? 0 : 1,
      });
      if (phase.observed.ok !== true) {
        throw Object.assign(new Error("native_universe_failed"), { stdout, stderr: "" });
      }
      return { stdout, stderr: "" };
    }
    if (command.id === "changeImpact") {
      return execute(process.execPath, args, { cwd: repo, env, maxBuffer: 16 * 1024 * 1024 });
    }
    const result = await runNativeModule(command.id, ownerArgs);
    if (result.exitCode) {
      throw Object.assign(new Error(`native_owner_failed:${command.id}`), {
        stdout: result.stdout,
        stderr: "",
      });
    }
    return { stdout: result.stdout, stderr: "" };
  };
  const bindings = {
    ...receipts,
    compactCleanupReview,
    recordAgentArtifact,
    reviewCleanupBeforeDecision,
    compactFlowGraphOwner: (await import("../../src/agents/central-harness/governance-input.js"))
      .compactFlowGraphOwner,
    process: { execPath: process.execPath, env },
    repoRoot: repo,
    DEFAULT_WORKSPACE_DIR: workspace,
    EXEC_MAX_BUFFER: 64 * 1024 * 1024,
    ownerArtifactRecordingConfig: config,
    OWNER_COMMANDS: commands,
    SAME_CYCLE_OWNER_PAYLOAD_IDS: new Set([
      "mindModel",
      "flowGraph",
      "contextRecovery",
      "changeImpact",
    ]),
    execFileAsync: ownerExecute,
  };
  const code = ts.transpile(functions.map((node) => node.getText(ast)).join("\n"), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  });
  const functionsHost = vm.compileFunction(
    `${code}\nreturn { runOwner, ownerRunFromPayload, captureOwnerRun };`,
    Object.keys(bindings),
  )(...Object.values(bindings)) as Row;
  const runOwner = functionsHost.runOwner as (
    command: unknown,
    scope: unknown,
  ) => Promise<OwnerRun>;
  const directOwners = await Promise.all(
    commands.map((command) => runOwner(command, { parentRunId, snapshot })),
  );
  assert.ok(phase, JSON.stringify(directOwners.find((owner) => owner.id === "universeIndex")));
  const before = structuredClone(directOwners);
  for (const owner of before) {
    assert.equal(owner.runReceipt.parentRunId, parentRunId);
  }
  const target = directOwners.find((owner) => owner.id === "universeIndex")!;
  const archive = target.compact.artifactEvidence as { relativePath: string };
  const faultPath = path.join(workspace, archive.relativePath);
  const preservedSource = await fs.readFile(faultPath);
  if (fault === "missing_source") {
    await fs.unlink(faultPath);
  }
  if (fault === "hash_conflict") {
    await fs.appendFile(faultPath, "\n");
  }
  const changeImpactIndex = directOwners.findIndex((owner) => owner.id === "changeImpact");
  const impactRun = directOwners[changeImpactIndex];
  const join = ast.statements.find(
    (node) =>
      ts.isIfStatement(node) && node.getText(ast).includes("await reviewCleanupBeforeDecision"),
  );
  assert.ok(join);
  const joinBindings = {
    ...bindings,
    ...functionsHost,
    directOwners,
    directOwnerCommands: commands,
    changeImpactIndex,
    impactRun,
    governanceRunId: parentRunId,
    governanceSnapshot: snapshot,
  };
  const joinCode = ts.transpile(`return (async () => { ${join.getText(ast)} })();`, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  });
  await vm.compileFunction(joinCode, Object.keys(joinBindings))(...Object.values(joinBindings));
  const received = directOwners[changeImpactIndex];
  const review = received.payload?.cleanupReview as Review;
  assert.ok(review);
  const resultPath = path.join(root, "actual-native-join.json");
  const phaseTrace = JSON.parse(
    await fs.readFile(phase.evidence.nodes[0].scope.path, "utf8"),
  ) as Row;
  const data = {
    parentRunId,
    snapshot,
    timing: {
      preparationMs: Math.round((ownerStartedAt ?? performance.now()) - startedAt),
      ownerPhaseMs: Math.round(performance.now() - (ownerStartedAt ?? startedAt)),
      preparationBudgetMs: 45_000,
      ownerPhaseBudgetMs: 35_000,
    },
    fault,
    callerInputs,
    sourceCalls,
    processes,
    denied,
    before,
    received,
    review,
    sourceHashes,
    nativeModules,
    skillInputs,
    copiedArchitecture,
    copiedArchitectureAreas: existingAreas,
    phaseTrace,
    phaseCallTiming:
      "private inputs prepared first; original runOwner actually invoked, then original Universe CLI and phase main released before any owner verdict existed",
    sourceExecution:
      "exact original module declarations with private module URL/config/IO and strict lowest execFile transport; no source verdict rewritten",
    scopeLimit:
      "host parent identifies this actual selected original owner batch, not full governance execution or semantic source truth",
    cleanup: {
      directChildCloseObserved: processes.every((item) => item.closeObserved && item.stdioClosed),
      descendants: "cleanup_unconfirmed_not_observed",
      modelProviderChannelCalls: "not_invoked_by_allowed_original_filesystem_sources",
    },
    positiveRecovery: "not_observed",
    naturalAdoption: "not_proven",
  };
  const bytes = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(resultPath, bytes);
  const ref = (pointer: string): WorkflowFieldRef => ({
    path: resultPath,
    pointer,
    sha256: sha(bytes),
  });
  const evidence = structuredClone(phase.evidence);
  for (const node of evidence.nodes) {
    for (const item of [
      node.scope,
      node.output,
      ...(node.outputs ?? []).map((port) => port.value),
      ...(node.inputs ?? []).map((port) => port.value),
    ]) {
      if (item) {
        item.path = resultPath;
        item.pointer = `/phaseTrace${item.pointer}`;
        item.sha256 = sha(bytes);
      }
    }
    node.scope = ref("/parentRunId");
  }
  const producers = [
    ["universeIndex", "universe_index"],
    ["mindModel", "mind_model"],
    ["flowGraph", "flow_graph"],
    ["contextRecovery", "fixed_evidence_recovery"],
  ] as const;
  for (const [id, nodeId] of producers) {
    const ownerIndex = before.findIndex((owner) => owner.id === id);
    const node = evidence.nodes.find((candidate) => candidate.nodeId === nodeId);
    const output = ref(`/before/${ownerIndex}/runReceipt`);
    if (node) {
      node.outputs = [...(node.outputs ?? []), { to: "cleanup_candidate_review", value: output }];
    } else {
      evidence.nodes.push({ nodeId, scope: ref("/parentRunId"), output });
    }
  }
  evidence.nodes.push({
    nodeId: "cleanup_candidate_review",
    scope: ref("/review/scope/parentRunId"),
    output: ref("/review"),
    block: {
      filter: "owner_coverage_required",
      status: ref("/review/status"),
      reason: ref("/review/reason"),
    },
    inputs: producers.flatMap(([id, nodeId]) => {
      const index = review.sourceReads.findIndex(
        (read) => read.pointer === `/value/byOwner/${id}/runReceipt`,
      );
      return index < 0 ? [] : [{ from: nodeId, value: ref(`/review/sourceReads/${index}/value`) }];
    }),
  });
  const impact = evidence.nodes.find((node) => node.nodeId === "change_impact_plan")!;
  impact.inputs = [
    ...(impact.inputs ?? []),
    { from: "cleanup_candidate_review", value: ref("/received/payload/cleanupReview") },
  ];
  // Field refs still describe real reads only: failed source can stop the review
  // before later sibling contents. Those edges must remain gaps in the auditor.
  const audit = (await auditWorkflowHandoffs([evidence])).find(
    (row) => row.scenarioId === evidence.scenarioId,
  )!;
  await fs.writeFile(
    path.join(root, "actual-fieldrefs.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await fs.writeFile(path.join(root, "actual-audit.json"), JSON.stringify(audit, null, 2) + "\n");
  // Retain the exact pre-fault bytes independently, without repairing the source
  // before its failure has been observed and sealed by the original consumer.
  await fs.writeFile(path.join(root, "source-before-fault.json"), preservedSource);
  await fs.mkdir(path.join(root, "frozen-source"), { recursive: true });
  for (const [relative, text] of Object.entries(sourceTexts)) {
    const destination = path.join(root, "frozen-source", relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, text);
  }
  return { ...data, audit, evidence, resultPath };
}
