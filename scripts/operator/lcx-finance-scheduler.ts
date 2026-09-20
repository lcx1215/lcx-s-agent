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
import { buildDetachedServeEnv } from "../../src/cli/serve-detach.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_DIR = path.join(REPO_ROOT, "state", "finance");
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

function runCycle(mode: "day" | "night", extraArgs: readonly string[]): Promise<RunRecord> {
  const startedAt = Date.now();
  const args = ["--import", "tsx", CYCLE_SCRIPT, "--json", "--mode", mode, ...extraArgs];
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
        ok: exitCode === 0,
        stdout,
        stderr,
      });
    });
  });
}

async function fire(mode: "day" | "night", extraArgs: readonly string[]): Promise<void> {
  const record = await runCycle(mode, extraArgs);
  appendRun(record);
  const state = readState();
  state.lastFired[mode] = record.etDate;
  writeState(state);
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
    // Mark before running: a crash mid-run must not loop forever.
    state.lastFired[slot.mode] = clock.date;
    writeState(state);
    await fire(slot.mode, extraArgs);
  }
}

async function loop(extraArgs: readonly string[]): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  process.stdout.write(`scheduler pid=${process.pid} tz=${MARKET_TZ} slots=${SLOTS.length}\n`);
  for (;;) {
    await tick(extraArgs);
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}

function detach(extraArgs: readonly string[]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--loop", ...extraArgs],
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
  const argv = process.argv.slice(2);
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

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
