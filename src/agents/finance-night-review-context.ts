import fs from "node:fs/promises";
import path from "node:path";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import { readFinanceBarLedger } from "./finance-bar-ledger.js";
import { readFinanceBrokerProfitFeedback } from "./finance-broker-profit-feedback.js";
import { financeEtClock, latestCompletedWeekdaySessionDate } from "./finance-cycle-schedule.js";
import {
  readFinanceIntradayDecisions,
  readFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import {
  projectFinancePositions,
  readFinanceLatestBrokerReconciliations,
  readFinanceBrokerHistoryRecords,
  readFinancePositionLedger,
} from "./finance-position-ledger.js";
import { buildFinanceMonthlyTrendDerivedEvidence } from "./finance-research-evidence.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";

export const FINANCE_NIGHT_REVIEW_CONTEXT_SCHEMA_VERSION =
  "lcx_finance_night_review_context_v1" as const;
export const FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION =
  "lcx_finance_night_research_scope_v1" as const;
export const FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID = "finance-night:research-scope" as const;
export const FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE = "finance-night-research-scope" as const;
export const FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS = 14;

function financeControllerHistoryMonths(
  activeRules: readonly Readonly<{
    body?: unknown;
  }>[],
): number {
  return Math.max(
    12,
    ...activeRules.map((rule) => {
      const frozen =
        rule.body && typeof rule.body === "object" && "frozenRule" in rule.body
          ? rule.body.frozenRule
          : undefined;
      const lookback =
        frozen && typeof frozen === "object" && "lookbackMonths" in frozen
          ? frozen.lookbackMonths
          : undefined;
      return typeof lookback === "number" &&
        Number.isInteger(lookback) &&
        lookback > 0 &&
        lookback <= 120
        ? lookback
        : 0;
    }),
  );
}

export type FinanceNightResearchInstrument = Readonly<{
  instrument: string;
  assetClass: "us_equity" | "crypto";
  reasons: readonly ("held_position" | "active_strategy")[];
}>;

export type FinanceNightResearchScope = Readonly<{
  schemaVersion: typeof FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION;
  asOf: string;
  activeStrategyIds: readonly string[];
  instruments: readonly FinanceNightResearchInstrument[];
  coverage?: Readonly<{
    totalInstrumentCount: number;
    deferredInstruments: readonly FinanceNightResearchInstrument[];
    selectionMethod: "held_priority_et_date_rotation_v1";
  }>;
}>;

export function assertFinanceNightResearchAsOf(asOf: string): void {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs) || asOfMs > Date.now()) {
    throw new Error("night research scope requires a valid non-future asOf");
  }
}

