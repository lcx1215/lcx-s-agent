import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiCallError } from "./api-call-contract.js";
import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";
import {
  planFinanceSourceHeartbeat,
  readFinanceSourceHeartbeat,
  runFinanceSourceHeartbeat,
} from "./finance-source-heartbeat.js";

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
});
