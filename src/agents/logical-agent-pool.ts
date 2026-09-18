import { createHash, randomUUID } from "node:crypto";
import { LCX_ONTOLOGY_AGENT_ROLES, type LcxOntologyAgentRole } from "../shared/lcx-ontology.js";
import {
  LOGICAL_AGENT_ANY_TOOL,
  LogicalAgentModelRouter,
  type LogicalAgentModelRouting,
  type ModelCallReceipt,
} from "./logical-agent-model-router.js";
export type { LogicalAgentModelRouting, ModelCallReceipt } from "./logical-agent-model-router.js";
import { stableStringify } from "./stable-stringify.js";

export const LOGICAL_AGENT_IDS = [
  "data_cleaning",
  "financial_extraction",
  "risk_check",
  "adversarial_challenge",
  "news_classification",
  "portfolio_exposure",
  "evidence_integrity",
  "research_draft",
  "formatting",
  "final_precheck",
] as const;

export type LogicalAgentId = (typeof LOGICAL_AGENT_IDS)[number];

export const LOGICAL_AGENT_SIDE_EFFECTS = [
  "local_read",
  "local_compute",
  "local_output",
  "provider_call",
  "external_message",
  "protected_memory_write",
  "trading_action",
] as const;

export type LogicalAgentSideEffect = (typeof LOGICAL_AGENT_SIDE_EFFECTS)[number];

export type LogicalAgentCapabilities = Readonly<{
  allowedTools: readonly string[];
  allowedSideEffects: readonly LogicalAgentSideEffect[];
  forbiddenSideEffects: readonly LogicalAgentSideEffect[];
}>;

export type LogicalAgentModelInvoker = (request: unknown, signal: AbortSignal) => Promise<unknown>;

export type LogicalAgentModelSlot = Readonly<{
  modelId: string;
  maxLoadedModels: 1;
  invoke: LogicalAgentModelInvoker;
}>;

export const LOGICAL_AGENT_CHECKPOINT_SCHEMA_VERSION = "lcx_logical_agent_checkpoint_v1" as const;

export type LogicalAgentRunEventKind =
  | "run_started"
  | "run_resumed"
  | "handoff"
  | "task_dispatched"
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  | "checkpoint_saved"
  | "run_completed";

export type LogicalAgentRunEvent = Readonly<{
  schemaVersion: typeof LOGICAL_AGENT_CHECKPOINT_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  sequence: number;
  kind: LogicalAgentRunEventKind;
  taskId?: string;
  atMs: number;
  payload?: Readonly<Record<string, unknown>>;
}>;

/** Event sinks are observers only; the in-memory event list remains the run's local proof. */
export type LogicalAgentEventSink = (event: LogicalAgentRunEvent) => void;

export type LogicalAgentCheckpoint<TResult> = Readonly<{
  schemaVersion: typeof LOGICAL_AGENT_CHECKPOINT_SCHEMA_VERSION;
  runId: string;
  planFingerprint: string;
  completedTaskIds: readonly string[];
  results: readonly LogicalAgentTaskResult<TResult>[];
  lastEventSequence: number;
}>;

/**
 * Persistence is injected by the caller so the pool cannot create a second
 * state root. Implementations must atomically replace a checkpoint by runId.
 */
export type LogicalAgentCheckpointStore<TResult> = Readonly<{
  load: (runId: string) => LogicalAgentCheckpoint<TResult> | undefined;
  save: (checkpoint: LogicalAgentCheckpoint<TResult>) => void;
}>;

export function createInMemoryLogicalAgentCheckpointStore<
  TResult,
>(): LogicalAgentCheckpointStore<TResult> {
  const checkpoints = new Map<string, LogicalAgentCheckpoint<TResult>>();
  return {
    load: (runId) => {
      const checkpoint = checkpoints.get(runId);
      return checkpoint === undefined ? undefined : snapshotCheckpoint(checkpoint);
    },
    save: (checkpoint) => {
      checkpoints.set(checkpoint.runId, snapshotCheckpoint(checkpoint));
    },
  };
}

export type LogicalAgentHandoff = Readonly<{
  fromTaskId: string;
  toTaskId: string;
  contextScope: "dependency_results";
  ownership: "transferred";
  reason?: string;
}>;

export type LogicalAgentInputGuardrailContext<TInput> = Readonly<{
  task: LogicalAgentTask<TInput>;
  agent: LogicalAgentDefinition;
  input: TInput;
  capabilities: LogicalAgentCapabilities;
}>;

export type LogicalAgentOutputGuardrailContext<TInput, TResult> = Readonly<{
  task: LogicalAgentTask<TInput>;
  agent: LogicalAgentDefinition;
  output: TResult;
  sideEffects: readonly LogicalAgentSideEffect[];
  capabilities: LogicalAgentCapabilities;
}>;

export type LogicalAgentGuardrails<TInput, TResult> = Readonly<{
  input?: (context: LogicalAgentInputGuardrailContext<TInput>) => void | Promise<void>;
  output?: (context: LogicalAgentOutputGuardrailContext<TInput, TResult>) => void | Promise<void>;
}>;

/**
 * Default capability grant for the logical-agent pool.
 *
 * It is deliberately unrestricted: every declared side effect and every tool is allowed,
 * so no local capability is withheld by default. Narrowing is opt-in -- a caller that
 * needs a smaller surface passes its own `LogicalAgentCapabilities`, and
 * `normalizeExecutionResult` still enforces exactly the set it was handed.
 *
 * An open default grants no side effect by itself. A side effect only happens when a
 * caller both declares it and supplies an executor that performs it; the pool merely
 * stops refusing the declaration up front. `provider_call` stays additionally gated per
 * run by the pool's `allowProviderCalls` option, which is what actually admits it.
 */
export const LOGICAL_AGENT_LOCAL_CAPABILITIES: LogicalAgentCapabilities = Object.freeze({
  allowedTools: Object.freeze([LOGICAL_AGENT_ANY_TOOL] as const),
  allowedSideEffects: Object.freeze([...LOGICAL_AGENT_SIDE_EFFECTS]),
  forbiddenSideEffects: Object.freeze([] as const),
});

export type LogicalAgentDefinition = Readonly<{
  id: LogicalAgentId;
  label: string;
  purpose: string;
  ontologyRole: LcxOntologyAgentRole;
  modelBinding: "shared_local_model";
  capabilities: LogicalAgentCapabilities;
}>;

function freezeLogicalAgentCapabilities(
  capabilities: LogicalAgentCapabilities,
): LogicalAgentCapabilities {
  return Object.freeze({
    allowedTools: Object.freeze([...capabilities.allowedTools]),
    allowedSideEffects: Object.freeze([...capabilities.allowedSideEffects]),
    forbiddenSideEffects: Object.freeze([...capabilities.forbiddenSideEffects]),
  });
}

function freezeLogicalAgentDefinition(definition: LogicalAgentDefinition): LogicalAgentDefinition {
  return Object.freeze({
    ...definition,
    capabilities: freezeLogicalAgentCapabilities(definition.capabilities),
  });
}

