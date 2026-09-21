/**
 * Operator entry for the unattended finance day.
 *
 * Two modes, and the split is the point:
 *   day   - data, signal, drift, rebalance. Zero model calls.
 *   night - settle matured calls and build the reflection. Zero model calls.
 *
 * The one place a model is wanted is the self-calibration step, and that is deliberately NOT in
 * this file. Keeping it out means the daily cost is zero no matter how often cron fires, and the
 * expensive step stays a separate, separately-budgeted invocation.
 *
 * Instruments come from the ACTIVE rule in the strategy ledger, never from a hard-coded list, so
 * the schedule follows the declared rule instead of drifting from it.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-daily-cycle.ts [--json] \
 *     [--mode day|night] [--dir PATH] [--as-of ISO] [--equity N] [--band N] [--place]
 */

import { fetchAlpacaAccountSnapshot } from "../../src/agents/finance-alpaca-run.js";
import { runFinanceDailyCycle } from "../../src/agents/finance-daily-cycle.js";
import { readFinanceLinkHealth } from "../../src/agents/finance-link-health.js";
import { backfillOutcomes } from "../../src/agents/finance-outcome-backfill.js";
import { buildReflection } from "../../src/agents/finance-reflection.js";
import { resolveScopedOverride } from "../../src/agents/finance-scoped-override.js";
import {
  FINANCE_RESEARCH_SAMPLES_FILENAME,
  FINANCE_RESEARCH_SCORED_FILENAME,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "../../src/agents/finance-strategy-rule-ledger.js";

// Named in `finance-state-dir.ts` alongside the rest of the plane: the cycle writes these and the
// calibration reader reads them back, so the names are declared once.
const SAMPLES_FILE = FINANCE_RESEARCH_SAMPLES_FILENAME;
const SCORED_FILE = FINANCE_RESEARCH_SCORED_FILENAME;

/**
 * Read one field of a settled row as text.
 *
 * A row comes off disk as parsed JSON, so a field is whatever the file happened to hold. Anything
 * that is not a string reads as empty rather than as "[object Object]": two rows missing the same
 * field must not collide into one identity, and an unreadable row must not silently become the
 * same call as another one.
 */
function rowText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : "";
}

/** Identity of one settled call, so a re-run does not score it twice. */
function scoredOutcomeKey(row: Record<string, unknown>): string {
  return [
    rowText(row, "instrument").toUpperCase(),
    rowText(row, "asOf").slice(0, 10),
    rowText(row, "direction"),
  ].join("@");
}

/**
 * Append settled outcomes to the scored file, skipping calls already on file.
 *
 * Written through a temporary file and renamed, the way the rest of this plane is: the scored set
 * is read back to decide what is already settled, so a half-written file would parse as a short,
 * wrong history — and a short history reads as "few calls", which is a different claim.
 */
