import type { ApiCallReceipt } from "./api-call-contract.js";

/** Conservative across multi-endpoint adapters: reuse cannot advance observation/fallback time. */
export function financeReuseTimestamp(
  calls: readonly ApiCallReceipt[],
  asOf: string,
): string | undefined {
  const timestamps = calls
    .filter((call) => call.dataAccess?.kind === "cache")
    .map((call) => Date.parse(call.dataAccess!.fetchedAt))
    .filter(Number.isFinite);
  if (!timestamps.length) {
    return undefined;
  }
  return new Date(Math.min(Date.parse(asOf), ...timestamps)).toISOString();
}
