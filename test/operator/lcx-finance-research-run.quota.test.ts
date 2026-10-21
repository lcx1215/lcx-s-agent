import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { financeResearchAdaptersWithFreshHealth } from "../../scripts/operator/lcx-finance-research-run.js";
import { ApiCallError } from "../../src/agents/api-call-contract.js";
import { resolveFinanceFetch } from "../../src/agents/finance-live-market-source.js";
import type { FinanceMarketCollectionAdapter } from "../../src/agents/finance-market-collection-registry.js";
import { createFinanceResponseCache } from "../../src/agents/finance-response-cache.js";
import { governFinanceQuota } from "../../src/agents/finance-source-quota.js";
import { financeQuotaStateDir } from "../../src/agents/finance-state-dir.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "research-quota-binding-"));
  roots.push(directory);
  return directory;
}
const request = {
  instrument: "AAPL",
  assetClass: "us_equity",
  collection: "news" as const,
  asOf: new Date().toISOString(),
};
async function source(directory: string, overrides: Partial<FinanceMarketCollectionAdapter> = {}) {
  const network = vi.fn(async () => ({ ok: true, status: 200, text: async () => "[]" }));
  const cache = createFinanceResponseCache();
  const fetch = resolveFinanceFetch(cache.wrap(governFinanceQuota(network)), {
    cacheMaxAgeMs: 60_000,
  });
  const adapter: FinanceMarketCollectionAdapter = {
    id: "fmp_fixture",
    providerName: "fmp-fixture",
    providerRole: "primary_market_data",
    priority: 0,
    supports: () => true,
    collect: async (_request, signal) => {
      await fetch("https://financialmodelingprep.com/stable/profile?symbol=AAPL", { signal });
      return [];
    },
    ...overrides,
  };
  const wrapped = await financeResearchAdaptersWithFreshHealth({
    includeYahooPublicSources: false,
    financeStateDir: directory,
    workspaceDir: directory,
    observedAt: request.asOf,
    registryOptions: {
      realtimeRegistryOptions: {},
      collectionRegistryOptions: { additionalAdapters: [adapter] },
    },
  });
  return { adapter: wrapped.collectionAdapters.find((entry) => entry.id === adapter.id)!, network };
}
async function exhaust(directory: string) {
  await fs.mkdir(financeQuotaStateDir(directory), { recursive: true });
  await fs.writeFile(
    path.join(financeQuotaStateDir(directory), "fmp.json"),
    JSON.stringify({
      schemaVersion: 1,
      events: [{ at: Date.now(), weight: 250, lane: "production" }],
      nextStartAt: 0,
      blockedUntil: 0,
    }),
  );
}
it("binds dispatch to the explicit book while a different ambient book has credits", async () => {
  const directory = await root();
  const ambient = await root();
  vi.stubEnv("LCX_FINANCE_STATE_DIR", ambient);
  await exhaust(directory);
  const f = await source(directory);
  await expect(f.adapter.collect(request, new AbortController().signal)).rejects.toMatchObject({
    kind: "budget_exhausted",
  });
  expect(f.network).not.toHaveBeenCalled();
});
it("reuses exact fresh cached data even after the provider's book is exhausted", async () => {
  const directory = await root();
  const f = await source(directory);
  await f.adapter.collect(request, new AbortController().signal);
  await exhaust(directory);
  expect(await f.adapter.unavailableForRequest!(request)).toBeUndefined();
  await f.adapter.collect(request, new AbortController().signal);
  expect(f.network).toHaveBeenCalledTimes(1);
});
it("preserves an additional adapter's own availability refusal", async () => {
  const error = new ApiCallError("forbidden", 403, 60_000);
  const f = await source(await root(), { unavailableForRequest: async () => error });
  expect(await f.adapter.unavailableForRequest!(request)).toBe(error);
  expect(f.network).not.toHaveBeenCalled();
});
