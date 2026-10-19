import { z } from "zod";
import {
  financeAlpacaMarketSessionIssue,
  type FinanceAlpacaMarketSession,
} from "./finance-alpaca-market-calendar.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeUsEquitySessionBounds } from "./finance-history-coverage.js";
import type { FinanceIntradayBar } from "./finance-intraday-ledger.js";
import type { FinanceStrategyRule } from "./finance-strategy-rule-ledger.js";
import { turnoverAndCost } from "./quant-math-advanced.js";

export const FINANCE_INTRADAY_PAPER_SCHEMA = "lcx_finance_intraday_paper_v1" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_RULE =
  "opening_range_breakout_long_next_bar_v1" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_RULE_V2 =
  "opening_range_breakout_long_pre_close_v2" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_RULE_V3 =
  "opening_range_breakout_long_dynamic_universe_v3" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_FORM = "intraday_opening_range_breakout" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION = "1" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2 = "2" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3 = "3" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_EMITS = "paper_signal" as const;
export const FINANCE_INTRADAY_PAPER_EXECUTION_ELIGIBILITY_FIELD =
  "paperExecutionEligibility" as const;

export type FinanceIntradayPaperExecutionEligibility = Readonly<{
  status:
    | "eligibility_missing"
    | "paper_contract_only"
    | "paper_execution_eligible"
    | "eligibility_invalid";
  automatedPaperPlacementAllowed: boolean;
}>;

export type FinanceIntradayActiveRuleContract = Readonly<{
  ruleId: string;
  formVersion:
    | typeof FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION
    | typeof FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2
    | typeof FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3;
  preCloseExitEnabled: boolean;
  declarationRef: string;
  activationRef: string;
  instruments: readonly string[];
  /** Explicit Paper-only opt-in: fresh US-equity selector may authorize current entries. */
  paperUniverseScope: "static" | "fresh_us_equity_selection_v1";
  openingRangeBars: number;
  rewardRisk: number;
  intervalSeconds: 60 | 300 | 900;
  feed: "iex" | "sip";
  eligibility: FinanceIntradayPaperExecutionEligibility;
}>;

/** A projection of the validated rule, never another execution policy. */
export const FinanceIntradayRuleSummarySchema = z
  .object({
    ruleId: z.string().min(1),
    declarationRef: z.string().regex(/^[a-f0-9]{64}$/u),
    activationRef: z.string().regex(/^[a-f0-9]{64}$/u),
    intervalSeconds: z.union([z.literal(60), z.literal(300), z.literal(900)]),
    feed: z.enum(["iex", "sip"]),
    openingRangeBars: z.number().int().min(2).max(12),
    rewardRisk: z.number().finite().positive(),
    preCloseExitEnabled: z.boolean(),
    exitEligibleAt: z.string().datetime().nullable(),
    marketCloseAt: z.string().datetime(),
    paperUniverseScope: z.enum(["static", "fresh_us_equity_selection_v1"]),
  })
  .strict();
export type FinanceIntradayRuleSummary = z.infer<typeof FinanceIntradayRuleSummarySchema>;

export function summarizeFinanceIntradayRule(
  contract: FinanceIntradayActiveRuleContract,
  session: FinanceAlpacaMarketSession,
): FinanceIntradayRuleSummary {
  const issue = financeAlpacaMarketSessionIssue(session);
  if (issue) {
    throw new Error(issue);
  }
  return FinanceIntradayRuleSummarySchema.parse({
    ruleId: contract.ruleId,
    declarationRef: contract.declarationRef,
    activationRef: contract.activationRef,
    intervalSeconds: contract.intervalSeconds,
    feed: contract.feed,
    openingRangeBars: contract.openingRangeBars,
    rewardRisk: contract.rewardRisk,
    preCloseExitEnabled: contract.preCloseExitEnabled,
    // The existing pre-close signal bar starts two intervals before close and
    // becomes actionable only when it closes, one interval before close.
    exitEligibleAt: contract.preCloseExitEnabled
      ? new Date(Date.parse(session.closeAt) - contract.intervalSeconds * 1_000).toISOString()
      : null,
    marketCloseAt: session.closeAt,
    paperUniverseScope: contract.paperUniverseScope,
  });
}

