import {
  buildDefaultLogicalAgentPlan,
  LOGICAL_AGENT_DEFINITIONS,
  LogicalAgentPool,
  runLogicalAgentPlan,
} from "../../src/agents/logical-agent-pool.ts";

type Options = {
  ask: string;
  concurrency: 1 | 2;
  demo: boolean;
  json: boolean;
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
    json: false,
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
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-logical-agent-pool.ts [--json] [--demo] [--concurrency 1|2] [--ask TEXT]",
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function buildLogicalAgentPoolPayload(options: Options) {
  const pool = new LogicalAgentPool({ maxConcurrency: options.concurrency });
  const plan = buildDefaultLogicalAgentPlan({ ask: options.ask });
  const execution = options.demo
    ? await runLogicalAgentPlan({
        pool,
        tasks: plan,
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
    claims: {
      logicalAgentCount: 10,
      maxLoadedModelSlots: 1,
      defaultConcurrency: 1,
      maxConcurrency: 2,
      realModelInference: false,
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
      `模式：${options.demo ? "本地确定性 demo（不调用模型）" : "只输出编排计划"}`,
      `下一步：注入真实本地 executor 后才会执行模型推理。`,
    ].join("\n") + "\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
