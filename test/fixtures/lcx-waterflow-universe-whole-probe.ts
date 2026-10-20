import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";

const nativeExec = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = "scripts/operator/lcx-universe-index.ts";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const clone = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
export type UniverseWholeFault = "missing_owner" | "unmatched" | "git_timeout";
type Call = { owner: string; args: unknown[]; result?: unknown };
type Receipt = {
  ok: boolean;
  ownerDeadline: { status: string; cleanupStatus: string; failureSources: string[] };
  repo: {
    changedFiles: string[];
    trackedAndVisibleFileCount: number;
    trackedInventory: { ok: boolean; error?: string };
    gitStatusInventory: { ok: boolean; error?: string };
    visibleInventory: { ok: boolean; error?: string };
  };
  ownerCoverage: {
    changeImpact: { ok: boolean; source: string; unmatchedFiles: string[] };
    governanceCoverage: {
      status: string;
      components: Array<{ path: string }>;
      routeOwnerValidation: { missing: string[] };
    };
  };
  artifacts: Record<string, { sourceStatus: string; fileCount: number }>;
};

/** Original bodies, actual private git/fs/child process. Instrumented run is separate from unchanged CLI. */
export async function probeUniverseWhole(
  root: string,
  proofDir: string,
  fault?: UniverseWholeFault,
) {
  root = await fs.realpath(root);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const workspace = path.join(home, ".openclaw/workspace");
  await fs.mkdir(path.join(repo, "scripts/operator"), { recursive: true });
  await fs.mkdir(path.join(repo, "test"));
  await fs.mkdir(path.join(workspace, "state"), { recursive: true });
  const copied = [
    sourcePath,
    "scripts/operator/lcx-local-paths.ts",
    "scripts/operator/lcx-change-impact-plan.ts",
    "scripts/operator/lcx-flow-graph.ts",
    "scripts/operator/lcx-commercial-answer-pipeline.ts",
    "scripts/operator/lcx-directed-daily-research-brief.ts",
    "scripts/operator/lcx-finance-research-checkpoint-run.ts",
    "scripts/operator/lcx-problem-cluster-radar.ts",
    "scripts/operator/lcx-external-channel-status.ts",
  ];
  const sourceHashes: Record<string, string> = {};
  for (const file of copied) {
    const bytes = await fs.readFile(path.join(sourceRoot, file));
    await fs.writeFile(path.join(repo, file), bytes);
    sourceHashes[file] = sha(bytes);
  }
  // Dependencies are read-only symlinks. Never create fixture files inside them.
  await fs.symlink(path.join(sourceRoot, "src"), path.join(repo, "src"));
  await fs.symlink(path.join(sourceRoot, "node_modules"), path.join(repo, "node_modules"));
  await fs.writeFile(path.join(repo, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(repo, "test/unchanged.test.ts"), "// unchanged fixture\n");
  await fs.writeFile(path.join(repo, "test/changed.test.ts"), "// initial fixture\n");
  const env: NodeJS.ProcessEnv = { ...process.env, LCX_USER_HOME: home };
  const git = (args: string[]) => nativeExec("git", args, { cwd: repo, env, timeout: 10_000 });
  await git(["init", "--quiet"]);
  await fs.writeFile(path.join(repo, ".git/info/exclude"), "/src\n/node_modules\n");
  await git(["add", "scripts", "test", "package.json"]);
  await git([
    "-c",
    "user.name=Offline Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "private offline baseline",
  ]);
  await fs.appendFile(path.join(repo, "test/changed.test.ts"), "// actual changed bytes\n");
  const artifactBody =
    '{"kind":"synthetic-private-inventory","content":"inventory is not semantic acceptance"}\n';
  await fs.writeFile(path.join(workspace, "state/sample.json"), artifactBody);
  if (fault === "missing_owner") {
    await fs.unlink(path.join(repo, "scripts/operator/lcx-external-channel-status.ts"));
  }
  if (fault === "unmatched") {
    await fs.mkdir(path.join(repo, "unknown-fixture"));
    await fs.writeFile(path.join(repo, "unknown-fixture/unknown.zzz"), "unmapped\n");
  }
  const slowProcessArgs = ["-e", "setTimeout(() => {}, 10000)"];
  const processFaultHook = path.join(root, "private-git-delay.cjs");
  if (fault === "git_timeout") {
    // Substitute only the Git child with an actual slow Node child. A shell
    // executable on PATH cannot intercept git.exe on Windows.
    await fs.writeFile(
      processFaultHook,
      `const cp = require('node:child_process');
const { promisify } = require('node:util');
const { syncBuiltinESMExports } = require('node:module');
const original = cp.execFile;
const originalAsync = promisify(original);
const slowArgs = ${JSON.stringify(slowProcessArgs)};
function delayed(command, args, options, callback) {
  return command === 'git'
    ? original(process.execPath, slowArgs, options, callback)
    : original(command, args, options, callback);
}
delayed[promisify.custom] = (command, args, options) => command === 'git'
  ? originalAsync(process.execPath, slowArgs, options)
  : originalAsync(command, args, options);
cp.execFile = delayed;
syncBuiltinESMExports();
`,
    );
  }
  let cliBytes = "";
  let cliExitCode: unknown = 0;
  let cliTimedOut = false;
  let cliError = "";
  try {
    ({ stdout: cliBytes } = await nativeExec(
      process.execPath,
      [
        ...(fault === "git_timeout" ? ["--require", processFaultHook] : []),
        "--import",
        "tsx",
        path.join(repo, sourcePath),
        "--json",
        "--no-write",
        ...(fault === "git_timeout" ? ["--timeout-ms", "80"] : []),
      ],
      {
        cwd: repo,
        env,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    ));
  } catch (error) {
    const details = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: unknown;
      killed?: boolean;
    };
    cliBytes = details.stdout ?? "";
    cliError = String(error) + "\n" + (details.stderr ?? "");
    cliExitCode = details.code;
    cliTimedOut = details.killed === true;
  }
  await fs.mkdir(proofDir, { recursive: true });
  await fs.writeFile(path.join(proofDir, "native-cli.stdout"), cliBytes);
  await fs.writeFile(path.join(proofDir, "native-cli.error"), cliError);
  if (!cliBytes.trim()) {
    throw new Error(cliError);
  }
  const cli = JSON.parse(cliBytes) as Receipt;
  const source = await fs.readFile(path.join(sourceRoot, sourcePath), "utf8");
  if (sha(source) !== sourceHashes[sourcePath]) {
    throw new Error("original_source_changed_between_cli_and_instrumented_run");
  }
  const ast = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const functions = ast.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name);
  const rules = ast.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (item) => ts.isIdentifier(item.name) && item.name.text === "GOVERNANCE_COMPONENT_RULES",
      ),
  );
  if (!rules) {
    throw new Error("original_governance_rules_not_found");
  }
  const phaseObservations: Record<string, unknown> = {};
  const instrumentOriginalMain = (node: ts.FunctionDeclaration): string => {
    if (!node.body) {
      throw new Error("original_main_body_missing");
    }
    const declared = (statement: ts.Statement, name: string) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (item) => ts.isIdentifier(item.name) && item.name.text === name,
      );
    const statements: ts.Statement[] = [];
    const visit = (candidate: ts.Node) => {
      if (ts.isVariableStatement(candidate)) {
        statements.push(candidate);
      }
      ts.forEachChild(candidate, visit);
    };
    visit(node.body);
    const union = statements.find((statement) => declared(statement, "repoComponentFiles"));
    const result = statements.find((statement) => declared(statement, "result"));
    if (!union || !result) {
      throw new Error("original_phase_boundary_missing");
    }
    const start = node.getStart(ast);
    let text = node.getText(ast);
    const insertions = [
      {
        offset: union.end - start,
        text: '\n capturePhase("repoComponentFiles", repoComponentFiles);',
      },
      {
        offset: result.getStart(ast) - start,
        text: 'capturePhase("validatedOwnerCoverage", governanceCoverage);\n',
      },
    ].toSorted((a, b) => b.offset - a.offset);
    for (const insertion of insertions) {
      text = text.slice(0, insertion.offset) + insertion.text + text.slice(insertion.offset);
    }
    return text;
  };
  const body = [
    rules.getText(ast),
    ...functions.map((node) =>
      (node.name?.text === "main" ? instrumentOriginalMain(node) : node.getText(ast)).replace(
        /^export\s+/u,
        "",
      ),
    ),
  ].join("\n");
  const calls: Call[] = [];
  let observedBytes = "";
  const hostRunId = randomUUID();
  const context = vm.createContext({
    fs,
    path,
    AbortController,
    setTimeout,
    clearTimeout,
    repoRoot: repo,
    EXEC_MAX_BUFFER: 64 * 1024 * 1024,
    STALE_ARTIFACT_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    LARGE_ARTIFACT_BYTES: 50 * 1024 * 1024,
    DEFAULT_WORKSPACE_DIR: workspace,
    DEFAULT_WORKSPACE_LOG_DIR: path.join(workspace, "logs"),
    EXTERNAL_CHANNEL_RUNTIME_ROOT: path.join(
      home,
      ".openclaw/external-channel-runtime/lcx-s-openclaw",
    ),
    UNIVERSE_INDEX_LATEST_PATH: path.join(workspace, "state/lcx-universe-index-latest.json"),
    resolveLocalOperatorLatestPath: () =>
      path.join(workspace, "state/lcx-local-operator-latest.json"),
    process: {
      argv: [
        process.execPath,
        sourcePath,
        "--json",
        "--no-write",
        ...(fault === "git_timeout" ? ["--timeout-ms", "80"] : []),
      ],
      env,
      execPath: process.execPath,
      stdout: {
        write: (value: string) => {
          observedBytes += value;
        },
      },
      exitCode: 0,
    },
    execFileAsync: (command: string, args: string[], options: object) =>
      fault === "git_timeout" && command === "git"
        ? nativeExec(process.execPath, slowProcessArgs, { ...options, env })
        : nativeExec(command, args, { ...options, env }),
    capturePhase: (name: string, value: unknown) => {
      phaseObservations[name] = clone(value);
    },
    record: (call: Call) => {
      calls.push(call);
    },
    clone,
  });
  vm.runInContext(
    ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).outputText,
    context,
  );
  for (const node of functions.filter((item) => item.name?.text !== "main")) {
    const name = node.name!.text;
    vm.runInContext(
      `{ const original = ${name}; ${name} = function(...args) { const call = { owner: ${JSON.stringify(name)}, args: clone(args) }; record(call); const result = original(...args); if (result && typeof result.then === "function") return result.then(value => { call.result = clone(value === undefined ? null : value); return value; }); call.result = clone(result === undefined ? null : result); return result; }; }`,
      context,
    );
  }
  await vm.runInContext("main()", context);
  const observed = JSON.parse(observedBytes) as Receipt;
  await fs.writeFile(path.join(proofDir, "native-cli.json"), cliBytes);
  const trace = {
    scope: {
      hostRunId,
      privateRepo: repo,
      sourceSha256: sha(source),
      environment: "offline_fixture",
      businessRunIdentity: "not_observed",
    },
    calls,
    phases: phaseObservations,
    instrumentation:
      "two read-only captures inserted after original union declaration and before original result declaration; all original parameters/statements/branches preserved",
    terminal: observed,
    cliSourceSha256: sha(cliBytes),
    extractedOriginalFunctions: functions.map((node) => ({
      owner: node.name!.text,
      sha256: sha(node.getText(ast)),
      unchangedOriginalBody: node.name?.text !== "main",
      originalStatementsPreserved: true,
    })),
    artifactSource: {
      path: path.join(workspace, "state/sample.json"),
      sha256: sha(artifactBody),
      synthetic: true,
      contentReadByInventoryOwner: false,
    },
  };
  const tracePath = path.join(proofDir, "native-phase-trace.json");
  const traceBytes = `${JSON.stringify(trace, null, 2)}\n`;
  await fs.writeFile(tracePath, traceBytes);
  const ref = (pointer: string) => ({ path: tracePath, pointer, sha256: sha(traceBytes) });
  const index = (owner: string) => calls.findIndex((call) => call.owner === owner);
  const mapping = index("buildRepoGovernanceCoverage");
  const areas = index("buildGovernanceInventoryAreas");
  const impact = index("changeImpactCoverage");
  const status = index("parseGitStatus");
  const stateInventory = calls.findIndex(
    (call) => call.owner === "walkArtifacts" && call.args[0] === path.join(workspace, "state"),
  );
  const evidence: WorkflowHandoffEvidence = {
    scenarioId: "universe_index_total_coverage_waterflow",
    environment: "offline_fixture",
    nodes: [
      {
        nodeId: "repo_inventory",
        scope: ref("/scope"),
        outputs: [
          { to: "owner_coverage_map", value: ref("/phases/repoComponentFiles") },
          { to: "change_impact_plan", value: ref(`/calls/${status}/result/changedFiles`) },
          { to: "universe_index", value: ref(`/calls/${status}/result/changedFiles`) },
        ],
      },
      {
        nodeId: "change_impact_plan",
        scope: ref("/scope"),
        inputs: [{ from: "repo_inventory", value: ref(`/calls/${impact}/args/0`) }],
        output: ref(`/calls/${impact}/result`),
      },
      {
        nodeId: "artifact_inventory",
        scope: ref("/scope"),
        outputs: [
          { to: "owner_coverage_map", value: ref(`/calls/${areas}/result`) },
          { to: "universe_index", value: ref(`/calls/${stateInventory}/result`) },
        ],
      },
      {
        nodeId: "owner_coverage_map",
        scope: ref("/scope"),
        inputs: [
          { from: "repo_inventory", value: ref(`/calls/${mapping}/args/0`) },
          { from: "artifact_inventory", value: ref(`/calls/${mapping}/args/1`) },
        ],
        output: ref("/phases/validatedOwnerCoverage"),
      },
      {
        nodeId: "universe_index",
        scope: ref("/scope"),
        inputs: [
          { from: "repo_inventory", value: ref("/terminal/repo/changedFiles") },
          { from: "artifact_inventory", value: ref("/terminal/artifacts/workspaceState") },
          { from: "owner_coverage_map", value: ref("/terminal/ownerCoverage/governanceCoverage") },
          { from: "change_impact_plan", value: ref("/terminal/ownerCoverage/changeImpact") },
        ],
        output: ref("/terminal/ownerCoverage"),
      },
    ],
  };
  const audit = (await auditWorkflowHandoffs([evidence])).find(
    (item) => item.scenarioId === evidence.scenarioId,
  );
  const result = {
    fault,
    cliTimedOut,
    terminalReceiptObserved: true,
    gap: fault === "git_timeout" ? "descendant_and_filesystem_cleanup_unconfirmed" : undefined,
    cliExitCode,
    cli,
    observed,
    calls,
    sourceHashes,
    observedOriginalInventoryMapEdge: [
      {
        from: "artifact_inventory",
        to: "owner_coverage_map",
        producer: ref(`/calls/${areas}/result`),
        consumer: ref(`/calls/${mapping}/args/1`),
        reason:
          "actual_original_area_builder_to_governance_map; separate producer and consumer observations",
      },
    ],
    hostRunId,
    evidence,
    audit,
    semanticAdoption: "not_proven",
    naturalRunObserved: false,
    topology:
      "parallel_git_changed_projection_and_inventory_mapping_join_in_main; no_changeImpact_to_map_call",
  };
  await fs.writeFile(path.join(proofDir, "proof.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
