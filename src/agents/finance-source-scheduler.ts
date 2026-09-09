import { FINANCE_SOURCE_QUOTA_POLICIES } from "./finance-source-quota-policy.js";

/** Adapter aliases share a provider lane; independent providers can make progress concurrently. */
export function financeProviderId(id: string): string {
  return (
    [...new Set(FINANCE_SOURCE_QUOTA_POLICIES.map((policy) => policy.provider))]
      .toSorted((a, b) => b.length - a.length)
      .find((provider) => id === provider || id.startsWith(`${provider}_`)) ?? id.split("_")[0]
  );
}

/** Keep independent host quotas explicit in source-health projections. */
export function financeQuotaGroupId(id: string): string {
  if (id === "fred_public_index_history") {
    return "fred_public";
  }
  if (id === "gdelt_public_news_titles") {
    return "gdelt_titles";
  }
  if (id === "gdelt_public_news") {
    return "gdelt_doc";
  }
  return financeProviderId(id);
}

export async function mapFinanceSourceLanes<T extends { id: string }, R>(
  sources: readonly T[],
  collect: (source: T) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("source concurrency must be an integer between 1 and 8");
  }
  const groups = new Map<string, { source: T; index: number }[]>();
  sources.forEach((source, index) => {
    const provider = financeProviderId(source.id);
    const lane = groups.get(provider) ?? [];
    lane.push({ source, index });
    groups.set(provider, lane);
  });
  const lanes = [...groups.values()];
  const results: R[] = [];
  let next = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, lanes.length) }, async () => {
      while (next < lanes.length) {
        const lane = lanes[next++];
        for (const { source, index } of lane) {
          results[index] = await collect(source);
        }
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
  return results;
}