const RAW_LOGICAL_AGENT_DEFINITIONS = [
  {
    id: "data_cleaning",
    label: "数据清洗 Agent",
    purpose: "整理输入、去重、标出缺失字段和未经验证的数字。",
    ontologyRole: "worker",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "financial_extraction",
    label: "财报抽取 Agent",
    purpose: "从已提供材料中抽取公司、财务和时间字段，不补造数据。",
    ontologyRole: "specialist",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "risk_check",
    label: "风险检查 Agent",
    purpose: "检查下行风险、约束条件、杠杆和需要补证的判断。",
    ontologyRole: "risk_gate",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "adversarial_challenge",
    label: "反方挑战 Agent",
    purpose: "主动寻找反例、冲突证据和过度自信的结论。",
    ontologyRole: "evaluator",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "news_classification",
    label: "新闻分类 Agent",
    purpose: "对输入新闻按主题、时效和影响方向分类，不替代来源核验。",
    ontologyRole: "specialist",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "portfolio_exposure",
    label: "组合暴露计算 Agent",
    purpose: "整理持仓暴露、集中度和情景影响；缺少持仓字段时明确缺口。",
    ontologyRole: "specialist",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "evidence_integrity",
    label: "证据完整性 Agent",
    purpose: "检查来源、时间戳、分母、单位和证据链是否足够。",
    ontologyRole: "evaluator",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "research_draft",
    label: "研究草稿 Agent",
    purpose: "把前置结果组合成研究级草稿，保留正方、反方和不确定性。",
    ontologyRole: "coordinator",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "formatting",
    label: "格式整理 Agent",
    purpose: "将草稿整理为清晰、短、可审阅的输出结构。",
    ontologyRole: "worker",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
  {
    id: "final_precheck",
    label: "最终本地预审 Agent",
    purpose: "在输出前检查直接交易指令、虚构当前数据和证据越权。",
    ontologyRole: "risk_gate",
    modelBinding: "shared_local_model",
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
  },
] as const satisfies readonly LogicalAgentDefinition[];

export const LOGICAL_AGENT_DEFINITIONS: readonly LogicalAgentDefinition[] = Object.freeze(
  RAW_LOGICAL_AGENT_DEFINITIONS.map(freezeLogicalAgentDefinition),
);

const ONTOLOGY_ROLE_SET = new Set<string>(LCX_ONTOLOGY_AGENT_ROLES);
const NODE_MAX_TIMEOUT_MS = 2_147_483_647;
const SHARED_MODEL_INVOCATION_CONCURRENCY = 1;
for (const definition of LOGICAL_AGENT_DEFINITIONS) {
  if (!ONTOLOGY_ROLE_SET.has(definition.ontologyRole)) {
    throw new Error(`logical agent has an unknown ontology role: ${definition.ontologyRole}`);
  }
}

export type LocalModelPoolConfig = Readonly<{
  modelId: string;
  maxLoadedModels: 1;
  maxConcurrency: 1 | 2;
  /** Requested per-invocation delta; the enforcement mode is reported below. */
  memoryBudgetMb: number;
  memoryBudgetEnforcement: "measured_invocation_delta";
  taskTimeoutMs: number;
}>;

export type LocalModelPoolOptions<
  TInput = unknown,
  TResult = unknown,
> = Partial<LocalModelPoolConfig> & {
  /** Adds `provider_call` to this pool's grant; a widening that is meaningful only when a
   * caller has already narrowed `capabilities`. */
  allowProviderCalls?: boolean;
  /**
   * Capability grant applied to every task in this pool. Defaults to the open
   * `LOGICAL_AGENT_LOCAL_CAPABILITIES`. Pass a narrower set to keep a boundary
   * enforceable: `normalizeExecutionResult` then rejects any declared side effect
   * outside it, and the router rejects an adapter requiring a tool outside it.
   */
  capabilities?: LogicalAgentCapabilities;
  modelInvoker?: LogicalAgentModelInvoker;
  modelRouting?: LogicalAgentModelRouting;
  guardrails?: LogicalAgentGuardrails<TInput, TResult>;
};

export const DEFAULT_LOCAL_MODEL_POOL: LocalModelPoolConfig = Object.freeze({
  modelId: "Qwen/Qwen3-0.6B",
  maxLoadedModels: 1,
  maxConcurrency: 1,
  memoryBudgetMb: 3072,
  memoryBudgetEnforcement: "measured_invocation_delta",
  taskTimeoutMs: 30_000,
});

export type LogicalAgentRequest = {
  ask: string;
  evidence?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Immutable facts shared by every role in one run. This is part of the plan
 * fingerprint so a resumed run cannot silently mix two fact snapshots.
 */
export type LogicalAgentSharedContext = Readonly<Record<string, unknown>>;

export type LogicalAgentTask<TInput = LogicalAgentRequest> = {
  id: string;
  agentId: LogicalAgentId;
  input: TInput;
  dependsOn?: readonly string[];
};

export type LogicalAgentTaskStatus = "queued" | "running" | "completed" | "failed" | "blocked";

export type LogicalAgentTaskResult<TResult = unknown> = Readonly<{
  taskId: string;
  agentId: LogicalAgentId;
  status: Exclude<LogicalAgentTaskStatus, "queued" | "running">;
  modelId: string;
  startedAt?: number;
  completedAt: number;
  output?: TResult;
  sideEffects: readonly LogicalAgentSideEffect[];
  error?: string;
  capabilityViolation?: string;
  modelCalls?: readonly ModelCallReceipt[];
}>;

export type LogicalAgentExecutionContext<TInput, TResult> = {
  task: LogicalAgentTask<TInput>;
  agent: LogicalAgentDefinition;
  input: TInput;
  sharedContext: LogicalAgentSharedContext;
  dependencyResults: Readonly<Record<string, LogicalAgentTaskResult<TResult>>>;
  modelPool: LocalModelPoolConfig;
  modelSlot: LogicalAgentModelSlot;
  capabilities: LogicalAgentCapabilities;
  signal: AbortSignal;
};

export type LogicalAgentExecutionResult<TResult> = Readonly<{
  output: TResult;
  sideEffects: readonly LogicalAgentSideEffect[];
}>;

export type LogicalAgentExecutor<TInput, TResult> = (
  context: LogicalAgentExecutionContext<TInput, TResult>,
) => LogicalAgentExecutionResult<TResult> | Promise<LogicalAgentExecutionResult<TResult>>;

export type LogicalAgentPoolStatus = {
  modelId: string;
  sharedModel: boolean;
  modelRoutingMode?: "shared_invoker" | "role_policy";
  configuredModelIds?: readonly string[];
  maxLoadedModels: 1;
  maxConcurrency: 1 | 2;
  memoryBudgetMb: number;
  memoryBudgetEnforcement: "measured_invocation_delta";
  taskTimeoutMs: number;
  queuedRuns: number;
  activeRuns: number;
  maxObservedConcurrency: number;
  activeModelInvocations: number;
  maxObservedModelConcurrency: number;
};

const UNAVAILABLE_MODEL_INVOKER: LogicalAgentModelInvoker = async () => {
  throw new Error("logical-agent model slot has no local model invoker");
};

export type LogicalAgentPlanResult<TResult> = {
  status: "completed" | "failed" | "blocked";
  finalTaskId: string | null;
  tasks: Array<LogicalAgentTaskResult<TResult>>;
  pool: LogicalAgentPoolStatus;
  runId: string;
  planFingerprint: string;
  resumed: boolean;
  events: readonly LogicalAgentRunEvent[];
  handoffs: readonly LogicalAgentHandoff[];
};

type QueueJob<TInput, TResult> = {
  task: LogicalAgentTask<TInput>;
  sharedContext: LogicalAgentSharedContext;
  dependencyResults: Readonly<Record<string, LogicalAgentTaskResult<TResult>>>;
  executor: LogicalAgentExecutor<TInput, TResult>;
  correlationId: string;
  signal?: AbortSignal;
  resolve: (result: LogicalAgentTaskResult<TResult>) => void;
  onStart?: () => void;
};

type ModelInvocationJob = {
  invoke: () => Promise<unknown>;
  signal: AbortSignal;
  cleanup: () => void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type TaskModelInvocationScope = {
  pending: Set<Promise<void>>;
  errors: unknown[];
  closed: boolean;
};

function getLogicalAgentDefinition(agentId: LogicalAgentId): LogicalAgentDefinition {
  const definition = LOGICAL_AGENT_DEFINITIONS.find((candidate) => candidate.id === agentId);
  if (!definition) {
    throw new Error(`unknown logical agent: ${agentId}`);
  }
  return definition;
}

function normalizePoolConfig(config?: Partial<LocalModelPoolConfig>): LocalModelPoolConfig {
  const maxConcurrency = config?.maxConcurrency ?? DEFAULT_LOCAL_MODEL_POOL.maxConcurrency;
  if (maxConcurrency !== 1 && maxConcurrency !== 2) {
    throw new Error("local logical-agent pool maxConcurrency must be 1 or 2");
  }
  const maxLoadedModels = config?.maxLoadedModels ?? DEFAULT_LOCAL_MODEL_POOL.maxLoadedModels;
  if (maxLoadedModels !== 1) {
    throw new Error("local logical-agent pool permits exactly one loaded model");
  }
  const memoryBudgetMb = config?.memoryBudgetMb ?? DEFAULT_LOCAL_MODEL_POOL.memoryBudgetMb;
  if (!Number.isFinite(memoryBudgetMb) || memoryBudgetMb <= 0) {
    throw new Error("local logical-agent pool memoryBudgetMb must be positive");
  }
  const taskTimeoutMs = config?.taskTimeoutMs ?? DEFAULT_LOCAL_MODEL_POOL.taskTimeoutMs;
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0) {
    throw new Error("local logical-agent pool taskTimeoutMs must be positive");
  }
  if (taskTimeoutMs > NODE_MAX_TIMEOUT_MS) {
    throw new Error(
      `local logical-agent pool taskTimeoutMs must not exceed ${NODE_MAX_TIMEOUT_MS}ms`,
    );
  }
  const modelId = config?.modelId?.trim() || DEFAULT_LOCAL_MODEL_POOL.modelId;
  return Object.freeze({
    modelId,
    maxLoadedModels: 1,
    maxConcurrency,
    memoryBudgetMb,
    memoryBudgetEnforcement: "measured_invocation_delta",
    taskTimeoutMs,
  });
}

export class LogicalAgentPool<TInput, TResult> {
  #allowProviderCalls: boolean;
  #capabilities?: LogicalAgentCapabilities;
  #config: LocalModelPoolConfig;
  #modelInvoker: LogicalAgentModelInvoker;
  #guardrails: LogicalAgentGuardrails<TInput, TResult>;
  #modelRouter?: LogicalAgentModelRouter;
  #queue: Array<QueueJob<TInput, TResult>> = [];
  #modelInvocationQueue: ModelInvocationJob[] = [];
  #activeRuns = 0;
  #maxObservedConcurrency = 0;
  #activeModelInvocations = 0;
  #maxObservedModelConcurrency = 0;

  constructor(options?: LocalModelPoolOptions<TInput, TResult>) {
    this.#allowProviderCalls = options?.allowProviderCalls === true;
    this.#capabilities = options?.capabilities
      ? freezeLogicalAgentCapabilities(options.capabilities)
      : undefined;
    this.#config = normalizePoolConfig(options);
    this.#modelInvoker = options?.modelInvoker ?? UNAVAILABLE_MODEL_INVOKER;
    this.#guardrails = options?.guardrails ?? {};
    this.#modelRouter = options?.modelRouting
      ? new LogicalAgentModelRouter(options.modelRouting)
      : undefined;
  }

  /** Functions are deliberately excluded; adapter code changes require a new revision. */
  get modelRoutingFingerprint(): string | undefined {
    return this.#modelRouter
      ? createHash("sha256")
          .update(
            stableStringify({
              routing: this.#modelRouter.routing,
              allowProviderCalls: this.#allowProviderCalls,
              // Included only when a caller narrowed the grant, so an un-narrowed pool keeps
              // exactly its previous fingerprint.
              ...(this.#capabilities ? { capabilities: this.#capabilities } : {}),
            }),
          )
          .digest("hex")
      : undefined;
  }

  get config(): LocalModelPoolConfig {
    return this.#config;
  }

  get status(): LogicalAgentPoolStatus {
    return {
      modelId: this.#config.modelId,
      sharedModel:
        !this.#modelRouter ||
        new Set(this.#modelRouter.routing.adapters.map((adapter) => adapter.modelId)).size === 1,
      modelRoutingMode: this.#modelRouter ? "role_policy" : "shared_invoker",
      configuredModelIds: Object.freeze(
        this.#modelRouter
          ? [...new Set(this.#modelRouter.routing.adapters.map((adapter) => adapter.modelId))]
          : [this.#config.modelId],
      ),
      maxLoadedModels: 1,
      maxConcurrency: this.#config.maxConcurrency,
      memoryBudgetMb: this.#config.memoryBudgetMb,
      memoryBudgetEnforcement: this.#config.memoryBudgetEnforcement,
      taskTimeoutMs: this.#config.taskTimeoutMs,
      queuedRuns: this.#queue.length,
      activeRuns: this.#activeRuns,
      maxObservedConcurrency: this.#maxObservedConcurrency,
      activeModelInvocations: this.#activeModelInvocations,
      maxObservedModelConcurrency: this.#maxObservedModelConcurrency,
    };
  }

  restoreCompletedModelCalls(
    correlationId: string,
    results: readonly LogicalAgentTaskResult<TResult>[],
  ): void {
    this.#modelRouter?.restoreCompletedModelCalls(
      correlationId,
      results.flatMap((result) => result.modelCalls ?? []),
    );
  }

  submit(
    task: LogicalAgentTask<TInput>,
    executor: LogicalAgentExecutor<TInput, TResult>,
    dependencyResults: Readonly<Record<string, LogicalAgentTaskResult<TResult>>> = {},
    sharedContext: LogicalAgentSharedContext = {},
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<LogicalAgentTaskResult<TResult>> {
    getLogicalAgentDefinition(task.agentId);
    const taskSnapshot = snapshotTask(task);
    const dependencySnapshot = snapshotDependencyResults(dependencyResults);
    return new Promise((resolve) => {
      let queued = true;
      let cancelQueued: () => void = () => {};
      const job: QueueJob<TInput, TResult> = {
        task: taskSnapshot,
        sharedContext: cloneAndFreeze(sharedContext),
        dependencyResults: dependencySnapshot,
        executor,
        correlationId,
        signal,
        resolve,
        onStart: () => {
          queued = false;
          signal?.removeEventListener("abort", cancelQueued);
        },
      };
      cancelQueued = () => {
        if (!queued) {
          return;
        }
        const index = this.#queue.indexOf(job);
        if (index < 0) {
          return;
        }
        this.#queue.splice(index, 1);
        queued = false;
        signal?.removeEventListener("abort", cancelQueued);
        resolve(
          failedTaskResult<TResult>(
            taskSnapshot,
            this.#config.modelId,
            Date.now(),
            new Error("logical-agent task cancelled before start"),
          ),
        );
        this.#pump();
      };
      if (signal?.aborted) {
        queued = false;
        resolve(
          failedTaskResult<TResult>(
            taskSnapshot,
            this.#config.modelId,
            Date.now(),
            new Error("logical-agent task cancelled before start"),
          ),
        );
        return;
      }
      signal?.addEventListener("abort", cancelQueued, { once: true });
      this.#queue.push(job);
      this.#pump();
    });
  }

  #pump() {
    while (this.#activeRuns < this.#config.maxConcurrency && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (!job) {
        return;
      }
      job.onStart?.();
      this.#activeRuns += 1;
      this.#maxObservedConcurrency = Math.max(this.#maxObservedConcurrency, this.#activeRuns);
      const startedAt = Date.now();
      const registeredAgent = getLogicalAgentDefinition(job.task.agentId);
      const granted = this.#capabilities ?? registeredAgent.capabilities;
      const capabilities = freezeLogicalAgentCapabilities(
        this.#allowProviderCalls
          ? {
              ...granted,
              allowedSideEffects: [...granted.allowedSideEffects, "provider_call"],
              forbiddenSideEffects: granted.forbiddenSideEffects.filter(
                (effect) => effect !== "provider_call",
              ),
            }
          : granted,
      );
      const agent = freezeLogicalAgentDefinition({
        ...registeredAgent,
        capabilities,
      });
      const modelScope: TaskModelInvocationScope = {
        pending: new Set(),
        errors: [],
        closed: false,
      };
      const modelCalls: ModelCallReceipt[] = [];
      const selectedModelId = this.#modelRouter?.primaryModelId(agent.id) ?? this.#config.modelId;
      const attempt = executeWithTimeout(
        async (signal) => {
          const modelSlot = this.#createTaskModelSlot(
            modelScope,
            job,
            signal,
            capabilities,
            modelCalls,
          );
          try {
            await this.#guardrails.input?.({
              task: job.task,
              agent,
              input: job.task.input,
              capabilities,
            });
            const execution = await job.executor({
              task: job.task,
              agent,
              input: job.task.input,
              sharedContext: job.sharedContext,
              dependencyResults: job.dependencyResults,
              modelPool: this.#config,
              modelSlot,
              capabilities,
              signal,
            });
            await this.#guardrails.output?.({
              task: job.task,
              agent,
              output: execution.output,
              sideEffects: execution.sideEffects,
              capabilities,
            });
            modelScope.closed = true;
            await this.#waitForTaskModelInvocations(modelScope);
            return execution;
          } catch (error: unknown) {
            modelScope.closed = true;
            await this.#waitForTaskModelInvocations(modelScope);
            throw error;
          }
        },
        this.#config.taskTimeoutMs,
        job.signal,
      );
      void attempt.outcome
        .then(
          (execution): LogicalAgentTaskResult<TResult> => {
            try {
              const normalized = normalizeExecutionResult<TResult>(execution, capabilities);
              return {
                taskId: job.task.id,
                agentId: job.task.agentId,
                status: "completed",
                modelId: this.#config.modelId,
                startedAt,
                completedAt: Date.now(),
                output: cloneAndFreeze(normalized.output),
                sideEffects: normalized.sideEffects,
              };
            } catch (error: unknown) {
              return failedTaskResult<TResult>(job.task, this.#config.modelId, startedAt, error);
            }
          },
          (error: unknown) =>
            failedTaskResult<TResult>(job.task, this.#config.modelId, startedAt, error),
        )
        .then((result) => {
          job.resolve(
            Object.freeze({
              ...result,
              modelId: modelCalls.at(-1)?.modelId ?? selectedModelId,
              modelCalls: Object.freeze([...modelCalls]),
            }),
          );
        });
      void attempt.termination.then(() => {
        this.#activeRuns -= 1;
        this.#pump();
      });
    }
  }

  #invokeModel(invoke: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.#modelInvocationQueue.indexOf(job);
        if (index >= 0) {
          this.#modelInvocationQueue.splice(index, 1);
          job.cleanup();
          reject(new Error("logical-agent model invocation aborted before start"));
        }
      };
      const job: ModelInvocationJob = {
        invoke,
        signal,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      this.#modelInvocationQueue.push(job);
      signal.addEventListener("abort", abort, { once: true });
      this.#pumpModelInvocations();
    });
  }

  #createTaskModelSlot(
    scope: TaskModelInvocationScope,
    job: QueueJob<TInput, TResult>,
    taskSignal: AbortSignal,
    capabilities: LogicalAgentCapabilities,
    receipts: ModelCallReceipt[],
  ): LogicalAgentModelSlot {
    return Object.freeze({
      modelId: this.#modelRouter?.primaryModelId(job.task.agentId) ?? this.#config.modelId,
      maxLoadedModels: 1,
      invoke: (request: unknown, signal: AbortSignal) => {
        if (scope.closed) {
          return Promise.reject(
            new Error("logical-agent model invocation started after task exit"),
          );
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        for (const source of [signal, taskSignal]) {
          source.addEventListener("abort", abort, { once: true });
          if (source.aborted) {
            controller.abort();
          }
        }
        const invocation = (
          this.#modelRouter
            ? this.#modelRouter.invoke({
                role: job.task.agentId,
                taskId: job.task.id,
                correlationId: job.correlationId,
                payload: request,
                capabilities,
                signal: controller.signal,
                dispatch: (invoke, dispatchSignal) => this.#invokeModel(invoke, dispatchSignal),
                record: (receipt) => receipts.push(receipt),
              })
            : this.#invokeLegacyModel(job, request, controller.signal, receipts)
        ).finally(() => {
          for (const source of [signal, taskSignal]) {
            source.removeEventListener("abort", abort);
          }
        });
        const observed = invocation.then(
          () => undefined,
          (error: unknown) => {
            scope.errors.push(error);
          },
        );
        scope.pending.add(observed);
        void observed.then(() => scope.pending.delete(observed));
        return invocation;
      },
    });
  }

  async #invokeLegacyModel(
    job: QueueJob<TInput, TResult>,
    request: unknown,
    signal: AbortSignal,
    receipts: ModelCallReceipt[],
  ): Promise<unknown> {
    const startedAtMs = Date.now();
    let outcome: ModelCallReceipt["outcome"] = "failed";
    let adapterInvoked = false;
    try {
      const value = await this.#invokeModel(() => {
        adapterInvoked = true;
        return this.#modelInvoker(request, signal);
      }, signal);
      outcome = "completed";
      return value;
    } finally {
      receipts.push(
        Object.freeze({
          schemaVersion: "lcx_model_call_v1",
          callId: randomUUID(),
          correlationId: job.correlationId,
          taskId: job.task.id,
          role: job.task.agentId,
          policyRevision: "legacy",
          adapterId: "legacy-invoker",
          provider: "unknown",
          modelId: this.#config.modelId,
          attempt: 1,
          mode: "injected",
          startedAtMs,
          latencyMs: Math.max(0, Date.now() - startedAtMs),
          outcome: signal.aborted ? "aborted" : outcome,
          adapterInvoked,
          realModelInferenceObserved: false,
          providerCallObserved: false,
          evidence: "not-observed",
        }),
      );
    }
  }

  async #waitForTaskModelInvocations(scope: TaskModelInvocationScope): Promise<void> {
    while (scope.pending.size > 0) {
      await Promise.all(scope.pending);
    }
    if (scope.errors.length > 0) {
      throw scope.errors[0];
    }
  }

  #pumpModelInvocations() {
    while (
      this.#activeModelInvocations < SHARED_MODEL_INVOCATION_CONCURRENCY &&
      this.#modelInvocationQueue.length > 0
    ) {
      const job = this.#modelInvocationQueue.shift();
      if (!job) {
        return;
      }
      job.cleanup();
      if (job.signal.aborted) {
        job.reject(new Error("logical-agent model invocation aborted before start"));
        continue;
      }
      this.#activeModelInvocations += 1;
      this.#maxObservedModelConcurrency = Math.max(
        this.#maxObservedModelConcurrency,
        this.#activeModelInvocations,
      );
      void Promise.resolve()
        .then(() => this.#invokeModelWithinBudget(job))
        .then(job.resolve, job.reject)
        .then(() => {
          this.#activeModelInvocations -= 1;
          this.#pumpModelInvocations();
        });
    }
  }

  async #invokeModelWithinBudget(job: ModelInvocationJob): Promise<unknown> {
    if (job.signal.aborted) {
      throw new Error("logical-agent model invocation aborted before adapter dispatch");
    }
    const beforeBytes = measuredProcessMemoryBytes();
    let result: unknown;
    let invocationError: unknown;
    let succeeded = false;
    try {
      result = await job.invoke();
      succeeded = true;
    } catch (error: unknown) {
      invocationError = error;
    }
    const observedDeltaBytes = Math.max(0, measuredProcessMemoryBytes() - beforeBytes);
    const budgetBytes = this.#config.memoryBudgetMb * 1024 * 1024;
    if (observedDeltaBytes > budgetBytes) {
      throw new LogicalAgentMemoryBudgetError(this.#config.memoryBudgetMb, observedDeltaBytes);
    }
    if (!succeeded) {
      throw invocationError;
    }
    return result;
  }
}

