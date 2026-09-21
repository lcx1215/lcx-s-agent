import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runFinanceResearchBatch,
  type FinanceResearchBatchOptions,
} from "./finance-research-batch-runner.js";
import * as checkpoints from "./finance-run-checkpoints.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-resume-"));
  directories.push(dir);
  const calls: string[] = [];
  const asOf = "2026-09-08T00:00:00Z";
  const options: FinanceResearchBatchOptions = {
    asOf,
    useCase: "checkpoint-acceptance",
    maxApiCalls: 3,
    // This fixture models one endpoint per source; production reserves two by default.
    maxHttpCallsPerSource: 1,
    maxConcurrency: 1,
    checkpoint: {
      path: path.join(dir, "source.sqlite"),
      runId: "run-1",
      executionFingerprint: "fixture-v1",
    },
    targets: ["SPY", "QQQ", "IWM"].map((instrument) => ({
      id: instrument,
      instrument,
      assetClass: "us_equity",
      realtime: false,
      collections: [{ collection: "news", freshnessMaxMinutes: 60 }],
    })),
    realtimeAdapters: [],
    collectionAdapters: [
      {
        id: "fixture",
        providerName: "fixture",
        providerRole: "primary_market_data",
        priority: 1,
        supports: () => true,
        collect: async (request) => {
          calls.push(request.instrument);
          return [
            {
              itemId: request.instrument,
              collection: "news",
              providerName: "fixture",
              providerRole: "primary_market_data",
              sourceFamily: "market_data_api",
              sourceTimestamp: asOf,
              observedAt: asOf,
              delayStatus: "realtime",
              sourceUrlOrArtifact: "fixture://news",
              data: { title: "bounded source evidence" },
            },
          ];
        },
      },
    ],
  };
  return { options, calls };
}
describe("finance batch restart", () => {
  it("reuses all completed nodes without dispatch or additional budget", async () => {
    const { options, calls } = await fixture();
    const first = await runFinanceResearchBatch(options);
    const resumed = await runFinanceResearchBatch({ ...options, correlationId: "new-process" });
    expect(calls).toEqual(["SPY", "QQQ", "IWM"]);
    expect(resumed.jobs).toEqual(first.jobs);
    expect(resumed.checkpoint?.reusedJobIds).toHaveLength(3);
    expect(resumed.budget.reservedCallBudget).toBe(3);
    expect(resumed.status).toBe("completed");
  });
  it("continues undispatched nodes after cancellation and retains charged failed nodes", async () => {
    const { options, calls } = await fixture();
    const controller = new AbortController();
    const adapter = options.collectionAdapters![0];
    const interrupted = {
      ...adapter,
      collect: async (...args: Parameters<typeof adapter.collect>) => {
        const result = await adapter.collect(...args);
        if (args[0].instrument === "QQQ") {
          controller.abort();
        }
        return result;
      },
    };
    const first = await runFinanceResearchBatch({
      ...options,
      signal: controller.signal,
      collectionAdapters: [interrupted],
    });
    expect(first.jobs[0].status).toBe("ready");
    expect(calls).toEqual(["SPY", "QQQ"]);
    const resumed = await runFinanceResearchBatch(options);
    expect(calls).toEqual(["SPY", "QQQ", "IWM"]);
    expect(resumed.checkpoint?.reusedJobIds).toHaveLength(2);
    expect(resumed.jobs[2].status).toBe("ready");
    expect(resumed.budget.reservedCallBudget).toBe(3);
  });
  it("rejects a changed observation date before dispatch", async () => {
    const { options, calls } = await fixture();
    await runFinanceResearchBatch(options);
    await expect(
      runFinanceResearchBatch({ ...options, asOf: "2026-09-09T00:00:00Z" }),
    ).rejects.toThrow("mismatch");
    expect(calls).toHaveLength(3);
  });
  it("retains the default two-call reservation across a restart", async () => {
    const { options, calls } = await fixture();
    const defaults = { ...options, maxHttpCallsPerSource: undefined };
    const first = await runFinanceResearchBatch(defaults);
    const resumed = await runFinanceResearchBatch(defaults);
    expect(calls).toEqual(["SPY"]);
    expect(resumed.jobs[0]).toEqual(first.jobs[0]);
    expect(first.budget.reservedCallBudget).toBe(2);
    expect(resumed.checkpoint?.reusedJobIds).toEqual([first.jobs[0].jobId]);
    expect(resumed.budget.reservedCallBudget).toBe(2);
    expect(resumed.jobs[1].missingEvidence).toContain("api_call_budget_exhausted");
    expect(resumed.jobs[2].missingEvidence).toContain("api_call_budget_exhausted");
  });
  it("does not recover exhausted budget by restarting", async () => {
    const { options, calls } = await fixture();
    await runFinanceResearchBatch({ ...options, maxApiCalls: 1 });
    const resumed = await runFinanceResearchBatch({ ...options, maxApiCalls: 1 });
    expect(calls).toEqual(["SPY"]);
    expect(resumed.budget.reservedCallBudget).toBe(1);
    expect(resumed.jobs[1].missingEvidence).toContain("api_call_budget_exhausted");
  });
  it("does not redispatch after result persistence fails", async () => {
    const { options, calls } = await fixture();
    const open = checkpoints.openFinanceRunCheckpoints;
    const spy = vi.spyOn(checkpoints, "openFinanceRunCheckpoints").mockImplementation((...args) => {
      const store = open(...args);
      return {
        ...store,
        complete: () => {
          throw new Error("fixture storage failure");
        },
      };
    });
    try {
      await expect(runFinanceResearchBatch(options)).rejects.toThrow("fixture storage failure");
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual(["SPY"]);
    const resumed = await runFinanceResearchBatch(options);
    expect(calls).toEqual(["SPY", "QQQ", "IWM"]);
    expect(resumed.checkpoint?.uncertainJobIds).toHaveLength(1);
    expect(resumed.jobs[0].status).toBe("needs_review");
    expect(resumed.jobs[0].missingEvidence).toContain("checkpoint_dispatch_outcome_unknown");
    expect(resumed.budget.reservedCallBudget).toBe(3);
    expect(resumed.status).toBe("partial");
  });
});
