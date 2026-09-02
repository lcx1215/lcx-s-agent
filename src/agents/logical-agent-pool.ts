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

export type LogicalAgentDefinition = {
  id: LogicalAgentId;
  label: string;
  purpose: string;
  ontologyRole: LcxOntologyAgentRole;
  modelBinding: "shared_local_model";
};

export const LOGICAL_AGENT_DEFINITIONS: readonly LogicalAgentDefinition[] = [
  {
    id: "data_cleaning",
    label: "数据清洗 Agent",
    purpose: "整理输入、去重、标出缺失字段和未经验证的数字。",
    ontologyRole: "worker",
    modelBinding: "shared_local_model",
  },
  {
    id: "financial_extraction",
    label: "财报抽取 Agent",
    purpose: "从已提供材料中抽取公司、财务和时间字段，不补造数据。",
    ontologyRole: "specialist",
    modelBinding: "shared_local_model",
  },
  {
    id: "risk_check",
    label: "风险检查 Agent",
    purpose: "检查下行风险、约束条件、杠杆和需要补证的判断。",
    ontologyRole: "risk_gate",
    modelBinding: "shared_local_model",
  },
  {
    id: "adversarial_challenge",
    label: "反方挑战 Agent",
    purpose: "主动寻找反例、冲突证据和过度自信的结论。",
    ontologyRole: "evaluator",
    modelBinding: "shared_local_model",
  },
  {
    id: "news_classification",
    label: "新闻分类 Agent",
    purpose: "对输入新闻按主题、时效和影响方向分类，不替代来源核验。",
    ontologyRole: "specialist",
    modelBinding: "shared_local_model",
  },
  {
    id: "portfolio_exposure",
    label: "组合暴露计算 Agent",
    purpose: "整理持仓暴露、集中度和情景影响；缺少持仓字段时明确缺口。",
    ontologyRole: "specialist",
    modelBinding: "shared_local_model",
  },
  {
    id: "evidence_integrity",
    label: "证据完整性 Agent",
    purpose: "检查来源、时间戳、分母、单位和证据链是否足够。",
    ontologyRole: "evaluator",
    modelBinding: "shared_local_model",
  },
  {
    id: "research_draft",
    label: "研究草稿 Agent",
    purpose: "把前置结果组合成研究级草稿，保留正方、反方和不确定性。",
    ontologyRole: "coordinator",
    modelBinding: "shared_local_model",
  },
  {
    id: "formatting",
    label: "格式整理 Agent",
    purpose: "将草稿整理为清晰、短、可审阅的输出结构。",
    ontologyRole: "worker",
    modelBinding: "shared_local_model",
  },
  {
    id: "final_precheck",
    label: "最终本地预审 Agent",
    purpose: "在输出前检查直接交易指令、虚构当前数据和证据越权。",
    ontologyRole: "risk_gate",
    modelBinding: "shared_local_model",
  },
] as const satisfies readonly LogicalAgentDefinition[];

const ONTOLOGY_ROLE_SET = new Set<string>(LCX_ONTOLOGY_AGENT_ROLES);
for (const definition of LOGICAL_AGENT_DEFINITIONS) {
  if (!ONTOLOGY_ROLE_SET.has(definition.ontologyRole)) {
    throw new Error(`logical agent has an unknown ontology role: ${definition.ontologyRole}`);
  }
}

export type LocalModelPoolConfig = {
  modelId: string;
  maxLoadedModels: 1;
  maxConcurrency: 1 | 2;
  memoryBudgetMb: number;
};

export const DEFAULT_LOCAL_MODEL_POOL: LocalModelPoolConfig = {
  modelId: "Qwen/Qwen3-0.6B",
  maxLoadedModels: 1,
  maxConcurrency: 1,
  memoryBudgetMb: 3072,
};

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
  error?: string;
};

export type LogicalAgentExecutionContext<TInput, TResult> = {
  task: LogicalAgentTask<TInput>;
  agent: LogicalAgentDefinition;
  input: TInput;
  dependencyResults: Readonly<Record<string, LogicalAgentTaskResult<TResult>>>;
  modelPool: LocalModelPoolConfig;
};

