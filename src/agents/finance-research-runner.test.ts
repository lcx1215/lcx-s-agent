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
    review: {
      verdict: "pass",
      criticalFindings: [],
      evidenceGaps: [],
      notes: ["Checked supplied timestamps and coverage; no additional fact was inferred."],
    },
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
  it("targets the caller-supplied equity ticker instead of the broad canary universe", () => {
    const targets = buildDefaultFinanceResearchTargets("Analyze AAPL stock", 6, AS_OF);
    expect(
      targets
        .filter((target) => target.id.startsWith("us-equity-"))
        .map((target) => target.instrument),
    ).toEqual(["AAPL"]);
  });

  it("maps common company names to bounded equity tickers", () => {
    const targets = buildDefaultFinanceResearchTargets("分析 Nvidia 股票", 6, AS_OF);
    expect(
      targets
        .filter((target) => target.id.startsWith("us-equity-"))
        .map((target) => target.instrument),
    ).toEqual(["NVDA"]);
  });

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
    const sentiment = targets.find((target) => target.id === "cross-asset-sentiment-news");
    expect(sentiment?.instrument).toBe("SPY");
    expect(sentiment?.collections?.[0]?.seriesId).toBe("market sentiment");
  });

  it("clamps month-end history windows and the registry collection limit", () => {
    const targets = buildDefaultFinanceResearchTargets(
      "分析美股历史",
      12,
      "2026-03-31T12:00:00.000Z",
    );
    const history = targets
      .flatMap((target) => target.collections ?? [])
      .filter((collection) => collection.collection === "eod_history");

    expect(history.length).toBeGreaterThan(0);
    expect(history.every((collection) => collection.fromDate === "2025-03-31")).toBe(true);
    expect(history.every((collection) => collection.limit === 250)).toBe(true);
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

  it("withholds a research candidate when a thesis proposal escapes the declared instrument universe", async () => {
    const unsupportedProposalInvoker = async (request: unknown): Promise<unknown> => {
      const output = await modelInvoker(request);
      const payload = request as { stage?: string };
      if (
        (payload.stage === "draft" || payload.stage === "format") &&
        typeof output === "object" &&
        output !== null &&
        "kind" in output &&
        output.kind === "artifact" &&
        "artifact" in output &&
        typeof output.artifact === "object" &&
        output.artifact !== null
      ) {
        const artifact = output.artifact as {
          supportingAnalysis?: Record<string, unknown>;
        };
        return {
          ...output,
          artifact: {
            ...output.artifact,
            supportingAnalysis: {
              ...artifact.supportingAnalysis,
              financeThesisProposals: [
                {
                  claimId: "claim-1",
                  instrument: "OUTSIDE-UNIVERSE",
                  invalidationConditions: ["The cited evidence no longer supports the claim."],
                },
              ],
            },
          },
        };
      }
      return output;
    };
    const result = await runFinanceResearchRun({
      input: {
        ask: "分析未来半年美股和比特币的市场情绪。",
        asOf: AS_OF,
        horizonMonths: 6,
        targets: [
          {
            id: "btc-thesis-fixture",
            instrument: "BTCUSDT",
            assetClass: "crypto",
            realtime: { requireOfficialReference: false },
          },
        ],
      },
      liveFetch: true,
      qualityEnabled: true,
      modelInvoker,
      qualityModelInvoker: unsupportedProposalInvoker,
      modelId: "fixture-model",
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.status).toBe("needs_review");
    expect(result.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
    expect(result.quality?.verification.details.join(" ")).toMatch(/declared universe/);
  });

  it("compiles a grounded dynamic allocation into the existing portfolio plan contract", async () => {
    const allocationModel = async (request: unknown): Promise<unknown> => {
      const output = await modelInvoker(request);
      if (
        typeof output === "object" &&
        output !== null &&
        "kind" in output &&
        output.kind === "artifact" &&
        "artifact" in output &&
        typeof output.artifact === "object" &&
        output.artifact !== null
      ) {
        const artifact = output.artifact as {
          supportingAnalysis?: Record<string, unknown>;
          claims: readonly { evidenceIds: readonly string[] }[];
        };
        const evidenceId = artifact.claims[0]?.evidenceIds[0];
        if (!evidenceId) {
          throw new Error("fixture artifact has no grounded evidence id");
        }
        return {
          ...output,
          artifact: {
            ...output.artifact,
            supportingAnalysis: {
              ...artifact.supportingAnalysis,
              portfolioAllocationProposal: {
                allocations: [
                  {
                    strategyId: "trend",
                    budgetFraction: 0.41,
                    evidenceIds: [evidenceId],
                  },
                ],
              },
            },
            answer:
              "Strategy candidate using timestamped evidence as of 2026-09-08: if the base scenario persists, retain a bounded allocation. Risk and invalidation are tied to the stated scenario over a six-month horizon. Review only; no automatic execution.",
          },
        };
      }
      return output;
    };
    const result = await runFinanceResearchRun({
      input: {
        ask: "分析未来半年美股市场情绪并形成可审阅的策略候选配置。",
        asOf: AS_OF,
        horizonMonths: 6,
        decisionMode: "strategy_candidate",
        strategyStage: "research_candidate",
        portfolioContext: {
          accountId: "paper-account",
          venue: "alpaca",
          validityMinutes: 1_440,
          conflictPolicy: "block",
          activeStrategyIds: ["trend"],
        },
        targets: [
          {
            id: "allocation-fixture",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelInvoker: allocationModel,
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.status).toBe("candidate");
    expect(result.portfolioPlan).toMatchObject({
      accountId: "paper-account",
      venue: "alpaca",
      allocations: [{ strategyId: "trend", budgetFraction: 0.41 }],
      candidates: [],
      provenance: {
        kind: "finance_research_allocation",
        receiptId: expect.stringMatching(/^quality:/u),
      },
    });
  });

  it("retains bounded post-cutoff collection evidence in live-now mode", async () => {
    const postCutoff = "2026-09-08T12:01:00.000Z";
    const requests: unknown[] = [];
    const liveCollection: FinanceMarketCollectionAdapter = {
      ...collectionAdapter(),
      collect: async (request) => [
        {
          itemId: "live-news",
          collection: request.collection,
          providerName: "fixture-collection",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: postCutoff,
          observedAt: postCutoff,
          delayStatus: "realtime",
          sourceUrlOrArtifact: "fixture://live-news",
          data: { title: "SPY stock market report", tickers: ["SPY"] },
        },
      ],
    };
    const result = await runFinanceResearchRun({
      input: {
        ask: "核对 SPY 新闻",
        asOf: AS_OF,
        asOfMode: "live_now",
        targets: [
          {
            id: "live-news",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: false,
            collections: [{ collection: "news", freshnessMaxMinutes: 60 }],
          },
        ],
      },
      liveFetch: true,
      modelInvoker: async (request) => {
        requests.push(request);
        return modelInvoker(request);
      },
      qualityModelInvoker: async (request) => {
        requests.push(request);
        return modelInvoker(request);
      },
      batchOptions: { ...BATCH_OPTIONS, collectionAdapters: [liveCollection] },
    });

    expect(result.batch?.asOfMode).toBe("live_now");
    expect(result.batch?.committeeEvidence[0]?.text).toContain("collection-time evidence");
    expect(
      result.batch?.committeeEvidence.find((item) => item.id === "finance-model:SPY")?.text,
    ).toContain(postCutoff);
    expect(
      requests.filter(
        (request): request is { sharedContext?: { asOfMode?: string } } =>
          typeof request === "object" && request !== null && "sharedContext" in request,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sharedContext: expect.objectContaining({ asOfMode: "live_now" }),
        }),
      ]),
    );
  });

  it.each([
    { ask: "分析未来半年美股趋势和共同暴露。", modules: ["M01", "M02", "M12"], trend: true },
    { ask: "核对 SPY 收盘价和来源时间。", modules: ["M01"], trend: false },
  ])("passes a consistent scoped method kit for $ask", async ({ ask, modules, trend }) => {
    const requests: unknown[] = [];
    const capture = async (request: unknown) => {
      requests.push(request);
      return modelInvoker(request);
    };
    const result = await runFinanceResearchRun({
      input: {
        ask,
        asOf: AS_OF,
        horizonMonths: 6,
        targets: [
          {
            id: "method-kit-fixture",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
          },
        ],
      },
      liveFetch: true,
      modelInvoker: capture,
      qualityModelInvoker: capture,
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.status).toBe("candidate");
    const committeeRequest = requests.find(
      (request): request is { instructions?: string } =>
        typeof request === "object" && request !== null && "instructions" in request,
    );
    expect(committeeRequest?.instructions?.includes("200-session moving average")).toBe(trend);
    expect(committeeRequest?.instructions).toContain("M11 波动率相对价值");
    expect(committeeRequest?.instructions).toContain("D28 融资拥挤与流动性压力");
    const qualityRequest = requests.find(
      (request): request is { task?: string; sharedContext?: Record<string, unknown> } =>
        typeof request === "object" &&
        request !== null &&
        "sharedContext" in request &&
        typeof (request as { sharedContext?: Record<string, unknown> }).sharedContext
          ?.strategyMethodKit === "object",
    );
    expect(qualityRequest?.sharedContext?.strategyMethodKit).toMatchObject({
      selectedModules: modules,
    });
    expect(qualityRequest?.task).toContain(ask);
    expect(qualityRequest?.task).not.toContain("quarter checkpoints");
    if (!trend) {
      expect(JSON.stringify(qualityRequest?.sharedContext?.strategyMethodKit)).not.toContain(
        "200-session",
      );
    }
  });

  it("does not spend model calls when all source evidence is unavailable", async () => {
    const invoke = vi.fn(modelInvoker);
    const result = await runFinanceResearchRun({
      input: {
        ask: "分析 SPY",
        asOf: AS_OF,
        targets: [
          {
            id: "empty",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: false,
            collections: [{ collection: "news", freshnessMaxMinutes: 60 }],
          },
        ],
      },
      liveFetch: true,
      modelInvoker: invoke,
      qualityModelInvoker: invoke,
      batchOptions: {
        ...BATCH_OPTIONS,
        collectionAdapters: [
          {
            ...collectionAdapter(),
            collect: async () => {
              throw new Error("fixture unavailable");
            },
          },
        ],
      },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.committee).toBeUndefined();
    expect(result.quality).toBeUndefined();
    expect(result.missingEvidence).toContain("source_evidence_unavailable");
    expect(result.sourceRecovery?.entries[0].action).toBe("review_evidence");
    expect(result.quarterlyOutput.adopted).toBe(false);
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
    expect(inventory.unplannedAdapterIds).toEqual([
      "fmp_eod_bulk",
      "fmp_earning_call_transcript",
      "fmp_institutional_ownership_symbol_positions_summary",
    ]);
    expect(inventory.unavailableProviders).toEqual([]);
    expect(receipt.plan.expectedJobCount).toBe(
      inventory.registeredAdapterIds.length - inventory.unplannedAdapterIds.length,
    );
    expect(
      receipt.plan.sourceInspections.every((job) => job.candidateAdapterIds.length === 1),
    ).toBe(true);
    expect(
      new Set(receipt.plan.sourceInspections.flatMap((job) => job.candidateAdapterIds)).size,
    ).toBe(inventory.registeredAdapterIds.length - inventory.unplannedAdapterIds.length);
    expect(JSON.stringify(receipt)).not.toContain("fixture-private-key");
    expect(receipt.batch).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});
/**
 * Ticker extraction is a blocklist, so the failure mode is an abbreviation becoming a research
 * target. Measured before the list was widened: RSI, MACD, EPS, IPO, FED, FOMC, YTD, TTM, NAV, AUM
 * and NYSE each became an instrument that then had history and news collected against a symbol that
 * does not exist — a run that looks like research and is not.
 */
describe("equity symbol extraction", () => {
  const instrumentsFor = (ask: string): readonly string[] =>
    buildDefaultFinanceResearchTargets(ask, 12, "2026-09-20").map((target) => target.instrument);

  it("still reads a real ticker", () => {
    expect(instrumentsFor("NVDA 现在怎么样")).toContain("NVDA");
  });

  it("does not read a financial abbreviation as a ticker", () => {
    const cases: readonly [string, string][] = [
      ["RSI 现在超买了吗", "RSI"],
      ["MACD 金叉了吗", "MACD"],
      ["这家公司 EPS 增长如何", "EPS"],
      ["IPO 打新值得参与吗", "IPO"],
      ["FED 加息会怎样", "FED"],
      ["FOMC 会议纪要说了什么", "FOMC"],
      ["今年 YTD 表现如何", "YTD"],
      ["EBITDA 和 TTM 是多少", "TTM"],
      ["这只基金的 NAV 和 AUM", "NAV"],
      ["这只基金的 NAV 和 AUM", "AUM"],
      ["NYSE 上市的公司", "NYSE"],
    ];
    for (const [ask, abbreviation] of cases) {
      expect(instrumentsFor(ask), ask).not.toContain(abbreviation);
    }
  });
});

describe("research module composition reaches actual model request boundaries", () => {
  const targets = [
    {
      id: "spy",
      instrument: "SPY",
      assetClass: "us_equity",
      realtime: { requireOfficialReference: false },
    },
  ];
  const moduleSelection = {
    moduleIds: ["credit_liquidity", "technical_timing"] as const,
    rationale: "Check transmission and observed behavior before retaining the rule route.",
  };

  it("passes the validated combination to both committee and quality invocations", async () => {
    const committeeRequests: unknown[] = [];
    const qualityRequests: unknown[] = [];
    const result = await runFinanceResearchRun({
      input: { ask: "Review market evidence", asOf: AS_OF, targets, moduleSelection },
      liveFetch: true,
      batchOptions: BATCH_OPTIONS,
      modelInvoker: async (request) => {
        committeeRequests.push(request);
        return modelInvoker(request);
      },
      qualityModelInvoker: async (request) => {
        qualityRequests.push(request);
        return modelInvoker(request);
      },
    });
    expect(result.status).toBe("candidate");
    expect(committeeRequests.length).toBeGreaterThan(0);
    expect(qualityRequests.length).toBeGreaterThan(0);
    for (const request of committeeRequests) {
      expect(request).toMatchObject({
        sharedContext: { userConstraints: { financeOrchestration: result.plan.orchestration } },
      });
    }
    for (const request of qualityRequests) {
      expect(request).toMatchObject({
        sharedContext: { financeOrchestration: result.plan.orchestration },
      });
    }
    expect(result.plan.orchestration.primaryModules.slice(0, 2)).toEqual(moduleSelection.moduleIds);
    expect(result.plan.orchestration.requiredTools).toContain("finance_data_gateway_snapshot");
    expect(result.committee?.model.realModelInferenceObserved).toBe(false);
    expect(result.notTouched).toContain("trading_execution");
  });

  it("cannot use module selection to bypass absent source evidence", async () => {
    const invoke = vi.fn(modelInvoker);
    const result = await runFinanceResearchRun({
      input: { ask: "Review market evidence", asOf: AS_OF, targets, moduleSelection },
      liveFetch: true,
      batchOptions: { realtimeAdapters: [], collectionAdapters: [] },
      modelInvoker: invoke,
      qualityModelInvoker: invoke,
    });
    expect(result.status).toBe("blocked");
    expect(result.answerDecision).toBe("return_failed_reason");
    expect(result.quarterlyOutput.adopted).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses cached model stages after a composition changes under the same run ID", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-module-checkpoint-"));
    try {
      const checkpoint = {
        path: path.join(directory, "checkpoints.sqlite"),
        runId: "module-case",
        executionFingerprint: "fixture-v1",
      };
      const invoke = vi.fn(modelInvoker);
      const options = {
        input: { ask: "Review market evidence", asOf: AS_OF, targets, moduleSelection },
        liveFetch: true,
        batchOptions: { ...BATCH_OPTIONS, checkpoint },
        modelCheckpoint: { ...checkpoint, maxModelCalls: 32 },
        modelInvoker: invoke,
        qualityModelInvoker: invoke,
      };
      expect((await runFinanceResearchRun(options)).status).toBe("candidate");
      const count = invoke.mock.calls.length;
      await expect(
        runFinanceResearchRun({
          ...options,
          input: {
            ...options.input,
            moduleSelection: { moduleIds: ["event_driven"], rationale: "Revised hypothesis" },
          },
        }),
      ).rejects.toThrow("checkpoint input/config mismatch");
      expect(invoke).toHaveBeenCalledTimes(count);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("compiles grounded committee producer inputs before dispatching the canonical module DAG", async () => {
    let captured: unknown;
    const producerAwareInvoker = async (request: unknown) => {
      const output = await modelInvoker(request);
      const payload = request as { stage?: string; evidence?: Array<{ id?: string }> };
      if (payload.stage !== "draft") {
        return output;
      }
      const evidenceId = payload.evidence?.[0]?.id ?? "finance-batch-summary";
      const artifact = (output as { artifact: { supportingAnalysis: Record<string, unknown> } })
        .artifact;
      artifact.supportingAnalysis.financeFrameworkProducerInputs = {
        causal_map: {
          domain: "causal_map",
          sourceArtifacts: [evidenceId],
          evidenceCategories: ["causal_chain_evidence"],
          evidenceSummary:
            "Timestamped evidence supports a bounded causal-chain hypothesis with an explicit alternative.",
          baseCase: "the observed transmission remains conditional",
          bullCase: "supportive transmission persists",
          bearCase: "the transmission reverses",
          keyCausalChain: "observed input -> transmission mechanism -> conditional repricing",
          upstreamDrivers: ["cited observed input"],
          downstreamAssetImpacts: ["conditional repricing"],
          confidenceOrConviction: "medium",
          whatChangesMyMind: "a cited counter-observation breaks the mechanism",
          noActionReason: "research evidence grants no order authority",
          riskGateNotes: "portfolio and execution gates remain required",
          allowedActionAuthority: "research_only",
        },
      };
      return output;
    };
    const result = await runFinanceResearchRun({
      input: {
        ask: "Review technical timing",
        asOf: AS_OF,
        targets,
        executeModules: true,
        moduleSelection: {
          moduleIds: ["technical_timing"],
          rationale: "Use the registered timing lens.",
        },
      },
      liveFetch: true,
      batchOptions: BATCH_OPTIONS,
      modelInvoker: producerAwareInvoker,
      qualityModelInvoker: producerAwareInvoker,
      moduleExecutor: async ({ plan, domainProducerInputs, asOf }) => {
        captured = domainProducerInputs;
        const nodes = plan.composition.nodes.map((node) => ({
          nodeId: node.id,
          moduleId: node.moduleId,
          requiredToolNames: [],
          dependsOn: node.dependsOn,
          status: "succeeded" as const,
          inputEvidenceIds: ["fixture"],
          outputEvidenceIds: [`finance-module:${node.id}`],
          toolCalls: [],
          missingEvidence: [],
        }));
        return {
          receipt: {
            schemaVersion: "lcx_finance_module_execution_v1" as const,
            boundary: "finance_module_execution_research_only" as const,
            requested: true,
            allNodesSucceeded: true,
            moduleToolsDispatched: true,
            compositionNodeIds: plan.composition.topologicalOrder,
            outputEvidenceIds: nodes.flatMap((node) => node.outputEvidenceIds),
            nodes,
            replanFeedback: {
              status: "completed" as const,
              hardNodeIds: plan.composition.control.hardNodeIds,
              softNodeIds: plan.composition.control.softNodeIds,
              hardFailures: [],
              softFailures: [],
              remainingSoftReplans: plan.composition.control.maxSoftReplans,
              nextAction: "none" as const,
            },
            notTouched: [
              "provider_config",
              "external_channel_sender",
              "trading_execution",
              "wallet_or_order_authority",
            ],
          },
          evidence: nodes.map((node) => ({
            id: node.outputEvidenceIds[0],
            source: "finance-module-execution",
            timestamp: asOf,
            text: JSON.stringify({ moduleId: node.moduleId, status: node.status }),
          })),
        };
      },
    });
    expect(captured).toMatchObject({ causal_map: { allowedActionAuthority: "research_only" } });
    expect(result.status).toBe("candidate");
    expect(result.gates).toContainEqual(
      expect.objectContaining({ id: "module_execution", passed: true }),
    );
  });
});
