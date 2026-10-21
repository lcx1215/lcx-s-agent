import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFinanceResearchRegistryOptions,
  financeResearchAdaptersWithFreshHealth,
} from "../../scripts/operator/lcx-finance-research-run.js";
import { ApiCallError } from "../../src/agents/api-call-contract.js";
import {
  resolveFinanceFetch,
  type FetchImpl,
} from "../../src/agents/finance-live-market-source.js";
import {
  createFinanceMarketCollectionRegistry,
  type FinanceMarketCollectionAdapter,
} from "../../src/agents/finance-market-collection-registry.js";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.js";
import { createFinanceResponseCache } from "../../src/agents/finance-response-cache.js";
import {
  persistFinanceSourceHeartbeat,
  readFinanceSourceHeartbeat,
  type FinanceSourceHeartbeatRecord,
} from "../../src/agents/finance-source-heartbeat-state.js";
import { runFinanceSourceHeartbeat } from "../../src/agents/finance-source-heartbeat.js";
import { governFinanceQuota } from "../../src/agents/finance-source-quota.js";
import { financeQuotaStateDir } from "../../src/agents/finance-state-dir.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(httpStatus = 402, adapterId = "fmp_income_statement_annual") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-endpoint-access-"));
  roots.push(directory);
  const now = Date.now();
  const asOf = new Date(now).toISOString();
  const fakeKey = "fake-endpoint-access-key-one";
  const calls: string[] = [];
  let denial = httpStatus;
  const fetchImpl: FetchImpl = async (raw) => {
    const endpoint = new URL(raw);
    calls.push(endpoint.pathname);
    const eod = endpoint.pathname.endsWith("/historical-price-eod/full");
    const status = eod ? 200 : denial;
    return {
      ok: status === 200,
      status,
      text: async () =>
        JSON.stringify(
          eod
            ? [
                {
                  symbol: "AAPL",
                  date: new Date(now - 7 * 86400000).toISOString().slice(0, 10),
                  close: 100,
                  volume: 1000,
                },
              ]
            : [{ symbol: "AAPL", date: new Date(now - 86400000).toISOString(), revenue: 100 }],
        ),
    };
  };
  const config = (key = fakeKey) => {
    const base = buildFinanceResearchRegistryOptions(false, { FMP_API_KEY: key });
    return {
      realtimeRegistryOptions: { ...base.realtimeRegistryOptions, fetchImpl },
      collectionRegistryOptions: { ...base.collectionRegistryOptions, fetchImpl },
    };
  };
  const adapter = createFinanceMarketCollectionRegistry(config().collectionRegistryOptions).find(
    (entry) => entry.id === adapterId,
  )!;
  expect(adapter).toBeDefined();
  const heartbeat = await runFinanceSourceHeartbeat({
    directory,
    env: {},
    asOf,
    now: () => now,
    realtimeAdapters: [],
    collectionAdapters: [adapter],
  });
  const record = heartbeat.state.endpointRecords![adapterId];
  expect(record.httpStatus).toBe(httpStatus);
  expect(record.accessScope).toMatchObject({
    version: 1,
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(JSON.stringify(heartbeat.state)).not.toContain(fakeKey);
  calls.splice(0);

  const research = async (
    options: { key?: string; instrument?: string; asOf?: string; fromDate?: string } = {},
  ) => {
    const adapters = await financeResearchAdaptersWithFreshHealth({
      includeYahooPublicSources: false,
      financeStateDir: directory,
      workspaceDir: directory,
      observedAt: new Date().toISOString(),
      registryOptions: config(options.key),
    });
    return runFinanceResearchRun({
      input: {
        ask: "Review supplied equity financial statements and history without trading.",
        asOf: options.asOf ?? asOf,
        asOfMode: "live_now",
        targets: [
          {
            id: "endpoint-access",
            instrument: options.instrument ?? adapter.sampleRequest?.instrument ?? "AAPL",
            assetClass: "us_equity",
            realtime: false,
            sourceAdapterIds: [adapterId, "fmp_free_basic_eod_history"],
            collections: [
              {
                collection: adapter.sampleRequest?.collection ?? "financial_statements",
                limit: 3,
                freshnessMaxMinutes: 43_200,
                ...(options.fromDate ? { fromDate: options.fromDate } : {}),
              },
              { collection: "eod_history", limit: 1, freshnessMaxMinutes: 43_200 },
            ],
          },
        ],
      },
      workspaceDir: directory,
      financeStateDir: directory,
      liveFetch: true,
      allowProviderCalls: false,
      batchOptions: {
        ...adapters,
        maxApiCalls: 4,
        maxConcurrency: 1,
        maxSourcesPerJob: 1,
        retry: { attempts: 1 },
      },
    });
  };
  const update = async (
    change: (record: FinanceSourceHeartbeatRecord) => FinanceSourceHeartbeatRecord,
  ) => {
    const next = change(structuredClone(record));
    await persistFinanceSourceHeartbeat(directory, { fmp: next }, now, { [adapterId]: next });
  };
  return {
    directory,
    now,
    asOf,
    record,
    calls,
    research,
    update,
    recover: () => {
      denial = 200;
    },
  };
}

describe("original research entry consumes endpoint-bound access cooldown", () => {
  it.each([
    { adapterId: "fmp_news_stock", endpoint: "/news/stock" },
    { adapterId: "fmp_earnings_calendar", endpoint: "/earnings-calendar" },
  ])(
    "binds $adapterId cooldown to the actual original URL-builder query",
    async ({ adapterId, endpoint }) => {
      const f = await fixture(402, adapterId);
      const denied = await f.research();
      expect(f.calls.filter((entry) => entry.endsWith(endpoint))).toHaveLength(0);
      expect(
        denied.sourceRecovery?.entries.some((entry) => entry.action === "resolve_access"),
      ).toBe(true);
      const raw = JSON.stringify(await readFinanceSourceHeartbeat({ directory: f.directory }));
      expect(raw).not.toContain("fake-endpoint-access-key-one");
      expect(raw).not.toContain("financialmodelingprep.com");
      f.calls.splice(0);
      await f.research({ fromDate: new Date(f.now - 30 * 86400000).toISOString().slice(0, 10) });
      expect(f.calls.filter((entry) => entry.endsWith(endpoint))).toHaveLength(1);
    },
  );

  it.each([401, 402, 403])(
    "does zero denied-endpoint HTTP for known %i while consuming the same provider's EOD",
    async (status) => {
      const f = await fixture(status);
      const result = await f.research();
      expect(f.calls.filter((endpoint) => endpoint.endsWith("/income-statement"))).toEqual([]);
      expect(
        f.calls.filter((endpoint) => endpoint.endsWith("/historical-price-eod/full")),
      ).toHaveLength(1);
      const denied = result.batch!.jobs.find(
        (job) => job.kind === "collection" && job.request.collection === "financial_statements",
      )!;
      expect(denied.status).toBe("blocked");
      expect(denied.apiCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "collect",
            status: "failed",
            httpStatus: status,
            retryAfterMs: expect.any(Number),
          }),
        ]),
      );
      expect(
        result.sourceRecovery?.entries.find((entry) => entry.parentJobId === denied.jobId)?.action,
      ).toBe("resolve_access");
      const eod = result.batch!.jobs.find(
        (job) => job.kind === "collection" && job.request.collection === "eod_history",
      )?.receipt;
      expect(eod && "records" in eod ? eod.records.length : 0).toBeGreaterThan(0);
      expect(result.status).toBe("blocked");
      expect(result.gates.some((gate) => !gate.passed)).toBe(true);
    },
  );

  it.each([
    "legacy",
    "version",
    "malformed",
    "expired",
    "future",
    "unknown",
    "adapter",
    "credential",
    "ticker",
    "stale",
    "healthy",
    "unconfirmed",
  ] as const)("preserves original availability when the denial scope is %s", async (fault) => {
    const f = await fixture();
    await f.update((record) => {
      if (fault === "legacy") {
        const { accessScope: _scope, ...legacy } = record;
        return legacy;
      }
      if (fault === "version") {
        Object.assign(record, {
          accessScope: { version: 2, fingerprint: record.accessScope!.fingerprint },
        });
      }
      if (fault === "malformed") {
        Object.assign(record, { accessScope: { version: 1, fingerprint: "not-a-fingerprint" } });
      }
      if (fault === "expired") {
        return {
          ...record,
          checkedAt: new Date(f.now - 7 * 3600000).toISOString(),
          nextCheckAt: new Date(f.now - 1).toISOString(),
        };
      }
      if (fault === "future") {
        return { ...record, checkedAt: new Date(f.now + 3600000).toISOString() };
      }
      if (fault === "unknown") {
        return { ...record, status: "unknown" };
      }
      if (fault === "stale") {
        return { ...record, checkedAt: new Date(f.now - 2 * 86400000).toISOString() };
      }
      if (fault === "healthy") {
        return { ...record, status: "healthy" };
      }
      if (fault === "unconfirmed") {
        return { ...record, attempts: 0 };
      }
      if (fault === "adapter") {
        return { ...record, adapterId: "foreign-endpoint" };
      }
      return record;
    });
    await f.research({
      ...(fault === "credential" ? { key: "fake-rotated-access-key" } : {}),
      ...(fault === "ticker" ? { instrument: "MSFT" } : {}),
    });
    expect(f.calls.filter((endpoint) => endpoint.endsWith("/income-statement"))).toHaveLength(1);
    if (["legacy", "version", "malformed"].includes(fault)) {
      expect(
        (await readFinanceSourceHeartbeat({ directory: f.directory })).endpointRecords!
          .fmp_income_statement_annual.accessScope,
      ).toBeUndefined();
    }
  });

  it("re-evaluates the original source naturally after the persisted deadline", async () => {
    const f = await fixture();
    await f.update((record) => ({
      ...record,
      checkedAt: new Date(f.now - 7 * 3600000).toISOString(),
      nextCheckAt: new Date(f.now - 1).toISOString(),
    }));
    f.recover();
    const result = await f.research();
    expect(f.calls.filter((endpoint) => endpoint.endsWith("/income-statement"))).toHaveLength(1);
    const job = result.batch!.jobs.find(
      (entry) => entry.kind === "collection" && entry.request.collection === "financial_statements",
    )!;
    expect(job.apiCalls.some((call) => call.httpStatus === 200)).toBe(true);
    expect(job.apiCalls.some((call) => call.httpStatus === 402)).toBe(false);
  });
});

