import { LCX_ONTOLOGY_AGENT_ROLES, type LcxOntologyAgentRole } from "../shared/lcx-ontology.js";

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

export const LOGICAL_AGENT_LOCAL_CAPABILITIES: LogicalAgentCapabilities = Object.freeze({
  allowedTools: Object.freeze(["local_model_inference"] as const),
  allowedSideEffects: Object.freeze(["local_read", "local_compute", "local_output"] as const),
  forbiddenSideEffects: Object.freeze([
    "provider_call",
    "external_message",
    "protected_memory_write",
    "trading_action",
  ] as const),
});

export type LogicalAgentDefinition = {
  id: LogicalAgentId;
  label: string;
  purpose: string;
  ontologyRole: LcxOntologyAgentRole;
  modelBinding: "shared_local_model";
  capabilities: LogicalAgentCapabilities;
};

export const LOGICAL_AGENT_DEFINITIONS: readonly LogicalAgentDefinition[] = [
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

const ONTOLOGY_ROLE_SET = new Set<string>(LCX_ONTOLOGY_AGENT_ROLES);
for (const definition of LOGICAL_AGENT_DEFINITIONS) {
  if (!ONTOLOGY_ROLE_SET.has(definition.ontologyRole)) {
    throw new Error(`logical agent has an unknown ontology role: ${definition.ontologyRole}`);
  }
}

export type LocalModelPoolConfig = Readonly<{
  modelId: string;
  maxLoadedModels: 1;
  maxConcurrency: 1 | 2;
  memoryBudgetMb: number;
  taskTimeoutMs: number;
}>;

export const DEFAULT_LOCAL_MODEL_POOL: LocalModelPoolConfig = Object.freeze({
  modelId: "Qwen/Qwen3-0.6B",
  maxLoadedModels: 1,
  maxConcurrency: 1,
  memoryBudgetMb: 3072,
  taskTimeoutMs: 30_000,
});

export type LogicalAgentRequest = {
  ask: string;
  evidence?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
};

export type LogicalAgentTask<TInput = LogicalAgentRequest> = {
  id: string;
  agentId: LogicalAgentId;
  input: TInput;
  dependsOn?: readonly string[];
};

export type LogicalAgentTaskStatus = "queued" | "running" | "completed" | "failed" | "blocked";

export type LogicalAgentTaskResult<TResult = unknown> = {
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
};

export type LogicalAgentExecutionContext<TInput, TResult> = {
  task: LogicalAgentTask<TInput>;
  agent: LogicalAgentDefinition;
  input: TInput;
  dependencyResults: Readonly<Record<string, LogicalAgentTaskResult<TResult>>>;
  modelPool: LocalModelPoolConfig;
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
  sharedModel: true;
  maxLoadedModels: 1;
  maxConcurrency: 1 | 2;
  memoryBudgetMb: number;
  taskTimeoutMs: number;
  queuedRuns: number;
  activeRuns: number;
  maxObservedConcurrency: number;
};

export type LogicalAgentPlanResult<TResult> = {
  status: "completed" | "failed" | "blocked";
  finalTaskId: string | null;
  tasks: Array<LogicalAgentTaskResult<TResult>>;
  pool: LogicalAgentPoolStatus;
};

type QueueJob<TInput, TResult> = {
  task: LogicalAgentTask<TInput>;
  dependencyResults: Readonly<Record<string, LogicalAgentTaskResult<TResult>>>;
  executor: LogicalAgentExecutor<TInput, TResult>;
  resolve: (result: LogicalAgentTaskResult<TResult>) => void;
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
  const modelId = config?.modelId?.trim() || DEFAULT_LOCAL_MODEL_POOL.modelId;
  return Object.freeze({
    modelId,
    maxLoadedModels: 1,
    maxConcurrency,
    memoryBudgetMb,
    taskTimeoutMs,
  });
}

export class LogicalAgentPool<TInput, TResult> {
  #config: LocalModelPoolConfig;
  #queue: Array<QueueJob<TInput, TResult>> = [];
  #activeRuns = 0;
  #maxObservedConcurrency = 0;

  constructor(config?: Partial<LocalModelPoolConfig>) {
    this.#config = normalizePoolConfig(config);
  }

  get config(): LocalModelPoolConfig {
    return this.#config;
  }

  get status(): LogicalAgentPoolStatus {
    return {
      modelId: this.#config.modelId,
      sharedModel: true,
      maxLoadedModels: 1,
      maxConcurrency: this.#config.maxConcurrency,
      memoryBudgetMb: this.#config.memoryBudgetMb,
      taskTimeoutMs: this.#config.taskTimeoutMs,
      queuedRuns: this.#queue.length,
      activeRuns: this.#activeRuns,
      maxObservedConcurrency: this.#maxObservedConcurrency,
    };
  }

  submit(
    task: LogicalAgentTask<TInput>,
    executor: LogicalAgentExecutor<TInput, TResult>,
    dependencyResults: Readonly<Record<string, LogicalAgentTaskResult<TResult>>> = {},
  ): Promise<LogicalAgentTaskResult<TResult>> {
    getLogicalAgentDefinition(task.agentId);
    const taskSnapshot = snapshotTask(task);
    const dependencySnapshot = Object.freeze({ ...dependencyResults });
    return new Promise((resolve) => {
      this.#queue.push({
        task: taskSnapshot,
        dependencyResults: dependencySnapshot,
        executor,
        resolve,
      });
      this.#pump();
    });
  }

  #pump() {
    while (this.#activeRuns < this.#config.maxConcurrency && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (!job) {
        return;
      }
      this.#activeRuns += 1;
      this.#maxObservedConcurrency = Math.max(this.#maxObservedConcurrency, this.#activeRuns);
      const startedAt = Date.now();
      const agent = getLogicalAgentDefinition(job.task.agentId);
      void executeWithTimeout(
        (signal) =>
          job.executor({
            task: job.task,
            agent,
            input: job.task.input,
            dependencyResults: job.dependencyResults,
            modelPool: this.#config,
            capabilities: agent.capabilities,
            signal,
          }),
        this.#config.taskTimeoutMs,
      )
        .then(
          (execution): LogicalAgentTaskResult<TResult> => {
            try {
              const normalized = normalizeExecutionResult<TResult>(execution, agent.capabilities);
              return {
                taskId: job.task.id,
                agentId: job.task.agentId,
                status: "completed",
                modelId: this.#config.modelId,
                startedAt,
                completedAt: Date.now(),
                output: normalized.output,
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
          this.#activeRuns -= 1;
          this.#pump();
          job.resolve(result);
        });
    }
  }
}

