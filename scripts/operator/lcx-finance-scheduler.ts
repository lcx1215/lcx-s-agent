/**
 * Standalone weekday finance scheduler. Reuses the daily-cycle operator; its only model use is
 * the cycle's bounded configured-provider veto review for eligible Alpaca Paper candidates.
 * Scheduling uses America/New_York wall clock.
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
import { createFinanceAlpacaCycleController } from "../../src/agents/finance-alpaca-cycle-controller.js";
import { syncConfiguredAlpacaPaperHistory } from "../../src/agents/finance-alpaca-history-sync.js";
import {
  DEFAULT_FINANCE_CYCLE_SLOTS,
  FINANCE_MARKET_TZ,
  FINANCE_TRADING_WEEKDAYS,
  financeEtClock,
  isFinanceCycleSlotDue,
} from "../../src/agents/finance-cycle-schedule.js";
import { executeFinanceIntradayDecision } from "../../src/agents/finance-intraday-execution.js";
import { runFinanceIntradayMonitorTick } from "../../src/agents/finance-intraday-monitor.js";
import {
  buildFinanceNightReviewEvidence,
  writeFinanceNightReviewEvidence,
  type FinanceNightSettlementSummary,
} from "../../src/agents/finance-night-review-context.js";
import {
  acquireFinanceSchedulerLock,
  FINANCE_SCHEDULER_LOCK,
  financeSchedulerPidPresent,
  readFinanceSchedulerPid,
} from "../../src/agents/finance-scheduler-lock.js";
import {
  DEFAULT_FINANCE_CYCLE_TIMEOUT_MS,
  runFinanceCycleProcess,
  type FinanceCycleProcessResult,
} from "../../src/agents/finance-scheduler-process.js";
import {
  FINANCE_SCHEDULER_TICK_MS,
  inspectFinanceSchedulerProgress,
  readFinanceSchedulerPolicyExpiry,
  readFinanceSchedulerState,
  writeFinanceSchedulerState,
} from "../../src/agents/finance-scheduler-state.js";
import {
  FINANCE_DAILY_CYCLE_RUNS_FILENAME,
  resolveFinanceStateDir,
  type FinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import { runFinanceTuningLifecycle } from "../../src/agents/finance-tuning-lifecycle.js";
import { buildDetachedServeEnv } from "../../src/cli/serve-detach.js";
import { loadConfig } from "../../src/config/config.js";
import { applyConfigEnvVars } from "../../src/config/env-vars.js";
import { killProcessTree } from "../../src/process/kill-tree.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CYCLE_SCRIPT = path.join(REPO_ROOT, "scripts", "operator", "lcx-finance-daily-cycle.ts");
const RESEARCH_SCRIPT = path.join(REPO_ROOT, "scripts", "operator", "lcx-finance-research-run.ts");
const RUNS_LOG = FINANCE_DAILY_CYCLE_RUNS_FILENAME;
/** Keep the five-minute reconciliation evidence fresh without coupling it to a trade slot. */
export const FINANCE_IDLE_RECONCILIATION_INTERVAL_MS = 4 * 60_000;
type Mode = "day" | "night";

type ResearchPlanConfig = Readonly<{
  contextPath: string;
  ask: string;
}>;

type IntradayMonitorConfig = Readonly<{
  place: boolean;
  instruments: readonly string[];
  intervalSeconds: 60 | 300 | 900;
  feed: "iex" | "sip";
  openingRangeBars: number;
  rewardRisk: number;
}>;

