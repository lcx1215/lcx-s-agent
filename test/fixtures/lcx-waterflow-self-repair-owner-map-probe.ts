import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import type { OwnerControlMap } from "../../scripts/operator/lcx-owner-control-map.js";
import { recordAgentArtifact } from "../../src/agents/artifact-result-recording.js";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
  createLcxRunSnapshot,
  type LcxRunReceipt,
  type LcxRunSnapshot,
} from "../../src/shared/lcx-run-receipt.js";

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
type RecordValue = Record<string, unknown>;
export type SelfRepairOwnerMapFault = "missing" | "hash" | "scope" | "stale" | "future";
export type SelfRepairReaderFault = "nonzero" | "malformed_stdout" | "timeout";
type OwnerRun = {
  id: string;
  parsed: boolean;
  ok?: boolean;
  exitCode: number;
  compact: RecordValue;
  error?: string;
  runReceipt: LcxRunReceipt;
};
type Command = { id: string; script: string; args: string[]; required: boolean };
type CliResult = { argv: string[]; stdout: string; stderr: string; exitCode: number };
type Owners = {
  runOwner: (
    command: Command,
    scope: { parentRunId: string; snapshot: LcxRunSnapshot },
  ) => Promise<OwnerRun>;
  ownerProjection: (owners: OwnerRun[]) => RecordValue;
};

function declarations(source: string, filename: string) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  return {
    ast,
    functions: ast.statements
      .filter(ts.isFunctionDeclaration)
      .map((node) => node.getText(ast).replace(/^export\s+/u, ""))
      .join("\n"),
  };
}

async function loadOwners(
  workspace: string,
  sourcePath: string,
  transport: (executable: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
) {
  const source = await fs.readFile(sourcePath, "utf8");
  const selected = declarations(source, sourcePath);
  const variables = selected.ast.statements
    .filter(ts.isVariableStatement)
    .filter((node) =>
      node.declarationList.declarations.some(
        (entry) =>
          ts.isIdentifier(entry.name) &&
          ["SAME_CYCLE_OWNER_PAYLOAD_IDS", "EXEC_MAX_BUFFER"].includes(entry.name.text),
      ),
    )
    .map((node) => node.getText(selected.ast))
    .join("\n");
  const receipt = selected.ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => node.declarationList.declarations)
    .find((node) => ts.isIdentifier(node.name) && node.name.text === "receipt");
  assert.ok(receipt?.initializer && ts.isObjectLiteralExpression(receipt.initializer));
  const projection = receipt.initializer.properties.find(
    (node) => ts.isPropertyAssignment(node) && node.name.getText(selected.ast) === "owners",
  );
  assert.ok(projection && ts.isPropertyAssignment(projection));
  const commands = receipt.initializer.properties.find(
    (node) => ts.isPropertyAssignment(node) && node.name.getText(selected.ast) === "ownerCommands",
  );
  assert.ok(commands && ts.isPropertyAssignment(commands));
  const config = {
    agents: {
      defaults: {
        workspace,
        memorySearch: { enabled: true, store: { path: path.join(workspace, "artifact.sqlite") } },
      },
    },
  };
  const failures = selected.ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => node.declarationList.declarations)
    .find((node) => ts.isIdentifier(node.name) && node.name.text === "structuralOwnerFailures");
  assert.ok(failures?.initializer);
  const summary = receipt.initializer.properties.find(
    (node) => ts.isPropertyAssignment(node) && node.name.getText(selected.ast) === "summary",
  );
  assert.ok(
    summary &&
      ts.isPropertyAssignment(summary) &&
      ts.isObjectLiteralExpression(summary.initializer),
  );
  const summaryFailures = summary.initializer.properties.find(
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.name.getText(selected.ast) === "structuralOwnerFailures",
  );
  assert.ok(summaryFailures && ts.isPropertyAssignment(summaryFailures));
  const code = `${variables}\nlet ownerArtifactRecordingConfig = privateConfig;\n${selected.functions}\n({runOwner, ownerProjection: (owners) => { const structuralOwnerFailures = ${failures.initializer.getText(selected.ast)}; return { owners: ${projection.initializer.getText(selected.ast)}, ownerCommands: ${commands.initializer.getText(selected.ast)}, summary: { structuralOwnerFailures: ${summaryFailures.initializer.getText(selected.ast)} } }; }})`;
  const context = vm.createContext({
    JSON,
    Date,
    Buffer,
    performance,
    process,
    repoRoot: repo,
    DEFAULT_WORKSPACE_DIR: workspace,
    privateConfig: config,
    execFileAsync: transport,
    recordAgentArtifact,
    boundaryFromFlags,
    buildLcxRunReceipt,
    createLcxRunId,
    loadConfig: () => {
      throw new Error("private probe forbids canonical config loading");
    },
  });
  const owners = vm.runInContext(
    ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context,
  ) as Owners;
  return { owners, sourceSha256: sha(source) };
}

