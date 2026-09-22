/**
 * Standalone weekday finance scheduler. Reuses the daily-cycle operator; it has no
 * model or Gateway dependency. Scheduling uses America/New_York wall clock.
 *
 * --once day|night | --loop | --detach | --status
 * --dir PATH pins the book for all child processes.
 * --cycle-timeout-ms N bounds each cycle (default 15 minutes).
 * --place, --venue paper|alpaca, --equity-from-venue and the --max-* caps are
 * forwarded unchanged. Scheduling does not grant additional execution authority.
 *
 * lastFired is an attempt marker, not success. A failed/interrupted attempt is
 * never automatically replayed; reconcile its effects before a manual --once.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_FINANCE_CYCLE_SLOTS,
  FINANCE_MARKET_TZ,
  FINANCE_TRADING_WEEKDAYS,
  financeEtClock,
  isFinanceCycleSlotDue,
} from "../../src/agents/finance-cycle-schedule.js";
import {
  acquireFinanceSchedulerLock,
  FINANCE_SCHEDULER_LOCK,
  financeSchedulerPidPresent,
  readFinanceSchedulerPid,
} from "../../src/agents/finance-scheduler-lock.js";
import {
  DEFAULT_FINANCE_CYCLE_TIMEOUT_MS,
  runFinanceCycleProcess,
} from "../../src/agents/finance-scheduler-process.js";
import {
  FINANCE_SCHEDULER_TICK_MS,
  inspectFinanceSchedulerProgress,
  readFinanceSchedulerPolicyExpiry,
  readFinanceSchedulerState,
  writeFinanceSchedulerState,
} from "../../src/agents/finance-scheduler-state.js";
import {
  resolveFinanceStateDir,
  type FinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import { buildDetachedServeEnv } from "../../src/cli/serve-detach.js";
import { loadConfig } from "../../src/config/config.js";
import { applyConfigEnvVars } from "../../src/config/env-vars.js";
import { killProcessTree } from "../../src/process/kill-tree.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CYCLE_SCRIPT = path.join(REPO_ROOT, "scripts", "operator", "lcx-finance-daily-cycle.ts");
const RUNS_LOG = "daily-cycle-runs.jsonl";
type Mode = "day" | "night";

type SchedulerOptions = {
  command: "once" | "loop" | "detach" | "status";
  mode?: Mode;
  directory?: string;
  timeoutMs: number;
  extraArgs: string[];
  json: boolean;
};

export function parseFinanceSchedulerArgs(argv: readonly string[]): SchedulerOptions {
  let command: SchedulerOptions["command"] | undefined;
  let json = false;
  let mode: Mode | undefined;
  let directory: string | undefined;
  let timeoutMs = DEFAULT_FINANCE_CYCLE_TIMEOUT_MS;
  const extraArgs: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (seen.has(arg)) {
      throw new Error(`duplicate argument: ${arg}`);
    }
    seen.add(arg);
    if (["--once", "--loop", "--detach", "--status"].includes(arg)) {
      if (command) {
        throw new Error("choose exactly one of --once, --loop, --detach, --status");
      }
      command = arg.slice(2) as SchedulerOptions["command"];
      if (arg === "--once") {
        const value = argv[++i];
        if (value !== "day" && value !== "night") {
          throw new Error("--once requires day or night");
        }
        mode = value;
      }
    } else if (arg === "--json") {
      json = true;
    } else if (
      arg === "--place" ||
      arg === "--equity-from-venue" ||
      arg === "--sync-alpaca-history"
    ) {
      extraArgs.push(arg);
    } else if (
      [
        "--dir",
        "--portfolio-plan",
        "--execution-policy",
        "--venue",
        "--cycle-timeout-ms",
        "--max-order-notional",
        "--max-instrument-notional",
        "--max-orders",
        "--core-weight",
        "--execution-quote-feed",
        "--execution-max-age-ms",
      ].includes(arg)
    ) {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--dir") {
        directory = value;
      } else if (arg === "--portfolio-plan" || arg === "--execution-policy") {
        // Detached children change cwd; bind the caller's plan before spawning.
        extraArgs.push(arg, path.resolve(value));
      } else if (arg === "--venue") {
        if (value !== "paper" && value !== "alpaca") {
          throw new Error("--venue must be paper or alpaca");
        }
        extraArgs.push(arg, value);
      } else if (arg === "--core-weight") {
        const fraction = Number(value);
        if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
          throw new Error("--core-weight must be between 0 and 1");
        }
        extraArgs.push(arg, value);
      } else if (arg === "--execution-quote-feed") {
        if (value !== "iex" && value !== "sip") {
          throw new Error("--execution-quote-feed must be iex or sip");
        }
        extraArgs.push(arg, value);
      } else {
        const number = Number(value);
        if (
          !Number.isFinite(number) ||
          number <= 0 ||
          ((arg === "--max-orders" || arg === "--cycle-timeout-ms") &&
            !Number.isSafeInteger(number)) ||
          (arg === "--cycle-timeout-ms" && number > 2_147_483_647)
        ) {
          throw new Error(`invalid positive value for ${arg}`);
        }
        if (arg === "--cycle-timeout-ms") {
          timeoutMs = number;
        } else {
          extraArgs.push(arg, value);
        }
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!command) {
    throw new Error("usage: --once day|night | --loop | --detach | --status");
  }
  if (json && command !== "status") {
    throw new Error("--json requires --status");
  }
  // Night settlement and read-only status do not need daytime execution inputs.
  if (
    command !== "status" &&
    !(command === "once" && mode === "night") &&
    extraArgs.includes("--place") &&
    extraArgs[extraArgs.indexOf("--venue") + 1] === "alpaca"
  ) {
    const required = ["--execution-policy", "--execution-quote-feed", "--execution-max-age-ms"];
    const missing = required.filter((flag) => !extraArgs.includes(flag));
    if (missing.length) {
      throw new Error(`Alpaca scheduler placement requires ${missing.join(", ")}`);
    }
    const maxAgeMs = Number(extraArgs[extraArgs.indexOf("--execution-max-age-ms") + 1]);
    if (maxAgeMs > 120000) {
      throw new Error("Alpaca execution quote age must not exceed 120000 ms");
    }
  }
  return { command, mode, directory, timeoutMs, extraArgs, json };
}

/** Exit zero alone does not establish that the cycle accepted its inputs. */
export function cycleOutputSucceeded(stdout: string): boolean {
  try {
    const payload: unknown = JSON.parse(stdout);
    return (
      typeof payload === "object" && payload !== null && (payload as { ok?: unknown }).ok === true
    );
  } catch {
    return false;
  }
}

