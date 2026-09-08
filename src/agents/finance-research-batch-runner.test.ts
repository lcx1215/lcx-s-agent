import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiSourceGovernanceRegistry } from "./api-call-contract.js";
import { buildFinanceCommitteeContext } from "./finance-agent-committee.js";
import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import {
  createFinanceMarketCollectionRegistry,
  type FinanceMarketCollectionAdapter,
  type FinanceMarketCollectionItem,
} from "./finance-market-collection-registry.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";
import {
  runFinanceResearchBatch,
  type FinanceResearchBatchOptions,
} from "./finance-research-batch-runner.js";

const AS_OF = "2026-09-08T12:00:00.000Z";
const FRESH = "2026-09-08T11:59:00.000Z";
const OLD = "2026-09-07T11:59:00.000Z";

function response(body: unknown, status = 200) {
  return { ok: status === 200, status, text: async () => JSON.stringify(body) };
}

function quote(
  providerName: string,
  providerRole: FinanceRealtimeSourceAdapter["providerRole"],
  timestamp = FRESH,
  value = 100,
): FinanceDataGatewayObservationInput {
  return {
    providerName,
    providerRole,
    sourceFamily: "market_data_api",
    observedAt: AS_OF,
    timezone: "UTC",
    delayStatus: "realtime",
    fields: [
      {
        name: "last_price",
        value,
        currency: "USD",
        fieldDefinition: "last trade",
        sourceTimestamp: timestamp,
        sourceUrlOrArtifact: `https://example.test/${providerName}`,
      },
    ],
  };
}

function realtime(fetchImpl: FetchImpl): FinanceRealtimeSourceAdapter[] {
  return (["primary_market_data", "cross_check_market_data"] as const).map((role, index) => ({
    id: `quote-${index}`,
    providerName: `quote-${index}`,
    providerRole: role,
    priority: index,
    supports: () => true,
    collect: async (request, signal) => {
      const result = await resolveFinanceFetch(fetchImpl)(
        `https://example.test/quote-${index}/${request.instrument}`,
        { signal },
      );
      return JSON.parse(await result.text()) as FinanceDataGatewayObservationInput;
    },
  }));
}

function news(overrides: Partial<FinanceMarketCollectionItem> = {}): FinanceMarketCollectionItem {
  return {
    itemId: "article",
    collection: "news",
    providerName: "news",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    sourceTimestamp: FRESH,
    observedAt: AS_OF,
    delayStatus: "realtime",
    sourceUrlOrArtifact: "https://example.test/article",
    data: { title: "Market report" },
    ...overrides,
  };
}

function collection(fetchImpl: FetchImpl): FinanceMarketCollectionAdapter {
  return {
    id: "news",
    providerName: "news",
    providerRole: "primary_market_data",
    priority: 0,
    supports: (request) => request.collection === "news",
    collect: async (request, signal) => {
      const result = await resolveFinanceFetch(fetchImpl)(
        `https://example.test/news/${request.instrument}`,
        { signal },
      );
      return JSON.parse(await result.text()) as FinanceMarketCollectionItem[];
    },
  };
}

function fixtureFetch(url: string): ReturnType<FetchImpl> {
  return Promise.resolve(
    response(
      url.includes("/news/")
        ? [news()]
        : quote(
            url.includes("quote-0") ? "quote-0" : "quote-1",
            url.includes("quote-0") ? "primary_market_data" : "cross_check_market_data",
          ),
    ),
  );
}

function options(fetchImpl: FetchImpl = fixtureFetch): FinanceResearchBatchOptions {
  return {
    asOf: AS_OF,
    useCase: "sentiment_and_horizon",
    correlationId: "batch-test",
    targets: [
      {
        id: "btc",
        instrument: "BTC",
        assetClass: "crypto",
        realtime: { requireOfficialReference: false },
        collections: [{ collection: "news", freshnessMaxMinutes: 60 }],
      },
      {
        id: "aapl",
        instrument: "AAPL",
        assetClass: "us_equity",
        realtime: { requireOfficialReference: false },
        collections: [{ collection: "news", freshnessMaxMinutes: 60 }],
      },
    ],
    realtimeAdapters: realtime(fetchImpl),
    collectionAdapters: [collection(fetchImpl)],
    sourceGovernance: createApiSourceGovernanceRegistry({ minIntervalMs: 0 }),
  };
}

afterEach(() => vi.useRealTimers());