function rotateByEtDate<T>(items: readonly T[], asOf: string, pageSize: number): T[] {
  if (items.length < 2) {
    return [...items];
  }
  const etDate = financeEtClock(new Date(asOf)).date;
  const dateOrdinal = Math.floor(Date.parse(`${etDate}T00:00:00.000Z`) / 86_400_000);
  const offset = (((dateOrdinal * pageSize) % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function financeNightResearchAssetClass(instrument: string): "us_equity" | "crypto" {
  const normalized = instrument.trim().toUpperCase();
  if (/^[A-Z0-9]{2,12}\/USD$/u.test(normalized)) {
    return "crypto";
  }
  if (/^[A-Z]{1,5}(?:\.[A-Z])?$/u.test(normalized)) {
    return "us_equity";
  }
  throw new Error(`night research scope contains unsupported instrument identity: ${instrument}`);
}

function buildFinanceNightResearchScope(params: {
  asOf: string;
  positions: Awaited<ReturnType<typeof readFinancePositionLedger>>["ledger"]["positions"];
  activeRules: readonly Readonly<{ ruleId: string; instruments: readonly string[] }>[];
}): FinanceNightResearchScope {
  assertFinanceNightResearchAsOf(params.asOf);
  const instruments = new Map<
    string,
    {
      instrument: string;
      assetClass: "us_equity" | "crypto";
      reasons: Set<"held_position" | "active_strategy">;
    }
  >();
  const add = (rawInstrument: string, reason: "held_position" | "active_strategy") => {
    const instrument = rawInstrument.trim().toUpperCase();
    const assetClass = financeNightResearchAssetClass(instrument);
    const key = `${assetClass}:${instrument}`;
    const existing = instruments.get(key) ?? { instrument, assetClass, reasons: new Set() };
    existing.reasons.add(reason);
    instruments.set(key, existing);
  };
  for (const position of params.positions) {
    if (position.quantity !== 0) {
      add(position.instrument, "held_position");
    }
  }
  for (const rule of params.activeRules) {
    for (const instrument of rule.instruments) {
      add(instrument, "active_strategy");
    }
  }
  if (instruments.size === 0) {
    throw new Error("night research scope has no held positions or active strategy instruments");
  }
  const allInstruments = [...instruments.values()].map((item) =>
    Object.freeze({
      instrument: item.instrument,
      assetClass: item.assetClass,
      reasons: Object.freeze([...item.reasons].toSorted()),
    }),
  );
  const selected =
    allInstruments.length <= FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS
      ? allInstruments
      : (() => {
          const held = allInstruments.filter((item) => item.reasons.includes("held_position"));
          const activeOnly = allInstruments
            .filter((item) => !item.reasons.includes("held_position"))
            .toSorted((left, right) => left.instrument.localeCompare(right.instrument));
          const heldBudget =
            FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS - (activeOnly.length > 0 ? 1 : 0);
          const heldPageSize = Math.min(held.length, heldBudget);
          const selectedHeld = rotateByEtDate(
            held.toSorted((left, right) => left.instrument.localeCompare(right.instrument)),
            params.asOf,
            heldPageSize,
          ).slice(0, heldPageSize);
          const remaining = FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS - selectedHeld.length;
          const selectedActive = rotateByEtDate(activeOnly, params.asOf, remaining).slice(
            0,
            remaining,
          );
          return [...selectedHeld, ...selectedActive];
        })();
  const selectedKeys = new Set(selected.map((item) => `${item.assetClass}:${item.instrument}`));
  const deferredInstruments = allInstruments.filter(
    (item) => !selectedKeys.has(`${item.assetClass}:${item.instrument}`),
  );
  return Object.freeze({
    schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
    asOf: params.asOf,
    activeStrategyIds: Object.freeze(params.activeRules.map((rule) => rule.ruleId)),
    instruments: Object.freeze(selected),
    ...(deferredInstruments.length > 0
      ? {
          coverage: Object.freeze({
            totalInstrumentCount: allInstruments.length,
            deferredInstruments: Object.freeze(deferredInstruments),
            selectionMethod: "held_priority_et_date_rotation_v1" as const,
          }),
        }
      : {}),
  });
}

function projectFinanceNightPositionsAtAsOf(params: {
  positionRead: Awaited<ReturnType<typeof readFinancePositionLedger>>;
  asOf: string;
}) {
  const cutoff = Date.parse(params.asOf);
  const receipts = params.positionRead.receipts.filter(
    (receipt) =>
      Date.parse(receipt.recordedAt) <= cutoff && Date.parse(receipt.fill.filledAt) <= cutoff,
  );
  return Object.freeze({
    receipts,
    ledger: projectFinancePositions({ receipts, marks: params.positionRead.marks }),
  });
}

/** Rebuild the exact night scope from the current controller ledgers at the supplied cutoff. */
export async function readFinanceNightReviewResearchScope(params: {
  directory: string;
  asOf: string;
}): Promise<FinanceNightResearchScope> {
  const [positions, strategyRules] = await Promise.all([
    readFinancePositionLedger(params.directory, { asOf: params.asOf }),
    readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf }),
  ]);
  const activeRules = strategyRules.ledger.rules
    .filter((rule) => rule.state === "active")
    .map((rule) => ({ ruleId: rule.ruleId, instruments: rule.instruments }));
  const positionsAtAsOf = projectFinanceNightPositionsAtAsOf({
    positionRead: positions,
    asOf: params.asOf,
  });
  return buildFinanceNightResearchScope({
    asOf: params.asOf,
    positions: positionsAtAsOf.ledger.positions,
    activeRules,
  });
}

export type FinanceNightSettlementSummary = Readonly<{
  scoredFiled: Readonly<{ appended: number; skipped: number }>;
  reflection: unknown;
  pending: readonly unknown[];
  declined: readonly unknown[];
  issues: readonly unknown[];
}>;

function compactReceipt(
  receipt: Awaited<ReturnType<typeof readFinancePositionLedger>>["receipts"][number],
) {
  return {
    receiptId: receipt.receiptId,
    intentId: receipt.intentId,
    runAuthorizationId: receipt.runAuthorizationId,
    adapterId: receipt.adapterId,
    adapterKind: receipt.adapterKind,
    venue: receipt.venue,
    instrument: receipt.instrument,
    side: receipt.side,
    quantity: receipt.quantity,
    referencePrice: receipt.referencePrice,
    referencePriceAt: receipt.referencePriceAt,
    recordedAt: receipt.recordedAt,
    fill: receipt.fill ?? null,
    ...(receipt.researchLineage === undefined
      ? {}
      : {
          researchLineageSummary: {
            planReceiptId: receipt.researchLineage.portfolioPlan.provenance?.receiptId ?? null,
            planAsOf: receipt.researchLineage.portfolioPlan.asOf,
            targetWeight: receipt.researchLineage.targetWeight,
            contributions: receipt.researchLineage.contributions.map((contribution) => ({
              strategyId: contribution.strategyId,
              evidenceReceiptId: contribution.evidenceReceiptId,
              stance: contribution.stance,
              accountWeight: contribution.accountWeight,
            })),
          },
        }),
  };
}

/** Read the same controller book used by execution; never infer activation from an ID. */
export async function buildFinanceActiveStrategyResearchEvidence(params: {
  directory: string;
  asOf: string;
  /** When supplied, every requested id must name a rule active at `asOf`. */
  strategyIds?: readonly string[];
  /** Internal calculation projection. The default remains the bounded model-facing summary. */
  historyFormat?: "model_summary" | "daily_calculation";
  /** Internal subset used when hydrating an already supplied controller evidence packet. */
  instrumentIds?: readonly string[];
}): Promise<readonly FinanceCommitteeEvidence[]> {
  const snapshot = await readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf });
  const allActiveRules = snapshot.ledger.rules.filter((rule) => rule.state === "active");
  const requestedIds = params.strategyIds;
  if (requestedIds) {
    const requested = new Set(requestedIds);
    if (requested.size !== requestedIds.length || requestedIds.some((id) => !id.trim())) {
      throw new Error("portfolio activeStrategyIds must be unique nonempty controller rule ids");
    }
    const activeById = new Map(allActiveRules.map((rule) => [rule.ruleId, rule]));
    const unavailable = requestedIds.filter((id) => !activeById.has(id));
    if (unavailable.length > 0) {
      throw new Error(
        `portfolio strategies are not active in the controller ledger at asOf: ${unavailable.join(", ")}`,
      );
    }
  }
  const activeRules = requestedIds
    ? requestedIds.map((id) => allActiveRules.find((rule) => rule.ruleId === id)!)
    : allActiveRules;
  const declaredInstruments = [
    ...new Set(
      activeRules.flatMap((rule) => rule.instruments.map((item) => item.trim().toUpperCase())),
    ),
  ];
  const instruments = params.instrumentIds
    ? [...new Set(params.instrumentIds)]
    : declaredInstruments;
  if (
    params.instrumentIds &&
    instruments.some((instrument) => !declaredInstruments.includes(instrument))
  ) {
    throw new Error("controller history instrument subset is outside the active strategy scope");
  }
  if (requestedIds && instruments.length === 0) {
    throw new Error("controller active strategies declare no research instruments");
  }
  if (instruments.length > 14) {
    throw new Error("active strategy history exceeds controller evidence budget");
  }
  const months = financeControllerHistoryMonths(activeRules);
  const start = new Date(params.asOf);
  // The prior anchor can close before today's day-of-month. Retain its whole
  // calendar month rather than silently dropping a valid 12-month comparison.
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months - 1);
  const fromDate = start.toISOString().slice(0, 10);
  const toDate = latestCompletedWeekdaySessionDate(params.asOf);
  const histories = await Promise.all(
    instruments.map(async (instrument) => {
      const book = await readFinanceBarLedger(params.directory, { instrument, asOf: params.asOf });
      const rawWindow = book.bars.filter((bar) => bar.date >= fromDate && bar.date <= toDate);
      // This is a close-only projection: differing OHLC records with the same close
      // must not manufacture extra return observations. Conflicting closes remain.
      const window = [
        ...new Map(rawWindow.map((bar) => [JSON.stringify([bar.date, bar.close]), bar])).values(),
      ];
      const bars = window.slice(-400);
      const monthEndDates = new Map<string, string>();
      for (const bar of bars) {
        const month = bar.date.slice(0, 7);
        const prior = monthEndDates.get(month);
        if (!prior || bar.date > prior) {
          monthEndDates.set(month, bar.date);
        }
      }
      const monthlyCloseObservations = [...monthEndDates.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([month, sessionDate]) => ({
          month,
          sessionDate,
          closeValues: [
            ...new Set(bars.filter((bar) => bar.date === sessionDate).map((bar) => bar.close)),
          ].toSorted((left, right) => left - right),
        }));
      const divergentDates = book.divergentDates.filter((key) => {
        const date = key.slice(key.lastIndexOf("@") + 1);
        return date >= fromDate && date <= toDate;
      });
      const historyPayload =
        params.historyFormat === "daily_calculation"
          ? {
              instrument,
              headRef: book.headRef,
              fromDate,
              toDate,
              windowBarCount: window.length,
              rawBarCount: rawWindow.length,
              collapsedRepeatedCloses: rawWindow.length - window.length,
              suppliedBarCount: bars.length,
              omittedByLimit: window.length - bars.length,
              divergentDates,
              closes: bars.map((bar) => [bar.date, bar.close]),
              monthlyCloseObservations,
            }
          : {
              instrument,
              headRef: book.headRef,
              fromDate,
              toDate,
              windowBarCount: window.length,
              rawBarCount: rawWindow.length,
              collapsedRepeatedCloses: rawWindow.length - window.length,
              uniqueSessionDates: new Set(window.map((bar) => bar.date)).size,
              suppliedBarCount: bars.length,
              omittedByLimit: window.length - bars.length,
              divergentDates,
              divergentCloseObservations: divergentDates.map((key) => {
                const sessionDate = key.slice(key.lastIndexOf("@") + 1);
                return {
                  sessionDate,
                  closeValues: [
                    ...new Set(
                      window.filter((bar) => bar.date === sessionDate).map((bar) => bar.close),
                    ),
                  ].toSorted((left, right) => left - right),
                };
              }),
              boundary:
                "stored historical observations summarized to the last supplied session per calendar month; conflicts remain explicit; not a daily-volatility input, execution quote or independently verified adjusted total return series",
              columns: ["month", "sessionDate", "closeValues"],
              monthlyCloseObservations,
            };
      const evidence: FinanceCommitteeEvidence = {
        id: `finance-controller:eod:${instrument}`,
        source: "finance-bar-ledger",
        timestamp: params.asOf,
        text: JSON.stringify(historyPayload),
      };
      return {
        evidence,
        // Keep daily rows out of model context while the existing numerical engine
        // still receives its actual inputs. The durable book and headRef retain them.
        calculationInput: {
          ...evidence,
          text: JSON.stringify({
            instrument,
            divergentDates,
            suppliedBarCount: bars.length,
            closes: bars.map((bar) => [bar.date, bar.close]),
          }),
        },
      };
    }),
  );
  const activeStrategyEvidence: FinanceCommitteeEvidence = {
    id: "finance-controller:active-strategies",
    source: "finance-strategy-rule-ledger",
    timestamp: params.asOf,
    text: JSON.stringify({
      boundary:
        "controller state only; activation does not prove readiness, performance or Live authority",
      scope: requestedIds ? "portfolio_allocation_subset" : "all_controller_active_rules",
      allControllerActiveRuleIds: allActiveRules.map((rule) => rule.ruleId),
      ...(requestedIds ? { allocationStrategyIds: requestedIds } : {}),
      ruleScope:
        (requestedIds
          ? "This allocation review does not enumerate every active controller rule. Other active rule IDs above remain outside this portfolio allocation scope; their parameters and readiness require their own controller evidence. "
          : "Review all controller rules active at this asOf. ") +
        "Review these declared rule bodies; generic method-kit examples do not replace the active rule parameters.",
      activeRules: activeRules.map((rule) => ({
        ruleId: rule.ruleId,
        form: rule.form,
        formVersion: rule.formVersion,
        instruments: rule.instruments,
        emits: rule.emits,
        schedule: rule.schedule,
        declaredAt: rule.declaredAt,
        body: rule.body,
        declarationClaimBoundary:
          "body (including openRisks) contains owner claims as of declaredAt; it is not current runtime policy or readiness",
        currentRuntimePolicyAndReadiness: "unknown_without_separately_timestamped_current_evidence",
        activeObservedAt: rule.activeObservedAt,
        provenance: rule.provenance,
      })),
    }),
  };
  return [
    activeStrategyEvidence,
    ...histories.map((history) => history.evidence),
    ...buildFinanceMonthlyTrendDerivedEvidence(
      [activeStrategyEvidence, ...histories.map((history) => history.calculationInput)],
      params.asOf,
    ),
  ];
}

