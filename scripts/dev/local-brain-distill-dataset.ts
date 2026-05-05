import fs from "node:fs/promises";
import path from "node:path";

type DistillExample = {
  prompt: string;
  completion: string;
  meta: {
    sourcePath: string;
    sourceKind: string;
    generatedAt?: string;
  };
};

type CliOptions = {
  workspaceDir: string;
  outDir: string;
  maxFiles: number;
  json: boolean;
};

const DEFAULT_OUT_DIR = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  "datasets",
  "thought-flow-v1",
);

const BOUNDARIES = [
  "research_only",
  "no_execution_authority",
  "evidence_required",
  "no_model_math_guessing",
  "risk_gate_before_action_language",
  "no_high_leverage_crypto",
  "no_unverified_cross_market_claims",
];

const MODULE_TAXONOMY = [
  "macro_rates_inflation",
  "credit_liquidity",
  "cross_asset_liquidity",
  "fx_currency_liquidity",
  "etf_regime",
  "global_index_regime",
  "us_equity_market_structure",
  "china_a_share_policy_flow",
  "crypto_market_structure",
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
  "Complex finance tasks should be decomposed like a careful human analyst: clarify objective, recall memory, split causal layers, identify missing evidence, run review, then summarize.",
  "Cross-market finance tasks spanning US equities, A-shares, indices, or crypto must include the concrete market-structure modules, cross_asset_liquidity, risk gates, fresh data gaps, and no_high_leverage_crypto.",
];

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/local-brain-distill-dataset.ts [--workspace DIR] [--out DIR] [--max-files N] [--json]",
      "",
      "Builds MLX-LM prompt/completion JSONL for a local auxiliary thought-flow model.",
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

function readPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    workspaceDir: path.join(process.env.HOME ?? ".", ".openclaw", "workspace"),
    outDir: DEFAULT_OUT_DIR,
    maxFiles: 250,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace") {
      options.workspaceDir = readValue(args, index);
      index += 1;
    } else if (arg === "--out") {
      options.outDir = readValue(args, index);
      index += 1;
    } else if (arg === "--max-files") {
      options.maxFiles = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.workspaceDir = path.resolve(options.workspaceDir);
  options.outDir = path.resolve(options.outDir);
  return options;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, maxFiles: number): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }
  const result: Array<{ path: string; mtimeMs: number }> = [];
  async function walk(dir: string): Promise<void> {
    if (result.length >= maxFiles) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && /\.(json|md)$/u.test(entry.name)) {
        const stat = await fs.stat(fullPath);
        result.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(root);
  return result
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => entry.path);
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim())
    : [];
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function inferFinanceModules(text: string): string[] {
  const lower = text.toLowerCase();
  const modules: string[] = [];
  if (/利率|通胀|real yield|yield|cpi|fed|fomc|treasury|tlt|duration/u.test(lower)) {
    modules.push("macro_rates_inflation");
  }
  if (/流动性|美元|dollar|liquidity|credit|信用|spread|融资|资金/u.test(lower)) {
    modules.push("credit_liquidity");
  }
  if (/跨资产|cross-asset|risk appetite|风险偏好|stablecoin|美元流动性|全球流动性/u.test(lower)) {
    modules.push("cross_asset_liquidity");
  }
  if (/汇率|人民币|美元指数|fx|dxy|uup|usd|cnh|cny|yen|日元|套息|carry/u.test(lower)) {
    modules.push("fx_currency_liquidity");
  }
  if (/etf|qqq|spy|tlt|iwm|择时|timing|regime|技术|趋势|均线/u.test(lower)) {
    modules.push("etf_regime");
  }
  if (/指数|indices|index|沪深300|中证|纳指|道指|标普|恒生|msci|russell/u.test(lower)) {
    modules.push("global_index_regime");
  }
  if (/美股|us equities|us stocks?|nasdaq|s&p|spx|spy|qqq|iwm|nvda|msft|aapl/u.test(lower)) {
    modules.push("us_equity_market_structure");
  }
  if (/a股|a-share|沪深|上证|深证|创业板|科创|北向|人民币资产|中国权益/u.test(lower)) {
    modules.push("china_a_share_policy_flow");
  }
  if (/加密|crypto|bitcoin|btc|ethereum|eth|stablecoin|usdt|链上|交易所储备/u.test(lower)) {
    modules.push("crypto_market_structure");
  }
  if (/nvda|公司|基本面|fundamental|capex|估值|revenue|margin|earnings|ai capex/u.test(lower)) {
    modules.push("company_fundamentals_value");
  }
  if (/数学|量化|波动|相关|回撤|var|dv01|beta|correlation|volatility|drawdown/u.test(lower)) {
    modules.push("quant_math");
  }
  if (/组合|持仓|仓位|风险|risk|sizing|止损|敞口|exposure/u.test(lower)) {
    modules.push("portfolio_risk_gates");
  }
  if (/因果|路径|传导|scenario|假设|invalidation|反证/u.test(lower)) {
    modules.push("causal_map");
  }
  return uniq(modules);
}

function toolsForModules(modules: string[]): string[] {
  const tools = modules.map((module) => {
    if (module === "quant_math") {
      return "quant_math";
    }
    if (module === "review_panel") {
      return "review_panel";
    }
    return `finance_framework_${module}_producer`;
  });
  return uniq([...tools, "review_panel"]);
}

