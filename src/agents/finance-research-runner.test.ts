import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import { resolveFinanceFetch } from "./finance-live-market-source.js";
import type {
  FinanceMarketCollectionAdapter,
  FinanceMarketCollectionItem,
} from "./finance-market-collection-registry.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";
import {
  buildDefaultFinanceResearchTargets,
  runFinanceResearchRun,
} from "./finance-research-runner.js";

const AS_OF = "2026-09-08T12:00:00.000Z";

function realtimeObservation(
  providerName: string,
  providerRole: FinanceDataGatewayObservationInput["providerRole"],
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
        value: 100,
        currency: "USD",
        adjusted: false,
        fieldDefinition: "synthetic current price",
        sourceTimestamp: AS_OF,
        sourceUrlOrArtifact: `fixture://${providerName}/price`,
      },
    ],
  };
}

function realtimeAdapter(
  id: string,
  providerRole: FinanceRealtimeSourceAdapter["providerRole"],
): FinanceRealtimeSourceAdapter {
  return {
    id,
    providerName: id,
    providerRole,
    priority: 1,
    supports: () => true,
    collect: async () => realtimeObservation(id, providerRole),
  };
}

function collectionAdapter(): FinanceMarketCollectionAdapter {
  return {
    id: "fixture_collection",
    providerName: "fixture-collection",
    providerRole: "primary_market_data",
    priority: 1,
    supports: () => true,
    collect: async (request) => {
      const item: FinanceMarketCollectionItem = {
        itemId: `${request.instrument}-${request.collection}-1`,
        collection: request.collection,
        providerName: "fixture-collection",
        providerRole: "primary_market_data",
        sourceFamily: "market_data_api",
        sourceTimestamp: AS_OF,
        observedAt: AS_OF,
        delayStatus: "realtime",
        sourceUrlOrArtifact: "fixture://collection",
        data: { close: 100, title: "bounded fixture evidence" },
      };
      return [item];
    },
  };
}

async function modelInvoker(request: unknown): Promise<unknown> {
  const payload = request as {
    stage?: string;
    evidence?: readonly { id: string }[];
  };
  if (payload.stage === "intake") {
    return { kind: "plan", requirements: ["timestamped evidence"], missingEvidence: [] };
  }
  if (payload.stage === "draft" || payload.stage === "format") {
    const evidenceId = payload.evidence?.[0]?.id ?? "finance-batch-summary";
    return {
      kind: "artifact",
      artifact: {
        supportingAnalysis: {
          causalHypotheses: ["liquidity", "earnings"].map((id) => ({
            id,
            cause: id,
            effect: "repricing",
            mechanism: "discount rate or cash flow",
            evidenceIds: [evidenceId],
            alternativeExplanations: ["risk premium change"],
            disconfirmingTest: "compare control windows",
            status: "hypothesis",
          })),
          scenarios: ["base", "up", "down"].map((id, index) => ({
            id,
            probability: [0.5, 0.3, 0.2][index],
            condition: id,
            expectedEffect: "conditional repricing",
            invalidation: "policy surprise",
            evidenceIds: [evidenceId],
          })),
        },
        answer:
          "Research-only quarterly outlook: the supplied evidence supports a bounded candidate view with explicit uncertainty and invalidation checks.",
        claims: [
          {
            id: "claim-1",
            text: "The current evidence packet is usable only within its timestamps and source coverage.",
            status: "supported",
            evidenceIds: [evidenceId],
          },
        ],
      },
    };
  }
  return {
    kind: "review",
    review: { verdict: "pass", criticalFindings: [], evidenceGaps: [], notes: [] },
  };
}

const BATCH_OPTIONS = {
  realtimeAdapters: [
    realtimeAdapter("fixture_primary", "primary_market_data"),
    realtimeAdapter("fixture_cross_check", "cross_check_market_data"),
  ],
  collectionAdapters: [collectionAdapter()],
  maxSourcesPerJob: 2,
  maxConcurrency: 2,
  sourceTimeoutMs: 1_000,
  totalTimeoutMs: 10_000,
} as const;

