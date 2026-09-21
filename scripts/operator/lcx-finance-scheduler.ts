/**
 * Standalone weekday scheduler for the unattended finance cycle.
 *
 * Why this is a separate process instead of an LCX cron job:
 * - LCX cron payloads are only `agentTurn` / `systemEvent`, so every fire runs a model.
 * - The `exec` tool is not in this agent's tool set (verified: both the isolated cron session
 *   and the main `serve` session report no `exec`), so an agentTurn job cannot run the script
 *   at all — it burns tokens and returns "I have no exec tool".
 * - `lcx cron add` goes through the Gateway, which is disabled here.
 * - `crontab` is blocked ("operation not permitted") and `launchctl bootstrap` is unreliable.
 *
 * So the arithmetic cycles run here: no model in the loop, no Gateway, no agent. Firing is a
 * plain `spawn` of the operator script. The one place a model is wanted (nightly
 * self-calibration) is deliberately NOT here.
 *
 * All scheduling is done in America/New_York wall clock via `Intl`, so DST is handled by the
 * runtime rather than by a fixed UTC offset.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-scheduler.ts --once day   # fire now, exit
 *   node --import tsx scripts/operator/lcx-finance-scheduler.ts --loop       # stay resident
 *   node --import tsx scripts/operator/lcx-finance-scheduler.ts --detach     # spawn detached
 *   node --import tsx scripts/operator/lcx-finance-scheduler.ts --status
 *
 * `--dir PATH` picks the finance state root (default: the config `env.vars` declaration, else
 * the workspace default — the same resolution the agent's tools use) and is passed down to
 * every cycle, so the book this loop feeds is the book the agent reads.
 * `--place`, `--venue paper|alpaca`, `--equity-from-venue` and the three `--max-*` caps are
 * forwarded to the cycle. Without `--place` nothing is sent to the venue; without
 * `--venue alpaca` the run stays on the local simulator.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FINANCE_CYCLE_SLOTS,
  FINANCE_MARKET_TZ,
  financeEtClock,
  isFinanceCycleSlotDue,
} from "../../src/agents/finance-cycle-schedule.js";
import {
  resolveFinanceStateDir,
  type FinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import { buildDetachedServeEnv } from "../../src/cli/serve-detach.js";
import { loadConfig } from "../../src/config/config.js";
import { applyConfigEnvVars } from "../../src/config/env-vars.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Which book this scheduler writes, decided once and handed to the child explicitly.
 *
 * It used to be an accident: this process hardcoded `<repo>/state/finance` for its own
 * bookkeeping while the cycle it spawns resolved `resolveFinanceStateDir()` from *its* cwd.
 * Those agree only while both are the repository root, and nothing complains when they stop
 * agreeing — the cycle writes one book, the agent reads the other, and an empty book is
 * indistinguishable from a flat account. A `--dir` flag passed to this script was silently
 * ignored, which is the same failure with a clearer intent behind it.
 *
 * So the root is resolved here (explicit `--dir` wins, then the config `env.vars` the agent
 * reads its own root from, then the workspace default) and passed to the cycle as `--dir`.
 */
function resolveSchedulerRoot(argv: readonly string[]): {
  root: FinanceStateDir;
  configError: string | null;
} {
  const dirIndex = argv.indexOf("--dir");
  const explicit = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;
  if (dirIndex >= 0 && (!explicit || explicit.startsWith("--"))) {
    throw new Error("--dir requires a path");
  }
  let configError: string | null = null;
  if (!explicit) {
    try {
      applyConfigEnvVars(loadConfig());
    } catch (error) {
      // Reported, not fatal: a cycle that writes the wrong book is worse than none, but a
      // scheduler that dies on a config typo takes the nightly run with it. The root and how
      // it was resolved are printed by `--status` and by every run record.
      configError = String(error);
    }
  }
  return { root: resolveFinanceStateDir({ directory: explicit }), configError };
}