function missingDataForModules(modules: string[]): string[] {
  const missing: string[] = [];
  if (modules.includes("macro_rates_inflation")) {
    missing.push("current_rates_and_inflation_inputs");
  }
  if (modules.includes("credit_liquidity")) {
    missing.push("current_credit_and_liquidity_inputs");
  }
  if (modules.includes("cross_asset_liquidity")) {
    missing.push("fresh_market_data_snapshot", "cross_asset_liquidity_inputs");
  }
  if (modules.includes("fx_currency_liquidity")) {
    missing.push("fx_dollar_yuan_and_global_liquidity_inputs");
  }
  if (modules.includes("etf_regime")) {
    missing.push("target_etf_price_and_regime_inputs");
  }
  if (modules.includes("global_index_regime")) {
    missing.push("index_constituents_weights_and_technical_regime_inputs");
  }
  if (modules.includes("us_equity_market_structure")) {
    missing.push("us_equity_breadth_earnings_and_valuation_inputs");
  }
  if (modules.includes("china_a_share_policy_flow")) {
    missing.push("china_a_share_policy_liquidity_and_northbound_inputs");
  }
  if (modules.includes("crypto_market_structure")) {
    missing.push("crypto_liquidity_volatility_custody_and_regulatory_inputs");
  }
  if (modules.includes("company_fundamentals_value")) {
    missing.push("latest_company_fundamental_inputs");
  }
  if (modules.includes("quant_math")) {
    missing.push("position_weights_and_return_series");
  }
  if (modules.includes("portfolio_risk_gates")) {
    missing.push("portfolio_weights_and_risk_limits");
  }
  return uniq(missing);
}

function normalizeMissingDataEntries(values: string[]): string[] {
  const normalized = values.map((entry) => entry.trim()).filter(Boolean);
  const exact: string[] = [];
  for (const entry of normalized) {
    const lower = entry.toLowerCase();
    if (lower.includes("position_weights_and_return_series")) {
      exact.push("position_weights_and_return_series");
    }
    if (lower.includes("source_url_or_local_source_path")) {
      exact.push("source_url_or_local_source_path");
    }
    if (lower.includes("current_subject_or_original_request")) {
      exact.push("current_subject_or_original_request");
    }
    if (lower.includes("actual_reading_scope")) {
      exact.push("actual_reading_scope");
    }
    if (lower.includes("source_coverage_limits")) {
      exact.push("source_coverage_limits");
    }
    if (lower.includes("portfolio_weights_and_risk_limits")) {
      exact.push("portfolio_weights_and_risk_limits");
    }
    if (lower.includes("fresh_market_data_snapshot")) {
      exact.push("fresh_market_data_snapshot");
    }
    if (lower.includes("us_equity_breadth_earnings_and_valuation_inputs")) {
      exact.push("us_equity_breadth_earnings_and_valuation_inputs");
    }
    if (lower.includes("china_a_share_policy_liquidity_and_northbound_inputs")) {
      exact.push("china_a_share_policy_liquidity_and_northbound_inputs");
    }
    if (lower.includes("index_constituents_weights_and_technical_regime_inputs")) {
      exact.push("index_constituents_weights_and_technical_regime_inputs");
    }
    if (lower.includes("crypto_liquidity_volatility_custody_and_regulatory_inputs")) {
      exact.push("crypto_liquidity_volatility_custody_and_regulatory_inputs");
    }
    if (lower.includes("fx_dollar_yuan_and_global_liquidity_inputs")) {
      exact.push("fx_dollar_yuan_and_global_liquidity_inputs");
    }
  }
  return uniq([...exact, ...normalized]);
}

function normalizeRiskBoundaries(values: string[]): string[] {
  const normalized = values.map((entry) => entry.trim()).filter(Boolean);
  const hasResearchBoundary =
    normalized.includes("research_only") || normalized.includes("no_execution_authority");
  return uniq(hasResearchBoundary ? normalized : [...normalized, ...BOUNDARIES]);
}

function buildPrompt(params: {
  sourceKind: string;
  userAsk: string;
  sourceSummary: string;
}): string {
  return [
    "You are the LCX Agent local auxiliary thought-flow model.",
    "Task: produce a concise control-room planning packet for the main agent.",
    "Do not answer the user's finance question directly.",
    "Think like a careful human financial analyst: clarify objective, recall local memory and learned rules, split causal layers, identify missing evidence, route to review, then summarize for the control room.",
    "Do not invent live data, execution approval, or durable memory writes.",
    `Allowed module ids: ${MODULE_TAXONOMY.join(", ")}.`,
    "For finance tasks, choose concrete module ids from the allowed list instead of generic finance labels.",
    `Planning contract hints: ${CONTRACT_HINTS.join(" ")}`,
    "Return only JSON with keys: task_family, primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, next_step, rejected_context.",
    "",
    `source_kind: ${params.sourceKind}`,
    `user_or_task: ${params.userAsk}`,
    `source_summary: ${params.sourceSummary}`,
  ].join("\n");
}

function buildCompletion(params: {
  taskFamily: string;
  primaryModules: string[];
  supportingModules?: string[];
  requiredTools?: string[];
  missingData?: string[];
  riskBoundaries?: string[];
  nextStep: string;
  rejectedContext?: string[];
}): string {
  return compactJson({
    task_family: params.taskFamily,
    primary_modules: params.primaryModules,
    supporting_modules: params.supportingModules ?? [],
    required_tools: params.requiredTools ?? [],
    missing_data: params.missingData ?? [],
    risk_boundaries: params.riskBoundaries ?? BOUNDARIES,
    next_step: params.nextStep,
    rejected_context: params.rejectedContext ?? [
      "old_lark_conversation_history",
      "language_routing_candidate_artifacts",
      "unsupported_execution_language",
    ],
  });
}