/** Process completion and trading outcomes are different evidence. */
export function describeFinanceCycleExecution(stdout: string, args: readonly string[], mode: Mode) {
  const placementEnabled = mode === "day" && args.includes("--place");
  const venueIndex = args.indexOf("--venue");
  const venue = venueIndex >= 0 ? (args[venueIndex + 1] ?? "unknown") : "paper";
  let payload: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(stdout);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      payload = value as Record<string, unknown>;
    }
  } catch {
    /* Missing output is unknown, not an empty trading result. */
  }
  const reportedPlacements = Array.isArray(payload.placed) ? payload.placed.length : null;
  const refusals = Array.isArray(payload.refusals) ? payload.refusals : [];
  const intents = Array.isArray(payload.drift)
    ? payload.drift.filter(
        (row: unknown) =>
          row !== null &&
          typeof row === "object" &&
          "action" in row &&
          ["buy", "sell"].includes(String(row.action)),
      ).length
    : null;
  const outcome =
    payload.ok !== true
      ? "failed_or_unknown"
      : mode === "night"
        ? "settlement"
        : !placementEnabled
          ? "preview_only"
          : refusals.length
            ? "blocked_or_partial"
            : reportedPlacements !== null && reportedPlacements > 0
              ? "placement_reported"
              : intents === 0
                ? "no_trade"
                : "not_executed";
  return {
    placementEnabled,
    venue,
    outcome,
    reportedPlacements,
    tradeIntentCount: intents,
    refusalCount: refusals.length,
  };
}

