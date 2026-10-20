import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiCallError } from "./api-call-contract.js";
import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import { readFinanceFundamentalSnapshot } from "./finance-fundamental-store.js";
import type { FetchImpl } from "./finance-live-market-source.js";
import { createBlsMacroSeriesCollectionAdapter } from "./finance-market-collection-registry.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";
import {
  planFinanceSourceHeartbeat,
  readFinanceSourceHeartbeat,
  runFinanceSourceHeartbeat,
} from "./finance-source-heartbeat.js";
import { createSecCompanyFactsAdapter } from "./finance-us-equity-source-adapters.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function observation(request: { asOf: string }): FinanceDataGatewayObservationInput {
  return {
    providerName: "test-provider",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    observedAt: request.asOf,
    timezone: "UTC",
    delayStatus: "realtime",
    fields: [
      {
        name: "price",
        value: 1,
        fieldDefinition: "test",
        sourceTimestamp: request.asOf,
        sourceUrlOrArtifact: "test-fixture",
      },
    ],
  };
}

function adapter(
  id: string,
  collect: FinanceRealtimeSourceAdapter["collect"],
): FinanceRealtimeSourceAdapter {
  return {
    id,
    providerName: id,
    providerRole: "primary_market_data",
    priority: 1,
    supports: () => true,
    collect,
  };
}