function exampleFromHandoff(
  parsed: Record<string, unknown>,
  sourcePath: string,
): DistillExample | undefined {
  const handoff = parsed.handoff as Record<string, unknown> | undefined;
  const apiCandidate = handoff?.apiCandidate as Record<string, unknown> | undefined;
  const workOrder = apiCandidate?.workOrder as Record<string, unknown> | undefined;
  const userAsk = readString(parsed.userMessage) ?? readString(workOrder?.objective);
  if (!userAsk) {
    return undefined;
  }
  const family = readString(handoff?.family) ?? readString(apiCandidate?.family) ?? "unknown";
  const targetSurface = readString(parsed.targetSurface) ?? "control_room";
  const requiredEvidence =
    readStringArray(workOrder?.evidenceRequired).length > 0
      ? readStringArray(workOrder?.evidenceRequired)
      : readStringArray(handoff?.missingBeforeExecution);
  const boundaries = [
    ...readStringArray(workOrder?.safetyBoundaries),
    ...(parsed.noExecutionApproval ? ["no_execution_authority"] : []),
    ...(parsed.noFinanceLearningArtifact ? ["language_handoff_only"] : []),
  ].filter(Boolean);
  const inferredModules = inferFinanceModules(
    [
      userAsk,
      family,
      targetSurface,
      readString(apiCandidate?.rationale),
      readString(workOrder?.objective),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const isFinancePlanning = inferredModules.length > 0;
  const sourceSummary = truncate(
    compactJson({
      family,
      targetSurface,
      rationale: readString(apiCandidate?.rationale),
      objective: readString(workOrder?.objective),
      evidenceRequired: requiredEvidence,
    }),
    1800,
  );
  return {
    prompt: buildPrompt({
      sourceKind: "lark_language_handoff_receipt",
      userAsk,
      sourceSummary,
    }),
    completion: buildCompletion({
      taskFamily: isFinancePlanning ? "finance_research_planning" : family,
      primaryModules: isFinancePlanning
        ? inferredModules
        : targetSurface === "learning_command"
          ? ["finance_learning_memory"]
          : [targetSurface],
      supportingModules: isFinancePlanning
        ? ["finance_learning_memory", "control_room_summary"]
        : family === "unknown"
          ? []
          : ["control_room_summary"],
      requiredTools: isFinancePlanning
        ? toolsForModules(inferredModules)
        : targetSurface === "learning_command"
          ? ["finance_learning_pipeline_orchestrator", "review_tier"]
          : ["review_tier"],
      missingData: isFinancePlanning
        ? uniq([...requiredEvidence, ...missingDataForModules(inferredModules)])
        : requiredEvidence,
      riskBoundaries: boundaries.length > 0 ? boundaries : BOUNDARIES,
      nextStep: isFinancePlanning
        ? "request_fresh_inputs_then_route_to_concrete_finance_modules"
        : family === "unknown"
          ? "ask_user_for_current_subject_before_reusing_prior_context"
          : "handoff_to_selected_modules_then_review_before_reply",
    }),
    meta: {
      sourcePath,
      sourceKind: "lark_language_handoff_receipt",
      generatedAt: readString(parsed.generatedAt),
    },
  };
}

function exampleFromApplyReceipt(
  parsed: Record<string, unknown>,
  sourcePath: string,
): DistillExample | undefined {
  const queryText = readString(parsed.queryText);
  const synthesis = parsed.capabilitySynthesis as Record<string, unknown> | undefined;
  if (!queryText || !synthesis) {
    return undefined;
  }
  const appliedCapabilities = Array.isArray(parsed.appliedCapabilities)
    ? parsed.appliedCapabilities
    : [];
  const matchedSignals = appliedCapabilities.flatMap((entry) =>
    entry && typeof entry === "object"
      ? readStringArray((entry as Record<string, unknown>).matchedSignals)
      : [],
  );
  const requiredInputs = readStringArray(synthesis.combinedRequiredInputs);
  const riskChecks = readStringArray(synthesis.combinedRiskChecks);
  const sourceSummary = truncate(
    compactJson({
      queryText,
      synthesisMode: readString(parsed.synthesisMode),
      primaryCapability: readString(synthesis.primaryCapability),
      matchedSignals,
      requiredInputs,
      riskChecks,
    }),
    1800,
  );
  return {
    prompt: buildPrompt({
      sourceKind: "finance_learning_capability_apply_receipt",
      userAsk: queryText,
      sourceSummary,
    }),
    completion: buildCompletion({
      taskFamily: "finance_capability_application",
      primaryModules:
        matchedSignals.length > 0 ? matchedSignals.slice(0, 4) : ["finance_learning_memory"],
      supportingModules: ["finance_learning_retrieval_review", "control_room_summary"],
      requiredTools: [
        "finance_learning_capability_apply",
        "finance_learning_retrieval_review",
        "review_tier",
      ],
      missingData: requiredInputs,
      riskBoundaries: [
        ...(parsed.noExecutionAuthority ? ["no_execution_authority"] : []),
        ...(parsed.noProtectedMemoryWrite ? ["no_protected_memory_write"] : []),
        ...riskChecks.slice(0, 3),
      ],
      nextStep: "apply_retrieved_capability_only_after_fresh_inputs_are_checked",
    }),
    meta: {
      sourcePath,
      sourceKind: "finance_learning_capability_apply_receipt",
      generatedAt: readString(parsed.generatedAt),
    },
  };
}

function exampleFromAcceptedBrainCandidate(
  accepted: Record<string, unknown>,
  sourcePath: string,
  generatedAt?: string,
  sourceKind = "brain_distillation_candidate_review",
  noLanguageRoutingPromotion?: unknown,
): DistillExample | undefined {
  const userAsk = readString(accepted.userMessage) ?? readString(accepted.candidateText);
  if (!userAsk) {
    return undefined;
  }
  const candidateText = readString(accepted.candidateText) ?? "";
  const primaryModules = readStringArray(accepted.proposedPrimaryModules);
  const supportingModules = readStringArray(accepted.proposedSupportingModules);
  const requiredTools = readStringArray(accepted.proposedRequiredTools);
  const missingData = readStringArray(accepted.proposedMissingData);
  const riskBoundaries = normalizeRiskBoundaries(readStringArray(accepted.proposedRiskBoundaries));
  const taskFamily = readString(accepted.proposedTaskFamily) ?? "brain_distillation_candidate";
  const nextStep =
    readString(accepted.proposedNextStep) ??
    "route_to_concrete_modules_then_review_before_visible_reply";
  if (primaryModules.length === 0 || requiredTools.length === 0) {
    return undefined;
  }
  const sourceSummary = truncate(
    compactJson({
      candidateText,
      taskFamily,
      primaryModules,
      supportingModules,
      requiredTools,
      missingData: normalizeMissingDataEntries(missingData),
      review: accepted.review,
      noLanguageRoutingPromotion,
    }),
    1800,
  );
  return {
    prompt: buildPrompt({
      sourceKind,
      userAsk,
      sourceSummary,
    }),
    completion: buildCompletion({
      taskFamily,
      primaryModules,
      supportingModules,
      requiredTools,
      missingData: normalizeMissingDataEntries(missingData),
      riskBoundaries,
      nextStep,
    }),
    meta: {
      sourcePath,
      sourceKind,
      generatedAt,
    },
  };
}

function findAcceptedBrainCandidates(candidates: unknown[]): Record<string, unknown>[] {
  return candidates.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const record = entry as Record<string, unknown>;
    const review = record.review as Record<string, unknown> | undefined;
    return (
      record.boundary === "brain_distillation_candidate" &&
      record.status === "accepted_brain_plan" &&
      readBoolean(review?.accepted) === true
    );
  });
}