type CycleContext = { root: FinanceStateDir; options: SchedulerOptions; signal: AbortSignal };

function writeSchedulerProgress(context: CycleContext, phase: "idle" | "cycle") {
  const filename = path.join(context.root.directory, FINANCE_SCHEDULER_LOCK, "progress.json");
  const temporary = `${filename}.tmp`;
  const args = context.options.extraArgs;
  const venueIndex = args.indexOf("--venue");
  const venue = venueIndex < 0 ? "paper" : args[venueIndex + 1];
  const policyIndex = args.indexOf("--execution-policy");
  fs.writeFileSync(
    temporary,
    JSON.stringify({
      pid: process.pid,
      observedAt: new Date().toISOString(),
      phase,
      timeoutMs: context.options.timeoutMs,
      placementEnabled: args.includes("--place"),
      venue,
      executionPolicyExpiresAt:
        venue === "alpaca"
          ? readFinanceSchedulerPolicyExpiry(policyIndex < 0 ? undefined : args[policyIndex + 1])
          : null,
    }),
  );
  fs.renameSync(temporary, filename);
}

async function fire(context: CycleContext, mode: Mode): Promise<boolean> {
  if (context.signal.aborted) {
    return false;
  }
  const directory = context.root.directory;
  const startedAt = Date.now();
  const attempt = {
    runId: randomUUID(),
    firedAt: new Date(startedAt).toISOString(),
    etDate: financeEtClock(new Date(startedAt)).date,
    mode,
    directory,
    rootSource: context.root.source,
    timeoutMs: context.options.timeoutMs,
  };
  const state = readFinanceSchedulerState(directory);
  const legacyClaim = path.join(directory, `daily-cycle-${attempt.etDate}-${mode}.json`);
  if (
    fs.existsSync(legacyClaim) ||
    state.lastFired[mode] === attempt.etDate ||
    state.lastStatus[mode] === "running"
  ) {
    process.stderr.write("cycle blocked: existing attempt requires reconciliation before replay\n");
    return false;
  }
  // Persist before spawning, for both scheduled and manual attempts. A crash is
  // uncertain execution, not permission to repeat a possible venue action.
  state.lastFired[mode] = attempt.etDate;
  state.lastStatus[mode] = "running";
  state.lastRun = { ...attempt, status: "running" };
  writeFinanceSchedulerState(directory, state);
  writeSchedulerProgress(context, "cycle");
  const result = await runFinanceCycleProcess({
    argv: [
      "--import",
      "tsx",
      CYCLE_SCRIPT,
      "--json",
      "--mode",
      mode,
      "--dir",
      directory,
      ...context.options.extraArgs.filter(
        (arg) => mode === "day" || (arg !== "--place" && arg !== "--equity-from-venue"),
      ),
    ],
    cwd: REPO_ROOT,
    timeoutMs: context.options.timeoutMs,
    signal: context.signal,
  });
  const accepted = result.ok && cycleOutputSucceeded(result.stdout);
  const record = {
    ...attempt,
    ...result,
    ok: accepted,
    status: result.ok && !accepted ? ("failed" as const) : result.status,
    durationMs: Date.now() - startedAt,
    execution: describeFinanceCycleExecution(result.stdout, context.options.extraArgs, mode),
  };

  fs.appendFileSync(path.join(directory, RUNS_LOG), `${JSON.stringify(record)}\n`);
  if (record.ok) {
    state.lastSucceeded[mode] = attempt.etDate;
  }
  state.lastStatus[mode] = record.status;
  state.lastRun = record;
  writeFinanceSchedulerState(directory, state);
  process.stdout.write(
    `[${record.firedAt}] ${mode} status=${record.status} execution=${record.execution.outcome} venue=${record.execution.venue} exit=${record.exitCode} ${record.durationMs}ms\n`,
  );
  if (!record.ok) {
    process.stderr.write(`${record.status}: ${record.stderr.slice(0, 2000)}\n`);
  }
  return record.ok;
}

