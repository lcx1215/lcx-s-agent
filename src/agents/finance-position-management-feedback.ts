import { createHash } from "node:crypto";
import { z } from "zod";
import { brokerSymbol } from "./finance-broker-reconciliation.js";
import { readFinanceLatestBrokerReconciliations } from "./finance-position-ledger.js";
import { classifyFinanceProtectionOrders } from "./finance-protection-coordination.js";

/** Shared latest read; asOf binds its consumer clock without changing head/superseded semantics. */
export type FinanceBrokerReconciliationObservation = Readonly<{
  directory: string;
  asOf: string;
  read: () => ReturnType<typeof readFinanceLatestBrokerReconciliations>;
}>;

const quantity = z
  .union([z.string().trim().min(1), z.number()])
  .transform(Number)
  .pipe(z.number().finite());
const snapshotSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  positions: z.array(z.object({ symbol: z.string(), qty: quantity })),
  openOrders: z.array(z.record(z.string(), z.unknown())),
});

type HoldingsCursor = {
  v: 1;
  accountId: string;
  venue: string;
  snapshotRef: string;
  orderingFingerprint: string;
  offset: number;
};
class HoldingsPageError extends Error {
  constructor(
    readonly status: "invalid_cursor" | "stale_cursor",
    message: string,
  ) {
    super(message);
  }
}
function decodeHoldingsCursor(value: string): HoldingsCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      parsed.v !== 1 ||
      typeof parsed.accountId !== "string" ||
      typeof parsed.venue !== "string" ||
      typeof parsed.snapshotRef !== "string" ||
      typeof parsed.orderingFingerprint !== "string" ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error("invalid holdings cursor");
    }
    return parsed as HoldingsCursor;
  } catch {
    throw new HoldingsPageError("invalid_cursor", "retained holdings cursor is invalid");
  }
}
function holdingsPage(cursor: HoldingsCursor, returned: number, total: number) {
  const remaining = Math.max(0, total - cursor.offset - returned);
  const progressing = returned > 0;
  return {
    status: !progressing && remaining > 0 ? "item_exceeds_page_budget" : "page",
    offset: cursor.offset,
    returnedHoldings: returned,
    remainingHoldings: remaining,
    complete: remaining === 0,
    nextCursor:
      remaining > 0 && progressing
        ? Buffer.from(JSON.stringify({ ...cursor, offset: cursor.offset + returned })).toString(
            "base64url",
          )
        : null,
  };
}

