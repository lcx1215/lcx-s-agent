import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  loadAuthProfileStoreForSecretsRuntime,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { FinanceHttpBodyAbortError, readBoundedFinanceResponseText } from "./finance-http-body.js";
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
  normalizeModelRequestUsage,
  type ModelRequestSource,
} from "./model-request-trajectory.js";
import { buildInlineProviderModels } from "./pi-embedded-runner/model.js";
import {
  FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES,
  type QualityHarnessModelRequest,
} from "./quality-harness-contract.js";

export const FINANCE_PROVIDER_PAYMENT_COOLDOWN_MS = 15 * 60_000;
const paymentCooldowns = new Map<string, number>();

/** Account-scoped operational facts, separate from credentials and auth configuration. */
function paymentCooldownKey(provider: string, endpoint: string, apiKey: string): string {
  return createHash("sha256")
    .update(JSON.stringify([provider, endpoint, apiKey]))
    .digest("hex");
}

function readPaymentCooldown(key: string, directory: string | undefined): number {
  let until = paymentCooldowns.get(key) ?? 0;
  if (directory) {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(path.join(directory, `${key}.json`), "utf8"),
      );
      if (
        typeof value !== "object" ||
        value === null ||
        !("schema" in value) ||
        value.schema !== "finance_provider_payment_cooldown_v1" ||
        !("until" in value) ||
        typeof value.until !== "number" ||
        !Number.isSafeInteger(value.until)
      ) {
        throw new ModelAdapterError("process_error");
      }
      until = Math.max(until, value.until);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ModelAdapterError("process_error");
      }
    }
  }
  return until;
}

function markPaymentCooldown(key: string, directory: string | undefined): void {
  const until = Date.now() + FINANCE_PROVIDER_PAYMENT_COOLDOWN_MS;
  paymentCooldowns.set(key, until);
  if (!directory) {
    return;
  }
  const filename = path.join(directory, `${key}.json`);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ schema: "finance_provider_payment_cooldown_v1", until }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, filename);
  } catch {
    // Keep the original payment failure and in-process block if persistence fails.
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Temporary-file cleanup must not hide a classified payment failure.
    }
  }
}

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
  agentDir?: string,
  signal?: AbortSignal,
  deadlineAtMs?: number,
): Promise<{ apiKey: string; source: "configuration" | "environment" | "auth_profile" }> {
  const assertActive = () => {
    signal?.throwIfAborted();
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
      throw new ModelAdapterError("runtime_timeout");
    }
  };
  assertActive();
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
    : loadAuthProfileStoreForSecretsRuntime(agentDir);
  for (const profileId of resolveAuthProfileOrder({ cfg, store, provider })) {
    assertActive();
    const credential = store.profiles[profileId];
    if (credential?.type !== "api_key" && credential?.type !== "token") {
      continue;
    }
    try {
      const resolved = await resolveApiKeyForProfile({ cfg, store, profileId, agentDir });
      assertActive();
      if (resolved?.apiKey) {
        return { apiKey: resolved.apiKey, source: "auth_profile" };
      }
    } catch {
      assertActive();
      /* Try another existing static profile, without exposing secret-resolution errors. */
    }
  }
  throw new ModelAdapterError("provider_auth");
}

