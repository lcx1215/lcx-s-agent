import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { FINANCE_DECISION_MODES, type FinanceDecisionMode } from "../finance-decision-policy.js";
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
  live: Type.Optional(Type.Boolean({ default: false })),
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
      "Plan or explicitly execute the canonical finance research workflow with configured models, independent review and finding closure. Works through any channel's normal agent tool dispatch. Planning is the default; live=true permits bounded source/model calls. decisionMode selects the answer authority (research_only by default; the candidate modes may produce a reviewable strategy or conditional buy/sell candidate) and never grants broker, wallet, or execution authority. Returns a local receipt, never sends a platform message or claims model learning or external delivery.",
    parameters: schema,
    execute: async (toolCallId, args, callerSignal) => {
      callerSignal?.throwIfAborted();
      const params = args as Record<string, unknown>;
      const ask = readStringParam(params, "ask", { required: true });
      const asOf = readStringParam(params, "asOf", { required: true });
      if (ask.length > 12_000 || !Number.isFinite(Date.parse(asOf))) {
        throw new ToolInputError("ask must be bounded and asOf must be a valid timestamp");
      }
      if (params.live !== undefined && typeof params.live !== "boolean") {
        throw new ToolInputError("live must be a boolean");
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
          },
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
          gates: "gates" in receipt ? receipt.gates : [],
          missingEvidence: "missingEvidence" in receipt ? receipt.missingEvidence : [],
          receiptPath,
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
