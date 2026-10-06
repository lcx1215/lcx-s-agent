import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  annualisedVol,
  bindFinanceDailyStrategy,
  FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES,
  financeMonthlyTrendReturn,
} from "./finance-daily-strategy.js";
import {
  FINANCE_LIVE_NOW_MAX_FUTURE_SKEW_MINUTES,
  type FinanceAsOfMode,
} from "./finance-data-gateway.js";
import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
import {
  renderFinanceOptionsEvidence,
  summarizeFinanceOptionsChain,
} from "./finance-options-evidence.js";
import type {
  FinanceResearchBatchEvidencePacket,
  FinanceResearchBatchJob,
} from "./finance-research-batch-runner.js";
import type { ModelCallReceipt } from "./logical-agent-model-router.js";
import { STAGE_BY_AGENT_ID, type QualityHarnessArtifact } from "./quality-harness-contract.js";

type FinanceEvidenceRecord = Record<string, unknown>;

function isEvidenceRecord(value: unknown): value is FinanceEvidenceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function closeHistoryByMonth(
  rows: readonly (readonly [string, number])[],
): readonly { date: string; close: number }[] {
  const byMonth = new Map<string, { date: string; close: number }>();
  for (const [date, close] of rows) {
    const month = date.slice(0, 7);
    const previous = byMonth.get(month);
    if (!previous || date > previous.date) {
      byMonth.set(month, { date, close });
    }
  }
  return [...byMonth.values()].toSorted((left, right) => left.date.localeCompare(right.date));
}

/**
 * Derive citeable observed-close arithmetic from an already captured controller packet.
 * This uses the daytime engine's rule binder and return function, but cannot verify that the
 * stored latest monthly observation was the venue's actual last trading session.
 */