describe("finance provider heartbeat", () => {
  it("pins a requested route before deduplicating its provider", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-pin-"));
    roots.push(root);
    const collect = vi.fn<FinanceRealtimeSourceAdapter["collect"]>(async (request) =>
      observation(request),
    );
    const adapters = [adapter("rotate_a", collect), adapter("rotate_b", collect)];
    const options = {
      directory: root,
      realtimeAdapters: adapters,
      collectionAdapters: [],
      adapterId: "rotate_b",
    };
    expect(planFinanceSourceHeartbeat(options).candidates.map((c) => c.adapterId)).toEqual([
      "rotate_b",
    ]);
    const result = await runFinanceSourceHeartbeat({ ...options, force: true });
    expect(result.state.records.rotate.adapterId).toBe("rotate_b");
    expect(collect).toHaveBeenCalledOnce();
  });

  it("rejects an unknown adapter before probing or creating state", async () => {
    const collect = vi.fn<FinanceRealtimeSourceAdapter["collect"]>(async (request) =>
      observation(request),
    );
    const options = {
      realtimeAdapters: [adapter("rotate_a", collect)],
      collectionAdapters: [],
      adapterId: "unknown_route",
      env: {},
    };
    expect(() => planFinanceSourceHeartbeat(options)).toThrow("unknown heartbeat adapter");
    await expect(runFinanceSourceHeartbeat(options)).rejects.toThrow("unknown heartbeat adapter");
    expect(collect).not.toHaveBeenCalled();
  });

  it("rotates routes across runs without resetting each endpoint failure history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-rotate-"));
    roots.push(root);
    let now = Date.parse("2026-09-22T07:00:00.000Z");
    const adapters = [
      adapter("rotate_a", async () => {
        throw new ApiCallError("forbidden", 403);
      }),
      adapter("rotate_b", async (request) => observation(request)),
    ];
    const run = () =>
      runFinanceSourceHeartbeat({
        directory: root,
        now: () => now,
        realtimeAdapters: adapters,
        collectionAdapters: [],
      });
    const first = await run();
    expect(first.state.records.rotate.adapterId).toBe("rotate_a");
    now += 15 * 60_000;
    const second = await run();
    expect(second.state.records.rotate.adapterId).toBe("rotate_b");
    expect(second.state.endpointRecords?.rotate_a.reason).toBe("forbidden");
    expect(second.state.endpointRecords?.rotate_b.adapterId).toBe("rotate_b");
    expect((await readFinanceSourceHeartbeat({ directory: root })).endpointRecords).toEqual(
      second.state.endpointRecords,
    );
    expect(second.checkedProviders).toEqual(["rotate"]);
  });
  it("stores successful statement payloads for research instead of discarding the heartbeat data", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-statements-"));
    roots.push(root);
    const asOf = "2026-09-22T07:00:00.000Z";
    const result = await runFinanceSourceHeartbeat({
      directory: root,
      asOf,
      now: () => Date.parse(asOf),
      realtimeAdapters: [],
      collectionAdapters: [
        {
          id: "sec_edgar_annual_operating",
          providerName: "SEC",
          providerRole: "official_or_issuer_reference",
          priority: 1,
          sampleRequest: {
            instrument: "AAPL",
            assetClass: "us_equity",
            collection: "financial_statements",
          },
          supports: (r) => r.collection === "financial_statements",
          collect: async () => [
            {
              itemId: "annual",
              collection: "financial_statements",
              providerName: "SEC",
              providerRole: "official_or_issuer_reference",
              sourceFamily: "official_filing",
              sourceTimestamp: "2026-02-01T00:00:00Z",
              observedAt: asOf,
              delayStatus: "official_lagged",
              sourceUrlOrArtifact: "https://example.test/filing",
              data: { revenue: 100, date: "2025-12-31", filingDate: "2026-02-01" },
            },
          ],
        },
      ],
    });
    expect(result.collectionWrites[0]).toMatchObject({ status: "stored", recordCount: 1 });
    const stored = readFinanceFundamentalSnapshot({
      directory: root,
      instrument: "AAPL",
      assetClass: "us_equity",
      collection: "financial_statements",
      sourceId: "sec_edgar_annual_operating",
      asOf,
      knownBy: asOf,
      maxAgeMs: 0,
    });
    expect(stored?.receipt.records[0].data.revenue).toBe(100);
    expect(Object.values(result.state.endpointRecords ?? {})[0].collectionWrite?.snapshotId).toBe(
      stored?.snapshotId,
    );
  });
  it("backs off repeated failures and resets after recovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-backoff-"));
    roots.push(root);
    let failure = true;
    const adapters = [
      adapter("repeat_provider_quote", async (request) => {
        if (failure) {
          throw new ApiCallError("timeout");
        }
        return observation(request);
      }),
    ];
    let now = Date.parse("2026-09-22T07:00:00.000Z");
    for (const delay of [5, 10, 20, 40, 60, 60]) {
      const run = await runFinanceSourceHeartbeat({
        directory: root,
        asOf: new Date(now).toISOString(),
        now: () => now,
        realtimeAdapters: adapters,
        collectionAdapters: [],
      });
      const record = run.state.records.repeat;
      expect(Date.parse(record.nextCheckAt) - now).toBe(delay * 60_000);
      now = Date.parse(record.nextCheckAt);
    }
    failure = false;
    const recovered = await runFinanceSourceHeartbeat({
      directory: root,
      asOf: new Date(now).toISOString(),
      now: () => now,
      realtimeAdapters: adapters,
      collectionAdapters: [],
    });
    expect(recovered.state.records.repeat.consecutiveFailures).toBe(0);
    expect(recovered.state.records.repeat.status).toBe("healthy");
  });

  it("selects one representative per provider instead of probing every route", () => {
    const plan = planFinanceSourceHeartbeat({
      asOf: "2026-09-22T07:00:00.000Z",
      realtimeAdapters: [
        adapter("demo_provider_quote", async (request) => observation(request)),
        adapter("demo_provider_news", async (request) => observation(request)),
        adapter("other_provider_quote", async (request) => observation(request)),
      ],
      collectionAdapters: [],
    });
    expect(plan.networkCalled).toBe(false);
    expect(plan.providerCount).toBe(2);
    expect(plan.candidates.map((candidate) => candidate.adapterId)).toEqual([
      "demo_provider_news",
      "other_provider_quote",
    ]);
  });

  it("uses a realtime adapter's declared sample instead of an unrelated generic symbol", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-sample-"));
    roots.push(root);
    const requested: string[] = [];
    const secAdapter: FinanceRealtimeSourceAdapter = {
      ...adapter("sec_edgar_companyfacts", async (request) => {
        requested.push(request.instrument);
        return observation(request);
      }),
      sampleRequest: { instrument: "AAPL", assetClass: "us_equity" },
    };

    const result = await runFinanceSourceHeartbeat({
      directory: root,
      asOf: "2026-09-22T07:00:00.000Z",
      now: () => Date.parse("2026-09-22T07:00:00.000Z"),
      realtimeAdapters: [secAdapter],
      collectionAdapters: [],
      maxSourceConcurrency: 1,
    });

    expect(result.healthyCount).toBe(1);
    expect(requested).toEqual(["AAPL"]);
  });

  it("probes the real SEC company-facts adapter with its declared AAPL sample", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-sec-"));
    roots.push(root);
    const requestedUrls: string[] = [];
    const secAdapter = createSecCompanyFactsAdapter({
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () =>
            url.includes("company_tickers")
              ? JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } })
              : JSON.stringify({
                  entityName: "Apple Inc.",
                  facts: {
                    "us-gaap": {
                      Assets: {
                        units: { USD: [{ val: 5000, filed: "2026-09-01", end: "2026-06-30" }] },
                      },
                    },
                  },
                }),
        };
      },
    });

    const result = await runFinanceSourceHeartbeat({
      directory: root,
      asOf: "2026-09-22T07:00:00.000Z",
      now: () => Date.parse("2026-09-22T07:00:00.000Z"),
      realtimeAdapters: [secAdapter],
      collectionAdapters: [],
      maxSourceConcurrency: 1,
    });

    expect(result.healthyCount).toBe(1);
    expect(requestedUrls).toEqual([
      "https://www.sec.gov/files/company_tickers.json",
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
    ]);
  });

  it("persists redacted healthy state and skips a provider before its next due time", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-"));
    roots.push(root);
    let calls = 0;
    const adapters = [
      adapter("demo_provider_quote", async (request) => {
        calls += 1;
        return observation(request);
      }),
    ];
    const first = await runFinanceSourceHeartbeat({
      directory: root,
      asOf: "2026-09-22T07:00:00.000Z",
      now: () => Date.parse("2026-09-22T07:00:00.000Z"),
      realtimeAdapters: adapters,
      collectionAdapters: [],
      maxSourceConcurrency: 1,
    });
    expect(first.networkCalled).toBe(true);
    expect(first.healthyCount).toBe(1);
    expect(calls).toBe(1);

    const persisted = await readFinanceSourceHeartbeat({ directory: root });
    expect(persisted.records.demo).toEqual(
      expect.objectContaining({
        status: "healthy",
        reason: "ok",
        adapterId: "demo_provider_quote",
      }),
    );
    const file = await fs.readFile(path.join(root, "source-heartbeats.json"), "utf8");
    expect(file).not.toContain("https://");
    expect(file).not.toContain("api_key");

    const second = await runFinanceSourceHeartbeat({
      directory: root,
      asOf: "2026-09-22T07:01:00.000Z",
      now: () => Date.parse("2026-09-22T07:01:00.000Z"),
      realtimeAdapters: adapters,
      collectionAdapters: [],
      maxSourceConcurrency: 1,
    });
    expect(second.networkCalled).toBe(false);
    expect(second.checkedProviders).toEqual([]);
    expect(calls).toBe(1);
  });

  it("keeps provider reachability distinct from entitlement or quota failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-"));
    roots.push(root);
    const result = await runFinanceSourceHeartbeat({
      directory: root,
      asOf: "2026-09-22T07:00:00.000Z",
      now: () => Date.parse("2026-09-22T07:00:00.000Z"),
      realtimeAdapters: [
        adapter("forbidden_provider_quote", async () => {
          throw new ApiCallError("forbidden", 403);
        }),
        adapter("quota_provider_quote", async () => {
          throw new ApiCallError("budget_exhausted");
        }),
      ],
      collectionAdapters: [],
      maxSourceConcurrency: 1,
    });
    const state = await readFinanceSourceHeartbeat({ directory: root });
    expect(result.degradedCount).toBe(2);
    expect(state.records.forbidden.status).toBe("degraded");
    expect(state.records.forbidden.reason).toBe("forbidden");
    expect(state.records.quota.status).toBe("degraded");
    expect(state.records.quota.reason).toBe("budget_exhausted");
  });

  it.each([
    { retryAfterMs: 10 * 60_000, expectedDelayMs: 10 * 60_000 },
    { retryAfterMs: 2 * 60_000, expectedDelayMs: 5 * 60_000 },
  ])(
    "honors Retry-After without shortening the heartbeat failure cooldown (%o)",
    async ({ retryAfterMs, expectedDelayMs }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-retry-after-"));
      roots.push(root);
      const checkedAt = Date.parse("2026-09-22T07:00:00.000Z");
      let calls = 0;
      const adapters = [
        adapter("limited_provider_quote", async () => {
          calls += 1;
          throw new ApiCallError("rate_limited", 429, retryAfterMs);
        }),
      ];
      const first = await runFinanceSourceHeartbeat({
        directory: root,
        asOf: new Date(checkedAt).toISOString(),
        now: () => checkedAt,
        realtimeAdapters: adapters,
        collectionAdapters: [],
        maxSourceConcurrency: 1,
      });
      const state = await readFinanceSourceHeartbeat({ directory: root });
      expect(first.degradedCount).toBe(1);
      expect(Date.parse(state.records.limited.nextCheckAt)).toBe(checkedAt + expectedDelayMs);
      expect(state.records.limited.retryAfterMs).toBe(retryAfterMs);

      const beforeRetryAt = checkedAt + expectedDelayMs - 1;
      const premature = await runFinanceSourceHeartbeat({
        directory: root,
        asOf: new Date(beforeRetryAt).toISOString(),
        now: () => beforeRetryAt,
        realtimeAdapters: adapters,
        collectionAdapters: [],
        maxSourceConcurrency: 1,
      });
      expect(premature.checkedProviders).toEqual([]);
      expect(premature.skippedProviders).toEqual(["limited"]);
      expect(calls).toBe(1);
    },
  );

  it("cancels pending probes on shutdown without classifying providers as unhealthy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-"));
    roots.push(root);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await runFinanceSourceHeartbeat({
      directory: root,
      signal: controller.signal,
      asOf: "2026-09-22T07:00:00.000Z",
      now: () => Date.parse("2026-09-22T07:00:00.000Z"),
      realtimeAdapters: [
        adapter("demo_provider_quote", async (request) => {
          calls += 1;
          return observation(request);
        }),
      ],
      collectionAdapters: [],
      maxSourceConcurrency: 1,
    });
    const state = await readFinanceSourceHeartbeat({ directory: root });
    expect(calls).toBe(0);
    expect(result.unknownCount).toBe(1);
    expect(state.records.demo).toMatchObject({ status: "unknown", reason: "cancelled" });
  });

  it.each([
    { stateText: "{not-json", message: "invalid JSON; refusing provider probes" },
    {
      stateText: JSON.stringify({
        schemaVersion: 2,
        updatedAt: "2026-09-22T07:00:00.000Z",
        records: {},
      }),
      message: "invalid schema; refusing provider probes",
    },
  ])(
    "refuses to probe or replace malformed heartbeat state (%o)",
    async ({ stateText, message }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-corrupt-"));
      roots.push(root);
      await fs.writeFile(path.join(root, "source-heartbeats.json"), stateText, { mode: 0o600 });
      let calls = 0;
      await expect(
        runFinanceSourceHeartbeat({
          directory: root,
          realtimeAdapters: [
            adapter("demo_provider_quote", async (request) => {
              calls += 1;
              return observation(request);
            }),
          ],
          collectionAdapters: [],
        }),
      ).rejects.toThrow(message);
      expect(calls).toBe(0);
      await expect(fs.readFile(path.join(root, "source-heartbeats.json"), "utf8")).resolves.toBe(
        stateText,
      );
    },
  );

  it("serializes overlapping runs and rechecks due providers after acquiring the lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-heartbeat-overlap-"));
    roots.push(root);
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const adapters = [
      adapter("demo_provider_quote", async (request) => {
        calls += 1;
        if (calls === 1) {
          startedFirst();
          await firstMayFinish;
        }
        return observation(request);
      }),
    ];
    const first = runFinanceSourceHeartbeat({
      directory: root,
      asOf: "2026-09-22T07:00:00.000Z",
      now: () => Date.parse("2026-09-22T07:00:00.000Z"),
      realtimeAdapters: adapters,
      collectionAdapters: [],
      maxSourceConcurrency: 1,
    });
    await firstStarted;
    const second = runFinanceSourceHeartbeat({
      directory: root,
      asOf: "2026-09-22T07:00:00.000Z",
      now: () => Date.parse("2026-09-22T07:00:00.000Z"),
      realtimeAdapters: adapters,
      collectionAdapters: [],
      maxSourceConcurrency: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.checkedProviders).toEqual(["demo"]);
    expect(secondResult.checkedProviders).toEqual([]);
    expect(secondResult.skippedProviders).toEqual(["demo"]);
    expect(calls).toBe(1);
  });

  it.each([
    { intervalMs: 1.5 },
    { intervalMs: 2_147_483_648 },
    { timeoutMs: 1.5 },
    { timeoutMs: 2_147_483_648 },
    { maxSourceConcurrency: 9 },
  ])("rejects unsupported heartbeat limits before provider calls (%o)", async (limits) => {
    let calls = 0;
    await expect(
      runFinanceSourceHeartbeat({
        realtimeAdapters: [
          adapter("demo_provider_quote", async (request) => {
            calls += 1;
            return observation(request);
          }),
        ],
        collectionAdapters: [],
        ...limits,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

it("uses a native BLS series for its natural heartbeat rather than FRED GDP", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-bls-native-"));
  roots.push(directory);
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    urls.push(url);
    const valid = url.endsWith("/CUUR0000SA0");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: valid ? "REQUEST_SUCCEEDED" : "REQUEST_FAILED",
          Results: {
            series: [
              {
                seriesID: valid ? "CUUR0000SA0" : "GDP",
                data: valid ? [{ year: "2025", period: "M12", value: "315.6" }] : [],
              },
            ],
          },
        }),
    };
  };
  const result = await runFinanceSourceHeartbeat({
    directory,
    asOf: "2026-10-14T03:00:00Z",
    realtimeAdapters: [],
    collectionAdapters: [createBlsMacroSeriesCollectionAdapter({ fetchImpl })],
  });
  expect(urls).toEqual(["https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0"]);
  expect(result.healthyCount).toBe(1);
  expect((await readFinanceSourceHeartbeat({ directory })).records.bls).toMatchObject({
    status: "healthy",
    reason: "ok",
    httpStatus: 200,
  });
});