function snapshotTask<TInput>(task: LogicalAgentTask<TInput>): LogicalAgentTask<TInput> {
  return Object.freeze({
    ...task,
    dependsOn: task.dependsOn === undefined ? undefined : Object.freeze([...task.dependsOn]),
  });
}

function snapshotDependencyResults<TResult>(
  dependencyResults: Readonly<Record<string, LogicalAgentTaskResult<TResult>>>,
): Readonly<Record<string, LogicalAgentTaskResult<TResult>>> {
  const snapshot = Object.create(null) as Record<string, LogicalAgentTaskResult<TResult>>;
  for (const [taskId, result] of Object.entries(dependencyResults)) {
    Object.defineProperty(snapshot, taskId, {
      configurable: false,
      enumerable: true,
      value: snapshotTaskResult(result),
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function snapshotTaskResult<TResult>(
  result: LogicalAgentTaskResult<TResult>,
): LogicalAgentTaskResult<TResult> {
  return Object.freeze({
    ...result,
    ...(result.output === undefined ? {} : { output: cloneAndFreeze(result.output) }),
    sideEffects: Object.freeze([...result.sideEffects]),
    ...(result.modelCalls ? { modelCalls: cloneAndFreeze(result.modelCalls) } : {}),
  });
}

function snapshotCheckpoint<TResult>(
  checkpoint: LogicalAgentCheckpoint<TResult>,
): LogicalAgentCheckpoint<TResult> {
  return Object.freeze({
    schemaVersion: checkpoint.schemaVersion,
    runId: checkpoint.runId,
    planFingerprint: checkpoint.planFingerprint,
    completedTaskIds: Object.freeze([...checkpoint.completedTaskIds]),
    results: Object.freeze(checkpoint.results.map(snapshotTaskResult)),
    lastEventSequence: checkpoint.lastEventSequence,
  });
}

function cloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return deepFreeze(cloneObjectFallback(value));
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return value;
}

function cloneObjectFallback<T extends object>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneAndFreeze(item)) as T;
  }
  if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    const copy = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }
      Object.defineProperty(copy, key, {
        ...descriptor,
        ...("value" in descriptor ? { value: cloneAndFreeze(descriptor.value) } : {}),
      });
    }
    return copy as T;
  }
  return value;
}