function exampleFromBrainDistillationCandidate(
  parsed: Record<string, unknown>,
  sourcePath: string,
): DistillExample[] {
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  return findAcceptedBrainCandidates(candidates)
    .map((accepted, index) =>
      exampleFromAcceptedBrainCandidate(
        accepted,
        `${sourcePath}#candidate-${index + 1}`,
        readString(parsed.generatedAt),
        "brain_distillation_candidate_review",
        parsed.noLanguageRoutingPromotion,
      ),
    )
    .filter((entry): entry is DistillExample => Boolean(entry));
}

function exampleFromBrainDistillationReview(
  parsed: Record<string, unknown>,
  sourcePath: string,
): DistillExample[] {
  const candidates = Array.isArray(parsed.acceptedCandidates) ? parsed.acceptedCandidates : [];
  return findAcceptedBrainCandidates(candidates)
    .map((accepted, index) =>
      exampleFromAcceptedBrainCandidate(
        accepted,
        `${sourcePath}#accepted-${index + 1}`,
        readString(parsed.reviewedAt),
        "brain_distillation_review",
        parsed.noLanguageRoutingPromotion,
      ),
    )
    .filter((entry): entry is DistillExample => Boolean(entry));
}

function exampleFromWorkReceipt(raw: string, sourcePath: string): DistillExample | undefined {
  const userAsk = raw.match(/## User Ask\s+- ([\s\S]*?)\n\n/u)?.[1]?.trim();
  const finalSummary = raw.match(/## Final Reply Summary\s+- ([\s\S]*)$/u)?.[1]?.trim();
  const surface = raw.match(/- \*\*Surface\*\*: ([^\n]+)/u)?.[1]?.trim();
  if (!userAsk || !surface || !finalSummary) {
    return undefined;
  }
  const inferredModules = inferFinanceModules(`${userAsk}\n${finalSummary}\n${surface}`);
  const isFinancePlanning = inferredModules.length > 0;
  const missingData = /ambiguous|没有说明|缺失|unclear|failedReason/iu.test(finalSummary)
    ? ["current_subject_or_original_request"]
    : isFinancePlanning
      ? missingDataForModules(inferredModules)
      : [];
  return {
    prompt: buildPrompt({
      sourceKind: "feishu_work_receipt",
      userAsk,
      sourceSummary: truncate(finalSummary, 1200),
    }),
    completion: buildCompletion({
      taskFamily: isFinancePlanning ? "finance_research_planning" : surface,
      primaryModules: isFinancePlanning ? inferredModules : [surface],
      supportingModules: isFinancePlanning
        ? ["finance_learning_memory", "control_room_summary"]
        : ["control_room_summary"],
      requiredTools: isFinancePlanning ? toolsForModules(inferredModules) : ["review_tier"],
      missingData,
      nextStep:
        missingData.length > 0
          ? isFinancePlanning
            ? "request_fresh_inputs_then_route_to_concrete_finance_modules"
            : "ask_user_for_missing_subject_instead_of_reusing_old_context"
          : isFinancePlanning
            ? "route_to_concrete_finance_modules_then_review_before_reply"
            : "compose_visible_reply_with_boundaries",
    }),
    meta: {
      sourcePath,
      sourceKind: "feishu_work_receipt",
    },
  };
}

async function examplesFromFile(filePath: string, workspaceDir: string): Promise<DistillExample[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const relativePath = path.relative(workspaceDir, filePath).split(path.sep).join("/");
  const parsed = safeJsonParse(raw);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (record.boundary === "language_handoff_only") {
      const example = exampleFromHandoff(record, relativePath);
      return example ? [example] : [];
    }
    if (record.boundary === "finance_learning_capability_apply_usage_receipt") {
      const example = exampleFromApplyReceipt(record, relativePath);
      return example ? [example] : [];
    }
    if (record.boundary === "brain_distillation_candidate") {
      return exampleFromBrainDistillationCandidate(record, relativePath);
    }
    if (record.boundary === "brain_distillation_review") {
      return exampleFromBrainDistillationReview(record, relativePath);
    }
    return [];
  }
  if (relativePath.includes("feishu-work-receipts/")) {
    const example = exampleFromWorkReceipt(raw, relativePath);
    return example ? [example] : [];
  }
  return [];
}

function splitExamples(examples: DistillExample[]): {
  train: DistillExample[];
  valid: DistillExample[];
  test: DistillExample[];
} {
  const curated = examples
    .filter((example) => example.meta.sourceKind === "curated_seed")
    .toSorted((a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath));
  const reviewedBrain = examples
    .filter((example) => example.meta.sourceKind === "brain_distillation_review")
    .toSorted((a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath));
  const sorted = examples
    .filter(
      (example) =>
        example.meta.sourceKind !== "curated_seed" &&
        example.meta.sourceKind !== "brain_distillation_review",
    )
    .toSorted((a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath));
  const testCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const validCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const reviewedBrainTrain = Array.from({ length: 8 }, (_, round) =>
    reviewedBrain.map((example) => ({
      ...example,
      meta: {
        ...example.meta,
        sourcePath: `${example.meta.sourcePath}-review-round-${round + 1}`,
      },
    })),
  ).flat();
  return {
    test: sorted.slice(0, testCount),
    valid: sorted.slice(testCount, testCount + validCount),
    train: sorted.slice(testCount + validCount).concat(reviewedBrainTrain, curated),
  };
}

function buildSeedExamples(): DistillExample[] {
  const seeds: Array<{
    userAsk: string;
    sourceSummary: string;
    taskFamily: string;
    primaryModules: string[];
    supportingModules: string[];
    requiredTools: string[];
    missingData: string[];
    nextStep: string;
  }> = [
    {
      userAsk:
        "我持有 QQQ、TLT 和少量 NVDA，未来两周担心利率、AI capex、美元流动性。先规划内部模块，不要给交易建议。",
      sourceSummary:
        "clean portfolio risk planning request; needs modules before conclusion; no live market data supplied.",
      taskFamily: "portfolio_risk_research_planning",
      primaryModules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
        "causal_map",
      ],
      supportingModules: ["finance_learning_memory", "review_panel", "control_room_summary"],
      requiredTools: [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "finance_framework_causal_map_producer",
        "review_panel",
      ],
      missingData: [
        "actual_position_weights",
        "current_2y_10y_real_yields",
        "qqq_tlt_nvda_recent_returns",
        "nvda_latest_fundamentals",
        "ai_capex_latest_guidance",
        "dollar_liquidity_indicators",
      ],
      nextStep: "produce_research_only_module_plan_then_request_fresh_inputs_before_any_conclusion",
    },
    {
      userAsk:
        "帮我分析未来两周 QQQ 和 TLT 谁更危险，重点看利率、通胀、美元流动性和组合风险，先别下结论。",
      sourceSummary:
        "ETF risk comparison request; needs macro, liquidity, ETF regime, math, and risk gates before conclusion.",
      taskFamily: "etf_macro_risk_research_planning",
      primaryModules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "quant_math",
        "portfolio_risk_gates",
      ],
      supportingModules: ["causal_map", "review_panel", "control_room_summary"],
      requiredTools: [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "current_yield_curve",
        "inflation_surprise_context",
        "dollar_liquidity_indicators",
        "qqq_tlt_return_series",
        "portfolio_weights",
      ],
      nextStep: "route_to_macro_liquidity_etf_math_risk_modules_before_visible_summary",
    },
    {
      userAsk:
        "NVDA 如果 AI capex 放缓，对我的科技仓有什么风险？先组织内部研究，不要直接建议买卖。",
      sourceSummary:
        "NVDA company fundamentals plus portfolio spillover request; no fresh filing or guidance data supplied.",
      taskFamily: "company_fundamental_portfolio_risk_planning",
      primaryModules: [
        "company_fundamentals_value",
        "causal_map",
        "etf_regime",
        "portfolio_risk_gates",
      ],
      supportingModules: ["macro_rates_inflation", "finance_learning_memory", "review_panel"],
      requiredTools: [
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_causal_map_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "nvda_latest_revenue_breakdown",
        "hyperscaler_capex_guidance",
        "valuation_multiple_context",
        "qqq_semiconductor_weight",
        "position_weights",
      ],
      nextStep: "build_company_to_portfolio_causal_plan_then_require_fresh_evidence",
    },
    {
      userAsk: "我想做一个低频 ETF 择时框架，先判断需要哪些内部能力，不要回测故事。",
      sourceSummary:
        "low-frequency ETF timing framework request; must avoid overfit backtest storytelling.",
      taskFamily: "low_frequency_etf_timing_framework",
      primaryModules: [
        "etf_regime",
        "macro_rates_inflation",
        "credit_liquidity",
        "quant_math",
        "portfolio_risk_gates",
      ],
      supportingModules: ["causal_map", "finance_learning_memory", "review_panel"],
      requiredTools: [
        "finance_framework_etf_regime_producer",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "target_etf_universe",
        "rebalance_frequency",
        "regime_features",
        "out_of_sample_design",
        "risk_limit_definition",
      ],
      nextStep: "draft_module_plan_with_overfit_guard_before_any_strategy_claim",
    },
    {
      userAsk: "把我这个持仓做风险拆解：利率、信用、流动性、单一公司、数学暴露都要过一遍。",
      sourceSummary:
        "portfolio decomposition request; explicitly names risk families and requires module fanout.",
      taskFamily: "portfolio_multi_module_risk_decomposition",
      primaryModules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "company_fundamentals_value",
        "quant_math",
        "portfolio_risk_gates",
      ],
      supportingModules: ["etf_regime", "causal_map", "review_panel"],
      requiredTools: [
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "holdings",
        "weights",
        "cost_basis_optional",
        "lookback_window",
        "latest_macro_inputs",
      ],
      nextStep: "collect_position_inputs_then_run_multi_module_risk_decomposition",
    },
    {
      userAsk:
        "这是一个复杂研究任务：我持有 QQQ、TLT、NVDA，还担心利率、美元流动性和 AI capex。先动用本地记忆、已学规则和历史沉淀，拆成可执行的内部分析步骤，再交给大模型审阅；不要直接给交易建议。",
      sourceSummary:
        "complex local-brain task requiring memory recall, learned-rule activation, finance module fanout, and model review handoff.",
      taskFamily: "local_memory_knowledge_activated_research_planning",
      primaryModules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
      ],
      supportingModules: ["review_panel", "control_room_summary"],
      requiredTools: [
        "artifact_memory_recall",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_causal_map_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_task_inputs",
        "position_weights_and_return_series",
        "current_rates_and_inflation_inputs",
        "current_credit_and_liquidity_inputs",
        "latest_company_fundamental_inputs",
      ],
      nextStep: "recall_relevant_local_memory_and_rules_then_decompose_modules_before_model_review",
    },
    {
      userAsk:
        "训练本地大脑像正常人类分析师一样拆复杂金融任务：我持有 QQQ、TLT、NVDA，担心利率、美元流动性和 AI capex。先理解目标，再调本地记忆和已学规则，再按宏观、流动性、基本面、数学、风险门和审阅拆步骤。",
      sourceSummary:
        "human-like complex finance decomposition requiring objective clarification, local memory activation, causal finance layers, evidence gates, and model review handoff.",
      taskFamily: "human_brain_finance_decomposition",
      primaryModules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "etf_regime",
        "company_fundamentals_value",
        "quant_math",
        "finance_learning_memory",
        "source_registry",
        "causal_map",
        "portfolio_risk_gates",
      ],
      supportingModules: ["review_panel", "control_room_summary"],
      requiredTools: [
        "artifact_memory_recall",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "finance_framework_causal_map_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_task_inputs",
        "position_weights_and_return_series",
        "current_rates_and_inflation_inputs",
        "current_credit_and_liquidity_inputs",
        "latest_company_fundamental_inputs",
      ],
      nextStep: "clarify_objective_recall_memory_split_causal_layers_check_evidence_then_review",
    },
    {
      userAsk:
        "未来我会同时看美股、A股、指数和加密币。请训练本地大脑做连贯分析：先动用本地记忆和已学规则，再拆宏观利率、美元/人民币流动性、美股市场结构、A股政策资金面、指数权重和趋势、加密币流动性和风险门；research-only，不要交易建议。",
      sourceSummary:
        "cross-market finance planning request spanning US equities, China A-shares, global indices, crypto, liquidity, quant checks, memory recall, and review handoff.",
      taskFamily: "cross_market_finance_research_planning",
      primaryModules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "us_equity_market_structure",
        "china_a_share_policy_flow",
        "global_index_regime",
        "crypto_market_structure",
        "quant_math",
        "portfolio_risk_gates",
      ],
      supportingModules: [
        "causal_map",
        "finance_learning_memory",
        "source_registry",
        "review_panel",
        "control_room_summary",
      ],
      requiredTools: [
        "artifact_memory_recall",
        "finance_learning_capability_apply",
        "source_registry_lookup",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_cross_asset_liquidity_producer",
        "finance_framework_fx_currency_liquidity_producer",
        "finance_framework_us_equity_market_structure_producer",
        "finance_framework_china_a_share_policy_flow_producer",
        "finance_framework_global_index_regime_producer",
        "finance_framework_crypto_market_structure_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "memory_recall_scope_or_relevant_receipts",
        "fresh_market_data_snapshot",
        "us_equity_breadth_earnings_and_valuation_inputs",
        "china_a_share_policy_liquidity_and_northbound_inputs",
        "index_constituents_weights_and_technical_regime_inputs",
        "crypto_liquidity_volatility_custody_and_regulatory_inputs",
        "fx_dollar_yuan_and_global_liquidity_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ],
      nextStep:
        "recall_local_finance_rules_then_build_cross_market_causal_map_collect_fresh_inputs_run_quant_and_review_before_control_room_summary",
    },
    {
      userAsk: "重新来一遍。",
      sourceSummary:
        "ambiguous repeat request with no current subject; prior Lark context was explicitly cleaned.",
      taskFamily: "ambiguous_repeat_without_current_subject",
      primaryModules: ["control_room"],
      supportingModules: [],
      requiredTools: ["review_tier"],
      missingData: ["current_subject_or_original_request"],
      nextStep: "ask_user_which_task_to_repeat_instead_of_reusing_old_lark_context",
    },
    {
      userAsk: "清除上下文，换个题，从头开始。",
      sourceSummary:
        "reset-context synonym family; must forbid old task inheritance and ask for a concrete new subject.",
      taskFamily: "ambiguous_repeat_without_current_subject",
      primaryModules: ["control_room"],
      supportingModules: ["ops_audit"],
      requiredTools: ["review_tier"],
      missingData: ["new_subject_or_original_request"],
      nextStep: "acknowledge_context_reset_then_ask_for_the_new_task_subject",
    },
    {
      userAsk: "去学习这个网页，但我没有给链接。",
      sourceSummary:
        "external learning request without source URL; must not pretend source was read.",
      taskFamily: "learning_external_source",
      primaryModules: ["finance_learning_memory"],
      supportingModules: ["source_registry", "review_tier"],
      requiredTools: [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "review_tier",
      ],
      missingData: ["source_url_or_local_source_path"],
      nextStep: "return_source_required_failed_reason_and_ask_for_link_or_local_file",
    },
    {
      userAsk: "用数学分析我这个组合，但不要靠模型胡猜。",
      sourceSummary:
        "portfolio math request; must use local calculable quantities only when inputs exist.",
      taskFamily: "quant_math_portfolio_risk",
      primaryModules: ["quant_math", "portfolio_risk_gates"],
      supportingModules: ["etf_regime", "review_tier"],
      requiredTools: [
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_tier",
      ],
      missingData: [
        "position_weights",
        "price_series",
        "return_series",
        "volatility_window",
        "correlation_window",
        "tlt_duration_or_dv01_inputs",
      ],
      nextStep: "compute_only_available_math_and_mark_failed_reason_for_missing_inputs",
    },
    {
      userAsk:
        "我有 QQQ、TLT、NVDA 三个仓位，想算波动、相关性、回撤和利率敏感性，但我还没给权重和价格序列。先拆模块，不要靠模型胡算。",
      sourceSummary:
        "fresh adjacent quant math planning request; exact required missing input is position_weights_and_return_series.",
      taskFamily: "quant_math_portfolio_risk",
      primaryModules: ["quant_math", "portfolio_risk_gates", "etf_regime", "macro_rates_inflation"],
      supportingModules: ["finance_learning_memory", "review_panel", "control_room_summary"],
      requiredTools: [
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "finance_framework_etf_regime_producer",
        "finance_framework_macro_rates_inflation_producer",
        "review_panel",
      ],
      missingData: [
        "position_weights_and_return_series",
        "volatility_window",
        "correlation_window",
        "drawdown_window",
        "tlt_duration_or_dv01_inputs",
      ],
      nextStep: "request_position_weights_and_return_series_before_any_local_math",
    },
    {
      userAsk: "给我一个 NVDA 基本面风险框架，不要直接说买卖。",
      sourceSummary: "company fundamentals planning request; no fresh filing data supplied.",
      taskFamily: "fundamental_research",
      primaryModules: ["company_fundamentals_value", "causal_map", "portfolio_risk_gates"],
      supportingModules: ["finance_learning_memory", "review_panel"],
      requiredTools: [
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_causal_map_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "latest_nvda_revenue_mix",
        "latest_gross_margin",
        "customer_concentration",
        "hyperscaler_capex_guidance",
        "valuation_band",
      ],
      nextStep: "build_research_only_fundamental_risk_frame_with_fresh_data_requirements",
    },
    {
      userAsk: "去学习这篇金融论文并沉淀成规则，但我还没给链接或本地文件。",
      sourceSummary:
        "external source learning request without URL or local path; must use source registry and fail cleanly before reading.",
      taskFamily: "learning_external_source_missing_source",
      primaryModules: ["finance_learning_memory", "source_registry"],
      supportingModules: ["review_panel", "control_room_summary"],
      requiredTools: [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "review_panel",
      ],
      missingData: ["source_url_or_local_source_path"],
      nextStep: "return_source_required_failed_reason_and_ask_for_link_or_local_file",
    },
    {
      userAsk: "学习这个网页里的 ETF 方法，先别编，我还没发 URL。",
      sourceSummary:
        "web learning request missing source URL; source_registry must be selected and no article should be invented.",
      taskFamily: "learning_external_source_missing_source",
      primaryModules: ["finance_learning_memory", "source_registry"],
      supportingModules: ["review_panel", "control_room_summary"],
      requiredTools: [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "review_panel",
      ],
      missingData: ["source_url_or_local_source_path"],
      nextStep: "return_source_required_failed_reason_and_ask_for_link_or_local_file",
    },
    {
      userAsk:
        "从 Google Scholar、SSRN 和 NBER 找前沿量化论文，但要列出实际读过的材料，不要说全覆盖。",
      sourceSummary:
        "external scholarly source learning with explicit coverage-honesty contract; must track what was actually read.",
      taskFamily: "external_source_coverage_honesty",
      primaryModules: ["finance_learning_memory", "source_registry", "causal_map"],
      supportingModules: ["review_panel", "control_room_summary"],
      requiredTools: [
        "finance_article_source_collection_preflight",
        "finance_article_source_registry_record",
        "finance_learning_retrieval_review",
        "review_panel",
      ],
      missingData: ["source_urls_or_manual_source_list", "actual_reading_scope"],
      nextStep: "collect_source_list_then_report_sample_limits_before_any_learning_claim",
    },
    {
      userAsk: "Lark 回复看起来又串到旧任务了，先判断是不是旧上下文污染。",
      sourceSummary:
        "ops audit request for dirty Lark context; must inspect session and language-candidate state.",
      taskFamily: "ops_source_grounding",
      primaryModules: ["ops_audit", "control_room"],
      supportingModules: ["lark_live_loop_debugger"],
      requiredTools: [
        "sessions_list",
        "sessions_history",
        "lark_loop_diagnose",
        "channels_status_probe",
      ],
      missingData: ["fresh_lark_message_id_or_visible_reply_text"],
      nextStep: "inspect_lark_session_store_and_candidate_replay_before_claiming_live_fixed",
    },
    {
      userAsk:
        "你刚才纳斯达克那句话哪来的，给我 artifact、source 或 receipt，没有就标 unverified。",
      sourceSummary:
        "source-grounding complaint; final answer must not rely on generic market framework without evidence.",
      taskFamily: "ops_source_grounding",
      primaryModules: ["ops_audit", "source_registry", "control_room_summary"],
      supportingModules: ["review_panel"],
      requiredTools: ["lark_loop_diagnose", "source_registry_lookup", "review_panel"],
      missingData: ["claim_to_verify", "artifact_or_source_path"],
      nextStep: "verify_claim_against_receipts_or_mark_unverified_before_answering",
    },
  ];

  const seedExamples = seeds.map((seed, index) => ({
    prompt: buildPrompt({
      sourceKind: "curated_seed",
      userAsk: seed.userAsk,
      sourceSummary: seed.sourceSummary,
    }),
    completion: buildCompletion({
      taskFamily: seed.taskFamily,
      primaryModules: seed.primaryModules,
      supportingModules: seed.supportingModules,
      requiredTools: seed.requiredTools,
      missingData: seed.missingData,
      riskBoundaries: BOUNDARIES,
      nextStep: seed.nextStep,
    }),
    meta: {
      sourcePath: `curated-seed/${String(index + 1).padStart(2, "0")}.json`,
      sourceKind: "curated_seed",
    },
  }));

  // The receipt corpus is intentionally broad and noisy.  Oversample the small
  // hand-written contract set so the auxiliary model learns LCX module names
  // instead of collapsing every finance task into a generic "finance" label.
  return Array.from({ length: 8 }, (_, round) =>
    seedExamples.map((example) => ({
      ...example,
      meta: {
        ...example.meta,
        sourcePath: example.meta.sourcePath.replace(".json", `-round-${round + 1}.json`),
      },
    })),
  ).flat();
}

