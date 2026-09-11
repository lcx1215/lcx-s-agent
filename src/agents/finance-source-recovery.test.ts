import { describe, expect, it, vi } from "vitest";
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
function batch(jobs: unknown[]) {
  return {
    schemaVersion: "lcx_finance_research_batch_v1",
    boundary: "finance_research_batch_research_only",
    correlationId: "original",
    asOf: AS_OF,
    jobs,
  };
}

describe("finance source recovery", () => {
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
