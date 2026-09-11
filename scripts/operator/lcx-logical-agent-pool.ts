import type { LogicalAgentModelRouting } from "../../src/agents/logical-agent-model-router.ts";
import { createCanonicalStateRootLogicalAgentCheckpointStore } from "../../src/agents/logical-agent-pool-checkpoint-store.ts";
import {
  buildDefaultLogicalAgentPlan,
  LOGICAL_AGENT_DEFINITIONS,
  LogicalAgentPool,
  runLogicalAgentPlan,
} from "../../src/agents/logical-agent-pool.ts";
import {
  runQualityHarness,
  type QualityHarnessModelRequest,
  type QualityHarnessStageOutput,
} from "../../src/agents/quality-harness.ts";

type Options = {
  ask: string;
  concurrency: 1 | 2;
  demo: boolean;
  qualityDemo: boolean;
  json: boolean;
  persistCheckpoint: boolean;
  resume: boolean;
  runId?: string;
};

function parsePositiveConcurrency(value: string): 1 | 2 {
  const parsed = Number(value);
  if (parsed !== 1 && parsed !== 2) {
    throw new Error("--concurrency must be 1 or 2");
  }
  return parsed;
}

function parseArgs(args: readonly string[]): Options {
  const options: Options = {
    ask: "生成一份研究级风险审阅包",
    concurrency: 1,
    demo: false,
    qualityDemo: false,
    json: false,
    persistCheckpoint: false,
    resume: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ask") {
      const value = args[index + 1];
      if (!value?.trim()) {
        throw new Error("--ask requires a non-empty value");
      }
      options.ask = value;
      index += 1;
    } else if (arg === "--concurrency") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--concurrency requires a value");
      }
      options.concurrency = parsePositiveConcurrency(value);
      index += 1;
    } else if (arg === "--demo") {
      options.demo = true;
    } else if (arg === "--quality-demo") {
      options.qualityDemo = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--persist-checkpoint") {
      options.persistCheckpoint = true;
    } else if (arg === "--resume") {
      options.resume = true;
      options.persistCheckpoint = true;
    } else if (arg === "--run-id") {
      const value = args[index + 1];
      if (!value?.trim()) {
        throw new Error("--run-id requires a non-empty value");
      }
      options.runId = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-logical-agent-pool.ts [--json] [--demo] [--quality-demo] [--persist-checkpoint] [--resume --run-id ID] [--concurrency 1|2] [--ask TEXT]",
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.resume && !options.demo) {
    throw new Error("--resume requires --demo so the persisted plan can be replayed safely");
  }
  if (options.resume && !options.runId) {
    throw new Error("--resume requires --run-id");
  }
  return options;
}

function qualityDemoResponse(request: QualityHarnessModelRequest): QualityHarnessStageOutput {
  if (request.stage === "intake") {
    return { kind: "plan", requirements: ["answer with evidence"], missingEvidence: [] };
  }
  if (request.stage === "draft" || request.stage === "format") {
    return {
      kind: "artifact",
      artifact: {
        answer: "确定性 demo 输出：保留已给材料边界。",
        claims: [
          {
            id: "demo-claim",
            text: "demo evidence supports a bounded claim.",
            status: "supported",
            evidenceIds: ["demo-evidence"],
          },
        ],
      },
    };
  }
  return {
    kind: "review",
    review: { verdict: "pass", criticalFindings: [], evidenceGaps: [], notes: [] },
  };
}

function qualityDemoRouting(): LogicalAgentModelRouting {
  return {
    revision: "operator-quality-demo-v1",
    adapters: [
      {
        id: "deterministic-quality-demo",
        provider: "local-deterministic-demo",
        modelId: "deterministic-demo-model",
        mode: "deterministic",
        capabilities: ["quality_harness"],
        requiredTools: [],
        requiredSideEffects: ["local_compute"],
        invoke: async ({ payload }) => qualityDemoResponse(payload as QualityHarnessModelRequest),
      },
    ],
    defaultPolicy: {
      primary: "deterministic-quality-demo",
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: 256_000,
      timeoutMs: 1_000,
    },
  };
}

export async function buildLogicalAgentPoolPayload(options: Options) {
  const pool = new LogicalAgentPool({ maxConcurrency: options.concurrency });
  const plan = buildDefaultLogicalAgentPlan({ ask: options.ask });
  const checkpointStore = options.persistCheckpoint
    ? createCanonicalStateRootLogicalAgentCheckpointStore<unknown>()
    : undefined;
  const execution = options.demo
    ? await runLogicalAgentPlan({
        pool,
        tasks: plan,
        ...(checkpointStore === undefined ? {} : { checkpointStore }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.resume ? { resume: true } : {}),
        executor: ({ task, dependencyResults }) => ({
          output: {
            taskId: task.id,
            dependencyCount: Object.keys(dependencyResults).length,
            execution: "deterministic_demo_only",
          },
          sideEffects: [],
        }),
      })
    : null;
  const qualityHarness = options.qualityDemo
    ? await runQualityHarness({
        request: {
          task: options.ask,
          evidence: [{ id: "demo-evidence", text: "deterministic operator demo evidence" }],
        },
        modelId: "deterministic-demo-model",
        maxConcurrency: options.concurrency,
        maxAttempts: 1,
        modelRouting: qualityDemoRouting(),
        verify: async () => ({
          status: "passed",
          summary: "deterministic local verifier passed",
          details: [],
        }),
        createRunId: () => "logical-agent-quality-demo",
      })
    : null;
  return {
    boundary: "local_logical_agent_pool_only",
    modelPool: {
      ...pool.status,
      executionBackend: "injected_local_executor",
      providerCallsMade: false,
      externalSideEffects: false,
    },
    agents: LOGICAL_AGENT_DEFINITIONS,
    plan: plan.map(({ id, agentId, dependsOn }) => ({ id, agentId, dependsOn: dependsOn ?? [] })),
    execution,
    qualityHarness,
    claims: {
      logicalAgentCount: 10,
      maxLoadedModelSlots: 1,
      defaultConcurrency: 1,
      maxConcurrency: 2,
      realModelInference: false,
      qualityHarness: options.qualityDemo,
      checkpointPersistence: options.persistCheckpoint
        ? "active_state_root_file"
        : "injected_store_only",
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildLogicalAgentPoolPayload(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `10 个逻辑 Agent / 1 个共享模型槽位 / 并发上限 ${options.concurrency}`,
      `模式：${options.qualityDemo ? "质量闭环 demo（role router + 确定性 adapter，不调用真实模型）" : options.demo ? "本地确定性 demo（不调用真实模型）" : "只输出编排计划"}`,
      `checkpoint：${options.persistCheckpoint ? "已接入活动 state-root 文件持久化" : "未启用（使用 --persist-checkpoint）"}`,
      `下一步：注入真实本地 modelInvoker 后才会执行模型推理；receipt 仍需真实 verifier 才能标 verified。`,
    ].join("\n") + "\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
