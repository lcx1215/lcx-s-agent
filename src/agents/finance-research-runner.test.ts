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
import { deriveFinanceModuleReplanFeedback } from "./finance-module-execution.js";
import type { FinanceRealtimeSourceAdapter } from "./finance-realtime-source-registry.js";
import {
  buildDefaultFinanceResearchTargets,
  readFinanceResearchEquityUniverseSnapshot,
  runFinanceResearchRun,
  validateFinanceResearchEquityUniverseSnapshot,
  type FinanceResearchEquityUniverseSnapshot,
} from "./finance-research-runner.js";
import {
  DEFAULT_UNIVERSE_THRESHOLDS,
  FINANCE_UNIVERSE_SELECTION_FRESHNESS_BASIS,
  FINANCE_UNIVERSE_SELECTION_SCHEMA,
  FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME,
  FINANCE_UNIVERSE_SELECTION_SOURCES,
} from "./finance-universe-selection.js";
import { buildQualityHarnessModelPromptWithCoverage } from "./local-text-model-adapter.js";
import type {
  LogicalAgentModelAdapter,
  LogicalAgentModelRouting,
  ModelCallObservation,
  ModelCallRequest,
} from "./logical-agent-model-router.js";
import type { QualityHarnessModelRequest } from "./quality-harness-contract.js";

const AS_OF = "2026-09-08T12:00:00.000Z";