/** Resolve exact active rule instruments together with their controller evidence. */
export async function readFinanceActiveStrategyResearchScope(params: {
  directory: string;
  asOf: string;
  strategyIds: readonly string[];
}): Promise<
  Readonly<{
    instruments: readonly string[];
    intradayInstruments: readonly string[];
    historyMonths: number;
    evidence: readonly FinanceCommitteeEvidence[];
  }>
> {
  const evidence = await buildFinanceActiveStrategyResearchEvidence(params);
  const activeStrategyEvidence = evidence.find(
    (item) => item.id === "finance-controller:active-strategies",
  );
  if (!activeStrategyEvidence) {
    throw new Error("controller active strategy evidence is missing");
  }
  const payload = JSON.parse(activeStrategyEvidence.text) as {
    activeRules?: readonly {
      instruments?: readonly unknown[];
      schedule?: { kind?: unknown };
      body?: unknown;
    }[];
  };
  const normalizeRuleInstruments = (rule: { instruments?: readonly unknown[] }) =>
    (rule.instruments ?? []).flatMap((instrument) =>
      typeof instrument === "string" && instrument.trim() ? [instrument.trim().toUpperCase()] : [],
    );
  const activeRules = payload.activeRules ?? [];
  const instruments = [...new Set(activeRules.flatMap(normalizeRuleInstruments))];
  const intradayInstruments = [
    ...new Set(
      activeRules.flatMap((rule) =>
        rule.schedule?.kind === "intraday" ? normalizeRuleInstruments(rule) : [],
      ),
    ),
  ];
  const historyMonths = financeControllerHistoryMonths(activeRules);
  return Object.freeze({
    instruments: Object.freeze(instruments),
    intradayInstruments: Object.freeze(intradayInstruments),
    historyMonths,
    evidence,
  });
}

