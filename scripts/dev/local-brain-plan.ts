import { spawn } from "node:child_process";
import path from "node:path";
import { hardenLocalBrainPlanForAsk } from "./local-brain-contracts.js";
import { LOCAL_BRAIN_CONTRACT_HINTS, LOCAL_BRAIN_MODULE_TAXONOMY } from "./local-brain-taxonomy.js";

type CliOptions = {
  ask: string;
  sourceSummary: string;
  model: string;
  adapterPath: string;
  pythonBin: string;
  json: boolean;
};

const DEFAULT_PYTHON = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  ".venv",
  "bin",
  "python",
);

const DEFAULT_ADAPTER = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  "adapters",
  "thought-flow-v1-qwen3-0.6b-taxonomy-v3",
);

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/local-brain-plan.ts --ask TEXT [--source-summary TEXT] [--json]",
      "",
      "Runs the accepted local auxiliary thought-flow adapter as a read-only planner.",
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
    ask: "",
    sourceSummary: "manual_cli_planning_request_no_live_side_effects",
    model: "Qwen/Qwen3-0.6B",
    adapterPath: DEFAULT_ADAPTER,
    pythonBin: DEFAULT_PYTHON,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ask") {
      options.ask = readValue(args, index);
      index += 1;
    } else if (arg === "--source-summary") {
      options.sourceSummary = readValue(args, index);
      index += 1;
    } else if (arg === "--model") {
      options.model = readValue(args, index);
      index += 1;
    } else if (arg === "--adapter") {
      options.adapterPath = readValue(args, index);
      index += 1;
    } else if (arg === "--python") {
      options.pythonBin = readValue(args, index);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (!options.ask.trim()) {
    usage();
  }
  options.adapterPath = path.resolve(options.adapterPath);
  return options;
}

function buildPrompt(options: CliOptions): string {
  return [
    "You are the LCX Agent local auxiliary thought-flow model.",
    "Task: produce a concise control-room planning packet for the main agent.",
    "Do not answer the user's finance question directly.",
    "Do not invent live data, execution approval, or durable memory writes.",
    `Allowed module ids: ${LOCAL_BRAIN_MODULE_TAXONOMY.join(", ")}.`,
    "For finance tasks, choose concrete module ids from the allowed list instead of generic finance labels.",
    `Planning contract hints: ${LOCAL_BRAIN_CONTRACT_HINTS.join(" ")}`,
    "Return only JSON with keys: task_family, primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, next_step, rejected_context.",
    "",
    "source_kind: local_cli_planning",
    `user_or_task: ${options.ask}`,
    `source_summary: ${options.sourceSummary}`,
  ].join("\n");
}

