import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadAuthProfileStoreForSecretsRuntime,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { buildQualityHarnessModelPromptWithCoverage } from "./local-text-model-adapter.js";
import {
  ModelAdapterError,
  type LogicalAgentModelAdapter,
  type ModelCallObservation,
} from "./logical-agent-model-router.js";
import type { LogicalAgentId } from "./logical-agent-pool.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "./model-auth.js";
import {
  recordModelRequestStart,
  recordModelRequestUpdate,
  type ModelRequestSource,
} from "./model-request-trajectory.js";
import { buildInlineProviderModels } from "./pi-embedded-runner/model.js";
import type { QualityHarnessModelRequest } from "./quality-harness-contract.js";

/** One attempt budget shared by every model and fallback in a workflow. */
export function createFinanceModelCallBudget(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("finance workflow requires 1..100 maximum model calls");
  }
  let reserved = 0;
  return Object.freeze({
    reserve() {
      if (reserved >= limit) {
        throw new ModelAdapterError("call_budget_exhausted");
      }
      reserved++;
    },
    snapshot: () => ({ limit, reserved, remaining: limit - reserved }),
  });
}

/** Read existing static credentials only. Never refresh OAuth or persist an auth store. */
export async function resolveConfiguredFinanceAuth(
  cfg: OpenClawConfig,
  provider: string,
  suppliedStore?: AuthProfileStore,
): Promise<{ apiKey: string; source: "configuration" | "environment" | "auth_profile" }> {
  const inline = getCustomProviderApiKey(cfg, provider);
  if (inline) {
    return { apiKey: inline, source: "configuration" };
  }
  const env = resolveEnvApiKey(provider)?.apiKey;
  if (env) {
    return { apiKey: env, source: "environment" };
  }
  const store = suppliedStore
    ? structuredClone(suppliedStore)
    : loadAuthProfileStoreForSecretsRuntime();
  for (const profileId of resolveAuthProfileOrder({ cfg, store, provider })) {
    const credential = store.profiles[profileId];
    if (credential?.type !== "api_key" && credential?.type !== "token") {
      continue;
    }
    try {
      const resolved = await resolveApiKeyForProfile({ cfg, store, profileId });
      if (resolved?.apiKey) {
        return { apiKey: resolved.apiKey, source: "auth_profile" };
      }
    } catch {
      /* Try another existing static profile, without exposing secret-resolution errors. */
    }
  }
  throw new ModelAdapterError("provider_auth");
}

/** Repair only terminal delimiters after a complete string; never add field values. */
function normalizeTerminalDelimiters(raw: string): unknown {
  const tail = /[\]}\s]+$/u.exec(raw);
  if (!tail || !/[\]}]/u.test(tail[0])) {
    throw new ModelAdapterError("output_invalid");
  }
  const prefix = raw.slice(0, tail.index);
  if (!prefix.trimEnd().endsWith('"')) {
    throw new ModelAdapterError("output_invalid");
  }
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of prefix) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) {
        throw new ModelAdapterError("output_invalid");
      }
    }
  }
  if (inString || stack[0] !== "{") {
    throw new ModelAdapterError("output_invalid");
  }
  return JSON.parse(
    prefix +
      stack
        .toReversed()
        .map((char) => (char === "{" ? "}" : "]"))
        .join(""),
  ) as unknown;
}