function snapshotTask<TInput>(task: LogicalAgentTask<TInput>): LogicalAgentTask<TInput> {
  return Object.freeze({
    ...task,
    dependsOn: task.dependsOn === undefined ? undefined : Object.freeze([...task.dependsOn]),
  });
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

function failedTaskResult<TResult>(
  task: LogicalAgentTask<unknown>,
  modelId: string,
  startedAt: number,
  error: unknown,
): LogicalAgentTaskResult<TResult> {
  return {
    taskId: task.id,
    agentId: task.agentId,
    status: "failed",
    modelId,
    startedAt,
    completedAt: Date.now(),
    sideEffects: error instanceof LogicalAgentCapabilityError ? error.sideEffects : [],
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof LogicalAgentCapabilityError ? { capabilityViolation: error.message } : {}),
  };
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
): Promise<TResult> {
  const controller = new AbortController();
  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      controller.abort();
      if (!settled) {
        settled = true;
        reject(new Error(`logical-agent task timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    void Promise.resolve()
      .then(() => executor(controller.signal))
      .then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
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
}): Promise<LogicalAgentPlanResult<TResult>> {
  const tasks = params.tasks.map(snapshotTask);
  validatePlan(tasks);
  const finalTaskId = resolveFinalTaskId(tasks, params.finalTaskId);
  const pool = params.pool ?? new LogicalAgentPool<TInput, TResult>();
  if (tasks.length === 0) {
    return { status: "completed", finalTaskId: null, tasks: [], pool: pool.status };
  }

  type PlanState = "pending" | "queued" | "completed" | "failed" | "blocked";
  const state = new Map<string, PlanState>(tasks.map((task) => [task.id, "pending"]));
  const results = new Map<string, LogicalAgentTaskResult<TResult>>();

  return new Promise((resolve) => {
    let remaining = tasks.length;
    let finished = false;

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
      resolve({
        status: hasFailure ? "failed" : hasBlocked ? "blocked" : "completed",
        finalTaskId,
        tasks: orderedResults,
        pool: pool.status,
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
            results.set(task.id, blockedResult(task, pool.config.modelId, failedDependencies));
            remaining -= 1;
            changed = true;
            continue;
          }
          if (!dependencies.every((dependency) => state.get(dependency) === "completed")) {
            continue;
          }
          const dependencyResults: Record<string, LogicalAgentTaskResult<TResult>> = {};
          for (const dependency of dependencies) {
            const result = results.get(dependency);
            if (!result) {
              throw new Error(`missing completed result for dependency ${dependency}`);
            }
            dependencyResults[dependency] = result;
          }
          state.set(task.id, "queued");
          changed = true;
          void pool.submit(task, params.executor, dependencyResults).then((result) => {
            state.set(task.id, result.status);
            results.set(task.id, result);
            remaining -= 1;
            schedule();
            finish();
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