function isLogicalAgentSideEffect(value: unknown): value is LogicalAgentSideEffect {
  return (
    typeof value === "string" && (LOGICAL_AGENT_SIDE_EFFECTS as readonly string[]).includes(value)
  );
}

class LogicalAgentCapabilityError extends Error {
  constructor(
    message: string,
    readonly sideEffects: readonly LogicalAgentSideEffect[],
  ) {
    super(message);
    this.name = "LogicalAgentCapabilityError";
  }
}

class LogicalAgentMemoryBudgetError extends Error {
  constructor(
    readonly budgetMb: number,
    readonly observedDeltaBytes: number,
  ) {
    super(
      `logical-agent model invocation exceeded memory budget of ${budgetMb}MiB ` +
        `(observed delta ${Math.ceil(observedDeltaBytes / (1024 * 1024))}MiB)`,
    );
    this.name = "LogicalAgentMemoryBudgetError";
  }
}

function measuredProcessMemoryBytes(): number {
  const usage = process.memoryUsage();
  // external includes ArrayBuffer memory in Node, so do not add arrayBuffers twice.
  return usage.heapUsed + usage.external;
}

type CapabilityViolation = Readonly<{
  sideEffects: readonly LogicalAgentSideEffect[];
  message: string;
}>;

function readCapabilityViolation(error: unknown): CapabilityViolation | undefined {
  try {
    if (!(error instanceof LogicalAgentCapabilityError)) {
      return undefined;
    }
    return {
      sideEffects: error.sideEffects,
      message: error.message,
    };
  } catch {
    return undefined;
  }
}

