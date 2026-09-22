import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  FINANCE_BRAIN_MODULES,
  financeBrainModuleCatalog,
  parseFinanceModuleSelection,
} from "../finance-brain-orchestration.js";
import {
  FINANCE_DECISION_MODES,
  FINANCE_STRATEGY_STAGES,
  type FinanceDecisionMode,
  type FinanceStrategyStage,
} from "../finance-decision-policy.js";
import {
  createFinanceModelWorkflow,
  type FinanceWorkflowSlotModels,
} from "../finance-model-workflow.js";
import { runFinanceResearchRun } from "../finance-research-runner.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import { jsonResult, readStringParam, ToolInputError, type AnyAgentTool } from "./common.js";

const targetCollectionSchema = Type.Object({
  collection: Type.String({ minLength: 1, maxLength: 64 }),
  seriesId: Type.Optional(Type.String({ maxLength: 256 })),
  fromDate: Type.Optional(Type.String({ maxLength: 32 })),
  toDate: Type.Optional(Type.String({ maxLength: 32 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 250 })),
  freshnessMaxMinutes: Type.Number({ minimum: 1, maximum: 60 * 24 * 366 }),
});

const targetSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  sourceAdapterIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
  ),
  instrument: Type.String({ minLength: 1, maxLength: 64 }),
  assetClass: Type.String({ minLength: 1, maxLength: 64 }),
  realtime: Type.Optional(
    Type.Union([
      Type.Literal(false),
      Type.Partial(
        Type.Object({
          freshnessMaxMinutes: Type.Number({ minimum: 1, maximum: 60 * 24 * 366 }),
          crossSourceSkewMaxMinutes: Type.Number({ minimum: 0, maximum: 60 * 24 * 366 }),
          requireOfficialReference: Type.Boolean(),
        }),
      ),
    ]),
  ),
  collections: Type.Optional(Type.Array(targetCollectionSchema, { maxItems: 16 })),
});

const moduleCompositionSchema = Type.Object(
  {
    nodes: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_-]*$" }),
          moduleId: Type.Union(FINANCE_BRAIN_MODULES.map(({ id }) => Type.Literal(id))),
          dependsOn: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 24 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 24 },
    ),
    maxReplans: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
  },
  {
    additionalProperties: false,
    description:
      "Finite analytical module DAG. It cannot grant tools, provider access, memory writes, or execution authority.",
  },
);

const schema = Type.Object({
  ask: Type.String({ minLength: 1, maxLength: 12_000 }),
  asOf: Type.String({ description: "Explicit ISO timestamp for the research evidence window" }),
  targets: Type.Optional(Type.Array(targetSchema, { maxItems: 64 })),
  /**
   * Answer-authority mode. `research_only` stays the compatibility default; the
   * candidate modes only widen what the frozen decision packet may contain and
   * never grant broker, wallet, or execution authority.
   */
  decisionMode: Type.Optional(Type.Union(FINANCE_DECISION_MODES.map((mode) => Type.Literal(mode)))),
  /**
   * Declared research maturity stage. When present it binds the mode: a method that has only
   * reached `paper_candidate` may not be written up as `conditional_trade_candidate`.
   */
  strategyStage: Type.Optional(
    Type.Union(FINANCE_STRATEGY_STAGES.map((stage) => Type.Literal(stage))),
  ),
  moduleSelection: Type.Optional(
    Type.Object(
      {
        moduleIds: Type.Array(Type.Union(FINANCE_BRAIN_MODULES.map(({ id }) => Type.Literal(id))), {
          minItems: 1,
          maxItems: FINANCE_BRAIN_MODULES.length,
          uniqueItems: true,
        }),
        rationale: Type.String({ minLength: 1, maxLength: 2000 }),
        composition: Type.Optional(moduleCompositionSchema),
      },
      {
        additionalProperties: false,
        description:
          "Optional analytical module composition in preferred order, replacing rule-suggested domain lenses. Required risk, evidence and review gates remain. Use feedback from a previous run to revise the composition; this does not dispatch module tools, change data targets or authorize execution. Supply targets separately when different evidence is needed.",
      },
    ),
  ),
  live: Type.Optional(Type.Boolean({ default: false })),
  executeModules: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "When true, dispatch the bounded module DAG against the fetched evidence and attach per-node receipts. This remains research-only and does not grant execution authority.",
    }),
  ),
  maxModelCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 48, default: 24 })),
  maxApiCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 64, default: 32 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 1_200_000, default: 600_000 })),
});