async function quotaFixtureDirectory() {
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
async function quotaFixtureSource(
  directory: string,
  overrides: Partial<FinanceMarketCollectionAdapter> = {},
) {
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
  const directory = await quotaFixtureDirectory();
  const ambient = await quotaFixtureDirectory();
  vi.stubEnv("LCX_FINANCE_STATE_DIR", ambient);
  await exhaust(directory);
  const f = await quotaFixtureSource(directory);
  await expect(f.adapter.collect(request, new AbortController().signal)).rejects.toMatchObject({
    kind: "budget_exhausted",
  });
  expect(f.network).not.toHaveBeenCalled();
});
it("reuses exact fresh cached data even after the provider's book is exhausted", async () => {
  const directory = await quotaFixtureDirectory();
  const f = await quotaFixtureSource(directory);
  await f.adapter.collect(request, new AbortController().signal);
  await exhaust(directory);
  expect(
    await f.adapter.unavailableForRequest!(request, new AbortController().signal),
  ).toBeUndefined();
  await f.adapter.collect(request, new AbortController().signal);
  expect(f.network).toHaveBeenCalledTimes(1);
});
it("preserves an additional adapter's own availability refusal", async () => {
  const error = new ApiCallError("forbidden", 403, 60_000);
  const f = await quotaFixtureSource(await quotaFixtureDirectory(), {
    unavailableForRequest: async () => error,
  });
  expect(await f.adapter.unavailableForRequest!(request, new AbortController().signal)).toBe(error);
  expect(f.network).not.toHaveBeenCalled();
});
