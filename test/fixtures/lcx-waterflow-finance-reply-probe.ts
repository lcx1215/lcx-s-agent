import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { executeFinanceModuleComposition } from "../../src/agents/finance-module-execution.js";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "../../src/agents/pi-embedded-subscribe.handlers.tools.js";
import type { ToolHandlerContext } from "../../src/agents/pi-embedded-subscribe.handlers.types.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
import { createFinanceResearchRunTool } from "../../src/agents/tools/finance-research-run-tool.js";
import {
  buildFinanceFrameworkCoreContractPath,
  parseFinanceFrameworkCoreContractArtifact,
} from "../../src/hooks/bundled/lobster-brain-registry.js";
import { registerAgentRunContext, getAgentRunContext } from "../../src/infra/agent-events.js";
import { probeOriginalCaseflow, type CaseflowProbeFault } from "./lcx-waterflow-caseflow-probe.js";
import { prepareOriginalFinanceModuleMain } from "./lcx-waterflow-finance-module-main-probe.js";

export type OfflineFinanceModulePreparation = Awaited<
  ReturnType<typeof prepareOriginalFinanceModuleMain>
>;
type OfflineModuleCall = {
  preparation: OfflineFinanceModulePreparation;
  signal: AbortSignal;
  host: { runId: string; sessionKey: string };
};

/** Native source/quality/receipt owners; only source adapters and model transports are substitutes. */
export async function executeOfflineFinanceResearchTool(
  directory: string,
  fault?: CaseflowProbeFault,
  modules?: OfflineModuleCall,
) {
  if (modules) {
    return executeOfflineFinanceModuleTool(directory, modules);
  }
  let producer: Awaited<ReturnType<typeof probeOriginalCaseflow>> | undefined;
  const tool = createFinanceResearchRunTool({
    workspaceDir: directory,
    executeResearch: async () => {
      producer = await probeOriginalCaseflow({ directory, caseId: "reply-source", fault });
      return producer.receipt;
    },
  });
  const result = await tool.execute("finance-call", {
    ask: "Review supplied BTC evidence and retain uncertainty.",
    asOf: "2026-07-01T12:00:00.000Z",
  });
  if (!producer) {
    throw new Error("original producer was not invoked");
  }
  return { result, producer };
}

