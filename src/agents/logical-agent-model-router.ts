import { createHash, randomUUID } from "node:crypto";
import type {
  LogicalAgentCapabilities,
  LogicalAgentId,
  LogicalAgentSideEffect,
} from "./logical-agent-pool.js";

export type ModelExecutionMode = "deterministic" | "injected" | "adapter";
export type ModelCallOutcome = "completed" | "failed" | "rejected" | "timed_out" | "aborted";
export type ModelCallRequest = Readonly<{
  callId: string;
  correlationId: string;
  taskId: string;
  role: LogicalAgentId;
  attempt: number;
  provider: string;
  modelId: string;
  payload: unknown;
}>;

/** Observation is obtained by the adapter's transport observer, never from model output. */
export type ModelCallObservation = Readonly<{
  callId: string;
  provider: string;
  modelId: string;
  transportRequestId: string;
  kind: "model_inference" | "provider_call";
}>;

export type LogicalAgentModelAdapter = Readonly<{
  id: string;
  provider: string;
  modelId: string;
  mode: ModelExecutionMode;
  capabilities: readonly string[];
  requiredTools: readonly string[];
  requiredSideEffects: readonly LogicalAgentSideEffect[];
  invoke: (request: ModelCallRequest, signal: AbortSignal) => Promise<unknown>;
  /** Trusted integration boundary: check an independent transport record for this call.
   * A test stub here proves contract handling only, not actual inference.
   * This synchronous observer must not do network I/O or inspect generated text.
   */
  observe?: (request: Omit<ModelCallRequest, "payload">) => ModelCallObservation | undefined;
}>;

export type LogicalAgentRoleModelPolicy = Readonly<{
  primary: string;
  fallback?: readonly string[];
  requiredCapabilities: readonly string[];
  maxInputBytes: number;
  timeoutMs: number;
}>;

export type LogicalAgentModelRouting = Readonly<{
  /** Change this revision whenever adapter implementation or input validation changes. */
  revision: string;
  adapters: readonly LogicalAgentModelAdapter[];
  defaultPolicy: LogicalAgentRoleModelPolicy;
  roles?: Partial<Readonly<Record<LogicalAgentId, LogicalAgentRoleModelPolicy>>>;
}>;

export type ModelCallReceipt = Readonly<{
  schemaVersion: "lcx_model_call_v1";
  callId: string;
  correlationId: string;
  taskId: string;
  role: LogicalAgentId;
  policyRevision: string;
  adapterId: string;
  provider: string;
  modelId: string;
  attempt: number;
  mode: ModelExecutionMode;
  startedAtMs: number;
  latencyMs: number;
  outcome: ModelCallOutcome;
  adapterInvoked: boolean;
  realModelInferenceObserved: boolean;
  providerCallObserved: boolean;
  evidence: "not-observed" | "adapter-attested";
  observationIdSha256?: string;
  /** Fixed codes only: never persist prompts, outputs, exception text or credentials. */
  reason?:
    | "input_constraint"
    | "capability_constraint"
    | "adapter_error"
    | "cancelled"
    | "deadline";
}>;

type Dispatch = (invoke: () => Promise<unknown>, signal: AbortSignal) => Promise<unknown>;

export class LogicalAgentModelRouter {
  readonly routing: LogicalAgentModelRouting;
  #adapters = new Map<string, LogicalAgentModelAdapter>();

