import type { FinanceDailyAccountBook } from "./finance-daily-cycle.js";

export function freshExecutionCapacity(
  account: FinanceDailyAccountBook,
  accountId: string,
  asOfMs: number,
): NonNullable<FinanceDailyAccountBook["executionCapacity"]> | undefined {
  const capacity = account.executionCapacity;
  const reconciliation = account.reconciliation;
  if (
    !capacity ||
    !reconciliation ||
    !Number.isFinite(asOfMs) ||
    !Array.isArray(reconciliation.quarantinedInstruments) ||
    capacity.source !== "controller_account_safety_facts" ||
    capacity.accountId !== accountId ||
    account.accountId !== accountId ||
    capacity.venue !== account.venue ||
    account.venue !== "alpaca:paper" ||
    capacity.observedAt !== account.observedAt ||
    capacity.expiresAt !== account.expiresAt ||
    !Number.isFinite(Date.parse(account.observedAt)) ||
    !Number.isFinite(Date.parse(account.expiresAt)) ||
    Date.parse(account.observedAt) > asOfMs ||
    Date.parse(account.expiresAt) <= asOfMs ||
    typeof capacity.policyPlanId !== "string" ||
    !capacity.policyPlanId.trim() ||
    typeof capacity.policyRevision !== "string" ||
    !capacity.policyRevision.trim() ||
    !Number.isFinite(capacity.grossExposure) ||
    capacity.grossExposure < 0 ||
    !Number.isFinite(capacity.maxGrossExposure) ||
    capacity.maxGrossExposure <= 0 ||
    !Number.isFinite(capacity.uncertaintyReserve) ||
    capacity.uncertaintyReserve < 0 ||
    (capacity.availableCash !== undefined &&
      (!Number.isFinite(capacity.availableCash) || capacity.availableCash < 0)) ||
    capacity.uncertaintyReserve !== reconciliation.uncertaintyReserve ||
    (reconciliation.status === "ready"
      ? reconciliation.historyStatus !== "reconciled" ||
        capacity.uncertaintyReserve !== 0 ||
        reconciliation.quarantinedInstruments.length !== 0
      : reconciliation.status !== "restricted" ||
        reconciliation.historyStatus !== "unresolved" ||
        capacity.uncertaintyReserve <= 0 ||
        reconciliation.quarantinedInstruments.length === 0)
  ) {
    return undefined;
  }
  return capacity;
}
