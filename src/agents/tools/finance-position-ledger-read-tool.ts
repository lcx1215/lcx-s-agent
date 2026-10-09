import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { readFinanceAccountTradingBook } from "../finance-account-trading-book.js";
import { readFinanceBrokerHistory } from "../finance-alpaca-history-sync.js";
import {
  buildFinanceBehaviourProfile,
  parseFinanceBehaviourThresholds,
  type FinanceBehaviourThresholds,
} from "../finance-behaviour-profile.js";
import { caseflowFingerprint } from "../finance-caseflow.js";
import { buildFinanceEquityCurve } from "../finance-equity-curve.js";
import type { FinanceExecutionReceipt } from "../finance-execution-adapter.js";
import {
  readFinancePositionLedger,
  readFinancePositionRecords,
  type FinancePositionMark,
} from "../finance-position-ledger.js";
import { readFinancePositionManagementFeedback } from "../finance-position-management-feedback.js";
import {
  financeBehaviourThresholdsPath,
  resolveFinancePositionLedgerLocation,
} from "../finance-state-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { calculateMaxDrawdown } from "./quant-math-tool.js";

export const FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION =
  "lcx_finance_position_ledger_read_v2" as const;

function decisionLinkCoverage(receipts: readonly FinanceExecutionReceipt[]) {
  const sourceCounts = new Map<string, number>();
  for (const receipt of receipts) {
    const source = receipt.decisionRef?.source;
    if (source !== undefined) {
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }
  }
  const explicitSourceLinkCount = receipts.filter(
    (receipt) => receipt.decisionRef !== undefined,
  ).length;
  const unlinkedReceiptCount = receipts.filter(
    (receipt) => receipt.decisionRef === undefined,
  ).length;

  return Object.freeze({
    executionReceiptCount: receipts.length,
    explicitSourceLinkCount,
    unlinkedReceiptCount,
    bySource: Object.freeze(Object.fromEntries(sourceCounts)),
    strategyAttribution: "incomplete" as const,
  });
}

function grossPerformanceDiagnostic(params: {
  curve: ReturnType<typeof buildFinanceEquityCurve>;
  receipts: readonly FinanceExecutionReceipt[];
}) {
  const { curve } = params;
  const links = decisionLinkCoverage(params.receipts);
  const completeMarkCoverage =
    curve.undefinedEquityAt.length === 0 && curve.receiptsAfterLastMark === 0;
  const grossPnlAtLastDefinedMark =
    curve.finalEquity === null
      ? null
      : Number((curve.finalEquity - curve.initialCapital).toFixed(6));
  const grossReturnPctAtLastDefinedMark =
    curve.finalEquity === null
      ? null
      : Number(
          (((curve.finalEquity - curve.initialCapital) / curve.initialCapital) * 100).toFixed(6),
        );
  const observedMaxDrawdown =
    curve.levels.length < 2 ? null : calculateMaxDrawdown([...curve.levels], "levels").maxDrawdown;

  return Object.freeze({
    boundary: "gross_marked_ledger_diagnostic_only" as const,
    status:
      params.receipts.length === 0
        ? ("no_execution_history" as const)
        : curve.levels.length < 2
          ? ("insufficient_mark_history" as const)
          : completeMarkCoverage
            ? ("gross_observation_only" as const)
            : ("partial_gross_observation" as const),
    pnlBasis: curve.pnlBasis,
    executionReceiptCount: params.receipts.length,
    decisionLinkCoverage: links,
    grossPnlAtLastDefinedMark,
    grossReturnPctAtLastDefinedMark,
    observedMaxDrawdown,
    netProfitability: "not_proven" as const,
    executionThresholdPromotionEligible: false,
    blockers: Object.freeze([
      "execution receipts do not record transaction fees or commissions",
      "the position projection does not include account cash flows, dividends, borrow, or financing costs",
      ...(links.unlinkedReceiptCount > 0
        ? [
            `${links.unlinkedReceiptCount} execution receipt(s) have no durable source-decision reference`,
          ]
        : []),
      "source-decision references do not yet identify a stable strategy, strategy version, trial, or forecast cohort",
      "no aligned benchmark series was supplied",
    ]),
  });
}