export function buildFinanceMonthlyTrendDerivedEvidence(
  controllerEvidence: readonly FinanceCommitteeEvidence[],
  asOf: string,
): readonly FinanceCommitteeEvidence[] {
  const asOfTime = Date.parse(asOf);
  if (!Number.isFinite(asOfTime) || new Date(asOfTime).toISOString() !== asOf) {
    return [];
  }
  const activeRuleItems = controllerEvidence.filter(
    (item) =>
      item.id === "finance-controller:active-strategies" &&
      item.source === "finance-strategy-rule-ledger",
  );
  if (activeRuleItems.length !== 1 || activeRuleItems[0].timestamp !== asOf) {
    return [];
  }
  let activeRules: unknown[];
  try {
    const parsed: unknown = JSON.parse(activeRuleItems[0].text);
    if (!isEvidenceRecord(parsed) || !Array.isArray(parsed.activeRules)) {
      return [];
    }
    activeRules = parsed.activeRules as unknown[];
  } catch {
    return [];
  }
  const trendRules = activeRules.filter(
    (value): value is FinanceEvidenceRecord =>
      isEvidenceRecord(value) && value.form === "cross_asset_trend",
  );
  if (trendRules.length !== 1) {
    return [];
  }
  const rule = trendRules[0];
  const ruleInstrumentsValue = rule.instruments;
  if (
    typeof rule.ruleId !== "string" ||
    typeof rule.formVersion !== "string" ||
    typeof rule.emits !== "string" ||
    typeof rule.activeObservedAt !== "string" ||
    !Number.isFinite(Date.parse(rule.activeObservedAt)) ||
    Date.parse(rule.activeObservedAt) > asOfTime ||
    !isEvidenceRecord(rule.schedule) ||
    rule.schedule.kind !== "monthly" ||
    rule.schedule.at !== "last_trading_day" ||
    rule.schedule.timezone !== "America/New_York" ||
    !isEvidenceRecord(rule.body) ||
    !Array.isArray(ruleInstrumentsValue) ||
    ruleInstrumentsValue.some((instrument: unknown) => typeof instrument !== "string")
  ) {
    return [];
  }
  const ruleInstruments = ruleInstrumentsValue.filter(
    (instrument: unknown): instrument is string => typeof instrument === "string",
  );
  if (ruleInstruments.length !== ruleInstrumentsValue.length) {
    return [];
  }
  let boundRule: ReturnType<typeof bindFinanceDailyStrategy>;
  try {
    const bound = bindFinanceDailyStrategy([
      {
        ruleId: rule.ruleId,
        form: "cross_asset_trend",
        formVersion: rule.formVersion,
        emits: rule.emits,
        schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
        body: rule.body,
        instruments: ruleInstruments,
        state: "active",
      },
    ]);
    boundRule = bound;
  } catch {
    return [];
  }
  const instruments = [
    ...new Set(boundRule.instruments.map((instrument) => instrument.toUpperCase())),
  ];
  if (instruments.length === 0 || instruments.length !== boundRule.instruments.length) {
    return [];
  }

  const histories = new Map<string, FinanceCommitteeEvidence[]>();
  for (const item of controllerEvidence) {
    if (item.source !== "finance-bar-ledger" || !item.id.startsWith("finance-controller:eod:")) {
      continue;
    }
    const instrument = item.id.slice("finance-controller:eod:".length).toUpperCase();
    const matches = histories.get(instrument) ?? [];
    matches.push(item);
    histories.set(instrument, matches);
  }

  const result: FinanceCommitteeEvidence[] = [];
  for (const instrument of instruments) {
    const matchingItems = histories.get(instrument);
    if (!matchingItems || matchingItems.length !== 1 || matchingItems[0].timestamp !== asOf) {
      continue;
    }
    const historyItem = matchingItems[0];
    let payload: FinanceEvidenceRecord;
    try {
      const parsed: unknown = JSON.parse(historyItem.text);
      if (!isEvidenceRecord(parsed)) {
        continue;
      }
      payload = parsed;
    } catch {
      continue;
    }
    if (
      payload.instrument !== instrument ||
      !Array.isArray(payload.divergentDates) ||
      payload.divergentDates.length > 0 ||
      !Array.isArray(payload.closes) ||
      payload.closes.length < 2 ||
      payload.suppliedBarCount !== payload.closes.length
    ) {
      continue;
    }
    const closeByDate = new Map<string, number>();
    let invalid = false;
    for (const row of payload.closes) {
      if (
        !Array.isArray(row) ||
        row.length !== 2 ||
        !isCalendarDate(row[0]) ||
        typeof row[1] !== "number" ||
        !Number.isFinite(row[1]) ||
        row[1] <= 0 ||
        row[0] >= asOf.slice(0, 10)
      ) {
        invalid = true;
        break;
      }
      const previous = closeByDate.get(row[0]);
      if (previous !== undefined && previous !== row[1]) {
        invalid = true;
        break;
      }
      closeByDate.set(row[0], row[1]);
    }
    if (invalid) {
      continue;
    }
    const rows = [...closeByDate.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    const volatilityRows = rows.slice(-FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES);
    const dailyVolatility =
      volatilityRows.length === FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES
        ? annualisedVol(volatilityRows.map(([, close]) => close))
        : Number.NaN;
    const sourceIds = [activeRuleItems[0].id, historyItem.id];
    if (Number.isFinite(dailyVolatility) && dailyVolatility > 0) {
      result.push({
        id: `finance-derived:annualised-volatility:${encodeURIComponent(boundRule.ruleId)}:${encodeURIComponent(instrument)}`,
        source: "finance-bar-ledger; deterministic daily-return risk-normalisation",
        timestamp: asOf,
        text:
          `Deterministic annualised daily-return volatility for ${instrument}, active rule ${boundRule.ruleId}: ` +
          `annualisedVol=${dailyVolatility.toFixed(8)} (${(dailyVolatility * 100).toFixed(2)}%); ` +
          `method=log(close_t/close_t-1), sample variance (n-1), sqrt(variance*252); ` +
          `${volatilityRows.length} supplied closes and ${volatilityRows.length - 1} daily-return intervals from ${volatilityRows[0]?.[0]} to ${volatilityRows.at(-1)?.[0]}; ` +
          `the value matches the daytime engine calculation over the same latest ${FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES} closes; ` +
          `this is a 252-observation trading window, not a claim about exact calendar-month boundaries; ` +
          `asOf=${asOf}; raw evidence IDs=${sourceIds.join(",")}.`,
      });
    }
    const months = closeHistoryByMonth(rows);
    // Align with the daytime calendar selection: use the latest observed close in a calendar
    // month strictly before asOf's month. This does not verify last-session coverage.
    const asOfMonth = asOf.slice(0, 7);
    const anchor = months.toReversed().find((row) => row.date.slice(0, 7) < asOfMonth);
    if (!anchor) {
      continue;
    }
    const prior = months.find((row) => {
      const target = new Date(`${anchor.date.slice(0, 7)}-01T00:00:00.000Z`);
      target.setUTCMonth(target.getUTCMonth() - boundRule.lookbackMonths);
      return row.date.slice(0, 7) === target.toISOString().slice(0, 7);
    });
    const returnFraction = financeMonthlyTrendReturn(months, anchor, boundRule.lookbackMonths);
    if (
      !prior ||
      returnFraction === undefined ||
      !Number.isFinite(returnFraction) ||
      !Number.isFinite(returnFraction * 100) ||
      prior.date >= anchor.date
    ) {
      continue;
    }
    const changePct = `${returnFraction >= 0 ? "+" : ""}${(returnFraction * 100).toFixed(1)}%`;
    result.push({
      id: `finance-derived:monthly-close-change:${encodeURIComponent(boundRule.ruleId)}:${encodeURIComponent(instrument)}`,
      source: "finance-bar-ledger; deterministic monthly trend arithmetic",
      timestamp: asOf,
      text:
        `Deterministic observed-close price-only arithmetic for ${instrument}, rule context ${boundRule.ruleId}: ` +
        `anchor close ${anchor.close} on ${anchor.date} divided by prior close ${prior.close} on ${prior.date}, ` +
        `formula (anchor/prior - 1) * 100 = ${changePct}; lookback=${boundRule.lookbackMonths} calendar months; ` +
        `asOf=${asOf}; raw evidence IDs=${sourceIds.join(",")}; ` +
        "latest observed close in each calendar month; month-end session coverage is unverified; " +
        "not a validated strategy signal or execution readiness; stored close observations only, " +
        "not dividend-reinvested total return.",
    });
  }
  return Object.freeze(result);
}

/** Instrument citation coverage only; source text is not semantic or truth validation. */
export function financeInstrumentCitationScope(evidence: readonly { id: string; text?: string }[]) {
  return evidence
    .filter((entry) => entry.id.startsWith("finance-model:"))
    .map((entry) => {
      const instrument = decodeURIComponent(entry.id.slice("finance-model:".length));
      const escaped = instrument.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
      return {
        instrument,
        canonicalId: entry.id,
        pattern,
        evidenceIds: evidence
          .filter(
            (candidate) =>
              candidate.id === entry.id ||
              (!candidate.id.startsWith("finance-model:") &&
                // This owner emits account aggregates, even if its context mentions a ticker.
                !candidate.id.startsWith("finance-night:broker-profit:") &&
                typeof candidate.text === "string" &&
                pattern.test(candidate.text)),
          )
          .map((candidate) => candidate.id),
      };
    });
}

/** Broker/filing/controller evidence may cover an instrument without being a price packet. */
export function findUncitedFinanceInstruments(
  evidence: readonly { id: string; text?: string }[],
  claims: QualityHarnessArtifact["claims"],
): readonly string[] {
  const instruments = financeInstrumentCitationScope(evidence);
  const missing: string[] = [];
  for (const claim of claims) {
    if (claim.status !== "supported") {
      continue;
    }
    for (const entry of instruments) {
      if (
        entry.pattern.test(claim.text) &&
        !claim.evidenceIds.some(
          (id) =>
            entry.evidenceIds.includes(id) &&
            (claim.evidenceRelations === undefined ||
              claim.evidenceRelations.some(
                (relation) => relation.evidenceId === id && relation.relation === "supports",
              )),
        )
      ) {
        missing.push(`${claim.id}:${entry.canonicalId}`);
      }
    }
  }
  return missing;
}

/**
 * Rejects narrow scope mismatches that can be identified from structured controller evidence:
 * instrument fill counts sourced from account aggregates, execution claims based on an empty
 * decision log while broker fills remain unattributed, instrument fee-loss causation when cited
 * controller records leave fees unallocated, and multi-rule scope claims that cannot be attributed.
 */
export function findUnsupportedFinanceClaimScope(
  evidence: readonly { id: string; text?: string }[],
  claims: QualityHarnessArtifact["claims"],
  declaredInstruments: readonly string[] = [],
): readonly string[] {
  const instruments = new Map(
    financeInstrumentCitationScope(evidence).map((entry) => [entry.instrument, entry] as const),
  );
  for (const value of declaredInstruments) {
    const instrument = value.trim();
    if (!instrument || instruments.has(instrument)) {
      continue;
    }
    const escaped = instrument.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    instruments.set(instrument, {
      instrument,
      canonicalId: `finance-model:${encodeURIComponent(instrument)}`,
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu"),
      evidenceIds: [],
    });
  }
  const problems = [...findAmbiguousFinanceRuleScopeClaims(evidence, claims)];
  for (const claim of claims) {
    if (claim.status !== "supported") {
      continue;
    }
    const namedInstruments = [...instruments.values()].filter((entry) =>
      entry.pattern.test(claim.text),
    );
    if (namedInstruments.length === 0) {
      continue;
    }
    const cited = evidence.filter((entry) => claim.evidenceIds.includes(entry.id));
    const citedText = cited.map((entry) => entry.text ?? "").join("\n");
    const claimFill = parseInstrumentFillClaim(claim.text);
    const citesAccountAggregate = cited.some(
      (entry) =>
        entry.id.startsWith("finance-night:broker-profit:") &&
        /\b(?:buyFills|sellFills|unattributedFillCount|matchedLots|netMatchedPnl)\b|账户汇总|买入成交数|卖出成交数|未归因成交数/iu.test(
          entry.text ?? "",
        ),
    );
    const hasInstrumentFillBridge =
      claimFill !== undefined &&
      cited.some(
        (entry) =>
          typeof entry.text === "string" &&
          namedInstruments.some(
            (instrument) =>
              structuredInstrumentFillCount(entry.text!, instrument.instrument, claimFill.side) ===
              claimFill.count,
          ),
      );
    if (claimFill !== undefined && citesAccountAggregate && !hasInstrumentFillBridge) {
      for (const entry of namedInstruments) {
        problems.push(
          `${claim.id}:${entry.canonicalId}:instrument_fill_claim_cites_account_aggregate_only`,
        );
      }
      continue;
    }

    if (claimFill === undefined && claimsNoInstrumentExecution(claim.text)) {
      const hasEmptyDecisionLog = cited.some(hasEmptyIntradayDecisionLog);
      const hasUnattributedBrokerFills = cited.some(hasPositiveUnattributedBrokerFills);
      if (hasEmptyDecisionLog && hasUnattributedBrokerFills) {
        for (const instrument of namedInstruments) {
          const scopedFillCounts = cited
            .map((entry) => {
              if (typeof entry.text !== "string") {
                return undefined;
              }
              const buy = structuredInstrumentFillCount(entry.text, instrument.instrument, "buy");
              const sell = structuredInstrumentFillCount(entry.text, instrument.instrument, "sell");
              return buy === undefined && sell === undefined ? undefined : { buy, sell };
            })
            .filter(
              (counts): counts is { buy: number | undefined; sell: number | undefined } =>
                counts !== undefined,
            );
          if (scopedFillCounts.some((counts) => (counts.buy ?? 0) > 0 || (counts.sell ?? 0) > 0)) {
            problems.push(
              `${claim.id}:${instrument.canonicalId}:no_execution_claim_conflicts_with_instrument_fills`,
            );
          } else if (!scopedFillCounts.some((counts) => counts.buy === 0 && counts.sell === 0)) {
            problems.push(
              `${claim.id}:${instrument.canonicalId}:empty_intraday_decisions_do_not_establish_zero_instrument_fills`,
            );
          }
        }
      }
    }

    const hasInstrumentFeeBridge = cited.some(
      (entry) =>
        typeof entry.text === "string" &&
        namedInstruments.some(
          (instrument) =>
            hasStructuredInstrumentRef(entry.text!, instrument.instrument) &&
            /["'](?:feeAmount|fees|costAmount|手续费|费用)["']\s*[:：]/iu.test(entry.text!) &&
            /["'](?:allocated|attributed|已分配|已归因)["']\s*:\s*true/iu.test(entry.text!) &&
            !/unallocated|未分配|未归因/iu.test(entry.text!),
        ),
    );
    const isInstrumentFeeLossCausation =
      /\b(?:fee|fees|cost|costs)\b|手续费|费用|成本/iu.test(claim.text) &&
      /\b(?:caus(?:e|es|ed|ing)|reduc(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|impact(?:s|ed|ing)?)\b|导致|造成|引发|减少|增加|推高|压低|侵蚀/iu.test(
        claim.text,
      ) &&
      /\b(?:loss|losses|net\s+(?:pnl|profit)|profit)\b|亏损|损失|净利润|净收益|利润|盈利/iu.test(
        claim.text,
      ) &&
      /\b(?:unallocated|not\s+reconciled)\b|未分配|未归因|未对账|尚未对账/iu.test(citedText) &&
      !hasInstrumentFeeBridge;
    if (isInstrumentFeeLossCausation) {
      for (const entry of namedInstruments) {
        problems.push(
          `${claim.id}:${entry.canonicalId}:instrument_fee_loss_claim_lacks_attributed_fee_bridge`,
        );
      }
    }
  }
  return problems;
}

/**
 * Provenance labels belong to individual strategy rules. Require a supported claim that discusses
 * scope or return validation to name only one rule when it cites a multi-rule ledger record.
 */
function findAmbiguousFinanceRuleScopeClaims(
  evidence: readonly { id: string; text?: string }[],
  claims: QualityHarnessArtifact["claims"],
): readonly string[] {
  const scopeTerms =
    /\bresearch[_ -]only\b|\bread\s*scope\b|\breturn[ -]+validat(?:ion|ed)\b|仅研究|研究专用|数据范围|收益验证|回报验证/iu;
  const problems: string[] = [];
  for (const claim of claims) {
    if (claim.status !== "supported" || !scopeTerms.test(claim.text)) {
      continue;
    }
    for (const entry of evidence) {
      if (!entry.id.startsWith("finance-night:rules:") || !claim.evidenceIds.includes(entry.id)) {
        continue;
      }
      const referencedRuleIds = new Set(
        financeRuleIds(entry.text).filter((ruleId) => claim.text.includes(ruleId)),
      );
      if (referencedRuleIds.size > 1) {
        problems.push(`${claim.id}:${entry.id}:multi_rule_scope_claim_requires_split`);
      }
    }
  }
  return problems;
}

function financeRuleIds(text: string | undefined): readonly string[] {
  if (typeof text !== "string") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const activeRules = (parsed as Record<string, unknown>).activeRules;
  if (!Array.isArray(activeRules)) {
    return [];
  }
  return activeRules.flatMap((rule) => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      return [];
    }
    const ruleId = (rule as Record<string, unknown>).ruleId;
    return typeof ruleId === "string" && ruleId.length > 0 ? [ruleId] : [];
  });
}

function claimsNoInstrumentExecution(text: string): boolean {
  return (
    /\b(?:no|zero|none)\b[^.!?\n]{0,100}\b(?:trades?|fills?|executions?)\b[^.!?\n]{0,40}\b(?:executed|occurred|recorded|filled)\b/iu.test(
      text,
    ) ||
    /(?:没有|无|零)[^。！？;\n]{0,30}(?:交易|成交|执行)[^。！？;\n]{0,16}(?:执行|发生|记录)/u.test(
      text,
    )
  );
}

function hasEmptyIntradayDecisionLog(entry: { id: string; text?: string }): boolean {
  if (!entry.id.startsWith("finance-night:intraday:") || typeof entry.text !== "string") {
    return false;
  }
  let root: unknown;
  try {
    root = JSON.parse(entry.text) as unknown;
  } catch {
    return false;
  }
  return hasEmptyArrayField(root, "decisions");
}

function hasEmptyArrayField(value: unknown, field: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasEmptyArrayField(item, field));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record[field]) && record[field].length === 0) {
    return true;
  }
  return Object.values(record).some((child) => hasEmptyArrayField(child, field));
}