type BrokerProfitFeedback = Awaited<ReturnType<typeof readFinanceBrokerProfitFeedback>>;
type BrokerReconciliationRead = Awaited<ReturnType<typeof readFinanceLatestBrokerReconciliations>>;

function projectFinanceBrokerAccountResearchSummary(params: {
  asOf: string;
  brokerProfit: BrokerProfitFeedback;
  brokerReconciliations: BrokerReconciliationRead;
  includeAccountFields?: boolean;
}) {
  return {
    ...(params.includeAccountFields
      ? {
          executionAuthority: "none",
          dataBasis: "canonical_local_broker_reconciliation_snapshots",
          missingFields: params.brokerReconciliations.records.length ? [] : ["positionSnapshots"],
        }
      : {}),
    attributionScope: "account_totals_not_instrument_or_strategy_totals",
    instrumentAttribution:
      "not_provided; do not assign account fill counts or fees to the requested instrument",
    boundary:
      "broker_paper_not_local_simulation; net excludes tax/fx; fill ownership is not strategy PnL",
    positionSnapshots: params.brokerReconciliations.records.map((record) => {
      const snapshot: unknown = record.snapshot;
      const snapshotObject =
        typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
          ? (snapshot as Record<string, unknown>)
          : undefined;
      const observedAt =
        typeof snapshotObject?.observedAt === "string" ? snapshotObject.observedAt : undefined;
      const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
      if (!snapshotObject || !observedAt || !Number.isFinite(observedAtMs)) {
        return {
          accountId: record.accountId,
          venue: record.venue,
          snapshotRef: record.ref,
          freshness: "invalid_timestamp",
          ...(params.includeAccountFields
            ? { missingFields: ["observedAt", "usable_account_snapshot"] }
            : {}),
        };
      }
      if (observedAtMs > Date.parse(params.asOf)) {
        return {
          accountId: record.accountId,
          venue: record.venue,
          snapshotRef: record.ref,
          freshness: "outside_cutoff",
          ...(params.includeAccountFields
            ? { missingFields: ["usable_account_snapshot_at_asOf"] }
            : {}),
        };
      }
      const snapshotPositions = Array.isArray(snapshotObject.positions)
        ? snapshotObject.positions.flatMap((value) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              return [];
            }
            const position = value as Record<string, unknown>;
            const rawQuantity = position.qty;
            const quantity =
              typeof rawQuantity === "number"
                ? rawQuantity
                : typeof rawQuantity === "string" && rawQuantity.trim()
                  ? Number(rawQuantity)
                  : Number.NaN;
            return typeof position.symbol === "string" && Number.isFinite(quantity)
              ? [{ symbol: position.symbol, quantity }]
              : [];
          })
        : [];
      const protection =
        typeof snapshotObject.protection === "object" &&
        snapshotObject.protection !== null &&
        !Array.isArray(snapshotObject.protection)
          ? (snapshotObject.protection as Record<string, unknown>)
          : undefined;
      const rawCash = snapshotObject.brokerCash;
      const cash =
        typeof rawCash === "number"
          ? rawCash
          : typeof rawCash === "string" && rawCash.trim()
            ? Number(rawCash)
            : Number.NaN;
      const missingFields = [
        ...(!Number.isFinite(cash) ? ["brokerCash"] : []),
        // These reconciliation records do not provide account equity or buying power.
        "equity",
        "buyingPower",
        ...(!Array.isArray(snapshotObject.positions) ? ["positions"] : []),
        ...(Array.isArray(snapshotObject.positions) &&
        snapshotPositions.length !== snapshotObject.positions.length
          ? ["positions.invalid_entries"]
          : []),
        ...(!Array.isArray(protection?.coverage) ? ["protectionCoverage"] : []),
      ];
      return {
        accountId: record.accountId,
        venue: record.venue,
        snapshotRef: record.ref,
        observedAt,
        ...(params.includeAccountFields
          ? {
              brokerCash: Number.isFinite(cash) ? cash : null,
              equity: null,
              buyingPower: null,
              missingFields,
            }
          : {}),
        freshness:
          !record.superseded && Date.parse(params.asOf) - observedAtMs <= 300_000
            ? "fresh"
            : "stale",
        positions: snapshotPositions,
        protectionCoverage: Array.isArray(protection?.coverage)
          ? protection.coverage.flatMap((value) => {
              if (typeof value !== "object" || value === null || Array.isArray(value)) {
                return [];
              }
              const item = value as Record<string, unknown>;
              return typeof item.instrument === "string"
                ? [
                    {
                      instrument: item.instrument,
                      positionQuantity: item.positionQuantity,
                      recognizedStopQuantity: item.recognizedStopQuantity,
                      uncoveredQuantity: item.uncoveredQuantity,
                      status: item.status,
                    },
                  ]
                : [];
            })
          : [],
      };
    }),
    omittedPositionSnapshotAccounts: params.brokerReconciliations.omittedAccounts,
    status: params.brokerProfit.status,
    ...(params.brokerProfit.status === "unavailable" ? { reason: params.brokerProfit.reason } : {}),
    accounts:
      "accounts" in params.brokerProfit
        ? params.brokerProfit.accounts?.map((account) => ({
            ...(params.includeAccountFields
              ? {
                  accountId: params.brokerReconciliations.records.find(
                    (record) => record.ref === account.snapshotRef,
                  )?.accountId,
                  venue: params.brokerReconciliations.records.find(
                    (record) => record.ref === account.snapshotRef,
                  )?.venue,
                  snapshotRef: account.snapshotRef,
                }
              : {}),
            status: account.status,
            ...("netMatchedPnl" in account
              ? {
                  netMatchedPnl: account.netMatchedPnl,
                  buyFills: account.buyFills,
                  sellFills: account.sellFills,
                  matchedLotCount: account.matchedLotCount,
                  feeActivityCount: account.feeActivityCount,
                  unallocatedFeeActivityCount: account.unallocatedFeeActivityCount,
                  attributedFillCount: account.strategyAttribution.attributedFillCount,
                  unattributedFillCount: account.strategyAttribution.unattributedFillCount,
                  decisionSourceLineage: account.strategyAttribution.decisionSourceLineage,
                  observedAt: account.observedAt,
                  freshness: account.freshness,
                }
              : {}),
          }))
        : [],
  };
}