function boundedInteger(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const value = params[key] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ToolInputError(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** All channel plugins use the same agent tool; transport never owns research or model selection. */
export function createFinanceResearchRunTool(options?: {
  workspaceDir?: string;
  config?: OpenClawConfig;
  slotModels?: FinanceWorkflowSlotModels;
  executeResearch?: typeof runFinanceResearchRun;
}): AnyAgentTool {
  const workspace = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    name: "finance_research_run",
    label: "Finance Research Workflow",
    description:
      "Plan or explicitly execute the canonical finance research workflow with configured models, independent review and finding closure. Works through any channel's normal agent tool dispatch. Planning is the default; live=true permits bounded source/model calls. decisionMode selects the answer authority (research_only by default; the candidate modes may produce a reviewable strategy or conditional buy/sell candidate) and never grants broker, wallet, or execution authority. strategyStage declares how far a method has been verified (method_only / research_candidate / paper_candidate / conditional_trade_candidate) and binds which decisionMode it may be written up in. moduleSelection composes registered analytical modules while required risk/math/review lanes remain; executeModules explicitly dispatches their existing bounded tools against fetched evidence and returns per-node receipts. Returns a local receipt, never sends a platform message or claims model learning or external delivery.",
    parameters: schema,
    execute: async (toolCallId, args, callerSignal) => {
      callerSignal?.throwIfAborted();
      const params = args as Record<string, unknown>;
      const ask = readStringParam(params, "ask", { required: true });
      const asOf = readStringParam(params, "asOf", { required: true });
      if (ask.length > 12_000 || !Number.isFinite(Date.parse(asOf))) {
        throw new ToolInputError("ask must be bounded and asOf must be a valid timestamp");
      }
      if (
        (params.live !== undefined && typeof params.live !== "boolean") ||
        (params.executeModules !== undefined && typeof params.executeModules !== "boolean")
      ) {
        throw new ToolInputError("live and executeModules must be booleans");
      }
      if (params.executeModules === true && params.live !== true) {
        throw new ToolInputError(
          "executeModules requires live=true so module tools receive fetched evidence",
        );
      }
      const rawDecisionMode = params.decisionMode;
      if (
        rawDecisionMode !== undefined &&
        !FINANCE_DECISION_MODES.includes(rawDecisionMode as FinanceDecisionMode)
      ) {
        throw new ToolInputError(
          `decisionMode must be one of ${FINANCE_DECISION_MODES.join(", ")}`,
        );
      }
      const decisionMode = rawDecisionMode as FinanceDecisionMode | undefined;
      const rawStrategyStage = params.strategyStage;
      if (
        rawStrategyStage !== undefined &&
        !FINANCE_STRATEGY_STAGES.includes(rawStrategyStage as FinanceStrategyStage)
      ) {
        throw new ToolInputError(
          `strategyStage must be one of ${FINANCE_STRATEGY_STAGES.join(", ")}`,
        );
      }
      const strategyStage = rawStrategyStage as FinanceStrategyStage | undefined;
      const moduleSelection = parseFinanceModuleSelection(params.moduleSelection);
      const maxModelCalls = boundedInteger(params, "maxModelCalls", 24, 48);
      const maxApiCalls = boundedInteger(params, "maxApiCalls", 32, 64);
      const timeoutMs = boundedInteger(params, "timeoutMs", 600_000, 1_200_000, 1_000);
      const targets = params.targets as Parameters<
        typeof runFinanceResearchRun
      >[0]["input"]["targets"];
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("finance workflow deadline exceeded")),
        timeoutMs,
      );
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
      const callKey = createHash("sha256").update(toolCallId).digest("hex").slice(0, 16);
      const receiptPath = path.join(
        workspace,
        "state",
        "finance-research-runs",
        `${callKey}-${randomUUID()}.json`,
      );
      try {
        const executeResearch = options?.executeResearch ?? runFinanceResearchRun;
        const workflow =
          params.live === true
            ? createFinanceModelWorkflow(options?.config ?? loadConfig(), {
                slotModels: options?.slotModels,
                maxCalls: maxModelCalls,
                maxTokens: 8_192,
              })
            : undefined;
        const receipt = await executeResearch({
          input: {
            ask,
            asOf,
            ...(targets ? { targets } : {}),
            ...(decisionMode ? { decisionMode } : {}),
            ...(strategyStage ? { strategyStage } : {}),
            ...(moduleSelection ? { moduleSelection } : {}),
            ...(params.executeModules === true ? { executeModules: true } : {}),
          },
          workspaceDir: workspace,
          signal,
          liveFetch: params.live === true,
          allowProviderCalls: params.live === true,
          batchOptions: { maxApiCalls, retry: { attempts: 1 } },
          ...(workflow
            ? { modelRouting: workflow.routing, qualityModelRouting: workflow.routing }
            : {}),
        });
        signal.throwIfAborted();
        await fs.mkdir(path.dirname(receiptPath), { recursive: true });
        await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        return jsonResult({
          status: "status" in receipt ? receipt.status : "unknown",
          // Keep actionable composition feedback ahead of large sections so the
          // central harness's bounded receipt can inform the next proposal.
          composition: {
            selectionSource: receipt.plan.orchestration.selectionTrace.selectionSource,
            primaryModules: receipt.plan.orchestration.primaryModules.slice(0, 4),
            omittedPrimaryModules: Math.max(
              0,
              receipt.plan.orchestration.primaryModules.length - 4,
            ),
            moduleToolsDispatched: receipt.moduleExecution?.moduleToolsDispatched ?? false,
            replanStatus: receipt.moduleExecution?.replanFeedback.status ?? "not_requested",
            nextAction: receipt.moduleExecution?.replanFeedback.nextAction ?? "none",
            hardFailureCount: receipt.moduleExecution?.replanFeedback.hardFailures.length ?? 0,
            softFailureCount: receipt.moduleExecution?.replanFeedback.softFailures.length ?? 0,
            remainingSoftReplans: receipt.moduleExecution?.replanFeedback.remainingSoftReplans ?? 0,
          },
          gates: "gates" in receipt ? receipt.gates : [],
          missingEvidence: "missingEvidence" in receipt ? receipt.missingEvidence : [],
          receiptPath,
          orchestration: receipt.plan.orchestration,
          plannedTargets: receipt.plan.targets,
          moduleCatalog: financeBrainModuleCatalog(),
          sourceRecovery: receipt.sourceRecovery,
          moduleToolsDispatched: receipt.moduleExecution?.moduleToolsDispatched ?? false,
          moduleExecution: receipt.moduleExecution,
          answerDecision: receipt.answerDecision,
          artifact:
            receipt.status === "candidate" && receipt.quality?.status === "verified"
              ? receipt.quality.finalArtifact
              : undefined,
          externalChannelApplied: false,
          modelWeightAbsorbed: false,
        });
      } catch (error) {
        await fs
          .mkdir(path.dirname(receiptPath), { recursive: true })
          .then(() =>
            fs.writeFile(
              receiptPath,
              `${JSON.stringify(
                {
                  boundary: "finance_research_tool_execution_only",
                  status: signal.aborted ? "cancelled" : "failed",
                  reason: controller.signal.aborted
                    ? "total_deadline_exceeded"
                    : callerSignal?.aborted
                      ? "caller_cancelled"
                      : "workflow_failed",
                  callKey,
                  externalChannelApplied: false,
                  modelWeightAbsorbed: false,
                },
                null,
                2,
              )}\n`,
              { mode: 0o600, flag: "wx" },
            ),
          )
          .catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
