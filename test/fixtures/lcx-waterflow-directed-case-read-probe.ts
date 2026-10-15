import { createHash } from "node:crypto";
/** Native research producer with local source/model response substitutes; no provider calls. */
import fs from "node:fs/promises";
import path from "node:path";
import { buildDirectedTaskAsk } from "../../scripts/operator/lcx-directed-daily-research-brief.js";
import {
  buildFinanceCaseRun,
  saveFinanceCaseRun,
  readFinanceCaseRun,
} from "../../src/agents/finance-caseflow.js";
import type { FinanceDataGatewayObservationInput } from "../../src/agents/finance-data-gateway.js";
import type {
  FinanceMarketCollectionAdapter,
  FinanceMarketCollectionRequest,
} from "../../src/agents/finance-market-collection-registry.js";
import type {
  FinanceRealtimeSourceAdapter,
  FinanceRealtimeSourceRequest,
} from "../../src/agents/finance-realtime-source-registry.js";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.js";
import { buildQualityHarnessModelPromptWithCoverage } from "../../src/agents/local-text-model-adapter.js";
import type {
  ModelCallObservation,
  LogicalAgentModelAdapter,
  LogicalAgentModelRouting,
} from "../../src/agents/logical-agent-model-router.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
export type DirectedCaseFault =
  | "missing_source"
  | "timeout"
  | "quality_failure"
  | "conflicting_source";