/** Local canonical observations only: no broker call, allocation or execution authority. */
export async function buildFinanceBrokerAccountResearchEvidence(params: {
  directory: string;
  asOf: string;
  /** Both fields select one canonical book; omit both for the legacy night aggregate. */
  accountId?: string;
  /** Canonical ledger venue, e.g. alpaca:paper. No alias or Paper/Live fallback is applied. */
  venue?: string;
  /** Callers may retain an existing evidence identity, including the night review identity. */
  evidenceId?: string;
}): Promise<FinanceCommitteeEvidence> {
  if (!Number.isFinite(Date.parse(params.asOf)) || Date.parse(params.asOf) > Date.now()) {
    throw new Error("account research evidence requires a valid non-future asOf");
  }
  const scoped = params.accountId !== undefined || params.venue !== undefined;
  if (scoped && (!params.accountId?.trim() || !params.venue?.trim())) {
    throw new Error("account research evidence requires both accountId and venue");
  }
  const readReconciliations = async (): Promise<BrokerReconciliationRead> => {
    if (!scoped) {
      return readFinanceLatestBrokerReconciliations(params.directory);
    }
    const history = await readFinanceBrokerHistoryRecords(
      params.directory,
      params.accountId ?? "",
      params.venue ?? "",
    );
    const latest = history.records.findLast((record) =>
      record.body.query.startsWith("reconciliation:"),
    );
    return {
      records: latest
        ? [
            {
              ref: latest.ref,
              accountId: latest.body.accountId,
              sequence: latest.sequence,
              venue: latest.body.venue,
              superseded: history.headRef !== latest.ref,
              snapshot: latest.body.payload[0],
            },
          ]
        : [],
      omittedAccounts: 0,
    };
  };
  const [brokerProfit, brokerReconciliations] = await Promise.all([
    readFinanceBrokerProfitFeedback(params.directory, params.asOf),
    readReconciliations(),
  ]);
  const projected = projectFinanceBrokerAccountResearchSummary({
    asOf: params.asOf,
    brokerProfit,
    brokerReconciliations,
    includeAccountFields: true,
  });
  const accountProfit =
    projected.accounts?.filter(
      (account) => account.accountId === params.accountId && account.venue === params.venue,
    ) ?? [];
  const accountSnapshot = projected.positionSnapshots[0];
  const usableCurrentAccountFacts =
    accountSnapshot?.freshness === "fresh" &&
    accountSnapshot.missingFields !== undefined &&
    !accountSnapshot.missingFields.some((field) =>
      ["brokerCash", "positions", "positions.invalid_entries"].includes(field),
    );
  const summary = scoped
    ? {
        ...projected,
        accountScope: { accountId: params.accountId, venue: params.venue },
        currentAccountFactsStatus: usableCurrentAccountFacts ? "observed" : "unknown",
        positionSnapshots: projected.positionSnapshots.map((snapshot) =>
          usableCurrentAccountFacts
            ? snapshot
            : {
                accountId: snapshot.accountId,
                venue: snapshot.venue,
                snapshotRef: snapshot.snapshotRef,
                observedAt: "observedAt" in snapshot ? snapshot.observedAt : undefined,
                freshness: snapshot.freshness,
                missingFields: [...(snapshot.missingFields ?? []), "usable_current_account_facts"],
                brokerCash: null,
                equity: null,
                buyingPower: null,
                positions: null,
                protectionCoverage: null,
              },
        ),
        accounts: accountProfit,
        status: accountProfit.length ? "present" : "unavailable",
        missingFields: [
          ...(projected.missingFields ?? []),
          ...(accountProfit.length ? [] : ["profit_summary_for_account"]),
        ],
      }
    : projected;
  return Object.freeze({
    id: params.evidenceId ?? "finance-controller:broker-account-summary",
    source: "finance-broker-profit-summary",
    timestamp: params.asOf,
    text: JSON.stringify(summary),
  });
}