const SCHEDULER_ARGV = process.argv.slice(2);
const SCHEDULER_ROOT = resolveSchedulerRoot(SCHEDULER_ARGV);
const FINANCE_ROOT: FinanceStateDir = SCHEDULER_ROOT.root;
const STATE_DIR = FINANCE_ROOT.directory;
const STATE_FILE = path.join(STATE_DIR, "daily-cycle-scheduler.json");
const RUNS_LOG = path.join(STATE_DIR, "daily-cycle-runs.jsonl");
const PID_FILE = path.join(STATE_DIR, "daily-cycle-scheduler.pid");
const CYCLE_SCRIPT = path.join(REPO_ROOT, "scripts", "operator", "lcx-finance-daily-cycle.ts");

const MARKET_TZ = FINANCE_MARKET_TZ;
const TICK_MS = 60_000;
const SLOTS = DEFAULT_FINANCE_CYCLE_SLOTS;

type SchedulerState = { lastFired: Record<string, string> };

function readState(): SchedulerState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const lastFired =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { lastFired?: unknown }).lastFired === "object"
        ? ((parsed as { lastFired: Record<string, string> }).lastFired ?? {})
        : {};
    return { lastFired: lastFired ?? {} };
  } catch {
    return { lastFired: {} };
  }
}

function writeState(state: SchedulerState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STATE_FILE);
}

type RunRecord = Readonly<{
  firedAt: string;
  etDate: string;
  mode: "day" | "night";
  exitCode: number | null;
  durationMs: number;
  ok: boolean;
  stdout: string;
  stderr: string;
}>;

function appendRun(record: RunRecord): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(RUNS_LOG, `${JSON.stringify(record)}\n`);
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

export function runCycle(mode: "day" | "night", extraArgs: readonly string[]): Promise<RunRecord> {
  const startedAt = Date.now();
  // The resolved root travels with the invocation, so the cycle's book cannot depend on the
  // cwd it happens to be spawned with.
  const args = [
    "--import",
    "tsx",
    CYCLE_SCRIPT,
    "--json",
    "--mode",
    mode,
    "--dir",
    FINANCE_ROOT.directory,
    ...extraArgs,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        firedAt: new Date(startedAt).toISOString(),
        etDate: financeEtClock(new Date(startedAt)).date,
        mode,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        ok: false,
        stdout,
        stderr: String(error),
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        firedAt: new Date(startedAt).toISOString(),
        etDate: financeEtClock(new Date(startedAt)).date,
        mode,
        exitCode,
        durationMs: Date.now() - startedAt,
        ok: exitCode === 0 && cycleOutputSucceeded(stdout),
        stdout,
        stderr,
      });
    });
  });
}