function universeSnapshot(
  overrides: Partial<FinanceResearchEquityUniverseSnapshot> = {},
): FinanceResearchEquityUniverseSnapshot {
  const selected = ["NVDA", "MSFT", "AAPL"];
  const selectedMetrics = selected.map((symbol) => ({
    symbol,
    bars: 800,
    firstDate: "2023-07-01",
    lastDate: "2026-09-09",
    medianDollarVolume: 10_000_000,
    annualisedVol: 0.2,
    outlierCount: 0,
    maxGapDays: 4,
  }));
  return {
    schemaVersion: FINANCE_UNIVERSE_SELECTION_SCHEMA,
    asOf: "2026-09-10T11:30:00.000Z",
    generatedAt: "2026-09-10T11:45:00.000Z",
    sources: FINANCE_UNIVERSE_SELECTION_SOURCES,
    freshnessBasis: FINANCE_UNIVERSE_SELECTION_FRESHNESS_BASIS,
    assetCount: 2_000,
    candidateCount: 1_000,
    screenedCount: 100,
    screenLimit: 120,
    unreadableCount: 0,
    eligibleCount: 30,
    selected,
    selectedMetrics,
    thresholds: DEFAULT_UNIVERSE_THRESHOLDS,
    liquidityPreScreen: {
      basis: "latest_completed_regular_session",
      source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
      sessionDate: "2026-09-09",
    },
    selectionEvidence: {
      method: "liquidity_seed_then_iterative_minimum_worst_correlation",
      maxCorrelation: 0.9,
      selected: [
        { symbol: "NVDA", rank: 1, reason: "highest_liquidity_eligible_seed" },
        {
          symbol: "MSFT",
          rank: 2,
          reason: "lowest_correlation_to_selected",
          maxCorrelationToPriorMembers: 0.4,
        },
        {
          symbol: "AAPL",
          rank: 3,
          reason: "lowest_correlation_to_selected",
          maxCorrelationToPriorMembers: 0.6,
        },
      ],
      excluded: [],
    },
    rejected: Array.from({ length: 70 }, (_, index) => ({
      symbol: `${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
      reason: "not eligible",
    })),
    ...overrides,
  };
}

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
    evidence?: readonly { id: string; text?: string }[];
    evidenceBatchMode?: "context_extraction" | "final_artifact_audit";
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
            epistemicClass: "inference",
            basis: "The conclusion is limited to the supplied timestamps and source coverage.",
            evidenceRelations: [{ evidenceId, relation: "supports" }],
          },
        ],
      },
    };
  }
  if (payload.evidenceBatchMode) {
    const contradictions =
      payload.evidenceBatchMode === "final_artifact_audit"
        ? (payload.evidence ?? []).filter((entry) =>
            entry.text?.includes("contradictory evidence refutes the early thesis"),
          )
        : [];
    return {
      kind: "review",
      review: {
        verdict: contradictions.length > 0 ? "revise" : "pass",
        criticalFindings: contradictions.map((entry) => `[${entry.id}] contradicts the draft.`),
        evidenceGaps: [],
        notes: (payload.evidence ?? []).map((entry) => `[${entry.id}] reviewed against the draft.`),
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

function mockQualityPromptRouting(
  invoke: (request: unknown) => Promise<unknown>,
): LogicalAgentModelRouting {
  const coverageByCall = new Map<string, ModelCallObservation["evidenceCoverage"]>();
  const adapter: LogicalAgentModelAdapter = {
    id: "mock-quality-prompt",
    provider: "fixture",
    modelId: "quality-fixture",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: async (request: ModelCallRequest) => {
      const payload = request.payload as Parameters<
        typeof buildQualityHarnessModelPromptWithCoverage
      >[0];
      const rendered = buildQualityHarnessModelPromptWithCoverage(payload);
      coverageByCall.set(request.callId, rendered.evidenceCoverage);
      return invoke(payload);
    },
    observe: (request) => {
      const evidenceCoverage = coverageByCall.get(request.callId);
      if (!evidenceCoverage) {
        return undefined;
      }
      return {
        callId: request.callId,
        provider: "fixture",
        modelId: "quality-fixture",
        transportRequestId: `fixture:${request.callId}`,
        kind: "model_inference",
        evidenceCoverage,
      };
    },
  };
  return {
    revision: "mock-quality-prompt-coverage-v1",
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: 1_000_000,
      timeoutMs: 10_000,
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
  it("separates explicit slow research from executable/current quote requirements", () => {
    const target = (ask: string) =>
      buildDefaultFinanceResearchTargets(ask, 6, AS_OF).find((row) => row.id === "us-equity-spy");
    expect(target("SPY long-term risk research")?.realtime).toBe(false);
    expect(
      target("SPY long-term risk research")?.collections?.some(
        (row) => row.collection === "eod_history",
      ),
    ).toBe(true);
    expect(target("SPY long-term research and current price")?.realtime).not.toBe(false);
    expect(target("SPY intraday risk research")?.realtime).not.toBe(false);
  });

  it("targets the caller-supplied equity ticker", () => {
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

  it("does not substitute fixed symbols for a broad-market request without a snapshot", () => {
    const targets = buildDefaultFinanceResearchTargets(
      "分析未来半年美股和加密货币市场情绪，并考虑美国中期选举。",
      6,
      AS_OF,
    );
    const instruments = targets.map((target) => target.instrument);
    expect(instruments).not.toContain("BTCUSDT"); // A broad crypto request does not imply BTC.
    expect(instruments).not.toContain("SPY");
    expect(instruments).not.toContain("QQQ");
    expect(targets.some((target) => target.assetClass === "us_equity")).toBe(false);
  });

  it("uses every selected symbol from a validated dynamic universe snapshot", () => {
    const snapshot = universeSnapshot();
    const targets = buildDefaultFinanceResearchTargets(
      "Review the broad US stock market",
      6,
      "2026-09-10T12:00:00.000Z",
      snapshot,
    );
    expect(
      targets
        .filter((target) => target.id.startsWith("us-equity-"))
        .map((target) => target.instrument),
    ).toEqual(snapshot.selected);
    expect(targets.find((target) => target.id === "cross-asset-sentiment-news")?.instrument).toBe(
      "NVDA",
    );
    expect(targets.some((target) => target.instrument === "SPY")).toBe(false);
  });

  it("rejects a universe snapshot whose unreadable count exceeds the screened candidates", () => {
    const invalidSnapshot = universeSnapshot({ unreadableCount: 101 });

    expect(() =>
      validateFinanceResearchEquityUniverseSnapshot(invalidSnapshot, "2026-09-10T12:00:00.000Z"),
    ).toThrow("candidate/count resource bounds");
  });

  it("rejects a universe snapshot whose unreadable and eligible counts overlap candidates", () => {
    const invalidSnapshot = universeSnapshot({ unreadableCount: 71, eligibleCount: 30 });

    expect(() =>
      validateFinanceResearchEquityUniverseSnapshot(invalidSnapshot, "2026-09-10T12:00:00.000Z"),
    ).toThrow("candidate/count resource bounds");
  });

  it("rejects rejected-candidate evidence with a wrong count, duplicates, or selected symbols", () => {
    const valid = universeSnapshot();
    const duplicateRejected = [...valid.rejected];
    duplicateRejected[1] = { ...duplicateRejected[1], symbol: duplicateRejected[0].symbol };
    const selectedRejected = [...valid.rejected];
    selectedRejected[0] = { ...selectedRejected[0], symbol: valid.selected[0] };

    for (const rejected of [[], duplicateRejected, selectedRejected]) {
      const invalidSnapshot = universeSnapshot({ rejected });
      expect(() =>
        validateFinanceResearchEquityUniverseSnapshot(invalidSnapshot, "2026-09-10T12:00:00.000Z"),
      ).toThrow("rejected-candidate evidence");
    }
  });

  it("validates optional liquidity-date audit metadata while accepting legacy snapshots", () => {
    const valid = universeSnapshot({
      liquidityPreScreen: {
        basis: "latest_completed_regular_session",
        source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
        sessionDate: "2026-09-09",
        sessionDateDistribution: [
          { sessionDate: "2026-09-08", quoteCount: 5 },
          { sessionDate: "2026-09-09", quoteCount: 20 },
        ],
        excludedOlderSessionBarCount: 5,
        excludedOlderCandidateCount: 3,
      },
    });
    expect(
      validateFinanceResearchEquityUniverseSnapshot(valid, "2026-09-10T12:00:00.000Z"),
    ).toEqual(valid);

    const inconsistent = universeSnapshot({
      liquidityPreScreen: {
        ...valid.liquidityPreScreen,
        excludedOlderSessionBarCount: 4,
      },
    });
    expect(() =>
      validateFinanceResearchEquityUniverseSnapshot(inconsistent, "2026-09-10T12:00:00.000Z"),
    ).toThrow("inconsistent liquidity-date audit evidence");

    const legacy = universeSnapshot();
    expect(
      validateFinanceResearchEquityUniverseSnapshot(legacy, "2026-09-10T12:00:00.000Z"),
    ).toEqual(legacy);

    const transitionalV1 = universeSnapshot({
      liquidityPreScreen: {
        basis: "latest_completed_regular_session",
        source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
        sessionDate: "2026-09-09",
        sessionDateDistribution: [
          { sessionDate: "2026-09-08", quoteCount: 5 },
          { sessionDate: "2026-09-09", quoteCount: 20 },
        ],
        excludedOlderSessionCount: 5,
        excludedOlderCandidateCount: 3,
      },
    });
    expect(
      validateFinanceResearchEquityUniverseSnapshot(transitionalV1, "2026-09-10T12:00:00.000Z"),
    ).toEqual(transitionalV1);

    const inconsistentTransitionalV1 = universeSnapshot({
      liquidityPreScreen: {
        ...transitionalV1.liquidityPreScreen,
        excludedOlderSessionCount: 4,
      },
    });
    expect(() =>
      validateFinanceResearchEquityUniverseSnapshot(
        inconsistentTransitionalV1,
        "2026-09-10T12:00:00.000Z",
      ),
    ).toThrow("inconsistent liquidity-date audit evidence");
  });

  it("accepts a Friday receipt through Monday before close, but expires it after Monday close", () => {
    const fridaySnapshot = universeSnapshot({
      asOf: "2026-09-11T20:05:00.000Z",
      generatedAt: "2026-09-11T20:10:00.000Z",
      selectedMetrics: universeSnapshot().selectedMetrics.map((metrics) => ({
        ...metrics,
        lastDate: "2026-09-11",
      })),
      liquidityPreScreen: {
        basis: "latest_completed_regular_session",
        source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
        sessionDate: "2026-09-11",
      },
    });
    expect(
      validateFinanceResearchEquityUniverseSnapshot(fridaySnapshot, "2026-09-14T19:30:00.000Z"),
    ).toEqual(fridaySnapshot);
    expect(() =>
      validateFinanceResearchEquityUniverseSnapshot(fridaySnapshot, "2026-09-14T20:05:00.000Z"),
    ).toThrow("latest completed weekday session");
  });

  it("reads the shared latest-snapshot path and fails closed when it is absent", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-universe-reader-"));
    try {
      const snapshot = universeSnapshot();
      await fs.writeFile(
        path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME),
        JSON.stringify(snapshot),
      );
      expect(
        readFinanceResearchEquityUniverseSnapshot(directory, "2026-09-10T12:00:00.000Z"),
      ).toEqual(snapshot);
      await fs.rm(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME));
      expect(() =>
        readFinanceResearchEquityUniverseSnapshot(directory, "2026-09-10T12:00:00.000Z"),
      ).toThrow("equity universe snapshot absent");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("reports missing broad-market universe coverage instead of silently using proxies", async () => {
    const receipt = await runFinanceResearchRun({
      input: { ask: "美股和加密市场展望", asOf: AS_OF },
      batchOptions: BATCH_OPTIONS,
    });
    const instruments = receipt.plan.targets.map((target) => target.instrument);
    expect(instruments).not.toContain("BTCUSDT");
    expect(instruments).not.toContain("SPY");
    expect(instruments).not.toContain("QQQ");
    expect(receipt.plan.limitations).toContain(
      "equity_universe_snapshot_missing:no equity ticker was substituted for a broad-market request",
    );
    expect(receipt.plan.limitations).toContain(
      "crypto_instrument_universe_missing:no crypto ticker was substituted for a broad request",
    );
    expect(receipt.missingEvidence).toEqual(expect.arrayContaining([...receipt.plan.limitations]));
  });

  it("clamps month-end history windows and the registry collection limit", () => {
    const snapshot = universeSnapshot({
      asOf: "2026-03-31T11:00:00.000Z",
      generatedAt: "2026-03-31T11:30:00.000Z",
      selectedMetrics: universeSnapshot().selectedMetrics.map((metrics) => ({
        ...metrics,
        firstDate: "2023-03-31",
        lastDate: "2026-03-30",
      })),
      liquidityPreScreen: {
        basis: "latest_completed_regular_session",
        source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
        sessionDate: "2026-03-30",
      },
    });
    const targets = buildDefaultFinanceResearchTargets(
      "分析美股历史",
      12,
      "2026-03-31T12:00:00.000Z",
      snapshot,
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
      qualityModelRouting: mockQualityPromptRouting(modelInvoker),
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

  it("audits a contradictory Finance item after item 48 and blocks adoption", async () => {
    const source = {
      ...collectionAdapter(),
      collect: async (request: Parameters<FinanceMarketCollectionAdapter["collect"]>[0]) => {
        const index = Number(request.instrument.slice("COV".length));
        const item: FinanceMarketCollectionItem = {
          itemId:
            index === 48
              ? "late-contradictory-evidence"
              : `coverage-item-${String(index).padStart(3, "0")}`,
          collection: request.collection,
          providerName: "fixture-collection",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: AS_OF,
          observedAt: AS_OF,
          delayStatus: "realtime",
          sourceUrlOrArtifact: `fixture://coverage/${index}`,
          data: {
            title:
              index === 48
                ? "contradictory evidence refutes the early thesis"
                : `positive evidence ${index}`,
            close: 100,
          },
        };
        return [item];
      },
    };
    const targets = Array.from({ length: 49 }, (_, index) => ({
      id: `coverage-target-${String(index).padStart(3, "0")}`,
      instrument: `COV${String(index).padStart(3, "0")}`,
      assetClass: "us_equity" as const,
      realtime: false as const,
      collections: [{ collection: "sec_filings" as const, limit: 1, freshnessMaxMinutes: 60 }],
    }));
    const qualityRequests: QualityHarnessModelRequest[] = [];
    const qualityResponses: Array<{ request: QualityHarnessModelRequest; response: unknown }> = [];
    const qualityInvoker = async (request: unknown) => {
      const current = request as QualityHarnessModelRequest;
      qualityRequests.push(current);
      const response = await modelInvoker(request);
      if (
        current.evidenceBatchMode === "final_artifact_audit" &&
        current.evidence.some((entry) => entry.id === "finance-model:COV048")
      ) {
        qualityResponses.push({ request: current, response });
      }
      return response;
    };
    const result = await runFinanceResearchRun({
      input: {
        ask: "Summarize the supplied market evidence and retain contradictory reports.",
        asOf: AS_OF,
        targets,
      },
      liveFetch: true,
      modelInvoker,
      qualityModelRouting: mockQualityPromptRouting(qualityInvoker),
      batchOptions: { ...BATCH_OPTIONS, collectionAdapters: [source] },
    });

    const contradictionId = "finance-model:COV048";
    const contradiction = result.batch?.committeeEvidence.find(
      (entry) => entry.id === contradictionId,
    );
    expect(contradiction?.text).toContain("late-contradictory-evidence");
    expect(contradiction?.text).toContain("contradictory evidence refutes the early thesis");
    expect(result.quality?.status).toBe("quality-failed");
    expect(result.quality?.verification.status).toBe("not-requested");
    const lateAudit = qualityRequests.find(
      (request) =>
        request.evidenceBatchMode === "final_artifact_audit" &&
        request.evidence.some((entry) => entry.id === contradictionId),
    );
    expect(lateAudit?.dependencyOutputs.formatting).toMatchObject({
      status: "completed",
      output: { kind: "artifact" },
    });
    expect(qualityResponses[0]?.response).toMatchObject({
      kind: "review",
      review: {
        verdict: "revise",
        criticalFindings: [expect.stringContaining(contradictionId)],
      },
    });
    expect(
      result.quality?.attempts[0]?.gates.find((gate) => gate.id === "evidence_batch_reviews"),
    ).toMatchObject({ passed: false, reason: expect.stringContaining("final artifact audit") });
    expect(result.quality?.evidenceCoverage?.controller?.sourceEvidenceIds).toContain(
      contradictionId,
    );
    expect(result.quality?.evidenceCoverage?.controller?.selectedEvidenceIds).toContain(
      contradictionId,
    );
    expect(result.quality?.evidenceCoverage?.controller?.runnerOmittedEvidenceIds).not.toContain(
      contradictionId,
    );
    expect(result.quality?.evidenceCoverage?.issues).toEqual([]);
    expect(result.quarterlyOutput.adopted).toBe(false);

    const complete = await runFinanceResearchRun({
      input: {
        ask: "Summarize the supplied BTC evidence.",
        asOf: AS_OF,
        targets: [
          {
            id: "complete-coverage-target",
            instrument: "BTCUSDT",
            assetClass: "crypto",
            realtime: { requireOfficialReference: false },
            collections: [{ collection: "news", limit: 1, freshnessMaxMinutes: 60 }],
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelRouting: mockQualityPromptRouting(modelInvoker),
      batchOptions: BATCH_OPTIONS,
    });
    expect(complete.quality?.status).toBe("verified");
    expect(complete.quality?.evidenceCoverage).toMatchObject({ passed: true, issues: [] });
    expect(complete.quarterlyOutput.adopted).toBe(true);
  });

  it("does not adopt quality output from an injected invoker without prompt coverage", async () => {
    const result = await runFinanceResearchRun({
      input: {
        ask: "Summarize the supplied BTC evidence.",
        asOf: AS_OF,
        targets: [
          {
            id: "unobserved-quality-target",
            instrument: "BTCUSDT",
            assetClass: "crypto",
            realtime: { requireOfficialReference: false },
            collections: [{ collection: "news", limit: 1, freshnessMaxMinutes: 60 }],
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelInvoker: modelInvoker,
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.quality?.status).toBe("quality-failed");
    expect(result.quality?.evidenceCoverage?.issues.join("\n")).toContain(
      "evidence_coverage_attestation_missing",
    );
    expect(result.quarterlyOutput.adopted).toBe(false);
  });

  it.each([
    ["Summarize the supplied BTC evidence.", true],
    ["Why did BTC move? Provide causal scenarios.", false],
  ] as const)(
    "derives assessment requirements from the original ask: %s",
    async (ask, accepted) => {
      const tasks: string[] = [];
      const withoutAssessment = async (request: unknown) => {
        const task = (request as { task?: string }).task;
        if (task) {
          tasks.push(task);
        }
        const output = (await modelInvoker(request)) as { artifact?: Record<string, unknown> };
        if (!output.artifact) {
          return output;
        }
        const { supportingAnalysis: _omitted, ...artifact } = output.artifact;
        return { ...output, artifact };
      };
      const result = await runFinanceResearchRun({
        input: {
          ask,
          asOf: AS_OF,
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
        modelInvoker: withoutAssessment,
        qualityModelRouting: mockQualityPromptRouting(withoutAssessment),
        modelId: "fixture-model",
        batchOptions: BATCH_OPTIONS,
      });
      expect(tasks.some((task) => /scenario/iu.test(task))).toBe(true);
      expect(result.quality?.status === "verified").toBe(accepted);
      if (!accepted) {
        expect(result.quality?.attempts[0]?.verification.summary).toBe(
          "causal_scenario_assessment_missing_or_invalid",
        );
      }
    },
  );

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
      qualityModelRouting: mockQualityPromptRouting(unsupportedProposalInvoker),
      modelId: "fixture-model",
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.status).toBe("needs_review");
    expect(result.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
    expect(result.quality?.verification.details.join(" ")).toMatch(/declared universe/);
  });

  it("compiles a grounded dynamic allocation into the existing portfolio plan contract", async () => {
    const allocationModel = async (request: unknown): Promise<unknown> => {
      const prompt = (request as { task: string }).task;
      expect(prompt).toContain("Decision mode: strategy_candidate");
      expect(prompt).toContain("exposure direction, trigger, horizon, invalidation");
      expect(prompt).not.toContain("Keep research-only and do not provide execution instructions");
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
              "Strategy candidate using timestamped evidence as of 2026-09-08: if the base scenario persists, retain a bounded allocation. Risk and invalidation are tied to the stated scenario over a six-month horizon.",
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
      qualityModelRouting: mockQualityPromptRouting(allocationModel),
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
      qualityModelRouting: mockQualityPromptRouting(async (request) => {
        requests.push(request);
        return modelInvoker(request);
      }),
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
      qualityModelRouting: mockQualityPromptRouting(capture),
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
      qualityModelRouting: mockQualityPromptRouting(invoke),
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

  it("allows an opportunity despite a stale auxiliary collection without relabeling its quality", async () => {
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
      qualityModelRouting: mockQualityPromptRouting(modelInvoker),
      batchOptions: { ...BATCH_OPTIONS, collectionAdapters: [staleCollection] },
    });

    expect(result.status).toBe("candidate");
    expect(result.gates.find((gate) => gate.id === "source")?.passed).toBe(true);
    expect(result.quarterlyOutput.adopted).toBe(true);
    expect(result.batch?.jobs.some((job) => job.status === "needs_review")).toBe(true);
    expect(
      result.batch?.committeeEvidence.some((entry) =>
        entry.text.includes("unverified research context only"),
      ),
    ).toBe(true);
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
        qualityModelRouting: mockQualityPromptRouting(
          stage === "quality" ? failingModel : modelInvoker,
        ),
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
      qualityModelRouting: mockQualityPromptRouting(modelInvoker),
      batchOptions: { ...BATCH_OPTIONS, collectionAdapters: [denied] },
    });
    expect(JSON.stringify(result.batch)).toContain("403");
    expect(result.status).toBe("candidate");
    expect(result.quarterlyOutput.adopted).toBe(true);
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
      qualityModelRouting: mockQualityPromptRouting(async () => ({
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
      })),
      batchOptions: BATCH_OPTIONS,
    });
    expect(result.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
    expect(result.quarterlyOutput.adopted).toBe(false);
  });

  it("blocks account-only SPY fill claims through the quality verifier", async () => {
    const brokerEvidenceId = "finance-night:broker-profit:2026-09-08";
    const result = await runFinanceResearchRun({
      input: {
        ask: "Review SPY fills",
        asOf: AS_OF,
        targets: [
          {
            id: "spy-fill-attribution",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
          },
        ],
        controllerEvidence: [
          {
            id: brokerEvidenceId,
            source: "paper_broker_controller",
            timestamp: AS_OF,
            text: "Account totals: buyFills=3; unattributedFillCount=3.",
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelRouting: mockQualityPromptRouting(async (request) => {
        const stage = (request as { stage?: string }).stage;
        if (stage !== "draft" && stage !== "format") {
          return modelInvoker(request);
        }
        const evidence = (request as { evidence: readonly { id: string }[] }).evidence;
        const cited = evidence
          .filter((entry) => entry.id === brokerEvidenceId || entry.id === "finance-model:SPY")
          .map((entry) => entry.id);
        return {
          kind: "artifact",
          artifact: {
            answer: "Three SPY buy fills are recorded.",
            claims: [
              {
                id: "spy-fill-claim",
                text: "Three SPY buy fills are recorded",
                status: "supported",
                evidenceIds: cited,
                epistemicClass: "source_observation",
                evidenceRelations: cited.map((evidenceId) => ({
                  evidenceId,
                  relation: "supports",
                })),
              },
            ],
          },
        };
      }),
      batchOptions: BATCH_OPTIONS,
    });
    expect(result.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
    expect(result.quality?.verification.details).toContain(
      "spy-fill-claim:finance-model:SPY:instrument_fill_claim_cites_account_aggregate_only",
    );
    expect(result.quarterlyOutput.adopted).toBe(false);
  });

  it("blocks a supported rule claim that transfers provenance scope across strategies", async () => {
    const rulesEvidenceId = "finance-night:rules:2026-09-27";
    const rulesEvidenceText = JSON.stringify({
      activeRules: [
        {
          ruleId: "trend_risk_normalised_v1",
          instruments: ["SPY", "QQQ"],
          provenance: {
            readScope: "research_only",
            notes:
              "公开方法蒸馏，不是任何管理人的实际参数；skill 明确声明当前状态为材料与规则可复核，不是收益验证",
          },
        },
        {
          ruleId: "opening_range_breakout_long_pre_close_v2",
          instruments: ["SPY"],
          provenance: {
            readScope: "Alpaca Paper calendar and IEX 5-minute bars",
            notes:
              "Adds a calendar-bound pre-close exit to the frozen v1 entry, stop, and reward-target rules. Optiver article informs the decision-loop design, not the alpha signal.",
          },
        },
      ],
    });
    const result = await runFinanceResearchRun({
      input: {
        ask: "Review the supplied SPY strategy provenance.",
        asOf: AS_OF,
        targets: [
          {
            id: "spy-rule-scope",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
          },
        ],
        controllerEvidence: [
          {
            id: rulesEvidenceId,
            source: "strategy_rule_controller",
            timestamp: AS_OF,
            text: rulesEvidenceText,
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelRouting: mockQualityPromptRouting(async (request) => {
        const current = request as QualityHarnessModelRequest;
        if (current.stage !== "draft" && current.stage !== "format") {
          return modelInvoker(request);
        }
        const cited = current.evidence
          .filter((entry) => entry.id === rulesEvidenceId || entry.id === "finance-model:SPY")
          .map((entry) => entry.id);
        return {
          kind: "artifact",
          artifact: {
            answer: "Both active SPY rules are research_only and have no return validation.",
            claims: [
              {
                id: "combined-rule-scope",
                text: "Both trend_risk_normalised_v1 and opening_range_breakout_long_pre_close_v2 are research_only and have no return validation.",
                status: "supported",
                evidenceIds: cited,
                epistemicClass: "source_observation",
                evidenceRelations: cited.map((evidenceId) => ({
                  evidenceId,
                  relation: "supports",
                })),
              },
            ],
          },
        };
      }),
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
    expect(result.quality?.verification.details).toContain(
      "combined-rule-scope:finance-night:rules:2026-09-27:multi_rule_scope_claim_requires_split",
    );
    expect(result.quarterlyOutput.adopted).toBe(false);
  });

  it("does not infer zero SPY execution from an empty decision log and unattributed fills", async () => {
    const intradayEvidenceId = "finance-night:intraday:2026-09-27";
    const brokerEvidenceId = "finance-night:broker-profit:2026-09-27";
    const result = await runFinanceResearchRun({
      input: {
        ask: "Review SPY execution evidence",
        asOf: AS_OF,
        targets: [
          {
            id: "spy-execution-absence",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
          },
        ],
        controllerEvidence: [
          {
            id: intradayEvidenceId,
            source: "paper_intraday_controller",
            timestamp: AS_OF,
            text: '{"decisions":[]}',
          },
          {
            id: brokerEvidenceId,
            source: "paper_broker_controller",
            timestamp: AS_OF,
            text: JSON.stringify({
              accounts: [
                {
                  buyFills: 3,
                  sellFills: 0,
                  attributedFillCount: 0,
                  unattributedFillCount: 3,
                },
              ],
            }),
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelRouting: mockQualityPromptRouting(async (request) => {
        const current = request as QualityHarnessModelRequest;
        if (current.stage !== "draft" && current.stage !== "format") {
          return modelInvoker(request);
        }
        const cited = current.evidence
          .filter(
            (entry) =>
              entry.id === intradayEvidenceId ||
              entry.id === brokerEvidenceId ||
              entry.id === "finance-model:SPY",
          )
          .map((entry) => entry.id);
        return {
          kind: "artifact",
          artifact: {
            answer: "The controller record does not establish SPY trade execution.",
            claims: [
              {
                id: "no-spy-execution",
                text: "No controller-authorized SPY trades executed on 2026-09-27",
                status: "supported",
                evidenceIds: cited,
                epistemicClass: "source_observation",
                evidenceRelations: cited.map((evidenceId) => ({
                  evidenceId,
                  relation: "supports",
                })),
              },
            ],
          },
        };
      }),
      batchOptions: BATCH_OPTIONS,
    });

    expect(result.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
    expect(result.quality?.verification).toMatchObject({
      status: "failed",
      details: expect.arrayContaining([
        "no-spy-execution:finance-model:SPY:empty_intraday_decisions_do_not_establish_zero_instrument_fills",
      ]),
    });
    expect(result.quarterlyOutput.adopted).toBe(false);
  });

  it("admits incomplete historical observations as research while retaining coverage gaps", async () => {
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
      qualityModelRouting: mockQualityPromptRouting(modelInvoker),
      batchOptions: BATCH_OPTIONS,
    });
    expect(result.status).toBe("candidate");
    expect(result.missingEvidence).toContain("history:historical_window_coverage_incomplete");
    expect(result.quarterlyOutput.adopted).toBe(true);
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
        qualityModelRouting: mockQualityPromptRouting(countedModel),
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
        qualityModelRouting: mockQualityPromptRouting(countedModel),
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
      qualityModelRouting: mockQualityPromptRouting(async (request) => {
        qualityRequests.push(request);
        return modelInvoker(request);
      }),
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
      qualityModelRouting: mockQualityPromptRouting(invoke),
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
        qualityModelRouting: mockQualityPromptRouting(invoke),
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

  it("reports failed upstream drafts instead of misdiagnosing an absent producer object", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-upstream-producer-"));
    try {
      const result = await runFinanceResearchRun({
        input: {
          ask: "Review technical timing",
          asOf: AS_OF,
          targets,
          executeModules: true,
          moduleSelection,
        },
        workspaceDir: directory,
        liveFetch: true,
        batchOptions: BATCH_OPTIONS,
        modelInvoker: async (request) => {
          if ((request as { stage?: string }).stage === "draft") {
            throw new Error("diagnostic draft failed");
          }
          return modelInvoker(request);
        },
      });
      expect(result.missingEvidence).toContain(
        "module_producer_input:upstream_research_draft_failed",
      );
      expect(result.missingEvidence).not.toContain(
        "module_producer_input:financeFrameworkProducerInputs must be an object",
      );
      expect(result.status).not.toBe("candidate");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["all", "optional_missing", "required_missing", "receipt_missing"] as const)(
    "checks module evidence after full quality review: %s",
    async (outcome) => {
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
        qualityModelRouting: mockQualityPromptRouting(producerAwareInvoker),
        moduleExecutor: async ({ plan, domainProducerInputs, asOf }) => {
          captured = domainProducerInputs;
          const failedNode =
            outcome === "optional_missing"
              ? plan.composition.control.softNodeIds[0]
              : outcome === "required_missing"
                ? plan.composition.control.hardNodeIds[0]
                : undefined;
          const nodes = plan.composition.nodes.map((node) => ({
            nodeId: node.id,
            moduleId: node.moduleId,
            requiredToolNames: [],
            dependsOn: node.dependsOn,
            status:
              node.id === failedNode
                ? ("blocked_missing_evidence" as const)
                : ("succeeded" as const),
            inputEvidenceIds: ["fixture"],
            outputEvidenceIds: node.id === failedNode ? [] : [`finance-module:${node.id}`],
            toolCalls: [],
            missingEvidence: node.id === failedNode ? ["unavailable_fixture_input"] : [],
          }));
          return {
            receipt: {
              schemaVersion: "lcx_finance_module_execution_v1" as const,
              boundary: "finance_module_execution_research_only" as const,
              requested: true,
              allNodesSucceeded: failedNode === undefined,
              requiredNodesSucceeded: outcome !== "required_missing",
              moduleToolsDispatched: failedNode === undefined,
              compositionNodeIds: plan.composition.topologicalOrder,
              outputEvidenceIds: nodes.flatMap((node) => node.outputEvidenceIds),
              nodes,
              replanFeedback: deriveFinanceModuleReplanFeedback(plan.composition, nodes, true),
              notTouched: [
                "provider_config",
                "external_channel_sender",
                "trading_execution",
                "wallet_or_order_authority",
              ],
            },
            evidence:
              outcome === "receipt_missing"
                ? []
                : nodes
                    .filter((node) => node.status === "succeeded")
                    .map((node) => ({
                      id: node.outputEvidenceIds[0],
                      source: "finance-module-execution",
                      timestamp: asOf,
                      text: JSON.stringify({ moduleId: node.moduleId, status: node.status }),
                    })),
          };
        },
      });
      expect(captured).toMatchObject({ causal_map: { allowedActionAuthority: "research_only" } });
      expect(result.committee?.model.purpose).toBe("producer_preparation");
      expect(result.committee?.model.roleCount).toBe(2);
      expect(result.committee?.coverage.equivalenceStatus).toBe("not_ready");
      expect(result.quality?.status).toBe("verified");
      expect(result.quality?.attempts[0]?.stages.map((stage) => stage.agentId)).toEqual(
        expect.arrayContaining(["adversarial_challenge", "formatting", "final_precheck"]),
      );
      const accepted = outcome === "all" || outcome === "optional_missing";
      expect(result.status).toBe(accepted ? "candidate" : "needs_review");
      expect(result.gates).toContainEqual(
        expect.objectContaining({ id: "module_execution", passed: accepted }),
      );
      if (outcome === "optional_missing") {
        expect(result.moduleExecution).toMatchObject({
          allNodesSucceeded: false,
          moduleToolsDispatched: false,
          requiredEvidenceReady: true,
        });
        expect(
          result.moduleExecution?.nodes.some((node) =>
            node.missingEvidence.includes("unavailable_fixture_input"),
          ),
        ).toBe(true);
      }
    },
  );
});

describe("partial research input boundaries", () => {
  it("does not invent coverage for a target with no supplied material", async () => {
    const result = await runFinanceResearchRun({
      input: {
        ask: "Compare available evidence",
        asOf: AS_OF,
        targets: [
          {
            id: "covered",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
          },
          {
            id: "uncovered",
            instrument: "QQQ",
            assetClass: "us_equity",
            realtime: false,
            collections: [{ collection: "news", freshnessMaxMinutes: 60 }],
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelRouting: mockQualityPromptRouting(modelInvoker),
      batchOptions: {
        ...BATCH_OPTIONS,
        collectionAdapters: [
          {
            ...collectionAdapter(),
            collect: async () => {
              throw new Error("unavailable fixture");
            },
          },
        ],
      },
    });
    expect(result.gates.find((gate) => gate.id === "source")).toMatchObject({
      passed: false,
      reason: expect.stringContaining("uncovered=QQQ"),
    });
    expect(result.quarterlyOutput.adopted).toBe(false);
  });

  it("passes conflicted quotes to research as unverified context without resolving the conflict", async () => {
    const result = await runFinanceResearchRun({
      input: {
        ask: "Investigate a possible price discrepancy",
        asOf: AS_OF,
        targets: [
          {
            id: "conflict",
            instrument: "SPY",
            assetClass: "us_equity",
            realtime: { requireOfficialReference: false },
          },
        ],
      },
      liveFetch: true,
      modelInvoker,
      qualityModelRouting: mockQualityPromptRouting(modelInvoker),
      batchOptions: {
        ...BATCH_OPTIONS,
        realtimeAdapters: [
          realtimeAdapter("first", "primary_market_data"),
          {
            ...realtimeAdapter("second", "cross_check_market_data"),
            collect: async () => {
              const observation = realtimeObservation("second", "cross_check_market_data");
              observation.fields[0].value = 110;
              return observation;
            },
          },
        ],
      },
    });
    expect(result.status).toBe("candidate");
    expect(result.batch?.jobs[0].status).toBe("needs_review");
    expect(
      result.batch?.committeeEvidence.some((entry) =>
        entry.text.includes("unverified research context only"),
      ),
    ).toBe(true);
    expect(result.missingEvidence.some((entry) => entry.includes("conflict"))).toBe(true);
    expect(
      result.batch?.committeeEvidence.some((entry) => entry.text.includes('"value":110')),
    ).toBe(true);
    expect(result.notTouched).toContain("trading_execution");
  });
});

it("does not admit future observations as historical opportunity evidence", async () => {
  const invoke = vi.fn(modelInvoker);
  const adapters = BATCH_OPTIONS.realtimeAdapters.map((adapter) => ({
    ...adapter,
    collect: async () => {
      const observation = realtimeObservation(adapter.providerName, adapter.providerRole);
      observation.fields[0].sourceTimestamp = "2026-09-09T12:00:00.000Z";
      return observation;
    },
  }));
  const result = await runFinanceResearchRun({
    input: {
      ask: "Investigate a historical opportunity",
      asOf: AS_OF,
      targets: [
        {
          id: "future",
          instrument: "SPY",
          assetClass: "us_equity",
          realtime: { requireOfficialReference: false },
        },
      ],
    },
    liveFetch: true,
    modelInvoker: invoke,
    qualityModelRouting: mockQualityPromptRouting(invoke),
    batchOptions: { ...BATCH_OPTIONS, realtimeAdapters: adapters },
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(result.quarterlyOutput.adopted).toBe(false);
  expect(result.missingEvidence).toContain("source_evidence_unavailable");
});