function hasPositiveUnattributedBrokerFills(entry: { id: string; text?: string }): boolean {
  if (!entry.id.startsWith("finance-night:broker-profit:") || typeof entry.text !== "string") {
    return false;
  }
  try {
    return hasPositiveCountField(JSON.parse(entry.text) as unknown, "unattributedFillCount");
  } catch {
    return /["']?unattributedFillCount["']?\s*[:=]\s*["']?[1-9]\d*/iu.test(entry.text);
  }
}

function hasPositiveCountField(value: unknown, field: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasPositiveCountField(item, field));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const count = parseStructuredCount(record[field]);
  return (
    (count !== undefined && count > 0) ||
    Object.values(record).some((child) => hasPositiveCountField(child, field))
  );
}

function hasStructuredInstrumentRef(text: string, instrument: string): boolean {
  const escaped = instrument.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = `(?:${escaped}|${encodeURIComponent(instrument)})`;
  return new RegExp(
    `(?:["'](?:instrument|symbol|ticker|证券代码|标的)["']\\s*:\\s*["']${value}["'])`,
    "iu",
  ).test(text);
}

function parseInstrumentFillClaim(
  text: string,
): { side: "buy" | "sell"; count: number } | undefined {
  const side = /\b(?:buy|purchase)\s+fills?\b|买入(?:成交|成交笔数|成交记录)/iu.test(text)
    ? "buy"
    : /\b(?:sell|sale)\s+fills?\b|卖出(?:成交|成交笔数|成交记录)/iu.test(text)
      ? "sell"
      : undefined;
  if (side === undefined) {
    return undefined;
  }

  const zero = /\b(?:zero|no|none)\b|零(?:笔|个)?|无(?:任何)?|没有|未有/iu.test(text);
  if (zero) {
    return { side, count: 0 };
  }
  const digit = text.match(/\b(\d+)\b/u)?.[1];
  if (digit !== undefined) {
    return { side, count: Number(digit) };
  }
  const englishNumber = text
    .match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/iu)?.[1]
    ?.toLowerCase();
  const englishCounts: Readonly<Record<string, number>> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  if (englishNumber !== undefined) {
    return { side, count: englishCounts[englishNumber] };
  }
  const chineseNumber = text.match(/[一二三四五六七八九十]+\s*(?:笔|个)?/u)?.[0]?.trim();
  const count = chineseNumber === undefined ? undefined : parseChineseCount(chineseNumber);
  return count === undefined ? undefined : { side, count };
}

