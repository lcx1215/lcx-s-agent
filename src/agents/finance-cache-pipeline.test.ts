import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApiSourceGovernanceRegistry } from "./api-call-contract.js";
import { resolveFinanceFetch } from "./finance-live-market-source.js";
import type { FinanceMarketCollectionAdapter } from "./finance-market-collection-registry.js";
import { runFinanceResearchBatch } from "./finance-research-batch-runner.js";
import { createFinanceResponseCache } from "./finance-response-cache.js";
import { createFinanceQuotaGuard } from "./finance-source-quota.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("completes repeated requests with one HTTP credit and preserves original observation time across runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-reuse-pipeline-"));
  roots.push(root);
  let time = Date.parse("2026-09-09T00:00:00Z");
  const cache = createFinanceResponseCache({ now: () => time });
  const quota = createFinanceQuotaGuard({
    stateDir: root,
    now: () => time,
    policies: [
      {
        id: "massive",
        provider: "massive",
        hosts: ["api.massive.com"],
        windows: [{ limit: 1, durationMs: 86_400_000 }],
        minIntervalMs: 0,
        basis: "conservative_unknown",
      },
    ],
  });
  const native = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"title":"Source article"}',
  }));
  const fetch = cache.wrap(quota.wrap(native));
  const adapter: FinanceMarketCollectionAdapter = {
    id: "massive_news",
    providerName: "massive",
    providerRole: "primary_market_data",
    priority: 1,
    supports: () => true,
    collect: async (request, signal) => {
      const result = await resolveFinanceFetch(fetch)("https://api.massive.com/news?symbol=AAPL", {
        signal,
      });
      return [
        {
          itemId: "one",
          collection: "news",
          providerName: "massive",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: request.asOf,
          observedAt: request.asOf,
          delayStatus: "realtime",
          sourceUrlOrArtifact: "https://api.massive.com/news",
          data: JSON.parse(await result.text()) as Record<string, unknown>,
        },
      ];
    },
  };
  const run = () =>
    runFinanceResearchBatch({
      targets: Array.from({ length: 5 }, (_, index) => ({
        id: `target-${index}`,
        instrument: "AAPL",
        assetClass: "us_equity",
        realtime: false,
        collections: [{ collection: "news", freshnessMaxMinutes: 1 }],
      })),
      asOf: new Date(time).toISOString(),
      useCase: "reuse verification",
      maxApiCalls: 1,
      collectionAdapters: [adapter],
      realtimeAdapters: [],
      maxConcurrency: 3,
      sourceGovernance: createApiSourceGovernanceRegistry({ minIntervalMs: 0, maxConcurrent: 4 }),
    });
  const first = await run();
  expect(first.budget).toMatchObject({
    httpDispatchCount: 1,
    cacheHitCount: 4,
    reservedCallBudget: 1,
    readyJobs: 5,
  });
  time += 1_000;
  const second = await run();
  expect(second.budget).toMatchObject({
    httpDispatchCount: 0,
    cacheHitCount: 5,
    reservedCallBudget: 0,
    readyJobs: 5,
  });
  const receipt = second.jobs[0].receipt;
  expect(receipt && "records" in receipt && receipt.records[0]).toMatchObject({
    observedAt: "2026-09-09T00:00:00.000Z",
    sourceTimestamp: "2026-09-09T00:00:00.000Z",
  });
  expect(native).toHaveBeenCalledTimes(1);
  expect((await quota.inspect())[0].windows[0].localRemaining).toBe(0);
  time += 60_000;
  const expired = await run();
  expect(expired.budget.readyJobs).toBe(0);
  expect(expired.budget.httpDispatchCount).toBe(0);
  expect(expired.budget.reservedCallBudget).toBe(0);
  expect(native).toHaveBeenCalledTimes(1);
});
