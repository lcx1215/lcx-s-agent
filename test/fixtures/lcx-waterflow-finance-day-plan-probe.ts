/** Lowest HTTP-body substitute; the original EOD adapter still parses and validates every bar. */
import type { FetchImpl } from "../../src/agents/finance-live-market-source.js";

export function privateDayHistory(asOf: string, missing = false) {
  const rows: string[] = [];
  const calls: string[] = [];
  const cutoff = Date.parse(asOf.slice(0, 10) + "T00:00:00.000Z");
  for (let offset = 900; offset > 0; offset--) {
    const day = new Date(cutoff - offset * 86_400_000);
    if ([0, 6].includes(day.getUTCDay())) {
      continue;
    }
    const price = 100 + (900 - offset) * 0.1 + Math.sin(offset) * 0.2;
    rows.push(
      `${day.toISOString().slice(0, 10)},${price},${price},${price + 1},${price - 1},1000000`,
    );
  }
  const fetchImpl: FetchImpl = async (url) => {
    calls.push(String(url));
    if (missing) {
      throw new Error("private day price source unavailable");
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { klines: rows } }) };
  };
  return { fetchImpl, calls, rowCount: rows.length };
}
