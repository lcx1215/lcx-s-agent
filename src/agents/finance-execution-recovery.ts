import { buildFinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { readFinanceExecutionSafetyClaims } from "./finance-execution-safety.js";
import { appendFinanceExecutionReceipt } from "./finance-position-ledger.js";
import { stableStringify } from "./stable-stringify.js";

/** Replay durable terminal receipts into the existing SQLite ledger, never replay an order.
 * Read-only journal snapshot: a concurrent incomplete append fails the snapshot as a whole.
 * This restores delivery only; it does not clear claims or certify broker reconciliation. */
export async function recoverConfirmedFinanceExecutions(params: {
  safetyStateDir: string;
  accountId: string;
  venue: string;
  ledgerDir: string;
  signal?: AbortSignal;
}) {
  const result = {
    replayed: [] as string[],
    alreadyRecorded: [] as string[],
    pendingReconciliation: [] as string[],
    legacyUnsupported: [] as string[],
    noFill: [] as string[],
    failures: [] as { claimId: string; reason: string }[],
  };
  let claims;
  try {
    claims = await readFinanceExecutionSafetyClaims({
      stateDir: params.safetyStateDir,
      accountId: params.accountId,
      venue: params.venue,
      signal: params.signal,
    });
  } catch {
    result.failures.push({ claimId: "snapshot", reason: "journal_snapshot_unavailable" });
    return result;
  }
  for (const claim of claims) {
    if (params.signal?.aborted) {
      result.failures.push({ claimId: claim.id, reason: "recovery_cancelled" });
      break;
    }
    if (claim.status !== "confirmed") {
      result.pendingReconciliation.push(claim.id);
      continue;
    }
    const { binding, receipt, fill, adapterKind } = claim;
    if (!binding || !receipt || !fill || !adapterKind || !receipt.accountId) {
      result.legacyUnsupported.push(claim.id);
      continue;
    }
    try {
      if (
        binding.accountId !== params.accountId ||
        binding.venue !== params.venue ||
        receipt.accountId !== params.accountId ||
        receipt.venue !== params.venue ||
        !["paper", "venue"].includes(adapterKind) ||
        (claim.receiptIdentityVersion !== undefined &&
          claim.receiptIdentityVersion !== "account-v1") ||
        !Number.isFinite(Date.parse(receipt.recordedAt)) ||
        (adapterKind === "venue" &&
          (typeof fill.terminalOrderIdentity?.terminal !== "boolean" ||
            !fill.terminalOrderIdentity.terminal))
      ) {
        throw new Error("binding");
      }
      const expected = buildFinanceExecutionReceipt({
        intent: binding.intent,
        adapter: { id: binding.adapterId, venue: binding.venue, kind: adapterKind },
        fill,
        recordedAt: receipt.recordedAt,
        accountId: binding.accountId,
        identityVersion: claim.receiptIdentityVersion ?? "legacy",
      });
      if (stableStringify(expected) !== stableStringify(receipt)) {
        throw new Error("receipt conflict");
      }
      if (fill.filledQuantity === 0 && adapterKind === "venue") {
        result.noFill.push(claim.id);
        continue;
      }
      const appended = await appendFinanceExecutionReceipt(params.ledgerDir, expected);
      (appended.appended ? result.replayed : result.alreadyRecorded).push(claim.id);
    } catch {
      result.failures.push({ claimId: claim.id, reason: "confirmed_receipt_delivery_pending" });
    }
  }
  return result;
}
