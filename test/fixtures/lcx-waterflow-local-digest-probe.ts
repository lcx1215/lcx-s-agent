import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import {
  summarizeTraceForHandoff,
  type LocalFailureTraceReceipt,
} from "../../scripts/operator/lcx-local-failure-trace.ts";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunSnapshot,
  type LcxRunStatus,
} from "../../src/shared/lcx-run-receipt.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
export const digestHash = (bytes: string | Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
export async function persistDigest(root: string, name: string, value: unknown) {
  const file = path.join(root, name);
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(file, bytes);
  return { path: file, sha256: digestHash(bytes) };
}
export function originalDigestInput(root: string, status: LcxRunStatus = "blocked", exitCode = 1) {
  const checkedAt = "2026-10-11T07:00:00.000Z";
  const snapshot = createLcxRunSnapshot({
    observedAt: checkedAt,
    sourceCommit: "private-offline-source",
    sourceBranch: "private-offline-branch",
    authorityOwner: "lcx-governance-autopilot",
  });
  const parent = buildLcxRunReceipt({
    runId: "private-native-governance-parent",
    owner: "lcx-governance-autopilot",
    phase: "observe",
    status,
    checkedAt,
    snapshot,
    boundary: boundaryFromFlags({ scope: "private_offline_governance_input" }),
    nextAction: "review_original_owner",
  });
  const child = buildLcxRunReceipt({
    runId: "private-native-commercial-owner",
    parentRunId: parent.runId,
    owner: "commercialAcceptance",
    phase: "observe",
    status,
    checkedAt,
    snapshot,
    boundary: boundaryFromFlags({ scope: "private_offline_owner_only" }),
    nextAction: "review_release_blocker",
  });
  return {
    ok: true,
    checkedAt,
    runId: parent.runId,
    runReceipt: parent,
    snapshot,
    workspaceDir: root,
    ownerCommands: [
      {
        id: "commercialAcceptance",
        command: "not executed: offline original owner receipt",
        parsed: true,
        ok: status === "passed",
        exitCode,
        runReceipt: child,
      },
    ],
    summary: {
      structuralOwnerFailures: status === "passed" ? [] : ["commercialAcceptance"],
      blockedGates: status === "blocked" ? ["commercial_release_blocked"] : [],
      failedGates: status === "failed" ? ["commercial_execution_failed"] : [],
      blockedClusters: [],
      fastestSafeNextAction: "review_release_blocker",
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}
export async function originalTraceCli(inputPath: string, expectedSha256?: string) {
  const args = [
    "--import",
    "tsx",
    path.join(repoRoot, "scripts/operator/lcx-local-failure-trace.ts"),
    "--autopilot-path",
    inputPath,
    "--json",
    ...(expectedSha256 ? ["--autopilot-sha256", expectedSha256] : []),
  ];
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    ({ stdout, stderr } = await promisify(execFile)(process.execPath, args, {
      cwd: repoRoot,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
    exitCode = failure.code ?? 1;
  }
  const bytes = await fs.readFile(
    path.join(repoRoot, "scripts/operator/lcx-local-failure-trace.ts"),
  );
  return {
    stdout,
    stderr,
    exitCode,
    value: JSON.parse(stdout) as LocalFailureTraceReceipt & {
      sourceReadback: Record<string, unknown>;
    },
    source: { path: "scripts/operator/lcx-local-failure-trace.ts", sha256: digestHash(bytes) },
    args,
    boundary: "original_readonly_cli_no_write_no_stack_private_source_only",
  };
}

async function originalSlice(file: string, names: string[], globals: Record<string, unknown>) {
  const full = await fs.readFile(path.join(repoRoot, file), "utf8");
  const ast = ts.createSourceFile(file, full, ts.ScriptTarget.ES2022, true);
  const selections = ast.statements.flatMap((statement) => {
    const ids =
      ts.isFunctionDeclaration(statement) && statement.name
        ? [statement.name.text]
        : ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.flatMap((row) =>
              ts.isIdentifier(row.name) ? [row.name.text] : [],
            )
          : [];
    return ids.some((id) => names.includes(id)) ? [statement] : [];
  });
  assert.equal(selections.length, names.length);
  const source = selections
    .map((statement) => statement.getText(ast).replace(/^export\s+/u, ""))
    .join("\n");
  const code = ts.transpileModule(
    source + `\nglobalThis.originalFunctions = {${names.join(",")}};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const context = vm.createContext(globals);
  vm.runInContext(code, context, { timeout: 1000 });
  return {
    functions: context.originalFunctions as Record<string, unknown>,
    source: {
      path: file,
      sha256: digestHash(full),
      slices: selections.map((statement) => ({
        line: ast.getLineAndCharacterOfPosition(statement.getStart(ast)).line + 1,
        sha256: digestHash(statement.getText(ast)),
      })),
    },
  };
}

/** Original writer persists exact CLI result; original governance renderer consumes its disk readback. */
export async function persistTraceAndConsume(root: string, receipt: LocalFailureTraceReceipt) {
  const latest = path.join(root, "private-trace-latest.json");
  const log = path.join(root, "private-trace-log.jsonl");
  const io: Array<{ op: string; path: string; sha256?: string }> = [];
  const safe = (file: string) => {
    assert.ok(
      path.resolve(file) === path.resolve(root) ||
        path.resolve(file).startsWith(path.resolve(root) + path.sep),
    );
    return file;
  };
  const writer = await originalSlice(
    "scripts/operator/lcx-local-failure-trace.ts",
    ["writeLocalFailureTraceReceipt"],
    {
      path,
      LOCAL_FAILURE_TRACE_LATEST_PATH: latest,
      LOCAL_FAILURE_TRACE_JSONL_PATH: log,
      fs: {
        mkdir: (file: string, options: { recursive: boolean }) => fs.mkdir(safe(file), options),
        writeFile: async (file: string, bytes: string) => {
          io.push({ op: "write", path: safe(file), sha256: digestHash(bytes) });
          await fs.writeFile(file, bytes);
        },
        appendFile: async (file: string, bytes: string) => {
          io.push({ op: "append", path: safe(file), sha256: digestHash(bytes) });
          await fs.appendFile(file, bytes);
        },
      },
    },
  );
  await (
    writer.functions.writeLocalFailureTraceReceipt as (
      value: LocalFailureTraceReceipt,
    ) => Promise<void>
  )(receipt);
  const bytes = await fs.readFile(latest, "utf8");
  io.push({ op: "consumer_read", path: latest, sha256: digestHash(bytes) });
  const readback = JSON.parse(bytes) as LocalFailureTraceReceipt;
  const absent = {
    status: "not_observed",
    reason: "source owner not run in private probe",
    latestStatePath: "not_observed",
  };
  const renderer = await originalSlice(
    "scripts/operator/lcx-governance-autopilot.ts",
    [
      "recordValue",
      "truncateLine",
      "inlineValue",
      "markdownList",
      "activePidHandoffLines",
      "buildContextRecoveryHandoff",
      "SELF_REPAIR_HANDS_OWNER_WRITE_POLICY",
    ],
    {
      repoRoot: root,
      summarizeTraceForHandoff,
      SELF_REPAIR_HANDS_LATEST_PATH: "not_observed",
      SELF_REPAIR_HANDS_MARKDOWN_PATH: "not_observed",
      SELF_REPAIR_HANDS_JSONL_PATH: "not_observed",
      MONOTONIC_DATA_LEDGER_LATEST_PATH: "not_observed",
      MONOTONIC_DATA_LEDGER_JSONL_PATH: "not_observed",
      selfRepairAutoWriteRun: undefined,
      selfRepairAutoSignal: undefined,
      selfRepairHandsCompact: undefined,
      selfRepairLatestWritten: undefined,
      externalChannelStatusCompact: undefined,
    },
  );
  const markdown = (
    renderer.functions.buildContextRecoveryHandoff as (value: Record<string, unknown>) => string
  )({
    receipt: {
      checkedAt: readback.checkedAt,
      ok: false,
      summary: {
        fastestSafeNextAction: readback.nextSafeAction,
        blockedGates: readback.blockers.blockedGates,
      },
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    },
    gitStatusLines: [],
    activePids: { guard: [], eval: [], mlx: [], teacher: [], quota: [] },
    digestMaterial: {},
    multiAgentPatternShadow: absent,
    localFailureTrace: readback,
  });
  const markdownPath = path.join(root, "private-original-governance-handoff.md");
  await fs.writeFile(markdownPath, markdown);
  return {
    latest: { path: latest, sha256: digestHash(bytes) },
    readback,
    markdown,
    markdownPath,
    io,
    writerSource: writer.source,
    consumerSource: renderer.source,
    boundary:
      "original_writer_and_original_governance_renderer_only_no_full_governance_or_terminal_digest",
  };
}