function failedTaskResult<TResult>(
  task: LogicalAgentTask<unknown>,
  modelId: string,
  startedAt: number,
  error: unknown,
): LogicalAgentTaskResult<TResult> {
  const capabilityViolation = readCapabilityViolation(error);
  return {
    taskId: task.id,
    agentId: task.agentId,
    status: "failed",
    modelId,
    startedAt,
    completedAt: Date.now(),
    sideEffects: capabilityViolation?.sideEffects ?? [],
    error: formatUnknownError(error),
    ...(capabilityViolation ? { capabilityViolation: capabilityViolation.message } : {}),
  };
}

function formatUnknownError(error: unknown): string {
  try {
    if (error instanceof Error) {
      try {
        return error.message;
      } catch {
        // Fall through to the defensive string conversion below.
      }
    }
  } catch {
    // A hostile proxy can throw while evaluating instanceof.
  }
  try {
    return String(error);
  } catch {
    return "logical-agent executor failed with an unstringifiable error";
  }
}

function normalizeExecutionResult<TResult>(
  value: unknown,
  capabilities: LogicalAgentCapabilities,
): LogicalAgentExecutionResult<TResult> {
  if (typeof value !== "object" || value === null || !("output" in value)) {
    throw new Error("logical-agent executor must return output and sideEffects");
  }
  const candidate = value as { output: TResult; sideEffects?: unknown };
  if (!Array.isArray(candidate.sideEffects)) {
    throw new Error("logical-agent executor must declare sideEffects");
  }
  const sideEffects = [...candidate.sideEffects];
  const unknownSideEffectIndex = sideEffects.findIndex(
    (sideEffect) => !isLogicalAgentSideEffect(sideEffect),
  );
  if (unknownSideEffectIndex >= 0) {
    throw new Error(
      `logical-agent executor declared unknown side effect: ${String(sideEffects[unknownSideEffectIndex])}`,
    );
  }
  const declaredSideEffects = sideEffects as LogicalAgentSideEffect[];
  const disallowed = declaredSideEffects.filter(
    (sideEffect) => !capabilities.allowedSideEffects.includes(sideEffect),
  );
  if (disallowed.length > 0) {
    throw new LogicalAgentCapabilityError(
      `logical-agent capability violation: ${disallowed.join(", ")}`,
      Object.freeze(disallowed),
    );
  }
  return {
    output: candidate.output,
    sideEffects: Object.freeze(declaredSideEffects),
  };
}