async function appendScoredOutcomes(
  path: string,
  rows: readonly Record<string, unknown>[],
): Promise<{ path: string; appended: number; skipped: number }> {
  let existing: string[] = [];
  try {
    const { readFile } = await import("node:fs/promises");
    existing = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  } catch {
    existing = [];
  }
  const known = new Set<string>();
  for (const line of existing) {
    try {
      known.add(scoredOutcomeKey(JSON.parse(line) as Record<string, unknown>));
    } catch {
      // An unparseable line is not evidence that a call was settled, and rewriting the file to
      // drop it would destroy history to fix formatting. Skipped, and preserved on rewrite.
    }
  }
  const fresh = rows.filter((row) => !known.has(scoredOutcomeKey(row)));
  if (fresh.length === 0) {
    return { path, appended: 0, skipped: rows.length };
  }
  const { writeFile, rename, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  const lines = [...existing, ...fresh.map((row) => JSON.stringify(row))];
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${lines.join("\n")}\n`, "utf8");
  await rename(tmp, path);
  return { path, appended: fresh.length, skipped: rows.length - fresh.length };
}

/**
 * The plane's own wiring, asked inside the run that goes unattended.
 *
 * Kept from failing the cycle: a health check that aborts the run it is checking would turn an
 * observation into an outage. It reports its own failure instead, so "the check could not run"
 * never reads as "the wiring is fine".
 */
async function safeLinkHealth(directory: string): Promise<unknown> {
  try {
    return await readFinanceLinkHealth({ directory });
  } catch (error) {
    return {
      schemaVersion: "lcx_finance_link_health_v1",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type Mode = "day" | "night";

type Options = Readonly<{
  json: boolean;
  mode: Mode;
  directory?: string;
  asOf: string;
  equity: number;
  band: number;
  place: boolean;
  venue: "paper" | "alpaca";
  equityFromVenue: boolean;
  /**
   * Declared risk caps. They are flags rather than constants because a boundary nobody chose
   * is not a boundary: the unattended budget refuses an undeclared cap, and a cap the script
   * author hard-coded is one the operator never agreed to.
   */
  maxOrderNotional: number;
  maxInstrumentNotional: number;
  maxOrdersPerRun: number;
}>;

const USAGE =
  "Usage: node --import tsx scripts/operator/lcx-finance-daily-cycle.ts [--json] " +
  "[--mode day|night] [--dir PATH] [--as-of ISO] [--equity N] [--band N] [--place] " +
  "[--venue paper|alpaca] [--equity-from-venue] " +
  "[--max-order-notional N] [--max-instrument-notional N] [--max-orders N]";

function positiveNumber(raw: string | undefined, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number\n${USAGE}`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): Options {
  const options = {
    json: false,
    mode: "day" as Mode,
    asOf: new Date().toISOString(),
    equity: 100_000,
    band: 0.05,
    place: false,
    venue: "paper" as "paper" | "alpaca",
    equityFromVenue: false,
    directory: undefined as string | undefined,
    // Defaults, not constants: they reproduce the previous behaviour when nothing is passed.
    maxOrderNotional: 10_000,
    maxInstrumentNotional: 20_000,
    maxOrdersPerRun: 8,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--mode") {
      if (next !== "day" && next !== "night") {
        throw new Error(`--mode must be day or night\n${USAGE}`);
      }
      options.mode = next;
      index += 1;
    } else if (arg === "--dir") {
      options.directory = next;
      index += 1;
    } else if (arg === "--as-of") {
      options.asOf = next ?? options.asOf;
      index += 1;
    } else if (arg === "--equity") {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--equity must be a positive number\n${USAGE}`);
      }
      options.equity = parsed;
      index += 1;
    } else if (arg === "--band") {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--band must be a non-negative number\n${USAGE}`);
      }
      options.band = parsed;
      index += 1;
    } else if (arg === "--place") {
      options.place = true;
    } else if (arg === "--venue") {
      if (next !== "paper" && next !== "alpaca") {
        throw new Error(`--venue must be paper or alpaca\n${USAGE}`);
      }
      options.venue = next;
      index += 1;
    } else if (arg === "--equity-from-venue") {
      options.equityFromVenue = true;
    } else if (arg === "--max-order-notional") {
      options.maxOrderNotional = positiveNumber(next, "--max-order-notional");
      index += 1;
    } else if (arg === "--max-instrument-notional") {
      options.maxInstrumentNotional = positiveNumber(next, "--max-instrument-notional");
      index += 1;
    } else if (arg === "--max-orders") {
      options.maxOrdersPerRun = Math.floor(positiveNumber(next, "--max-orders"));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    } else {
      throw new Error(`unknown argument: ${arg ?? ""}\n${USAGE}`);
    }
  }
  return options;
}

async function activeInstruments(directory: string): Promise<{
  instruments: readonly string[];
  ruleIds: readonly string[];
}> {
  const read = await readFinanceStrategyRuleLedger(directory, {});
  const active = read.ledger.rules.filter((rule) => rule.state === "active");
  const instruments = [...new Set(active.flatMap((rule) => [...rule.instruments]))];
  return { instruments, ruleIds: active.map((rule) => rule.ruleId) };
}