/** Explicit opt-in to an already configured model. Never creates provider/auth configuration. */
export function createConfiguredFinanceModelAdapter(
  cfg: OpenClawConfig,
  options: {
    maxTokens?: number;
    maxTokensByRole?: Partial<Record<LogicalAgentId, number>>;
    buildPrompt?: (payload: unknown) => string;
    reasoningEffortByRole?: Partial<Record<LogicalAgentId, "low" | "high" | "max">>;
    timeoutMs?: number;
    maxCalls?: number;
    /** Must resolve to an existing definition; never creates a provider. */
    modelRef?: string;
    callBudget?: ReturnType<typeof createFinanceModelCallBudget>;
    /** Identifies the existing caller without changing provider or model selection. */
    trajectorySource?: Exclude<ModelRequestSource, "agent_session">;
  } = {},
): LogicalAgentModelAdapter {
  const selection = cfg.agents?.defaults?.model;
  const primary =
    options.modelRef ?? (typeof selection === "string" ? selection : selection?.primary);
  const slash = primary?.indexOf("/") ?? -1;
  if (!primary || slash <= 0) {
    throw new Error(
      "configured finance analysis requires an explicit provider/model in agents.defaults.model",
    );
  }
  const provider = primary.slice(0, slash),
    modelId = primary.slice(slash + 1);
  const model = buildInlineProviderModels(cfg.models?.providers ?? {}).find(
    (m) => m.provider === provider && m.id === modelId,
  );
  if (!model || model.api !== "openai-completions" || !model.baseUrl) {
    throw new Error(
      "configured finance analysis requires an existing openai-completions model definition",
    );
  }
  const maxTokens = options.maxTokens ?? 8_192;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxCalls = options.maxCalls ?? 48;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100) {
    throw new Error("configured finance model requires 1..100 maximum calls");
  }
  let calls = 0;
  if (
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 16_384 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new Error("configured finance model requires bounded tokens and timeout");
  }
  if (
    Object.values(options.maxTokensByRole ?? {}).some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 16_384,
    )
  ) {
    throw new Error("configured finance model requires bounded role token limits");
  }
  const supportsReasoningEffort =
    model.compat?.supportsReasoningEffort === true ||
    (new URL(model.baseUrl).hostname === "api.deepseek.com" && modelId.startsWith("deepseek-v4-"));
  const endpoint = `${model.baseUrl.replace(/\/$/u, "")}/chat/completions`;
  const observations = new Map<
    string,
    {
      id: string;
      normalized?: boolean;
      reasoningEffort?: "low" | "high" | "max";
      credentialSource: "configuration" | "environment" | "auth_profile";
      evidenceCoverage?: ModelCallObservation["evidenceCoverage"];
    }
  >();
  return {
    id: `configured-finance-${randomUUID().slice(0, 8)}`,
    provider,
    modelId,
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: ["provider_call"],
    invoke: async (request, signal) => {
      if (calls >= maxCalls) {
        throw new ModelAdapterError("call_budget_exhausted");
      }
      const reasoningEffort = supportsReasoningEffort
        ? options.reasoningEffortByRole?.[request.role]
        : undefined;
      let promptText: string;
      let evidenceCoverage: ModelCallObservation["evidenceCoverage"];
      try {
        if (options.buildPrompt) {
          promptText = options.buildPrompt(request.payload);
        } else {
          const built = buildQualityHarnessModelPromptWithCoverage(
            request.payload as QualityHarnessModelRequest,
          );
          promptText = built.prompt;
          evidenceCoverage = built.evidenceCoverage;
        }
      } catch (error) {
        // Request assembly is local: preserve a safe category without charging a
        // provider call or replaying the unchanged invalid packet on another model.
        throw new ModelAdapterError(
          error instanceof Error && /prompt budget/u.test(error.message)
            ? "prompt_budget_exceeded"
            : "prompt_input_invalid",
        );
      }
      const auth = await resolveConfiguredFinanceAuth(cfg, provider);
      // Auth resolution may yield; recheck before the synchronous reservation.
      if (calls >= maxCalls) {
        throw new ModelAdapterError("call_budget_exhausted");
      }
      if (signal.aborted) {
        throw new ModelAdapterError("process_error");
      }
      options.callBudget?.reserve();
      calls += 1;
      const trajectoryTicket = recordModelRequestStart({
        source: options.trajectorySource ?? "finance_engine",
        provider,
        modelId,
        modelApi: model.api,
        inputBytes: Buffer.byteLength(promptText, "utf8"),
        messageCount: 1,
      });
      const requestMaxTokens = options.maxTokensByRole?.[request.role] ?? maxTokens;
      let response: {
        id?: string;
        choices?: { finish_reason?: string; message?: { content?: string } }[];
      };
      let receivedHttpResponse = false;
      try {
        const http = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          headers: {
            "Content-Type": "application/json",
            ...cfg.models?.providers?.[provider]?.headers,
            Authorization: `Bearer ${auth.apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: promptText }],
            max_tokens: requestMaxTokens,
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            response_format: { type: "json_object" },
            stream: false,
          }),
        });
        receivedHttpResponse = true;
        recordModelRequestUpdate(trajectoryTicket, {
          stage: "response_received",
          httpStatus: http.status,
        });
        if (!http.ok) {
          await http.body?.cancel();
          throw new ModelAdapterError(
            [401, 403].includes(http.status)
              ? "provider_auth"
              : http.status === 402
                ? "provider_payment_required"
                : http.status === 429
                  ? "provider_rate_limit"
                  : "process_error",
          );
        }
        response = (await http.json()) as typeof response;
      } catch (error) {
        if (!receivedHttpResponse) {
          recordModelRequestUpdate(trajectoryTicket, {
            stage: "request_error",
            errorKind: "transport",
          });
        }
        throw error instanceof ModelAdapterError ? error : new ModelAdapterError("process_error");
      }
      if (response.id) {
        observations.set(request.callId, {
          id: response.id,
          credentialSource: auth.source,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(evidenceCoverage ? { evidenceCoverage } : {}),
        });
      }
      const choice = response.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new ModelAdapterError("output_truncated");
      }
      if (!choice || !choice.message?.content) {
        throw new ModelAdapterError("output_invalid");
      }
      try {
        return JSON.parse(choice.message.content) as unknown;
      } catch {
        if (choice.finish_reason !== "stop") {
          throw new ModelAdapterError("output_invalid");
        }
        try {
          const value = normalizeTerminalDelimiters(choice.message.content);
          if (response.id) {
            observations.set(request.callId, {
              id: response.id,
              normalized: true,
              credentialSource: auth.source,
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(evidenceCoverage ? { evidenceCoverage } : {}),
            });
          }
          return value;
        } catch {
          throw new ModelAdapterError("output_invalid");
        }
      }
    },
    observe: (request): ModelCallObservation | undefined => {
      const observation = observations.get(request.callId);
      if (!observation) {
        return undefined;
      }
      observations.delete(request.callId);
      return {
        callId: request.callId,
        provider,
        modelId,
        transportRequestId: observation.id,
        kind: "provider_call",
        credentialSource: observation.credentialSource,
        ...(observation.reasoningEffort ? { reasoningEffort: observation.reasoningEffort } : {}),
        ...(observation.evidenceCoverage ? { evidenceCoverage: observation.evidenceCoverage } : {}),
        ...(observation.normalized ? { outputNormalization: "terminal_delimiters" as const } : {}),
      };
    },
  };
}