async function tick(context: CycleContext): Promise<void> {
  for (const slot of DEFAULT_FINANCE_CYCLE_SLOTS) {
    if (context.signal.aborted) {
      break;
    }
    // Re-read time and state after each cycle; a long day cycle can cross midnight.
    const clock = financeEtClock(new Date());
    const state = readFinanceSchedulerState(context.root.directory);
    if (isFinanceCycleSlotDue(slot, clock, state.lastFired)) {
      await fire(context, slot.mode);
    }
  }
}

async function detach(root: FinanceStateDir, options: SchedulerOptions): Promise<void> {
  fs.mkdirSync(root.directory, { recursive: true });
  const log = fs.openSync(path.join(root.directory, "daily-cycle-scheduler.log"), "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(import.meta.url),
        "--loop",
        "--dir",
        root.directory,
        "--cycle-timeout-ms",
        String(options.timeoutMs),
        ...options.extraArgs,
      ],
      {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ["ignore", log, log, "ipc"],
        env: buildDetachedServeEnv(),
      },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (child.pid) {
          killProcessTree(child.pid);
        }
        onError(new Error("scheduler startup timed out; inspect daily-cycle-scheduler.log"));
      }, 10_000);
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.removeListener("message", onMessage);
        if (child.connected) {
          child.disconnect();
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(
          new Error(`scheduler exited before ready (${code}); inspect daily-cycle-scheduler.log`),
        );
      };
      const onMessage = (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "finance-scheduler-ready"
        ) {
          cleanup();
          resolve();
        }
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
    });
    child.unref();
    process.stdout.write(`detached scheduler ready pid=${child.pid}\n`);
  } finally {
    fs.closeSync(log);
  }
}

export function inspectFinanceSchedulerStatus(root: FinanceStateDir, at = new Date()) {
  const state = readFinanceSchedulerState(root.directory);
  const clock = financeEtClock(at);
  const pid = readFinanceSchedulerPid(root.directory);
  const processPresent = pid !== null && financeSchedulerPidPresent(pid);
  const lockPresent = fs.existsSync(path.join(root.directory, FINANCE_SCHEDULER_LOCK));
  return {
    boundary: "read_only_finance_scheduler_status",
    observedAt: at.toISOString(),
    timezone: FINANCE_MARKET_TZ,
    clock,
    root,
    pid,
    processPresent,
    lockPresent,
    // A PID/lock is not proof of identity, heartbeat or successful work.
    ownerObservation: processPresent
      ? lockPresent
        ? "process_and_lock_present"
        : "legacy_or_unlocked_process"
      : lockPresent
        ? "lock_requires_reconciliation"
        : "no_process_observed",
    progress: inspectFinanceSchedulerProgress(root.directory, pid, processPresent, at.getTime()),
    executionHealthVerified: false,
    slots: DEFAULT_FINANCE_CYCLE_SLOTS.map((slot) => ({
      mode: slot.mode,
      scheduledTime: `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`,
      status:
        state.lastStatus[slot.mode] === "running" && state.lastFired[slot.mode] !== clock.date
          ? "reconciliation_required"
          : state.lastFired[slot.mode] === clock.date
            ? (state.lastStatus[slot.mode] ??
              (state.lastSucceeded[slot.mode] === clock.date
                ? "succeeded"
                : "attempted_outcome_unknown"))
            : !FINANCE_TRADING_WEEKDAYS.includes(clock.weekday)
              ? "outside_schedule"
              : isFinanceCycleSlotDue(slot, clock, state.lastFired)
                ? "due_unattempted"
                : "not_due",
      attemptedDate: state.lastFired[slot.mode] ?? null,
      succeededDate: state.lastSucceeded[slot.mode] ?? null,
    })),
    lastRun: state.lastRun
      ? {
          runId: state.lastRun.runId,
          mode: state.lastRun.mode,
          status: state.lastRun.status,
          firedAt: state.lastRun.firedAt,
          exitCode: state.lastRun.exitCode,
          durationMs: state.lastRun.durationMs,
          execution: state.lastRun.execution ?? { outcome: "unknown_legacy_run" },
        }
      : null,
  };
}

