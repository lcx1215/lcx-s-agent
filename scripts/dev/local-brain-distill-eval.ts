import { spawn } from "node:child_process";
import path from "node:path";
import { hardenLocalBrainPlanForAsk } from "./local-brain-contracts.js";

type CliOptions = {
  model: string;
  adapterPath?: string;
  pythonBin: string;
  json: boolean;
  noAdapter: boolean;
  hardened: boolean;
  progress: boolean;
  summaryOnly: boolean;
  timeoutMs: number;
};

const REQUIRED_KEYS = [
  "task_family",
  "primary_modules",
  "supporting_modules",
  "required_tools",
  "missing_data",
  "risk_boundaries",
  "next_step",
  "rejected_context",
] as const;

const REQUIRED_FINANCE_MODULES = [
  "macro_rates_inflation",
  "credit_liquidity",
  "etf_regime",
  "company_fundamentals_value",
  "portfolio_risk_gates",
];

const MODULE_TAXONOMY = [
  "macro_rates_inflation",
  "credit_liquidity",
  "etf_regime",
  "company_fundamentals_value",
  "quant_math",
  "portfolio_risk_gates",
  "causal_map",
  "finance_learning_memory",
  "source_registry",
  "review_panel",
  "control_room_summary",
  "ops_audit",
];

const CONTRACT_HINTS = [
  "If source URL or local file is missing, include source_registry and missing_data source_url_or_local_source_path.",
  "If portfolio math inputs are missing, include missing_data position_weights_and_return_series exactly.",
  "If a company risk can affect a portfolio or ETF sleeve, include portfolio_risk_gates.",
  "If the user asks to use local memory, learned rules, receipts, or prior knowledge, include finance_learning_memory, source_registry, causal_map, review_panel, and memory_recall_scope_or_relevant_receipts.",
];

type EvalCase = {
  id: string;
  userAsk: string;
  sourceSummary: string;
  requiredModules: string[];
  forbiddenModules?: string[];
  minModuleMatches: number;
  requiredMissingData?: string[];
};

const DEFAULT_PYTHON = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  ".venv",
  "bin",
  "python",
);

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/local-brain-distill-eval.ts (--adapter PATH | --no-adapter) [--model MODEL] [--python BIN] [--json] [--summary-only] [--progress] [--timeout-ms N]",
      "",
      "Runs one local inference acceptance check for the auxiliary thought-flow adapter.",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    model: "Qwen/Qwen3-0.6B",
    pythonBin: DEFAULT_PYTHON,
    json: false,
    noAdapter: false,
    hardened: false,
    progress: false,
    summaryOnly: false,
    timeoutMs: 180_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      options.model = readValue(args, index);
      index += 1;
    } else if (arg === "--adapter") {
      options.adapterPath = readValue(args, index);
      index += 1;
    } else if (arg === "--no-adapter") {
      options.noAdapter = true;
    } else if (arg === "--python") {
      options.pythonBin = readValue(args, index);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--hardened") {
      options.hardened = true;
    } else if (arg === "--progress") {
      options.progress = true;
    } else if (arg === "--summary-only") {
      options.summaryOnly = true;
    } else if (arg === "--timeout-ms") {
      const rawValue = readValue(args, index);
      const timeoutMs = Number(rawValue);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        usage();
      }
      options.timeoutMs = timeoutMs;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (!options.noAdapter && !options.adapterPath) {
    usage();
  }
  if (options.noAdapter && options.adapterPath) {
    usage();
  }
  if (options.adapterPath) {
    options.adapterPath = path.resolve(options.adapterPath);
  }
  return options;
}

