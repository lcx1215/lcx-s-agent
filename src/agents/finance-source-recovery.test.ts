import { describe, expect, it, vi } from "vitest";
import { ApiCallError } from "./api-call-contract.js";
import type { FinanceMarketCollectionAdapter } from "./finance-market-collection-registry.js";
import {
  buildFinanceSourceRecoveryPlan,
  runFinanceSourceRecovery,
} from "./finance-source-recovery.js";

const AS_OF = "2026-09-10T08:00:00.000Z";
function job(id: string, transportError = "budget_exhausted", httpStatus?: number) {
  return {
    jobId: id,
    targetId: id,
    kind: "collection",
    sourceAdapterIds: ["fixture"],
    status: "blocked",
    freshnessMaxMinutes: 60,
    request: { instrument: "SPY", assetClass: "us_equity", collection: "news", limit: 2 },
    apiCalls: [{ status: "failed", finishedAt: AS_OF, transportError, httpStatus }],
    missingEvidence: ["successful_finance_market_collection"],
    freshnessWarnings: [],
    conflicts: [],
  };
}
function batch<T>(jobs: T[]) {
  return {
    schemaVersion: "lcx_finance_research_batch_v1",
    boundary: "finance_research_batch_research_only",
    correlationId: "original",
    asOf: AS_OF,
    jobs,
  };
}

