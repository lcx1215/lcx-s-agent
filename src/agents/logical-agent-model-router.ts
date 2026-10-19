import { createHash, randomUUID } from "node:crypto";
import type {
  LogicalAgentCapabilities,
  LogicalAgentId,
  LogicalAgentSideEffect,
} from "./logical-agent-pool.js";

/**
 * Explicit "any tool" grant token. A capability set that lists it is unrestricted on the
 * tool axis, so registering a new tool does not require enumerating it in every caller.
 * It is declared here, next to the gate that reads it, so the pool -> router import edge
 * stays one-way. A narrower set that omits it still gates exactly as before.
 */
export const LOGICAL_AGENT_ANY_TOOL = "*" as const;

export type ModelExecutionMode = "deterministic" | "injected" | "adapter";
export type ModelCallOutcome = "completed" | "failed" | "rejected" | "timed_out" | "aborted";
export class ModelAdapterError extends Error {
  constructor(
    readonly code:
      | "prompt_input_invalid"
      | "prompt_budget_exceeded"
      | "output_invalid"
      | "output_truncated"
      | "process_error"
      | "output_limit"
      | "runtime_timeout"
      | "provider_auth"
      | "provider_payment_required"
      | "provider_rate_limit"
      | "call_budget_exhausted",
  ) {
    super(`model adapter ${code}`);
    this.name = "ModelAdapterError";
  }
}
export type ModelCallRequest = Readonly<{
  callId: string;
  correlationId: string;
  taskId: string;
  role: LogicalAgentId;
  attempt: number;
  provider: string;
  modelId: string;
  payload: unknown;
  /** Host-owned wall deadline, never a value supplied by model output. */
  deadlineAtMs?: number;
}>;

/** Observation is obtained by the adapter's transport observer, never from model output. */
export type ModelCallObservation = Readonly<{
  callId: string;
  provider: string;
  modelId: string;
  transportRequestId: string;
  kind: "model_inference" | "provider_call";
  outputNormalization?: "terminal_delimiters" | "json_extraction";
  credentialSource?: "configuration" | "environment" | "auth_profile";
  reasoningEffort?: "low" | "high" | "max";
  /** Adapter-authored evidence coverage for the exact request boundary. */
  evidenceCoverage?: ModelEvidenceCoverage;
}>;

export type ModelEvidenceCoverage = Readonly<{
  boundary: "canonical_prompt";
  suppliedEvidenceIds: readonly string[];
  includedEvidenceIds: readonly string[];
  omittedEvidenceIds: readonly string[];
  clippedEvidenceIds: readonly string[];
  promptSha256?: string;
}>;

export type LogicalAgentModelAdapter = Readonly<{
  id: string;
  provider: string;
  modelId: string;
  mode: ModelExecutionMode;
  capabilities: readonly string[];
  requiredTools: readonly string[];
  requiredSideEffects: readonly LogicalAgentSideEffect[];
  /** Explicitly bounded specialists cannot become general fallbacks. */
  roleScope?: readonly LogicalAgentId[];
  /** Read-only preflight; a rejected adapter is not dispatched or charged a model call. */
  unavailableReason?: () =>
    | "provider_rate_limit"
    | "provider_auth"
    | "provider_payment_required"
    | undefined;
  maxInputBytes?: number;
  qualificationId?: string;
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
  /** One same-adapter structural repair, using the existing dispatch and call budget.
   * The adapter owns diagnostic feedback; semantic review failures are not retried here.
   */
  retryOutputContractOnce?: boolean;
  /** Retry one truncated evidence or independent final review with the same adapter. */
  retryTruncatedOutputOnce?: boolean;
  /** Retry one truncated affinity-bound artifact once with its original author. */
  retryAffinityTruncationOnce?: boolean;
  workload?: string;
  /** Require observed prior-role execution and exclude every model it used successfully. */
  excludeModelsUsedBy?: readonly LogicalAgentId[];
  /** Keep all artifact edits with the one proven author, preserving another reviewer. */
  sameModelAsRole?: LogicalAgentId;
  outputContract?: Readonly<{
    /** Included in checkpoint identity; change when validation semantics change. */
    revision: string;
    validate: (output: unknown, input: unknown) => boolean;
    /** Bounded diagnostic only; cannot approve an output or launch another call. */
    describeFailure?: (output: unknown, input: unknown) => string;
  }>;
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
  outputNormalization?: "terminal_delimiters" | "json_extraction";
  credentialSource?: "configuration" | "environment" | "auth_profile";
  reasoningEffort?: "low" | "high" | "max";
  evidenceCoverage?: ModelEvidenceCoverage;
  workload?: string;
  outputContractRevision?: string;
  qualificationId?: string;
  /** Fixed codes only: never persist prompts, outputs, exception text or credentials. */
  reason?:
    | "input_constraint"
    | "capability_constraint"
    | "role_scope_constraint"
    | "model_separation_constraint"
    | "model_separation_unproven"
    | "model_affinity_constraint"
    | "model_affinity_unproven"
    | "adapter_input_constraint"
    | "output_contract"
    | "adapter_error"
    | ModelAdapterError["code"]
    | "cancelled"
    | "deadline";
}>;