function runGenerate(options: CliOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.pythonBin,
      [
        "-m",
        "mlx_lm",
        "generate",
        "--model",
        options.model,
        "--adapter-path",
        options.adapterPath,
        "--prompt",
        buildPrompt(options),
        "--max-tokens",
        "800",
        "--temp",
        "0",
        "--verbose",
        "false",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
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
    throw new Error(`no JSON object found in local brain output: ${raw.slice(0, 240)}`);
  }
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function planRiskBoundaryValue(value: unknown): string[] {
  return arrayValue(value).filter(
    (item) => !["language_routing_only", "language_routing_required"].includes(item),
  );
}

function mergeUnique(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of groups.flat()) {
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function looksLikeExternalCoveragePlanningAsk(text: string): boolean {
  return (
    /(google scholar|scholar|ssrn|nber|arxiv|working paper|preprint|literature review|公开课程|顶级大学|高校|syllabus|论文|paper)/iu.test(
      text,
    ) &&
    /(覆盖|coverage|sample limits?|sampling limits?|实际读过|读过哪些|what was actually read|不要说全覆盖|别说全覆盖|未覆盖范围|source limits?|全覆盖|完整覆盖|exhaustive|comprehensive)/iu.test(
      text,
    )
  );
}

function looksLikeExternalMissingSourceAsk(text: string): boolean {
  const asksToLearnSource =
    /(学习|learn|读|吸收|沉淀|论文|paper|网页|article|source|url|链接|本地文件|local file)/iu.test(
      text,
    );
  const namesSourceObject = /(论文|paper|网页|article|source|url|链接|本地文件|local file)/iu.test(
    text,
  );
  const sourceIsAbsent =
    /(没给|没有给|还没给|未提供|缺少|missing|without|no)\s*(?:url|link|source|local file|paper|article)/iu.test(
      text,
    ) ||
    /(没给|没有给|还没给|未提供|缺少).{0,12}(链接|网址|来源|源文件|本地文件|论文|文章)/iu.test(
      text,
    );
  return asksToLearnSource && namesSourceObject && sourceIsAbsent;
}

function looksLikeAmbiguousRepeatOnlyPlanningAsk(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return /^(重新来一遍|重来一遍|再来一遍|从头来|从头开始|redo|restart|again)[。.!！?？\s]*$/iu.test(
    normalized,
  );
}

function looksLikeContextResetPlanningAsk(text: string): boolean {
  return /(清除上下文|清空上下文|别接上个任务|不要接上个任务|换个题|fresh start|reset context|new task)/iu.test(
    text,
  );
}

function looksLikeCompanyToPortfolioRiskAsk(text: string): boolean {
  return (
    /(公司|基本面|fundamental|capex|revenue|margin|earnings|估值|收入质量|客户集中度)/iu.test(
      text,
    ) && /(组合|持仓|仓位|科技仓|etf sleeve|portfolio|sleeve|risk|风险|传导|连接|影响)/iu.test(text)
  );
}

function looksLikePortfolioMacroRiskAsk(text: string): boolean {
  return (
    /(qqq|tlt|nvda|持仓|组合|portfolio)/iu.test(text) &&
    /(利率|ai capex|美元流动性|流动性|通胀|credit|macro|未来两周|风险)/iu.test(text) &&
    /(tlt|美元流动性|流动性|credit|duration|久期|fed|通胀)/iu.test(text)
  );
}

function hardenPlanForKnownContracts(
  plan: Record<string, unknown>,
  options: CliOptions,
): Record<string, unknown> {
  const text = `${options.ask}\n${options.sourceSummary}`;
  const basePlan = {
    ...plan,
    risk_boundaries: mergeUnique(planRiskBoundaryValue(plan.risk_boundaries), [
      "research_only",
      "no_execution_authority",
      "evidence_required",
      "no_model_math_guessing",
    ]),
    rejected_context: mergeUnique(arrayValue(plan.rejected_context), [
      "old_lark_conversation_history",
      "language_routing_candidate_artifacts",
      "unsupported_execution_language",
    ]),
  };
  if (looksLikeAmbiguousRepeatOnlyPlanningAsk(options.ask)) {
    return {
      ...basePlan,
      task_family: "ambiguous_repeat_without_current_subject",
      primary_modules: ["control_room_summary"],
      supporting_modules: ["ops_audit"],
      required_tools: ["review_panel"],
      missing_data: ["current_subject_or_original_request"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "ask_user_for_current_subject_before_reusing_prior_context",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }
  if (looksLikeContextResetPlanningAsk(text)) {
    return {
      ...basePlan,
      task_family: "context_reset_new_subject_required",
      primary_modules: ["control_room_summary"],
      supporting_modules: ["ops_audit"],
      required_tools: ["review_panel"],
      missing_data: ["new_subject_or_original_request"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "acknowledge_context_reset_then_ask_for_new_task_subject",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }
  if (looksLikeExternalMissingSourceAsk(text)) {
    return {
      ...basePlan,
      task_family: "external_source_learning_missing_source",
      primary_modules: ["finance_learning_memory", "source_registry"],
      supporting_modules: ["review_panel", "control_room_summary"],
      required_tools: [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "review_panel",
      ],
      missing_data: ["source_url_or_local_source_path"],
      risk_boundaries: ["research_only", "no_execution_authority", "evidence_required"],
      next_step: "return_source_required_failed_reason_and_ask_for_link_or_local_file",
      rejected_context: [
        "old_lark_conversation_history",
        "language_routing_candidate_artifacts",
        "unsupported_execution_language",
      ],
    };
  }
  if (looksLikeCompanyToPortfolioRiskAsk(text) && !looksLikePortfolioMacroRiskAsk(text)) {
    return {
      ...basePlan,
      primary_modules: mergeUnique(arrayValue(basePlan.primary_modules), [
        "company_fundamentals_value",
        "causal_map",
        "portfolio_risk_gates",
      ]),
      supporting_modules: mergeUnique(arrayValue(basePlan.supporting_modules), [
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ]),
      required_tools: mergeUnique(arrayValue(basePlan.required_tools), [
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_causal_map_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ]),
      missing_data: mergeUnique(arrayValue(basePlan.missing_data), [
        "latest_company_fundamental_inputs",
        "portfolio_weights_and_risk_limits",
        "company_to_portfolio_exposure_map",
      ]),
      next_step: "build_company_to_portfolio_causal_plan_then_require_fresh_evidence",
    };
  }
  if (!looksLikeExternalCoveragePlanningAsk(text)) {
    return basePlan;
  }
  return {
    ...basePlan,
    primary_modules: mergeUnique(arrayValue(basePlan.primary_modules), [
      "source_registry",
      "finance_learning_memory",
      "causal_map",
    ]),
    supporting_modules: mergeUnique(arrayValue(basePlan.supporting_modules), [
      "review_panel",
      "control_room_summary",
    ]),
    required_tools: mergeUnique(arrayValue(basePlan.required_tools), [
      "finance_article_source_collection_preflight",
      "finance_article_source_registry_record",
      "finance_learning_retrieval_review",
      "review_panel",
    ]),
    missing_data: mergeUnique(arrayValue(basePlan.missing_data), [
      "source_url_or_local_source_path",
      "actual_reading_scope",
      "source_coverage_limits",
    ]),
    risk_boundaries: mergeUnique(planRiskBoundaryValue(basePlan.risk_boundaries), [
      "research_only",
      "evidence_required",
      "do_not_claim_exhaustive_coverage",
      "no_execution_authority",
    ]),
    next_step:
      "collect_or_verify_source_list_then_report_actual_reading_scope_before_any_learning_claim",
    rejected_context: mergeUnique(arrayValue(basePlan.rejected_context), [
      "unverified_full_coverage_claim",
      "old_lark_conversation_history",
      "language_routing_candidate_artifacts",
      "unsupported_execution_language",
    ]),
  };
}

const options = parseArgs(process.argv.slice(2));
const rawOutput = await runGenerate(options);
let rawParseError: string | null = null;
let rawPlan: Record<string, unknown> = {};
try {
  rawPlan = extractJson(rawOutput);
} catch (error) {
  rawParseError = String(error);
}
const parsed = hardenLocalBrainPlanForAsk(hardenPlanForKnownContracts(rawPlan, options), {
  ask: options.ask,
  sourceSummary: options.sourceSummary,
});
const result = {
  ok: true,
  boundary: "local_auxiliary_thought_flow_only",
  liveTouched: false,
  providerConfigTouched: false,
  durableMemoryTouched: false,
  rawParseError,
  model: options.model,
  adapterPath: options.adapterPath,
  ask: options.ask,
  plan: parsed,
};

process.stdout.write(
  options.json ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(parsed, null, 2)}\n`,
);
