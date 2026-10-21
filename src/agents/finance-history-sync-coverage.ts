import { z } from "zod";

const instantSchema = z.iso.datetime({ offset: true });
export function financeHistoryInstant(value: unknown): number {
  return typeof value === "string" && instantSchema.safeParse(value).success
    ? Date.parse(value)
    : NaN;
}

/** Account-scoped historical seal; no claim that a past cutoff describes live holdings. */
export function financeBrokerHistoryCoverage(
  receipt: Record<string, unknown> | null,
  accountId: string,
  knownEventTimes: readonly string[],
  requiredThrough?: string,
): { from: string; through: string; accountCreatedAt: string } | undefined {
  if (
    !receipt ||
    receipt.status !== "raw_history_synced" ||
    receipt.accountId !== accountId ||
    receipt.venue !== "alpaca:paper"
  ) {
    return undefined;
  }
  const from = financeHistoryInstant(receipt.after);
  const through = financeHistoryInstant(receipt.until);
  const inception = financeHistoryInstant(receipt.accountCreatedAt);
  const cutoff = requiredThrough === undefined ? through : financeHistoryInstant(requiredThrough);
  const events = knownEventTimes.map(financeHistoryInstant);
  if (
    ![from, through, inception, cutoff, ...events].every(Number.isFinite) ||
    from >= through ||
    through > Date.now() ||
    from > inception ||
    inception > through ||
    through < cutoff ||
    events.some((time) => time < inception || time > through)
  ) {
    return undefined;
  }
  return {
    from: new Date(from).toISOString(),
    through: new Date(through).toISOString(),
    accountCreatedAt: new Date(inception).toISOString(),
  };
}