describe("finance research batch runner", () => {
  it("fans out mixed targets and preserves per-job provenance in committee-compatible evidence", async () => {
    const fetchImpl = vi.fn(fixtureFetch);
    const packet = await runFinanceResearchBatch(options(fetchImpl));
    expect(packet.status).toBe("completed");
    expect(packet.jobs.map((job) => [job.targetId, job.kind])).toEqual([
      ["btc", "realtime"],
      ["btc", "collection"],
      ["aapl", "realtime"],
      ["aapl", "collection"],
    ]);
    expect(packet.budget).toMatchObject({
      requestedJobs: 4,
      completedJobs: 4,
      failedJobs: 0,
      callCount: 6,
      receiptCount: 12,
      readyJobs: 4,
      sourceGovernance: "caller_shared",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    const calls = packet.jobs.flatMap((job) => job.apiCalls);
    expect(new Set(calls.map((call) => call.callId)).size).toBe(calls.length);
    for (const job of packet.jobs) {
      expect(job.apiCalls.every((call) => call.correlationId === job.correlationId)).toBe(true);
      expect(job.apiCalls).toEqual(
        job.receipt?.sourceAttempts.flatMap((attempt) => attempt.apiCalls ?? []),
      );
      expect(job.receipt?.notTouched).toEqual(packet.notTouched);
    }
    const context = buildFinanceCommitteeContext({
      ask: "Compare sentiment",
      asOf: AS_OF,
      evidence: packet.committeeEvidence,
    });
    expect(context.decisionMode).toBe("research_only");
    expect(context.evidence).toHaveLength(5);
    expect(packet.notTouched).toContain("trading_execution");
  });

  it("keeps stable job identities across correlation IDs without pretending to cache reads", async () => {
    const fetchImpl = vi.fn(fixtureFetch);
    const first = await runFinanceResearchBatch(options(fetchImpl));
    const second = await runFinanceResearchBatch({
      ...options(fetchImpl),
      correlationId: "second-run",
    });
    expect(first.jobs.map((job) => job.idempotencyKey)).toEqual(
      second.jobs.map((job) => job.idempotencyKey),
    );
    expect(first.jobs[0].correlationId).not.toBe(second.jobs[0].correlationId);
    expect(first.jobs[0].apiCalls[0].callId).not.toBe(second.jobs[0].apiCalls[0].callId);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });

  it("enforces job concurrency and a shared source limiter across target jobs", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const fetchImpl: FetchImpl = async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return fixtureFetch(url);
    };
    const base = options(fetchImpl);
    const pending = runFinanceResearchBatch({
      ...base,
      maxConcurrency: 2,
      targets: Array.from({ length: 5 }, (_, index) => ({
        id: String(index),
        instrument: "AAPL",
        assetClass: "us_equity",
        realtime: false as const,
        collections: [{ collection: "news" as const, freshnessMaxMinutes: 60 }],
      })),
      sourceGovernance: createApiSourceGovernanceRegistry({
        minIntervalMs: 10,
        maxConcurrent: 1,
        maxQueue: 2,
      }),
    });
    await vi.runAllTimersAsync();
    const packet = await pending;
    expect(packet.budget.peakConcurrency).toBe(2);
    expect(peak).toBe(1);
    expect(packet.budget.callCount).toBe(5);
    expect(packet.budget.throttleWaitMs).toBeGreaterThan(0);
    expect(packet.jobs[4].queueWaitMs).toBeGreaterThan(0);
  });

  it.each(["stale", "conflict", "failed-source"] as const)(
    "withholds %s realtime values while retaining raw receipts",
    async (kind) => {
      const fetchImpl: FetchImpl = async (url) => {
        if (url.includes("quote-1")) {
          return kind === "failed-source"
            ? response({}, 403)
            : response(
                quote(
                  "quote-1",
                  "cross_check_market_data",
                  kind === "stale" ? OLD : FRESH,
                  kind === "conflict" ? 110 : 100,
                ),
              );
        }
        return fixtureFetch(url);
      };
      const base = options(fetchImpl);
      const packet = await runFinanceResearchBatch({
        ...base,
        targets: [{ ...base.targets[0], collections: [] }],
      });
      const job = packet.jobs[0];
      expect(["blocked", "needs_review"]).toContain(job.status);
      expect(job.receipt).toBeDefined();
      const evidence = JSON.parse(packet.committeeEvidence[1].text);
      expect(evidence.usableAsCurrentEvidence).toBe(false);
      expect(evidence.data).toBeUndefined();
      if (kind === "stale") {
        expect(job.freshnessWarnings.length).toBeGreaterThan(0);
      }
      if (kind === "conflict") {
        expect(job.conflicts).toEqual(["last_price"]);
      }
      if (kind === "failed-source") {
        expect(
          job.apiCalls.some(
            (call) => call.httpStatus === 403 && call.transportError === "forbidden",
          ),
        ).toBe(true);
      }
    },
  );

  it.each([
    [news({ sourceTimestamp: OLD })],
    [news({ sourceTimestamp: "invalid" })],
    [news({ sourceTimestamp: "2026-09-09T12:00:00Z" })],
    [news({ delayStatus: "manual_or_unknown" })],
    [news(), news({ data: { title: "Contradictory revision" } })],
  ])("does not promote invalid, stale, or contradictory collection records", async (...records) => {
    const base = options(async () => response(records));
    const packet = await runFinanceResearchBatch({
      ...base,
      targets: [{ ...base.targets[0], realtime: false }],
    });
    expect(packet.jobs[0].status).toBe("needs_review");
    expect(packet.jobs[0].receipt?.status).toBe("ready");
    expect(JSON.parse(packet.committeeEvidence[1].text).data).toBeUndefined();
  });

  it("preserves partial-source failure even when the realtime gateway itself is ready", async () => {
    const base = options();
    const extra: FinanceRealtimeSourceAdapter = {
      ...base.realtimeAdapters![0],
      id: "extra",
      priority: 9,
      collect: async () => {
        throw new Error("private upstream diagnostic");
      },
    };
    const packet = await runFinanceResearchBatch({
      ...base,
      realtimeAdapters: [...base.realtimeAdapters!, extra],
      targets: [{ ...base.targets[0], collections: [] }],
    });
    expect(packet.jobs[0].receipt?.status).toBe("ready");
    expect(packet.jobs[0].status).toBe("needs_review");
    expect(JSON.stringify(packet)).not.toContain("private upstream diagnostic");
  });

  it("reports unsupported requests as blocked without making network calls", async () => {
    const fetchImpl = vi.fn(fixtureFetch);
    const packet = await runFinanceResearchBatch({
      ...options(fetchImpl),
      realtimeAdapters: [],
      collectionAdapters: [],
    });
    expect(packet.status).toBe("blocked");
    expect(packet.budget).toMatchObject({
      failedJobs: 4,
      blockedJobs: 4,
      completedJobs: 0,
      callCount: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an oversized or invalid batch before dispatching any job", async () => {
    const fetchImpl = vi.fn(fixtureFetch);
    const base = options(fetchImpl);
    await expect(runFinanceResearchBatch({ ...base, maxJobs: 3 })).rejects.toThrow("budget");
    await expect(runFinanceResearchBatch({ ...base, targets: [] })).rejects.toThrow("empty");
    await expect(
      runFinanceResearchBatch({ ...base, targets: [base.targets[0], base.targets[0]] }),
    ).rejects.toThrow("duplicate target");
    await expect(
      runFinanceResearchBatch({
        ...base,
        targets: [
          base.targets[0],
          { ...base.targets[1], collections: [{ collection: "news", freshnessMaxMinutes: NaN }] },
        ],
      }),
    ).rejects.toThrow("freshnessMaxMinutes");
    await expect(runFinanceResearchBatch({ ...base, maxConcurrency: 0 })).rejects.toThrow(
      "maxConcurrency",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reserves a hard worst-case API budget before dispatching jobs", async () => {
    const fetchImpl = vi.fn(fixtureFetch);
    const packet = await runFinanceResearchBatch({
      ...options(fetchImpl),
      maxApiCalls: 3,
      maxSourcesPerJob: 2,
      retry: { attempts: 1 },
    });

    expect(packet.status).toBe("partial");
    expect(packet.budget).toMatchObject({
      maxApiCalls: 3,
      reservedCallBudget: 3,
      callCount: 3,
      blockedJobs: 2,
    });
    expect(packet.jobs.slice(2).every((job) => job.error === "api_call_budget_exhausted")).toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns cancellation for every queued job with no dispatch when already aborted", async () => {
    const fetchImpl = vi.fn(fixtureFetch);
    const packet = await runFinanceResearchBatch({
      ...options(fetchImpl),
      signal: AbortSignal.abort(),
    });
    expect(packet.status).toBe("cancelled");
    expect(packet.budget).toMatchObject({ cancelledJobs: 4, callCount: 0, peakConcurrency: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["cancel", "deadline"] as const)(
    "aborts in-flight HTTP and queued work on %s",
    async (kind) => {
      vi.useFakeTimers();
      let aborted = 0;
      const fetchImpl = vi.fn<FetchImpl>(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted++;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      );
      const controller = new AbortController();
      const pending = runFinanceResearchBatch({
        ...options(fetchImpl),
        signal: controller.signal,
        totalTimeoutMs: 100,
        sourceTimeoutMs: 1000,
        maxConcurrency: 1,
      });
      await vi.advanceTimersByTimeAsync(1);
      if (kind === "cancel") {
        controller.abort();
      }
      await vi.runAllTimersAsync();
      const packet = await pending;
      expect(packet.status).toBe(kind === "cancel" ? "cancelled" : "timed_out");
      expect(packet.budget.cancelledJobs + packet.budget.timedOutJobs).toBe(4);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(aborted).toBe(1);
      expect(
        packet.jobs[0].apiCalls.some(
          (call) => call.status === (kind === "cancel" ? "cancelled" : "timed_out"),
        ),
      ).toBe(true);
      expect(packet.jobs[1].missingEvidence).toContain("job_not_dispatched");
    },
  );

  it("counts retry attempts and preserves rate-limit and circuit receipts", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<FetchImpl>(async () => response({}, 429));
    const base = options(fetchImpl);
    const pending = runFinanceResearchBatch({
      ...base,
      maxConcurrency: 1,
      retry: { attempts: 2, minDelayMs: 1, maxDelayMs: 1 },
      targets: base.targets.map((target) => ({ ...target, realtime: false })),
      sourceGovernance: createApiSourceGovernanceRegistry({
        minIntervalMs: 0,
        failureThreshold: 1,
      }),
    });
    await vi.runAllTimersAsync();
    const packet = await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(packet.budget).toMatchObject({
      callCount: 3,
      rateLimitedCalls: 2,
      circuitOpenCalls: 1,
      failedJobs: 2,
    });
    expect(
      packet.jobs[0].apiCalls
        .filter((call) => call.operation === "http_get")
        .map((call) => call.attempt),
    ).toEqual([1, 2]);
  });

  it("uses the existing collection registry with injected fetch and no configured environment", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      response({
        articles: [
          {
            title: "Market headline",
            url: "https://example.test/article",
            seendate: "20260908T115900Z",
            domain: "example.test",
          },
        ],
      }),
    );
    const adapters = createFinanceMarketCollectionRegistry({ fetchImpl }).filter((adapter) =>
      adapter.id.includes("gdelt"),
    );
    expect(adapters).toHaveLength(1);
    const base = options();
    const packet = await runFinanceResearchBatch({
      ...base,
      collectionAdapters: adapters,
      targets: [{ ...base.targets[1], realtime: false }],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(
      packet.jobs[0].apiCalls.some(
        (call) => call.operation === "http_get" && call.status === "succeeded",
      ),
    ).toBe(true);
    expect(packet.jobs[0].receipt?.selectedSourceIds).toEqual([adapters[0].id]);
  });
});

it("dispatches only the requested source and reserves its multi-endpoint cost", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    calls.push(String(url));
    return response([news()]);
  };
  const chosen = collection(fetchImpl);
  const other = { ...chosen, id: "not-selected", collect: vi.fn(chosen.collect) };
  const receipt = await runFinanceResearchBatch({
    asOf: AS_OF,
    useCase: "source-coverage",
    maxApiCalls: 2,
    maxHttpCallsPerSource: 2,
    targets: [
      {
        id: "source-news",
        instrument: "AAPL",
        assetClass: "us_equity",
        realtime: false,
        sourceAdapterIds: [chosen.id],
        collections: [{ collection: "news", freshnessMaxMinutes: 60 }],
      },
    ],
    collectionAdapters: [
      {
        ...chosen,
        collect: async (request, signal) => {
          await resolveFinanceFetch(fetchImpl)("https://example.test/lookup", { signal });
          return chosen.collect(request, signal);
        },
      },
      other,
    ],
  });
  expect(receipt.budget.callCount).toBe(2);
  expect(receipt.budget.reservedCallBudget).toBe(2);
  expect(other.collect).not.toHaveBeenCalled();
  expect(receipt.jobs[0].status).toBe("ready");
  expect(calls).toHaveLength(2);
});

it("keeps single-source observations available for review without promoting their quality", async () => {
  const adapters = realtime(fixtureFetch);
  const result = await runFinanceResearchBatch({
    asOf: AS_OF,
    useCase: "all-source-review",
    includeReviewEvidence: true,
    targets: [
      {
        id: "isolated-primary",
        sourceAdapterIds: [adapters[0].id],
        instrument: "AAPL",
        assetClass: "us_equity",
      },
    ],
    realtimeAdapters: adapters,
  });
  const evidence = JSON.parse(result.committeeEvidence[1].text);
  expect(evidence.usableAsCurrentEvidence).toBe(false);
  expect(evidence.data).toBeUndefined();
  expect(evidence.reviewData.snapshot.normalizedFields.length).toBeGreaterThan(0);
  expect(evidence.reviewBoundary).toContain("not_verified_current_evidence");
  expect(result.jobs[0].status).toBe("blocked");
});