export async function buildFinanceNightReviewEvidence(params: {
  directory: string;
  asOf: string;
  etDate: string;
  settlement: FinanceNightSettlementSummary;
  /** Include a fail-closed typed scope only for scheduler night research runs. */
  includeResearchScope?: boolean;
}): Promise<readonly FinanceCommitteeEvidence[]> {
  const [positions, strategyRules, decisions, brokerProfit, brokerReconciliations] =
    await Promise.all([
      readFinancePositionLedger(params.directory, { asOf: params.asOf }),
      readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf }),
      readFinanceIntradayDecisions(params.directory, { sessionDate: params.etDate }),
      readFinanceBrokerProfitFeedback(params.directory, params.asOf),
      readFinanceLatestBrokerReconciliations(params.directory),
    ]);
  const outcomes = await Promise.all(
    decisions.map(async (decision) => ({
      signalId: decision.input.signalId,
      instrument: decision.input.instrument,
      action: decision.input.action,
      reason: decision.input.reason,
      referencePrice: decision.input.referencePrice,
      referencePriceAt: decision.input.referencePriceAt,
      outcome: await readFinanceIntradayOutcome(params.directory, decision.input.signalId),
    })),
  );
  const activeRules = strategyRules.ledger.rules
    .filter((rule) => rule.state === "active")
    .map((rule) => ({
      ruleId: rule.ruleId,
      form: rule.form,
      formVersion: rule.formVersion,
      instruments: rule.instruments,
      emits: rule.emits,
      schedule: rule.schedule,
      declaredAt: rule.declaredAt,
      body: rule.body,
      declarationClaimBoundary:
        "body (including openRisks) contains owner claims as of declaredAt; it is not current runtime policy or readiness",
      currentRuntimePolicyAndReadiness: "unknown_without_separately_timestamped_current_evidence",
      activeObservedAt: rule.activeObservedAt,
      provenance: rule.provenance,
    }));
  const positionsAtAsOf = projectFinanceNightPositionsAtAsOf({
    positionRead: positions,
    asOf: params.asOf,
  });
  const researchScope = params.includeResearchScope
    ? buildFinanceNightResearchScope({
        asOf: params.asOf,
        positions: positionsAtAsOf.ledger.positions,
        activeRules,
      })
    : undefined;
  const controllerEodEvidence =
    params.includeResearchScope && activeRules.length > 0
      ? (
          await buildFinanceActiveStrategyResearchEvidence({
            directory: params.directory,
            asOf: params.asOf,
            strategyIds: activeRules.map((rule) => rule.ruleId),
            ...(researchScope
              ? {
                  instrumentIds: researchScope.instruments
                    .filter((item) => item.reasons.includes("active_strategy"))
                    .map((item) => item.instrument),
                }
              : {}),
          })
        ).filter((item) => item.id.startsWith("finance-controller:eod:"))
      : [];
  const asOfMs = Date.parse(params.asOf);
  const dayReceipts = positions.receipts
    .filter(
      (receipt) =>
        Date.parse(receipt.recordedAt) <= asOfMs &&
        Date.parse(receipt.fill.filledAt) <= asOfMs &&
        financeEtClock(new Date(receipt.recordedAt)).date === params.etDate,
    )
    .slice(-100)
    .map(compactReceipt);
  const brokerSummary: FinanceCommitteeEvidence = {
    id: `finance-night:broker-profit:${params.etDate}`,
    source: "finance-broker-profit-summary",
    timestamp: params.asOf,
    text: JSON.stringify(
      projectFinanceBrokerAccountResearchSummary({
        asOf: params.asOf,
        brokerProfit,
        brokerReconciliations,
      }),
    ),
  };
  return Object.freeze([
    Object.freeze({
      id: `finance-night:settlement:${params.etDate}`,
      source: "finance-night-settlement",
      timestamp: params.asOf,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_REVIEW_CONTEXT_SCHEMA_VERSION,
        etDate: params.etDate,
        profitReview: {
          objective:
            "Improve realized profit after costs within the existing strategy and risk budget.",
          questions: [
            "Which executed opportunities made or lost money after costs? Separate gross gains, net gains and unrealized marks.",
            "Were profitable opportunities refused or delayed? Use subsequent market data and the original executable constraints; a refusal alone proves no missed profit.",
            "Did exits truncate winners? Compare the declared exit with a pre-specified alternative over the same horizon, including adverse excursion and costs.",
            "When could holding or adding to a winner improve net returns within the total position loss budget? Do not infer an edge from a recent win alone.",
            "How many average net wins does the largest net loss erase? Report sample size and missing cost or round-trip evidence.",
          ],
          requiredProposalFields: [
            "evidenceIds",
            "hypothesis",
            "validationConditions",
            "riskBudgetImpact",
          ],
          boundaries: [
            "Zero trades is not success; trade count and gross win rate are not profit objectives.",
            "Use actual fills for execution analysis. Reference quotes are not fills; local simulation and broker Paper are separate evidence.",
            "No known costs means net profit is unknown, not zero-cost profit. Per-trade return ratios are not currency PnL.",
            "Missing counterfactual prices or fills must remain unknown; do not invent missed profits or claim an exit was premature.",
            "Propose testable candidates only; this review cannot change execution permissions, stops, leverage or risk budgets.",
          ],
        },
        scoredFiled: params.settlement.scoredFiled,
        reflection: params.settlement.reflection,
        pending: params.settlement.pending,
        declined: params.settlement.declined,
        issues: params.settlement.issues,
      }),
    }),
    Object.freeze(brokerSummary),
    Object.freeze({
      id: `finance-night:portfolio:${params.etDate}`,
      source: "finance-position-ledger",
      timestamp: params.asOf,
      text: JSON.stringify({
        headRef: positions.headRef,
        receiptCount: positionsAtAsOf.receipts.length,
        positions: positionsAtAsOf.ledger.positions,
        positionMeaning: "combined local execution ledger projection, not broker account holdings",
        paperFillCount: positionsAtAsOf.receipts.filter(
          (receipt) => receipt.adapterKind === "paper",
        ).length,
        venueFillCount: positionsAtAsOf.receipts.filter(
          (receipt) => receipt.adapterKind === "venue",
        ).length,
        pnlBasis: "ledger_projection_not_broker_reconciled_net_profit",
        costsReconciled: false,
        brokerProfit,
        realizedPnl: positionsAtAsOf.ledger.realizedPnl,
        unrealizedPnl: positionsAtAsOf.ledger.unrealizedPnl,
        instrumentsWithoutMark: positionsAtAsOf.ledger.instrumentsWithoutMark,
        dayReceipts,
      }),
    }),
    Object.freeze({
      id: `finance-night:rules:${params.etDate}`,
      source: "finance-strategy-rule-ledger",
      timestamp: params.asOf,
      text: JSON.stringify({ headRef: strategyRules.headRef, activeRules }),
    }),
    Object.freeze({
      id: `finance-night:intraday:${params.etDate}`,
      source: "finance-intraday-control-ledger",
      timestamp: params.asOf,
      text: JSON.stringify({ decisions: outcomes }),
    }),
    ...(researchScope
      ? [
          Object.freeze({
            id: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
            source: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
            timestamp: params.asOf,
            text: JSON.stringify(researchScope),
          }),
        ]
      : []),
    ...controllerEodEvidence,
  ]);
}

export async function writeFinanceNightReviewEvidence(
  filename: string,
  evidence: readonly FinanceCommitteeEvidence[],
): Promise<string> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
  return filename;
}
