import assert from "node:assert/strict";
import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import {
  CONSOLIDATION_CLUSTERS,
  CONSOLIDATED_ENTRYPOINT_FAMILIES,
  SHARED_ENTRYPOINT_OWNERS,
  type WorkflowFieldRef,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import { parseJsonObjectFromOutput } from "../../scripts/operator/smoke-json-output.js";
import { buildCentralGovernanceInput } from "../../src/agents/central-harness/governance-input.js";
import { readFileWithinRoot } from "../../src/infra/fs-safe.js";
import { buildLcxRunReceipt, createLcxRunSnapshot } from "../../src/shared/lcx-run-receipt.js";

const execute = promisify(execFile);
export const engineeringRepo = path.resolve(import.meta.dirname, "../..");
export const engineeringHash = (bytes: string | Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
type Row = Record<string, unknown>;
type CommandReceipt = {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  value: Row;
};

/** Run only the original lock/impact CLIs; all lease and Git state belongs to a private fixture. */
export async function engineeringCli(script: string, args: string[]): Promise<CommandReceipt> {
  assert.ok(["lcx-automation-repair-lock.ts", "lcx-change-impact-plan.ts"].includes(script));
  const argv = [
    "--import",
    "tsx",
    path.join(engineeringRepo, "scripts/operator", script),
    ...args,
    "--json",
  ];
  const requestedWorktree = args[args.indexOf("--worktree") + 1];
  const env =
    script === "lcx-automation-repair-lock.ts" && args.includes("--worktree")
      ? { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(requestedWorktree) }
      : process.env;
  try {
    const result = await execute(process.execPath, argv, {
      cwd: engineeringRepo,
      timeout: 10_000,
      env,
    });
    return {
      args: argv,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      value: JSON.parse(result.stdout) as Row,
    };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    assert.equal(typeof failed.code, "number", "native CLI failed without a durable receipt");
    assert.ok(failed.stdout);
    return {
      args: argv,
      exitCode: Number(failed.code),
      stdout: failed.stdout,
      stderr: failed.stderr ?? "",
      value: JSON.parse(failed.stdout) as Row,
    };
  }
}
export async function privateEngineeringRepo(root: string, name = "worktree") {
  const cwd = path.join(root, `${name}-${crypto.randomUUID()}`);
  await fs.mkdir(cwd, { recursive: true });
  await execute("git", ["init"], { cwd });
  return cwd;
}
export function engineeringLockArgs(
  cwd: string,
  lease: string,
  mode: string,
  extra: string[] = [],
) {
  return [
    "--mode",
    mode,
    "--lane",
    "offline-engineering-probe",
    "--worktree",
    cwd,
    "--lock",
    lease,
    ...extra,
  ];
}
export async function persistEngineering(root: string, name: string, value: unknown) {
  const file = path.join(root, name);
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(file, bytes);
  return { path: file, sha256: engineeringHash(bytes) };
}
export function engineeringRef(
  receipt: { path: string; sha256: string },
  pointer: string,
): WorkflowFieldRef {
  return { ...receipt, pointer };
}

/** Original AST-selected functions, unchanged bodies. Importing doctor/lock would execute their CLI. */
async function ownerSlice<T>(
  script: string,
  names: string[],
  globals: Row,
): Promise<{ owner: T; source: Row }> {
  const file = path.join(engineeringRepo, "scripts/operator", script);
  const original = await fs.readFile(file, "utf8");
  const parsed = ts.createSourceFile(file, original, ts.ScriptTarget.ES2022, true);
  const selected: string[] = [];
  const slices: Row[] = [];
  const found = new Set<string>();
  for (const statement of parsed.statements) {
    const selectedNames =
      ts.isFunctionDeclaration(statement) && statement.name
        ? [statement.name.text].filter((name) => names.includes(name))
        : ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.flatMap((declaration) =>
              ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)
                ? [declaration.name.text]
                : [],
            )
          : [];
    if (!selectedNames.length) {
      continue;
    }
    const text = statement.getText(parsed).replace(/^export\s+/u, "");
    selected.push(text);
    selectedNames.forEach((name) => found.add(name));
    slices.push({
      names: selectedNames,
      startLine: parsed.getLineAndCharacterOfPosition(statement.getStart(parsed)).line + 1,
      sha256: engineeringHash(text),
    });
  }
  assert.deepEqual(
    [...found].toSorted(),
    [...names].toSorted(),
    `missing original slice ${script}`,
  );
  const source = selected.join("\n") + `\nglobalThis.originalOwner = { ${names.join(",")} };`;
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = vm.createContext({ ...globals, setTimeout, clearTimeout, Date });
  vm.runInContext(code, context, { timeout: 1000 });
  return {
    owner: context.originalOwner as T,
    source: {
      path: file,
      sha256: engineeringHash(original),
      slices,
      boundary: "unchanged_original_functions_not_full_owner_entry",
    },
  };
}

type DoctorCheck = { name: string; ok: boolean; durationMs: number; summary: Row; error?: string };
/** A real private child ignores TERM; observe its native close independently of the owner result. */
export async function originalDoctorCancellation(root: string, lateOutputOnTerm = false) {
  let native: ReturnType<typeof spawn> | undefined;
  let closed = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const signals: string[] = [];
  const loaded = await ownerSlice<{ runCommand: (params: Row) => Promise<DoctorCheck> }>(
    "lcx-system-doctor.ts",
    ["runCommand", "summarizeJson", "summarizeText", "summarizeGitStatus"],
    {
      spawn: (
        command: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv },
      ) => {
        const child = spawn(command, args, options);
        native = child;
        const kill = child.kill.bind(child);
        child.kill = (signal) => {
          signals.push(String(signal));
          return kill(signal);
        };
        child.on("exit", (code, signal) => {
          exit = { code, signal };
        });
        child.on("close", () => {
          closed = true;
        });
        return child;
      },
      process,
      parseJsonObjectFromOutput,
      WORKTREE_CWD: root,
    },
  );
  const lateFile = path.join(root, "late-success.json");
  const ignoredFile = path.join(root, "term-ignored.json");
  const program = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[2],'term_ignored');${lateOutputOnTerm ? "fs.writeFileSync(process.argv[1],'late_success');process.stdout.write(JSON.stringify({ok:true}));" : ""}});setTimeout(()=>{fs.writeFileSync(process.argv[1],'late_success');process.stdout.write(JSON.stringify({ok:true}));},1500);setInterval(()=>{},10000)`;
  const check = await loaded.owner.runCommand({
    name: "private-local-test",
    command: process.execPath,
    args: ["-e", program, lateFile, ignoredFile],
    cwd: root,
    parseJson: true,
    timeoutMs: 400,
  });
  const closedAtReturn = closed;
  const nativeExitAtReturn = exit;
  let aliveAtReturn = false;
  try {
    if (native?.pid) {
      process.kill(native.pid, 0);
      aliveAtReturn = true;
    }
  } catch {
    /* ESRCH proves this private PID is gone. */
  }
  const cleanupByFixture = !closed;
  if (native && !closed) {
    const child = native;
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill("SIGKILL");
    });
  }
  return {
    source: loaded.source,
    check,
    nativePid: native?.pid,
    closedAtReturn,
    nativeExitAtReturn,
    aliveAtReturn,
    cleanupByFixture,
    signals,
    termIgnored: await fs.readFile(ignoredFile, "utf8").catch(() => undefined),
    lateResultWritten: await fs.stat(lateFile).then(
      () => true,
      () => false,
    ),
    boundary: "original_runCommand_with_one_native_private_child_not_full_doctor",
  };
}

/** Deterministic no-close transport; it cannot stand in for a native cleanup acknowledgement. */
export async function originalDoctorUnconfirmedCancellation(root: string) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const signals: string[] = [];
  const stream = (name: string) => ({
    setEncoding: () => undefined,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(`${name}:${event}`, listener);
    },
  });
  const loaded = await ownerSlice<{ runCommand: (params: Row) => Promise<DoctorCheck> }>(
    "lcx-system-doctor.ts",
    ["runCommand", "summarizeJson", "summarizeText", "summarizeGitStatus"],
    {
      spawn: () => ({
        stdout: stream("stdout"),
        stderr: stream("stderr"),
        kill: (signal: string) => {
          signals.push(signal);
          return false;
        },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener);
        },
      }),
      process,
      parseJsonObjectFromOutput,
      WORKTREE_CWD: root,
    },
  );
  const check = await loaded.owner.runCommand({
    name: "private-no-close-transport",
    command: "not_executed",
    args: [],
    parseJson: true,
    timeoutMs: 10,
  });
  const atReturn = JSON.stringify(check);
  listeners.get("stdout:data")?.(JSON.stringify({ ok: true }));
  listeners.get("close")?.(0, null);
  return {
    source: loaded.source,
    check,
    signals,
    stableAfterLateClose: atReturn === JSON.stringify(check),
    boundary: "deterministic_no_close_transport_only_not_native_cleanup_proof",
  };
}

export async function originalDoctorCheck(
  root: string,
  receiptPath: string,
  timeout = false,
  exitCode = 0,
) {
  const names = [
    "runCommand",
    "summarizeJson",
    "summarizeText",
    "summarizeGitStatus",
    "actionableFailures",
  ];
  const loaded = await ownerSlice<{
    runCommand: (params: Row) => Promise<DoctorCheck>;
    actionableFailures: (checks: DoctorCheck[]) => string[];
  }>("lcx-system-doctor.ts", names, {
    spawn,
    process,
    parseJsonObjectFromOutput,
    WORKTREE_CWD: root,
  });
  // The lowest child transport prints exact already-produced original bytes. No source owner runs.
  const args = timeout
    ? ["-e", "setTimeout(() => {}, 10000)"]
    : [
        "-e",
        "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8')); process.exitCode = Number(process.argv[2])",
        receiptPath,
        String(exitCode),
      ];
  const check = await loaded.owner.runCommand({
    name: "change-impact-plan",
    command: process.execPath,
    args,
    cwd: root,
    parseJson: true,
    timeoutMs: timeout ? 30 : 2000,
  });
  return {
    source: loaded.source,
    check,
    actionableFailures: loaded.owner.actionableFailures([check]),
    boundary: "one_original_doctor_consumer_function_native_private_stdout_not_full_doctor",
  };
}

/** Original doctor aggregation, with exactly the check actually run above; no diagnostics dispatch. */
export async function originalDoctorAggregate(check: DoctorCheck) {
  const loaded = await ownerSlice<{ result: Row }>(
    "lcx-system-doctor.ts",
    ["actionableFailures", "failures", "result"],
    {
      checks: [check],
      options: { deep: false, live: false, brainPlan: false },
    },
  );
  return {
    source: loaded.source,
    result: loaded.owner.result,
    boundary: "original_aggregate_over_one_observed_check_not_full_doctor_coverage",
  };
}

/** Execute the actual final output block over one observed check, never its owner dispatch. */
export async function originalDoctorTail(check: DoctorCheck) {
  const aggregated = await originalDoctorAggregate(check);
  const file = path.join(engineeringRepo, "scripts/operator/lcx-system-doctor.ts");
  const original = await fs.readFile(file, "utf8");
  const start = original.indexOf("const gitSummary = checks.find");
  assert.ok(start > 0);
  const source = original.slice(start);
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let stdout = "";
  let stderr = "";
  const childProcess = {
    stdout: {
      write: (value: string) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value: string) => {
        stderr += value;
      },
    },
    exitCode: 0,
  };
  vm.runInNewContext(
    code,
    {
      checks: [check],
      result: aggregated.result,
      failures: aggregated.result.actionableFailures,
      options: { json: true },
      Buffer,
      process: childProcess,
    },
    { timeout: 1000 },
  );
  return {
    aggregated,
    stdout,
    stderr,
    exitCode: childProcess.exitCode,
    source: {
      path: file,
      sha256: engineeringHash(original),
      sliceSha256: engineeringHash(source),
      startLine: original.slice(0, start).split("\n").length,
    },
    boundary: "original_output_tail_one_observed_check_no_owner_dispatch",
  };
}

/** Execute only the original receipt writer's Node heredoc, never its shell supervisor. */
export async function originalOperatorReceipt(
  root: string,
  doctorPath: string,
  file: string,
  doctorStderr = "",
  doctorExitCode = 1,
) {
  const original = await fs.readFile(file, "utf8");
  const anchor = original.indexOf("function writeJsonAtomically(filePath, value)");
  const marker = "<<'NODE'\n";
  const start = original.lastIndexOf(marker, anchor) + marker.length;
  const end = original.indexOf("\nNODE", anchor);
  assert.ok(anchor > 0 && start > marker.length && end > anchor);
  const source = original.slice(start, end);
  const env: Record<string, string> = {
    NODE_REPO_ROOT: root,
    NODE_SOURCE_COMMIT: "",
    NODE_OBSERVE_ONLY: "true",
    NODE_SKIP_CLEANUP: "true",
    NODE_SKIP_TRAINING_RESTART: "true",
  };
  const absent = await persistEngineering(root, "unrun-owner.json", {
    ok: false,
    skipped: true,
    reason: "source_owner_not_run_in_private_writer_probe",
  });
  for (const id of [
    "PLAN",
    "EXAM",
    "GOVERNANCE",
    "MIND",
    "FLOW",
    "CONTEXT_RECOVERY",
    "TRAINING_SUPERVISOR",
  ]) {
    env[`NODE_${id}_FILE`] = absent.path;
    env[`NODE_${id}_CODE`] = "1";
  }
  env.NODE_DOCTOR_FILE = doctorPath;
  env.NODE_DOCTOR_CODE = String(doctorExitCode);
  env.NODE_CLEANUP_FILE = path.join(root, "not-run-cleanup.txt");
  env.NODE_CLEANUP_CODE = "0";
  env.NODE_JSONL = path.join(root, "private-operator-log.jsonl");
  env.NODE_LATEST = path.join(root, "private-operator-latest.json");
  env.NODE_REPO_LATEST = path.join(root, "state/lcx-local-operator-latest.json");
  for (const id of ["DOCTOR", "PLAN", "EXAM", "GOVERNANCE", "MIND", "FLOW", "CONTEXT_RECOVERY"]) {
    env[`NODE_${id}_ERR`] = path.join(root, `private-${id.toLowerCase()}.err`);
  }
  await fs.writeFile(env.NODE_DOCTOR_ERR, doctorStderr);
  const io: Row[] = [];
  const safePath = (value: string) => {
    assert.ok(
      typeof value === "string" &&
        (path.resolve(value) === path.resolve(root) ||
          path.resolve(value).startsWith(path.resolve(root) + path.sep)),
      "writer IO escaped private fixture",
    );
    return value;
  };
  const safeFs = {
    readFileSync: (filePath: string, encoding: BufferEncoding) => {
      io.push({ op: "read", path: safePath(filePath) });
      return fsSync.readFileSync(filePath, encoding);
    },
    mkdirSync: (filePath: string, options: fsSync.MakeDirectoryOptions) =>
      fsSync.mkdirSync(safePath(filePath), options),
    writeFileSync: (filePath: string, bytes: string, options: fsSync.WriteFileOptions) => {
      io.push({ op: "write", path: safePath(filePath) });
      fsSync.writeFileSync(filePath, bytes, options);
    },
    renameSync: (from: string, to: string) => {
      io.push({ op: "rename", from: safePath(from), to: safePath(to) });
      fsSync.renameSync(from, to);
    },
    appendFileSync: (filePath: string, bytes: string) => {
      io.push({ op: "append", path: safePath(filePath) });
      fsSync.appendFileSync(filePath, bytes);
    },
  };
  const output: unknown[] = [];
  vm.runInNewContext(
    source,
    {
      require: (name: string) => {
        if (name === "fs") {
          return safeFs;
        }
        assert.equal(name, "path");
        return path;
      },
      process: { env, pid: process.pid },
      console: { log: (value: unknown) => output.push(value) },
    },
    { timeout: 1000 },
  );
  const receipt = JSON.parse(await fs.readFile(env.NODE_REPO_LATEST, "utf8")) as Row;
  assert.deepEqual(JSON.parse(await fs.readFile(env.NODE_LATEST, "utf8")), receipt);
  return {
    source: {
      path: file,
      sha256: engineeringHash(original),
      sliceSha256: engineeringHash(source),
      startLine: original.slice(0, start).split("\n").length,
    },
    receipt,
    io,
    output,
    repoLatest: env.NODE_REPO_LATEST,
    globalSubstituteLatest: env.NODE_LATEST,
    boundary: "original_writer_only_all_io_private_unknown_other_owners_no_supervisor_or_services",
  };
}

export async function originalTrainingDecisions(cwd: string) {
  const names = [
    "buildDecisions",
    "activeGuardEvolutionCooldownSnapshot",
    "eventTime",
    "reasonText",
    "hasOutputContractSignals",
    "evalNonPromotionReason",
    "quoteShellArg",
    "buildRepairLockCommand",
    "buildMediumTrainingCommand",
  ];
  const loaded = await ownerSlice<{ buildDecisions: (input: Row) => Row[] }>(
    "local-brain-training-plan.ts",
    names,
    {},
  );
  const input = {
    activeProcesses: [],
    overlappingHeavyEval: false,
    miniMaxTeacherRuntime: { enabled: false, reason: "offline provider unavailable" },
    guardLogPath: path.join(cwd, "private-guard.jsonl"),
    worktree: cwd,
    latestGuardStart: { at: "2026-10-11T00:00:00Z" },
    latestGuardFailure: { at: "2026-10-11T00:01:00Z", error: "offline native source failure" },
  };
  return {
    source: loaded.source,
    input,
    decisions: loaded.owner.buildDecisions(input),
    boundary: "original_pure_decision_function_only_no_training_planner_runtime_or_lock_caller",
  };
}

export async function originalGitTransportTimeout(root: string, cwd: string) {
  let rejectGit: ((reason: Error) => void) | undefined;
  const calls: Row[] = [];
  const loaded = await ownerSlice<{ acquire: (options: Row) => Promise<Row> }>(
    "lcx-automation-repair-lock.ts",
    ["acquire", "gitStatusPorcelain", "readLock", "isExpired", "publicLock", "writeLock"],
    {
      fs,
      path,
      crypto,
      process,
      execFileAsync: (command: string, args: string[], options: Row) => {
        calls.push({ command, args, options });
        return new Promise((_resolve, reject) => {
          rejectGit = reject;
        });
      },
    },
  );
  const lease = path.join(root, "private-timeout.lock");
  let settled = false;
  const pending = loaded.owner
    .acquire({
      worktreeDir: cwd,
      lockPath: lease,
      allowDirty: true,
      lane: "offline",
      ttlMinutes: 1,
    })
    .then((value) => {
      settled = true;
      return value;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const settledBeforeTransportFailure = settled;
  assert.ok(rejectGit);
  rejectGit(Object.assign(new Error("offline Git transport timeout"), { code: "ETIMEDOUT" }));
  const receipt = await pending;
  return {
    source: loaded.source,
    calls,
    settledBeforeTransportFailure,
    receipt,
    boundary: "lowest_git_transport_substitute_no_real_hanging_child_no_native_deadline_claim",
  };
}

export async function probeEngineeringPartial(root: string) {
  const cwd = await privateEngineeringRepo(root);
  const lease = path.join(root, "private.lock");
  const acquired = await engineeringCli(
    "lcx-automation-repair-lock.ts",
    engineeringLockArgs(cwd, lease, "acquire"),
  );
  assert.equal(acquired.value.acquired, true);
  const read = await engineeringCli(
    "lcx-automation-repair-lock.ts",
    engineeringLockArgs(cwd, lease, "status"),
  );
  const source = await persistEngineering(root, "native-acquire.json", acquired.value);
  const consumer = await persistEngineering(root, "native-status-readback.json", read.value);
  const changedPath = "scripts/operator/lcx-automation-repair-lock.ts";
  await fs.mkdir(path.dirname(path.join(cwd, changedPath)), { recursive: true });
  await fs.writeFile(path.join(cwd, changedPath), "// explicit private Git fixture only\n");
  const git = await execute("git", ["status", "--porcelain", "--untracked-files=all"], { cwd });
  const changedFiles = git.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3));
  assert.deepEqual(changedFiles, [changedPath]);
  const impact = await engineeringCli("lcx-change-impact-plan.ts", ["--changed", ...changedFiles]);
  const impactRef = await persistEngineering(root, "native-change-impact.json", impact.value);
  const evidence: WorkflowHandoffEvidence[] = [
    {
      scenarioId: "automation_repair_lock_waterflow",
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "schedule_gate",
          scope: engineeringRef(source, "/worktreeDir"),
          output: engineeringRef(source, "/lock"),
        },
        {
          nodeId: "repair_lock",
          scope: engineeringRef(consumer, "/worktreeDir"),
          output: engineeringRef(consumer, "/lock"),
          inputs: [{ from: "schedule_gate", value: engineeringRef(consumer, "/lock") }],
        },
      ],
    },
    {
      scenarioId: "similar_engineering_consolidation_waterflow",
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "local_change",
          scope: engineeringRef(impactRef, "/checkedAt"),
          output: engineeringRef(impactRef, "/changedFiles"),
        },
        {
          nodeId: "change_impact_plan",
          scope: engineeringRef(impactRef, "/checkedAt"),
          output: engineeringRef(impactRef, "/impacts"),
          inputs: [
            { from: "local_change", value: engineeringRef(impactRef, "/impacts/0/matchedFiles") },
          ],
        },
      ],
    },
  ];
  const released = await engineeringCli(
    "lcx-automation-repair-lock.ts",
    engineeringLockArgs(cwd, lease, "release", ["--token", String(acquired.value.token)]),
  );
  return {
    cwd,
    acquired,
    read,
    impact,
    gitRead: {
      cwd,
      args: ["status", "--porcelain", "--untracked-files=all"],
      stdout: git.stdout,
      changedFiles,
      boundary: "private_host_git_to_original_cli_args_no_production_lease_consumer_claim",
    },
    released,
    evidence,
    boundary: "partial_original_functions_only_missing_plan_lock_scope_doctor_operator_consumers",
  };
}

type PriorWorkObservation = {
  status: string;
  blocksPlan: boolean;
  gaps: string[];
  semanticEquivalence: string;
  scope?: {
    changedFilesCount: number;
    eligibleCount: number;
    selectedCount: number;
    focusLimit: number;
  };
  omissions?: { source: string; indices: number[]; budgetIndices: number[] };
  reads: {
    path: string;
    old?: { sha256: string };
    current: { status: string; sha256?: string };
    diff: { sha256: string; hunks: unknown[]; publicSymbols: { name: string }[] };
    disposition: string;
  }[];
};
/** Exact original main and compact bodies, real private Git and original safe filesystem reader. */
export async function originalPriorWorkProbe(
  root: string,
  mode:
    | "changed"
    | "new"
    | "deleted"
    | "conflict"
    | "too_large"
    | "git_failure"
    | "late_read"
    | "mixed_batch"
    | "mixed_conflict"
    | "canonical_shared"
    | "canonical_conflict"
    | "canonical_unknown",
) {
  const cwd = await fs.realpath(await privateEngineeringRepo(root, "prior-work"));
  const canonical = mode.startsWith("canonical_");
  const file = canonical
    ? mode === "canonical_unknown"
      ? "src/agents/finance-expectation-gap.ts"
      : "scripts/operator/lcx-universe-index.ts"
    : "src/agents/finance-expectation-gap.ts";
  const target = path.join(cwd, file);
  let oldBody = "export function inspectEvidence() { return 'old-private-literal'; }\n";
  let newBody =
    "export function inspectEvidence() { return 'new-private-literal'; }\nexport const sourceDigest = 'fixture-secret-must-not-enter-central';\n";
  const declarations = {
    CONSOLIDATION_CLUSTERS,
    CONSOLIDATED_ENTRYPOINT_FAMILIES: structuredClone(CONSOLIDATED_ENTRYPOINT_FAMILIES),
    SHARED_ENTRYPOINT_OWNERS: structuredClone(SHARED_ENTRYPOINT_OWNERS),
  };
  const declarationFaults: string[] = [];
  if (canonical) {
    oldBody = await fs.readFile(
      path.join(engineeringRepo, "scripts/operator/lcx-universe-index.ts"),
      "utf8",
    );
    newBody = oldBody + "\nexport const privateComparisonProbe = true;\n";
    for (const owner of [
      "scripts/operator/lcx-universe-index.ts",
      "scripts/operator/lcx-mind-model.ts",
    ]) {
      const destination = path.join(cwd, owner);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(engineeringRepo, owner), destination);
    }
  }
  if (mode === "canonical_conflict") {
    declarations.SHARED_ENTRYPOINT_OWNERS = declarations.SHARED_ENTRYPOINT_OWNERS.filter(
      (rule) => rule.path !== file,
    );
    const family = declarations.CONSOLIDATED_ENTRYPOINT_FAMILIES.find(
      (row) => row.id === "universe_inventory_entrypoints",
    );
    assert.ok(family);
    family.ownerPath = "src/agents/undeclared-private-owner.ts";
    declarationFaults.push(
      "loaded_declaration_transport_missing_share",
      "loaded_declaration_transport_owner_not_allowed",
    );
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, oldBody);
  if (mode === "mixed_batch" || mode === "mixed_conflict") {
    for (let i = 0; i < 18; i++) {
      await fs.writeFile(
        path.join(cwd, `src/agents/finance-expectation-gap-${String(i).padStart(2, "0")}.ts`),
        oldBody,
      );
    }
    await fs.mkdir(path.join(cwd, "test/fixtures"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src/agents/finance-expectation-gap.test.ts"), oldBody);
    await fs.writeFile(path.join(cwd, "test/fixtures/private-probe.ts"), oldBody);
    await execute("git", ["add", "--", "src", "test"], { cwd });
  }
  if (canonical) {
    await execute("git", ["add", "--all"], { cwd });
  }
  await execute("git", ["add", "--", file], { cwd });
  await execute(
    "git",
    [
      "-c",
      "user.name=Private Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "private source baseline",
    ],
    { cwd },
  );
  let selectedFile = file;
  if (mode === "deleted") {
    await fs.unlink(target);
  } else if (mode === "new") {
    selectedFile = "src/agents/finance-source-recovery.ts";
    await fs.writeFile(path.join(cwd, selectedFile), newBody);
  } else {
    await fs.writeFile(target, mode === "too_large" ? newBody.repeat(3000) : newBody);
  }
  if (mode === "mixed_batch" || mode === "mixed_conflict") {
    for (let i = 0; i < 18; i++) {
      await fs.writeFile(
        path.join(cwd, `src/agents/finance-expectation-gap-${String(i).padStart(2, "0")}.ts`),
        newBody,
      );
    }
    await fs.writeFile(path.join(cwd, "src/agents/finance-expectation-gap.test.ts"), newBody);
    await fs.writeFile(path.join(cwd, "test/fixtures/private-probe.ts"), newBody);
  }
  const calls: Row[] = [];
  const reads: Row[] = [];
  let count = 0;
  let lateResolved = false;
  const safeReader: typeof readFileWithinRoot = async (options) => {
    const opened = await readFileWithinRoot(options);
    reads.push({
      path: opened.realPath,
      sha256: engineeringHash(opened.buffer),
      bytes: opened.buffer.length,
    });
    if ((mode === "conflict" || mode === "mixed_conflict") && ++count === 1) {
      await fs.appendFile(opened.realPath, "export const lateMutation = true;\n");
    }
    if (mode === "late_read") {
      await new Promise<void>((resolve) => setTimeout(resolve, 1100));
      lateResolved = true;
    }
    return opened;
  };
  const execTransport = async (command: string, argv: string[], options: ExecFileOptions) => {
    assert.equal(command, "git", "no provider, model, owner stack or external child permitted");
    calls.push({ command, args: argv });
    if (mode === "git_failure" && argv[0] === "show") {
      throw new Error("private Git show unavailable");
    }
    return await execute(command, argv, options);
  };
  let stdout = "";
  const loaded = await ownerSlice<{ main: () => Promise<void> }>(
    "lcx-change-impact-plan.ts",
    [
      "PATH_RULES",
      "parseArgs",
      "gitChangedFiles",
      "normalizeChangedFiles",
      "impactFor",
      "uniqueCommands",
      "uniqueDeferredCommands",
      "uniqueSafetyNotes",
      "readPriorWork",
      "readConsolidation",
      "main",
    ],
    {
      ...declarations,
      repoRoot: cwd,
      path,
      createHash: crypto.createHash,
      execFileAsync: execTransport,
      readFileWithinRoot: safeReader,
      AbortController,
      AbortSignal,
      Buffer,
      process: {
        argv: [process.execPath, "private-original-main.ts", "--json"],
        stdout: {
          write: (value: string) => {
            stdout += value;
          },
        },
      },
    },
  );
  if (mode === "late_read") {
    // A direct original function call below carries a narrow deadline; main is still observed separately.
    const prior = await ownerSlice<{
      readPriorWork: (
        files: string[],
        readback: Row,
        impacts: Row[],
        deadline: number,
      ) => Promise<PriorWorkObservation>;
    }>("lcx-change-impact-plan.ts", ["readPriorWork"], {
      repoRoot: cwd,
      path,
      createHash: crypto.createHash,
      execFileAsync: execTransport,
      readFileWithinRoot: safeReader,
      AbortController,
      Buffer,
    });
    const result = await prior.owner.readPriorWork(
      [file],
      { source: "git", status: "observed" },
      [],
      Date.now() + 1000,
    );
    const frozen = JSON.stringify(result);
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
    assert.equal(JSON.stringify(result), frozen);
    const proof = {
      source: prior.source,
      result,
      reads,
      calls,
      lateResolved,
      boundary: "original_read_consumer_deadline_not_full_main_timeout",
    };
    await persistEngineering(root, "native-prior-work.json", proof);
    return { proof: proof as Row, result: undefined, priorWork: result, central: undefined };
  }
  await loaded.owner.main();
  const stdoutPath = path.join(root, "native-owner-output.json");
  await fs.writeFile(stdoutPath, stdout);
  const originalStdout = { path: stdoutPath, sha256: engineeringHash(stdout) };
  const originalPayload = stdout;
  const result = JSON.parse(stdout) as Row & {
    ok: boolean;
    checkedAt: string;
    strayGate: {
      nextAction: string;
      priorWork: PriorWorkObservation;
      consolidation: {
        status: string;
        blocksPlan: boolean;
        conflicts: { path: string; reason: string }[];
        routes: {
          source: { path: string; sha256: string };
          sharedApproval?: string;
          ownerSources: { path: string; sha256: string }[];
          disposition: string;
          gaps: string[];
        }[];
      };
    };
  };
  const compactLoaded = await ownerSlice<{ compactOwner: (id: string, payload: Row) => Row }>(
    "lcx-governance-autopilot.ts",
    ["compactOwner"],
    { Buffer },
  );
  const compact = compactLoaded.owner.compactOwner("changeImpact", result);
  assert.deepEqual(result, JSON.parse(originalPayload), "compact must not mutate original payload");
  const commit = (await execute("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const snapshot = createLcxRunSnapshot({
    observedAt: result.checkedAt,
    sourceCommit: commit,
    sourceBranch: "private-fixture",
    authorityOwner: "private-offline-governance-caller",
  });
  const parentRunId = crypto.randomUUID();
  const runReceipt = buildLcxRunReceipt({
    runId: crypto.randomUUID(),
    parentRunId,
    owner: "changeImpact",
    phase: "observe",
    status: result.ok ? "passed" : "blocked",
    checkedAt: result.checkedAt,
    snapshot,
    nextAction: result.strayGate.nextAction,
    boundary: {
      scope: "private_original_source_comparison",
      externalSender: "not_touched_by_projection",
      training: "not_touched_by_projection",
      providerConfig: "not_touched_by_projection",
      protectedMemory: "not_touched_by_projection",
    },
  });
  const central = buildCentralGovernanceInput(
    [{ id: "changeImpact", ok: result.ok, compact, runReceipt }],
    { parentRunId, snapshot, checkedAt: result.checkedAt },
  );
  const proof = {
    originalStdout,
    declarationFaults,
    declarationBoundary: canonical
      ? "original_loaded_declarations_negative_transport_faults_explicit"
      : "original_loaded_canonical_declarations",
    originalMainSource: loaded.source,
    originalCompactSource: compactLoaded.source,
    selectedFile,
    originalBodySha256: engineeringHash(oldBody),
    newBodySha256: engineeringHash(newBody),
    result,
    compact,
    central,
    reads,
    calls,
    boundary: "offline_original_main_compact_central_not_natural_semantic_adoption",
  };
  await persistEngineering(root, "native-prior-work.json", proof);
  return { proof: proof as Row, result, priorWork: result.strayGate.priorWork, central };
}