/** Observations for the Harness, never an ownership transfer or an execution gate. */
export async function readFinancePositionManagementFeedback(params: {
  directory: string;
  observedAt: string;
  rules: readonly { ruleId: string; state: string; instruments: readonly string[] }[];
  reconciliationObservation?: FinanceBrokerReconciliationObservation;
  scope?: { accountId: string; venue: string };
  signal?: AbortSignal;
  holdingsPage?: { cursor?: string };
}) {
  params.signal?.throwIfAborted();
  try {
    if (params.holdingsPage && !params.scope) {
      throw new HoldingsPageError(
        "invalid_cursor",
        "holdings pagination requires an explicit account and venue",
      );
    }
    const cursor =
      params.holdingsPage?.cursor === undefined
        ? undefined
        : decodeHoldingsCursor(params.holdingsPage.cursor);
    if (
      cursor &&
      (cursor.accountId !== params.scope?.accountId || cursor.venue !== params.scope?.venue)
    ) {
      throw new HoldingsPageError("stale_cursor", "holdings cursor account or venue changed");
    }
    const read =
      params.scope === undefined &&
      params.reconciliationObservation?.directory === params.directory &&
      params.reconciliationObservation.asOf === params.observedAt
        ? await params.reconciliationObservation.read()
        : await readFinanceLatestBrokerReconciliations(params.directory, {
            scope: params.scope,
            signal: params.signal,
          });
    params.signal?.throwIfAborted();
    if (cursor && !read.records.some((record) => record.ref === cursor.snapshotRef)) {
      throw new HoldingsPageError(
        "stale_cursor",
        "retained holdings snapshot changed or is absent",
      );
    }
    const pageCursors = new Map<string, HoldingsCursor>();
    const accounts = read.records.map((record) => {
      const snapshot = snapshotSchema.parse(record.snapshot);
      const age = Date.parse(params.observedAt) - Date.parse(snapshot.observedAt);
      const fresh = !record.superseded && Number.isFinite(age) && age >= 0 && age <= 300_000;
      const positions = new Map<string, number>();
      for (const row of snapshot.positions) {
        const instrument = brokerSymbol(row.symbol);
        if (positions.has(instrument)) {
          throw new Error("duplicate broker position");
        }
        positions.set(instrument, row.qty);
      }
      const protection = classifyFinanceProtectionOrders(
        snapshot.openOrders,
        positions,
        Date.parse(params.observedAt),
      );
      const holdings = protection.coverage.map((position) => ({
        ...position,
        activeRuleIds: params.rules
          .filter(
            (rule) => rule.state === "active" && rule.instruments.includes(position.instrument),
          )
          .map((rule) => rule.ruleId),
      }));
      const needsReview = (position: (typeof holdings)[number]) =>
        position.status !== "covered" || position.activeRuleIds.length === 0;
      const ordered = holdings.toSorted(
        (a, b) =>
          Number(b.status !== "covered") - Number(a.status !== "covered") ||
          Number(needsReview(b)) - Number(needsReview(a)) ||
          (params.holdingsPage ? a.instrument.localeCompare(b.instrument) : 0),
      );
      const pageCursor: HoldingsCursor | undefined = params.holdingsPage
        ? {
            v: 1,
            accountId: record.accountId,
            venue: record.venue,
            snapshotRef: record.ref,
            orderingFingerprint: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
            offset: cursor?.offset ?? 0,
          }
        : undefined;
      if (
        cursor &&
        pageCursor &&
        (cursor.orderingFingerprint !== pageCursor.orderingFingerprint ||
          cursor.offset > ordered.length)
      ) {
        throw new HoldingsPageError("stale_cursor", "holdings classification or ordering changed");
      }
      if (pageCursor) {
        pageCursors.set(record.ref, pageCursor);
      }
      const selected = ordered
        .slice(pageCursor?.offset ?? 0, (pageCursor?.offset ?? 0) + 4)
        .map((p) => ({
          ...p,
          activeRuleIds: p.activeRuleIds.slice(0, 3),
          omittedRuleCount: Math.max(0, p.activeRuleIds.length - 3),
        }));
      return {
        accountId: record.accountId,
        venue: record.venue,
        snapshotRef: record.ref,
        observedAt: snapshot.observedAt,
        freshness: fresh ? "fresh" : "stale",
        positionCount: holdings.length,
        uncoveredCount: holdings.filter((p) => p.status !== "covered").length,
        outsideActiveRuleCount: holdings.filter((p) => p.activeRuleIds.length === 0).length,
        unresolvedOrderCount: protection.unresolved.length,
        needsInspection: fresh && (holdings.some(needsReview) || protection.unresolved.length > 0),
        holdings: selected,
        omittedHoldings: Math.max(0, holdings.length - selected.length),
        ...(pageCursor
          ? { holdingsPage: holdingsPage(pageCursor, selected.length, holdings.length) }
          : {}),
      };
    });
    const needsInspection = accounts.some((account) => account.needsInspection);
    // Keep the shared finance perception below its existing key budget. Counts
    // cover every inspected holding even when detail must be omitted.
    let omittedAccounts = read.omittedAccounts;
    while (Buffer.byteLength(JSON.stringify(accounts), "utf8") > 1600) {
      const detailed = accounts.findLast((account) => account.holdings.length > 0);
      if (detailed) {
        detailed.holdings.pop();
        detailed.omittedHoldings += 1;
        const pageCursor = pageCursors.get(detailed.snapshotRef);
        if (pageCursor) {
          detailed.holdingsPage = holdingsPage(
            pageCursor,
            detailed.holdings.length,
            detailed.positionCount,
          );
        }
      } else {
        accounts.pop();
        omittedAccounts += 1;
      }
    }
    return {
      status:
        accounts.length > 0
          ? "present"
          : params.holdingsPage && read.records.length > 0
            ? "page_exceeds_budget"
            : "absent",
      accounts,
      omittedAccounts,
      needsInspection,
      boundary: "observed_stop_and_rule_scope_not_exit_ownership_or_execution_authority",
    };
  } catch (error) {
    params.signal?.throwIfAborted();
    return {
      status: error instanceof HoldingsPageError ? error.status : "unavailable",
      reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      needsInspection: false,
    };
  }
}