function parseChineseCount(value: string): number | undefined {
  const digitValues: Readonly<Record<string, number>> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const text = value.replace(/(?:笔|个)/gu, "");
  if (text === "十") {
    return 10;
  }
  if (text.startsWith("十")) {
    const ones = digitValues[text.slice(1)];
    return ones === undefined ? undefined : 10 + ones;
  }
  if (text.endsWith("十")) {
    const tens = digitValues[text.slice(0, -1)];
    return tens === undefined ? undefined : tens * 10;
  }
  return digitValues[text];
}

function structuredInstrumentFillCount(
  text: string,
  instrument: string,
  side: "buy" | "sell",
): number | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  const countKeys =
    side === "buy"
      ? ["buyFills", "buyFillCount", "买入成交数"]
      : ["sellFills", "sellFillCount", "卖出成交数"];
  const rowKeys = ["fills", "fillRows", "成交记录"];
  const sideKeys = ["side", "orderSide", "direction", "买卖方向"];
  const instrumentKeys = ["instrument", "symbol", "ticker", "证券代码", "标的"];
  const desiredSide = side === "buy" ? /^(?:buy|purchase|买入)$/iu : /^(?:sell|sale|卖出)$/iu;
  const visit = (value: unknown, inheritedScope: boolean): number | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = visit(item, inheritedScope);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    }
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const explicitInstrument = instrumentKeys
      .map((key) => record[key])
      .find((item): item is string => typeof item === "string");
    const scoped =
      inheritedScope ||
      (explicitInstrument !== undefined &&
        normalizeInstrument(explicitInstrument).toLowerCase() === instrument.toLowerCase());
    if (scoped) {
      for (const key of countKeys) {
        const count = parseStructuredCount(record[key]);
        if (count !== undefined) {
          return count;
        }
      }
      for (const key of rowKeys) {
        const rows = record[key];
        if (!Array.isArray(rows) || rows.length === 0) {
          continue;
        }
        let matched = 0;
        for (const row of rows) {
          if (typeof row !== "object" || row === null) {
            continue;
          }
          const fill = row as Record<string, unknown>;
          const rowInstrument = instrumentKeys
            .map((item) => fill[item])
            .find((item): item is string => typeof item === "string");
          if (
            rowInstrument !== undefined &&
            normalizeInstrument(rowInstrument).toLowerCase() !== instrument.toLowerCase()
          ) {
            continue;
          }
          const rowSide = sideKeys
            .map((item) => fill[item])
            .find((item): item is string => typeof item === "string");
          if (rowSide !== undefined && desiredSide.test(rowSide)) {
            matched += 1;
          }
        }
        if (matched > 0) {
          return matched;
        }
      }
    }
    for (const child of Object.values(record)) {
      const result = visit(child, scoped);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  };
  return visit(root, false);
}