export async function fire(mode: "day" | "night", extraArgs: readonly string[]): Promise<void> {
  const etDate = financeEtClock(new Date()).date;
  if (readState().lastFired[mode] === etDate) {
    return;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const claimPath = path.join(STATE_DIR, `daily-cycle-${etDate}-${mode}.json`);
  // An exclusive durable claim prevents concurrent schedulers and crash recovery from
  // replaying a potentially submitted order. An unfinished claim requires reconciliation.
  try {
    fs.writeFileSync(claimPath, `${JSON.stringify({ etDate, mode, status: "started" })}\n`, {
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      process.stderr.write(`cycle blocked: existing claim ${claimPath}; reconcile before retry\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const record = await runCycle(mode, extraArgs);
  appendRun(record);
  const tmp = `${claimPath}.tmp-${randomUUID()}`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ ...record, status: record.ok ? "succeeded" : "failed" })}\n`,
  );
  fs.renameSync(tmp, claimPath);
  if (record.ok) {
    const state = readState();
    state.lastFired[mode] = record.etDate;
    writeState(state);
  } else {
    process.exitCode = 1;
  }
  process.stdout.write(
    `[${record.firedAt}] ${mode} exit=${record.exitCode} ${record.durationMs}ms ok=${record.ok}\n`,
  );
  if (!record.ok) {
    process.stderr.write(record.stderr.slice(0, 2000));
  }
}

async function tick(extraArgs: readonly string[]): Promise<void> {
  const clock = financeEtClock(new Date());
  const state = readState();
  for (const slot of SLOTS) {
    if (!isFinanceCycleSlotDue(slot, clock, state.lastFired)) {
      continue;
    }
    await fire(slot.mode, extraArgs);
  }
}

async function loop(extraArgs: readonly string[]): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  process.stdout.write(
    `scheduler pid=${process.pid} tz=${MARKET_TZ} slots=${SLOTS.length} ` +
      `root=${FINANCE_ROOT.directory} (${FINANCE_ROOT.source})` +
      `${SCHEDULER_ROOT.configError ? ` configError=${SCHEDULER_ROOT.configError}` : ""}\n`,
  );
  for (;;) {
    await tick(extraArgs);
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}

export function detach(extraArgs: readonly string[]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      "--loop",
      "--dir",
      FINANCE_ROOT.directory,
      ...extraArgs,
    ],
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: "ignore",
      // Drop session-scoped proxy vars and the CODEBUDDY_* shim so the resident process does not
      // inherit anything that only exists for this terminal session.
      env: buildDetachedServeEnv(),
    },
  );
  child.unref();
  process.stdout.write(`detached scheduler pid=${child.pid}\n`);
}

function status(): void {
  const state = readState();
  const clock = financeEtClock(new Date());
  const pid = fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, "utf8").trim() : "(none)";
  const runs = fs.existsSync(RUNS_LOG)
    ? fs
        .readFileSync(RUNS_LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-5)
        .map((line) => {
          try {
            const parsed = JSON.parse(line) as RunRecord;
            return `  ${parsed.firedAt} ${parsed.mode} exit=${parsed.exitCode} ${parsed.durationMs}ms ok=${parsed.ok}`;
          } catch {
            return `  (unparseable line)`;
          }
        })
    : [];
  process.stdout.write(
    [
      `tz=${MARKET_TZ}`,
      `et now: ${clock.date} ${clock.weekday} ${clock.minutes} min past midnight`,
      `pid file: ${pid}`,
      `finance root: ${FINANCE_ROOT.directory} (${FINANCE_ROOT.source})`,
      ...(SCHEDULER_ROOT.configError ? [`config unavailable: ${SCHEDULER_ROOT.configError}`] : []),
      `lastFired: ${JSON.stringify(state.lastFired)}`,
      `recent runs (${runs.length}):`,
      ...runs,
    ].join("\n") + "\n",
  );
}

/**
 * Everything after the scheduler's own switches is forwarded to the cycle verbatim.
 *
 * `--venue` matters more than it looks: the cycle defaults to the local simulator, so a
 * detached loop that is not told `alpaca` will happily run unattended against a book no venue
 * has ever seen. The venue is a decision, and a resident process must inherit it explicitly.
 */
function forwardedArgs(argv: readonly string[]): string[] {
  const forwarded: string[] = [];
  if (argv.includes("--place")) {
    forwarded.push("--place");
  }
  if (argv.includes("--equity-from-venue")) {
    forwarded.push("--equity-from-venue");
  }
  const venueIndex = argv.indexOf("--venue");
  if (venueIndex >= 0) {
    const venue = argv[venueIndex + 1];
    if (venue !== "paper" && venue !== "alpaca") {
      throw new Error("--venue must be paper or alpaca");
    }
    forwarded.push("--venue", venue);
  }
  // The caps are part of the authorisation, not tuning knobs: an unattended run has to name
  // every ceiling, so they are forwarded rather than left to the cycle's defaults.
  for (const flag of ["--max-order-notional", "--max-instrument-notional", "--max-orders"]) {
    const index = argv.indexOf(flag);
    if (index >= 0) {
      forwarded.push(flag, String(argv[index + 1]));
    }
  }
  return forwarded;
}

async function main(): Promise<void> {
  const argv = SCHEDULER_ARGV;
  const extraArgs = forwardedArgs(argv);

  if (argv.includes("--status")) {
    status();
    return;
  }
  if (argv.includes("--detach")) {
    detach(extraArgs);
    return;
  }
  const onceIndex = argv.indexOf("--once");
  if (onceIndex >= 0) {
    const mode = argv[onceIndex + 1];
    if (mode !== "day" && mode !== "night") {
      throw new Error("--once requires day or night");
    }
    await fire(mode, extraArgs);
    return;
  }
  if (argv.includes("--loop")) {
    await loop(extraArgs);
    return;
  }
  throw new Error("usage: --once day|night | --loop | --detach | --status");
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
