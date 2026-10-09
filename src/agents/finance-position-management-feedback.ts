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

/** Observations for the Harness, never an ownership transfer or an execution gate. */
export async function readFinancePositionManagementFeedback(params: {
  directory: string;
  observedAt: string;
  rules: readonly { ruleId: string; state: string; instruments: readonly string[] }[];
  reconciliationObservation?: FinanceBrokerReconciliationObservation;
  scope?: { accountId: string; venue: string };
}) {
  try {
    const read =
      params.scope === undefined &&
      params.reconciliationObservation?.directory === params.directory &&
      params.reconciliationObservation.asOf === params.observedAt
        ? await params.reconciliationObservation.read()
        : await readFinanceLatestBrokerReconciliations(params.directory, { scope: params.scope });
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
        holdings: holdings
          .toSorted(
            (a, b) =>
              Number(b.status !== "covered") - Number(a.status !== "covered") ||
              Number(needsReview(b)) - Number(needsReview(a)),
          )
          .slice(0, 4)
          .map((p) => ({
            ...p,
            activeRuleIds: p.activeRuleIds.slice(0, 3),
            omittedRuleCount: Math.max(0, p.activeRuleIds.length - 3),
          })),
        omittedHoldings: Math.max(0, holdings.length - 4),
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
      } else {
        accounts.pop();
        omittedAccounts += 1;
      }
    }
    return {
      status: accounts.length > 0 ? "present" : "absent",
      accounts,
      omittedAccounts,
      needsInspection,
      boundary: "observed_stop_and_rule_scope_not_exit_ownership_or_execution_authority",
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      needsInspection: false,
    };
  }
}
