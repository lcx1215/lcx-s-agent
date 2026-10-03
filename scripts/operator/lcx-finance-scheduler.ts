/**
 * Standalone weekday finance scheduler. Daily and actionable intraday Alpaca Paper candidates
 * receive bounded configured-provider veto review; model output never replaces execution gates.
 * Scheduling uses America/New_York wall clock.
 *
 * --once day|night | --loop | --detach | --status
 * --dir PATH pins the book for all child processes.
 * --cycle-timeout-ms N bounds each cycle (default 15 minutes).
 * --place, --venue paper|alpaca, --equity-from-venue and the --max-* caps are
 * forwarded unchanged. Scheduling does not grant additional execution authority.
 *
 * lastFired is an attempt marker, not success. A failed/interrupted attempt is
 * never automatically replayed after execution starts. A proven preflight-only failure
 * gets one delayed retry inside the day window; unknown outcomes require reconciliation.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createFinanceAlpacaCycleController,
  financeAlpacaCyclePolicySchema,
} from "../../src/agents/finance-alpaca-cycle-controller.js";
import { syncConfiguredAlpacaPaperHistory } from "../../src/agents/finance-alpaca-history-sync.js";
import { createFinanceAlpacaMarketSessionResolver } from "../../src/agents/finance-alpaca-market-calendar.js";
import {
  createAlpacaPaperOrderStream,
  type AlpacaPaperOrderStreamStatus,
} from "../../src/agents/finance-alpaca-order-stream.js";
import { caseflowFingerprint } from "../../src/agents/finance-caseflow.js";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import {
  DEFAULT_FINANCE_CYCLE_SLOTS,
  FINANCE_MARKET_TZ,
  FINANCE_TRADING_WEEKDAYS,
  financeEtClock,
  isFinanceCycleSlotDue,
} from "../../src/agents/finance-cycle-schedule.js";
import { FINANCE_RISK_BUDGET_ANY_INSTRUMENT } from "../../src/agents/finance-execution-adapter.js";
import { runFinanceHistoricalPositionMaintenance } from "../../src/agents/finance-historical-position-maintenance.js";
import { executeFinanceIntradayDecision } from "../../src/agents/finance-intraday-execution.js";
import { runFinanceIntradayMonitorTick } from "../../src/agents/finance-intraday-monitor.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  financeIntradayExecutionUniverse,
  resolveFinanceIntradayActiveRuleContract,
  type FinanceIntradayActiveRuleContract,
  type FinanceIntradayMonitorScope,
} from "../../src/agents/finance-intraday-paper.js";
import {
  readFinanceDynamicIntradayExitTargets,
  readFinanceRetiredIntradayExitTargets,
} from "../../src/agents/finance-intraday-position.js";
import {
  buildFinanceBrokerAccountResearchEvidence,
  buildFinanceNightReviewEvidence,
  writeFinanceNightReviewEvidence,
  type FinanceNightSettlementSummary,
} from "../../src/agents/finance-night-review-context.js";
import {
  financeResearchPortfolioAbstentionSchema,
  financeResearchPortfolioContextSchema,
} from "../../src/agents/finance-research-portfolio-plan.js";
import {
  readFinanceResearchEquityUniverseSnapshot,
  type FinanceResearchEquityUniverseSnapshot,
} from "../../src/agents/finance-research-runner.js";
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
import { createFinanceSchedulerReconciliationWake } from "../../src/agents/finance-scheduler-reconciliation-wake.js";
import {
  FINANCE_SCHEDULER_TICK_MS,
  FINANCE_SCHEDULER_INTRADAY_MONITOR_STATUSES,
  normalizeFinanceSchedulerIntradayLastTick,
  type FinanceSchedulerCycleStage,
  type FinanceSchedulerIntradayLastTick,
  inspectFinanceSchedulerProgress,
  readFinanceSchedulerPolicyAuthorization,
  readFinanceSchedulerState,
  writeFinanceSchedulerState,
  type SchedulerState,
  initializeFinanceSchedulerDatabase,
} from "../../src/agents/finance-scheduler-state.js";
import { runFinanceSourceHeartbeat } from "../../src/agents/finance-source-heartbeat.js";
import {
  FINANCE_DAILY_CYCLE_RUNS_FILENAME,
  resolveFinanceStateDir,
  type FinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "../../src/agents/finance-strategy-rule-ledger.js";
import { createFinanceTradeDecisionReviewer } from "../../src/agents/finance-trade-decision-review.js";
import { runFinanceTuningLifecycle } from "../../src/agents/finance-tuning-lifecycle.js";
import { FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME } from "../../src/agents/finance-universe-selection.js";
import { buildDetachedServeEnv } from "../../src/cli/serve-detach.js";
import { loadConfig } from "../../src/config/config.js";
import { applyConfigEnvVars } from "../../src/config/env-vars.js";
import { killProcessTree } from "../../src/process/kill-tree.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CYCLE_SCRIPT = path.join(REPO_ROOT, "scripts", "operator", "lcx-finance-daily-cycle.ts");
const RESEARCH_SCRIPT = path.join(REPO_ROOT, "scripts", "operator", "lcx-finance-research-run.ts");
const UNIVERSE_SELECTION_SCRIPT = path.join(
  REPO_ROOT,
  "scripts",
  "operator",
  "lcx-finance-universe-select.ts",
);
const RUNS_LOG = FINANCE_DAILY_CYCLE_RUNS_FILENAME;
const UNIVERSE_SELECTION_RUNS_LOG = "finance-universe-selection-runs.jsonl";
/** Keep the five-minute reconciliation evidence fresh without coupling it to a trade slot. */
export const FINANCE_IDLE_RECONCILIATION_INTERVAL_MS = 4 * 60_000;
type Mode = "day" | "night";

type ResearchPlanConfig = Readonly<{
  contextPath: string;
  ask: string;
}>;

type IntradayMonitorConfig = Readonly<{
  place: boolean;
  placementRequested: boolean;
  placementEligibility:
    | "not_requested"
    | "eligibility_missing"
    | "paper_contract_only"
    | "paper_execution_eligible"
    | "eligibility_invalid"
    | "explicit_diagnostic_only"
    | "instrument_scope_mismatch"
    | "universe_unavailable"
    | "active_rule_unavailable"
    | "controller_unavailable";
  instrumentSource: "explicit" | "active_rule" | "system_universe";
  instruments: readonly string[];
  executionInstruments: readonly string[];
  intervalSeconds: 60 | 300 | 900;
  feed: "iex" | "sip";
  openingRangeBars: number;
  rewardRisk: number;
  strategyContract?: FinanceIntradayActiveRuleContract;
  scope?: FinanceIntradayMonitorScope;
}>;