function normalizeInstrument(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseStructuredCount(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 0 ? number : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "string" && /^[+-]?\d+(\.\d+)?$/u.test(value.trim())) {
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function macroValue(
  data: Readonly<Record<string, unknown>>,
): { field: string; value: number } | undefined {
  for (const field of ["value", "tot_pub_debt_out_amt", "avg_interest_rate_amt"]) {
    const value = number(data[field]);
    if (value !== undefined) {
      return { field, value };
    }
  }
  return undefined;
}

const MACRO_SERIES_IDENTITY_FIELDS = [
  "seriesId",
  "series_id",
  "series",
  "security_type_desc",
  "security_desc",
  "unit",
  "units",
  "unit_desc",
  "unit_name",
  "unit_description",
  "unit_of_measure",
  "unitOfMeasure",
  "measure",
  "frequency",
  "seasonal_adjustment",
] as const;

function macroSeriesIdentity(data: Readonly<Record<string, unknown>>): string {
  const dimensions = Object.fromEntries(
    MACRO_SERIES_IDENTITY_FIELDS.flatMap((field) => {
      const value = data[field];
      return typeof value === "string" || typeof value === "number" ? [[field, value]] : [];
    }),
  );
  return JSON.stringify(dimensions);
}

function macroObservationDate(record: FinanceMarketCollectionItem): string {
  for (const field of ["date", "observation_date", "observationDate", "record_date", "period"]) {
    const value = record.data[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return record.sourceTimestamp;
}

function summarizeMacroSeries(
  records: readonly FinanceMarketCollectionItem[],
  instrument: string,
  prefix: string,
): string[] {
  const series = new Map<string, FinanceMarketCollectionItem[]>();
  for (const record of records) {
    const key = macroSeriesIdentity(record.data);
    const grouped = series.get(key) ?? [];
    grouped.push(record);
    series.set(key, grouped);
  }

  return [...series.values()].map((observations) => {
    const dimensions = JSON.parse(macroSeriesIdentity(observations[0].data)) as Record<
      string,
      string | number
    >;
    const dimensionNames = Object.keys(dimensions);
    const seriesIdField = dimensionNames.find((field) =>
      ["seriesId", "series_id", "series"].includes(field),
    );
    const identity =
      dimensionNames.length === 0
        ? instrument
        : dimensionNames.length === 1 && seriesIdField
          ? String(dimensions[seriesIdField])
          : JSON.stringify(dimensions);
    const byDate = new Map<string, FinanceMarketCollectionItem[]>();
    for (const observation of observations) {
      const date = macroObservationDate(observation);
      const sameDate = byDate.get(date) ?? [];
      sameDate.push(observation);
      byDate.set(date, sameDate);
    }
    const dates = [...byDate.keys()].toSorted((a, b) => a.localeCompare(b));
    const latestDate = dates.at(-1);
    const previousDate = dates.at(-2);
    const latestRecords = latestDate ? byDate.get(latestDate)! : [];
    const latestValues = [
      ...new Set(latestRecords.map((record) => macroValue(record.data)?.value)),
    ].filter((value): value is number => value !== undefined);
    const previousRecords = previousDate ? byDate.get(previousDate)! : [];
    const previousValues = [
      ...new Set(previousRecords.map((record) => macroValue(record.data)?.value)),
    ].filter((value): value is number => value !== undefined);
    const latestConflict = latestValues.length > 1;
    const previousConflict = previousValues.length > 1;
    const latest = latestRecords[0] ? macroValue(latestRecords[0].data) : undefined;
    const previous = previousRecords[0] ? macroValue(previousRecords[0].data) : undefined;
    const latestPeriod = latestDate ?? "unknown";
    const previousPeriod = previousDate ?? "unknown";
    const conflictFacts = dates.flatMap((date) => {
      const values = [
        ...new Set((byDate.get(date) ?? []).map((record) => macroValue(record.data)?.value)),
      ].filter((value): value is number => value !== undefined);
      return values.length > 1
        ? [`same observation date has conflicting values on ${date}: ${values.join(", ")}`]
        : [];
    });
    const latestText = latestConflict
      ? `latest ${latest?.field ?? "value"}=unavailable (conflict on ${latestDate})`
      : `latest ${latest?.field ?? "value"}=${String(latest?.value ?? "unknown")}`;
    const previousText = previousConflict
      ? `conflict on ${previousDate}: ${previousValues.join(", ")}`
      : `${String(previous?.value ?? "unknown")} (${previousPeriod})`;
    const vintageRecord = latestConflict ? undefined : latestRecords[0];
    const publicationTime = vintageRecord
      ? ["publication_time", "published_at", "release_date"].find(
          (field) => typeof vintageRecord.data[field] === "string",
        )
      : undefined;
    const realtimeStart = vintageRecord?.data.realtime_start;
    const realtimeEnd = vintageRecord?.data.realtime_end;
    return `${prefix}: ${identity}, ${latestText}, observation period=${latestPeriod}; previous=${previousText}. Observation period is not publication time; publication time=${publicationTime ? String(vintageRecord!.data[publicationTime]) : "unverified"}; vintage interval=${typeof realtimeStart === "string" ? realtimeStart : "unverified"}..${typeof realtimeEnd === "string" ? realtimeEnd : "unverified"}. ${conflictFacts.join("; ")}${conflictFacts.length > 0 ? ". " : ""}Historical FRED queries conservatively use the prior UTC day, not intraday release availability. Units and revisions need source review.`;
  });
}
const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * Keep fetched non-price collections visible to the model without allowing one provider payload
 * to consume the whole bounded evidence window. This is a transport summary, not a valuation or
 * signal: the source record and timestamp remain attached so a later module can do the real work.
 */
function compactCollectionValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
  }
  if (depth >= 2) {
    return "[nested value omitted]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactCollectionValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 24)
        .map(([key, item]) => [key, compactCollectionValue(item, depth + 1)]),
    );
  }
  return typeof value === "bigint" || typeof value === "symbol"
    ? String(value)
    : "[unsupported value omitted]";
}

function renderUnmodeledCollectionEvidence(
  job: FinanceResearchBatchJob,
  prefix: string,
  collection: string,
  records: readonly FinanceMarketCollectionItem[],
): string {
  const samples = records.slice(0, 6).map((record) => ({
    itemId: record.itemId,
    providerName: record.providerName,
    sourceTimestamp: record.sourceTimestamp,
    sourceUrlOrArtifact: record.sourceUrlOrArtifact,
    data: compactCollectionValue(record.data),
  }));
  return (
    `${prefix}: ${collection} records=${records.length}; samples=${JSON.stringify(samples)}. ` +
    "Raw collection evidence is source-bound; no derived signal or valuation was inferred here."
  );
}

export function rankFinanceWindowDrawdowns(
  entries: readonly {
    instrument: string;
    from: string;
    to: string;
    maxDrawdownPct: number;
  }[],
) {
  const groups = new Map<string, (typeof entries)[number][]>();
  for (const entry of entries) {
    const key = `${entry.from}..${entry.to}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups].map(([window, values]) => ({
    window,
    ranked: values.toSorted((a, b) => a.maxDrawdownPct - b.maxDrawdownPct),
  }));
}

/** Descriptive arithmetic over one provider and one price definition, never a forecast. */
export function summarizeFinancePriceHistory(
  rows: readonly FinanceMarketCollectionItem[],
  asOf: string,
  options: Readonly<{
    asOfMode?: FinanceAsOfMode;
    futureTimestampLimitMs?: number;
  }> = {},
) {
  const historicalCutoff = options.asOfMode !== "live_now";
  const futureTimestampLimitMs =
    options.futureTimestampLimitMs ??
    (historicalCutoff
      ? Date.parse(asOf)
      : Date.now() + FINANCE_LIVE_NOW_MAX_FUTURE_SKEW_MINUTES * 60_000);
  const series = new Map<string, Map<string, number>>();
  const seriesQuality = new Map<
    string,
    { invalid: number; duplicates: number; conflicts: number }
  >();
  let invalid = 0;
  let duplicates = 0;
  let conflicts = 0;
  for (const row of rows) {
    const close = number(row.data.close ?? row.data.c ?? row.data.price);
    const date =
      typeof row.data.date === "string" ? row.data.date : row.sourceTimestamp.slice(0, 10);
    const dateMs = Date.parse(`${date}T00:00:00.000Z`);
    const dateAfterCutoff = historicalCutoff
      ? date >= asOf.slice(0, 10)
      : !Number.isFinite(dateMs) || dateMs > futureTimestampLimitMs;
    const sourceTimestampMs = Date.parse(row.sourceTimestamp);
    // Feed and adjustment basis are part of identity; do not stitch different definitions.
    const key = JSON.stringify([
      row.providerName,
      row.data.feed ?? "unspecified",
      row.data.adjusted ?? "unspecified",
      row.data.instrumentType ?? "unspecified",
      row.data.unit ?? "unspecified",
    ]);
    const quality = seriesQuality.get(key) ?? { invalid: 0, duplicates: 0, conflicts: 0 };
    seriesQuality.set(key, quality);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      dateAfterCutoff ||
      !Number.isFinite(sourceTimestampMs) ||
      sourceTimestampMs > futureTimestampLimitMs ||
      close === undefined ||
      close <= 0
    ) {
      invalid += 1;
      quality.invalid += 1;
      continue;
    }
    const values = series.get(key) ?? new Map<string, number>();
    if (values.has(date)) {
      duplicates += 1;
      quality.duplicates += 1;
      if (values.get(date) !== close) {
        conflicts += 1;
        quality.conflicts += 1;
      }
    } else {
      values.set(date, close);
    }
    series.set(key, values);
  }
  const summaries = [...series].map(([identity, values]) => {
    const ordered = [...values].toSorted(([a], [b]) => a.localeCompare(b));
    const prices = ordered.map(([, close]) => close);
    const last = prices.at(-1)!;
    let peak = prices[0];
    let drawdown = 0;
    for (const price of prices) {
      peak = Math.max(peak, price);
      drawdown = Math.min(drawdown, price / peak - 1);
    }
    const returns = Object.fromEntries(
      [1, 5, 21, 63, 126].map((period) => [
        period,
        prices.length > period
          ? rounded((last / prices[prices.length - 1 - period] - 1) * 100)
          : null,
      ]),
    );
    const observationWindows = Object.fromEntries(
      [1, 5, 21, 63, 126].map((period) => [
        period,
        prices.length > period
          ? { from: ordered[prices.length - 1 - period][0], to: ordered.at(-1)![0] }
          : null,
      ]),
    );
    const volatilityRows = ordered.slice(-FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES);
    const dailyVolatility =
      invalid === 0 &&
      duplicates === 0 &&
      volatilityRows.length === FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES
        ? annualisedVol(volatilityRows.map(([, close]) => close))
        : Number.NaN;
    return {
      identity: JSON.parse(identity) as string[],
      invalid: seriesQuality.get(identity)?.invalid ?? 0,
      duplicates: seriesQuality.get(identity)?.duplicates ?? 0,
      conflicts: seriesQuality.get(identity)?.conflicts ?? 0,
      orderedCloses: ordered.map(([date, close]) => ({ date, close })),
      observations: prices.length,
      from: ordered[0][0],
      to: ordered.at(-1)![0],
      first: prices[0],
      last,
      priceReturnPct: rounded((last / prices[0] - 1) * 100),
      returnsByObservationPct: returns,
      observationWindows,
      dailyVolatility:
        Number.isFinite(dailyVolatility) && dailyVolatility > 0
          ? {
              annualisedVolatility: dailyVolatility,
              from: volatilityRows[0][0],
              to: volatilityRows.at(-1)![0],
              closeCount: volatilityRows.length,
              returnCount: volatilityRows.length - 1,
            }
          : null,
      maxDrawdownPct: rounded(drawdown * 100),
      currentDrawdownPct: rounded((last / peak - 1) * 100),
    };
  });
  return {
    invalid,
    duplicates,
    conflicts,
    invalidSeries: [...seriesQuality]
      .filter(([, quality]) => quality.invalid > 0)
      .map(([identity, quality]) => ({
        identity: JSON.parse(identity) as string[],
        invalid: quality.invalid,
      })),
    summaries,
    usable: conflicts === 0 && summaries.length > 0,
    basis:
      "price_change_not_dividend_reinvested_total_return; periods_are_observations; gaps_and_source_status_remain_separate",
  };
}

/** Build model-sized facts before prompt clipping, retaining raw job IDs as audit references. */
export function buildFinanceResearchModelEvidence(
  batch: FinanceResearchBatchEvidencePacket,
  options: { includeReviewEvidence?: boolean } = {},
): readonly FinanceCommitteeEvidence[] {
  const futureTimestampLimitMs =
    batch.asOfMode === "live_now"
      ? Date.now() + FINANCE_LIVE_NOW_MAX_FUTURE_SKEW_MINUTES * 60_000
      : Date.parse(batch.asOf);
  const groups = new Map<string, FinanceResearchBatchJob[]>();
  const readyDrawdowns: Parameters<typeof rankFinanceWindowDrawdowns>[0][number][] = [];
  for (const job of batch.jobs) {
    const group = groups.get(job.request.instrument) ?? [];
    group.push(job);
    groups.set(job.request.instrument, group);
  }
  const result: FinanceCommitteeEvidence[] = [
    {
      id: `finance-model-coverage:${batch.correlationId}`,
      source: "finance-research-batch-runner",
      timestamp: batch.asOf,
      text: `Research only. ${
        batch.asOfMode === "live_now"
          ? `Live-now collection-time evidence anchored at asOf=${batch.asOf}; source timestamps may be later than asOf only within the bounded live-now skew.`
          : `Frozen asOf=${batch.asOf}.`
      } ${batch.jobs.length} jobs, ${batch.status}. Status counts: ${JSON.stringify(
        batch.jobs.reduce<Record<string, number>>((counts, job) => {
          counts[job.status] = (counts[job.status] ?? 0) + 1;
          return counts;
        }, {}),
      )}. Facts below are deterministic summaries of ${
        batch.asOfMode === "live_now" ? "collection-time receipts" : "frozen receipts"
      }, not model conclusions. Needs_review values cannot be promoted to verified current evidence. Original receipts remain available by job ID.`,
    },
  ];
  for (const [instrument, jobs] of groups) {
    const facts: string[] = [];
    const modelEvidenceId = `finance-model:${encodeURIComponent(instrument)}`;
    const priceCandidates: {
      job: FinanceResearchBatchJob;
      summary: ReturnType<typeof summarizeFinancePriceHistory>["summaries"][number];
      spotAt: string;
      invalid: number;
      duplicates: number;
    }[] = [];
    const optionCandidates: Array<{
      job: FinanceResearchBatchJob;
      records: readonly FinanceMarketCollectionItem[];
    }> = [];
    for (const job of jobs) {
      if (
        job.status !== "ready" &&
        !(options.includeReviewEvidence && job.status === "needs_review")
      ) {
        continue;
      }
      if (!job.receipt) {
        continue;
      }
      const reviewCaveats =
        job.status === "ready"
          ? ""
          : `; unverified research context only; gaps=${JSON.stringify(job.missingEvidence)}; freshness=${JSON.stringify(job.freshnessWarnings)}; conflicts=${JSON.stringify(job.conflicts)}`;
      const captureBoundary = job.sourceReuse
        ? `stored source snapshot=${job.sourceReuse.snapshotId}; originally capturedAt=${job.sourceReuse.capturedAt}; no new source fetch`
        : batch.asOfMode === "live_now"
          ? "collection-time evidence"
          : "frozen-asOf evidence";
      const prefix = `${job.jobId} (audit receipt ID only; cite this observation as ${modelEvidenceId}; ${job.status}${reviewCaveats}; ${captureBoundary})`;
      if ("records" in job.receipt) {
        const records = job.receipt.records;
        const collection = "collection" in job.request ? job.request.collection : undefined;
        if (collection === "eod_history") {
          const history = summarizeFinancePriceHistory(records, batch.asOf, {
            asOfMode: batch.asOfMode,
            futureTimestampLimitMs,
          });
          if (!history.usable) {
            facts.push(
              `${prefix}: historical values excluded; conflicting dates=${history.conflicts}, invalid=${history.invalid}.`,
            );
            continue;
          }
          for (const summary of history.summaries) {
            priceCandidates.push({
              job,
              summary,
              spotAt: summary.to,
              invalid: history.invalid,
              duplicates: history.duplicates,
            });
          }
        } else if (collection === "options_chain") {
          optionCandidates.push({ job, records });
        } else if (collection === "macro_series") {
          const valid = records
            .filter(
              (r) =>
                macroValue(r.data) !== undefined &&
                Date.parse(r.sourceTimestamp) <= futureTimestampLimitMs,
            )
            .toSorted((a, b) => macroObservationDate(a).localeCompare(macroObservationDate(b)));
          facts.push(...summarizeMacroSeries(valid, instrument, prefix));
        } else if (collection === "news") {
          const eligible = records.filter((r) => {
            const match = r.data.entityMatch;
            return (
              Date.parse(r.sourceTimestamp) <= futureTimestampLimitMs &&
              typeof match === "object" &&
              match !== null &&
              "status" in match &&
              match.status === "matched"
            );
          });
          facts.push(
            `${prefix}: ${records.length} news rows, ${eligible.length} entity-matched headlines. Headline-only, not full-text verification or sentiment. ${eligible
              .slice(0, 2)
              .map(
                (r) =>
                  `${typeof r.data.title === "string" ? r.data.title : typeof r.data.headline === "string" ? r.data.headline : "unknown"} (${r.sourceTimestamp})`,
              )
              .join("; ")}`,
          );
        } else if (collection) {
          // The runner can deliberately fetch these collections for selected modules. They used
          // to disappear here, so the module was "collected" but the committee never saw it.
          facts.push(renderUnmodeledCollectionEvidence(job, prefix, collection, records));
        }
      } else {
        const fields = job.receipt.snapshot?.normalizedFields ?? [];
        if (fields.length) {
          facts.push(
            `${prefix}: quote fields ${JSON.stringify(fields.slice(0, 3).map((f) => ({ name: f.name, value: f.value, sourceTimestamp: f.sourceTimestamp })))}; unresolved provider values=${JSON.stringify(job.receipt.snapshot?.conflicts ?? [])}`,
          );
        }
      }
    }
    // One entire source series per instrument. Tie-breaks prefer consolidated daily closes over IEX.
    const preference = ["yahoo", "massive", "twelve", "binance", "fred", "alpaca"];
    const rank = (provider: string) => {
      const index = preference.findIndex((name) => provider.includes(name));
      return index < 0 ? 99 : index;
    };
    priceCandidates.sort(
      (a, b) =>
        b.summary.to.localeCompare(a.summary.to) ||
        b.summary.observations - a.summary.observations ||
        rank(a.summary.identity[0]) - rank(b.summary.identity[0]),
    );
    const candidate = priceCandidates[0];
    if (candidate) {
      const h = candidate.summary;
      if (candidate.job.status === "ready") {
        readyDrawdowns.push({
          instrument,
          from: h.from,
          to: h.to,
          maxDrawdownPct: h.maxDrawdownPct,
        });
      }
      const window21 = h.observationWindows[21];
      const window63 = h.observationWindows[63];
      const volatility = h.dailyVolatility;
      const volatilityText = volatility
        ? `annualisedDailyVol=${volatility.annualisedVolatility.toFixed(8)}; volatilityWindow=${volatility.closeCount} closes/${volatility.returnCount} returns ${volatility.from}..${volatility.to}; method=log(close_t/close_t-1), sample variance (n-1), sqrt(variance*252)`
        : `annualisedDailyVol=unavailable; requires ${FINANCE_DAILY_VOLATILITY_LOOKBACK_CLOSES} clean unique daily closes; observed=${h.observations}, invalidRows=${candidate.invalid}, duplicateRows=${candidate.duplicates}`;
      facts.unshift(
        `Price (${candidate.job.status}); audit receipt ID only=${candidate.job.jobId}; cite this observation as ${modelEvidenceId}; assetClass=${candidate.job.request.assetClass}, kind=${h.identity[3]}, unit=${h.identity[4]}; ${h.observations} closes ${h.from}..${h.to}, window=${h.priceReturnPct}%, maxDD_entire_window=${h.maxDrawdownPct}%; last21=${h.returnsByObservationPct[21] ?? "unknown"}% (${window21 ? `${window21.from}..${window21.to}` : "insufficient history"}); last63=${h.returnsByObservationPct[63] ?? "unknown"}% (${window63 ? `${window63.from}..${window63.to}` : "insufficient history"}); ${volatilityText}. Price change, not total return; lookbacks are return intervals, not calendar days. Source=${h.identity[0]}; feed=${h.identity[1]}; adjusted=${h.identity[2]}; Coverage=${candidate.job.historyCoverage?.status ?? "unverified"}; ${priceCandidates.length} source series available, not stitched.`,
      );
    }
    for (const option of optionCandidates) {
      if (!candidate) {
        facts.push(
          `Options chain (${option.job.status}); audit receipt ID only; cite this observation as ${modelEvidenceId}; no usable underlying price series was available, so Greeks were not calculated.`,
        );
        continue;
      }
      const summary = summarizeFinanceOptionsChain(option.records, {
        asOf: batch.asOf,
        underlyingSpot: candidate.summary.last,
        underlyingSpotAt: candidate.spotAt,
        futureTimestampLimitMs,
      });
      facts.push(renderFinanceOptionsEvidence(summary, option.job.jobId, modelEvidenceId));
    }
    if (facts.length) {
      result.push({
        id: modelEvidenceId,
        source: "finance-research-batch-runner",
        timestamp: batch.asOf,
        text: `${instrument}\n${facts.join("\n")}`,
      });
    }
  }
  const ranking = rankFinanceWindowDrawdowns(readyDrawdowns)
    .filter((group) => group.ranked.length > 1)
    .map(
      (group) =>
        `Worst drawdown magnitudes, same window ${group.window}: ${group.ranked
          .slice(0, 5)
          .map((entry) => `${entry.instrument} ${entry.maxDrawdownPct}%`)
          .join(", ")}.`,
    )
    .join(" ");
  if (ranking) {
    result[0] = {
      ...result[0],
      text: result[0].text.replace(". Facts below", `. ${ranking} Facts below`),
    };
  }
  return result;
}

// Same fixed model-call vocabulary as the quality harness; unknown codes never become evidence.
const HISTORICAL_QUALITY_FAILURE_REASONS = new Set<NonNullable<ModelCallReceipt["reason"]>>([
  "input_constraint",
  "capability_constraint",
  "role_scope_constraint",
  "model_separation_constraint",
  "model_separation_unproven",
  "model_affinity_constraint",
  "model_affinity_unproven",
  "adapter_input_constraint",
  "output_contract",
  "adapter_error",
  "prompt_input_invalid",
  "prompt_budget_exceeded",
  "output_invalid",
  "output_truncated",
  "process_error",
  "output_limit",
  "runtime_timeout",
  "provider_auth",
  "provider_payment_required",
  "provider_rate_limit",
  "call_budget_exhausted",
  "cancelled",
  "deadline",
]);

function historicalQualityFailure(stage: FinanceEvidenceRecord) {
  const taskId = stage.taskId;
  if (
    typeof taskId !== "string" ||
    !(
      Object.hasOwn(STAGE_BY_AGENT_ID, taskId) ||
      /^evidence_batch_(?:extract_[2-6]|review_[1-6])$/u.test(taskId)
    )
  ) {
    return undefined;
  }
  const sourceCalls = Array.isArray(stage.modelCalls) ? stage.modelCalls : [];
  const calls = sourceCalls
    .filter(isEvidenceRecord)
    .flatMap((call) => {
      if (
        (call.outcome !== "failed" && call.outcome !== "rejected") ||
        (call.taskId !== undefined && call.taskId !== taskId) ||
        typeof call.reason !== "string" ||
        !HISTORICAL_QUALITY_FAILURE_REASONS.has(
          call.reason as NonNullable<ModelCallReceipt["reason"]>,
        ) ||
        typeof call.attempt !== "number" ||
        !Number.isSafeInteger(call.attempt) ||
        call.attempt < 1 ||
        typeof call.adapterInvoked !== "boolean" ||
        typeof call.providerCallObserved !== "boolean"
      ) {
        return [];
      }
      return [
        {
          attempt: call.attempt,
          reason: call.reason,
          outcome: call.outcome,
          adapterInvoked: call.adapterInvoked,
          providerCallObserved: call.providerCallObserved,
        },
      ];
    })
    .slice(0, 2);
  return calls.length
    ? { taskId, status: "failed" as const, calls, omittedCalls: sourceCalls.length - calls.length }
    : undefined;
}

/** Historical workflow diagnostics only; not market facts, readiness or execution authority. */
export function buildFinanceHistoricalResearchFeedback(params: {
  receipt: unknown;
  sourceRef: string;
  sourceSha256: string;
}): Record<string, unknown> {
  const receipt = isEvidenceRecord(params.receipt) ? params.receipt : {};
  const execution = isEvidenceRecord(receipt.moduleExecution) ? receipt.moduleExecution : {};
  const feedback = isEvidenceRecord(execution.replanFeedback) ? execution.replanFeedback : {};
  const nodes = Array.isArray(execution.nodes)
    ? execution.nodes.filter(isEvidenceRecord).filter((node) => node.status !== "succeeded")
    : [];
  const gates = Array.isArray(receipt.gates)
    ? receipt.gates.filter(isEvidenceRecord).filter((gate) => gate.passed === false)
    : [];
  const text = (value: unknown) =>
    typeof value === "string"
      ? value.length > 120
        ? `${value.slice(0, 96)} [truncated]`
        : value
      : "unknown";
  const failures = nodes.slice(0, 4).map((node) => {
    const missing = Array.isArray(node.missingEvidence)
      ? node.missingEvidence.filter((value): value is string => typeof value === "string")
      : [];
    return {
      nodeId: text(node.nodeId),
      moduleId: text(node.moduleId),
      status: text(node.status),
      missingEvidence: missing.filter((item) => Buffer.byteLength(item, "utf8") <= 120).slice(0, 4),
      omittedMissingEvidence:
        missing.length -
        missing.filter((item) => Buffer.byteLength(item, "utf8") <= 120).slice(0, 4).length,
    };
  });
  const gaps = Array.isArray(receipt.missingEvidence)
    ? receipt.missingEvidence.filter((value): value is string => typeof value === "string")
    : [];
  const quality = isEvidenceRecord(receipt.quality) ? receipt.quality : {};
  const attempts = Array.isArray(quality.attempts) ? quality.attempts.filter(isEvidenceRecord) : [];
  const lastAttempt = attempts.at(-1);
  const qualityFeedback =
    gates.some((gate) => gate.id === "quality") && Array.isArray(lastAttempt?.feedback)
      ? lastAttempt.feedback.filter((value): value is string => typeof value === "string")
      : [];
  const failedQualityStages =
    gates.some((gate) => gate.id === "quality") && Array.isArray(lastAttempt?.stages)
      ? lastAttempt.stages.filter(isEvidenceRecord).filter((stage) => stage.status === "failed")
      : [];
  const qualityFailures = failedQualityStages
    .flatMap((stage) => {
      const failure = historicalQualityFailure(stage);
      return failure ? [failure] : [];
    })
    .slice(0, 2);
  const actionableSourceGaps = receipt.status === "needs_review" || receipt.status === "blocked";
  const result = {
    status:
      failures.length || gates.length || (actionableSourceGaps && gaps.length)
        ? "present"
        : "no_gap",
    boundary:
      "historical_research_diagnostic_not_current_market_fact_readiness_profit_quote_or_authority",
    guidance:
      "Consume only decision-dependent gaps in the existing research plan. Preserve actual module status; successful modules do not become failed because quality failed. Hard failures and all current evidence/execution gates remain strict. No extra retry, model budget, activation or order authority.",
    sourceRef: params.sourceRef,
    sourceSha256: params.sourceSha256,
    sourceAsOf: isEvidenceRecord(receipt.plan) ? receipt.plan.asOf : null,
    replanStatus: [
      "not_requested",
      "completed",
      "replan_soft",
      "blocked_hard",
      "soft_replan_budget_exhausted",
    ].includes(typeof feedback.status === "string" ? feedback.status : "")
      ? feedback.status
      : "unknown",
    nextAction: ["none", "revise_soft_modules", "stop"].includes(
      typeof feedback.nextAction === "string" ? feedback.nextAction : "",
    )
      ? feedback.nextAction
      : "unknown",
    remainingSoftReplans:
      typeof feedback.remainingSoftReplans === "number" &&
      Number.isSafeInteger(feedback.remainingSoftReplans) &&
      feedback.remainingSoftReplans >= 0 &&
      feedback.remainingSoftReplans <= 2
        ? feedback.remainingSoftReplans
        : 0,
    failures,
    omittedFailures: Math.max(0, nodes.length - failures.length),
    failedGates: gates
      .slice(0, 4)
      .map((gate) => ({ id: text(gate.id), reason: text(gate.reason) })),
    omittedFailedGates: Math.max(0, gates.length - 4),
    qualityFeedback: qualityFeedback.slice(0, 4).map(text),
    omittedQualityFeedback: Math.max(0, qualityFeedback.length - 4),
    ...(qualityFailures.length
      ? {
          qualityFailures,
          omittedQualityFailures: Math.max(0, failedQualityStages.length - qualityFailures.length),
        }
      : {}),
    sourceGaps: gaps.filter((item) => Buffer.byteLength(item, "utf8") <= 120).slice(0, 4),
    omittedSourceGaps:
      gaps.length -
      gaps.filter((item) => Buffer.byteLength(item, "utf8") <= 120).slice(0, 4).length,
  };
  // Remove whole details with explicit counts; never cut a serialized target or hide truncation.
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 2048) {
    if (result.sourceGaps.length) {
      result.sourceGaps.pop();
      result.omittedSourceGaps += 1;
    } else if (result.failures.length > 1) {
      result.failures.pop();
      result.omittedFailures += 1;
    } else if (result.qualityFeedback.length > (qualityFailures.length ? 0 : 1)) {
      result.qualityFeedback.pop();
      result.omittedQualityFeedback += 1;
    } else if (result.failedGates.length > 1) {
      result.failedGates.pop();
      result.omittedFailedGates += 1;
    } else if (result.qualityFailures && result.qualityFailures.length > 1) {
      result.qualityFailures.pop();
      result.omittedQualityFailures = (result.omittedQualityFailures ?? 0) + 1;
    } else if (
      result.qualityFailures?.[0]?.calls.length &&
      result.qualityFailures[0].calls.length > 1
    ) {
      result.qualityFailures[0].calls.pop();
      result.qualityFailures[0].omittedCalls += 1;
    } else {
      return {
        status: "omitted",
        reason: "historical_feedback_header_or_primary_gap_exceeds_budget",
        boundary: result.boundary,
      };
    }
  }
  return result;
}
