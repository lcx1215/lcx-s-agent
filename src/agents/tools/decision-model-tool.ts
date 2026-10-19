import { Type } from "@sinclair/typebox";
import {
  CLEF_POLICY,
  evaluateClef,
  parseClefRequest,
  resolveClefConfig,
} from "../clef-decision-model.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "./common.js";

const Instructions = Type.String({ minLength: 1, maxLength: 1024 });
const Question = Type.Union([
  Type.Object(
    { type: Type.Literal("noul"), instructions: Instructions },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("choice"),
      instructions: Instructions,
      criteria: Type.Record(
        Type.String({ minLength: 1, maxLength: 100 }),
        Type.String({ minLength: 1, maxLength: 512 }),
        { minProperties: 2, maxProperties: CLEF_POLICY.maxOptions },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("score"),
      instructions: Instructions,
      criteria: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        minItems: 2,
        maxItems: CLEF_POLICY.maxOptions,
      }),
    },
    { additionalProperties: false },
  ),
]);

/** Optional classifier. Its output returns to the existing supervising agent and gates. */
export function createDecisionModelTool(options?: {
  sandboxed?: boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool {
  let calls = 0;
  return {
    name: "decision_model_evaluate",
    label: "Structured Decision Model",
    description:
      "Inspect or call the host-configured Clef decision model when semantic source classification, ambiguous tool/research routing among declared choices, or escalation assessment benefits from an auxiliary classifier. If the next tool is already clear, use it directly. Supply a bounded state and explicit noul (yes/no), choice, or score questions. Returns per-option probabilities to the supervising agent; confidence is not a calibrated trading win rate. Use deterministic code or quant_math for arithmetic and numeric comparisons, including quote freshness and stop/risk thresholds; model classifications cannot replace these checks. Suggestions cannot grant permissions, discard evidence, approve trades, or replace deterministic gates. Do not send credentials, private account identifiers, or protected memory. At most 8 calls per tool instance, 15 seconds each, no retries; unavailable/invalid output falls back to the agent. Endpoint, model and credentials are host-only. Not available for inference in a sandbox.",
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("inspect"), Type.Literal("evaluate")]),
        state: Type.Optional(
          Type.Union([
            Type.String({ minLength: 1 }),
            Type.Record(Type.String(), Type.Unknown()),
            Type.Array(Type.Unknown()),
          ]),
        ),
        questions: Type.Optional(
          Type.Record(Type.String({ pattern: "^[\\w.-]{1,100}$" }), Question, {
            minProperties: 1,
            maxProperties: CLEF_POLICY.maxQuestions,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_callId, args, signal) => {
      const params = args as Record<string, unknown>;
      if (
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        Object.keys(params).some((key) => !["action", "state", "questions"].includes(key)) ||
        !["inspect", "evaluate"].includes(String(params.action))
      ) {
        throw new ToolInputError("decision model accepts only action, state and questions");
      }
      const config = resolveClefConfig(options?.env ?? process.env);
      const boundary = ["advisory_only", "no_execution_authority", "existing_gates_required"];
      if (params.action === "inspect") {
        if (params.state !== undefined || params.questions !== undefined) {
          throw new ToolInputError("inspect does not accept state or questions");
        }
        return jsonResult({
          status: options?.sandboxed
            ? "unavailable"
            : config.ready
              ? "configured_not_verified"
              : "unavailable",
          ...(options?.sandboxed
            ? { reason: "sandbox_blocked" }
            : !config.ready
              ? { reason: config.reason }
              : {}),
          ...(config.ready ? { provider: "cloudflare-workers-ai", model: config.model } : {}),
          callsRemaining: Math.max(0, CLEF_POLICY.maxCalls - calls),
          policy: CLEF_POLICY,
          providerCallObserved: false,
          boundary,
        });
      }
      let request;
      try {
        request = parseClefRequest({ state: params.state, questions: params.questions });
      } catch (error) {
        throw new ToolInputError(
          error instanceof Error && error.message === "request_budget_exceeded"
            ? "request_budget_exceeded"
            : "invalid_request",
        );
      }
      const reason = options?.sandboxed
        ? "sandbox_blocked"
        : !config.ready
          ? config.reason
          : calls >= CLEF_POLICY.maxCalls
            ? "call_budget_exhausted"
            : undefined;
      if (reason || !config.ready) {
        return jsonResult({
          status: "fallback_to_agent",
          reason,
          boundary,
          providerCallObserved: false,
        });
      }
      if (signal?.aborted) {
        return jsonResult({
          status: "cancelled",
          reason: "caller_cancelled",
          boundary,
          providerCallObserved: false,
        });
      }
      calls++;
      const result = await evaluateClef(request, config, signal);
      return jsonResult({ ...result, boundary });
    },
  };
}