type SchedulerOptions = {
  command: "once" | "loop" | "detach" | "status";
  mode?: Mode;
  directory?: string;
  timeoutMs: number;
  extraArgs: string[];
  sourceHeartbeatEnabled: boolean;
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
  let sourceHeartbeatEnabled = true;
  const seen = new Set<string>();
  let intradayEnabled = false;
  let legacyIntradayPlace = false;
  let intradayInstruments: string[] = [];
  let intradayInstrumentsProvided = false;
  let intradayActiveRule = false;
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
    } else if (arg === "--no-source-heartbeat") {
      sourceHeartbeatEnabled = false;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--intraday-monitor") {
      intradayEnabled = true;
    } else if (arg === "--intraday-place") {
      // Keep old supervisor invocations parseable, but do not make this a second
      // order-placement switch. The shared --place flag is the only authority.
      legacyIntradayPlace = true;
    } else if (arg === "--intraday-active-rule") {
      intradayActiveRule = true;
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
        intradayInstrumentsProvided = true;
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
  if (intradayActiveRule && intradayInstrumentsProvided) {
    throw new Error("choose either --intraday-active-rule or --intraday-instruments, not both");
  }
  if (intradayActiveRule && !intradayEnabled) {
    throw new Error("--intraday-active-rule requires --intraday-monitor");
  }
  if (intradayInstrumentsProvided && !intradayEnabled) {
    throw new Error("--intraday-instruments requires --intraday-monitor");
  }
  if (intradayInstrumentsProvided && intradayInstruments.length === 0) {
    throw new Error("--intraday-instruments must contain at least one symbol");
  }
  if (Boolean(researchContextPath) !== Boolean(researchAsk)) {
    throw new Error(
      "research plan refresh requires both --research-portfolio-context and --research-ask",
    );
  }
  if (researchContextPath && extraArgs.includes("--portfolio-plan")) {
    throw new Error("automatic research plan refresh cannot combine a static --portfolio-plan");
  }
  if (legacyIntradayPlace && !intradayEnabled) {
    throw new Error("--intraday-place requires --intraday-monitor");
  }
  const placementEnabled = extraArgs.includes("--place");
  if (intradayEnabled && legacyIntradayPlace && !placementEnabled) {
    throw new Error("--intraday-place requires the shared --place authorization");
  }
  if (intradayEnabled && placementEnabled) {
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
    sourceHeartbeatEnabled,
    json,
    ...(intradayEnabled
      ? {
          intraday: {
            place: placementEnabled,
            placementRequested: placementEnabled,
            placementEligibility: placementEnabled ? "eligibility_missing" : "not_requested",
            instrumentSource: intradayActiveRule
              ? "active_rule"
              : intradayInstrumentsProvided
                ? "explicit"
                : "system_universe",
            instruments: Object.freeze(intradayInstruments),
            executionInstruments: Object.freeze([]),
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
/** Storage success and research acceptance are separate observations. */
export function inspectFinanceResearchReceiptPersistence(stdout: string): boolean {
  try {
    const summary = JSON.parse(stdout) as {
      status?: string;
      plan?: { asOf?: string };
      written?: { datedPath?: string };
    };
    const receiptPath = summary.written?.datedPath;
    if (!receiptPath || !summary.plan?.asOf) {
      return false;
    }
    const stat = fs.statSync(receiptPath);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) {
      return false;
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
      schemaVersion?: string;
      status?: string;
      plan?: { asOf?: string };
    };
    return (
      receipt.schemaVersion === "lcx_finance_research_run_v1" &&
      receipt.status === summary.status &&
      receipt.plan?.asOf === summary.plan.asOf
    );
  } catch {
    return false;
  }
}

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

/** Research egress is child-local; trading retains its independently configured route. */
export function financeResearchProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  const declared = env.LCX_FINANCE_RESEARCH_HTTP_PROXY;
  if (declared === undefined) {
    return undefined;
  }
  const proxy = declared.trim();
  if (proxy) {
    const parsed = new URL(proxy);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("research proxy must be an HTTP(S) URL without credentials");
    }
  }
  return { ...env, LCX_FINANCE_HTTP_PROXY: proxy };
}

async function runNightResearchReview(params: {
  context: CycleContext;
  attempt: { firedAt: string; etDate: string };
  settlement: FinanceNightSettlementSummary;
}): Promise<FinanceCycleProcessResult> {
  try {
    const reviewAsOf = new Date().toISOString();
    const evidencePath = path.join(
      params.context.root.directory,
      `night-review-evidence-${params.attempt.etDate}.json`,
    );
    const evidence = await buildFinanceNightReviewEvidence({
      directory: params.context.root.directory,
      asOf: reviewAsOf,
      etDate: params.attempt.etDate,
      settlement: params.settlement,
      includeResearchScope: true,
    });
    await writeFinanceNightReviewEvidence(evidencePath, evidence);
    return runScheduledCycleProcess(params.context, "night_review", {
      argv: [
        "--import",
        "tsx",
        RESEARCH_SCRIPT,
        "--live",
        "--workflow-models",
        "--max-api-calls",
        "160",
        "--execute-modules",
        "--write",
        "--scheduler-summary",
        "--decision-mode",
        "research_only",
        "--as-of",
        reviewAsOf,
        "--ask",
        `Night review of net profit, missed opportunities, premature exits, winner retention, portfolio risk and fresh news. Follow the profitReview questions and evidence boundaries in controller evidence. Propose validated experiments, never silently change execution authority or risk limits. Reassess the active evidence and invalidations for: ${params.context.options.researchPlan!.ask}`,
        "--controller-research-scope",
        "--controller-evidence",
        evidencePath,
        "--persist-theses",
        "--finance-state-dir",
        params.context.root.directory,
      ],
      cwd: REPO_ROOT,
      env: financeResearchProcessEnv(),
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

type DayResearchPreflightResult = FinanceCycleProcessResult & {
  controllerEvidenceStatus?: "invalid_scope" | "invalid_config" | "read_failed";
};

function failedDayResearchPreflight(
  controllerEvidenceStatus: "invalid_scope" | "invalid_config" | "read_failed",
  error: unknown,
): DayResearchPreflightResult {
  return {
    exitCode: null,
    signal: null,
    status: "failed",
    ok: false,
    stdout: "",
    stderr: `day controller evidence ${controllerEvidenceStatus}: ${error instanceof Error ? error.message : String(error)}`,
    outputTruncated: false,
    controllerEvidenceStatus,
  };
}

async function runDayResearchPreflight(params: {
  context: CycleContext;
  attempt: { firedAt: string; etDate: string; runId: string };
  portfolioPlanPath: string;
}): Promise<DayResearchPreflightResult> {
  let contextContents: string;
  try {
    contextContents = fs.readFileSync(params.context.options.researchPlan!.contextPath, "utf8");
  } catch (error) {
    return failedDayResearchPreflight("read_failed", error);
  }
  let portfolioContext: ReturnType<typeof financeResearchPortfolioContextSchema.parse>;
  try {
    portfolioContext = financeResearchPortfolioContextSchema.parse(JSON.parse(contextContents));
  } catch (error) {
    return failedDayResearchPreflight("invalid_scope", error);
  }
  const evidencePath = path.join(
    params.context.root.directory,
    `day-research-controller-evidence-${params.attempt.etDate}-${params.attempt.runId}.json`,
  );
  const frozenContextPath = path.join(
    params.context.root.directory,
    `day-research-portfolio-context-${params.attempt.etDate}-${params.attempt.runId}.json`,
  );
  try {
    const accountEvidence = await buildFinanceBrokerAccountResearchEvidence({
      directory: params.context.root.directory,
      asOf: params.attempt.firedAt,
      accountId: portfolioContext.accountId,
      venue: portfolioContext.venue === "alpaca" ? "alpaca:paper" : "paper",
    });
    await writeFinanceNightReviewEvidence(evidencePath, [accountEvidence]);
    // Bind the child to the same parsed account scope used for its evidence.
    // The operator's source file may change while evidence is being assembled.
    fs.writeFileSync(frozenContextPath, `${JSON.stringify(portfolioContext)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    return failedDayResearchPreflight("read_failed", error);
  }
  let researchEnv: NodeJS.ProcessEnv | undefined;
  try {
    researchEnv = financeResearchProcessEnv();
  } catch (error) {
    return failedDayResearchPreflight("invalid_config", error);
  }
  try {
    return await runScheduledCycleProcess(params.context, "research_preflight", {
      argv: [
        "--import",
        "tsx",
        RESEARCH_SCRIPT,
        "--live",
        "--workflow-models",
        "--max-api-calls",
        "160",
        "--execute-modules",
        "--write",
        "--scheduler-summary",
        "--decision-mode",
        "strategy_candidate",
        "--as-of",
        params.attempt.firedAt,
        "--ask",
        params.context.options.researchPlan!.ask,
        "--controller-evidence",
        evidencePath,
        "--portfolio-context",
        frozenContextPath,
        "--portfolio-plan-out",
        params.portfolioPlanPath,
        "--persist-theses",
        "--finance-state-dir",
        params.context.root.directory,
      ],
      cwd: REPO_ROOT,
      env: researchEnv,
      timeoutMs: params.context.options.timeoutMs,
      signal: params.context.signal,
    });
  } catch (error) {
    if (error instanceof SchedulerProgressBeforeDispatchError) {
      return failedDayResearchPreflight("read_failed", error);
    }
    throw error;
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
        : reportedPlacements !== null && reportedPlacements > 0
          ? refusals.length > 0
            ? "blocked_or_partial"
            : "placement_reported"
          : allCandidatesVetoed
            ? "model_vetoed"
            : refusals.length > 0
              ? "blocked_or_partial"
              : reviewFailed
                ? "model_review_failed"
                : payload.ok !== true
                  ? "failed_or_unknown"
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
  resolveMarketSession?: ReturnType<typeof createFinanceAlpacaMarketSessionResolver>;
  lastIdleReconciliationAtMs?: number;
  lastHistoricalMaintenanceAtMs?: number;
  historicalMaintenance?: {
    observedAt: string;
    status: string;
    decisionCount: number;
    unknownCount: number;
  };
  reconciliationWake?: ReturnType<typeof createFinanceSchedulerReconciliationWake>;
  sourceHeartbeatInFlight?: boolean;
  lastIntradayTick?: FinanceSchedulerIntradayLastTick | null;
  progressPhase?: "idle" | "cycle";
};

type UniverseSelectionReceipt = Readonly<{
  schemaVersion: "lcx_finance_universe_selection_attempt_v1";
  runId: string;
  attemptedAt: string;
  completedAt: string;
  status: "started" | "selected" | "failed";
  processStatus: string;
  exitCode: number | null;
  snapshotRef?: string;
  generatedAt?: string;
  selectedCount?: number;
  error?: string;
}>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertUniverseSnapshotNotSupersededByFailure(
  directory: string,
  snapshot: FinanceResearchEquityUniverseSnapshot,
): void {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(directory, UNIVERSE_SELECTION_RUNS_LOG), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // The selector may have been run independently for a first-run bootstrap. The shared
      // snapshot reader has already validated source evidence and freshness in this case.
      return;
    }
    throw error;
  }

  const lastLine = contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) {
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(lastLine);
  } catch {
    throw new Error("latest universe selection attempt receipt is unreadable");
  }
  if (
    !isObjectRecord(value) ||
    value.schemaVersion !== "lcx_finance_universe_selection_attempt_v1" ||
    typeof value.runId !== "string" ||
    typeof value.completedAt !== "string" ||
    (value.status !== "started" && value.status !== "selected" && value.status !== "failed")
  ) {
    throw new Error("latest universe selection attempt receipt is invalid");
  }

  const completedAtMs = Date.parse(value.completedAt);
  const snapshotGeneratedAtMs = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(snapshotGeneratedAtMs)) {
    throw new Error("latest universe selection attempt or snapshot timestamp is invalid");
  }
  if (value.status === "started") {
    throw new Error("latest universe selector attempt did not complete with a selected receipt");
  }
  if (value.status === "failed") {
    if (completedAtMs >= snapshotGeneratedAtMs) {
      throw new Error("latest universe selector attempt failed at or after the persisted snapshot");
    }
    // A separately produced, validated snapshot newer than the failed scheduler attempt may
    // bootstrap/recover monitoring; the failed attempt still takes precedence over its old data.
    return;
  }
  if (
    typeof value.snapshotRef !== "string" ||
    value.snapshotRef !== caseflowFingerprint(snapshot) ||
    value.generatedAt !== snapshot.generatedAt ||
    value.selectedCount !== snapshot.selected.length
  ) {
    throw new Error("latest universe selection receipt does not bind the current snapshot");
  }
}

function preserveUniverseSnapshot(
  directory: string,
  runId: string,
  suffix: "previous" | "unaccepted" | "unreceipted",
): string | undefined {
  const snapshotPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);
  try {
    fs.lstatSync(snapshotPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const backupPath = path.join(directory, `finance-universe-selection-${runId}-${suffix}.json`);
  try {
    fs.lstatSync(backupPath);
    throw new Error(`universe snapshot backup already exists: ${path.basename(backupPath)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.renameSync(snapshotPath, backupPath);
  return backupPath;
}

function replaceIntradaySystemUniverse(
  context: CycleContext,
  snapshot?: FinanceResearchEquityUniverseSnapshot,
): void {
  const current = context.options.intraday;
  if (!current || current.instrumentSource !== "system_universe") {
    return;
  }

  if (!snapshot || !current.strategyContract) {
    const nextIntraday = {
      ...current,
      // Retain the last observed symbols for non-execution monitoring, but remove
      // the snapshot binding and all entry placement authority until a fresh read.
      executionInstruments: [],
      place: false,
      placementEligibility: current.placementRequested
        ? current.strategyContract?.eligibility.status === "paper_contract_only"
          ? "paper_contract_only"
          : "universe_unavailable"
        : "not_requested",
    } satisfies IntradayMonitorConfig;
    delete nextIntraday.scope;
    context.options = { ...context.options, intraday: nextIntraday };
    context.intradayController = undefined;
    return;
  }

  const dynamicUniverse =
    current.strategyContract.paperUniverseScope === "fresh_us_equity_selection_v1";
  const executionCandidates = financeIntradayExecutionUniverse(
    current.strategyContract,
    snapshot.selected,
  );
  const executionBindingUnchanged =
    JSON.stringify([...executionCandidates].toSorted()) ===
    JSON.stringify([...current.executionInstruments].toSorted());
  const keepPlacement =
    current.placementRequested &&
    (dynamicUniverse || executionBindingUnchanged) &&
    current.strategyContract.eligibility.automatedPaperPlacementAllowed &&
    executionCandidates.length > 0;
  const placementEligibility: IntradayMonitorConfig["placementEligibility"] =
    !current.placementRequested
      ? "not_requested"
      : !current.strategyContract.eligibility.automatedPaperPlacementAllowed
        ? current.strategyContract.eligibility.status
        : executionCandidates.length === 0
          ? "instrument_scope_mismatch"
          : !dynamicUniverse && !executionBindingUnchanged
            ? "universe_unavailable"
            : current.strategyContract.eligibility.status;

  context.options = {
    ...context.options,
    intraday: {
      ...current,
      instruments: snapshot.selected,
      executionInstruments: keepPlacement ? executionCandidates : [],
      place: keepPlacement,
      placementEligibility,
      scope: {
        kind: "system_universe",
        universeSnapshotRef: caseflowFingerprint(snapshot),
        selectedInstruments: snapshot.selected,
      },
    },
  };
  context.intradayController = undefined;
  try {
    context.intradayController = createIntradayControllerForOptions(
      context.root.directory,
      context.options,
    );
  } catch (error) {
    context.options = {
      ...context.options,
      intraday: {
        ...context.options.intraday!,
        place: false,
        executionInstruments: [],
        placementEligibility: "controller_unavailable",
      },
    };
    process.stderr.write(
      `intraday system-universe controller refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function refreshFinanceUniverseSelection(params: {
  context: CycleContext;
  attempt: { runId: string; firedAt: string };
}): Promise<UniverseSelectionReceipt> {
  const startedAt = new Date().toISOString();
  let completedAt = startedAt;
  let processResult: FinanceCycleProcessResult = {
    exitCode: null,
    signal: null,
    status: "spawn_error",
    ok: false,
    stdout: "",
    stderr: "",
    outputTruncated: false,
  };
  let snapshotForRuntime: FinanceResearchEquityUniverseSnapshot | undefined;
  let snapshotRef: string | undefined;
  let generatedAt: string | undefined;
  let selectedCount: number | undefined;
  let error: string | undefined;
  let status: UniverseSelectionReceipt["status"] = "failed";
  let startedReceiptPersisted = false;
  try {
    const startedReceipt: UniverseSelectionReceipt = Object.freeze({
      schemaVersion: "lcx_finance_universe_selection_attempt_v1",
      runId: params.attempt.runId,
      attemptedAt: startedAt,
      completedAt: startedAt,
      status: "started",
      processStatus: "running",
      exitCode: null,
    });
    fs.appendFileSync(
      path.join(params.context.root.directory, UNIVERSE_SELECTION_RUNS_LOG),
      `${JSON.stringify(startedReceipt)}\n`,
    );
    startedReceiptPersisted = true;
    preserveUniverseSnapshot(params.context.root.directory, params.attempt.runId, "previous");
    processResult = await runScheduledCycleProcess(params.context, "universe_selection", {
      argv: [
        "--import",
        "tsx",
        UNIVERSE_SELECTION_SCRIPT,
        "--json",
        "--write-snapshot",
        "--dir",
        params.context.root.directory,
      ],
      cwd: REPO_ROOT,
      timeoutMs: Math.min(params.context.options.timeoutMs, 15 * 60_000),
      signal: params.context.signal,
    });
    completedAt = new Date().toISOString();
    const payload = JSON.parse(processResult.stdout) as Record<string, unknown>;
    if (!processResult.ok || payload.snapshotPersisted !== true) {
      throw new Error("selector did not confirm atomic snapshot persistence");
    }
    const snapshot = readFinanceResearchEquityUniverseSnapshot(
      params.context.root.directory,
      completedAt,
    );
    const generatedAtMs = Date.parse(snapshot.generatedAt);
    if (
      !Number.isFinite(generatedAtMs) ||
      payload.generatedAt !== snapshot.generatedAt ||
      JSON.stringify(payload.selected) !== JSON.stringify(snapshot.selected) ||
      generatedAtMs < Date.parse(startedAt) ||
      generatedAtMs > Date.parse(completedAt) + 1_000
    ) {
      throw new Error("persisted universe snapshot is not from this selector attempt");
    }
    snapshotRef = caseflowFingerprint(snapshot);
    generatedAt = snapshot.generatedAt;
    selectedCount = snapshot.selected.length;
    snapshotForRuntime = snapshot;
    status = "selected";
  } catch (failure) {
    completedAt = new Date().toISOString();
    error = failure instanceof Error ? failure.message : String(failure);
  }
  if (status === "selected" && snapshotForRuntime) {
    const selectedReceipt: UniverseSelectionReceipt = Object.freeze({
      schemaVersion: "lcx_finance_universe_selection_attempt_v1",
      runId: params.attempt.runId,
      attemptedAt: startedAt,
      completedAt,
      status,
      processStatus: processResult.status,
      exitCode: processResult.exitCode,
      ...(snapshotRef ? { snapshotRef } : {}),
      ...(generatedAt ? { generatedAt } : {}),
      ...(selectedCount === undefined ? {} : { selectedCount }),
    });
    try {
      fs.appendFileSync(
        path.join(params.context.root.directory, UNIVERSE_SELECTION_RUNS_LOG),
        `${JSON.stringify(selectedReceipt)}\n`,
      );
      replaceIntradaySystemUniverse(params.context, snapshotForRuntime);
      return selectedReceipt;
    } catch (writeError) {
      status = "failed";
      error = `universe selection receipt append failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`;
      snapshotForRuntime = undefined;
      completedAt = new Date().toISOString();
      process.stderr.write(`${error}\n`);
      try {
        preserveUniverseSnapshot(
          params.context.root.directory,
          params.attempt.runId,
          "unreceipted",
        );
      } catch (preserveError) {
        process.stderr.write(
          `unreceipted universe snapshot could not be quarantined: ${preserveError instanceof Error ? preserveError.message : String(preserveError)}\n`,
        );
      }
    }
  } else if (startedReceiptPersisted) {
    try {
      preserveUniverseSnapshot(params.context.root.directory, params.attempt.runId, "unaccepted");
    } catch (preserveError) {
      error = `${error ?? "selector did not produce an accepted snapshot"}; unaccepted snapshot could not be quarantined: ${preserveError instanceof Error ? preserveError.message : String(preserveError)}`;
      process.stderr.write(`${error}\n`);
    }
  }

  replaceIntradaySystemUniverse(params.context);
  const receipt: UniverseSelectionReceipt = Object.freeze({
    schemaVersion: "lcx_finance_universe_selection_attempt_v1",
    runId: params.attempt.runId,
    attemptedAt: startedAt,
    completedAt,
    status: "failed",
    processStatus: processResult.status,
    exitCode: processResult.exitCode,
    ...(snapshotRef ? { snapshotRef } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    ...(selectedCount === undefined ? {} : { selectedCount }),
    ...(error ? { error } : {}),
  });
  try {
    fs.appendFileSync(
      path.join(params.context.root.directory, UNIVERSE_SELECTION_RUNS_LOG),
      `${JSON.stringify(receipt)}\n`,
    );
  } catch (writeError) {
    process.stderr.write(
      `universe selection receipt append failed: ${writeError instanceof Error ? writeError.message : String(writeError)}\n`,
    );
  }
  return receipt;
}

/**
 * Resolve the supported ORB runtime universe from its explicit active rule event. The strategy
 * ledger's top-level `instruments` field is authoritative; nested replay metadata is only checked
 * for disagreement and never used to supply the execution universe.
 */
export async function resolveActiveIntradayRule(
  directory: string,
  config: Pick<
    IntradayMonitorConfig,
    "openingRangeBars" | "rewardRisk" | "intervalSeconds" | "feed"
  >,
): Promise<FinanceIntradayActiveRuleContract> {
  const { ledger } = await readFinanceStrategyRuleLedger(directory);
  const activeIntradayRules = ledger.rules.filter(
    (rule) => rule.state === "active" && rule.form === FINANCE_INTRADAY_OPENING_RANGE_FORM,
  );
  if (activeIntradayRules.length !== 1) {
    throw new Error(
      `active intraday rule resolution requires exactly one ${FINANCE_INTRADAY_OPENING_RANGE_FORM} rule; found ${activeIntradayRules.length}`,
    );
  }
  const contract = resolveFinanceIntradayActiveRuleContract(activeIntradayRules[0]);
  if (
    contract.openingRangeBars !== config.openingRangeBars ||
    contract.rewardRisk !== config.rewardRisk ||
    contract.intervalSeconds !== config.intervalSeconds ||
    contract.feed !== config.feed
  ) {
    throw new Error(
      `active intraday strategy ${contract.ruleId} has parameters incompatible with scheduler settings`,
    );
  }
  return contract;
}

function numericExtra(args: readonly string[], flag: string): number {
  const index = args.indexOf(flag);
  return index < 0 ? Number.NaN : Number(args[index + 1]);
}

function createIntradayTradeDecisionReviewer() {
  try {
    // Each reviewer owns a single-call model adapter, so scope it to one decision.
    return createFinanceTradeDecisionReviewer(loadConfig());
  } catch {
    return undefined;
  }
}

function writeSchedulerProgress(
  context: CycleContext,
  phase: "idle" | "cycle",
  cycleStage?: FinanceSchedulerCycleStage,
) {
  const filename = path.join(context.root.directory, FINANCE_SCHEDULER_LOCK, "progress.json");
  const temporary = `${filename}.tmp`;
  const args = context.options.extraArgs;
  const venueIndex = args.indexOf("--venue");
  const venue = venueIndex < 0 ? "paper" : args[venueIndex + 1];
  const policyIndex = args.indexOf("--execution-policy");
  const executionPolicyAuthorization =
    venue === "alpaca"
      ? readFinanceSchedulerPolicyAuthorization(policyIndex < 0 ? undefined : args[policyIndex + 1])
      : { authorizationMode: "unknown" as const, expiresAt: null };
  const intradayLastTick = context.options.intraday
    ? normalizeFinanceSchedulerIntradayLastTick(context.lastIntradayTick, {
        instruments: context.options.intraday.instruments,
        nowMs: Date.now(),
        intervalSeconds: context.options.intraday.intervalSeconds,
      })
    : null;
  fs.writeFileSync(
    temporary,
    JSON.stringify({
      pid: process.pid,
      observedAt: new Date().toISOString(),
      phase,
      ...(cycleStage ? { cycleStage } : {}),
      timeoutMs: context.options.timeoutMs,
      historicalMaintenance: context.historicalMaintenance ?? null,
      placementEnabled: args.includes("--place"),
      venue,
      executionPolicyAuthorizationMode:
        executionPolicyAuthorization.authorizationMode === "unknown"
          ? null
          : executionPolicyAuthorization.authorizationMode,
      executionPolicyExpiresAt: executionPolicyAuthorization.expiresAt,
      intradayControllerPolicyAuthorizationMode:
        context.intradayController?.executionPolicyAuthorizationMode ?? null,
      intradayControllerPolicyExpiresAt:
        context.intradayController?.executionPolicyExpiresAt ?? null,
      intraday: context.options.intraday
        ? {
            enabled: true,
            placementEnabled: context.options.intraday.place,
            placementRequested: context.options.intraday.placementRequested,
            placementEligibility: context.options.intraday.placementEligibility,
            instrumentSource: context.options.intraday.instrumentSource,
            instruments: context.options.intraday.instruments,
            universeStatus:
              context.options.intraday.instrumentSource !== "system_universe"
                ? "not_applicable"
                : context.options.intraday.scope?.universeSnapshotRef
                  ? "validated"
                  : "unavailable",
            universeSnapshotRef: context.options.intraday.scope?.universeSnapshotRef ?? null,
            executionInstruments: context.options.intraday.executionInstruments,
            lastTick: intradayLastTick,
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
  context.progressPhase = phase;
}

/** Each bounded child owns a fresh progress deadline; elapsed prior stages do not count as a stall. */
class SchedulerProgressBeforeDispatchError extends Error {
  constructor(error: unknown) {
    super(
      `scheduler progress before dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runScheduledCycleProcess(
  context: CycleContext,
  stage: FinanceSchedulerCycleStage,
  options: Parameters<typeof runFinanceCycleProcess>[0],
): Promise<FinanceCycleProcessResult> {
  try {
    writeSchedulerProgress(context, "cycle", stage);
  } catch (error) {
    throw new SchedulerProgressBeforeDispatchError(error);
  }
  if (context.options.command !== "loop" || !context.options.intraday || stage === "execution") {
    const work = () => runFinanceCycleProcess(options);
    return stage === "execution" && context.reconciliationWake
      ? context.reconciliationWake.run(work)
      : work();
  }
  // Research has no placement authority. Keep the existing resident trading tick
  // alive while it waits, with at most one trading tick in flight. Before handing
  // off to any next stage (especially daily execution), join that tick completely.
  let tradingTick: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (tradingTick || context.signal.aborted) {
      return;
    }
    tradingTick = runTradingTick(context)
      .catch((error: unknown) => {
        process.stderr.write(
          `intraday tick during ${stage} failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => {
        tradingTick = undefined;
      });
  }, FINANCE_SCHEDULER_TICK_MS);
  try {
    return await runFinanceCycleProcess(options);
  } finally {
    clearInterval(timer);
    await tradingTick;
  }
}

/**
 * Keep provider liveness evidence fresh without making the heartbeat a scheduler single point of
 * failure. The heartbeat owns its durable due time and diagnostic quota lane; this loop only wakes
 * it up, so a 60-second scheduler tick does not mean a 60-second API fanout.
 */
async function heartbeat(context: CycleContext): Promise<void> {
  if (context.signal.aborted) {
    return;
  }
  try {
    const result = await runFinanceSourceHeartbeat({
      directory: context.root.directory,
      signal: context.signal,
      timeoutMs: Math.min(context.options.timeoutMs, 20_000),
      maxSourceConcurrency: 4,
    });
    if (result.checkedProviders.length > 0) {
      process.stdout.write(
        `source-heartbeat checked=${result.checkedProviders.length} ` +
          `healthy=${result.healthyCount} degraded=${result.degradedCount} ` +
          `unhealthy=${result.unhealthyCount}\n`,
      );
    }
  } catch (error) {
    // Source health is diagnostic evidence, not permission to stop scheduled research or trading.
    process.stderr.write(
      `source-heartbeat unavailable: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
  }
}

/** Retry only a terminal, controller-recorded preflight failure with no execution dispatch. */
export function financeResearchPreflightRetryDue(state: SchedulerState, at: Date): boolean {
  const clock = financeEtClock(at);
  const run = state.lastRun;
  if (
    !FINANCE_TRADING_WEEKDAYS.includes(clock.weekday) ||
    clock.minutes < 15 * 60 + 30 ||
    clock.minutes >= 16 * 60 ||
    state.lastFired.day !== clock.date ||
    state.lastSucceeded.day === clock.date ||
    state.lastStatus.day !== "failed" ||
    !run ||
    run.mode !== "day" ||
    run.etDate !== clock.date ||
    run.status !== "failed" ||
    run.researchAttempt !== 1 ||
    run.ok !== false ||
    !isObjectRecord(run.execution) ||
    run.execution.outcome !== "not_run" ||
    !["research_plan_not_accepted", "controller_evidence_read_failed"].includes(
      String(run.execution.blockReason),
    ) ||
    !isObjectRecord(run.researchPlanRefresh) ||
    run.researchPlanRefresh.ok !== false ||
    typeof run.completedAt !== "string"
  ) {
    return false;
  }
  const completedAt = Date.parse(run.completedAt);
  return Number.isFinite(completedAt) && at.getTime() - completedAt >= 10 * 60_000;
}

async function fire(context: CycleContext, mode: Mode): Promise<boolean> {
  if (context.signal.aborted) {
    return false;
  }
  const directory = context.root.directory;
  const startedAt = Date.now();
  const state = readFinanceSchedulerState(directory);
  const retryDue =
    mode === "day" &&
    Boolean(context.options.researchPlan) &&
    financeResearchPreflightRetryDue(state, new Date(startedAt));
  const attempt = {
    ...(mode === "day" && context.options.researchPlan
      ? { researchAttempt: retryDue ? 2 : 1 }
      : {}),
    runId: randomUUID(),
    firedAt: new Date(startedAt).toISOString(),
    etDate: financeEtClock(new Date(startedAt)).date,
    mode,
    directory,
    rootSource: context.root.source,
    timeoutMs: context.options.timeoutMs,
  };
  const legacyClaim = path.join(directory, `daily-cycle-${attempt.etDate}-${mode}.json`);
  if (
    fs.existsSync(legacyClaim) ||
    (state.lastFired[mode] === attempt.etDate && !retryDue) ||
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
  let dayPreflightProgressFailure: { error: unknown } | undefined;
  try {
    writeSchedulerProgress(context, "cycle");
  } catch (error) {
    if (mode !== "day" || !context.options.researchPlan) {
      throw error;
    }
    dayPreflightProgressFailure = { error };
  }
  const portfolioPlanPath = path.join(directory, "research-portfolio-plan-latest.json");
  const research =
    mode === "day" && context.options.researchPlan
      ? dayPreflightProgressFailure
        ? failedDayResearchPreflight("read_failed", dayPreflightProgressFailure.error)
        : await runDayResearchPreflight({
            context,
            attempt,
            portfolioPlanPath,
          })
      : undefined;
  const researchPayload = (() => {
    if (!research?.ok) {
      return undefined;
    }
    try {
      const payload = JSON.parse(research.stdout) as {
        status?: unknown;
        portfolioPlanWritten?: unknown;
        portfolioPlan?: unknown;
        portfolioAbstention?: unknown;
        plan?: { asOf?: unknown };
        gates?: { id?: unknown; passed?: unknown }[];
      };
      if (
        payload.status !== "candidate" ||
        payload.plan?.asOf !== attempt.firedAt ||
        !Array.isArray(payload.gates) ||
        !payload.gates.every((gate) => gate?.passed === true) ||
        !["source", "committee", "quality", "module_execution"].every((id) =>
          payload.gates?.some((gate) => gate.id === id && gate.passed === true),
        )
      ) {
        return undefined;
      }
      return payload;
    } catch {
      return undefined;
    }
  })();
  const researchAbstention = (() => {
    if (
      !researchPayload ||
      researchPayload.portfolioPlanWritten !== undefined ||
      researchPayload.portfolioPlan !== undefined
    ) {
      return undefined;
    }
    try {
      return financeResearchPortfolioAbstentionSchema.parse(researchPayload.portfolioAbstention);
    } catch {
      return undefined;
    }
  })();
  const researchAccepted =
    research === undefined ||
    (researchPayload !== undefined &&
      researchPayload.portfolioAbstention === undefined &&
      researchPayload.portfolioPlan === undefined &&
      researchPayload.portfolioPlanWritten === portfolioPlanPath);
  const result = researchAccepted
    ? await runScheduledCycleProcess(context, "execution", {
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
  const cycleAccepted = researchAccepted && result.ok && cycleOutputSucceeded(result.stdout);
  const settlement =
    mode === "night" && cycleAccepted ? parseNightSettlement(result.stdout) : undefined;
  const universeSelection = settlement
    ? await refreshFinanceUniverseSelection({ context, attempt })
    : undefined;
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
  const accepted =
    researchAbstention !== undefined ||
    (cycleAccepted && (tuningLifecycle?.ok ?? true) && nightReviewAccepted);
  const record = {
    ...attempt,
    ...result,
    ok: accepted,
    cycleExitCode: result.exitCode,
    exitCode: !accepted && result.exitCode === 0 ? 2 : result.exitCode,
    status: result.ok && !accepted ? ("failed" as const) : result.status,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
    execution: researchAccepted
      ? describeFinanceCycleExecution(result.stdout, context.options.extraArgs, mode)
      : {
          ...describeFinanceCycleExecution("", context.options.extraArgs, mode),
          outcome: "not_run",
          blockReason: researchAbstention
            ? "research_no_allocation"
            : research?.controllerEvidenceStatus === "invalid_scope"
              ? "controller_evidence_invalid_scope"
              : research?.controllerEvidenceStatus === "invalid_config"
                ? "controller_evidence_invalid_config"
                : research?.controllerEvidenceStatus === "read_failed"
                  ? "controller_evidence_read_failed"
                  : "research_plan_not_accepted",
        },
    ...(research
      ? {
          researchPlanRefresh: {
            ok: researchAccepted || researchAbstention !== undefined,
            status: research.status,
            exitCode: research.exitCode,
            planPath: researchAccepted ? portfolioPlanPath : null,
            ...(research.controllerEvidenceStatus
              ? { controllerEvidenceStatus: research.controllerEvidenceStatus }
              : {}),
            ...(researchAbstention ? { abstention: researchAbstention } : {}),
            processResult: research,
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
            receiptPersisted: inspectFinanceResearchReceiptPersistence(nightReview.stdout),
            processResult: nightReview,
          },
        }
      : {}),
    ...(universeSelection ? { universeSelection } : {}),
    ...(tuningLifecycle ? { tuningLifecycle } : {}),
  };

  if (record.ok) {
    state.lastSucceeded[mode] = attempt.etDate;
  }
  state.lastStatus[mode] = record.status;
  state.lastRun = record;
  writeFinanceSchedulerState(directory, state);
  fs.appendFileSync(path.join(directory, RUNS_LOG), `${JSON.stringify(record)}\n`);
  process.stdout.write(
    `[${record.firedAt}] ${mode} status=${record.status} execution=${record.execution.outcome} venue=${record.execution.venue} exit=${record.exitCode} ${record.durationMs}ms\n`,
  );
  if (!record.ok) {
    process.stderr.write(`${record.status}: ${record.stderr.slice(0, 2000)}\n`);
  }
  return record.ok;
}

export async function runFinanceRetiredIntradayExitTick(context: CycleContext): Promise<void> {
  const args = context.options.extraArgs;
  if (
    context.options.intraday?.placementRequested &&
    context.options.intraday.instrumentSource !== "explicit" &&
    context.resolveMarketSession
  ) {
    try {
      const policyIndex = args.indexOf("--execution-policy");
      if (policyIndex < 0 || !args[policyIndex + 1]) {
        throw new Error("retired exits require an execution policy");
      }
      const policy: unknown = JSON.parse(fs.readFileSync(args[policyIndex + 1], "utf8"));
      const parsedPolicy = financeAlpacaCyclePolicySchema.parse(policy);
      const retiredTargets = await readFinanceRetiredIntradayExitTargets(
        context.root.directory,
        parsedPolicy.accountId,
      );
      const dynamicTargets =
        context.options.intraday?.instrumentSource === "system_universe" &&
        context.options.intraday.strategyContract
          ? await readFinanceDynamicIntradayExitTargets(
              context.root.directory,
              parsedPolicy.accountId,
              context.options.intraday.scope?.kind === "system_universe"
                ? context.options.intraday.instruments
                : [],
            )
          : [];
      const targets = [...retiredTargets, ...dynamicTargets];
      for (const target of targets) {
        if (context.signal.aborted) {
          break;
        }
        const exitController = createFinanceAlpacaCycleController({
          directory: context.root.directory,
          policy,
          instruments: [target.instrument],
          feed: target.contract.feed,
          maxAgeMs: numericExtra(args, "--execution-max-age-ms"),
        });
        const result = await runFinanceIntradayMonitorTick({
          directory: context.root.directory,
          accountId: exitController.accountId,
          instrument: target.instrument,
          exitOnly: true,
          intervalSeconds: target.contract.intervalSeconds,
          feed: target.contract.feed,
          openingRangeBars: target.contract.openingRangeBars,
          rewardRisk: target.contract.rewardRisk,
          strategyContract: target.contract,
          scope:
            context.options.intraday?.instrumentSource === "system_universe" &&
            target.contract.paperUniverseScope === "fresh_us_equity_selection_v1"
              ? { kind: "managed_position_exit" }
              : { kind: "strategy_universe" },
          resolveMarketSession: context.resolveMarketSession,
          signal: context.signal,
        });
        if (
          (result.status === "decision_recorded" ||
            result.status === "decision_pending_execution") &&
          result.decision.input.action === "sell"
        ) {
          const execution = await executeFinanceIntradayDecision({
            directory: context.root.directory,
            decision: result.decision,
            controller: exitController,
            caps: {
              maxOrderNotional: numericExtra(args, "--max-order-notional"),
              maxInstrumentNotional: numericExtra(args, "--max-instrument-notional"),
              maxOrdersPerRun: numericExtra(args, "--max-orders"),
            },
            signal: context.signal,
          });
          process.stdout.write(
            `[${new Date().toISOString()}] retired intraday ${target.instrument} execution=${execution.status}\n`,
          );
        } else {
          process.stdout.write(
            `[${new Date().toISOString()}] retired intraday ${target.instrument} monitor=${result.status}\n`,
          );
        }
      }
    } catch (error) {
      process.stderr.write(
        `retired intraday exit cycle failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

async function resolveIntradayRuntimeOptions(
  directory: string,
  options: SchedulerOptions,
): Promise<SchedulerOptions> {
  let runtimeOptions = options;
  if (options.command === "loop" && options.intraday) {
    let strategyContract: FinanceIntradayActiveRuleContract | undefined;
    try {
      strategyContract = await resolveActiveIntradayRule(directory, options.intraday);
    } catch (error) {
      process.stderr.write(
        `intraday strategy resolution unavailable; monitoring and placement disabled: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      runtimeOptions = {
        ...options,
        intraday: {
          ...options.intraday,
          instruments: [],
          executionInstruments: [],
          place: false,
          placementEligibility: "active_rule_unavailable",
          strategyContract: undefined,
          scope: undefined,
        },
      };
    }
    if (strategyContract) {
      let instruments: readonly string[] = [];
      let executionInstruments: readonly string[] = [];
      let scope: FinanceIntradayMonitorScope | undefined;
      let universeUnavailable = false;
      if (options.intraday.instrumentSource === "active_rule") {
        instruments = strategyContract.instruments;
        executionInstruments = strategyContract.instruments;
        scope = { kind: "strategy_universe" };
      } else if (options.intraday.instrumentSource === "explicit") {
        instruments = options.intraday.instruments;
        scope = { kind: "explicit_diagnostic" };
      } else {
        try {
          const snapshot = readFinanceResearchEquityUniverseSnapshot(
            directory,
            new Date().toISOString(),
          );
          assertUniverseSnapshotNotSupersededByFailure(directory, snapshot);
          instruments = snapshot.selected;
          executionInstruments = financeIntradayExecutionUniverse(
            strategyContract,
            snapshot.selected,
          );
          scope = {
            kind: "system_universe",
            universeSnapshotRef: caseflowFingerprint(snapshot),
            selectedInstruments: snapshot.selected,
          };
        } catch (error) {
          universeUnavailable = true;
          // Preserve the last observed symbols for monitor-only work. The missing scope
          // and empty executionInstruments below keep them out of entry authority.
          instruments = options.intraday.instruments;
          process.stderr.write(
            `intraday system universe unavailable; no static fallback candidates: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      const placementEligibility = !options.intraday.placementRequested
        ? "not_requested"
        : options.intraday.instrumentSource === "explicit"
          ? "explicit_diagnostic_only"
          : universeUnavailable
            ? "universe_unavailable"
            : options.intraday.instrumentSource === "system_universe" &&
                executionInstruments.length === 0
              ? "instrument_scope_mismatch"
              : strategyContract.eligibility.status;
      const place =
        options.intraday.placementRequested &&
        options.intraday.instrumentSource !== "explicit" &&
        !universeUnavailable &&
        executionInstruments.length > 0 &&
        strategyContract.eligibility.automatedPaperPlacementAllowed;
      runtimeOptions = {
        ...options,
        intraday: {
          ...options.intraday,
          instruments,
          executionInstruments: place ? executionInstruments : [],
          place,
          placementEligibility,
          strategyContract,
          ...(scope ? { scope } : {}),
        },
      };
    }
  }
  return runtimeOptions;
}

function createIntradayControllerForOptions(directory: string, options: SchedulerOptions) {
  if (options.command !== "loop" || !options.intraday?.place) {
    return undefined;
  }
  const args = options.extraArgs;
  return createFinanceAlpacaCycleController({
    directory,
    instruments: options.intraday.executionInstruments,
    feed: args[args.indexOf("--execution-quote-feed") + 1] as "iex" | "sip",
    maxAgeMs: numericExtra(args, "--execution-max-age-ms"),
    policy: JSON.parse(fs.readFileSync(args[args.indexOf("--execution-policy") + 1], "utf8")),
  });
}

/** Refresh the active binding before admitting this tick's new entry candidates. */
async function refreshActiveIntradayBinding(context: CycleContext): Promise<void> {
  if (
    context.options.intraday?.instrumentSource !== "active_rule" &&
    context.options.intraday?.instrumentSource !== "system_universe"
  ) {
    return;
  }
  const next = await resolveIntradayRuntimeOptions(context.root.directory, context.options);
  if (JSON.stringify(next.intraday) === JSON.stringify(context.options.intraday)) {
    return;
  }
  // Drop the old controller before assembling the replacement: a failed refresh
  // must never keep the retired universe executable.
  context.intradayController = undefined;
  context.options = next;
  try {
    context.intradayController = createIntradayControllerForOptions(context.root.directory, next);
  } catch (error) {
    context.options = {
      ...next,
      intraday: {
        ...next.intraday!,
        place: false,
        executionInstruments: [],
        placementEligibility: "controller_unavailable",
      },
    };
    process.stderr.write(
      `intraday controller refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function buildIntradayLastTickCandidate(
  instrument: string,
  observedAt: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const decisionInput =
    isObjectRecord(result.decision) && isObjectRecord(result.decision.input)
      ? result.decision.input
      : undefined;
  const signal = isObjectRecord(result.signal) ? result.signal : decisionInput;
  const reportedInstrument = typeof signal?.instrument === "string" ? signal.instrument : undefined;
  const symbolMatches = reportedInstrument === undefined || reportedInstrument === instrument;
  const status = FINANCE_SCHEDULER_INTRADAY_MONITOR_STATUSES.some(
    (candidate) => candidate === result.status,
  )
    ? result.status
    : "invalid_result";
  return {
    instrument,
    observedAt,
    monitorStatus: symbolMatches ? status : "invalid_result",
    ...(!symbolMatches
      ? { reason: "monitor_result_invalid" }
      : {
          ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
          ...(signal &&
          (signal.action === "buy" || signal.action === "sell" || signal.action === "hold")
            ? { action: signal.action }
            : {}),
          ...(typeof signal?.reason === "string" ? { reason: signal.reason } : {}),
          ...(typeof signal?.referencePriceAt === "string"
            ? { referenceTime: signal.referencePriceAt }
            : {}),
          ...(isObjectRecord(result.outcome) && typeof result.outcome.status === "string"
            ? { outcomeStatus: result.outcome.status }
            : {}),
        }),
  };
}

export async function reconcileResidentAlpacaAccount(
  context: CycleContext,
  source: "idle" | "stream",
) {
  context.lastIdleReconciliationAtMs = Date.now();
  if (context.intradayController) {
    const refreshed = await context.intradayController.inspectReconciliation(context.signal);
    process.stdout.write(
      `[${new Date().toISOString()}] ${source} broker reconciliation=${refreshed.readiness.status} account=${context.intradayController.accountId}\n`,
    );
    await maintainAfterSuccessfulReconciliation(context, refreshed.readiness.status);
    return refreshed.readiness.status;
  } else {
    const refreshed = await syncConfiguredAlpacaPaperHistory({
      directory: context.root.directory,
      signal: context.signal,
    });
    process.stdout.write(
      `[${new Date().toISOString()}] ${source} broker reconciliation=${refreshed.accountReconciliation.status} account=${refreshed.accountId}\n`,
    );
    await maintainAfterSuccessfulReconciliation(context, refreshed.accountReconciliation.status);
    return refreshed.accountReconciliation.status;
  }
}

async function maintainAfterSuccessfulReconciliation(context: CycleContext, readiness: string) {
  const now = Date.now();
  if (
    readiness !== "reconciled" ||
    context.signal.aborted ||
    (context.lastHistoricalMaintenanceAtMs !== undefined &&
      now - context.lastHistoricalMaintenanceAtMs < FINANCE_IDLE_RECONCILIATION_INTERVAL_MS)
  ) {
    return;
  }
  // Both stream and idle readbacks share the account lane. Mark before awaiting
  // so failed maintenance cannot become a hot loop on frequent stream events.
  context.lastHistoricalMaintenanceAtMs = now;
  try {
    await runHistoricalMaintenanceAfterReconciliation(context);
  } catch {
    context.historicalMaintenance = {
      observedAt: new Date().toISOString(),
      status: context.signal.aborted ? "cancelled" : "unavailable",
      decisionCount: 0,
      unknownCount: 0,
    };
    if (!context.signal.aborted) {
      process.stderr.write(
        "historical position maintenance unavailable; durable recovery remains owned by maintenance\n",
      );
    }
  }
}

async function runHistoricalMaintenanceAfterReconciliation(context: CycleContext): Promise<void> {
  const args = context.options.extraArgs;
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const policyPath = value("--execution-policy");
  const authorization = readFinanceSchedulerPolicyAuthorization(policyPath);
  const maxOrderNotional = numericExtra(args, "--max-order-notional");
  const maxInstrumentNotional = numericExtra(args, "--max-instrument-notional");
  const maxOrdersPerRun = numericExtra(args, "--max-orders");
  const maxAgeMs = numericExtra(args, "--execution-max-age-ms");
  const feed = value("--execution-quote-feed");
  if (
    context.signal.aborted ||
    !args.includes("--place") ||
    value("--venue") !== "alpaca" ||
    !policyPath ||
    authorization.authorizationMode === "unknown" ||
    (authorization.expiresAt !== null && Date.parse(authorization.expiresAt) <= Date.now()) ||
    ![maxOrderNotional, maxInstrumentNotional, maxOrdersPerRun, maxAgeMs].every(
      (cap) => Number.isFinite(cap) && cap > 0,
    ) ||
    !Number.isSafeInteger(maxOrdersPerRun) ||
    (feed !== "iex" && feed !== "sip")
  ) {
    context.historicalMaintenance = {
      observedAt: new Date().toISOString(),
      status: "not_authorized",
      decisionCount: 0,
      unknownCount: 0,
    };
    return;
  }
  const policy: unknown = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const result = await runFinanceHistoricalPositionMaintenance({
    directory: context.root.directory,
    policy,
    budget: {
      automation: "unattended",
      allowedInstruments: [FINANCE_RISK_BUDGET_ANY_INSTRUMENT],
      maxOrderNotional,
      maxInstrumentNotional,
      maxOrdersPerRun,
    },
    feed,
    maxAgeMs,
    signal: context.signal,
  });
  context.historicalMaintenance = {
    observedAt: result.observedAt,
    status: result.status,
    decisionCount: result.decisions.length,
    unknownCount: result.decisions.filter((decision) => decision.status === "unknown").length,
  };
}

async function runTradingTick(context: CycleContext): Promise<void> {
  const work = () => runTradingTickOnAccountLane(context);
  return context.reconciliationWake ? context.reconciliationWake.run(work) : work();
}

async function runTradingTickOnAccountLane(context: CycleContext): Promise<void> {
  const args = context.options.extraArgs;
  await refreshActiveIntradayBinding(context);
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
    try {
      await reconcileResidentAlpacaAccount(context, "idle");
    } catch (error) {
      if (!context.signal.aborted) {
        process.stderr.write(
          `[${new Date().toISOString()}] idle broker reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  await runFinanceRetiredIntradayExitTick(context);
  if (context.options.intraday) {
    const executionInstruments = new Set(context.options.intraday.executionInstruments);
    // Process executable instruments before spending this tick on research monitoring.
    const instruments = context.options.intraday.instruments.toSorted(
      (left, right) =>
        Number(executionInstruments.has(right)) - Number(executionInstruments.has(left)),
    );
    for (const instrument of instruments) {
      if (context.signal.aborted) {
        break;
      }
      let observedAt: string;
      let monitorReturned = false;
      let executionStarted = false;
      let progressCandidate: Record<string, unknown> | undefined;
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
          strategyContract: context.options.intraday.strategyContract!,
          scope: context.options.intraday.scope!,
          ...(context.resolveMarketSession
            ? { resolveMarketSession: context.resolveMarketSession }
            : {}),
          signal: context.signal,
        });
        monitorReturned = true;
        observedAt = new Date().toISOString();
        progressCandidate = buildIntradayLastTickCandidate(
          instrument,
          observedAt,
          result as unknown as Record<string, unknown>,
        );
        context.lastIntradayTick = normalizeFinanceSchedulerIntradayLastTick(progressCandidate, {
          instruments: context.options.intraday.instruments,
          nowMs: Date.now(),
          intervalSeconds: context.options.intraday.intervalSeconds,
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
          if (
            context.options.intraday.place &&
            context.intradayController &&
            executionInstruments.has(instrument)
          ) {
            executionStarted = true;
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
              tradeDecisionReviewer: createIntradayTradeDecisionReviewer(),
              signal: context.signal,
            });
            context.lastIntradayTick = normalizeFinanceSchedulerIntradayLastTick(
              {
                ...progressCandidate,
                executionStatus: execution.status,
                ...(isObjectRecord(execution.outcome) &&
                typeof execution.outcome.status === "string"
                  ? { outcomeStatus: execution.outcome.status }
                  : {}),
              },
              {
                instruments: context.options.intraday.instruments,
                nowMs: Date.now(),
                intervalSeconds: context.options.intraday.intervalSeconds,
              },
            );
            const tradeDecisionReview =
              "tradeDecisionReview" in execution ? execution.tradeDecisionReview : undefined;
            const reviewStatus = tradeDecisionReview
              ? `${tradeDecisionReview.status}/${tradeDecisionReview.decision?.decision ?? tradeDecisionReview.failureCode ?? "unknown"}`
              : "not_reached";
            process.stdout.write(
              `[${new Date().toISOString()}] intraday ${instrument} execution=${execution.status} modelReview=${reviewStatus}${tradeDecisionReview ? ` latencyMs=${tradeDecisionReview.latencyMs}` : ""}\n`,
            );
          }
        }
      } catch (error) {
        if (!monitorReturned) {
          observedAt = new Date().toISOString();
          context.lastIntradayTick = normalizeFinanceSchedulerIntradayLastTick(
            {
              instrument,
              observedAt,
              monitorStatus: "tick_failed",
              reason: "monitor_tick_failed",
            },
            {
              instruments: context.options.intraday.instruments,
              nowMs: Date.now(),
              intervalSeconds: context.options.intraday.intervalSeconds,
            },
          );
        } else if (executionStarted && progressCandidate) {
          context.lastIntradayTick = normalizeFinanceSchedulerIntradayLastTick(
            { ...progressCandidate, executionStatus: "failed" },
            {
              instruments: context.options.intraday.instruments,
              nowMs: Date.now(),
              intervalSeconds: context.options.intraday.intervalSeconds,
            },
          );
        }
        process.stderr.write(
          `[${new Date().toISOString()}] intraday ${instrument} tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        // A many-symbol sweep can exceed the idle progress deadline. Publish only
        // after a symbol finishes; an in-flight monitor or order must still stall
        // if it hangs. Concurrent research keeps its own cycle-stage deadline.
        if (context.progressPhase === "idle" && !context.signal.aborted) {
          writeSchedulerProgress(context, "idle");
        }
      }
    }
  }
}

async function tick(context: CycleContext): Promise<void> {
  await runTradingTick(context);
  for (const slot of DEFAULT_FINANCE_CYCLE_SLOTS) {
    if (context.signal.aborted) {
      break;
    }
    // Re-read time and state after each cycle; a long day cycle can cross midnight.
    const clock = financeEtClock(new Date());
    const state = readFinanceSchedulerState(context.root.directory);
    if (
      isFinanceCycleSlotDue(slot, clock, state.lastFired) ||
      (slot.mode === "day" &&
        context.options.researchPlan &&
        financeResearchPreflightRetryDue(state, new Date()))
    ) {
      await fire(context, slot.mode);
    }
  }
  // Diagnostic provider probes must not hold the resident scheduling loop open. A
  // degraded source may take several bounded timeout batches, but that work is independent
  // of the next scheduler tick and trading decision.
  if (context.options.sourceHeartbeatEnabled && !context.sourceHeartbeatInFlight) {
    context.sourceHeartbeatInFlight = true;
    void heartbeat(context).then(
      () => {
        context.sourceHeartbeatInFlight = false;
      },
      (error: unknown) => {
        context.sourceHeartbeatInFlight = false;
        process.stderr.write(
          `source-heartbeat task failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
      },
    );
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
        ...(!options.sourceHeartbeatEnabled ? ["--no-source-heartbeat"] : []),
        ...(options.intraday
          ? [
              "--intraday-monitor",
              ...(options.intraday.instrumentSource === "active_rule"
                ? ["--intraday-active-rule"]
                : options.intraday.instrumentSource === "explicit"
                  ? ["--intraday-instruments", options.intraday.instruments.join(",")]
                  : []),
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
      researchRetryDue: slot.mode === "day" && financeResearchPreflightRetryDue(state, at),
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
  const runtimeOptions = await resolveIntradayRuntimeOptions(root.directory, options);
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
  let orderStream: ReturnType<typeof createAlpacaPaperOrderStream> | undefined;
  let reconciliationWake: ReturnType<typeof createFinanceSchedulerReconciliationWake> | undefined;
  try {
    release = acquireFinanceSchedulerLock(root.directory);
    initializeFinanceSchedulerDatabase(root.directory);
    const intradayController = createIntradayControllerForOptions(root.directory, runtimeOptions);
    const resolveMarketSession =
      runtimeOptions.command === "loop" && runtimeOptions.intraday
        ? createFinanceAlpacaMarketSessionResolver({ directory: root.directory })
        : undefined;
    const context: CycleContext = {
      root,
      options: runtimeOptions,
      signal: controller.signal,
      intradayController,
      resolveMarketSession,
    };
    const venueIndex = runtimeOptions.extraArgs.indexOf("--venue");
    if (
      runtimeOptions.command === "loop" &&
      runtimeOptions.extraArgs.includes("--sync-alpaca-history") &&
      venueIndex >= 0 &&
      runtimeOptions.extraArgs[venueIndex + 1] === "alpaca"
    ) {
      let streamStatus: AlpacaPaperOrderStreamStatus | undefined;
      const reconciliation = {
        lastAttemptAt: null as string | null,
        lastReadbackAt: null as string | null,
        lastSucceededAt: null as string | null,
        lastReadinessStatus: null as string | null,
        lastErrorCode: null as string | null,
      };
      const writeStreamStatus = () => {
        const filename = path.join(root.directory, "alpaca-order-stream-latest.json");
        const temporary = `${filename}.tmp`;
        try {
          fs.writeFileSync(
            temporary,
            JSON.stringify({
              schemaVersion: "lcx_alpaca_order_stream_observation_v1",
              pid: process.pid,
              observedAt: new Date().toISOString(),
              venue: "alpaca:paper",
              boundary: "event_hint_only_rest_reconciliation_owns_account_facts",
              stream: streamStatus ?? { state: "unavailable" },
              reconciliation,
            }),
            { mode: 0o600 },
          );
          fs.renameSync(temporary, filename);
        } catch {
          process.stderr.write("Alpaca stream observation persistence failed\n");
        }
      };
      context.reconciliationWake = reconciliationWake = createFinanceSchedulerReconciliationWake({
        signal: controller.signal,
        reconcile: async () => {
          reconciliation.lastAttemptAt = new Date().toISOString();
          writeStreamStatus();
          const readiness = await reconcileResidentAlpacaAccount(context, "stream");
          reconciliation.lastReadbackAt = new Date().toISOString();
          reconciliation.lastReadinessStatus = readiness;
          if (readiness === "ready" || readiness === "reconciled") {
            reconciliation.lastSucceededAt = reconciliation.lastReadbackAt;
          }
          reconciliation.lastErrorCode = null;
          writeStreamStatus();
        },
        onError: () => {
          reconciliation.lastErrorCode = "reconciliation_failed";
          reconciliation.lastReadinessStatus = "unavailable";
          writeStreamStatus();
          process.stderr.write(
            "Alpaca stream reconciliation failed; periodic readback remains enabled\n",
          );
        },
      });
      try {
        const env = resolveFinanceCredentialEnv({
          ...process.env,
          LCX_FINANCE_STATE_DIR: root.directory,
        });
        orderStream = createAlpacaPaperOrderStream({
          credentials: {
            keyId: env.ALPACA_API_KEY_ID ?? "",
            secret: env.ALPACA_API_SECRET_KEY ?? "",
          },
          signal: controller.signal,
          onWake: () => context.reconciliationWake?.request(),
          onStatus: (status) => {
            streamStatus = status;
            writeStreamStatus();
          },
        });
        orderStream.start();
      } catch {
        reconciliation.lastErrorCode = "stream_unavailable";
        writeStreamStatus();
        process.stderr.write("Alpaca stream unavailable; periodic readback remains enabled\n");
      }
    }
    if (options.command === "once") {
      const ok = await fire(context, options.mode!);
      return signalExitCode || (ok ? 0 : 1);
    }
    process.stdout.write(
      `scheduler pid=${process.pid} tz=${FINANCE_MARKET_TZ} root=${root.directory} timeoutMs=${runtimeOptions.timeoutMs}\n`,
    );
    if (process.connected) {
      process.send?.({ type: "finance-scheduler-ready" });
    }
    while (!controller.signal.aborted) {
      writeSchedulerProgress(context, "idle");
      try {
        await tick(context);
      } catch (error) {
        if (controller.signal.aborted) {
          break;
        }
        throw error;
      }
      if (controller.signal.aborted) {
        break;
      }
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
      controller.abort();
      await orderStream?.close();
      await reconciliationWake?.flush();
    } finally {
      try {
        release?.();
      } finally {
        process.removeListener("SIGTERM", onTerm);
        process.removeListener("SIGINT", onInt);
      }
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