function status(root: FinanceStateDir, configError: string | null, json: boolean): void {
  const report = { ...inspectFinanceSchedulerStatus(root), configError };
  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : [
          `tz=${report.timezone}`,
          `et now: ${report.clock.date} ${report.clock.weekday} ${report.clock.minutes} min past midnight`,
          `pid file: ${report.pid ?? "(none)"}; process present: ${report.processPresent}`,
          `lock present: ${report.lockPresent}; owner observation: ${report.ownerObservation}`,
          `finance root: ${root.directory} (${root.source})`,
          `progress: ${JSON.stringify(report.progress)}`,
          ...(configError ? [`config unavailable: ${configError}`] : []),
          ...report.slots.map(
            (slot) =>
              `${slot.mode} ${slot.scheduledTime}: ${slot.status}; attempted=${slot.attemptedDate}; succeeded=${slot.succeededDate}`,
          ),
          `lastRun: ${JSON.stringify(report.lastRun)}`,
          "Process presence is not proof of healthy scheduling; running without an owner requires reconciliation.",
        ].join("\n") + "\n",
  );
}

export async function runFinanceScheduler(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseFinanceSchedulerArgs(argv);
  let configError: string | null = null;
  if (!options.directory) {
    try {
      applyConfigEnvVars(loadConfig());
    } catch (error) {
      configError = String(error);
    }
  }
  const root = resolveFinanceStateDir({ directory: options.directory });
  if (options.command === "status") {
    status(root, configError, options.json);
    return 0;
  }
  if (configError) {
    throw new Error(
      `cannot resolve configured finance book: ${configError}; supply --dir explicitly`,
    );
  }
  if (options.command === "detach") {
    await detach(root, options);
    return 0;
  }
  const controller = new AbortController();
  let signalExitCode = 0;
  const onTerm = () => {
    signalExitCode = 143;
    controller.abort();
  };
  const onInt = () => {
    signalExitCode = 130;
    controller.abort();
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  let release: (() => void) | undefined;
  try {
    release = acquireFinanceSchedulerLock(root.directory);
    readFinanceSchedulerState(root.directory);
    const context = { root, options, signal: controller.signal };
    if (options.command === "once") {
      const ok = await fire(context, options.mode!);
      return signalExitCode || (ok ? 0 : 1);
    }
    process.stdout.write(
      `scheduler pid=${process.pid} tz=${FINANCE_MARKET_TZ} root=${root.directory} timeoutMs=${options.timeoutMs}\n`,
    );
    if (process.connected) {
      process.send?.({ type: "finance-scheduler-ready" });
    }
    while (!controller.signal.aborted) {
      writeSchedulerProgress(context, "idle");
      await tick(context);
      writeSchedulerProgress(context, "idle");
      try {
        await delay(FINANCE_SCHEDULER_TICK_MS, undefined, { signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) {
          throw error;
        }
      }
    }
    return signalExitCode;
  } finally {
    try {
      release?.();
    } finally {
      process.removeListener("SIGTERM", onTerm);
      process.removeListener("SIGINT", onInt);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runFinanceScheduler()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