type SchedulerOptions = {
  command: "once" | "loop" | "detach" | "status";
  mode?: Mode;
  directory?: string;
  timeoutMs: number;
  extraArgs: string[];
  intraday?: IntradayMonitorConfig;
  researchPlan?: ResearchPlanConfig;
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
  let intradayEnabled = false;
  let intradayPlace = false;
  let intradayInstruments: string[] = [];
  let intradayIntervalSeconds: 60 | 300 | 900 = 300;
  let intradayFeed: "iex" | "sip" = "iex";
  let intradayOpeningRangeBars = 6;
  let intradayRewardRisk = 2;
  let researchContextPath: string | undefined;
  let researchAsk: string | undefined;
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
    } else if (arg === "--intraday-monitor") {
      intradayEnabled = true;
    } else if (arg === "--intraday-place") {
      intradayPlace = true;
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
        "--intraday-instruments",
        "--intraday-interval-seconds",
        "--intraday-feed",
        "--intraday-opening-range-bars",
        "--intraday-reward-risk",
        "--research-portfolio-context",
        "--research-ask",
      ].includes(arg)
    ) {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--dir") {
        directory = value;
      } else if (arg === "--research-portfolio-context") {
        researchContextPath = path.resolve(value);
      } else if (arg === "--research-ask") {
        researchAsk = value;
      } else if (arg === "--intraday-instruments") {
        intradayInstruments = [
          ...new Set(
            value
              .split(",")
              .map((item) => item.trim().toUpperCase())
              .filter(Boolean),
          ),
        ];
      } else if (arg === "--intraday-feed") {
        if (value !== "iex" && value !== "sip") {
          throw new Error("--intraday-feed must be iex or sip");
        }
        intradayFeed = value;
      } else if (arg === "--intraday-interval-seconds") {
        const interval = Number(value);
        if (interval !== 60 && interval !== 300 && interval !== 900) {
          throw new Error("--intraday-interval-seconds must be 60, 300, or 900");
        }
        intradayIntervalSeconds = interval;
      } else if (arg === "--intraday-opening-range-bars") {
        const count = Number(value);
        if (!Number.isInteger(count) || count < 2 || count > 12) {
          throw new Error("--intraday-opening-range-bars must be an integer in [2,12]");
        }
        intradayOpeningRangeBars = count;
      } else if (arg === "--intraday-reward-risk") {
        const ratio = Number(value);
        if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 10) {
          throw new Error("--intraday-reward-risk must be in (0,10]");
        }
        intradayRewardRisk = ratio;
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
  if (intradayEnabled && intradayInstruments.length === 0) {
    throw new Error("--intraday-monitor requires --intraday-instruments");
  }
  if (Boolean(researchContextPath) !== Boolean(researchAsk)) {
    throw new Error(
      "research plan refresh requires both --research-portfolio-context and --research-ask",
    );
  }
  if (researchContextPath && extraArgs.includes("--portfolio-plan")) {
    throw new Error("automatic research plan refresh cannot combine a static --portfolio-plan");
  }
  if (intradayPlace && !intradayEnabled) {
    throw new Error("--intraday-place requires --intraday-monitor");
  }
  if (intradayEnabled && intradayPlace) {
    if (!extraArgs.includes("--place")) {
      throw new Error("--intraday-place requires the shared --place authorization");
    }
    if (extraArgs[extraArgs.indexOf("--venue") + 1] !== "alpaca") {
      throw new Error("intraday placement requires --venue alpaca (paper account only)");
    }
    const missingCaps = [
      "--max-order-notional",
      "--max-instrument-notional",
      "--max-orders",
    ].filter((flag) => !extraArgs.includes(flag));
    if (missingCaps.length) {
      throw new Error(`intraday placement requires ${missingCaps.join(", ")}`);
    }
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
  return {
    command,
    mode,
    directory,
    timeoutMs,
    extraArgs,
    json,
    ...(intradayEnabled
      ? {
          intraday: {
            place: intradayPlace,
            instruments: Object.freeze(intradayInstruments),
            intervalSeconds: intradayIntervalSeconds,
            feed: intradayFeed,
            openingRangeBars: intradayOpeningRangeBars,
            rewardRisk: intradayRewardRisk,
          },
        }
      : {}),
    ...(researchContextPath && researchAsk
      ? { researchPlan: { contextPath: researchContextPath, ask: researchAsk } }
      : {}),
  };
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

function parseNightSettlement(stdout: string): FinanceNightSettlementSummary {
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  const scoredFiled = payload.scoredFiled as Record<string, unknown> | undefined;
  if (
    !scoredFiled ||
    !Number.isSafeInteger(scoredFiled.appended) ||
    !Number.isSafeInteger(scoredFiled.skipped) ||
    !Array.isArray(payload.pending) ||
    !Array.isArray(payload.declined) ||
    !Array.isArray(payload.issues)
  ) {
    throw new Error("night settlement output is missing its durable feedback summary");
  }
  return Object.freeze({
    scoredFiled: Object.freeze({
      appended: Number(scoredFiled.appended),
      skipped: Number(scoredFiled.skipped),
    }),
    reflection: payload.reflection,
    pending: Object.freeze([...payload.pending]),
    declined: Object.freeze([...payload.declined]),
    issues: Object.freeze([...payload.issues]),
  });
}

async function runNightResearchReview(params: {
  context: CycleContext;
  attempt: { firedAt: string; etDate: string };
  settlement: FinanceNightSettlementSummary;
}): Promise<FinanceCycleProcessResult> {
  try {
    const evidencePath = path.join(
      params.context.root.directory,
      `night-review-evidence-${params.attempt.etDate}.json`,
    );
    const evidence = await buildFinanceNightReviewEvidence({
      directory: params.context.root.directory,
      asOf: params.attempt.firedAt,
      etDate: params.attempt.etDate,
      settlement: params.settlement,
    });
    await writeFinanceNightReviewEvidence(evidencePath, evidence);
    return runFinanceCycleProcess({
      argv: [
        "--import",
        "tsx",
        RESEARCH_SCRIPT,
        "--live",
        "--workflow-models",
        "--execute-modules",
        "--write",
        "--json",
        "--decision-mode",
        "research_only",
        "--as-of",
        params.attempt.firedAt,
        "--ask",
        `Night review, reflection, portfolio risk and fresh news follow-up. Reassess the active evidence and invalidations for: ${params.context.options.researchPlan!.ask}`,
        "--controller-evidence",
        evidencePath,
      ],
      cwd: REPO_ROOT,
      timeoutMs: params.context.options.timeoutMs,
      signal: params.context.signal,
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      status: "failed",
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      outputTruncated: false,
    };
  }
}

function runNightTuning(params: {
  directory: string;
  firedAt: string;
  settlement: FinanceNightSettlementSummary;
}) {
  if (params.settlement.scoredFiled.appended === 0) {
    return Object.freeze({ ok: true, status: "no_new_scored_outcomes", result: null });
  }
  try {
    return Object.freeze({
      ok: true,
      status: "completed",
      result: runFinanceTuningLifecycle({
        directory: params.directory,
        generatedAt: params.firedAt,
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      status: "failed",
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
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
  const review =
    payload.tradeDecisionReview !== null && typeof payload.tradeDecisionReview === "object"
      ? (payload.tradeDecisionReview as Record<string, unknown>)
      : undefined;
  const reviewDecisions: Record<string, unknown>[] = Array.isArray(review?.decisions)
    ? review.decisions.filter(
        (decision: unknown): decision is Record<string, unknown> =>
          decision !== null && typeof decision === "object" && !Array.isArray(decision),
      )
    : [];
  const approvedCount = reviewDecisions.filter(
    (decision) => decision.decision === "approve",
  ).length;
  const vetoedCount = reviewDecisions.filter((decision) => decision.decision === "veto").length;
  const tradeDecisionReview = review
    ? {
        status:
          review.status === "completed" ||
          review.status === "failed" ||
          review.status === "not_needed"
            ? review.status
            : "unknown",
        candidateCount:
          Number.isSafeInteger(review.candidateCount) && Number(review.candidateCount) >= 0
            ? Number(review.candidateCount)
            : null,
        modelCalls:
          Number.isSafeInteger(review.modelCalls) && Number(review.modelCalls) >= 0
            ? Number(review.modelCalls)
            : null,
        approvedCount,
        vetoedCount,
        ...(typeof review.provider === "string" ? { provider: review.provider } : {}),
        ...(typeof review.modelId === "string" ? { modelId: review.modelId } : {}),
        ...(typeof review.latencyMs === "number" && Number.isFinite(review.latencyMs)
          ? { latencyMs: review.latencyMs }
          : {}),
        ...(typeof review.providerCallObserved === "boolean"
          ? { providerCallObserved: review.providerCallObserved }
          : {}),
        ...(typeof review.adapterAttested === "boolean"
          ? { adapterAttested: review.adapterAttested }
          : {}),
        ...(typeof review.requestIdSha256 === "string"
          ? { requestIdSha256: review.requestIdSha256 }
          : {}),
        ...(typeof review.failureCode === "string" ? { failureCode: review.failureCode } : {}),
      }
    : null;
  const reviewFailed = review?.status === "failed";
  const allCandidatesVetoed =
    review?.status === "completed" &&
    Number.isSafeInteger(review.candidateCount) &&
    Number(review.candidateCount) > 0 &&
    vetoedCount === Number(review.candidateCount);
  // Readiness is a strategy diagnostic, not proof that this cycle's execution was blocked.
  // New cycle payloads identify the actual refusal explicitly; recognize the former error text
  // only for receipts written before `failureKind` existed.
  const legacyReadinessBlock =
    payload.ok === false &&
    typeof payload.error === "string" &&
    payload.error.includes(
      "active strategy rule is not paper-ready under the declared readiness evidence",
    );
  const readinessBlocked =
    payload.failureKind === "execution_readiness_gate" || legacyReadinessBlock;
  const outcome = readinessBlocked
    ? "blocked_by_readiness"
    : mode === "night"
      ? payload.ok === true
        ? "settlement"
        : "failed_or_unknown"
      : !placementEnabled
        ? payload.ok === true
          ? "preview_only"
          : "failed_or_unknown"
        : reviewFailed
          ? "model_review_failed"
          : payload.ok !== true
            ? "failed_or_unknown"
            : allCandidatesVetoed
              ? "model_vetoed"
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
    ...(readinessBlocked ? { blockReason: "paper_readiness_not_met" } : {}),
    tradeDecisionReview,
  };
}

type CycleContext = {
  root: FinanceStateDir;
  options: SchedulerOptions;
  signal: AbortSignal;
  intradayController?: ReturnType<typeof createFinanceAlpacaCycleController>;
  lastIdleReconciliationAtMs?: number;
};

function numericExtra(args: readonly string[], flag: string): number {
  const index = args.indexOf(flag);
  return index < 0 ? Number.NaN : Number(args[index + 1]);
}

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
      intraday: context.options.intraday
        ? {
            enabled: true,
            placementEnabled: context.options.intraday.place,
            instruments: context.options.intraday.instruments,
            intervalSeconds: context.options.intraday.intervalSeconds,
            feed: context.options.intraday.feed,
          }
        : { enabled: false },
      researchPlanRefresh: context.options.researchPlan
        ? { enabled: true, contextPath: context.options.researchPlan.contextPath }
        : { enabled: false },
      nightReview: context.options.researchPlan
        ? { enabled: true, moduleExecution: true, newsReview: true }
        : { enabled: false },
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
  const portfolioPlanPath = path.join(directory, "research-portfolio-plan-latest.json");
  const research =
    mode === "day" && context.options.researchPlan
      ? await runFinanceCycleProcess({
          argv: [
            "--import",
            "tsx",
            RESEARCH_SCRIPT,
            "--live",
            "--workflow-models",
            "--execute-modules",
            "--write",
            "--json",
            "--decision-mode",
            "strategy_candidate",
            "--as-of",
            attempt.firedAt,
            "--ask",
            context.options.researchPlan.ask,
            "--portfolio-context",
            context.options.researchPlan.contextPath,
            "--portfolio-plan-out",
            portfolioPlanPath,
          ],
          cwd: REPO_ROOT,
          timeoutMs: context.options.timeoutMs,
          signal: context.signal,
        })
      : undefined;
  const researchAccepted =
    research === undefined ||
    (research.ok &&
      (() => {
        try {
          const payload = JSON.parse(research.stdout) as Record<string, unknown>;
          return (
            payload.status === "candidate" && payload.portfolioPlanWritten === portfolioPlanPath
          );
        } catch {
          return false;
        }
      })());
  const result = researchAccepted
    ? await runFinanceCycleProcess({
        argv: [
          "--import",
          "tsx",
          CYCLE_SCRIPT,
          "--json",
          "--mode",
          mode,
          "--dir",
          directory,
          ...(research ? ["--portfolio-plan", portfolioPlanPath] : []),
          ...context.options.extraArgs.filter(
            (arg) => mode === "day" || (arg !== "--place" && arg !== "--equity-from-venue"),
          ),
        ],
        cwd: REPO_ROOT,
        timeoutMs: context.options.timeoutMs,
        signal: context.signal,
      })
    : research;
  const cycleAccepted = result.ok && cycleOutputSucceeded(result.stdout);
  const settlement =
    mode === "night" && cycleAccepted ? parseNightSettlement(result.stdout) : undefined;
  const tuningLifecycle = settlement
    ? runNightTuning({ directory, firedAt: attempt.firedAt, settlement })
    : undefined;
  const nightReview =
    settlement && context.options.researchPlan
      ? await runNightResearchReview({
          context,
          attempt,
          settlement,
        })
      : undefined;
  const nightReviewAccepted =
    nightReview === undefined ||
    (nightReview.ok &&
      (() => {
        try {
          return (JSON.parse(nightReview.stdout) as Record<string, unknown>).status === "candidate";
        } catch {
          return false;
        }
      })());
  const accepted = cycleAccepted && (tuningLifecycle?.ok ?? true) && nightReviewAccepted;
  const record = {
    ...attempt,
    ...result,
    ok: accepted,
    status: result.ok && !accepted ? ("failed" as const) : result.status,
    durationMs: Date.now() - startedAt,
    execution: describeFinanceCycleExecution(result.stdout, context.options.extraArgs, mode),
    ...(research
      ? {
          researchPlanRefresh: {
            ok: researchAccepted,
            status: research.status,
            exitCode: research.exitCode,
            planPath: researchAccepted ? portfolioPlanPath : null,
          },
        }
      : {}),
    ...(nightReview
      ? {
          nightReview: {
            ok: nightReviewAccepted,
            status: nightReview.status,
            exitCode: nightReview.exitCode,
            evidencePath: path.join(directory, `night-review-evidence-${attempt.etDate}.json`),
            receiptPersisted: nightReviewAccepted,
          },
        }
      : {}),
    ...(tuningLifecycle ? { tuningLifecycle } : {}),
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
  const args = context.options.extraArgs;
  const venueIndex = args.indexOf("--venue");
  const idleReconciliationEnabled =
    args.includes("--sync-alpaca-history") && venueIndex >= 0 && args[venueIndex + 1] === "alpaca";
  const now = Date.now();
  if (
    idleReconciliationEnabled &&
    (context.lastIdleReconciliationAtMs === undefined ||
      now - context.lastIdleReconciliationAtMs >= FINANCE_IDLE_RECONCILIATION_INTERVAL_MS)
  ) {
    // Record the attempt time before awaiting so a failing broker cannot turn the
    // one-minute scheduler heartbeat into an unbounded retry loop. The next
    // bounded attempt happens after the same interval; placement still performs
    // its own fresh reconciliation immediately before any order.
    context.lastIdleReconciliationAtMs = now;
    try {
      const refreshed = await syncConfiguredAlpacaPaperHistory({
        directory: context.root.directory,
        signal: context.signal,
      });
      process.stdout.write(
        `[${new Date().toISOString()}] idle broker reconciliation=${refreshed.accountReconciliation.status} account=${refreshed.accountId}\n`,
      );
    } catch (error) {
      if (!context.signal.aborted) {
        process.stderr.write(
          `[${new Date().toISOString()}] idle broker reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  if (context.options.intraday) {
    for (const instrument of context.options.intraday.instruments) {
      try {
        const result = await runFinanceIntradayMonitorTick({
          directory: context.root.directory,
          ...(context.intradayController
            ? { accountId: context.intradayController.accountId }
            : {}),
          instrument,
          intervalSeconds: context.options.intraday.intervalSeconds,
          feed: context.options.intraday.feed,
          openingRangeBars: context.options.intraday.openingRangeBars,
          rewardRisk: context.options.intraday.rewardRisk,
          signal: context.signal,
        });
        if (
          result.status === "decision_recorded" ||
          result.status === "decision_pending_execution"
        ) {
          if (result.status === "decision_recorded") {
            process.stdout.write(
              `[${new Date().toISOString()}] intraday ${instrument} action=${result.signal.action} reason=${result.signal.reason} signal=${result.signal.signalId}\n`,
            );
          }
          if (context.options.intraday.place && context.intradayController) {
            const execution = await executeFinanceIntradayDecision({
              directory: context.root.directory,
              decision: result.decision,
              controller: context.intradayController,
              caps: {
                maxOrderNotional: numericExtra(context.options.extraArgs, "--max-order-notional"),
                maxInstrumentNotional: numericExtra(
                  context.options.extraArgs,
                  "--max-instrument-notional",
                ),
                maxOrdersPerRun: numericExtra(context.options.extraArgs, "--max-orders"),
              },
              signal: context.signal,
            });
            process.stdout.write(
              `[${new Date().toISOString()}] intraday ${instrument} execution=${execution.status}\n`,
            );
          }
        }
      } catch (error) {
        process.stderr.write(
          `[${new Date().toISOString()}] intraday ${instrument} tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
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
        ...(options.intraday
          ? [
              "--intraday-monitor",
              ...(options.intraday.place ? ["--intraday-place"] : []),
              "--intraday-instruments",
              options.intraday.instruments.join(","),
              "--intraday-interval-seconds",
              String(options.intraday.intervalSeconds),
              "--intraday-feed",
              options.intraday.feed,
              "--intraday-opening-range-bars",
              String(options.intraday.openingRangeBars),
              "--intraday-reward-risk",
              String(options.intraday.rewardRisk),
            ]
          : []),
        ...(options.researchPlan
          ? [
              "--research-portfolio-context",
              options.researchPlan.contextPath,
              "--research-ask",
              options.researchPlan.ask,
            ]
          : []),
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
    const intradayController = options.intraday?.place
      ? createFinanceAlpacaCycleController({
          directory: root.directory,
          instruments: options.intraday.instruments,
          feed: options.extraArgs[options.extraArgs.indexOf("--execution-quote-feed") + 1] as
            | "iex"
            | "sip",
          maxAgeMs: numericExtra(options.extraArgs, "--execution-max-age-ms"),
          policy: JSON.parse(
            fs.readFileSync(
              options.extraArgs[options.extraArgs.indexOf("--execution-policy") + 1],
              "utf8",
            ),
          ),
        })
      : undefined;
    const context = { root, options, signal: controller.signal, intradayController };
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