function executeWithTimeout<TResult>(
  executor: (signal: AbortSignal) => TResult | Promise<TResult>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { outcome: Promise<TResult>; termination: Promise<void> } {
  const controller = new AbortController();
  const cancellationErrors: unknown[] = [];
  const signal = createSafeAbortSignal(controller, cancellationErrors);
  let timedOut = false;
  let cancelled = parentSignal?.aborted === true;
  let outcomeSettled = false;
  let rejectOutcome: ((reason?: unknown) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rejectIfPending = (reason: unknown) => {
    if (outcomeSettled) {
      return;
    }
    outcomeSettled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    rejectOutcome?.(reason);
  };
  const cancel = () => {
    cancelled = true;
    try {
      controller.abort();
    } catch (error: unknown) {
      cancellationErrors.push(error);
    }
    if (!timedOut) {
      rejectIfPending(new Error("logical-agent task cancelled"));
    }
  };
  parentSignal?.addEventListener("abort", cancel, { once: true });
  const execution = Promise.resolve()
    .then(() => {
      if (cancelled) {
        throw new Error("logical-agent task cancelled before start");
      }
      return executor(signal);
    })
    .finally(() => parentSignal?.removeEventListener("abort", cancel));
  const termination = execution.then(
    () => undefined,
    () => undefined,
  );
  const outcome = new Promise<TResult>((resolve, reject) => {
    rejectOutcome = reject;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch (error: unknown) {
        cancellationErrors.push(error);
      }
      const cancellationDetail =
        cancellationErrors.length === 0
          ? ""
          : `; abort listener failures: ${cancellationErrors.map(formatUnknownError).join("; ")}`;
      const timeoutError = new Error(
        `logical-agent task timed out after ${timeoutMs}ms${cancellationDetail}`,
      );
      void termination.then(() => rejectIfPending(timeoutError));
    }, timeoutMs);
    execution.then(
      (value) => {
        if (outcomeSettled) {
          return;
        }
        if (cancelled) {
          rejectIfPending(new Error("logical-agent task cancelled"));
        } else if (!timedOut) {
          outcomeSettled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (outcomeSettled) {
          return;
        }
        if (!timedOut) {
          outcomeSettled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
  return { outcome, termination };
}

function createSafeAbortSignal(
  controller: AbortController,
  cancellationErrors: unknown[],
): AbortSignal {
  const target = controller.signal;
  const listeners = new WeakMap<object, Map<boolean, EventListener>>();
  let guardedOnAbort: EventListener | null = null;

  return new Proxy(target, {
    get(signal, property, receiver) {
      if (property === "addEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (listener === null) {
            return;
          }
          if (
            type !== "abort" ||
            (typeof listener !== "object" && typeof listener !== "function")
          ) {
            return signal.addEventListener(type, listener, options);
          }
          const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
          const listenerKey = listener as object;
          const existing = listeners.get(listenerKey);
          if (existing?.has(capture)) {
            return;
          }
          const guarded: EventListener = (event) => {
            try {
              if (typeof listener === "function") {
                listener.call(signal, event);
              } else {
                listener.handleEvent(event);
              }
            } catch (error: unknown) {
              cancellationErrors.push(error);
            }
          };
          const registrations = existing ?? new Map<boolean, EventListener>();
          registrations.set(capture, guarded);
          listeners.set(listenerKey, registrations);
          signal.addEventListener(type, guarded, options);
        };
      }
      if (property === "removeEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | EventListenerOptions,
        ) => {
          if (listener === null) {
            return;
          }
          const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
          const listenerKey = listener as object;
          const registrations = listeners.get(listenerKey);
          const guarded = registrations?.get(capture);
          if (guarded !== undefined) {
            signal.removeEventListener(type, guarded, options);
            registrations?.delete(capture);
          } else {
            signal.removeEventListener(type, listener, options);
          }
        };
      }
      if (typeof signal[property as keyof AbortSignal] === "function") {
        return (signal[property as keyof AbortSignal] as (...args: never[]) => unknown).bind(
          signal,
        );
      }
      return Reflect.get(signal, property, receiver);
    },
    set(signal, property, value, receiver) {
      if (property === "onabort") {
        if (guardedOnAbort !== null) {
          signal.removeEventListener("abort", guardedOnAbort);
        }
        if (value === null) {
          guardedOnAbort = null;
          return true;
        }
        if (typeof value !== "function") {
          return false;
        }
        guardedOnAbort = (event) => {
          try {
            value.call(signal, event);
          } catch (error: unknown) {
            cancellationErrors.push(error);
          }
        };
        signal.addEventListener("abort", guardedOnAbort);
        return true;
      }
      return Reflect.set(signal, property, value, receiver);
    },
  });
}

function validatePlan<TInput>(tasks: readonly LogicalAgentTask<TInput>[]) {
  const taskById = new Map<string, LogicalAgentTask<TInput>>();
  for (const task of tasks) {
    if (!task.id.trim()) {
      throw new Error("logical-agent task id must not be empty");
    }
    if (taskById.has(task.id)) {
      throw new Error(`duplicate logical-agent task id: ${task.id}`);
    }
    getLogicalAgentDefinition(task.agentId);
    taskById.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!taskById.has(dependency)) {
        throw new Error(`task ${task.id} depends on missing task ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`task ${task.id} cannot depend on itself`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) {
      throw new Error(`logical-agent plan contains a dependency cycle at ${taskId}`);
    }
    if (visited.has(taskId)) {
      return;
    }
    visiting.add(taskId);
    for (const dependency of taskById.get(taskId)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) {
    visit(task.id);
  }
}

export function fingerprintLogicalAgentPlan<TInput>(
  tasks: readonly LogicalAgentTask<TInput>[],
  handoffs: readonly LogicalAgentHandoff[] = [],
  finalTaskId?: string | null,
  sharedContext: LogicalAgentSharedContext = {},
): string {
  const canonicalTasks = tasks.map((task) => ({
    id: task.id,
    agentId: task.agentId,
    input: task.input,
    dependsOn: task.dependsOn ?? [],
  }));
  return createHash("sha256")
    .update(
      stableStringify({
        tasks: canonicalTasks,
        handoffs,
        finalTaskId: finalTaskId ?? null,
        sharedContext,
      }),
    )
    .digest("hex");
}

function validateHandoffs<TInput>(
  tasks: readonly LogicalAgentTask<TInput>[],
  handoffs: readonly LogicalAgentHandoff[],
): LogicalAgentHandoff[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const targets = new Set<string>();
  for (const handoff of handoffs) {
    const from = taskById.get(handoff.fromTaskId);
    const to = taskById.get(handoff.toTaskId);
    if (!from || !to) {
      throw new Error(
        `logical-agent handoff must reference existing tasks: ${handoff.fromTaskId} -> ${handoff.toTaskId}`,
      );
    }
    if (handoff.fromTaskId === handoff.toTaskId) {
      throw new Error(`logical-agent handoff cannot target itself: ${handoff.toTaskId}`);
    }
    if (!(to.dependsOn ?? []).includes(handoff.fromTaskId)) {
      throw new Error(
        `logical-agent handoff source must be a dependency: ${handoff.fromTaskId} -> ${handoff.toTaskId}`,
      );
    }
    if (targets.has(handoff.toTaskId)) {
      throw new Error(`logical-agent task has multiple handoffs: ${handoff.toTaskId}`);
    }
    if (handoff.contextScope !== "dependency_results" || handoff.ownership !== "transferred") {
      throw new Error(
        `logical-agent handoff has unsupported transfer semantics: ${handoff.toTaskId}`,
      );
    }
    targets.add(handoff.toTaskId);
  }
  return handoffs.map((handoff) => Object.freeze({ ...handoff }));
}

function createLogicalAgentRunId(): string {
  return `logical-agent-run-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function checkpointForResults<TInput, TResult>(params: {
  runId: string;
  planFingerprint: string;
  tasks: readonly LogicalAgentTask<TInput>[];
  results: ReadonlyMap<string, LogicalAgentTaskResult<TResult>>;
  lastEventSequence: number;
}): LogicalAgentCheckpoint<TResult> {
  const completedTaskIds: string[] = [];
  const completedResults: LogicalAgentTaskResult<TResult>[] = [];
  for (const task of params.tasks) {
    const result = params.results.get(task.id);
    if (result?.status !== "completed") {
      continue;
    }
    completedTaskIds.push(task.id);
    completedResults.push(snapshotTaskResult(result));
  }
  return snapshotCheckpoint({
    schemaVersion: LOGICAL_AGENT_CHECKPOINT_SCHEMA_VERSION,
    runId: params.runId,
    planFingerprint: params.planFingerprint,
    completedTaskIds,
    results: completedResults,
    lastEventSequence: params.lastEventSequence,
  });
}

function restoreCheckpoint<TInput, TResult>(params: {
  checkpoint: LogicalAgentCheckpoint<TResult>;
  runId: string;
  planFingerprint: string;
  tasks: readonly LogicalAgentTask<TInput>[];
}): Map<string, LogicalAgentTaskResult<TResult>> {
  const { checkpoint } = params;
  if (checkpoint.schemaVersion !== LOGICAL_AGENT_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error("logical-agent checkpoint schema is incompatible");
  }
  if (checkpoint.runId !== params.runId) {
    throw new Error("logical-agent checkpoint runId mismatch; refuse to resume another run");
  }
  if (checkpoint.planFingerprint !== params.planFingerprint) {
    throw new Error("logical-agent checkpoint fingerprint mismatch; refuse to resume another plan");
  }
  const taskIds = new Set(params.tasks.map((task) => task.id));
  const completedIds = new Set<string>();
  const results = new Map<string, LogicalAgentTaskResult<TResult>>();
  for (const taskId of checkpoint.completedTaskIds) {
    if (!taskIds.has(taskId) || completedIds.has(taskId)) {
      throw new Error(`logical-agent checkpoint contains an invalid completed task: ${taskId}`);
    }
    completedIds.add(taskId);
  }
  for (const result of checkpoint.results) {
    if (!completedIds.has(result.taskId) || result.status !== "completed") {
      throw new Error(`logical-agent checkpoint contains an invalid result: ${result.taskId}`);
    }
    const task = params.tasks.find((candidate) => candidate.id === result.taskId);
    if (!task || task.agentId !== result.agentId) {
      throw new Error(`logical-agent checkpoint result does not match its task: ${result.taskId}`);
    }
    if (results.has(result.taskId)) {
      throw new Error(`logical-agent checkpoint contains duplicate result: ${result.taskId}`);
    }
    results.set(result.taskId, snapshotTaskResult(result));
  }
  if (results.size !== completedIds.size) {
    throw new Error("logical-agent checkpoint completed task/result indexes disagree");
  }
  for (const task of params.tasks) {
    if (!completedIds.has(task.id)) {
      continue;
    }
    for (const dependency of task.dependsOn ?? []) {
      if (!completedIds.has(dependency)) {
        throw new Error(
          `logical-agent checkpoint completed ${task.id} before dependency ${dependency}`,
        );
      }
    }
  }
  return results;
}

function blockedResult<TResult>(
  task: LogicalAgentTask<unknown>,
  modelId: string,
  dependencies: readonly string[],
): LogicalAgentTaskResult<TResult> {
  return {
    taskId: task.id,
    agentId: task.agentId,
    status: "blocked",
    modelId,
    completedAt: Date.now(),
    sideEffects: [],
    error: `blocked by dependency: ${dependencies.join(", ")}`,
  };
}

export async function runLogicalAgentPlan<TInput, TResult>(params: {
  tasks: readonly LogicalAgentTask<TInput>[];
  executor: LogicalAgentExecutor<TInput, TResult>;
  pool?: LogicalAgentPool<TInput, TResult>;
  finalTaskId?: string;
  runId?: string;
  eventSink?: LogicalAgentEventSink;
  checkpointStore?: LogicalAgentCheckpointStore<TResult>;
  resume?: boolean;
  handoffs?: readonly LogicalAgentHandoff[];
  sharedContext?: LogicalAgentSharedContext;
  signal?: AbortSignal;
}): Promise<LogicalAgentPlanResult<TResult>> {
  const tasks = params.tasks.map(snapshotTask);
  validatePlan(tasks);
  const finalTaskId = resolveFinalTaskId(tasks, params.finalTaskId);
  const pool = params.pool ?? new LogicalAgentPool<TInput, TResult>();
  const handoffs = validateHandoffs(tasks, params.handoffs ?? []);
  const sharedContext = cloneAndFreeze(params.sharedContext ?? {});
  const baseFingerprint = fingerprintLogicalAgentPlan(tasks, handoffs, finalTaskId, sharedContext);
  const planFingerprint = pool.modelRoutingFingerprint
    ? createHash("sha256")
        .update(`${baseFingerprint}:${pool.modelRoutingFingerprint}`)
        .digest("hex")
    : baseFingerprint;
  const runId = params.runId?.trim() || createLogicalAgentRunId();
  const events: LogicalAgentRunEvent[] = [];
  let eventSequence = 0;
  const emit = (
    kind: LogicalAgentRunEventKind,
    taskId?: string,
    payload?: Readonly<Record<string, unknown>>,
  ) => {
    const event = Object.freeze({
      schemaVersion: LOGICAL_AGENT_CHECKPOINT_SCHEMA_VERSION,
      eventId: `${runId}:${eventSequence + 1}`,
      runId,
      sequence: ++eventSequence,
      kind,
      ...(taskId === undefined ? {} : { taskId }),
      atMs: Date.now(),
      ...(payload === undefined ? {} : { payload }),
    }) satisfies LogicalAgentRunEvent;
    events.push(event);
    try {
      params.eventSink?.(event);
    } catch {
      // A passive observer cannot change execution truth or block recovery.
    }
  };

  if (params.resume && !params.checkpointStore) {
    throw new Error("logical-agent resume requires an injected checkpoint store");
  }
  if (params.resume && !params.runId?.trim()) {
    throw new Error("logical-agent resume requires an explicit runId");
  }

  const restoredCheckpoint = params.resume ? params.checkpointStore?.load(runId) : undefined;
  if (params.resume && !restoredCheckpoint) {
    throw new Error(`logical-agent checkpoint not found for runId: ${runId}`);
  }
  const restoredResults = params.resume
    ? restoreCheckpoint({
        checkpoint: restoredCheckpoint!,
        runId,
        planFingerprint,
        tasks,
      })
    : new Map<string, LogicalAgentTaskResult<TResult>>();
  if (params.resume) {
    pool.restoreCompletedModelCalls(runId, [...restoredResults.values()]);
    eventSequence = restoredCheckpoint?.lastEventSequence ?? 0;
    emit("run_resumed", undefined, {
      completedTaskCount: restoredResults.size,
      planFingerprint,
    });
  } else {
    emit("run_started", undefined, { taskCount: tasks.length, planFingerprint });
  }

  if (tasks.length === 0) {
    emit("run_completed", undefined, { status: "completed" });
    return {
      status: "completed",
      finalTaskId: null,
      tasks: [],
      pool: pool.status,
      runId,
      planFingerprint,
      resumed: Boolean(params.resume),
      events: Object.freeze([...events]),
      handoffs: Object.freeze(handoffs),
    };
  }

  type PlanState = "pending" | "queued" | "completed" | "failed" | "blocked";
  const state = new Map<string, PlanState>(
    tasks.map((task) => [task.id, restoredResults.has(task.id) ? "completed" : "pending"]),
  );
  const results = restoredResults;

  return new Promise((resolve, reject) => {
    let remaining = tasks.length - restoredResults.size;
    let finished = false;

    const saveCheckpoint = () => {
      if (!params.checkpointStore) {
        return;
      }
      const checkpoint = checkpointForResults({
        runId,
        planFingerprint,
        tasks,
        results,
        // Reserve the sequence used by checkpoint_saved before persisting.
        lastEventSequence: eventSequence + 1,
      });
      params.checkpointStore.save(checkpoint);
      emit("checkpoint_saved", undefined, {
        completedTaskCount: checkpoint.completedTaskIds.length,
        checkpointEventSequence: checkpoint.lastEventSequence,
      });
    };

    const finish = () => {
      if (remaining !== 0 || finished) {
        return;
      }
      finished = true;
      const orderedResults: Array<LogicalAgentTaskResult<TResult>> = [];
      for (const task of tasks) {
        const result = results.get(task.id);
        if (!result) {
          throw new Error("logical-agent plan finished without a result for every task");
        }
        orderedResults.push(result);
      }
      const hasFailure = orderedResults.some((result) => result.status === "failed");
      const hasBlocked = orderedResults.some((result) => result.status === "blocked");
      const status = hasFailure ? "failed" : hasBlocked ? "blocked" : "completed";
      emit("run_completed", undefined, { status });
      resolve({
        status,
        finalTaskId,
        tasks: orderedResults,
        pool: pool.status,
        runId,
        planFingerprint,
        resumed: Boolean(params.resume),
        events: Object.freeze([...events]),
        handoffs: Object.freeze(handoffs),
      });
    };

    const schedule = () => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of tasks) {
          if (state.get(task.id) !== "pending") {
            continue;
          }
          const dependencies = task.dependsOn ?? [];
          const failedDependencies = dependencies.filter((dependency) => {
            const dependencyStatus = state.get(dependency);
            return dependencyStatus === "failed" || dependencyStatus === "blocked";
          });
          if (failedDependencies.length > 0) {
            state.set(task.id, "blocked");
            const result = blockedResult<TResult>(task, pool.config.modelId, failedDependencies);
            results.set(task.id, result);
            emit("task_blocked", task.id, {
              agentId: task.agentId,
              dependencies: failedDependencies,
            });
            remaining -= 1;
            changed = true;
            continue;
          }
          if (!dependencies.every((dependency) => state.get(dependency) === "completed")) {
            continue;
          }
          const dependencyResults = Object.create(null) as Record<
            string,
            LogicalAgentTaskResult<TResult>
          >;
          for (const dependency of dependencies) {
            const result = results.get(dependency);
            if (!result) {
              throw new Error(`missing completed result for dependency ${dependency}`);
            }
            dependencyResults[dependency] = result;
          }
          for (const handoff of handoffs) {
            if (handoff.toTaskId === task.id) {
              emit("handoff", task.id, {
                fromTaskId: handoff.fromTaskId,
                contextScope: handoff.contextScope,
                ownership: handoff.ownership,
                ...(handoff.reason === undefined ? {} : { reason: handoff.reason }),
              });
            }
          }
          state.set(task.id, "queued");
          emit("task_dispatched", task.id, {
            agentId: task.agentId,
            dependsOn: dependencies,
          });
          changed = true;
          void pool
            .submit(task, params.executor, dependencyResults, sharedContext, runId, params.signal)
            .then((result) => {
              if (finished) {
                return;
              }
              try {
                state.set(task.id, result.status);
                results.set(task.id, result);
                emit(result.status === "completed" ? "task_completed" : "task_failed", task.id, {
                  agentId: task.agentId,
                  status: result.status,
                  ...(result.capabilityViolation === undefined
                    ? {}
                    : { capabilityViolation: result.capabilityViolation }),
                });
                remaining -= 1;
                if (result.status === "completed") {
                  saveCheckpoint();
                }
                schedule();
                finish();
              } catch (error: unknown) {
                finished = true;
                reject(error);
              }
            });
        }
      }
      finish();
    };

    schedule();
  });
}

function resolveFinalTaskId<TInput>(
  tasks: readonly LogicalAgentTask<TInput>[],
  requestedFinalTaskId?: string,
): string | null {
  const taskIds = new Set(tasks.map((task) => task.id));
  if (requestedFinalTaskId !== undefined) {
    if (!taskIds.has(requestedFinalTaskId)) {
      throw new Error(`final logical-agent task does not exist: ${requestedFinalTaskId}`);
    }
    return requestedFinalTaskId;
  }
  const referenced = new Set(tasks.flatMap((task) => task.dependsOn ?? []));
  const sinks = tasks.filter((task) => !referenced.has(task.id));
  return sinks.length === 1 ? sinks[0].id : null;
}

export function buildDefaultLogicalAgentPlan(input: LogicalAgentRequest): Array<LogicalAgentTask> {
  return [
    { id: "data_cleaning", agentId: "data_cleaning", input },
    {
      id: "financial_extraction",
      agentId: "financial_extraction",
      input,
      dependsOn: ["data_cleaning"],
    },
    {
      id: "news_classification",
      agentId: "news_classification",
      input,
      dependsOn: ["data_cleaning"],
    },
    {
      id: "evidence_integrity",
      agentId: "evidence_integrity",
      input,
      dependsOn: ["data_cleaning"],
    },
    {
      id: "risk_check",
      agentId: "risk_check",
      input,
      dependsOn: ["financial_extraction", "news_classification", "evidence_integrity"],
    },
    {
      id: "portfolio_exposure",
      agentId: "portfolio_exposure",
      input,
      dependsOn: ["financial_extraction", "evidence_integrity"],
    },
    {
      id: "research_draft",
      agentId: "research_draft",
      input,
      dependsOn: ["risk_check", "portfolio_exposure", "evidence_integrity", "news_classification"],
    },
    {
      id: "adversarial_challenge",
      agentId: "adversarial_challenge",
      input,
      dependsOn: ["research_draft"],
    },
    {
      id: "formatting",
      agentId: "formatting",
      input,
      dependsOn: ["research_draft", "adversarial_challenge"],
    },
    {
      id: "final_precheck",
      agentId: "final_precheck",
      input,
      dependsOn: ["formatting", "risk_check", "evidence_integrity"],
    },
  ];
}