export type FinanceIntradayOpeningRangeRuleId =
  | typeof FINANCE_INTRADAY_OPENING_RANGE_RULE
  | typeof FINANCE_INTRADAY_OPENING_RANGE_RULE_V2
  | typeof FINANCE_INTRADAY_OPENING_RANGE_RULE_V3;

export type FinanceIntradayMonitorScope = Readonly<{
  kind: "strategy_universe" | "system_universe" | "managed_position_exit" | "explicit_diagnostic";
  universeSnapshotRef?: string;
  selectedInstruments?: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing or unknown eligibility is never interpreted as permission to place Paper orders. */
export function resolveFinanceIntradayPaperExecutionEligibility(
  ruleBody: Readonly<Record<string, unknown>>,
): FinanceIntradayPaperExecutionEligibility {
  const value = ruleBody[FINANCE_INTRADAY_PAPER_EXECUTION_ELIGIBILITY_FIELD];
  const measuredResult = ruleBody.measuredResult;
  if (value === "paper_contract_only") {
    return Object.freeze({ status: "paper_contract_only", automatedPaperPlacementAllowed: true });
  }
  if (value === "paper_execution_eligible") {
    return Object.freeze({
      status: "paper_execution_eligible",
      automatedPaperPlacementAllowed: true,
    });
  }
  if (value !== undefined) {
    return Object.freeze({ status: "eligibility_invalid", automatedPaperPlacementAllowed: false });
  }
  if (isRecord(measuredResult) && measuredResult.status === "paper_contract_only") {
    // This replay artifact grants no execution authority. It does, however, describe a
    // Paper-only contract; the separate Alpaca Paper controller still applies every order gate.
    return Object.freeze({ status: "paper_contract_only", automatedPaperPlacementAllowed: true });
  }
  return Object.freeze({ status: "eligibility_missing", automatedPaperPlacementAllowed: false });
}

/**
 * Validates the active ledger declaration against the one ORB implementation shipped here.
 * Research prose is ignored; only the versioned envelope and recognized machine fields bind.
 */
export function validateFinanceIntradayRuleDeclaration(
  rule: FinanceStrategyRule,
): Omit<FinanceIntradayActiveRuleContract, "declarationRef" | "activationRef"> {
  const legacyVersion = new Map<string, string>([
    [FINANCE_INTRADAY_OPENING_RANGE_RULE, FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION],
    [FINANCE_INTRADAY_OPENING_RANGE_RULE_V2, FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2],
    [FINANCE_INTRADAY_OPENING_RANGE_RULE_V3, FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3],
  ]).get(rule.ruleId);
  const supportedVersion =
    (rule.formVersion === "1" || rule.formVersion === "2" || rule.formVersion === "3") &&
    (legacyVersion === undefined || legacyVersion === rule.formVersion);
  if (
    !supportedVersion ||
    rule.form !== FINANCE_INTRADAY_OPENING_RANGE_FORM ||
    rule.emits !== FINANCE_INTRADAY_OPENING_RANGE_EMITS ||
    rule.schedule.kind !== "intraday"
  ) {
    throw new Error(`active intraday strategy ${rule.ruleId} has an incompatible contract`);
  }
  const instruments = rule.instruments.map((instrument) => instrument.toUpperCase());
  if (
    instruments.length === 0 ||
    instruments.some((instrument) => !/^[A-Z0-9][A-Z0-9./_-]{0,19}$/u.test(instrument)) ||
    new Set(instruments).size !== instruments.length
  ) {
    throw new Error(
      `active intraday strategy ${rule.ruleId} has an empty or ambiguous instrument scope`,
    );
  }

  const bodyUniverse = rule.body.universe;
  if (bodyUniverse !== undefined) {
    const normalizedBodyUniverse = Array.isArray(bodyUniverse)
      ? bodyUniverse.filter((instrument): instrument is string => typeof instrument === "string")
      : [];
    if (
      !Array.isArray(bodyUniverse) ||
      normalizedBodyUniverse.length !== bodyUniverse.length ||
      JSON.stringify(
        normalizedBodyUniverse.map((instrument) => instrument.toUpperCase()).toSorted(),
      ) !== JSON.stringify([...instruments].toSorted())
    ) {
      throw new Error(
        `active intraday strategy ${rule.ruleId} has conflicting top-level and replay universes`,
      );
    }
  }

  const frozenRule = isRecord(rule.body.frozenRule) ? rule.body.frozenRule : undefined;
  const data = isRecord(rule.body.data) ? rule.body.data : undefined;
  if (
    frozenRule === undefined ||
    typeof frozenRule.openingRangeBars !== "number" ||
    !Number.isInteger(frozenRule.openingRangeBars) ||
    frozenRule.openingRangeBars < 2 ||
    frozenRule.openingRangeBars > 12 ||
    typeof frozenRule.rewardRisk !== "number" ||
    !Number.isFinite(frozenRule.rewardRisk) ||
    frozenRule.rewardRisk <= 0 ||
    frozenRule.rewardRisk > 10 ||
    data === undefined ||
    (data.intervalSeconds !== 60 && data.intervalSeconds !== 300 && data.intervalSeconds !== 900) ||
    (data.feed !== "iex" && data.feed !== "sip")
  ) {
    throw new Error(
      `active intraday strategy ${rule.ruleId} has an unsupported rule parameter set`,
    );
  }

  const eligibility = resolveFinanceIntradayPaperExecutionEligibility(rule.body);
  const paperUniverseScope = rule.body.paperUniverseScope;
  if (paperUniverseScope !== undefined && paperUniverseScope !== "fresh_us_equity_selection_v1") {
    throw new Error(
      `active intraday strategy ${rule.ruleId} has an unsupported Paper universe scope`,
    );
  }
  if (
    (rule.formVersion === FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3 &&
      paperUniverseScope !== "fresh_us_equity_selection_v1") ||
    (rule.formVersion !== FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3 &&
      paperUniverseScope !== undefined)
  ) {
    throw new Error(`active intraday strategy ${rule.ruleId} has a version/scope mismatch`);
  }

  const resolvedFormVersion = rule.formVersion === "3" ? "3" : rule.formVersion === "2" ? "2" : "1";
  return Object.freeze({
    ruleId: rule.ruleId,
    formVersion: resolvedFormVersion,
    preCloseExitEnabled: resolvedFormVersion !== "1",
    instruments: Object.freeze(instruments),
    paperUniverseScope: paperUniverseScope ?? "static",
    openingRangeBars: frozenRule.openingRangeBars,
    rewardRisk: frozenRule.rewardRisk,
    intervalSeconds: data.intervalSeconds,
    feed: data.feed,
    eligibility,
  });
}

export function resolveFinanceIntradayActiveRuleContract(
  rule: FinanceStrategyRule,
  options: { allowRetiredExit?: boolean } = {},
): FinanceIntradayActiveRuleContract {
  if (rule.state !== "active" && !(options.allowRetiredExit && rule.state === "retired")) {
    throw new Error(`active intraday strategy ${rule.ruleId} has an incompatible contract`);
  }
  const declarations = rule.transitions.filter((record) => record.body.kind === "declared");
  const activations = rule.transitions.filter((record) => record.body.kind === "activated");
  if (declarations.length !== 1 || activations.length !== 1) {
    throw new Error(`active intraday strategy ${rule.ruleId} has ambiguous lifecycle events`);
  }
  return Object.freeze({
    ...validateFinanceIntradayRuleDeclaration(rule),
    declarationRef: declarations[0].ref,
    activationRef: activations[0].ref,
  });
}

/** Preserve legacy dedup IDs; new method identities cannot consume another activation's signal. */
export function financeIntradayBoundSignalId(
  signalId: string,
  contract: FinanceIntradayActiveRuleContract,
): string {
  if (
    [
      FINANCE_INTRADAY_OPENING_RANGE_RULE,
      FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
      FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
    ].some((id) => id === contract.ruleId)
  ) {
    return signalId;
  }
  return `intraday-${caseflowFingerprint({
    signalId,
    ruleId: contract.ruleId,
    declarationRef: contract.declarationRef,
    activationRef: contract.activationRef,
  })}`;
}

/** Dynamic Paper opt-in uses only the current selected snapshot; legacy rules stay intersected. */
export function financeIntradayExecutionUniverse(
  contract: Pick<FinanceIntradayActiveRuleContract, "instruments" | "paperUniverseScope">,
  selectedInstruments: readonly string[],
): readonly string[] {
  return contract.paperUniverseScope === "fresh_us_equity_selection_v1"
    ? Object.freeze([...new Set(selectedInstruments.map((instrument) => instrument.toUpperCase()))])
    : Object.freeze(
        contract.instruments.filter((instrument) => selectedInstruments.includes(instrument)),
      );
}

const Config = z
  .object({
    openingRangeBars: z.number().int().min(2).max(12).default(6),
    capital: z.number().finite().positive(),
    maxAllocationFraction: z.number().finite().positive().max(1),
    feeBpsPerSide: z.number().finite().nonnegative().max(500),
    spreadBps: z.number().finite().nonnegative().max(500),
    slippageBpsPerSide: z.number().finite().nonnegative().max(500),
    rewardRisk: z.number().finite().positive().max(10).default(2),
  })
  .strict();

export type FinanceIntradayPaperConfig = z.input<typeof Config>;

export type FinanceIntradayPaperTrade = Readonly<{
  sessionDate: string;
  instrument: string;
  signalAt: string;
  entryAt: string;
  exitAt: string;
  exitReason: "opening_range_stop" | "reward_target" | "session_end" | "pre_close";
  quantity: number;
  entryReferencePrice: number;
  exitReferencePrice: number;
  grossReturn: number;
  netReturn: number;
  costFraction: number;
}>;

type Metric = Readonly<{
  sessions: number;
  trades: number;
  totalReturn: number;
  averageReturn: number;
  winRate: number;
  maxDrawdown: number;
}>;

export class FinanceIntradayReplayInputError extends Error {
  readonly owner = "src/agents/finance-intraday-ledger.ts";

  constructor(
    readonly gap: Readonly<{
      reason:
        | "bar_duration_mismatch"
        | "bar_sequence_gap_or_overlap"
        | "source_bars_missing"
        | "no_usable_sessions";
      instrument: string;
      sessionDate: string;
      expectedAt?: string;
      actualAt?: string;
    }>,
    message?: string,
    readonly source?: Readonly<{ ledgerHeadRef: string | null; datasetRef: string }>,
  ) {
    super(
      message ??
        `intraday replay ${gap.reason}: ${gap.instrument} ${gap.sessionDate}, expected ${gap.expectedAt}, received ${gap.actualAt}`,
    );
    this.name = "FinanceIntradayReplayInputError";
  }
}

export type FinanceIntradayPaperReceipt = Readonly<{
  schemaVersion: typeof FINANCE_INTRADAY_PAPER_SCHEMA;
  status: "paper_contract_only";
  executionAuthority: "none";
  strategyRule: FinanceIntradayOpeningRangeRuleId;
  datasetRef: string;
  marketCalendarRef?: string;
  config: z.output<typeof Config>;
  trades: readonly FinanceIntradayPaperTrade[];
  strategy: Metric;
  retailOpenToCloseBaseline: Metric;
  cashBaseline: Metric;
  checks: Readonly<{
    pointInTime: true;
    nextBarEntry: true;
    sameCostModel: true;
    noOrderPlacement: true;
  }>;
  limitations: readonly string[];
  excludedSessions?: readonly Readonly<{
    sessionDate: string;
    reason: "incomplete_calendar_session" | "insufficient_opening_history";
    selectedBars: number;
  }>[];
  receiptRef: string;
}>;

const newYorkParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function sessionParts(instant: string): { date: string; minute: number } {
  const parts = Object.fromEntries(
    newYorkParts.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * The final bar that can be acted on before the cash close starts one interval earlier than the
 * final market bar. Its close leaves one full interval for order submission before the close.
 */
export function financeIntradayPreCloseExitBarMinute(
  intervalSeconds: 60 | 300 | 900,
  marketCloseMinute = 960,
): number {
  return marketCloseMinute - 2 * (intervalSeconds / 60);
}

function isCompleteSession(
  bars: readonly FinanceIntradayBar[],
  intervalSeconds: 60 | 300 | 900,
  marketOpenMinute: number,
  marketCloseMinute: number,
): boolean {
  const intervalMinutes = intervalSeconds / 60;
  const expectedBars = ((marketCloseMinute - marketOpenMinute) * 60) / intervalSeconds;
  return (
    Number.isInteger(expectedBars) &&
    bars.length === expectedBars &&
    bars.every((bar, index) => {
      const expectedStartMinute = marketOpenMinute + index * intervalMinutes;
      return (
        sessionParts(bar.startAt).minute === expectedStartMinute &&
        Date.parse(bar.endAt) === Date.parse(bar.startAt) + intervalSeconds * 1_000
      );
    })
  );
}

function metric(returns: readonly number[], trades: number): Metric {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    // Every session is sized from config.capital, not the prior session's wealth.
    // These are fixed-notional P&L fractions; compounding would invent reinvestment.
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  return Object.freeze({
    sessions: returns.length,
    trades,
    totalReturn: equity - 1,
    averageReturn:
      returns.length === 0 ? 0 : returns.reduce((sum, value) => sum + value, 0) / returns.length,
    winRate:
      returns.length === 0 ? 0 : returns.filter((value) => value > 0).length / returns.length,
    maxDrawdown,
  });
}

function round(value: number): number {
  return Number(value.toFixed(12));
}

/**
 * Deterministic research replay. It consumes only closed ledger bars and never calls an execution
 * adapter: a backtest fill is evidence about a rule, not an order or an execution receipt.
 */
export function runFinanceIntradayPaperReplay(params: {
  bars: readonly FinanceIntradayBar[];
  ledgerHeadRef: string | null;
  config: FinanceIntradayPaperConfig;
  strategyRule?: FinanceIntradayOpeningRangeRuleId;
  marketSessions?: readonly FinanceAlpacaMarketSession[];
}): FinanceIntradayPaperReceipt {
  const config = Config.parse(params.config);
  const source = () => ({
    ledgerHeadRef: params.ledgerHeadRef,
    datasetRef: caseflowFingerprint({ ledgerHeadRef: params.ledgerHeadRef, bars: params.bars }),
  });
  const strategyRule = params.strategyRule ?? FINANCE_INTRADAY_OPENING_RANGE_RULE;
  const preCloseExitEnabled =
    strategyRule === FINANCE_INTRADAY_OPENING_RANGE_RULE_V2 ||
    strategyRule === FINANCE_INTRADAY_OPENING_RANGE_RULE_V3;
  if (params.bars.length === 0) {
    throw new FinanceIntradayReplayInputError(
      { reason: "source_bars_missing", instrument: "unknown", sessionDate: "none" },
      "intraday replay requires bars",
      source(),
    );
  }
  const instruments = new Set(params.bars.map((bar) => bar.instrument));
  const intervals = new Set(params.bars.map((bar) => bar.intervalSeconds));
  if (instruments.size !== 1 || intervals.size !== 1) {
    throw new Error("intraday replay requires one instrument and one interval");
  }
  const intervalSeconds = [...intervals][0];
  if (intervalSeconds !== 60 && intervalSeconds !== 300 && intervalSeconds !== 900) {
    throw new Error("intraday replay received an unsupported interval");
  }
  if (preCloseExitEnabled && !params.marketSessions) {
    throw new Error("pre-close replay requires an Alpaca market-calendar snapshot");
  }
  const marketSessions = params.marketSessions ?? [];
  const sessionsByDate = new Map(marketSessions.map((session) => [session.date, session]));
  if (
    sessionsByDate.size !== marketSessions.length ||
    marketSessions.some((session) => financeAlpacaMarketSessionIssue(session) !== null)
  ) {
    throw new Error("intraday replay received an invalid or duplicate market-calendar session");
  }
  const bySession = new Map<string, FinanceIntradayBar[]>();
  const replayCalendarDates = new Set<string>();
  for (const bar of params.bars.toSorted((left, right) =>
    left.startAt.localeCompare(right.startAt),
  )) {
    const session = sessionParts(bar.startAt);
    if (params.marketSessions) {
      const marketSession = sessionsByDate.get(session.date);
      if (!marketSession) {
        if (session.minute >= 570 && session.minute < 960) {
          throw new Error("pre-close replay is missing an official market-calendar session");
        }
        continue;
      }
      const barStart = Date.parse(bar.startAt);
      if (
        barStart < Date.parse(marketSession.openAt) ||
        barStart >= Date.parse(marketSession.closeAt)
      ) {
        continue;
      }
      if (Date.parse(bar.endAt) > Date.parse(marketSession.closeAt)) {
        throw new Error("pre-close replay contains a bar that crosses the official market close");
      }
      replayCalendarDates.add(session.date);
    } else if (session.minute < 570 || session.minute >= 960) {
      continue;
    }
    const rows = bySession.get(session.date) ?? [];
    rows.push(bar);
    bySession.set(session.date, rows);
  }

  const allInBpsPerSide = config.feeBpsPerSide + config.spreadBps / 2 + config.slippageBpsPerSide;
  const roundTripCost = turnoverAndCost({
    currentWeights: [0, 1],
    targetWeights: [1, 0],
    costBasisPoints: allInBpsPerSide,
  }).cost;
  const trades: FinanceIntradayPaperTrade[] = [];
  const strategyReturns: number[] = [];
  const baselineReturns: number[] = [];
  let baselineTrades = 0;
  const excludedSessions: Array<{
    sessionDate: string;
    reason: "incomplete_calendar_session" | "insufficient_opening_history";
    selectedBars: number;
  }> = [];

  for (const [sessionDate, rows] of [...bySession].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const bars = rows.toSorted((left, right) => left.startAt.localeCompare(right.startAt));
    const marketSession = sessionsByDate.get(sessionDate);
    if (preCloseExitEnabled) {
      if (
        !marketSession ||
        !isCompleteSession(
          bars,
          intervalSeconds,
          marketSession.openMinute,
          marketSession.closeMinute,
        )
      ) {
        excludedSessions.push({
          sessionDate,
          reason: "incomplete_calendar_session",
          selectedBars: bars.length,
        });
        continue;
      }
    }
    // An absent bar is not the next interval. It also hides possible stop/target touches.
    for (const [index, bar] of bars.entries()) {
      const expectedEnd = new Date(Date.parse(bar.startAt) + intervalSeconds * 1_000).toISOString();
      if (Date.parse(bar.endAt) !== Date.parse(expectedEnd)) {
        throw new FinanceIntradayReplayInputError(
          {
            reason: "bar_duration_mismatch",
            instrument: bar.instrument,
            sessionDate,
            expectedAt: expectedEnd,
            actualAt: bar.endAt,
          },
          undefined,
          source(),
        );
      }
      const previous = bars[index - 1];
      if (previous && Date.parse(bar.startAt) !== Date.parse(previous.endAt)) {
        throw new FinanceIntradayReplayInputError(
          {
            reason: "bar_sequence_gap_or_overlap",
            instrument: bar.instrument,
            sessionDate,
            expectedAt: previous.endAt,
            actualAt: bar.startAt,
          },
          undefined,
          source(),
        );
      }
    }
    if (!preCloseExitEnabled) {
      const bounds = params.marketSessions
        ? marketSession
        : financeUsEquitySessionBounds(sessionDate);
      if (
        !bounds ||
        !isCompleteSession(bars, intervalSeconds, bounds.openMinute, bounds.closeMinute)
      ) {
        excludedSessions.push({
          sessionDate,
          reason: "incomplete_calendar_session",
          selectedBars: bars.length,
        });
        continue;
      }
    }
    if (bars.length <= config.openingRangeBars + 1) {
      excludedSessions.push({
        sessionDate,
        reason: "insufficient_opening_history",
        selectedBars: bars.length,
      });
      continue;
    }
    const opening = bars.slice(0, config.openingRangeBars);
    const openingHigh = Math.max(...opening.map((bar) => bar.high));
    const baselineEntry = bars[config.openingRangeBars];
    const sessionEnd = bars.at(-1)!;
    const baselineQuantity = Math.floor(
      (config.capital * config.maxAllocationFraction) / baselineEntry.open,
    );
    if (baselineQuantity > 0) {
      baselineTrades += 1;
    }
    baselineReturns.push(
      round(
        (baselineQuantity *
          (sessionEnd.close - baselineEntry.open - baselineEntry.open * roundTripCost)) /
          config.capital,
      ),
    );
    const preCloseMinute = marketSession?.closeMinute ?? 960;
    const preCloseIndex = preCloseExitEnabled
      ? bars.findIndex(
          (bar) =>
            sessionParts(bar.startAt).minute ===
            financeIntradayPreCloseExitBarMinute(intervalSeconds, preCloseMinute),
        )
      : -1;
    if (preCloseExitEnabled && preCloseIndex < 0) {
      continue;
    }
    const exitIndex = preCloseExitEnabled ? preCloseIndex : bars.length - 1;
    const exit = bars[exitIndex];
    const latestSignalIndex = preCloseExitEnabled ? exitIndex - 2 : bars.length - 2;

    const signalIndex = bars.findIndex(
      (bar, index) =>
        index >= config.openingRangeBars && index <= latestSignalIndex && bar.close > openingHigh,
    );
    if (signalIndex < 0 || signalIndex + 1 >= bars.length || signalIndex > latestSignalIndex) {
      strategyReturns.push(0);
      continue;
    }
    const signal = bars[signalIndex];
    const entry = bars[signalIndex + 1];
    const quantity = Math.floor((config.capital * config.maxAllocationFraction) / entry.open);
    if (quantity < 1) {
      strategyReturns.push(0);
      continue;
    }
    const stopPrice = Math.min(...opening.map((bar) => bar.low));
    const riskPerShare = entry.open - stopPrice;
    if (riskPerShare <= 0) {
      strategyReturns.push(0);
      continue;
    }
    const targetPrice = entry.open + riskPerShare * config.rewardRisk;
    let chosenExit = exit;
    let exitPrice = exit.close;
    let exitReason: FinanceIntradayPaperTrade["exitReason"] = preCloseExitEnabled
      ? "pre_close"
      : "session_end";
    for (const candidate of bars.slice(signalIndex + 1, exitIndex + 1)) {
      // When both touch within one OHLC bar the path is unknowable; choose the adverse outcome.
      if (candidate.low <= stopPrice) {
        chosenExit = candidate;
        exitPrice = stopPrice;
        exitReason = "opening_range_stop";
        break;
      }
      if (candidate.high >= targetPrice) {
        chosenExit = candidate;
        exitPrice = targetPrice;
        exitReason = "reward_target";
        break;
      }
    }
    const grossReturn = exitPrice / entry.open - 1;
    const netReturn = grossReturn - roundTripCost;
    strategyReturns.push(
      round((quantity * (exitPrice - entry.open - entry.open * roundTripCost)) / config.capital),
    );
    trades.push(
      Object.freeze({
        sessionDate,
        instrument: entry.instrument,
        signalAt: signal.endAt,
        entryAt: entry.startAt,
        exitAt: chosenExit.endAt,
        exitReason,
        quantity,
        entryReferencePrice: entry.open,
        exitReferencePrice: round(exitPrice),
        grossReturn: round(grossReturn),
        netReturn: round(netReturn),
        costFraction: round(roundTripCost),
      }),
    );
  }
  if (strategyReturns.length === 0) {
    throw new FinanceIntradayReplayInputError(
      {
        reason: "no_usable_sessions",
        instrument: [...instruments][0],
        sessionDate: [...bySession.keys()].join(",") || "none",
      },
      "intraday replay has no complete sessions with the required market calendar",
      source(),
    );
  }
  const marketCalendarRef =
    params.marketSessions !== undefined
      ? caseflowFingerprint(
          marketSessions
            .filter((session) => replayCalendarDates.has(session.date))
            .map(({ date, calendarRef }) => ({ date, calendarRef }))
            .toSorted((left, right) => left.date.localeCompare(right.date)),
        )
      : undefined;
  const datasetRef = caseflowFingerprint({
    ledgerHeadRef: params.ledgerHeadRef,
    bars: params.bars,
    ...(marketCalendarRef ? { marketCalendarRef } : {}),
  });
  const body = {
    schemaVersion: FINANCE_INTRADAY_PAPER_SCHEMA,
    status: "paper_contract_only" as const,
    executionAuthority: "none" as const,
    strategyRule,
    datasetRef,
    ...(marketCalendarRef ? { marketCalendarRef } : {}),
    config,
    trades: Object.freeze(trades),
    strategy: metric(strategyReturns, trades.length),
    retailOpenToCloseBaseline: metric(baselineReturns, baselineTrades),
    cashBaseline: metric(
      strategyReturns.map(() => 0),
      0,
    ),
    checks: Object.freeze({
      pointInTime: true as const,
      nextBarEntry: true as const,
      sameCostModel: true as const,
      noOrderPlacement: true as const,
    }),
    limitations: Object.freeze([
      "A replay validates mechanics, not future alpha.",
      "Promotion needs real point-in-time data across at least three non-overlapping market regimes.",
      "Paper fills do not prove live liquidity, latency, capacity, or profitability.",
      ...(preCloseExitEnabled
        ? [
            "The pre-close rule accepts only complete calendar-backed sessions and exits before the closing bar.",
            "The Alpaca market-calendar snapshot is fingerprinted into this replay receipt.",
          ]
        : []),
    ]),
    excludedSessions: Object.freeze(excludedSessions.map((session) => Object.freeze(session))),
  };
  return Object.freeze({ ...body, receiptRef: caseflowFingerprint(body) });
}