export async function runFinanceDailyCycleOperator(
  argv: readonly string[] = process.argv.slice(2),
): Promise<Record<string, unknown>> {
  const options = parseArgs(argv);
  const directory = options.directory ?? resolveFinanceStateDir().directory;
  let equity = options.equity;
  let equitySource: "flag" | "default" | "venue" | "venue-failed" = argv.includes("--equity")
    ? "flag"
    : "default";
  if (
    options.equityFromVenue ||
    (options.mode === "day" && options.place && options.venue === "alpaca")
  ) {
    if (options.venue !== "alpaca") {
      return {
        directory,
        mode: options.mode,
        asOf: options.asOf,
        ok: false,
        error: "--equity-from-venue requires --venue alpaca",
      };
    }
    const snapshot = await fetchAlpacaAccountSnapshot();
    if (!snapshot.ok) {
      return {
        directory,
        mode: options.mode,
        asOf: options.asOf,
        ok: false,
        equitySource: "venue-failed",
        error: `account verification failed: ${snapshot.reason}`,
      };
    }
    if (
      !Number.isFinite(snapshot.account.equity) ||
      snapshot.account.equity <= 0 ||
      snapshot.account.status !== "ACTIVE" ||
      snapshot.account.tradingBlocked
    ) {
      return {
        directory,
        mode: options.mode,
        asOf: options.asOf,
        ok: false,
        equitySource: "venue",
        error: "account is not active, trading is blocked, or equity is invalid",
      };
    }
    if (
      options.equityFromVenue ||
      (options.mode === "day" && options.place && !argv.includes("--equity"))
    ) {
      equity = snapshot.account.equity;
      equitySource = "venue";
    } else if (options.mode === "day" && options.place && equity > snapshot.account.equity) {
      return {
        directory,
        mode: options.mode,
        asOf: options.asOf,
        ok: false,
        equitySource,
        error: "declared strategy equity exceeds verified account equity",
      };
    }
  }

  const base = { directory, mode: options.mode, asOf: options.asOf, equity, equitySource };

  try {
    let instruments: readonly string[] = [];
    let ruleIds: readonly string[] = [];
    let ruleIssue = "";
    try {
      const active = await activeInstruments(directory);
      instruments = active.instruments;
      ruleIds = active.ruleIds;
    } catch (error) {
      // A day run with no rule book has nothing to collect and nothing to trade, so it stops.
      // A night run settles calls that were already recorded: it reads the samples, never the
      // rules. Failing it here would end the reflection loop on a fault in a book it never reads.
      if (options.mode === "day") {
        throw error;
      }
      ruleIssue =
        "rule book unreadable, settled the recorded calls anyway: " +
        (error instanceof Error ? error.message : String(error));
    }
    // Only the day run needs a universe. Pausing every rule is a decision about trading, not
    // about remembering: a night that refuses to settle because nothing is active is a night the
    // system stops learning from itself, and it does it silently.
    if (options.mode === "day" && instruments.length === 0) {
      return { ...base, ok: false, error: "no active rule declares any instrument" };
    }

    if (options.mode === "day") {
      // A declared override is resolved here, where the cap is actually read.
      // Without this the override tool writes a file nothing consults and reports
      // success for a change that never takes effect.
      const ordersOverride = await resolveScopedOverride({
        knob: "maxOrdersPerRun",
        fallback: options.maxOrdersPerRun,
      });
      const report = await runFinanceDailyCycle({
        instruments,
        equity,
        asOf: options.asOf,
        caps: {
          maxOrderNotional: options.maxOrderNotional,
          maxInstrumentNotional: options.maxInstrumentNotional,
          maxOrdersPerRun: ordersOverride.value,
        },
        runAuthorizationId: `daily-cycle:${options.asOf.slice(0, 10)}`,
        rebalanceBand: options.band,
        place: options.place,
        venue: options.venue,
        directory,
      });
      const payload = {
        ...base,
        ok: report.ok,
        ruleIds,
        modelCalls: report.modelCalls,
        signalAnchor: report.signalAnchor,
        // Reported so a run can be read back against the boundary it actually used.
        caps: {
          maxOrderNotional: options.maxOrderNotional,
          maxInstrumentNotional: options.maxInstrumentNotional,
          maxOrdersPerRun: ordersOverride.value,
        },
        targets: report.targets,
        drift: report.drift,
        dataIssues: report.dataIssues,
        placed: report.placed,
        refusals: report.refusals,
        // Surfaced, not just performed: `appended: false` means the history was already in the
        // book, which is the normal steady state. Without this line an operator cannot tell
        // "nothing was filed" from "the run never tried".
        barsFiled: report.barsFiled,
        // Priced, not just collected: what this run did with the bars it just filed. Left out of
        // the payload once and it read as "nothing was re-priced" while seven positions had been.
        marksFiled: report.marksFiled,
        unpricedHoldings: report.unpricedHoldings,
        // Whether the plane is still wired together, asked by the run that nobody watches. A
        // position held outside every rule, or priced with a day the book has passed, does not
        // show up in this cycle's own numbers — it shows up here or nowhere.
        linkHealth: await safeLinkHealth(directory),
      };
      if (!options.json) {
        process.stdout.write(`${renderDay(payload)}\n`);
      }
      return payload;
    }

    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let samples: unknown[] = [];
    try {
      samples = (await readFile(join(directory, SAMPLES_FILE), "utf8"))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      samples = [];
    }
    const settled = await backfillOutcomes({
      samples: samples as Parameters<typeof backfillOutcomes>[0]["samples"],
      asOf: options.asOf,
    });
    // Filed, not just computed. A settlement that is worked out every night and then dropped
    // leaves calibration with nothing to read: the scored file stays empty, and the tool that
    // tells the model how its last judgement went reports "no history" forever. The samples the
    // calls came from are append-only, so the scores are too — re-scoring the same call must not
    // add a second copy of it.
    const scoredFiled = await appendScoredOutcomes(
      join(directory, SCORED_FILE),
      settled.scored as readonly Record<string, unknown>[],
    );
    const reflection =
      settled.scored.length > 0 ? buildReflection(settled.scored, { instanceLimit: 5 }) : null;
    const issues = [...settled.issues, ruleIssue].filter((item) => item.length > 0);
    const payload = {
      ...base,
      ok: issues.length === 0,
      ruleIds,
      // Stated because an empty `ruleIds` is otherwise indistinguishable from a rule book that
      // could not be read: settlement went ahead either way, and this says which it was.
      rulesActive: ruleIds.length > 0,
      modelCalls: 0,
      sampleCount: samples.length,
      scored: settled.scored,
      scoredFiled,
      pending: settled.pending,
      declined: settled.declined,
      reflection,
      issues,
    };
    if (!options.json) {
      process.stdout.write(`${renderNight(payload)}\n`);
    }
    return payload;
  } catch (error) {
    const payload = {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    if (!options.json) {
      process.stdout.write(`finance daily cycle: 错误: ${String(payload.error)}\n`);
    }
    return payload;
  }
}

function renderDay(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("Finance daily cycle — day");
  lines.push(`  目录: ${String(payload.directory)}`);
  lines.push(`  规则: ${(payload.ruleIds as string[]).join(", ")}`);
  lines.push(
    `  信号锚点: ${String(payload.signalAnchor)}  模型调用: ${String(payload.modelCalls)}`,
  );
  const drift = payload.drift as { instrument: string; action: string; notional: number }[];
  const acting = drift.filter((row) => row.action !== "none");
  lines.push(`  需要动作: ${acting.length} / ${drift.length}`);
  for (const row of acting) {
    lines.push(`    - ${row.instrument} ${row.action} ${row.notional}`);
  }
  const placed = payload.placed as { instrument: string; quantity: number }[];
  if (placed.length > 0) {
    lines.push(`  已成交: ${placed.map((row) => `${row.instrument}x${row.quantity}`).join(", ")}`);
  } else {
    lines.push("  已成交: 无（未给 --place 或无需动作）");
  }
  const issues = payload.dataIssues as string[];
  if (issues.length > 0) {
    lines.push(`  数据问题: ${issues.join("; ")}`);
  }
  lines.push("边界：不下真实单；未给 --place 只输出计划。");
  return lines.join("\n");
}

function renderNight(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("Finance daily cycle — night");
  lines.push(`  目录: ${String(payload.directory)}`);
  lines.push(
    `  样本: ${String(payload.sampleCount)}  已结算: ${(payload.scored as unknown[]).length}  未到期: ${(payload.pending as unknown[]).length}  被拒(不计命中率): ${(payload.declined as unknown[]).length}`,
  );
  const reflection = payload.reflection as {
    hitRate: number | null;
    brier: number | null;
    overconfidenceGap: number | null;
    instances: readonly string[];
  } | null;
  if (reflection) {
    lines.push(
      `  命中率: ${reflection.hitRate?.toFixed(3) ?? "n/a"}  Brier: ${reflection.brier?.toFixed(4) ?? "n/a"}  过度自信差: ${reflection.overconfidenceGap?.toFixed(4) ?? "n/a"}`,
    );
    for (const line of reflection.instances) {
      lines.push(`    - ${line}`);
    }
  } else {
    lines.push("  反思: 无已结算样本（不足则不编造基线）");
  }
  lines.push("边界：只报事实，不下指令；自我校准是另一次独立、单独预算的调用。");
  return lines.join("\n");
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes("--json");
  const payload = await runFinanceDailyCycleOperator(argv);
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  if (payload["ok"] === false) {
    process.exitCode = 1;
  }
}
