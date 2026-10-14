import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readPredictionMarketResearchIntake } from "../../scripts/operator/lcx-external-agent-upgrade-radar.js";
import { hardenLocalBrainPlanForAsk } from "../../scripts/operator/local-brain-contracts.js";
import { createYahooDelayedMarketAdapter } from "../../src/agents/finance-realtime-source-registry.js";
import { createFinanceReplyEvidenceTracker } from "../../src/agents/finance-reply-evidence.js";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness.js";
import { createFinanceResearchRunTool } from "../../src/agents/tools/finance-research-run-tool.js";
import {
  clearAgentRunContext,
  onAgentEvent,
  type AgentEventPayload,
} from "../../src/infra/agent-events.js";
import { readFileWithinRoot } from "../../src/infra/fs-safe.js";
import { publishOriginalFinanceResult } from "./lcx-waterflow-finance-reply-probe.js";

const asOf = "2026-07-01T12:00:00.000Z";
const instrument = "offline-polymarket-resolution-question";
const ask =
  "Review this Polymarket prediction market research source; resolution criteria are ambiguous. Do not infer an outcome or place an order.";
const offlineConfig = {
  agents: { defaults: { model: { primary: "offline/guarded" } } },
  models: {
    providers: {
      offline: {
        baseUrl: "https://offline.invalid",
        api: "openai-completions" as const,
        models: [
          {
            id: "guarded",
            name: "offline guard",
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
};

/** Actual registered tool/runner/receipt publisher/readback; only source/model transports are offline. */
export async function probePredictionMarket(workspaceDir: string, proofDir?: string) {
  const sourceBody = JSON.stringify({
    fixture: "synthetic prediction-market source, not a fetched market or legal resolution",
    id: instrument,
    question: "Will the offline event occur?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.61", "0.39"],
    resolutionSource: "unknown",
    endDate: "2026-07-02T00:00:00.000Z",
    liquidity: "1",
    updatedAt: asOf,
  });
  const httpRequests: string[] = [];
  const yahoo = createYahooDelayedMarketAdapter({
    fetchImpl: async (url) => {
      httpRequests.push(String(url));
      return { ok: true, status: 200, text: async () => sourceBody };
    },
  });
  const targets = [
    { id: "prediction-market-source", instrument, assetClass: "prediction_market", realtime: {} },
  ];
  const input = { ask, asOf, targets, decisionMode: "research_only" as const };
  const nativeRequest = {
    instrument,
    assetClass: "prediction_market",
    useCase: "finance_research_run",
    asOf,
  };
  let modelCalls = 0;
  const modelTransport = async (): Promise<never> => {
    modelCalls++;
    throw new Error("offline_model_transport_unavailable");
  };
  let receipt: Awaited<ReturnType<typeof runFinanceResearchRun>> | undefined;
  let runnerInput: Parameters<typeof runFinanceResearchRun>[0]["input"] | undefined;
  const tool = createFinanceResearchRunTool({
    workspaceDir,
    config: offlineConfig,
    executeResearch: async (options) => {
      runnerInput = options.input;
      receipt = await runFinanceResearchRun({
        ...options,
        allowProviderCalls: false,
        modelRouting: undefined,
        qualityModelRouting: undefined,
        modelInvoker: modelTransport,
        qualityModelInvoker: modelTransport,
        batchOptions: {
          ...options.batchOptions,
          realtimeAdapters: [yahoo],
          collectionAdapters: [],
          maxApiCalls: 4,
          sourceTimeoutMs: 600,
          totalTimeoutMs: 800,
          retry: { attempts: 1 },
        },
      });
      return receipt;
    },
  });
  const result = await tool.execute("prediction-source-call", {
    ...input,
    live: true,
    timeoutMs: 1000,
  });
  if (!receipt || !runnerInput) {
    throw new Error("original_prediction_research_owner_not_invoked");
  }
  const details = result.details as { receiptPath: string; receiptSha256: string };
  const originalBytes = await fs.readFile(details.receiptPath);
  const runId = randomUUID();
  const sessionKey = `offline-prediction:${runId}`;
  const tracker = createFinanceReplyEvidenceTracker({ workspaceDir, sessionKey });
  tracker.start(runId);
  const observedEvents: AgentEventPayload[] = [];
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId === runId) {
      observedEvents.push(event);
      tracker.observe(event);
    }
  });
  try {
    await publishOriginalFinanceResult({
      runId,
      sessionKey,
      result,
      toolCallId: "prediction-source-call",
    });
  } finally {
    unsubscribe();
    clearAgentRunContext(runId);
  }
  const candidate = `Observed market probability is unverified. Resolution/source evidence must be checked before any conclusion.\n\`\`\`figures\n${JSON.stringify([{ kind: "observed", name: "outcome_probability", value: 0.61, unit: "probability" }])}\n\`\`\`\n\`\`\`finance_evidence\n${JSON.stringify({ toolCallId: "prediction-source-call", receiptSha256: details.receiptSha256, snapshotPointer: "/batch/jobs/0/receipt/snapshot", instrument, asOf })}\n\`\`\``;
  const consumer = await tracker.check(candidate, ask);
  const route = hardenLocalBrainPlanForAsk({}, { ask, sourceSummary: sourceBody });
  const sample = {
    input,
    runnerInput,
    sourceBody,
    nativeRequest,
    yahooEligible: yahoo.supports(nativeRequest),
    httpRequests,
    modelCalls,
    receipt,
    result,
    observedEvents,
    candidate,
    consumer,
    route,
    receiptContentHashMatches:
      createHash("sha256").update(originalBytes).digest("hex") === details.receiptSha256,
    evidenceOrigin: "offline_fixture",
    naturalRunObserved: false,
    semanticAdoption: "not_proven",
    stageBoundary:
      "prediction source caller/resolution/microstructure not implemented; generic runner rejects unsupported source, model and quality never run",
  };
  if (proofDir) {
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(
      path.join(proofDir, "actual-native.json"),
      JSON.stringify(sample, null, 2) + "\n",
    );
    await fs.writeFile(path.join(proofDir, "original-receipt.json"), originalBytes);
  }
  return { ...sample, tracker, details, runId, sessionKey };
}

/** Same original owner attempt; only actual file IO and optional Quality response transport are replaceable. */
export async function preparePredictionResolutionProbe(
  workspaceDir: string,
  options: {
    missingCriteria?: boolean;
    conflictingCriteria?: boolean;
    sourceScope?: { accountId: string; runId: string };
  } = {},
) {
  const scope = { accountId: "private-prediction-account", runId: randomUUID() };
  const packet = {
    fixture: "synthetic local prediction packet; not fetched market evidence",
    marketId: "private-market-resolution",
    question: "Will the private synthetic indicator reach 30?",
    sourceUrl: "https://offline.invalid/prediction/private-market",
    observedAt: "2026-07-01T12:00:00.000Z",
    resolutionCriteria: options.missingCriteria
      ? undefined
      : options.conflictingCriteria
        ? "Resolve Yes if the indicator equals 30. Resolve No if the indicator equals 30."
        : "Resolve Yes if the final published indicator is at least 30; otherwise resolve No.",
    resolutionSource: "Synthetic issuer release; authoritative status unknown",
    closeDate: "2026-07-02T12:00:00.000Z",
    timezone: "UTC",
    ...(options.sourceScope ? { scope: options.sourceScope } : {}),
  };
  await fs.mkdir(workspaceDir, { recursive: true });
  const sourcePath = "private-prediction-source.json";
  const text = `${JSON.stringify(packet, null, 2)}\n`;
  await fs.writeFile(path.join(workspaceDir, sourcePath), text);
  const source = {
    path: sourcePath,
    sha256: createHash("sha256").update(text).digest("hex"),
    version: "synthetic-v1",
  };
  const fileCalls: string[] = [];
  const readFile: typeof readFileWithinRoot = async (input) => {
    fileCalls.push(input.relativePath);
    return readFileWithinRoot(input);
  };
  const modelInputs: QualityHarnessModelRequest[] = [];
  let held = false;
  let aborted = false;
  const releases: Array<() => void> = [];
  const modelInvoker = async (raw: unknown, signal: AbortSignal): Promise<unknown> => {
    const request = raw as QualityHarnessModelRequest;
    modelInputs.push(structuredClone(request));
    signal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    if (held) {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    }
    const actualText = request.evidence.map((entry) => entry.text).join("\n");
    const conflict =
      actualText.includes("Resolve Yes if the indicator equals 30.") &&
      actualText.includes("Resolve No if the indicator equals 30.");
    if (request.stage === "intake") {
      return {
        kind: "plan",
        requirements: ["Review actual resolution clauses and their ambiguity"],
        missingEvidence: [],
      };
    }
    if (request.stage === "draft" || request.stage === "format") {
      return {
        kind: "artifact",
        artifact: {
          answer: conflict
            ? "The same threshold has opposite resolution instructions. A directional conclusion is held."
            : "The source was read; authoritative resolution interpretation remains unresolved.",
          claims: [
            {
              id: "resolution-ambiguity",
              text: "Resolution interpretation requires independent verification.",
              status: "uncertain",
              evidenceIds: [],
              uncertainty: "Synthetic offline review; no factual market acceptance",
            },
          ],
        },
      };
    }
    return {
      kind: "review",
      review: {
        verdict: conflict ? "reject" : "pass",
        criticalFindings: conflict ? ["opposite_resolution_for_same_observation"] : [],
        evidenceGaps: [],
        notes: ["Compared supplied original clauses only; market source trust remains unknown."],
      },
    };
  };
  return {
    workspaceDir,
    scope,
    source,
    text,
    packet,
    readFile,
    fileCalls,
    modelInputs,
    modelInvoker,
    run: (
      extra: Omit<
        Parameters<typeof readPredictionMarketResearchIntake>[0],
        "workspaceDir" | "scope" | "source"
      > = {},
    ) => readPredictionMarketResearchIntake({ workspaceDir, scope, source, readFile, ...extra }),
    holdModel: () => {
      held = true;
    },
    releaseModel: () => {
      held = false;
      for (const release of releases.splice(0)) {
        release();
      }
    },
    abortObserved: () => aborted,
  };
}

export async function savePredictionResolutionProof(
  name: string,
  probe: Awaited<ReturnType<typeof preparePredictionResolutionProbe>>,
  result: unknown,
) {
  const root = process.env.LCX_PREDICTION_RESOLUTION_PROOF_DIR;
  if (!root) {
    return;
  }
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  const sourceBytes = await fs
    .readFile(path.join(probe.workspaceDir, probe.source.path))
    .catch(() => undefined);
  if (sourceBytes) {
    await fs.writeFile(path.join(directory, probe.source.path), sourceBytes);
  }
  await fs.writeFile(
    path.join(directory, "actual-owner-result.json"),
    JSON.stringify(
      {
        hostScope: probe.scope,
        source: probe.source,
        result,
        fileCalls: probe.fileCalls,
        modelInputs: probe.modelInputs,
        modelAbortObserved: probe.abortObserved(),
        evidenceOrigin: "offline_fixture",
        semanticAdoption: "not_proven",
        naturalRunObserved: false,
      },
      null,
      2,
    ) + "\n",
  );
}