describe("finance source recovery", () => {
  it("keeps unknown dispatch reconciliation ahead of a reported payment denial", () => {
    const source = batch([
      {
        ...job("unknown-payment", "http_error", 402),
        missingEvidence: ["checkpoint_dispatch_outcome_unknown"],
      },
    ]);
    expect(buildFinanceSourceRecoveryPlan(source, AS_OF).entries[0].action).toBe(
      "reconcile_dispatch",
    );
  });

  it.each([
    { transportError: "network_error", networkCode: "ECONNRESET", action: "retry" },
    { transportError: "timeout", action: "retry" },
    { transportError: "http_error", httpStatus: 503, action: "retry" },
    { transportError: "http_error", httpStatus: 402, action: "resolve_access" },
    { transportError: "forbidden", httpStatus: 403, action: "resolve_access" },
    { transportError: "network_error", networkCode: "CERT_HAS_EXPIRED", action: "review_evidence" },
  ])(
    "keeps the underlying HTTP classification through a collect wrapper: $transportError $networkCode $httpStatus",
    ({ action, ...failure }) => {
      const source = batch([
        {
          ...job("macro"),
          apiCalls: [
            {
              status: "failed",
              finishedAt: AS_OF,
              operation: "http_get",
              source: "treasury",
              ...failure,
            },
            {
              status: "failed",
              finishedAt: AS_OF,
              operation: "collect",
              source: "treasury",
              transportError: "source_error",
            },
          ],
        },
      ]);
      expect(buildFinanceSourceRecoveryPlan(source, AS_OF).entries[0].action).toBe(action);
    },
  );

  it("keeps an independent adapter parse failure reviewable despite another source's reset", () => {
    const source = batch([
      {
        ...job("mixed"),
        apiCalls: [
          {
            status: "failed",
            finishedAt: AS_OF,
            operation: "http_get",
            source: "first",
            transportError: "network_error",
            networkCode: "ECONNRESET",
          },
          {
            status: "failed",
            finishedAt: AS_OF,
            operation: "collect",
            source: "second",
            transportError: "source_error",
          },
        ],
      },
    ]);
    expect(buildFinanceSourceRecoveryPlan(source, AS_OF).entries[0].action).toBe("review_evidence");
  });

  it("separates transient, permission, quality and unknown-dispatch failures", () => {
    const plan = buildFinanceSourceRecoveryPlan(
      batch([
        { ...job("ready"), status: "ready" },
        job("budget"),
        job("timeout", "timeout"),
        job("access", "forbidden", 403),
        { ...job("uncertain"), missingEvidence: ["checkpoint_dispatch_outcome_unknown"] },
        { ...job("review"), status: "needs_review" },
        job("parse", "source_error"),
        {
          ...job("tls", "network_error"),
          apiCalls: [
            {
              ...job("tls").apiCalls[0],
              transportError: "network_error",
              networkCode: "CERT_HAS_EXPIRED",
            },
          ],
        },
      ]),
      AS_OF,
    );
    expect(plan.entries.map((entry) => entry.action)).toEqual([
      "preserve",
      "retry",
      "retry",
      "resolve_access",
      "reconcile_dispatch",
      "review_evidence",
      "review_evidence",
      "review_evidence",
    ]);
    expect(plan.targets.map((target) => target.id)).toEqual(["budget", "timeout"]);
  });

  it.each(["rate_limited", "budget_exhausted"])(
    "honors retry-after for %s without sleeping or dispatching early",
    (kind) => {
      const throttled = job("throttled", kind, kind === "rate_limited" ? 429 : undefined);
      const source = batch([
        { ...throttled, apiCalls: [{ ...throttled.apiCalls[0], retryAfterMs: 120_000 }] },
      ]);
      expect(buildFinanceSourceRecoveryPlan(source, AS_OF).entries[0]).toMatchObject({
        action: "wait",
        retryAt: "2026-09-10T08:02:00.000Z",
      });
      expect(
        buildFinanceSourceRecoveryPlan(source, "2026-09-10T08:02:00.000Z").entries[0].action,
      ).toBe("retry");
    },
  );

  it("does not retry a successful transport to repair missing cross-source evidence", () => {
    const source = batch([
      {
        ...job("crosscheck"),
        apiCalls: [{ status: "succeeded", finishedAt: AS_OF }],
        missingEvidence: ["cross_check_market_data_provider"],
      },
    ]);
    expect(buildFinanceSourceRecoveryPlan(source, AS_OF).targets).toEqual([]);
  });

  it("preserves macro series and historical windows in the recovery request", () => {
    const source = batch([
      {
        ...job("macro"),
        request: {
          instrument: "DGS10",
          assetClass: "macro",
          collection: "macro_series",
          seriesId: "DGS10",
          fromDate: "2026-01-01",
          toDate: "2026-09-09",
          limit: 200,
        },
      },
    ]);
    expect(buildFinanceSourceRecoveryPlan(source, AS_OF).targets[0].collections?.[0]).toMatchObject(
      { seriesId: "DGS10", fromDate: "2026-01-01", toDate: "2026-09-09", limit: 200 },
    );
  });

  it("executes only selected retry jobs and leaves original success and access failures untouched", async () => {
    const collect = vi.fn<FinanceMarketCollectionAdapter["collect"]>(async () => [
      {
        itemId: "article",
        collection: "news",
        providerName: "fixture",
        providerRole: "primary_market_data",
        sourceFamily: "market_data_api",
        sourceTimestamp: AS_OF,
        observedAt: AS_OF,
        delayStatus: "realtime",
        sourceUrlOrArtifact: "fixture://news",
        data: { title: "SPY market news" },
      },
    ]);
    const adapter: FinanceMarketCollectionAdapter = {
      id: "fixture",
      providerName: "fixture",
      providerRole: "primary_market_data",
      priority: 0,
      supports: () => true,
      collect,
    };
    const original = batch([
      { ...job("ready"), status: "ready" },
      job("retry-1"),
      job("retry-2"),
      job("access", "forbidden", 403),
    ]);
    const frozen = JSON.stringify(original);
    const options = {
      asOf: AS_OF,
      live: false,
      maxJobs: 1,
      batchOptions: { collectionAdapters: [adapter], realtimeAdapters: [], maxApiCalls: 2 },
    };
    const planned = await runFinanceSourceRecovery(original, options);
    expect(planned.status).toBe("planned");
    expect(collect).not.toHaveBeenCalled();
    const executed = await runFinanceSourceRecovery(original, { ...options, live: true });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(executed.selectedParentJobIds).toEqual(["retry-1"]);
    expect(executed.deferredParentJobIds).toEqual(["retry-2"]);
    expect(executed.batch?.jobs[0]).toMatchObject({ targetId: "retry-1", status: "ready" });
    expect(executed.adopted).toBe(false);
    expect(JSON.stringify(original)).toBe(frozen);
    const resumed = await runFinanceSourceRecovery(executed, { ...options, live: true });
    expect(resumed.selectedParentJobIds).toEqual(["retry-2"]);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(resumed.recoveryState.jobs.filter((entry) => entry.status === "ready")).toHaveLength(3);
    expect(resumed.recoveryState.jobs.find((entry) => entry.jobId === "access")?.status).toBe(
      "blocked",
    );
  });

  it("narrows multi-source jobs to the explicitly selected adapter", async () => {
    const source = batch([
      { ...job("two"), sourceAdapterIds: ["primary", "secondary"] },
      { ...job("other"), sourceAdapterIds: ["other"] },
    ]);
    const calls: string[] = [];
    const adapters: FinanceMarketCollectionAdapter[] = ["primary", "secondary", "other"].map(
      (id) => ({
        id,
        providerName: id,
        providerRole: "primary_market_data",
        priority: 0,
        supports: () => true,
        collect: async () => {
          calls.push(id);
          return [];
        },
      }),
    );
    const result = await runFinanceSourceRecovery(source, {
      asOf: AS_OF,
      live: true,
      maxJobs: 2,
      sourceAdapterIds: ["secondary"],
      batchOptions: { realtimeAdapters: [], collectionAdapters: adapters, maxSourcesPerJob: 2 },
    });
    expect(result.selectedParentJobIds).toEqual(["two"]);
    expect(result.excludedParentJobIds).toEqual(["other"]);
    expect(calls).toEqual(["secondary"]);
    expect(result.recoveryState.jobs.map((entry) => entry.jobId)).toEqual([
      "two",
      result.batch?.jobs[0].jobId,
      "other",
    ]);
    expect(
      result.recoveryState.jobs.find((entry) => entry.jobId === "two")?.sourceAdapterIds,
    ).toEqual(["primary"]);
  });

  it("applies an explicit source selection to an originally unpinned job", async () => {
    const source = batch([{ ...job("unpin"), sourceAdapterIds: undefined }]);
    const calls: string[] = [];
    const adapter: FinanceMarketCollectionAdapter = {
      id: "selected",
      providerName: "selected",
      providerRole: "primary_market_data",
      priority: 0,
      supports: () => true,
      collect: async () => {
        calls.push("selected");
        return [];
      },
    };
    const result = await runFinanceSourceRecovery(source, {
      asOf: AS_OF,
      live: true,
      maxJobs: 1,
      sourceAdapterIds: ["selected"],
      batchOptions: { realtimeAdapters: [], collectionAdapters: [adapter] },
    });
    expect(result.selectedParentJobIds).toEqual(["unpin"]);
    expect(calls).toEqual(["selected"]);
  });
  it.each(["named", "anonymous"])(
    "preserves original unpinned %s failures when only one selected source recovers",
    async (failureScope) => {
      const original = batch([
        {
          ...job("unpin", "timeout"),
          sourceAdapterIds: undefined,
          apiCalls:
            failureScope === "named"
              ? ["source-a", "source-b"].map((source) => ({
                  status: "failed",
                  source,
                  transportError: "timeout",
                  finishedAt: AS_OF,
                }))
              : [{ status: "failed", transportError: "timeout", finishedAt: AS_OF }],
        },
      ]);
      const originalJson = JSON.stringify(original);
      const calls: string[] = [];
      let sourceReturnsEvidence = true;
      const adapters: FinanceMarketCollectionAdapter[] = ["source-a", "source-b"].map((id) => ({
        id,
        providerName: id,
        providerRole: "primary_market_data",
        priority: 0,
        supports: () => true,
        collect: async () => {
          calls.push(id);
          if (!sourceReturnsEvidence) {
            return [];
          }
          return [
            {
              itemId: "recovered-news",
              collection: "news",
              providerName: id,
              providerRole: "primary_market_data",
              sourceFamily: "market_data_api",
              sourceTimestamp: AS_OF,
              observedAt: AS_OF,
              delayStatus: "realtime",
              sourceUrlOrArtifact: "fixture://recovered-news",
              data: { title: "SPY market news" },
            },
          ];
        },
      }));
      const options = {
        asOf: AS_OF,
        live: true,
        maxJobs: 1,
        sourceAdapterIds: ["source-b"],
        batchOptions: {
          realtimeAdapters: [],
          collectionAdapters: adapters,
          maxSourcesPerJob: 1,
          maxApiCalls: 1,
        },
      };
      const result = await runFinanceSourceRecovery(original, options);
      expect(calls).toEqual(["source-b"]);
      expect(result.batch?.jobs[0].status).toBe("ready");
      expect(result.recoveryState.jobs.find((entry) => entry.jobId === "unpin")).toMatchObject(
        original.jobs[0],
      );
      expect(
        result.recoveryState.jobs.find((entry) => entry.jobId === "unpin")?.sourceAdapterIds,
      ).toBeUndefined();
      const next = buildFinanceSourceRecoveryPlan(result, AS_OF);
      expect(next.entries.find((entry) => entry.parentJobId === "unpin")?.action).toBe("retry");
      expect(next.targets.find((entry) => entry.id === "unpin")?.sourceAdapterIds).toBeUndefined();
      expect(result.recoveryState.jobs.find((entry) => entry.status === "ready")).toMatchObject({
        parentJobId: "unpin",
        targetId: "unpin",
        latestAttemptJobId: result.batch?.jobs[0].jobId,
        sourceAdapterIds: ["source-b"],
      });
      expect(JSON.stringify(original)).toBe(originalJson);
      expect(result.adopted).toBe(false);
      expect(result.recoveryState).toMatchObject({
        originalCorrelationId: "original",
        originalAsOf: AS_OF,
      });
      const anotherSubset = await runFinanceSourceRecovery(result, {
        ...options,
        sourceAdapterIds: ["source-a"],
      });
      expect(calls).toEqual(["source-b", "source-a"]);
      expect(
        anotherSubset.recoveryState.jobs.find((entry) =>
          entry.sourceAdapterIds?.includes("source-b"),
        )?.status,
      ).toBe("ready");
      expect(
        anotherSubset.recoveryState.jobs.find((entry) => entry.jobId === "unpin")?.sourceAdapterIds,
      ).toBeUndefined();
      expect(
        buildFinanceSourceRecoveryPlan(anotherSubset, AS_OF).entries.find(
          (entry) => entry.parentJobId === "unpin",
        )?.action,
      ).toBe("retry");
      sourceReturnsEvidence = false;
      const repeated = await runFinanceSourceRecovery(
        {
          ...anotherSubset,
          recoveryState: {
            ...anotherSubset.recoveryState,
            jobs: anotherSubset.recoveryState.jobs.toReversed(),
          },
        },
        options,
      );
      expect(calls).toEqual(["source-b", "source-a", "source-b"]);
      expect(repeated.recoveryState.jobs).toHaveLength(3);
      expect(new Set(repeated.recoveryState.jobs.map((entry) => entry.jobId)).size).toBe(3);
      expect(
        repeated.recoveryState.jobs.find((entry) => entry.sourceAdapterIds?.includes("source-a"))
          ?.status,
      ).toBe("ready");
      expect(repeated.recoveryState.jobs.find((entry) => entry.jobId === "unpin")).toMatchObject(
        original.jobs[0],
      );
      expect(
        repeated.recoveryState.jobs.find((entry) => entry.sourceAdapterIds?.includes("source-b"))
          ?.status,
      ).toBe("blocked");
      expect(() => buildFinanceSourceRecoveryPlan(repeated, AS_OF)).not.toThrow();
      const child = result.recoveryState.jobs.find((entry) => entry.parentJobId === "unpin")!;
      const conflicting = {
        ...result,
        recoveryState: {
          ...result.recoveryState,
          jobs: result.recoveryState.jobs.map((entry) =>
            entry.jobId === child.jobId
              ? { ...entry, parentJobId: "unrelated-original", status: "blocked" }
              : entry,
          ),
        },
      };
      await expect(runFinanceSourceRecovery(conflicting, options)).rejects.toThrow(
        "recovery attempt identity conflicts",
      );
    },
  );

  it.each([
    { reversed: false, filtered: true },
    { reversed: true, filtered: true },
    { reversed: false, filtered: false },
    { reversed: true, filtered: false },
  ])(
    "does not dispatch overlapping unpinned parent and retryable child together (reversed=$reversed filtered=$filtered)",
    async ({ reversed, filtered }) => {
      const original = batch([
        {
          ...job("unpin", "timeout"),
          sourceAdapterIds: undefined,
          apiCalls: ["source-a", "source-b"].map((source) => ({
            status: "failed",
            source,
            transportError: "timeout",
            finishedAt: AS_OF,
          })),
        },
      ]);
      const collect = vi.fn<FinanceMarketCollectionAdapter["collect"]>(async () => {
        throw new ApiCallError("timeout");
      });
      const adapter: FinanceMarketCollectionAdapter = {
        id: "source-b",
        providerName: "source-b",
        providerRole: "primary_market_data",
        priority: 0,
        supports: () => true,
        collect,
      };
      const options = {
        asOf: AS_OF,
        live: true,
        maxJobs: 2,
        sourceAdapterIds: ["source-b"],
        batchOptions: {
          realtimeAdapters: [],
          collectionAdapters: [adapter],
          maxSourcesPerJob: 1,
          maxApiCalls: 2,
        },
      };
      const first = await runFinanceSourceRecovery(original, options);
      const child = first.recoveryState.jobs.find((entry) => entry.parentJobId === "unpin")!;
      expect(
        buildFinanceSourceRecoveryPlan(first, AS_OF).entries.filter(
          (entry) => entry.action === "retry",
        ),
      ).toHaveLength(2);
      collect.mockClear();
      const input = {
        ...first,
        recoveryState: {
          ...first.recoveryState,
          jobs: reversed ? first.recoveryState.jobs.toReversed() : first.recoveryState.jobs,
        },
      };
      const result = await runFinanceSourceRecovery(input, {
        ...options,
        sourceAdapterIds: filtered ? options.sourceAdapterIds : undefined,
      });
      expect(collect).toHaveBeenCalledTimes(1);
      expect(result.selectedParentJobIds).toHaveLength(1);
      expect(result.deferredParentJobIds).toEqual([reversed ? "unpin" : child.jobId]);
      expect(result.batch?.jobs).toHaveLength(1);
      const retainedParent = result.recoveryState.jobs.find((entry) => entry.jobId === "unpin")!;
      expect(retainedParent.sourceAdapterIds).toBeUndefined();
      expect(retainedParent.apiCalls).toEqual(expect.arrayContaining(original.jobs[0].apiCalls));
      const currentAttempt = result.batch!.jobs[0];
      const observedState = result.recoveryState.jobs.find(
        (entry) => entry.latestAttemptJobId === currentAttempt.jobId,
      )!;
      for (const call of currentAttempt.apiCalls) {
        expect(observedState.apiCalls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: call.status,
              source: call.source,
              operation: call.operation,
              transportError: call.transportError,
              finishedAt: call.finishedAt,
            }),
          ]),
        );
      }
      expect(observedState.latestAttemptJobId).toBe(currentAttempt.jobId);
      expect(() => buildFinanceSourceRecoveryPlan(result, AS_OF)).not.toThrow();
    },
  );

  it("keeps disjoint pinned parent and child scopes concurrently retryable", async () => {
    const original = batch([
      { ...job("pinned", "timeout"), sourceAdapterIds: ["source-a", "source-b"] },
    ]);
    const calls: string[] = [];
    const adapters: FinanceMarketCollectionAdapter[] = ["source-a", "source-b"].map((id) => ({
      id,
      providerName: id,
      providerRole: "primary_market_data",
      priority: 0,
      supports: () => true,
      collect: async () => {
        calls.push(id);
        throw new ApiCallError("timeout");
      },
    }));
    const options = {
      asOf: AS_OF,
      live: true,
      maxJobs: 2,
      batchOptions: {
        realtimeAdapters: [],
        collectionAdapters: adapters,
        maxSourcesPerJob: 1,
        maxApiCalls: 2,
      },
    };
    const first = await runFinanceSourceRecovery(original, {
      ...options,
      sourceAdapterIds: ["source-b"],
    });
    calls.splice(0);
    const result = await runFinanceSourceRecovery(first, options);
    expect(calls).toEqual(["source-a", "source-b"]);
    expect(result.selectedParentJobIds).toHaveLength(2);
    expect(result.deferredParentJobIds).toEqual([]);
    expect(result.batch?.jobs).toHaveLength(2);
    for (const attempt of result.batch?.jobs ?? []) {
      const state = result.recoveryState.jobs.find(
        (entry) => entry.latestAttemptJobId === attempt.jobId,
      )!;
      expect(attempt.apiCalls).toMatchObject(state.apiCalls);
    }
    expect(() => buildFinanceSourceRecoveryPlan(result, AS_OF)).not.toThrow();
  });

  it.each(["quality", "access"])(
    "retains old unknown-scope failures while honoring the fresh unfiltered %s gate",
    async (outcome) => {
      const original = batch([
        {
          ...job("unpin", "timeout"),
          sourceAdapterIds: undefined,
          apiCalls: [
            { status: "failed", source: "source-a", transportError: "timeout", finishedAt: AS_OF },
          ],
        },
      ]);
      const adapter: FinanceMarketCollectionAdapter = {
        id: "source-b",
        providerName: "source-b",
        providerRole: "primary_market_data",
        priority: 0,
        supports: () => true,
        collect: async () => {
          if (outcome === "access") {
            throw new ApiCallError("forbidden", 403);
          }
          return [
            {
              itemId: "future-news",
              collection: "news",
              providerName: "source-b",
              providerRole: "primary_market_data",
              sourceFamily: "market_data_api",
              sourceTimestamp: "2026-09-10T08:01:00Z",
              observedAt: AS_OF,
              delayStatus: "realtime",
              sourceUrlOrArtifact: "fixture://news",
              data: { title: "SPY market news" },
            },
          ];
        },
      };
      const result = await runFinanceSourceRecovery(original, {
        asOf: AS_OF,
        live: true,
        maxJobs: 1,
        batchOptions: {
          realtimeAdapters: [],
          collectionAdapters: [adapter],
          maxSourcesPerJob: 1,
          maxApiCalls: 1,
        },
      });
      const retained = result.recoveryState.jobs.find((entry) => entry.jobId === "unpin")!;
      expect(retained.apiCalls).toEqual(expect.arrayContaining(original.jobs[0].apiCalls));
      expect(retained.sourceAdapterIds).toBeUndefined();
      expect(retained.latestAttemptJobId).toBe(result.batch?.jobs[0].jobId);
      expect(
        buildFinanceSourceRecoveryPlan(result, AS_OF).entries.find(
          (entry) => entry.parentJobId === "unpin",
        )?.action,
      ).toBe(outcome === "access" ? "resolve_access" : "review_evidence");
    },
  );

  it.each(["unfiltered", "pinned-subset"])(
    "preserves the original %s recovery semantics",
    async (scope) => {
      const original = batch([
        {
          ...job("parent", "timeout"),
          sourceAdapterIds: scope === "unfiltered" ? undefined : ["source-a", "source-b"],
        },
      ]);
      const calls: string[] = [];
      const adapters: FinanceMarketCollectionAdapter[] = ["source-a", "source-b"].map((id) => ({
        id,
        providerName: id,
        providerRole: "primary_market_data",
        priority: 0,
        supports: () => true,
        collect: async () => {
          calls.push(id);
          return [
            {
              itemId: id,
              collection: "news",
              providerName: id,
              providerRole: "primary_market_data",
              sourceFamily: "market_data_api",
              sourceTimestamp: AS_OF,
              observedAt: AS_OF,
              delayStatus: "realtime",
              sourceUrlOrArtifact: `fixture://${id}`,
              data: { title: "SPY market news" },
            },
          ];
        },
      }));
      const result = await runFinanceSourceRecovery(original, {
        asOf: AS_OF,
        live: true,
        maxJobs: 1,
        ...(scope === "pinned-subset" ? { sourceAdapterIds: ["source-b"] } : {}),
        batchOptions: {
          realtimeAdapters: [],
          collectionAdapters: adapters,
          maxSourcesPerJob: 2,
          maxApiCalls: 2,
        },
      });
      expect(result.batch?.jobs[0].status).toBe("ready");
      if (scope === "unfiltered") {
        expect(calls).toEqual(["source-a", "source-b"]);
        expect(result.recoveryState.jobs).toHaveLength(1);
        expect(result.recoveryState.jobs[0]).toMatchObject({ jobId: "parent", status: "ready" });
        expect(result.recoveryState.jobs[0].sourceAdapterIds).toBeUndefined();
        expect(buildFinanceSourceRecoveryPlan(result, AS_OF).targets).toEqual([]);
      } else {
        expect(calls).toEqual(["source-b"]);
        expect(result.recoveryState.jobs.find((entry) => entry.jobId === "parent")).toMatchObject({
          status: "blocked",
          sourceAdapterIds: ["source-a"],
        });
        expect(result.recoveryState.jobs.find((entry) => entry.status === "ready")).toMatchObject({
          parentJobId: "parent",
          sourceAdapterIds: ["source-b"],
        });
      }
    },
  );

  it("rejects malformed, duplicate and backwards-time inputs before execution", () => {
    expect(() => buildFinanceSourceRecoveryPlan({}, AS_OF)).toThrow();
    expect(() =>
      buildFinanceSourceRecoveryPlan({ batch: batch([]), recoveryState: {} }, AS_OF),
    ).toThrow();
    expect(() => buildFinanceSourceRecoveryPlan(batch([job("same"), job("same")]), AS_OF)).toThrow(
      "duplicate",
    );
    expect(() =>
      buildFinanceSourceRecoveryPlan(batch([job("one")]), "2026-09-09T08:00:00Z"),
    ).toThrow("precede");
  });
});