export async function produceDirectedCase(params: {
  directory: string;
  caseId: string;
  price?: number;
  taskId?: string;
  ask?: string;
  asOf?: string;
  instrument?: string;
  planned?: boolean;
  fault?: DirectedCaseFault;
}) {
  const asOf = params.asOf ?? "2026-10-11T12:00:00.000Z";
  const price = params.price ?? 100;
  const sourceCalls: Array<{
    adapterId: string;
    request: FinanceRealtimeSourceRequest | FinanceMarketCollectionRequest;
    aborted: boolean;
    response?: FinanceDataGatewayObservationInput;
  }> = [];
  const qualityRequests: QualityHarnessModelRequest[] = [];
  let modelCalls = 0;
  const sourceFault = async (signal: AbortSignal) => {
    if (params.fault === "missing_source") {
      throw new Error("offline_source_evidence_missing");
    }
    if (params.fault === "timeout") {
      await new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  };
  const realtime = (
    providerRole: FinanceRealtimeSourceAdapter["providerRole"],
  ): FinanceRealtimeSourceAdapter => ({
    id: `offline-${providerRole}`,
    providerName: `offline-${providerRole}`,
    providerRole,
    priority: 1,
    supports: () => true,
    collect: async (request, signal) => {
      const call: (typeof sourceCalls)[number] = {
        adapterId: `offline-${providerRole}`,
        request,
        aborted: false,
      };
      sourceCalls.push(call);
      signal.addEventListener(
        "abort",
        () => {
          call.aborted = true;
        },
        { once: true },
      );
      await sourceFault(signal);
      const response: FinanceDataGatewayObservationInput = {
        providerName: `offline-${providerRole}`,
        providerRole,
        sourceFamily:
          providerRole === "official_or_issuer_reference" ? "official_filing" : "market_data_api",
        observedAt: asOf,
        timezone: "UTC",
        delayStatus: "realtime",
        fields: [
          {
            name: "last_price",
            value:
              params.fault === "conflicting_source" && providerRole === "cross_check_market_data"
                ? price + 10
                : price,
            currency: "USD",
            adjusted: false,
            fieldDefinition: "offline observed last price",
            sourceTimestamp: asOf,
            sourceUrlOrArtifact: `fixture://${providerRole}/${request.instrument}`,
          },
        ],
      };
      call.response = response;
      return response;
    },
  });
  const collection: FinanceMarketCollectionAdapter = {
    id: "offline-news",
    providerName: "offline-news",
    providerRole: "primary_market_data",
    priority: 1,
    supports: () => true,
    collect: async (request, signal) => {
      const call = { adapterId: "offline-news", request, aborted: false };
      sourceCalls.push(call);
      signal.addEventListener(
        "abort",
        () => {
          call.aborted = true;
        },
        { once: true },
      );
      await sourceFault(signal);
      return [
        {
          itemId: "offline-news-item",
          collection: request.collection,
          providerName: "offline-news",
          providerRole: "primary_market_data",
          sourceFamily: "market_data_api",
          sourceTimestamp: asOf,
          observedAt: asOf,
          delayStatus: "realtime",
          sourceUrlOrArtifact: "fixture://news",
          data: { close: price, title: "offline source-bound market evidence" },
        },
      ];
    },
  };
  const modelInvoker = async (request: unknown): Promise<unknown> => {
    modelCalls++;
    const payload = request as Partial<QualityHarnessModelRequest>;
    if (payload.stage === "intake") {
      return { kind: "plan", requirements: ["timestamped evidence"], missingEvidence: [] };
    }
    if (payload.stage === "draft" || payload.stage === "format") {
      const evidenceId = payload.evidence?.[0]?.id ?? "finance-batch-summary";
      return {
        kind: "artifact",
        artifact: {
          answer:
            "Research-only outlook: supplied evidence supports a bounded candidate view with uncertainty and invalidation checks.",
          claims: [
            {
              id: "claim-1",
              text: "The view is limited to supplied timestamps and source coverage.",
              status: "supported",
              evidenceIds: [evidenceId],
              epistemicClass: "inference",
              basis: "The actual supplied evidence limits the claim.",
              evidenceRelations: [{ evidenceId, relation: "supports" }],
            },
          ],
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
            scenarios: ["base", "up", "down"].map((id, i) => ({
              id,
              probability: [0.5, 0.3, 0.2][i],
              condition: id,
              expectedEffect: "conditional repricing",
              invalidation: "policy surprise",
              evidenceIds: [evidenceId],
            })),
          },
        },
      };
    }
    return {
      kind: "review",
      review: {
        verdict: params.fault === "quality_failure" && payload.stage ? "revise" : "pass",
        criticalFindings:
          params.fault === "quality_failure" && payload.stage
            ? ["offline_quality_contradiction: supplied evidence does not justify the draft"]
            : [],
        evidenceGaps: [],
        notes: (payload.evidence ?? []).map((entry) => `[${entry.id}] read against the draft.`),
      },
    };
  };
  const coverage = new Map<string, ModelCallObservation["evidenceCoverage"]>();
  const adapter: LogicalAgentModelAdapter = {
    id: "offline-quality",
    provider: "fixture",
    modelId: "offline-quality",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: async (request) => {
      const payload = request.payload as QualityHarnessModelRequest;
      qualityRequests.push(payload);
      coverage.set(
        request.callId,
        buildQualityHarnessModelPromptWithCoverage(payload).evidenceCoverage,
      );
      return modelInvoker(payload);
    },
    observe: (request) => ({
      callId: request.callId,
      provider: "fixture",
      modelId: "offline-quality",
      transportRequestId: `fixture:${request.callId}`,
      kind: "model_inference",
      evidenceCoverage: coverage.get(request.callId),
    }),
  };
  const qualityModelRouting: LogicalAgentModelRouting = {
    revision: "offline-caseflow-v1",
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: 1_000_000,
      timeoutMs: 1_000,
    },
  };
  const receipt = await runFinanceResearchRun({
    input: {
      ask: params.ask ?? buildDirectedTaskAsk(params.taskId ?? "index_options_regime"),
      asOf,
      horizonMonths: 6,
      targets: [
        {
          id: "directed-test-market",
          instrument: params.instrument ?? "QQQ",
          assetClass: "equity",
          realtime: { requireOfficialReference: true },
          collections: [{ collection: "news", limit: 1, freshnessMaxMinutes: 60 }],
        },
      ],
    },
    liveFetch: !params.planned,
    qualityEnabled: true,
    modelInvoker,
    qualityModelRouting,
    modelId: "offline-fixture",
    batchOptions: {
      realtimeAdapters: [
        realtime("primary_market_data"),
        realtime("cross_check_market_data"),
        realtime("official_or_issuer_reference"),
      ],
      collectionAdapters: [collection],
      maxSourcesPerJob: 3,
      maxConcurrency: 1,
      sourceTimeoutMs: params.fault === "timeout" ? 10 : 1_000,
      totalTimeoutMs: 5_000,
    },
  });
  const frozen = buildFinanceCaseRun({
    caseId: params.caseId,
    receipt,
    execution: { mode: "offline_fixture", providerCalls: 0, brokerCalls: 0 },
    budget: { maxApiCalls: 64 },
  });
  const saved = await saveFinanceCaseRun(params.directory, frozen);
  const before = await fs.readFile(saved.path, "utf8");
  const readback = await readFinanceCaseRun(params.directory, saved.ref);
  return { receipt, saved, readback, bytes: before, sourceCalls, modelCalls, qualityRequests };
}

export function directedCaseSha(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function writeDirectedBindings(
  workspace: string,
  run: Awaited<ReturnType<typeof produceDirectedCase>>,
  taskId = "index_options_regime",
) {
  const bindings = {
    schemaVersion: "lcx_directed_daily_case_bindings_v1",
    date: "2026-10-11",
    asOf: "2026-10-11T12:00:00.000Z",
    caseDirectory: "cases",
    tasks: [
      {
        taskId,
        caseId: run.readback.case.id,
        ref: run.saved.ref,
        caseSha256: directedCaseSha(run.bytes),
        snapshotFingerprint: run.readback.run.snapshotFingerprint,
        ask: run.readback.case.question,
        targets: run.receipt.plan.targets.map((t) => t.instrument),
      },
    ],
  };
  const file = path.join(workspace, "bindings.json");
  await fs.writeFile(file, JSON.stringify(bindings, null, 2) + "\n");
  return { file, bindings };
}