/** Bound secret lookup without allowing a late credential to dispatch a request. */
async function resolveFinanceAuthBeforeDeadline(
  cfg: OpenClawConfig,
  provider: string,
  agentDir: string | undefined,
  signal: AbortSignal,
  deadlineAtMs: number,
) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(new ModelAdapterError("process_error"));
  const expire = () => controller.abort(new ModelAdapterError("runtime_timeout"));
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  signal.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(expire, Math.max(0, deadlineAtMs - Date.now()));
  if (signal.aborted) {
    relayAbort();
  } else if (Date.now() >= deadlineAtMs) {
    expire();
  }
  try {
    return await Promise.race([
      aborted,
      resolveConfiguredFinanceAuth(
        cfg,
        provider,
        undefined,
        agentDir,
        controller.signal,
        deadlineAtMs,
      ),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", relayAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
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

export const ConfiguredFinanceCallStateSchema = z
  .object({
    requestIdSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    stage: z.enum(["request_started", "response_received", "body_complete", "cancelled", "failed"]),
    cleanupStatus: z.enum(["not_required", "confirmed", "unconfirmed"]),
    httpStatus: z.number().int().min(100).max(599).optional(),
    requestDispatched: z.boolean().optional(),
    paymentRefusalSource: z.enum(["provider_http", "local_cooldown"]).optional(),
    cooldownUntil: z.string().datetime().optional(),
  })
  .strict();
export type ConfiguredFinanceCallState = Readonly<z.infer<typeof ConfiguredFinanceCallStateSchema>>;

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
    /** Isolated operational state for tests; production shares the existing state root. */
    availabilityStateDirectory?: string;
  } = {},
): LogicalAgentModelAdapter & { inspectCall?: () => ConfiguredFinanceCallState | undefined } {
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
  // Read the raw declaration: inline model normalization inserts a fallback capacity.
  const declaredMaxTokens = cfg.models?.providers?.[provider]?.models.find(
    (candidate) => candidate.id === modelId,
  )?.maxTokens;
  const maxTokens = options.maxTokens ?? declaredMaxTokens;
  let callState: ConfiguredFinanceCallState | undefined;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxCalls = options.maxCalls ?? 48;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100) {
    throw new Error("configured finance model requires 1..100 maximum calls");
  }
  let calls = 0;
  if (
    (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new Error(
      "configured finance model requires positive safe-integer tokens and bounded timeout",
    );
  }
  if (
    Object.values(options.maxTokensByRole ?? {}).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  ) {
    throw new Error("configured finance model requires positive safe-integer role token limits");
  }
  const supportsReasoningEffort =
    model.compat?.supportsReasoningEffort === true ||
    (new URL(model.baseUrl).hostname === "api.deepseek.com" && modelId.startsWith("deepseek-v4-"));
  const endpoint = `${model.baseUrl.replace(/\/$/u, "")}/chat/completions`;
  const availabilityDirectory =
    options.availabilityStateDirectory ??
    (process.env.NODE_ENV === "test"
      ? undefined
      : path.join(resolveStateDir(), "model-provider-cooldowns"));
  let accountKey: string | undefined;
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
    unavailableReason: () =>
      accountKey && readPaymentCooldown(accountKey, availabilityDirectory) > Date.now()
        ? "provider_payment_required"
        : undefined,
    inspectCall: () => callState,
    invoke: async (request, signal) => {
      callState = undefined;
      const deadlineAtMs = Math.min(Date.now() + timeoutMs, request.deadlineAtMs ?? Infinity);
      const assertActive = () => {
        if (signal.aborted) {
          throw new ModelAdapterError("process_error");
        }
        if (Date.now() >= deadlineAtMs) {
          throw new ModelAdapterError("runtime_timeout");
        }
      };
      assertActive();
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
            { maxPromptBytes: FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES },
          );
          promptText = built.prompt;
          evidenceCoverage = built.evidenceCoverage;
        }
        if (Buffer.byteLength(promptText, "utf8") > FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES) {
          throw new Error("rendered finance input exceeds prompt budget");
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
      const auth = await resolveFinanceAuthBeforeDeadline(
        cfg,
        provider,
        undefined,
        signal,
        deadlineAtMs,
      );
      assertActive();
      accountKey = paymentCooldownKey(provider, endpoint, auth.apiKey);
      const cooldownUntil = readPaymentCooldown(accountKey, availabilityDirectory);
      if (cooldownUntil > Date.now()) {
        callState = {
          requestIdSha256: createHash("sha256").update(request.callId).digest("hex"),
          stage: "failed",
          cleanupStatus: "not_required",
          requestDispatched: false,
          paymentRefusalSource: "local_cooldown",
          cooldownUntil: new Date(cooldownUntil).toISOString(),
        };
        throw new ModelAdapterError("provider_payment_required");
      }
      // Auth resolution may yield; recheck before the synchronous reservation.
      if (calls >= maxCalls) {
        throw new ModelAdapterError("call_budget_exhausted");
      }
      assertActive();
      options.callBudget?.reserve();
      assertActive();
      calls += 1;
      const trajectoryTicket = recordModelRequestStart({
        source: options.trajectorySource ?? "finance_engine",
        provider,
        modelId,
        modelApi: model.api,
        callId: request.callId,
        correlationId: request.correlationId,
        taskId: request.taskId,
        role: request.role,
        attempt: request.attempt,
        inputBytes: Buffer.byteLength(promptText, "utf8"),
        messageCount: 1,
      });
      const requestMaxTokens = options.maxTokensByRole?.[request.role] ?? maxTokens;
      let response: {
        id?: string;
        usage?: unknown;
        choices?: { finish_reason?: string; message?: { content?: string } }[];
      };
      let receivedHttpResponse = false;
      callState = {
        requestIdSha256: createHash("sha256").update(request.callId).digest("hex"),
        stage: "request_started",
        requestDispatched: false,
        cleanupStatus: "not_required",
      };
      const requestController = new AbortController();
      const relayAbort = () => requestController.abort(signal.reason);
      signal.addEventListener("abort", relayAbort, { once: true });
      let abortRecorded = false;
      const observeAbort = () => {
        callState = { ...callState!, stage: "cancelled", cleanupStatus: "unconfirmed" };
        if (!abortRecorded) {
          recordModelRequestUpdate(trajectoryTicket, { stage: "request_aborted" });
          abortRecorded = true;
        }
      };
      requestController.signal.addEventListener("abort", observeAbort, { once: true });
      let deadlineExpired = false;
      const timer = setTimeout(
        () => {
          if (!requestController.signal.aborted) {
            deadlineExpired = true;
            requestController.abort(new Error("model request timeout"));
          }
        },
        Math.max(0, deadlineAtMs - Date.now()),
      );
      if (signal.aborted) {
        relayAbort();
      }
      try {
        const init: RequestInit = {
          method: "POST",
          redirect: "error",
          signal: requestController.signal,
          headers: {
            "Content-Type": "application/json",
            ...cfg.models?.providers?.[provider]?.headers,
            Authorization: `Bearer ${auth.apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: promptText }],
            ...(requestMaxTokens !== undefined ? { max_tokens: requestMaxTokens } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            response_format: { type: "json_object" },
            stream: false,
          }),
        };
        assertActive();
        callState = { ...callState, requestDispatched: true };
        const http = await fetch(endpoint, init);
        receivedHttpResponse = true;
        callState = { ...callState, stage: "response_received", httpStatus: http.status };
        recordModelRequestUpdate(trajectoryTicket, {
          stage: "response_received",
          httpStatus: http.status,
        });
        if (!http.ok) {
          if (http.status === 402) {
            markPaymentCooldown(accountKey, availabilityDirectory);
            callState = {
              ...callState,
              paymentRefusalSource: "provider_http",
              cooldownUntil: new Date(
                readPaymentCooldown(accountKey, availabilityDirectory),
              ).toISOString(),
            };
          }
          await readBoundedFinanceResponseText(http, {
            signal: requestController.signal,
            discardBody: true,
          });
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
        const body = await readBoundedFinanceResponseText(http, {
          signal: requestController.signal,
          label: "finance model",
        });
        requestController.signal.throwIfAborted();
        assertActive();
        response = JSON.parse(body) as typeof response;
        callState = { ...callState, stage: "body_complete" };
        const usage = normalizeModelRequestUsage(response.usage);
        if (usage) {
          recordModelRequestUpdate(trajectoryTicket, { stage: "usage_received", ...usage });
        }
        assertActive();
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
        let value: unknown;
        let normalized = false;
        try {
          value = JSON.parse(choice.message.content) as unknown;
        } catch {
          assertActive();
          if (choice.finish_reason !== "stop") {
            throw new ModelAdapterError("output_invalid");
          }
          try {
            value = normalizeTerminalDelimiters(choice.message.content);
            normalized = true;
          } catch {
            assertActive();
            throw new ModelAdapterError("output_invalid");
          }
        }
        assertActive();
        if (normalized && response.id) {
          observations.set(request.callId, {
            id: response.id,
            normalized: true,
            credentialSource: auth.source,
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(evidenceCoverage ? { evidenceCoverage } : {}),
          });
        }
        return value;
      } catch (error) {
        if (requestController.signal.aborted) {
          callState = {
            ...callState,
            stage: "cancelled",
            cleanupStatus:
              error instanceof FinanceHttpBodyAbortError
                ? error.cleanupStatus
                : !receivedHttpResponse
                  ? "confirmed"
                  : "unconfirmed",
          };
          if (!abortRecorded) {
            recordModelRequestUpdate(trajectoryTicket, { stage: "request_aborted" });
            abortRecorded = true;
          }
        } else {
          callState = { ...callState, stage: "failed" };
        }
        if (!receivedHttpResponse && !requestController.signal.aborted) {
          recordModelRequestUpdate(trajectoryTicket, {
            stage: "request_error",
            errorKind: "transport",
          });
        }
        if (deadlineExpired) {
          throw new ModelAdapterError("runtime_timeout");
        }
        throw error instanceof ModelAdapterError ? error : new ModelAdapterError("process_error");
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", relayAbort);
        requestController.signal.removeEventListener("abort", observeAbort);
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