const EVAL_CASES: EvalCase[] = [
  {
    id: "portfolio_mixed_q_t_nvda",
    userAsk:
      "我持有QQQ、TLT和少量NVDA，未来两周担心利率、AI capex、美元流动性。请先规划内部模块，不要给交易建议。",
    sourceSummary: "clean_context_eval_no_old_lark_history",
    requiredModules: REQUIRED_FINANCE_MODULES,
    minModuleMatches: 3,
  },
  {
    id: "unseen_etf_timing_framework",
    userAsk:
      "我想做一个低频ETF择时研究框架，先拆内部能力：宏观、流动性、ETF状态、数学验证、风险门都要考虑。",
    sourceSummary: "unseen adjacent ETF timing planning request; no live data supplied.",
    requiredModules: [
      "macro_rates_inflation",
      "credit_liquidity",
      "etf_regime",
      "quant_math",
      "portfolio_risk_gates",
    ],
    minModuleMatches: 4,
  },
  {
    id: "ambiguous_repeat_no_old_context",
    userAsk: "重新来一遍。",
    sourceSummary: "ambiguous repeat request with no current subject and old Lark context cleared.",
    requiredModules: [],
    forbiddenModules: REQUIRED_FINANCE_MODULES,
    minModuleMatches: 0,
    requiredMissingData: ["current_subject_or_original_request"],
  },
  {
    id: "portfolio_math_without_guessing",
    userAsk:
      "我有 QQQ、TLT、NVDA 三个仓位，想算波动、相关性、回撤和利率敏感性，但我还没给权重和价格序列。先拆模块，不要靠模型胡算。",
    sourceSummary:
      "fresh adjacent quant math planning request with missing weights and return series.",
    requiredModules: ["quant_math", "portfolio_risk_gates", "etf_regime", "macro_rates_inflation"],
    minModuleMatches: 3,
    requiredMissingData: ["position_weights_and_return_series"],
  },
  {
    id: "external_source_missing_url",
    userAsk: "去学习这篇金融论文并沉淀成规则，但我还没给链接或本地文件。",
    sourceSummary: "external learning request missing source path.",
    requiredModules: ["finance_learning_memory", "source_registry"],
    forbiddenModules: REQUIRED_FINANCE_MODULES,
    minModuleMatches: 2,
    requiredMissingData: ["source_url_or_local_source_path"],
  },
  {
    id: "single_company_fundamental_risk",
    userAsk:
      "只研究 NVDA 基本面风险：AI capex、收入质量、估值、客户集中度、对科技仓的传导，不要给买卖建议。",
    sourceSummary: "single-company fundamental risk planning request without fresh filing data.",
    requiredModules: ["company_fundamentals_value", "causal_map", "portfolio_risk_gates"],
    minModuleMatches: 3,
  },
  {
    id: "lark_context_pollution_audit",
    userAsk: "它刚才又像串到旧任务了，先审计是不是 Lark 上下文污染，不要继续金融分析。",
    sourceSummary: "ops audit request, explicitly not a finance research request.",
    requiredModules: ["ops_audit"],
    forbiddenModules: REQUIRED_FINANCE_MODULES,
    minModuleMatches: 1,
  },
  {
    id: "local_memory_knowledge_activation",
    userAsk:
      "这是一个复杂研究任务：我持有 QQQ、TLT、NVDA，还担心利率、美元流动性和 AI capex。先动用本地记忆、已学规则和历史沉淀，拆成可执行的内部分析步骤，再交给大模型审阅；不要直接给交易建议。",
    sourceSummary:
      "complex local-brain task requiring memory recall, learned-rule activation, finance module fanout, and model review handoff.",
    requiredModules: [
      "macro_rates_inflation",
      "credit_liquidity",
      "etf_regime",
      "company_fundamentals_value",
      "finance_learning_memory",
      "source_registry",
      "causal_map",
      "portfolio_risk_gates",
      "review_panel",
      "control_room_summary",
    ],
    minModuleMatches: 8,
    requiredMissingData: ["memory_recall_scope_or_relevant_receipts"],
  },
];

function buildPrompt(evalCase: EvalCase): string {
  return [
    "You are the LCX Agent local auxiliary thought-flow model.",
    "Task: produce a concise control-room planning packet for the main agent.",
    "Do not answer the user's finance question directly.",
    "Do not invent live data, execution approval, or durable memory writes.",
    `Allowed module ids: ${MODULE_TAXONOMY.join(", ")}.`,
    "For finance tasks, choose concrete module ids from the allowed list instead of generic finance labels.",
    `Planning contract hints: ${CONTRACT_HINTS.join(" ")}`,
    "Return only JSON with keys: task_family, primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, next_step, rejected_context.",
    "",
    "source_kind: clean_eval",
    `user_or_task: ${evalCase.userAsk}`,
    `source_summary: ${evalCase.sourceSummary}`,
  ].join("\n");
}

function runGenerate(options: CliOptions, evalCase: EvalCase): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      "mlx_lm",
      "generate",
      "--model",
      options.model,
      "--prompt",
      buildPrompt(evalCase),
      "--max-tokens",
      "800",
      "--temp",
      "0",
      "--verbose",
      "false",
    ];
    if (options.adapterPath) {
      args.splice(5, 0, "--adapter-path", options.adapterPath);
    }
    const child = spawn(options.pythonBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`mlx_lm generate timed out after ${options.timeoutMs}ms for ${evalCase.id}`),
      );
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`mlx_lm generate exited ${code}\n${stderr}`));
      }
    });
  });
}

function extractJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`no JSON object found in model output: ${raw.slice(0, 240)}`);
  }
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function evaluate(
  output: Record<string, unknown>,
  evalCase: EvalCase,
): {
  ok: boolean;
  missingKeys: string[];
  matchedFinanceModules: string[];
  missingFinanceModules: string[];
  forbiddenModuleMatches: string[];
  missingRequiredData: string[];
  boundaryOk: boolean;
  oldContextRejected: boolean;
} {
  const missingKeys = REQUIRED_KEYS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(output, key),
  );
  const modules = new Set([
    ...asStringArray(output.primary_modules),
    ...asStringArray(output.supporting_modules),
    ...asStringArray(output.required_tools),
  ]);
  const matchedFinanceModules = evalCase.requiredModules.filter((module) => modules.has(module));
  const missingFinanceModules = evalCase.requiredModules.filter((module) => !modules.has(module));
  const forbiddenModuleMatches = (evalCase.forbiddenModules ?? []).filter((module) =>
    modules.has(module),
  );
  const missingData = asStringArray(output.missing_data);
  const missingRequiredData = (evalCase.requiredMissingData ?? []).filter(
    (entry) => !missingData.includes(entry),
  );
  const riskBoundaries = asStringArray(output.risk_boundaries);
  const rejectedContext = asStringArray(output.rejected_context);
  const boundaryOk =
    riskBoundaries.includes("research_only") || riskBoundaries.includes("no_execution_authority");
  const oldContextRejected = rejectedContext.includes("old_lark_conversation_history");
  return {
    ok:
      missingKeys.length === 0 &&
      boundaryOk &&
      oldContextRejected &&
      matchedFinanceModules.length >= evalCase.minModuleMatches &&
      forbiddenModuleMatches.length === 0 &&
      missingRequiredData.length === 0,
    missingKeys,
    matchedFinanceModules,
    missingFinanceModules,
    forbiddenModuleMatches,
    missingRequiredData,
    boundaryOk,
    oldContextRejected,
  };
}

function parseFailureAcceptance(error: unknown): ReturnType<typeof evaluate> {
  return {
    ok: false,
    missingKeys: [...REQUIRED_KEYS],
    matchedFinanceModules: [],
    missingFinanceModules: [],
    forbiddenModuleMatches: [],
    missingRequiredData: [],
    boundaryOk: false,
    oldContextRejected: false,
    parseError: String(error),
  } as ReturnType<typeof evaluate> & { parseError: string };
}

const options = parseArgs(process.argv.slice(2));
const caseResults = [];
for (const evalCase of EVAL_CASES) {
  if (options.progress) {
    process.stderr.write(`[local-brain-eval] start ${evalCase.id}\n`);
  }
  const rawOutput = await runGenerate(options, evalCase);
  try {
    const rawParsed = extractJson(rawOutput);
    const parsed = options.hardened
      ? hardenLocalBrainPlanForAsk(rawParsed, {
          ask: evalCase.userAsk,
          sourceSummary: evalCase.sourceSummary,
        })
      : rawParsed;
    caseResults.push({
      id: evalCase.id,
      rawOutput,
      parsed,
      acceptance: evaluate(parsed, evalCase),
    });
    if (options.progress) {
      process.stderr.write(
        `[local-brain-eval] done ${evalCase.id} ok=${caseResults.at(-1)?.acceptance.ok ? "true" : "false"}\n`,
      );
    }
  } catch (error) {
    const fallbackParsed = options.hardened
      ? hardenLocalBrainPlanForAsk(
          {},
          {
            ask: evalCase.userAsk,
            sourceSummary: evalCase.sourceSummary,
          },
        )
      : null;
    caseResults.push({
      id: evalCase.id,
      rawOutput,
      parsed: fallbackParsed,
      acceptance: fallbackParsed
        ? evaluate(fallbackParsed, evalCase)
        : parseFailureAcceptance(error),
      parseError: String(error),
    });
    if (options.progress) {
      process.stderr.write(
        `[local-brain-eval] done ${evalCase.id} ok=${caseResults.at(-1)?.acceptance.ok ? "true" : "false"} parseError=true\n`,
      );
    }
  }
}
const passedCases = caseResults.filter((entry) => entry.acceptance.ok);
const failedCases = caseResults.filter((entry) => !entry.acceptance.ok);
const result = {
  ok: failedCases.length === 0,
  boundary: "local_auxiliary_thought_flow_only",
  model: options.model,
  adapterPath: options.adapterPath ?? null,
  noAdapter: options.noAdapter,
  hardened: options.hardened,
  summary: {
    passed: passedCases.length,
    total: caseResults.length,
    passRate: Number((passedCases.length / caseResults.length).toFixed(3)),
    failedCaseIds: failedCases.map((entry) => entry.id),
    promotionReady: failedCases.length === 0,
  },
  cases: options.summaryOnly ? undefined : caseResults,
};

process.stdout.write(
  options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `local brain adapter eval ${result.ok ? "passed" : "failed"} passed=${passedCases.length}/${caseResults.length}\n`,
);
process.exitCode = result.ok ? 0 : 1;