export type LogicalAgentExecutor<TInput, TResult> = (
  context: LogicalAgentExecutionContext<TInput, TResult>,
) => TResult | Promise<TResult>;

export type LogicalAgentPoolStatus = {
  modelId: string;
  sharedModel: true;
  maxLoadedModels: 1;
  maxConcurrency: 1 | 2;
  memoryBudgetMb: number;
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
  const modelId = config?.modelId?.trim() || DEFAULT_LOCAL_MODEL_POOL.modelId;
  return { modelId, maxLoadedModels: 1, maxConcurrency, memoryBudgetMb };
}

export class LogicalAgentPool<TInput, TResult> {
  readonly config: LocalModelPoolConfig;
  #queue: Array<QueueJob<TInput, TResult>> = [];
  #activeRuns = 0;
  #maxObservedConcurrency = 0;

  constructor(config?: Partial<LocalModelPoolConfig>) {
    this.config = normalizePoolConfig(config);
  }

  get status(): LogicalAgentPoolStatus {
    return {
      modelId: this.config.modelId,
      sharedModel: true,
      maxLoadedModels: 1,
      maxConcurrency: this.config.maxConcurrency,
      memoryBudgetMb: this.config.memoryBudgetMb,
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
    return new Promise((resolve) => {
      this.#queue.push({ task, dependencyResults, executor, resolve });
      this.#pump();
    });
  }

  #pump() {
    while (this.#activeRuns < this.config.maxConcurrency && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (!job) {
        return;
      }
      this.#activeRuns += 1;
      this.#maxObservedConcurrency = Math.max(this.#maxObservedConcurrency, this.#activeRuns);
      const startedAt = Date.now();
      const agent = getLogicalAgentDefinition(job.task.agentId);
      void Promise.resolve()
        .then(() =>
          job.executor({
            task: job.task,
            agent,
            input: job.task.input,
            dependencyResults: job.dependencyResults,
            modelPool: this.config,
          }),
        )
        .then(
          (output): LogicalAgentTaskResult<TResult> => ({
            taskId: job.task.id,
            agentId: job.task.agentId,
            status: "completed",
            modelId: this.config.modelId,
            startedAt,
            completedAt: Date.now(),
            output,
          }),
          (error: unknown): LogicalAgentTaskResult<TResult> => ({
            taskId: job.task.id,
            agentId: job.task.agentId,
            status: "failed",
            modelId: this.config.modelId,
            startedAt,
            completedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((result) => {
          this.#activeRuns -= 1;
          this.#pump();
          job.resolve(result);
        });
    }
  }
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
    error: `blocked by dependency: ${dependencies.join(", ")}`,
  };
}

export async function runLogicalAgentPlan<TInput, TResult>(params: {
  tasks: readonly LogicalAgentTask<TInput>[];
  executor: LogicalAgentExecutor<TInput, TResult>;
  pool?: LogicalAgentPool<TInput, TResult>;
}): Promise<LogicalAgentPlanResult<TResult>> {
  validatePlan(params.tasks);
  const pool = params.pool ?? new LogicalAgentPool<TInput, TResult>();
  if (params.tasks.length === 0) {
    return { status: "completed", finalTaskId: null, tasks: [], pool: pool.status };
  }

  type PlanState = "pending" | "queued" | "completed" | "failed" | "blocked";
  const state = new Map<string, PlanState>(params.tasks.map((task) => [task.id, "pending"]));
  const results = new Map<string, LogicalAgentTaskResult<TResult>>();

  return new Promise((resolve) => {
    let remaining = params.tasks.length;
    let finished = false;

    const finish = () => {
      if (remaining !== 0 || finished) {
        return;
      }
      finished = true;
      const orderedResults: Array<LogicalAgentTaskResult<TResult>> = [];
      for (const task of params.tasks) {
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
        finalTaskId: params.tasks.at(-1)?.id ?? null,
        tasks: orderedResults,
        pool: pool.status,
      });
    };

    const schedule = () => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of params.tasks) {
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