type Dispatch = (invoke: () => Promise<unknown>, signal: AbortSignal) => Promise<unknown>;

export class LogicalAgentModelRouter {
  readonly routing: LogicalAgentModelRouting;
  #adapters = new Map<string, LogicalAgentModelAdapter>();
  #completedModels = new Map<string, Map<LogicalAgentId, Set<string>>>();

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
      if (
        adapter.maxInputBytes !== undefined &&
        (!Number.isSafeInteger(adapter.maxInputBytes) || adapter.maxInputBytes < 1)
      ) {
        throw new Error("specialist input bytes must be bounded");
      }
      this.#adapters.set(
        adapter.id,
        Object.freeze({
          ...adapter,
          capabilities: Object.freeze([...adapter.capabilities]),
          requiredTools: Object.freeze([...adapter.requiredTools]),
          requiredSideEffects: Object.freeze([...adapter.requiredSideEffects]),
          ...(adapter.roleScope ? { roleScope: Object.freeze([...adapter.roleScope]) } : {}),
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
      if (
        policy.retryOutputContractOnce !== undefined &&
        (typeof policy.retryOutputContractOnce !== "boolean" || !policy.outputContract)
      ) {
        throw new Error("model contract repair requires a validator and boolean policy");
      }
      if (
        policy.retryAffinityTruncationOnce !== undefined &&
        (typeof policy.retryAffinityTruncationOnce !== "boolean" || !policy.sameModelAsRole)
      ) {
        throw new Error("affinity truncation repair requires a same-model role policy");
      }
      if (
        policy.retryTruncatedOutputOnce !== undefined &&
        typeof policy.retryTruncatedOutputOnce !== "boolean"
      ) {
        throw new Error("truncated-output retry policy must be boolean");
      }
      const targets = [policy.primary, ...(policy.fallback ?? [])];
      if (
        policy.outputContract &&
        (!policy.outputContract.revision.trim() ||
          typeof policy.outputContract.validate !== "function")
      ) {
        throw new Error("model output contract requires a revision and validator");
      }
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
        ...(policy.excludeModelsUsedBy
          ? { excludeModelsUsedBy: Object.freeze([...policy.excludeModelsUsedBy]) }
          : {}),
        ...(policy.outputContract
          ? { outputContract: Object.freeze({ ...policy.outputContract }) }
          : {}),
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

  restoreCompletedModelCalls(
    correlationId: string,
    receipts: readonly ModelCallReceipt[],
    sourceCorrelationId: string = correlationId,
  ): void {
    if (!correlationId.trim()) {
      throw new Error("model routing restore requires a correlation ID");
    }
    if (sourceCorrelationId !== correlationId) {
      const sourceAttempt = /^(.*):attempt:(\d+)$/u.exec(sourceCorrelationId);
      if (
        !sourceAttempt ||
        correlationId !== `${sourceAttempt[1]}:attempt:${Number(sourceAttempt[2]) + 1}`
      ) {
        throw new Error("model routing restore requires the next attempt of the same run");
      }
    }
    const completed = new Map<LogicalAgentId, Set<string>>();
    for (const receipt of receipts) {
      if (receipt.correlationId !== sourceCorrelationId) {
        throw new Error("model routing checkpoint receipt correlation mismatch");
      }
      if (receipt.outcome !== "completed") {
        continue;
      }
      const adapter = this.#adapters.get(receipt.adapterId);
      if (
        !adapter ||
        receipt.schemaVersion !== "lcx_model_call_v1" ||
        receipt.policyRevision !== this.routing.revision ||
        receipt.provider !== adapter.provider ||
        receipt.modelId !== adapter.modelId ||
        !receipt.adapterInvoked
      ) {
        throw new Error("logical-agent checkpoint contains an invalid completed model receipt");
      }
      const models = completed.get(receipt.role) ?? new Set<string>();
      models.add(`${receipt.provider}/${receipt.modelId}`);
      completed.set(receipt.role, models);
    }
    if (completed.size > 0) {
      this.#completedModels.set(correlationId, completed);
    }
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
    /** A caller task can expire before an individual role's timeout. */
    deadlineAtMs?: number;
    /** Host-owned classifier for an inherited task deadline's abort reason. */
    isDeadlineAbort?: (reason: unknown) => boolean;
    dispatch: Dispatch;
    record: (receipt: ModelCallReceipt) => void;
  }): Promise<unknown> {
    const policy = this.#policy(params.role);
    if (
      policy.retryTruncatedOutputOnce &&
      params.role !== "evidence_integrity" &&
      params.role !== "adversarial_challenge" &&
      params.role !== "final_precheck"
    ) {
      throw new Error("truncated-output retry requires a quality review role");
    }
    const targets = [policy.primary, ...(policy.fallback ?? [])];
    let contractRepairUsed = false;
    let affinityTruncationRetryTarget: string | undefined;
    // Freeze the input snapshot across retries; each adapter receives its own JSON copy.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(params.payload);
    } catch {
      /* Rejected below with a fixed code. */
    }
    for (const [index, id] of targets.entries()) {
      const isAffinityTruncationRetryAttempt = affinityTruncationRetryTarget === id;
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
      const abort = () => {
        if (params.isDeadlineAbort?.(params.signal.reason)) {
          reason = "deadline";
        }
        controller.abort(params.signal.reason);
      };
      params.signal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadlineAtMs = Math.min(
        startedAtMs + policy.timeoutMs,
        params.deadlineAtMs ?? Number.POSITIVE_INFINITY,
      );
      const assertActive = () => {
        if (!controller.signal.aborted && Date.now() >= deadlineAtMs) {
          outcome = "timed_out";
          reason = "deadline";
          controller.abort();
        }
        if (controller.signal.aborted) {
          throw new Error("model call cancelled or timed out");
        }
      };
      try {
        if (params.signal.aborted) {
          const expired = params.isDeadlineAbort?.(params.signal.reason) === true;
          outcome = expired ? "timed_out" : "aborted";
          reason = expired ? "deadline" : "cancelled";
          throw new Error("model call cancelled or timed out");
        }
        assertActive();
        const anyTool = params.capabilities.allowedTools.includes(LOGICAL_AGENT_ANY_TOOL);
        const allowed =
          policy.requiredCapabilities.every((cap) => adapter.capabilities.includes(cap)) &&
          adapter.requiredTools.every(
            (tool) => anyTool || params.capabilities.allowedTools.includes(tool),
          ) &&
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
        const prior = this.#completedModels.get(params.correlationId);
        const affinity = policy.sameModelAsRole ? prior?.get(policy.sameModelAsRole) : undefined;
        if (policy.sameModelAsRole && affinity?.size !== 1) {
          outcome = "rejected";
          reason = "model_affinity_unproven";
          throw new Error("artifact author identity is unavailable or ambiguous");
        }
        if (affinity && !affinity.has(`${adapter.provider}/${adapter.modelId}`)) {
          outcome = "rejected";
          reason = "model_affinity_constraint";
          throw new Error("artifact rewrite must preserve its actual author model");
        }
        if (policy.excludeModelsUsedBy?.some((role) => !prior?.get(role)?.size)) {
          outcome = "rejected";
          reason = "model_separation_unproven";
          throw new Error("prior model identity unavailable for independent review");
        }
        if (
          policy.excludeModelsUsedBy?.some((role) =>
            prior?.get(role)?.has(`${adapter.provider}/${adapter.modelId}`),
          )
        ) {
          outcome = "rejected";
          reason = "model_separation_constraint";
          throw new Error("review model must differ from artifact authors");
        }
        if (adapter.roleScope && !adapter.roleScope.includes(params.role)) {
          outcome = "rejected";
          reason = "role_scope_constraint";
          throw new Error("model specialist role scope rejected");
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
        if (
          adapter.maxInputBytes !== undefined &&
          Buffer.byteLength(serialized, "utf8") > adapter.maxInputBytes
        ) {
          outcome = "rejected";
          reason = "adapter_input_constraint";
          throw new Error("model specialist input scope rejected");
        }
        const unavailable = adapter.unavailableReason?.();
        if (unavailable) {
          outcome = "rejected";
          reason = unavailable;
          throw new ModelAdapterError(unavailable);
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
        timer = setTimeout(
          () => {
            reason = "deadline";
            controller.abort();
          },
          Math.max(0, deadlineAtMs - Date.now()),
        );
        const result = await Promise.race([
          params.dispatch(async () => {
            assertActive();
            adapterInvoked = true;
            return adapter.invoke(
              Object.freeze({ ...identity, payload, deadlineAtMs }),
              controller.signal,
            );
          }, controller.signal),
          cancelled,
        ]);
        assertActive();
        if (policy.outputContract) {
          let accepted = false;
          try {
            accepted = policy.outputContract.validate(result, payload);
          } catch {
            // Validator exceptions are contract failures, never model success.
          }
          assertActive();
          if (!accepted) {
            reason = "output_contract";
            throw new Error("model output contract rejected");
          }
        }
        outcome = "completed";
        const completed =
          this.#completedModels.get(params.correlationId) ?? new Map<LogicalAgentId, Set<string>>();
        const models = completed.get(params.role) ?? new Set<string>();
        models.add(`${adapter.provider}/${adapter.modelId}`);
        completed.set(params.role, models);
        this.#completedModels.set(params.correlationId, completed);
        return result;
      } catch (error) {
        if (!params.signal.aborted && Date.now() >= deadlineAtMs) {
          outcome = "timed_out";
          reason = "deadline";
          controller.abort();
        }
        if (error instanceof ModelAdapterError && error.code === "runtime_timeout") {
          outcome = "timed_out";
        }
        reason ??= error instanceof ModelAdapterError ? error.code : "adapter_error";
        const retryContract =
          reason === "output_contract" && policy.retryOutputContractOnce && !contractRepairUsed;
        const retryTruncatedAffinity =
          (reason === "output_truncated" ||
            (params.role === "formatting" && reason === "output_invalid")) &&
          policy.retryAffinityTruncationOnce &&
          !contractRepairUsed;
        const retryTruncatedOutput =
          reason === "output_truncated" && policy.retryTruncatedOutputOnce && !contractRepairUsed;
        if (
          (retryContract || retryTruncatedAffinity || retryTruncatedOutput) &&
          !params.signal.aborted
        ) {
          contractRepairUsed = true;
          if (retryTruncatedAffinity) {
            affinityTruncationRetryTarget = id;
          }
          // Stay with the same eligible author/reviewer; each attempt still goes
          // through capability, separation, affinity, dispatch and budget checks.
          targets.splice(index + 1, 0, id);
        }
        // An affinity-bound truncated or syntactically invalid rewrite gets one same-author repair.
        // Do not try another adapter if the repair itself fails validation or truncates.
        if (isAffinityTruncationRetryAttempt) {
          throw new Error(`model routing ${outcome}: ${reason}`, { cause: error });
        }
        // Cancellation never launches a fallback; failed/rejected/timed-out targets may do so.
        if (
          outcome === "aborted" ||
          params.signal.aborted ||
          Date.now() >= (params.deadlineAtMs ?? Number.POSITIVE_INFINITY) ||
          index === targets.length - 1 ||
          reason === "input_constraint" ||
          reason === "prompt_input_invalid" ||
          reason === "prompt_budget_exceeded" ||
          reason === "call_budget_exhausted" ||
          reason === "model_separation_unproven" ||
          reason === "model_affinity_unproven"
        ) {
          throw new Error(`model routing ${outcome}: ${reason}`, { cause: error });
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
            ...(policy.workload ? { workload: policy.workload } : {}),
            ...(policy.outputContract
              ? { outputContractRevision: policy.outputContract.revision }
              : {}),
            ...(adapter.qualificationId ? { qualificationId: adapter.qualificationId } : {}),
            startedAtMs,
            latencyMs: Math.max(0, Date.now() - startedAtMs),
            outcome,
            adapterInvoked,
            realModelInferenceObserved: observation !== undefined,
            providerCallObserved: observation?.kind === "provider_call",
            evidence: observation ? "adapter-attested" : "not-observed",
            ...(observation?.reasoningEffort
              ? { reasoningEffort: observation.reasoningEffort }
              : {}),
            ...(observation?.credentialSource
              ? { credentialSource: observation.credentialSource }
              : {}),
            ...(observation?.outputNormalization
              ? { outputNormalization: observation.outputNormalization }
              : {}),
            ...(observation?.evidenceCoverage
              ? { evidenceCoverage: observation.evidenceCoverage }
              : {}),
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

/** Allow every bounded fallback plus scheduler overhead without truncating the role contract. */
export function modelRoutingTaskTimeoutMs(routing: LogicalAgentModelRouting): number {
  return Math.min(
    2_147_483_647,
    Math.max(
      ...[routing.defaultPolicy, ...Object.values(routing.roles ?? {})].map(
        (policy) =>
          policy.timeoutMs *
            (1 +
              (policy.fallback?.length ?? 0) +
              (policy.retryOutputContractOnce ||
              policy.retryAffinityTruncationOnce ||
              policy.retryTruncatedOutputOnce
                ? 1
                : 0)) +
          1_000,
      ),
    ),
  );
}