function brokerTradeEconomicsDiagnostic(
  book: Awaited<ReturnType<typeof readFinanceAccountTradingBook>>,
) {
  const { brokerHistory } = book;
  const links = decisionLinkCoverage(book.execution.receipts);
  const unsupportedFeeCount = brokerHistory.fees.filter((fee) => {
    if (fee.currency === "USD") {
      return false;
    }
    const baseAsset = fee.instrument?.split("/")[0];
    return baseAsset === undefined || fee.currency !== baseAsset;
  }).length;
  const feeCoverageComplete =
    brokerHistory.historyStatus === "reconciled" &&
    brokerHistory.feesInterpreted &&
    brokerHistory.unappliedFeeCount === 0 &&
    brokerHistory.baselineAppliedFeeCount === 0 &&
    unsupportedFeeCount === 0;
  const hasTradeHistory = brokerHistory.brokerFillCount > 0;
  const realizedTradePnlAfterFees =
    feeCoverageComplete && hasTradeHistory
      ? Number(
          brokerHistory.positions
            .reduce((total, position) => total + position.realizedPnl, 0)
            .toFixed(6),
        )
      : null;
  const status =
    brokerHistory.historyStatus === "missing"
      ? "no_broker_history"
      : !feeCoverageComplete
        ? "incomplete_cost_coverage"
        : !hasTradeHistory
          ? "no_trade_history"
          : "realized_trade_pnl_after_fees";
  const blockers = [
    ...(brokerHistory.historyStatus !== "reconciled"
      ? ["complete broker fills and fee reconciliation are not available"]
      : []),
    ...(unsupportedFeeCount > 0
      ? [`${unsupportedFeeCount} fee(s) use currencies the trade projection cannot value`]
      : []),
    ...(brokerHistory.baselineAppliedFeeCount > 0
      ? ["some asset fees are applied to account quantity without order-level attribution"]
      : []),
    ...(links.unlinkedReceiptCount > 0
      ? [
          `${links.unlinkedReceiptCount} execution receipt(s) have no durable source-decision reference`,
        ]
      : []),
    "source-decision references do not yet identify a stable strategy, strategy version, trial, or forecast cohort",
    "this projection does not include current open-position marks or full account equity",
    "dividends, other corporate actions, borrow, financing, and an aligned benchmark are not included",
  ];

  return Object.freeze({
    status,
    pnlBasis: "broker_fills_after_supported_fees_only" as const,
    historyStatus: brokerHistory.historyStatus,
    positionsReconciled: brokerHistory.positionsReconciled,
    positionBaselineUsable: brokerHistory.positionBaselineUsable,
    brokerFillCount: brokerHistory.brokerFillCount,
    matchedReceiptCount: brokerHistory.matchedReceiptCount,
    unmatchedFillCount: brokerHistory.unmatchedFillCount,
    decisionLinkCoverage: links,
    brokerFeeCount: brokerHistory.brokerFeeCount,
    feeCoverageComplete,
    unsupportedFeeCount,
    feeTotals: brokerHistory.feeTotals,
    realizedTradePnlAfterFees,
    netProfitability: "not_proven" as const,
    executionThresholdPromotionEligible: false,
    blockers: Object.freeze(blockers),
    warnings: book.warnings,
  });
}

const FinancePositionLedgerReadSchema = Type.Object({
  directory: Type.Optional(
    Type.String({
      description:
        "Ledger directory to read. Defaults to LCX_FINANCE_STATE_DIR, then <workspace>/state/finance.",
    }),
  ),
  asOf: Type.Optional(
    Type.String({
      description:
        "ISO datetime for a point-in-time view. Only marks at or before this instant are used.",
    }),
  ),
  brokerAccountId: Type.Optional(
    Type.String({
      description:
        "Optional explicit Alpaca paper account id. Reads reconstructed broker history and brokerSnapshot: latest retained native positions and stop coverage with source time/ref, freshness and explicit omissions. This is a stored snapshot, not a fresh network request; it does not read credentials.",
    }),
  ),
  initialCapital: Type.Optional(
    Type.Number({
      description:
        "Positive starting capital. Supplying it adds the equity-curve projection; without it no curve is produced and no return figure is invented.",
    }),
  ),
  includeCurveLevels: Type.Optional(
    Type.Boolean({
      description: "Include the full equity level series instead of only its summary.",
    }),
  ),
  includeBehaviour: Type.Optional(
    Type.Boolean({
      description:
        "Include the behaviour profile of the recorded fills (disposition effect, turnover, momentum chasing, anchoring). Measured numbers are always reported; a dimension carries a label only when the owner has declared that dimension's threshold in the ledger's behaviour-thresholds.json. Descriptive observations, never advice.",
    }),
  ),
  historyKind: Type.Optional(
    Type.Union([
      Type.Literal("receipt"),
      Type.Literal("order"),
      Type.Literal("fill"),
      Type.Literal("fee"),
    ]),
  ),
  historyAccountId: Type.Optional(
    Type.String({ description: "Required with historyKind; exact account scope." }),
  ),
  historyVenue: Type.Optional(
    Type.String({
      description: "Required with historyKind; receipt venue or alpaca:paper for broker facts.",
    }),
  ),
  historyInstrument: Type.Optional(
    Type.String({ description: "Optional exact instrument filter." }),
  ),
  historyFrom: Type.Optional(
    Type.String({ description: "Optional inclusive ISO datetime lower bound." }),
  ),
  historyThrough: Type.Optional(
    Type.String({ description: "Optional inclusive ISO datetime upper bound." }),
  ),
  historyLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  historyCursor: Type.Optional(
    Type.String({
      description: "Opaque next-page cursor bound to scope, filters, and current book head.",
    }),
  ),
});