async function writeJsonl(filePath: string, examples: DistillExample[]): Promise<void> {
  const lines = examples.map((example) =>
    JSON.stringify({
      prompt: example.prompt,
      completion: example.completion,
      meta: example.meta,
    }),
  );
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

const options = parseArgs(process.argv.slice(2));
const memoryDir = path.join(options.workspaceDir, "memory");
const roots = [
  path.join(memoryDir, "lark-language-handoff-receipts"),
  path.join(memoryDir, "finance-learning-apply-usage-receipts"),
  path.join(memoryDir, "feishu-work-receipts"),
  path.join(memoryDir, "lark-brain-distillation-candidates"),
  path.join(memoryDir, "lark-brain-distillation-reviews"),
];
const files = (await Promise.all(roots.map((root) => collectFiles(root, options.maxFiles)))).flat();
const examples = (
  await Promise.all(files.map((filePath) => examplesFromFile(filePath, options.workspaceDir)))
)
  .flat()
  .concat(buildSeedExamples());

if (examples.length < 3) {
  throw new Error(`Not enough distillation examples: ${examples.length}`);
}

const splits = splitExamples(examples);
await fs.mkdir(options.outDir, { recursive: true });
await writeJsonl(path.join(options.outDir, "train.jsonl"), splits.train);
await writeJsonl(path.join(options.outDir, "valid.jsonl"), splits.valid);
await writeJsonl(path.join(options.outDir, "test.jsonl"), splits.test);

const manifest = {
  ok: true,
  boundary: "local_auxiliary_thought_flow_only",
  workspaceDir: options.workspaceDir,
  outDir: options.outDir,
  counts: {
    sourceFiles: files.length,
    examples: examples.length,
    train: splits.train.length,
    valid: splits.valid.length,
    test: splits.test.length,
  },
  sourceKinds: examples.reduce<Record<string, number>>((acc, example) => {
    acc[example.meta.sourceKind] = (acc[example.meta.sourceKind] ?? 0) + 1;
    return acc;
  }, {}),
  notTouched: [
    "live_sender",
    "provider_config",
    "protected_repo_memory",
    "formal_lark_routing_corpus",
    "finance_doctrine",
  ],
};
await fs.writeFile(path.join(options.outDir, "manifest.json"), `${compactJson(manifest)}\n`);

if (options.json) {
  process.stdout.write(`${compactJson(manifest)}\n`);
} else {
  process.stdout.write(
    [
      "local brain distillation dataset built",
      `out_dir=${options.outDir}`,
      `examples=${examples.length}`,
      `train=${splits.train.length}`,
      `valid=${splits.valid.length}`,
      `test=${splits.test.length}`,
    ].join("\n") + "\n",
  );
}