/** Keep the original tool input/signal, replacing only its configured research transports. */
async function executeOfflineFinanceModuleTool(
  directory: string,
  { preparation, signal, host }: OfflineModuleCall,
) {
  let receipt: Awaited<ReturnType<typeof runFinanceResearchRun>> | undefined;
  let moduleInvocationCount = 0;
  let moduleInvocation:
    | Omit<Parameters<typeof executeFinanceModuleComposition>[0], "signal">
    | undefined;
  let invocation:
    | {
        toolInput: Parameters<typeof runFinanceResearchRun>[0]["input"];
        runnerInput: Parameters<typeof runFinanceResearchRun>[0]["input"];
        toolWorkspaceDir?: string;
        signalPresent: boolean;
        callerSignalPresent: boolean;
        liveFetch?: boolean;
        configuredProviderCallsAllowed: false;
        hostContextSource: string;
        hostCaller: { runId: string; sessionKey: string };
      }
    | undefined;
  const tool = createFinanceResearchRunTool({
    workspaceDir: directory,
    config: {},
    agentRunId: host.runId,
    agentSessionKey: host.sessionKey,
    // The original live tool constructs its workflow; these inert slots are never invoked.
    slotModels: {
      fast: "fixture/never-provider",
      reasoning: "fixture/never-provider",
      review: "fixture/never-provider",
    },
    executeResearch: async (options) => {
      const runnerInput = {
        ...options.input,
        horizonMonths: preparation.input.horizonMonths,
        controllerEvidence: preparation.input.controllerEvidence,
        portfolioContext: preparation.input.portfolioContext,
      };
      invocation = {
        toolInput: structuredClone(options.input),
        runnerInput: structuredClone(runnerInput),
        toolWorkspaceDir: options.workspaceDir,
        signalPresent: options.signal instanceof AbortSignal,
        callerSignalPresent: signal instanceof AbortSignal,
        liveFetch: options.liveFetch,
        configuredProviderCallsAllowed: false,
        hostContextSource: "original_private_active_strategy_ledger_projection",
        hostCaller: { ...host },
      };
      receipt = await runFinanceResearchRun({
        ...options,
        input: runnerInput,
        workspaceDir: directory,
        financeStateDir: preparation.book,
        allowProviderCalls: false,
        modelRouting: undefined,
        qualityEnabled: true,
        modelInvoker: async (request, requestSignal) => {
          const payload = request as QualityHarnessModelRequest;
          preparation.committeeRequests.push(structuredClone(payload));
          return preparation.scriptedOutput(payload, requestSignal);
        },
        qualityModelRouting: preparation.routing,
        moduleExecutor: async (parameters) => {
          moduleInvocationCount++;
          const { signal: moduleSignal, ...originalInput } = parameters;
          moduleInvocation = structuredClone(originalInput);
          return executeFinanceModuleComposition({ ...parameters, signal: moduleSignal });
        },
        batchOptions: {
          ...options.batchOptions,
          realtimeAdapters: [
            preparation.realtime("primary_market_data"),
            preparation.realtime("cross_check_market_data"),
          ],
          collectionAdapters: [preparation.collection],
          maxSourcesPerJob: 2,
          maxConcurrency: 1,
          sourceTimeoutMs: 20,
          totalTimeoutMs: 2_000,
        },
      });
      return receipt;
    },
  });
  const { ask, asOf, targets, decisionMode, strategyStage, moduleSelection } = preparation.input;
  const args = {
    ask,
    asOf,
    targets,
    decisionMode,
    strategyStage,
    moduleSelection,
    live: true,
    executeModules: true,
    timeoutMs: 10_000,
    maxModelCalls: 24,
    maxApiCalls: 16,
  };
  const result = await tool.execute("finance-call", args, signal);
  if (!receipt || !invocation) {
    throw new Error("original module research caller did not run");
  }
  const contractPath = path.join(directory, buildFinanceFrameworkCoreContractPath());
  const contractBytes = await fs.readFile(contractPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  const frameworkReadback = contractBytes
    ? {
        path: contractPath,
        sha256: createHash("sha256").update(contractBytes).digest("hex"),
        text: contractBytes.toString("utf8"),
        artifact: parseFinanceFrameworkCoreContractArtifact(contractBytes.toString("utf8")),
      }
    : undefined;
  return {
    result,
    producer: {
      receipt,
      invocation,
      moduleInvocation,
      moduleInvocationCount,
      frameworkReadback,
      sourceBodyUses: preparation.sourceBodyUses,
      toolArgs: args,
      sourceCalls: preparation.sourceCalls,
      committeeRequests: preparation.committeeRequests,
      qualityRequests: preparation.qualityRequests,
      hostScope: preparation.scope,
      productionHandoffGap: "production_controller_context_handoff_not_wired",
    },
  };
}

/** Publish using the original synchronous tool handler, never fabricated host evidence. */
export async function publishOriginalFinanceResult(params: {
  runId: string;
  sessionKey: string;
  result: unknown;
  toolCallId?: string;
  isError?: boolean;
  onAgentEvent?: ToolHandlerContext["params"]["onAgentEvent"];
  allowContextRegistration?: boolean;
}) {
  if (params.allowContextRegistration !== false && !getAgentRunContext(params.runId)?.sessionKey) {
    registerAgentRunContext(params.runId, { sessionKey: params.sessionKey });
  }
  const noop = () => {};
  const ctx: ToolHandlerContext = {
    params: { runId: params.runId, onAgentEvent: params.onAgentEvent },
    flushBlockReplyBuffer: noop,
    log: { debug: noop, warn: noop },
    state: {
      toolMetaById: new Map(),
      toolMetas: [],
      toolSummaryById: new Set(),
      pendingMessagingTargets: new Map(),
      pendingMessagingTexts: new Map(),
      pendingMessagingMediaUrls: new Map(),
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      successfulCronAdds: 0,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: noop,
    emitToolOutput: noop,
    trimMessagingToolSent: noop,
  };
  const event = {
    type: "tool_execution_end",
    toolName: "finance_research_run",
    toolCallId: params.toolCallId ?? "finance-call",
    isError: params.isError ?? false,
    result: params.result,
  } satisfies AgentEvent & { result: unknown };
  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    toolName: "finance_research_run",
    toolCallId: params.toolCallId ?? "finance-call",
    args: {},
  });
  await handleToolExecutionEnd(ctx, event);
}