describe("finance research runner", () => {
  it("builds an explicit six-month target window and preserves research boundaries", () => {
    const targets = buildDefaultFinanceResearchTargets(
      "分析未来半年美股和加密货币市场情绪，并考虑美国中期选举。",
      6,
      AS_OF,
    );
    const history = targets
      .flatMap((target) => target.collections ?? [])
      .filter((collection) => collection.collection === "eod_history");

    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history.every((collection) => collection.fromDate === "2026-03-08")).toBe(true);
    expect(history.every((collection) => collection.toDate === "2026-09-07")).toBe(true);
    expect(targets.some((target) => target.assetClass === "crypto")).toBe(true);
    expect(targets.some((target) => target.assetClass === "us_equity")).toBe(true);
  });

  it("runs a dry plan without invoking a source or model", async () => {
    const result = await runFinanceResearchRun({
      input: {
        ask: "分析未来半年美股和比特币的市场情绪。",
        asOf: AS_OF,
        horizonMonths: 6,
        targets: [
          {
            id: "dry-target",
            instrument: "BTCUSDT",
            assetClass: "crypto",
            realtime: { requireOfficialReference: false },
          },
        ],
      },
      liveFetch: false,
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.status).toBe("planned");
    expect(result.plan.expectedJobCount).toBe(1);
    expect(result.plan.sourceInspections[0]?.candidateAdapterIds).toEqual([
      "fixture_primary",
      "fixture_cross_check",
    ]);
    expect(result.notTouched).toContain("trading_execution");
  });

  it("connects batch evidence to the committee, quality harness, and quarterly checkpoints", async () => {
    const result = await runFinanceResearchRun({
      input: {
        ask: "分析未来半年美股和比特币的市场情绪，并考虑美国中期选举。",
        asOf: AS_OF,
        horizonMonths: 6,
        targets: [
          {
            id: "btc-fixture",
            instrument: "BTCUSDT",
            assetClass: "crypto",
            realtime: { requireOfficialReference: false },
            collections: [{ collection: "news", limit: 1, freshnessMaxMinutes: 60 }],
          },
        ],
      },
      liveFetch: true,
      qualityEnabled: true,
      modelInvoker,
      qualityModelInvoker: modelInvoker,
      modelId: "fixture-model",
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.status).toBe("candidate");
    expect(result.answerDecision).toBe("candidate_for_review");
    expect(result.batch?.status).toBe("completed");
    expect(result.committee?.coverage.equivalenceStatus).toBe("committee_candidate");
    expect(result.committee?.model.modelCallCount).toBe(10);
    expect(result.quality?.status).toBe("verified");
    expect(result.quality?.quality.passed).toBe(true);
    expect(result.quarterlyOutput.checkpoints).toHaveLength(2);
    expect(result.quarterlyOutput.adopted).toBe(true);
    expect(result.notTouched).toEqual(
      expect.arrayContaining(["provider_config", "external_channel_sender", "trading_execution"]),
    );
  });

  it("keeps a stale collection out of adopted output even when the model DAG completes", async () => {
    const staleCollection: FinanceMarketCollectionAdapter = {
      ...collectionAdapter(),
      collect: async (request) => [
        {
          itemId: "stale-item",
          collection: request.collection,
          providerName: "fixture-collection",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: "2026-09-01T00:00:00.000Z",
          observedAt: AS_OF,
          delayStatus: "delayed",
          sourceUrlOrArtifact: "fixture://stale",
          data: { close: 100 },
        },
      ],
    };
    const result = await runFinanceResearchRun({
      input: {
        ask: "分析未来半年美股市场情绪。",
        asOf: AS_OF,
        targets: [
          {
            id: "stale-target",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
            collections: [{ collection: "news", limit: 1, freshnessMaxMinutes: 60 }],
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelInvoker: modelInvoker,
      batchOptions: { ...BATCH_OPTIONS, collectionAdapters: [staleCollection] },
    });

    expect(result.status).toBe("needs_review");
    expect(result.gates.find((gate) => gate.id === "source")?.passed).toBe(false);
    expect(result.quarterlyOutput.adopted).toBe(false);
    expect(
      result.missingEvidence.some((item) =>
        item.includes("stale_or_invalid_collection_provenance"),
      ),
    ).toBe(true);
  });
  it.each(["committee", "quality"])(
    "isolates %s model failure from collected evidence",
    async (stage) => {
      const failingModel = async () => {
        throw new Error("fixture model failure");
      };
      const result = await runFinanceResearchRun({
        input: {
          ask: "Review market evidence",
          asOf: AS_OF,
          targets: [
            {
              id: "model-failure",
              instrument: "SPY",
              assetClass: "us_equity",
              realtime: { requireOfficialReference: false },
            },
          ],
        },
        liveFetch: true,
        modelInvoker: stage === "committee" ? failingModel : modelInvoker,
        qualityModelInvoker: stage === "quality" ? failingModel : modelInvoker,
        batchOptions: BATCH_OPTIONS,
      });
      expect(result.batch?.status).toBe("completed");
      expect(result.batch?.committeeEvidence.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.batch)).not.toContain("fixture model failure");
      expect(result.gates.find((gate) => gate.id === stage)?.passed).toBe(false);
      expect(result.quarterlyOutput.adopted).toBe(false);
      expect(result.answerDecision).toBe("return_failed_reason");
    },
  );

  it("retains a 403 source failure even with successful model execution", async () => {
    const denied: FinanceMarketCollectionAdapter = {
      ...collectionAdapter(),
      collect: async () => {
        await resolveFinanceFetch(async () => ({
          ok: false,
          status: 403,
          text: async () => "Forbidden",
        }))("https://example.test/denied");
        return [];
      },
    };
    const result = await runFinanceResearchRun({
      input: {
        ask: "Review market evidence",
        asOf: AS_OF,
        targets: [
          {
            id: "denied",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
            collections: [{ collection: "news", freshnessMaxMinutes: 60 }],
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelInvoker: modelInvoker,
      batchOptions: { ...BATCH_OPTIONS, collectionAdapters: [denied] },
    });
    expect(JSON.stringify(result.batch)).toContain("403");
    expect(result.status).toBe("needs_review");
    expect(result.quarterlyOutput.adopted).toBe(false);
  });

  it("does not accept an unknown evidence citation", async () => {
    const result = await runFinanceResearchRun({
      input: {
        ask: "Review market evidence",
        asOf: AS_OF,
        targets: [
          {
            id: "citation",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelInvoker: async () => ({
        kind: "artifact",
        artifact: {
          answer: "Research candidate",
          claims: [
            {
              id: "invented",
              text: "unsupported",
              status: "supported",
              evidenceIds: ["nonexistent-source"],
            },
          ],
        },
      }),
      batchOptions: BATCH_OPTIONS,
    });
    expect(result.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
    expect(result.quarterlyOutput.adopted).toBe(false);
  });

  it("keeps fresh but unverified historical coverage in review", async () => {
    const result = await runFinanceResearchRun({
      input: {
        ask: "Review six months of history",
        asOf: AS_OF,
        targets: [
          {
            id: "history",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: false,
            collections: [
              {
                collection: "eod_history",
                fromDate: "2026-03-08",
                toDate: "2026-09-07",
                freshnessMaxMinutes: 300000,
              },
            ],
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelInvoker: modelInvoker,
      batchOptions: BATCH_OPTIONS,
    });
    expect(result.status).toBe("needs_review");
    expect(result.missingEvidence).toContain("history:historical_window_coverage_incomplete");
    expect(result.quarterlyOutput.adopted).toBe(false);
  });
  it("resumes committee and quality stages without new model calls", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-model-resume-"));
    try {
      const checkpoint = {
        path: path.join(directory, "checkpoints.sqlite"),
        runId: "fixture-case",
        executionFingerprint: "fixture-v1",
      };
      let calls = 0;
      const countedModel: typeof modelInvoker = async (request) => {
        calls++;
        return modelInvoker(request);
      };
      const options = {
        input: {
          ask: "Review market evidence",
          asOf: AS_OF,
          targets: [
            {
              id: "spy",
              instrument: "SPY",
              assetClass: "us_equity",
              realtime: { requireOfficialReference: false },
            },
          ],
        },
        liveFetch: true,
        modelInvoker: countedModel,
        qualityModelInvoker: countedModel,
        batchOptions: { ...BATCH_OPTIONS, checkpoint },
        modelCheckpoint: { ...checkpoint, maxModelCalls: 32 },
      };
      const first = await runFinanceResearchRun(options);
      const firstCalls = calls;
      expect(first.status).toBe("candidate");
      expect(firstCalls).toBeGreaterThan(10);
      const resumed = await runFinanceResearchRun(options);
      expect(calls).toBe(firstCalls);
      expect(resumed.status).toBe("candidate");
      expect(resumed.committee).toEqual(first.committee);
      expect(resumed.batch?.committeeEvidence).toEqual(first.batch?.committeeEvidence);
      expect(resumed.quality).toEqual(first.quality);
      expect(resumed.modelCheckpoint).toMatchObject({
        newModelCalls: 0,
        reservedModelCalls: firstCalls,
        reusedStages: ["committee", "quality"],
      });
      const ids = new Set(resumed.batch?.committeeEvidence.map((item) => item.id));
      expect(
        resumed.quarterlyOutput.candidateClaims?.every((claim) =>
          claim.evidenceIds.every((id) => ids.has(id)),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps exhausted inference budgets and failed quality gates across resume", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-model-budget-"));
    try {
      const checkpoint = {
        path: path.join(directory, "checkpoints.sqlite"),
        runId: "budget-case",
        executionFingerprint: "fixture-v1",
      };
      let calls = 0;
      const countedModel: typeof modelInvoker = async (request) => {
        calls++;
        return modelInvoker(request);
      };
      const options = {
        input: {
          ask: "Review market evidence",
          asOf: AS_OF,
          targets: [
            {
              id: "spy",
              instrument: "SPY",
              assetClass: "us_equity",
              realtime: { requireOfficialReference: false },
            },
          ],
        },
        liveFetch: true,
        modelInvoker: countedModel,
        qualityModelInvoker: countedModel,
        batchOptions: { ...BATCH_OPTIONS, checkpoint },
        modelCheckpoint: { ...checkpoint, maxModelCalls: 1 },
      };
      const first = await runFinanceResearchRun(options);
      expect(calls).toBe(1);
      expect(first.quarterlyOutput.adopted).toBe(false);
      expect(first.batch?.status).toBe("completed");
      const resumed = await runFinanceResearchRun(options);
      expect(calls).toBe(1);
      expect(resumed.quarterlyOutput.adopted).toBe(false);
      expect(resumed.modelCheckpoint?.reservedModelCalls).toBe(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

it("plans every registered source independently and loads configured source credentials without exposing them", async () => {
  for (const key of [
    "ALPHA_VANTAGE_API_KEY",
    "COINGECKO_API_KEY",
    "MASSIVE_API_KEY",
    "ALPACA_API_KEY_ID",
    "ALPACA_API_SECRET_KEY",
    "FINNHUB_API_KEY",
    "TWELVE_DATA_API_KEY",
    "FRED_API_KEY",
    "FMP_API_KEY",
  ]) {
    vi.stubEnv(key, "fixture-private-key-not-a-live-key");
  }
  try {
    const receipt = await runFinanceResearchRun({
      input: { ask: "all financial sources", asOf: AS_OF, sourcePolicy: "all_registered" },
    });
    const inventory = receipt.plan.sourceInventory!;
    expect(inventory.registeredAdapterIds).toContain("alpha_vantage_global_quote");
    expect(inventory.unplannedAdapterIds).toEqual([]);
    expect(inventory.unavailableProviders).toEqual([]);
    expect(receipt.plan.expectedJobCount).toBe(inventory.registeredAdapterIds.length);
    expect(
      receipt.plan.sourceInspections.every((job) => job.candidateAdapterIds.length === 1),
    ).toBe(true);
    expect(
      new Set(receipt.plan.sourceInspections.flatMap((job) => job.candidateAdapterIds)).size,
    ).toBe(inventory.registeredAdapterIds.length);
    expect(JSON.stringify(receipt)).not.toContain("fixture-private-key");
    expect(receipt.batch).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});