const receiptHistoryHash = (value: string) => createHash("sha256").update(value).digest("hex");
const FINANCE_HISTORY_PAGE_MAX_BYTES = 3_000;
const isIsoDateTime = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
  Number.isFinite(Date.parse(value));

function receiptHistoryPage(params: {
  records: Awaited<ReturnType<typeof readFinancePositionRecords>>["records"];
  headRef: string | null;
  kind: "receipt";
  accountId: string;
  venue: string;
  instrument?: string;
  from?: string;
  through?: string;
  limit: number;
  cursor?: string;
}) {
  const scope = receiptHistoryHash(
    JSON.stringify([
      params.accountId,
      params.kind,
      params.venue,
      params.instrument ?? null,
      params.from ?? null,
      params.through ?? null,
    ]),
  );
  let afterRef: string | null = null;
  if (params.cursor !== undefined) {
    try {
      const decoded = JSON.parse(
        Buffer.from(params.cursor, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (
        decoded.v !== 1 ||
        decoded.scope !== scope ||
        typeof decoded.headRef !== "string" ||
        decoded.headRef !== params.headRef ||
        typeof decoded.afterRef !== "string"
      ) {
        return {
          status: "stale_cursor" as const,
          items: [],
          nextCursor: null,
          headRef: params.headRef,
        };
      }
      afterRef = decoded.afterRef;
    } catch {
      return {
        status: "invalid_cursor" as const,
        items: [],
        nextCursor: null,
        headRef: params.headRef,
      };
    }
  }
  const rows = params.records.filter((record) => {
    if (record.body.kind !== "receipt") {
      return false;
    }
    const receipt = record.body.receipt;
    const at = Date.parse(receipt.recordedAt);
    return (
      (receipt.accountId ?? "") === params.accountId &&
      receipt.venue === params.venue &&
      (params.instrument === undefined || receipt.instrument === params.instrument) &&
      (params.from === undefined || at >= Date.parse(params.from)) &&
      (params.through === undefined || at <= Date.parse(params.through))
    );
  });
  const start = afterRef === null ? 0 : rows.findIndex((row) => row.ref === afterRef) + 1;
  if (afterRef !== null && start === 0) {
    return {
      status: "cursor_scope_mismatch" as const,
      items: [],
      nextCursor: null,
      headRef: params.headRef,
    };
  }
  const page: (typeof rows)[number][] = [];
  for (const row of rows.slice(start, start + params.limit)) {
    if (Buffer.byteLength(JSON.stringify([...page, row])) > FINANCE_HISTORY_PAGE_MAX_BYTES) {
      break;
    }
    page.push(row);
  }
  if (page.length === 0 && start < rows.length) {
    return {
      status: "item_too_large" as const,
      kind: "receipt" as const,
      accountId: params.accountId,
      venue: params.venue,
      items: [],
      nextCursor: null,
      headRef: params.headRef,
      omittedRef: rows[start]?.ref ?? null,
    };
  }
  const hasMore = start + page.length < rows.length;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({ v: 1, scope, headRef: params.headRef, afterRef: last.ref }),
        ).toString("base64url")
      : null;
  return {
    status: "available" as const,
    kind: "receipt" as const,
    accountId: params.accountId,
    venue: params.venue,
    headRef: params.headRef,
    items: page
      .map(({ sequence, ref, body }) =>
        body.kind === "receipt" ? { sequence, ref, ...body.receipt } : null,
      )
      .filter(Boolean),
    nextCursor,
  };
}

function brokerHistoryPage<
  T extends { sourceFactRef: string; instrument?: string; occurredAt: string },
>(params: {
  rows: readonly T[];
  sourceStatus: "missing" | "incomplete" | "reconciled" | "raw_observations_only";
  headRef: string | null;
  kind: "order" | "fill" | "fee";
  accountId: string;
  venue: string;
  instrument?: string;
  from?: string;
  through?: string;
  limit: number;
  cursor?: string;
}) {
  const scope = receiptHistoryHash(
    JSON.stringify([
      params.kind,
      params.accountId,
      params.venue,
      params.instrument ?? null,
      params.from ?? null,
      params.through ?? null,
    ]),
  );
  let afterRef: string | null = null;
  if (params.cursor !== undefined) {
    try {
      const decoded = JSON.parse(
        Buffer.from(params.cursor, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (
        decoded.v !== 1 ||
        decoded.scope !== scope ||
        typeof decoded.headRef !== "string" ||
        decoded.headRef !== params.headRef ||
        typeof decoded.afterRef !== "string"
      ) {
        return {
          status: "stale_cursor" as const,
          items: [],
          nextCursor: null,
          headRef: params.headRef,
        };
      }
      afterRef = decoded.afterRef;
    } catch {
      return {
        status: "invalid_cursor" as const,
        items: [],
        nextCursor: null,
        headRef: params.headRef,
      };
    }
  }
  const rows = params.rows.filter(
    (row) =>
      (params.instrument === undefined || row.instrument === params.instrument) &&
      (params.from === undefined || Date.parse(row.occurredAt) >= Date.parse(params.from)) &&
      (params.through === undefined || Date.parse(row.occurredAt) <= Date.parse(params.through)),
  );
  const start = afterRef === null ? 0 : rows.findIndex((row) => row.sourceFactRef === afterRef) + 1;
  if (afterRef !== null && start === 0) {
    return {
      status: "cursor_scope_mismatch" as const,
      items: [],
      nextCursor: null,
      headRef: params.headRef,
    };
  }
  const items: T[] = [];
  for (const row of rows.slice(start, start + params.limit)) {
    if (Buffer.byteLength(JSON.stringify([...items, row])) > FINANCE_HISTORY_PAGE_MAX_BYTES) {
      break;
    }
    items.push(row);
  }
  if (items.length === 0 && start < rows.length) {
    return {
      status: "item_too_large" as const,
      kind: params.kind,
      accountId: params.accountId,
      venue: params.venue,
      items: [],
      nextCursor: null,
      headRef: params.headRef,
      omittedRef: rows[start]?.sourceFactRef ?? null,
    };
  }
  const last = items.at(-1);
  const nextCursor =
    start + items.length < rows.length && last
      ? Buffer.from(
          JSON.stringify({ v: 1, scope, headRef: params.headRef, afterRef: last.sourceFactRef }),
        ).toString("base64url")
      : null;
  return {
    status:
      params.sourceStatus === "missing"
        ? ("unavailable" as const)
        : params.sourceStatus === "incomplete"
          ? ("partial" as const)
          : params.sourceStatus === "raw_observations_only"
            ? ("raw_observations_only" as const)
            : ("available" as const),
    sourceStatus: params.sourceStatus,
    kind: params.kind,
    accountId: params.accountId,
    venue: params.venue,
    headRef: params.headRef,
    items,
    nextCursor,
  };
}

function projectBrokerOrderFacts(
  facts: readonly { stream: string; fact: Record<string, unknown> }[],
) {
  let omittedCount = 0;
  const rows = facts.flatMap(({ stream, fact }) => {
    if (stream !== "orders") {
      return [];
    }
    const occurredAt = [fact.updated_at, fact.created_at, fact.submitted_at].find(
      (value): value is string => typeof value === "string" && isIsoDateTime(value),
    );
    if (!occurredAt || typeof fact.id !== "string" || !fact.id.trim()) {
      omittedCount += 1;
      return [];
    }
    const projected: Record<string, unknown> = {
      sourceFactRef: caseflowFingerprint(fact),
      occurredAt,
      projection: "safe_order_field_allowlist",
    };
    const omittedFields = ["unallowlisted_broker_fields"];
    const addText = (key: string, source: string, maximum: number) => {
      const value = fact[source];
      if (typeof value === "string" && value.length > 0 && value.length <= maximum) {
        projected[key] = value;
      } else if (value !== undefined) {
        omittedFields.push(key);
      }
    };
    const addNumber = (key: string, source: string) => {
      const value = fact[source];
      const numeric =
        typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
      if (Number.isFinite(numeric) && numeric >= 0) {
        projected[key] = numeric;
      } else if (value !== undefined) {
        omittedFields.push(key);
      }
    };
    addText("orderId", "id", 128);
    addText("clientOrderId", "client_order_id", 128);
    addText("instrument", "symbol", 32);
    if (fact.side === "buy" || fact.side === "sell") {
      projected.side = fact.side;
    } else if (fact.side !== undefined) {
      omittedFields.push("side");
    }
    addText("status", "status", 64);
    addNumber("quantity", "qty");
    addNumber("filledQuantity", "filled_qty");
    addNumber("limitPrice", "limit_price");
    addNumber("stopPrice", "stop_price");
    addText("createdAt", "created_at", 64);
    addText("updatedAt", "updated_at", 64);
    projected.omittedFields = omittedFields;
    return [
      projected as typeof projected & {
        sourceFactRef: string;
        instrument?: string;
        occurredAt: string;
      },
    ];
  });
  return { rows, omittedCount };
}

/**
 * Build the behaviour section of a ledger read.
 *
 * A declaration that exists but does not parse is **reported, not thrown**. The positions are
 * still the answer to the question that was asked, and a broken declaration is not a reason to
 * make the book unreadable. The validation rules come from `parseFinanceBehaviourThresholds`, so
 * this tool and the operator entry cannot come to disagree about what a valid declaration is —
 * only their failure behaviour differs.
 *
 * The profile is built over the stream the ledger projection actually consumed, so a label can
 * never describe different fills than the positions printed beside it.
 */
async function readBehaviourSection(params: {
  directory: string;
  receipts: readonly FinanceExecutionReceipt[];
  marks: readonly FinancePositionMark[];
}) {
  const thresholdsFile = financeBehaviourThresholdsPath(params.directory);
  let raw: string | null = null;
  try {
    raw = await fs.readFile(thresholdsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  let declared: FinanceBehaviourThresholds | null = null;
  let thresholdsError: string | null = null;
  if (raw !== null) {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      thresholdsError = `${thresholdsFile} is not valid JSON`;
    }
    if (thresholdsError === null) {
      const parsed = parseFinanceBehaviourThresholds(value, thresholdsFile);
      if (parsed.ok) {
        declared = parsed.thresholds;
      } else {
        thresholdsError = parsed.error;
      }
    }
  }

  return {
    status: "computed" as const,
    thresholdsFile,
    thresholdsDeclared: declared !== null,
    thresholdsError,
    profile: buildFinanceBehaviourProfile({
      receipts: params.receipts,
      marks: params.marks,
      ...(declared === null ? {} : { thresholds: declared }),
    }),
  };
}

/**
 * Read-only view of the agent's own book.
 *
 * Before this tool the ledger was write-only from the agent's side: fills and marks could be
 * appended by operator scripts, but no tool could answer "what do I hold, and what is it
 * worth". That made every finance answer stateless, so the agent could not reason about a
 * position it had already opened or a call it had already made.
 *
 * It reports where it read from. Reading the wrong directory is silent — an absent book and
 * a flat account look identical — so `ledgerDirectory`, `resolvedFrom` and `status` are part
 * of the result, and an absent database is a named failure rather than an empty portfolio.
 *
 * `includeBehaviour` adds the behaviour profile over the same stream. The boundary it reports
 * against is the owner's, not the caller's: the thresholds come from the declaration file in the
 * ledger directory, which the operator entry resolves to the same path, and the caller cannot
 * substitute its own. That is deliberate — a model choosing the thresholds would be making the
 * judgement and then reading its own measurement as evidence for it.
 */
export function createFinancePositionLedgerReadTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  return {
    label: "Finance Position Ledger Read",
    name: "finance_position_ledger_read",
    description:
      "Read the durable position book and optional bounded history. For history pass historyKind=receipt|order|fill|fee, historyAccountId, historyVenue, optional instrument/time filters, historyLimit (1-25), then the returned opaque historyCursor. Receipts are LCX execution records; fills/fees use normalized reconciled Alpaca paper facts; orders are deduplicated raw observations with a fixed safe-field projection and are not reconciled. The page is bounded for model context, while existing owners still validate/read the underlying history stream. Read-only: no append, network call, or venue access.",
    parameters: FinancePositionLedgerReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const directory = readStringParam(params, "directory");
      const asOf = readStringParam(params, "asOf");
      const brokerAccountId = readStringParam(params, "brokerAccountId")?.trim();
      const initialCapital = readNumberParam(params, "initialCapital");
      const includeCurveLevels = params.includeCurveLevels === true;
      const includeBehaviour = params.includeBehaviour === true;
      const historyKind = readStringParam(params, "historyKind");
      const historyAccountId = readStringParam(params, "historyAccountId")?.trim();
      const historyVenue = readStringParam(params, "historyVenue")?.trim();
      const historyInstrument = readStringParam(params, "historyInstrument")?.trim();
      const historyFrom = readStringParam(params, "historyFrom");
      const historyThrough = readStringParam(params, "historyThrough");
      const historyCursor = readStringParam(params, "historyCursor");
      const historyLimit = readNumberParam(params, "historyLimit") ?? 10;

      if (historyKind !== undefined && !["receipt", "order", "fill", "fee"].includes(historyKind)) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "invalid_history_kind",
          reason: "history_kind_not_supported",
        });
      }

      if (historyKind !== undefined && (!historyAccountId || !historyVenue)) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "invalid_scope",
          reason: "history_account_and_venue_required",
        });
      }
      if (
        !Number.isInteger(historyLimit) ||
        historyLimit < 1 ||
        historyLimit > 25 ||
        [historyFrom, historyThrough].some((value) => value !== undefined && !isIsoDateTime(value))
      ) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "invalid_history_filter",
          reason: "history_limit_or_time_invalid",
        });
      }
      if (historyFrom && historyThrough && Date.parse(historyFrom) > Date.parse(historyThrough)) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "invalid_history_filter",
          reason: "history_from_after_through",
        });
      }
      if (
        (historyKind === "fill" || historyKind === "fee" || historyKind === "order") &&
        historyVenue !== "alpaca:paper"
      ) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "invalid_scope",
          reason: "broker_history_requires_alpaca_paper_venue",
        });
      }

      if (brokerAccountId !== undefined && brokerAccountId.length === 0) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "invalid_scope",
          reason: "broker_account_id_required",
          notTouched: [
            "trading_execution",
            "order_placement",
            "provider_config",
            "external_channel_sender",
            "protected_memory",
          ],
        });
      }
      const location = resolveFinancePositionLedgerLocation({
        workspaceDir: options?.workspaceDir,
        directory,
      });

      if (asOf !== undefined && !Number.isFinite(Date.parse(asOf))) {
        return jsonResult({
          ok: false,
          reason: "finance_position_ledger_as_of_invalid",
          asOf,
          action: "Pass asOf as an ISO datetime, or omit it for the current book.",
        });
      }
      if (brokerAccountId !== undefined && asOf !== undefined) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "unsupported_scope",
          reason: "broker_history_as_of_filter_not_supported",
          action: "read the account-wide broker history without asOf, or omit brokerAccountId",
          notTouched: [
            "trading_execution",
            "order_placement",
            "provider_config",
            "external_channel_sender",
            "protected_memory",
          ],
        });
      }
      if (
        initialCapital !== undefined &&
        (!Number.isFinite(initialCapital) || initialCapital <= 0)
      ) {
        return jsonResult({
          ok: false,
          reason: "finance_position_ledger_initial_capital_invalid",
          initialCapital,
          action:
            "initialCapital must be a positive finite number. Omit it to read positions without an equity curve.",
        });
      }

      const databasePresent = await fs
        .access(location.database)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return false;
          }
          throw error;
        });

      if (!databasePresent) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "absent",
          reason: "finance_position_ledger_absent",
          ledgerDirectory: location.directory,
          resolvedFrom: location.source,
          databasePath: location.database,
          action:
            "No ledger exists at this path, so this is not evidence of a flat book. Set LCX_FINANCE_STATE_DIR (or pass directory) to the directory an operator script appended to, or append a first execution receipt.",
          notTouched: [
            "trading_execution",
            "order_placement",
            "provider_config",
            "external_channel_sender",
            "protected_memory",
          ],
        });
      }

      const read = await readFinancePositionRecords(location.directory);
      const ledgerRead = await readFinancePositionLedger(
        location.directory,
        asOf === undefined ? {} : { asOf },
      );
      const { ledger } = ledgerRead;
      const accountTradingBook =
        brokerAccountId === undefined
          ? null
          : await readFinanceAccountTradingBook({
              directory: location.directory,
              accountId: brokerAccountId,
              venue: "alpaca:paper",
            });
      const brokerReadAt = new Date().toISOString();
      const nativeFeedback =
        brokerAccountId === undefined
          ? undefined
          : await readFinancePositionManagementFeedback({
              directory: location.directory,
              observedAt: brokerReadAt,
              rules: [],
              scope: { accountId: brokerAccountId, venue: "alpaca:paper" },
            });
      const brokerSnapshot = nativeFeedback
        ? {
            status: nativeFeedback.status,
            readAt: brokerReadAt,
            boundary:
              "retained_native_positions_and_stop_coverage_not_network_read_or_rule_membership",
            ...("reason" in nativeFeedback ? { reason: nativeFeedback.reason } : {}),
            ...(nativeFeedback.accounts !== undefined
              ? {
                  omittedAccounts: nativeFeedback.omittedAccounts,
                  accounts: nativeFeedback.accounts.map((account) => ({
                    accountId: account.accountId,
                    venue: account.venue,
                    snapshotRef: account.snapshotRef,
                    observedAt: account.observedAt,
                    freshness: account.freshness,
                    positionCount: account.positionCount,
                    uncoveredCount: account.uncoveredCount,
                    unresolvedOrderCount: account.unresolvedOrderCount,
                    omittedHoldings: account.omittedHoldings,
                    holdings: account.holdings.map(
                      ({ activeRuleIds: _rules, omittedRuleCount: _omittedRules, ...holding }) =>
                        holding,
                    ),
                  })),
                }
              : {}),
          }
        : undefined;
      const historyBook =
        historyKind === "fill" || historyKind === "fee"
          ? brokerAccountId === historyAccountId && accountTradingBook
            ? accountTradingBook
            : await readFinanceAccountTradingBook({
                directory: location.directory,
                accountId: historyAccountId!,
                venue: "alpaca:paper",
              })
          : null;
      const historyHead = historyBook?.brokerHistory.sourceHeadRef;
      const orderHistory =
        historyKind === "order"
          ? await readFinanceBrokerHistory(location.directory, historyAccountId!, {
              streams: ["orders"],
            })
          : null;
      const orderRows = orderHistory ? projectBrokerOrderFacts(orderHistory.facts) : null;
      const history =
        historyKind === "receipt"
          ? receiptHistoryPage({
              records: read.records,
              headRef: read.headRef,
              accountId: historyAccountId!,
              venue: historyVenue!,
              kind: "receipt",
              ...(historyInstrument ? { instrument: historyInstrument } : {}),
              ...(historyFrom ? { from: historyFrom } : {}),
              ...(historyThrough ? { through: historyThrough } : {}),
              limit: historyLimit,
              ...(historyCursor ? { cursor: historyCursor } : {}),
            })
          : (historyKind === "fill" || historyKind === "fee") &&
              historyBook &&
              typeof historyHead !== "string"
            ? { status: "source_head_unavailable", items: [], nextCursor: null, complete: false }
            : historyKind === "fill" && historyBook && historyHead
              ? brokerHistoryPage({
                  rows: historyBook.brokerHistory.fills,
                  sourceStatus: historyBook.brokerHistory.historyStatus,
                  headRef: historyHead,
                  kind: "fill",
                  accountId: historyAccountId!,
                  venue: historyVenue!,
                  ...(historyInstrument ? { instrument: historyInstrument } : {}),
                  ...(historyFrom ? { from: historyFrom } : {}),
                  ...(historyThrough ? { through: historyThrough } : {}),
                  limit: historyLimit,
                  ...(historyCursor ? { cursor: historyCursor } : {}),
                })
              : historyKind === "fee" && historyBook && historyHead
                ? brokerHistoryPage({
                    rows: historyBook.brokerHistory.fees,
                    sourceStatus: historyBook.brokerHistory.historyStatus,
                    headRef: historyHead,
                    kind: "fee",
                    accountId: historyAccountId!,
                    venue: historyVenue!,
                    ...(historyInstrument ? { instrument: historyInstrument } : {}),
                    ...(historyFrom ? { from: historyFrom } : {}),
                    ...(historyThrough ? { through: historyThrough } : {}),
                    limit: historyLimit,
                    ...(historyCursor ? { cursor: historyCursor } : {}),
                  })
                : historyKind === "order" && orderHistory && orderRows
                  ? {
                      ...brokerHistoryPage({
                        rows: orderRows.rows,
                        sourceStatus: orderHistory.historyStatus,
                        headRef: orderHistory.headRef,
                        kind: "order",
                        accountId: historyAccountId!,
                        venue: historyVenue!,
                        ...(historyInstrument ? { instrument: historyInstrument } : {}),
                        ...(historyFrom ? { from: historyFrom } : {}),
                        ...(historyThrough ? { through: historyThrough } : {}),
                        limit: historyLimit,
                        ...(historyCursor ? { cursor: historyCursor } : {}),
                      }),
                      omittedOrderCount: orderRows.omittedCount,
                      projection: "safe_order_field_allowlist",
                    }
                  : undefined;

      const openPositions = ledger.positions.filter((position) => position.quantity !== 0);
      const status =
        ledgerRead.recordCount === 0
          ? "empty"
          : ledger.unrealizedPnl === null
            ? "partial_no_mark"
            : "ready";

      const equityCurve =
        initialCapital === undefined
          ? { status: "not_requested" as const }
          : (() => {
              const asOfMs = asOf === undefined ? Number.POSITIVE_INFINITY : Date.parse(asOf);
              const curveReceipts = read.receipts.filter(
                (receipt) => Date.parse(receipt.recordedAt) <= asOfMs,
              );
              const curveMarks = read.marks.filter((mark) => Date.parse(mark.at) <= asOfMs);
              const curve = buildFinanceEquityCurve({
                receipts: curveReceipts,
                marks: curveMarks,
                initialCapital,
              });
              return {
                status: "computed" as const,
                initialCapital,
                pnlBasis: curve.pnlBasis,
                sampleCount: curve.sampleCount,
                finalEquity: curve.finalEquity,
                definedLevelCount: curve.levels.length,
                undefinedEquityAt: curve.undefinedEquityAt,
                receiptsAfterLastMark: curve.receiptsAfterLastMark,
                meanSampleSpacingSeconds: curve.meanSampleSpacingSeconds,
                grossPerformanceDiagnostic: grossPerformanceDiagnostic({
                  curve,
                  receipts: curveReceipts,
                }),
                ...(includeCurveLevels
                  ? { levels: curve.levels, levelTimestamps: curve.levelTimestamps }
                  : {}),
              };
            })();

      const behaviour = includeBehaviour
        ? await readBehaviourSection({
            directory: location.directory,
            receipts: ledgerRead.receipts,
            marks: ledgerRead.marks,
          })
        : ({ status: "not_requested" as const } as const);

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
        boundary: "finance_position_ledger_read_only",
        status,
        ledgerDirectory: location.directory,
        resolvedFrom: location.source,
        databasePath: location.database,
        asOf: asOf ?? null,
        // The position view keeps its existing all-receipts behavior; the curve below is
        // filtered to asOf so its historical fills and marks describe the requested window.
        asOfCaveat:
          asOf === undefined
            ? null
            : "positions include every recorded fill; the gross curve includes only receipts and marks recorded by asOf",
        recordCount: ledgerRead.recordCount,
        receiptRecordCount: ledgerRead.receiptRecordCount,
        markRecordCount: ledgerRead.markRecordCount,
        headRef: ledgerRead.headRef,
        // Paper and venue fills are reported apart so a simulated book is never read as real.
        paperFillCount: ledger.paperFillCount,
        venueFillCount: ledger.venueFillCount,
        positionCount: ledger.positions.length,
        openPositionCount: openPositions.length,
        positions: ledger.positions,
        ...(brokerSnapshot === undefined ? {} : { brokerSnapshot }),
        ...(history === undefined ? {} : { historyKind, history }),
        pnlBasis: ledger.pnlBasis,
        brokerTradeEconomics: accountTradingBook
          ? {
              accountId: accountTradingBook.accountId,
              venue: accountTradingBook.venue,
              baselineSource: accountTradingBook.baselineSource,
              diagnostic: brokerTradeEconomicsDiagnostic(accountTradingBook),
            }
          : { status: "not_requested" },
        realizedPnl: ledger.realizedPnl,
        unrealizedPnl: ledger.unrealizedPnl,
        unrealizedUnavailableReason:
          ledger.unrealizedPnl === null
            ? "at least one open position has no usable mark; a partial sum would overstate certainty"
            : null,
        instrumentsWithoutMark: ledger.instrumentsWithoutMark,
        rejectedMarks: ledger.rejectedMarks,
        equityCurve,
        behaviour,
        notTouched: [
          "trading_execution",
          "order_placement",
          "provider_config",
          "external_channel_sender",
          "protected_memory",
        ],
      });
    },
  };
}