  constructor(routing: LogicalAgentModelRouting) {
    if (!routing.revision.trim()) {
      throw new Error("model routing requires a revision");
    }
    for (const adapter of routing.adapters) {
      if (
        !adapter.id.trim() ||
        !adapter.provider.trim() ||
        !adapter.modelId.trim() ||
        this.#adapters.has(adapter.id)
      ) {
        throw new Error("model routing requires unique adapters with provider/model identity");
      }
      this.#adapters.set(
        adapter.id,
        Object.freeze({
          ...adapter,
          capabilities: Object.freeze([...adapter.capabilities]),
          requiredTools: Object.freeze([...adapter.requiredTools]),
          requiredSideEffects: Object.freeze([...adapter.requiredSideEffects]),
        }),
      );
    }
    const snapshotPolicy = (policy: LogicalAgentRoleModelPolicy): LogicalAgentRoleModelPolicy => {
      if (
        !Number.isSafeInteger(policy.maxInputBytes) ||
        policy.maxInputBytes <= 0 ||
        !Number.isFinite(policy.timeoutMs) ||
        policy.timeoutMs <= 0 ||
        policy.timeoutMs > 2_147_483_647
      ) {
        throw new Error("model policy requires bounded input bytes and timeout");
      }
      const targets = [policy.primary, ...(policy.fallback ?? [])];
      if (
        new Set(targets).size !== targets.length ||
        targets.some((id) => !this.#adapters.has(id))
      ) {
        throw new Error("model policy targets must be unique registered adapters");
      }
      return Object.freeze({
        ...policy,
        fallback: Object.freeze([...(policy.fallback ?? [])]),
        requiredCapabilities: Object.freeze([...policy.requiredCapabilities]),
      });
    };
    this.routing = Object.freeze({
      revision: routing.revision,
      adapters: Object.freeze([...this.#adapters.values()]),
      defaultPolicy: snapshotPolicy(routing.defaultPolicy),
      roles: Object.freeze(
        Object.fromEntries(
          Object.entries(routing.roles ?? {}).map(([role, policy]) => [
            role,
            snapshotPolicy(policy),
          ]),
        ),
      ),
    });
  }

  primaryModelId(role: LogicalAgentId): string {
    return this.#adapters.get(this.#policy(role).primary)!.modelId;
  }

  #policy(role: LogicalAgentId): LogicalAgentRoleModelPolicy {
    return this.routing.roles?.[role] ?? this.routing.defaultPolicy;
  }

  async invoke(params: {
    role: LogicalAgentId;
    taskId: string;
    correlationId: string;
    payload: unknown;
    capabilities: LogicalAgentCapabilities;
    signal: AbortSignal;
    dispatch: Dispatch;
    record: (receipt: ModelCallReceipt) => void;
  }): Promise<unknown> {
    const policy = this.#policy(params.role);
    const targets = [policy.primary, ...(policy.fallback ?? [])];
    // Freeze the input snapshot across retries; each adapter receives its own JSON copy.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(params.payload);
    } catch {
      /* Rejected below with a fixed code. */
    }
    for (const [index, id] of targets.entries()) {
      const adapter = this.#adapters.get(id)!;
      const startedAtMs = Date.now();
      const identity = Object.freeze({
        callId: randomUUID(),
        correlationId: params.correlationId,
        taskId: params.taskId,
        role: params.role,
        attempt: index + 1,
        provider: adapter.provider,
        modelId: adapter.modelId,
      });
      let outcome: ModelCallOutcome = "failed";
      let reason: ModelCallReceipt["reason"];
      let adapterInvoked = false;
      let observation: ModelCallObservation | undefined;
      const controller = new AbortController();
      const abort = () => controller.abort();
      params.signal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (params.signal.aborted) {
          outcome = "aborted";
          reason = "cancelled";
          throw new Error("model call cancelled");
        }
        const allowed =
          policy.requiredCapabilities.every((cap) => adapter.capabilities.includes(cap)) &&
          adapter.requiredTools.every((tool) => params.capabilities.allowedTools.includes(tool)) &&
          adapter.requiredSideEffects.every(
            (effect) =>
              params.capabilities.allowedSideEffects.includes(effect) &&
              !params.capabilities.forbiddenSideEffects.includes(effect),
          );
        if (!allowed) {
          outcome = "rejected";
          reason = "capability_constraint";
          throw new Error("model capability constraint rejected");
        }
        let payload: unknown;
        try {
          if (
            serialized === undefined ||
            Buffer.byteLength(serialized, "utf8") > policy.maxInputBytes
          ) {
            throw new Error("invalid input");
          }
          payload = JSON.parse(serialized);
        } catch {
          outcome = "rejected";
          reason = "input_constraint";
          throw new Error("model input constraint rejected");
        }
        const cancelled = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              outcome = reason === "deadline" ? "timed_out" : "aborted";
              reason ??= "cancelled";
              reject(new Error("model call cancelled or timed out"));
            },
            { once: true },
          );
        });
        timer = setTimeout(() => {
          reason = "deadline";
          controller.abort();
        }, policy.timeoutMs);
        const result = await Promise.race([
          params.dispatch(async () => {
            adapterInvoked = true;
            return adapter.invoke(Object.freeze({ ...identity, payload }), controller.signal);
          }, controller.signal),
          cancelled,
        ]);
        outcome = "completed";
        return result;
      } catch {
        reason ??= "adapter_error";
        // Cancellation never launches a fallback; failed/rejected/timed-out targets may do so.
        if (
          outcome === "aborted" ||
          params.signal.aborted ||
          index === targets.length - 1 ||
          reason === "input_constraint"
        ) {
          throw new Error(`model routing ${outcome}: ${reason}`);
        }
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        params.signal.removeEventListener("abort", abort);
        if (adapterInvoked && adapter.mode === "adapter") {
          try {
            const candidate = adapter.observe?.(identity);
            if (
              candidate !== undefined &&
              candidate.callId === identity.callId &&
              candidate.provider === adapter.provider &&
              candidate.modelId === adapter.modelId &&
              typeof candidate.transportRequestId === "string" &&
              candidate.transportRequestId.trim() &&
              (candidate.kind === "model_inference" ||
                (candidate.kind === "provider_call" &&
                  adapter.requiredSideEffects.includes("provider_call")))
            ) {
              observation = candidate;
            }
          } catch {
            /* Observation failure cannot promote execution evidence. */
          }
        }
        params.record(
          Object.freeze({
            schemaVersion: "lcx_model_call_v1",
            ...identity,
            policyRevision: this.routing.revision,
            adapterId: adapter.id,
            mode: adapter.mode,
            startedAtMs,
            latencyMs: Math.max(0, Date.now() - startedAtMs),
            outcome,
            adapterInvoked,
            realModelInferenceObserved: observation !== undefined,
            providerCallObserved: observation?.kind === "provider_call",
            evidence: observation ? "adapter-attested" : "not-observed",
            ...(observation
              ? {
                  observationIdSha256: createHash("sha256")
                    .update(observation.transportRequestId)
                    .digest("hex"),
                }
              : {}),
            ...(reason ? { reason } : {}),
          }),
        );
      }
    }
    throw new Error("model routing exhausted");
  }
}