async function loadControlMap(sourcePath: string) {
  const source = await fs.readFile(sourcePath, "utf8");
  const code = `${declarations(source, sourcePath).functions}\n buildOwnerControlMap`;
  return {
    build: vm.runInNewContext(
      ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      { JSON, Date, Set, Object },
    ) as (input: {
      checkedAt: string;
      snapshot: LcxRunSnapshot;
      governance: RecordValue;
      localFailureTrace: RecordValue;
      paths: { latestJsonPath: string; latestMarkdownPath: string; sourcePaths: string[] };
    }) => OwnerControlMap,
    sourceSha256: sha(source),
  };
}

async function cli(args: string[]): Promise<CliResult> {
  const argv = [
    "--import",
    "tsx",
    path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
    ...args,
  ];
  const result = await exec(process.execPath, argv, { cwd: repo, timeout: 30000 });
  return { argv, ...result, exitCode: 0 };
}

/** Original CLI producers/readers and governance functions; only process IO and host roots are isolated. */
export async function probeOriginalSelfRepairOwnerMap(params: {
  directory: string;
  fault?: SelfRepairOwnerMapFault;
  readerFault?: SelfRepairReaderFault;
  governanceSourcePath?: string;
  controlMapSourcePath?: string;
}) {
  const workspace = path.join(params.directory, "workspace");
  await fs.mkdir(path.join(workspace, "state"), { recursive: true });
  const scope = { accountId: "private-self-repair-paper", runId: "private-self-repair-current" };
  const rule = "Use fresh scoped evidence before candidate reuse.";
  const source = {
    scope: { ...scope, accountId: params.fault === "scope" ? "other-account" : scope.accountId },
    observedAt: new Date(
      Date.now() +
        (params.fault === "future" ? 60000 : params.fault === "stale" ? -8 * 86400000 : -1000),
    ).toISOString(),
    replacementRule: rule,
    trust: "private fixture; reference consistency is not source truth",
  };
  const sourceBytes = `${JSON.stringify(source, null, 2)}\n`;
  const sourcePath = path.join(workspace, "state/source.json");
  const manifestPath = path.join(workspace, "state/source-review.json");
  await fs.writeFile(sourcePath, sourceBytes);
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      source: {
        path: "state/source.json",
        sha256: params.fault === "hash" ? "0".repeat(64) : sha(sourceBytes),
      },
    }),
  );
  const common = ["--workspace-dir", workspace, "--replacement-rule", rule, "--json"];
  const prior = await cli([...common, "--signal-key", "prior-private-candidate", "--write"]);
  if (params.fault === "missing") {
    await fs.unlink(sourcePath);
  }
  const reviewed = [
    ...common,
    "--signal-key",
    scope.runId,
    "--source-review",
    manifestPath,
    "--review-account-id",
    scope.accountId,
    "--review-run-id",
    scope.runId,
  ];
  const writer = await cli([...reviewed, "--write"]);
  const nativeWriter = JSON.parse(writer.stdout) as RecordValue;
  const persistedWriterBytes = await fs.readFile(String(nativeWriter.latestJsonPath), "utf8");
  const persistedWriter = JSON.parse(persistedWriterBytes) as RecordValue;
  const candidatePath = String(
    (nativeWriter.hands as { memoryCleaner: { path: string } }).memoryCleaner.path,
  );
  const candidateExists = await fs.access(candidatePath).then(
    () => true,
    () => false,
  );
  if (params.readerFault === "nonzero") {
    await fs.writeFile(String(nativeWriter.latestJsonPath), "{invalid latest JSON");
  }
  const commit = await exec("git", ["rev-parse", "HEAD"], { cwd: repo });
  const branch = await exec("git", ["branch", "--show-current"], { cwd: repo });
  const snapshot = createLcxRunSnapshot({
    observedAt: new Date().toISOString(),
    sourceCommit: commit.stdout.trim(),
    sourceBranch: branch.stdout.trim() || "detached",
    authorityOwner: "lcx-governance-autopilot",
  });
  const parentRunId = createLcxRunId({
    checkedAt: snapshot.observedAt,
    owner: "lcx-governance-autopilot",
    key: workspace,
  });
  const execution: {
    executable: string;
    argv: string[];
    stdout?: string;
    stderr?: string;
    error?: string;
  }[] = [];
  const sourcePaths = {
    governance:
      params.governanceSourcePath ??
      path.join(repo, "scripts/operator/lcx-governance-autopilot.ts"),
    map:
      params.controlMapSourcePath ?? path.join(repo, "scripts/operator/lcx-owner-control-map.ts"),
  };
  const loaded = await loadOwners(workspace, sourcePaths.governance, async (executable, argv) => {
    const capture = { executable, argv } as (typeof execution)[number];
    execution.push(capture);
    if (argv.includes("--write")) {
      capture.stdout = writer.stdout;
      capture.stderr = writer.stderr;
      return { stdout: writer.stdout, stderr: writer.stderr };
    }
    try {
      const result = await exec(executable, argv, {
        cwd: repo,
        timeout: params.readerFault === "timeout" ? 1 : 30000,
      });
      Object.assign(capture, result);
      return result;
    } catch (error) {
      const native = error as { stdout?: string; stderr?: string; message?: string };
      capture.stdout = native.stdout;
      capture.stderr = native.stderr;
      capture.error = native.message;
      throw error;
    }
  });
  const command = {
    id: "selfRepairHands",
    script: "scripts/operator/lcx-self-repair-hands.ts",
    required: true,
  };
  const directOwner = await loaded.owners.runOwner(
    { ...command, args: [...reviewed, "--write"] },
    { parentRunId, snapshot },
  );
  const readerArgs =
    params.readerFault === "malformed_stdout"
      ? reviewed.filter((arg) => arg !== "--json")
      : reviewed;
  const readerOwner = await loaded.owners.runOwner(
    { ...command, args: readerArgs },
    { parentRunId, snapshot },
  );
  const map = await loadControlMap(sourcePaths.map);
  const build = (owner: OwnerRun, name: string) => {
    const governanceProjection = loaded.owners.ownerProjection([owner]);
    return {
      governanceProjection,
      map: map.build({
        checkedAt: snapshot.observedAt,
        snapshot,
        governance: governanceProjection,
        localFailureTrace: {},
        paths: {
          latestJsonPath: path.join(workspace, `state/${name}-map.json`),
          latestMarkdownPath: path.join(workspace, `state/${name}-map.md`),
          sourcePaths: [String(nativeWriter.latestJsonPath)],
        },
      }),
    };
  };
  const direct = build(directOwner, "direct");
  const reader = build(readerOwner, "reader");
  const proof = {
    fault: params.fault,
    readerFault: params.readerFault,
    prior,
    writer,
    nativeWriter,
    persistedWriter,
    persistedWriterSha256: sha(persistedWriterBytes),
    sourceBytes,
    sourceBodySha256: sha(sourceBytes),
    manifest: JSON.parse(await fs.readFile(manifestPath, "utf8")),
    candidateExists,
    snapshot,
    parentRunId,
    directOwner,
    readerOwner,
    execution,
    direct,
    reader,
    sourceHashes: {
      governance: loaded.sourceSha256,
      ownerMap: map.sourceSha256,
      selfRepair: sha(await fs.readFile(path.join(repo, command.script), "utf8")),
    },
    boundary:
      "private original CLI/writer, original AST runOwner/ownerRunFromPayload/compactOwner/captureOwnerRun and map; current writer stdout reused only at lowest exec IO; safe reader really executes. No governance main/aggregate receipt. Empty sibling scope is omitted, not verified. Original artifact recorder uses private config/store. Timeout is private exec host limit; production runOwner has no child deadline. No semantic source trust, applied replacement, ranking, training or natural governance claim.",
  };
  await fs.writeFile(
    path.join(params.directory, "proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  return proof;
}
