import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateCases, scorePlan, toDatasetRow } from "./local-brain-generalization-generator.js";
import {
  LOCAL_BRAIN_CONTRACT_HINTS,
  LOCAL_BRAIN_MODULE_TAXONOMY,
  LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS,
  LOCAL_BRAIN_RISK_BOUNDARIES,
  packLocalBrainModuleFields,
} from "./local-brain-taxonomy.js";

export type DistillExample = {
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
  // Number of infinite-stream generated cases to mix into the TRAIN pool only.
  // 0 (default) keeps the historical receipt-only dataset unchanged.
  mixGenerated: number;
  // Seed for the generator so a rebuild is reproducible.
  generatedSeed: number;
  // Held-out fraction the generator reserves; mixed train rows are drawn from
  // the "train" split so they never overlap the harness generalization holdout.
  generatedHoldoutFraction: number;
};

const DEFAULT_OUT_DIR = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  "datasets",
  "thought-flow-v1",
);

const BOUNDARIES = [...LOCAL_BRAIN_RISK_BOUNDARIES];
const MAX_DISTILL_USER_ASK_CHARS = 420;
const MAX_ACCEPTED_CANDIDATE_SUMMARY_CHARS = 420;
const MAX_NEXT_STEP_CHARS = 220;
const MAX_PRIMARY_MODULES = 8;
const MAX_SUPPORTING_MODULES = 6;
const MAX_REQUIRED_TOOLS = 6;
const MAX_MISSING_DATA = 8;
const MAX_RISK_BOUNDARIES = 6;
const MAX_REJECTED_CONTEXT = 3;
const DEFAULT_REJECTED_CONTEXT = [
  "old_lark_conversation_history",
  "language_routing_candidate_artifacts",
  "unsupported_execution_language",
];
const SOURCE_KIND_TRUST_TIERS: Record<string, string> = {
  curated_seed: "gold_curated",
  brain_distillation_review: "teacher_distillation_review",
  finance_learning_capability_apply_receipt: "workflow_receipt",
  feishu_work_receipt: "workflow_receipt",
  lark_language_handoff_receipt: "workflow_receipt",
  module_learning_plan_receipt: "plan_only_receipt",
  module_learning_review_receipt: "review_only_receipt",
  // Synthetic rule-derived rows: high internal consistency but not a real
  // receipt or human-curated gold. Kept as its own tier so the manifest never
  // conflates generated volume with real workflow evidence.
  generalization_generator: "synthetic_rule_generated",
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/local-brain-distill-dataset.ts [--workspace DIR] [--out DIR] [--max-files N] [--mix-generated N] [--generated-seed N] [--generated-holdout-fraction F] [--json]",
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
    mixGenerated: 0,
    generatedSeed: 1,
    generatedHoldoutFraction: 0.2,
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
    } else if (arg === "--mix-generated") {
      options.mixGenerated = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--generated-seed") {
      options.generatedSeed = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--generated-holdout-fraction") {
      const parsed = Number(readValue(args, index));
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
        usage();
      }
      options.generatedHoldoutFraction = parsed;
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

function trustTierForSourceKind(sourceKind: string): string {
  return SOURCE_KIND_TRUST_TIERS[sourceKind] ?? "unknown_or_unclassified";
}

function sourceKindCounts(examples: DistillExample[]): Record<string, number> {
  return examples.reduce<Record<string, number>>((acc, example) => {
    acc[example.meta.sourceKind] = (acc[example.meta.sourceKind] ?? 0) + 1;
    return acc;
  }, {});
}

function trustTierCounts(examples: DistillExample[]): Record<string, number> {
  return examples.reduce<Record<string, number>>((acc, example) => {
    const tier = trustTierForSourceKind(example.meta.sourceKind);
    acc[tier] = (acc[tier] ?? 0) + 1;
    return acc;
  }, {});
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizedContent(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function completionRecord(example: DistillExample): Record<string, unknown> | undefined {
  const parsed = safeJsonParse(example.completion);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function qualityTierForTeacherReview(example: DistillExample): string {
  const completion = completionRecord(example);
  if (!completion) {
    return "parse_invalid";
  }
  const taskFamily = readString(completion.task_family);
  const primaryModules = readStringArray(completion.primary_modules);
  const supportingModules = readStringArray(completion.supporting_modules);
  const requiredTools = readStringArray(completion.required_tools);
  const missingData = readStringArray(completion.missing_data);
  const riskBoundaries = readStringArray(completion.risk_boundaries);
  const nextStep = readString(completion.next_step);
  if (!taskFamily || primaryModules.length === 0 || !nextStep) {
    return "contract_incomplete";
  }
  if (!riskBoundaries.includes("research_only")) {
    return "boundary_incomplete";
  }
  if (missingData.length > MAX_MISSING_DATA || riskBoundaries.length > MAX_RISK_BOUNDARIES) {
    return "overwide_contract";
  }
  if (requiredTools.length === 0 && supportingModules.length === 0) {
    return "weak_tooling";
  }
  return "contract_complete_high_signal";
}

function failureFamilyForTeacherReview(example: DistillExample): string {
  const completion = completionRecord(example);
  const taskFamily = readString(completion?.task_family) ?? "";
  const primaryModules = readStringArray(completion?.primary_modules);
  const supportingModules = readStringArray(completion?.supporting_modules);
  const requiredTools = readStringArray(completion?.required_tools);
  const riskBoundaries = readStringArray(completion?.risk_boundaries);
  const text = normalizedContent(
    [taskFamily, ...primaryModules, ...supportingModules, ...requiredTools, ...riskBoundaries].join(
      " ",
    ),
  );
  if (/skill_pattern_distillation|external_agent|cli_anything|skill_harvester/u.test(text)) {
    return "agent_skill_distillation";
  }
  if (/lark|feishu|reply|visible|old_lark|context|language/u.test(text)) {
    return "lark_visible_workflow";
  }
  if (/learning|internalization|receipt|retrieval|module_learning|sedimentation/u.test(text)) {
    return "module_learning_absorption";
  }
  if (/source|vendor|provenance|filing|data_quality|timestamp|official/u.test(text)) {
    return "finance_source_quality";
  }
  if (/portfolio|risk_gate|qqq|tlt|nvda|position|weight/u.test(text)) {
    return "portfolio_risk";
  }
  if (/macro|rates|inflation|credit|liquidity|commodity|oil|gold|fx|cross_asset/u.test(text)) {
    return "macro_cross_asset";
  }
  if (/fundamental|valuation|company|margin|revenue|fcf|roic/u.test(text)) {
    return "company_fundamentals";
  }
  return "general_workflow";
}

function teacherReviewQualitySummary(examples: DistillExample[]): Record<string, unknown> {
  const teacherExamples = examples.filter(
    (example) => example.meta.sourceKind === "brain_distillation_review",
  );
  const qualityTiers: Record<string, number> = {};
  const failureFamilies: Record<string, number> = {};
  const signatureSources = new Map<string, string[]>();
  for (const example of teacherExamples) {
    qualityTiers[qualityTierForTeacherReview(example)] =
      (qualityTiers[qualityTierForTeacherReview(example)] ?? 0) + 1;
    failureFamilies[failureFamilyForTeacherReview(example)] =
      (failureFamilies[failureFamilyForTeacherReview(example)] ?? 0) + 1;
    const signature = hashText(
      `${normalizedContent(example.prompt)}\n${normalizedContent(example.completion)}`,
    );
    signatureSources.set(signature, [
      ...(signatureSources.get(signature) ?? []),
      example.meta.sourcePath,
    ]);
  }
  const duplicateGroups = [...signatureSources.entries()]
    .filter(([, sourcePaths]) => sourcePaths.length > 1)
    .map(([signature, sourcePaths]) => ({
      signature,
      count: sourcePaths.length,
      sampleSourcePaths: sourcePaths.slice(0, 5),
    }))
    .toSorted(
      (left, right) => right.count - left.count || left.signature.localeCompare(right.signature),
    );
  return {
    boundary: "local_teacher_distillation_review_quality_summary_only",
    sourceKind: "brain_distillation_review",
    total: teacherExamples.length,
    qualityTiers,
    failureFamilies,
    dedup: {
      method: "normalized_prompt_completion_sha256_16",
      uniqueContent: signatureSources.size,
      duplicateGroups: duplicateGroups.length,
      duplicateExamples: duplicateGroups.reduce((sum, group) => sum + group.count - 1, 0),
      topDuplicateGroups: duplicateGroups.slice(0, 8),
    },
    selectionBoundary:
      "teacher review quality stats guide bounded sampling; they are not promotion or absorption proof",
  };
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
  const visitedDirs = new Set<string>();
  async function walk(dir: string): Promise<void> {
    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      return;
    }
    if (visitedDirs.has(realDir)) {
      return;
    }
    visitedDirs.add(realDir);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const entryStat = await fs.lstat(fullPath).catch(() => undefined);
      if (!entryStat) {
        continue;
      }
      if (entryStat.isSymbolicLink()) {
        continue;
      }
      if (entryStat.isDirectory()) {
        await walk(fullPath);
      } else if (entryStat.isFile() && /\.(json|md)$/u.test(entry.name)) {
        result.push({ path: fullPath, mtimeMs: entryStat.mtimeMs });
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
  return JSON.stringify(value);
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function compactList(values: string[], maxItems: number): string[] {
  return uniq(values.map((entry) => entry.trim()).filter(Boolean)).slice(0, maxItems);
}

function compactText(value: string, maxChars: number): string {
  return truncate(value, maxChars);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const OVERCLAIMED_NEXT_STEP_PATTERN =
  /internet_search_engine|bloomberg|yahoo finance|fred|authenticated data feeds?|public data source|pull (?:latest|current|historical)|gather (?:latest|current|fresh)|fetch\b|retrieve .*data|obtain .*data|compute\b|time series regression|update finance_learning_memory|store in agent_workflow_memory|update source_registry|写入|沉淀到记忆|更新(?:finance_learning_memory|source_registry|causal_map)/iu;

function sanitizeNextStep(nextStep: string, missingData: string[]): string {
  if (!OVERCLAIMED_NEXT_STEP_PATTERN.test(nextStep)) {
    return nextStep;
  }
  if (
    missingData.includes("source_url_or_local_source_path") ||
    missingData.includes("actual_reading_scope_receipt")
  ) {
    return "Require a source URL or local source path plus an actual reading receipt before source-gated learning or reusable-rule extraction.";
  }
  if (
    missingData.includes("position_weights_and_return_series") ||
    missingData.includes("fresh_market_data_snapshot")
  ) {
    return "List missing data gaps, require timestamped source evidence and portfolio inputs, then route to review before any research-only summary.";
  }
  return "Clarify the objective, list missing evidence, route to review, and summarize only verified research boundaries.";
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
  return uniq([...modules, "review_panel"]);
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
  const lowerEntries = normalized.map((entry) => entry.toLowerCase());
  const hasPositionWeights = lowerEntries.some((entry) =>
    /(^|_)position_weights($|_)|current_position_weights|portfolio_weights|仓位|权重/u.test(entry),
  );
  const hasReturnSeries = lowerEntries.some((entry) =>
    /return_series|price_history|recent_returns|收益率序列|价格序列/u.test(entry),
  );
  if (hasPositionWeights && hasReturnSeries) {
    exact.push("position_weights_and_return_series");
  }
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
  const normalized = values.map(canonicalRiskBoundary).filter(Boolean);
  const hasResearchBoundary =
    normalized.includes("research_only") || normalized.includes("no_execution_authority");
  const unique = uniq(hasResearchBoundary ? normalized : [...normalized, ...BOUNDARIES]);
  const priority = [
    "research_only",
    "no_execution_authority",
    "evidence_required",
    "no_model_math_guessing",
    "no_unverified_current_market_data",
    "no_language_corpus_modification",
    "no_provider_config_change",
    "no_external_channel_sender_change",
    "no_protected_memory_write",
    "no_high_leverage_crypto",
  ];
  return compactList(
    [
      ...priority.filter((entry) => unique.includes(entry)),
      ...unique.filter((entry) => !priority.includes(entry)),
    ],
    MAX_RISK_BOUNDARIES,
  );
}

function canonicalRiskBoundary(entry: string): string {
  const normalized = entry
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (
    normalized.includes("no_high_leverage_crypto") ||
    normalized === "no_high_leverage" ||
    normalized === "no_leverage_on_crypto" ||
    normalized === "no_crypto_leverage_recommendation" ||
    normalized === "no_crypto_leverage" ||
    normalized === "crypto_no_leverage" ||
    normalized === "no_crypto_high_leverage" ||
    normalized === "do_not_execute_crypto_leverage" ||
    normalized === "no_crypto_leverage_trade_recommendation" ||
    normalized === "no_crypto_high_leverage_trading"
  ) {
    return "no_high_leverage_crypto";
  }
  if (
    normalized === "no_live_market_claims" ||
    normalized === "no_live_market_claim" ||
    normalized === "no_live_finance_advice" ||
    normalized === "no_unverified_live_data" ||
    normalized === "no_unverified_live_data_claims" ||
    normalized === "no_unverified_live_market_data_claims" ||
    normalized === "no_unverified_current_market_claims" ||
    normalized === "no_unverified_current_market_claim" ||
    normalized === "no_unverified_current_market_data_claims"
  ) {
    return "no_unverified_current_market_data";
  }
  if (
    normalized === "no_external_channel_sender_change" ||
    normalized === "no_external_channel_sender_changes" ||
    normalized === "no_lark_external_channel_sender_change" ||
    normalized === "no_live_sender_change" ||
    normalized === "no_live_sender_changes"
  ) {
    return "no_external_channel_sender_change";
  }
  if (
    normalized === "no_language_corpus_change" ||
    normalized === "no_language_corpus_changes" ||
    normalized === "no_language_corpus_modify" ||
    normalized === "no_formal_lark_routing_corpus" ||
    normalized === "no_formal_lark_routing_corpus_change"
  ) {
    return "no_language_corpus_modification";
  }
  return normalized || entry.trim();
}

function inferRiskBoundariesFromText(text: string): string[] {
  const inferred: string[] = [];
  if (/language corpus|formal_lark_routing_corpus|语言语料|路由语料/iu.test(text)) {
    inferred.push("no_language_corpus_modification");
  }
  if (
    // Accept older live-market wording in receipts, but emit the current-market boundary.
    /no live market claim|no live finance advice|unverified live data|current market claim|current market data|timestamped market data|实时行情|实时数据|live market/iu.test(
      text,
    )
  ) {
    inferred.push("no_unverified_current_market_data");
  }
  return inferred;
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
    "/no_think",
    "Do not emit chain-of-thought, markdown, or <think> blocks; output only the JSON object.",
    "Keep the JSON compact: short arrays, short next_step, no explanation inside or outside JSON.",
    `Output contract: ${LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS.join(" ")}`,
    'Use this exact compact shape: {"task_family":"snake_case","primary_modules":[],"supporting_modules":[],"required_tools":[],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"snake_case_action","rejected_context":["old_lark_conversation_history"]}',
    "Think like a careful human financial analyst: clarify objective, recall local memory and learned rules, split causal layers, identify missing evidence, route to review, then summarize for the control room.",
    "Do not invent current or timestamped market data, execution approval, or durable memory writes.",
    `Allowed module ids: ${LOCAL_BRAIN_MODULE_TAXONOMY.join(", ")}.`,
    "For finance tasks, choose concrete module ids from the allowed list instead of generic finance labels.",
    `Core planning hints: ${LOCAL_BRAIN_CONTRACT_HINTS.slice(0, 4).join(" ")}`,
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
  const packedModules = packLocalBrainModuleFields(
    params.primaryModules,
    params.supportingModules ?? [],
    params.requiredTools ?? [],
  );
  return compactJson({
    task_family: params.taskFamily,
    primary_modules: packedModules.primary_modules,
    supporting_modules: packedModules.supporting_modules,
    required_tools: packedModules.required_tools,
    missing_data: compactList(params.missingData ?? [], MAX_MISSING_DATA),
    risk_boundaries: normalizeRiskBoundaries(params.riskBoundaries ?? BOUNDARIES),
    next_step: compactText(params.nextStep, MAX_NEXT_STEP_CHARS),
    rejected_context: compactList(
      params.rejectedContext ?? DEFAULT_REJECTED_CONTEXT,
      MAX_REJECTED_CONTEXT,
    ),
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

function exampleFromModuleLearningPlanReceipt(
  parsed: Record<string, unknown>,
  sourcePath: string,
): DistillExample | undefined {
  const targetModule = readString(parsed.targetModule);
  const learningIntent = readString(parsed.learningIntent);
  const applicationTask = readString(parsed.applicationValidationTask);
  if (!targetModule || !learningIntent) {
    return undefined;
  }
  const missingEvidence = readStringArray(parsed.missingEvidence);
  const requiredInputs = readStringArray(parsed.requiredInputs);
  const safetyBoundaries = readStringArray(parsed.safetyBoundaries);
  const status = readString(parsed.status) ?? "unknown";
  const sourceSummary = truncate(
    compactJson({
      targetModule,
      moduleFamily: readString(parsed.moduleFamily),
      status,
      sourceUrlOrPath: readString(parsed.sourceUrlOrPath),
      actualReadingScope: readString(parsed.actualReadingScope),
      moduleSpecificCapabilityRule: readString(parsed.moduleSpecificCapabilityRule),
      evidenceFamilies: readStringArray(parsed.evidenceFamilies),
      missingEvidence,
      keepDownrankDiscardDecision: readString(parsed.keepDownrankDiscardDecision),
      claimBoundary: readString(parsed.claimBoundary),
    }),
    1200,
  );
  return {
    prompt: buildPrompt({
      sourceKind: "module_learning_plan_receipt",
      userAsk: applicationTask ?? learningIntent,
      sourceSummary,
    }),
    completion: buildCompletion({
      taskFamily: "module_learning_internalization",
      primaryModules: [targetModule, "finance_learning_memory", "source_registry"],
      supportingModules: ["eval_harness_design", "review_panel", "control_room_summary"],
      requiredTools: [
        "source_registry_lookup",
        "finance_learning_capability_apply",
        "local_brain_eval",
      ],
      missingData: compactList(
        [
          "module_learning_pipeline_review_status",
          "training_or_eval_absorption_evidence",
          "fresh_adjacent_application_task",
          "keep_downrank_or_discard_decision",
          ...missingEvidence,
          ...requiredInputs,
        ],
        MAX_MISSING_DATA,
      ),
      riskBoundaries: normalizeRiskBoundaries([
        ...safetyBoundaries,
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_external_channel_sender_change",
        "no_language_corpus_modification",
      ]),
      nextStep:
        status === "eval_absorbed"
          ? "keep_review_absorption_evidence_and_apply_to_fresh_adjacent_task"
          : "run_module_review_then_require_eval_absorption_and_keep_downrank_decision",
      rejectedContext: [
        "stored_source_only",
        "language_routing_candidate_artifacts",
        "old_lark_conversation_history",
      ],
    }),
    meta: {
      sourcePath,
      sourceKind: "module_learning_plan_receipt",
      generatedAt: readString(parsed.generatedAt),
    },
  };
}

function exampleFromModuleLearningReview(
  parsed: Record<string, unknown>,
  sourcePath: string,
): DistillExample[] {
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  return rows
    .slice(0, 24)
    .map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return undefined;
      }
      const record = row as Record<string, unknown>;
      const targetModule = readString(record.targetModule);
      const learningIntent = readString(record.learningIntent);
      if (!targetModule || !learningIntent) {
        return undefined;
      }
      const missingEvidence = readStringArray(record.missingEvidence);
      const safetyBoundaries = readStringArray(record.safetyBoundaries);
      const status = readString(record.status) ?? "unknown";
      const weak = readBoolean(record.weak) === true;
      const sourceSummary = truncate(
        compactJson({
          targetModule,
          status,
          weak,
          failedReason: readString(record.failedReason),
          sourceUrlOrPath: readString(record.sourceUrlOrPath),
          actualReadingScope: readString(record.actualReadingScope),
          missingEvidence,
          boundaryViolation: readBoolean(record.boundaryViolation),
          keepDownrankDiscardDecision: readString(record.keepDownrankDiscardDecision),
        }),
        1000,
      );
      return {
        prompt: buildPrompt({
          sourceKind: "module_learning_review_receipt",
          userAsk: learningIntent,
          sourceSummary,
        }),
        completion: buildCompletion({
          taskFamily: "module_learning_review_status",
          primaryModules: [targetModule, "finance_learning_memory", "source_registry"],
          supportingModules: ["eval_harness_design", "review_panel", "control_room_summary"],
          requiredTools: [
            "source_registry_lookup",
            "finance_learning_capability_apply",
            "local_brain_eval",
            "review_panel",
          ],
          missingData: compactList(
            [
              "module_learning_pipeline_review_status",
              ...(weak || status !== "eval_absorbed"
                ? [
                    "training_or_eval_absorption_evidence",
                    "fresh_adjacent_application_task",
                    "keep_downrank_or_discard_decision",
                  ]
                : []),
              ...missingEvidence,
            ],
            MAX_MISSING_DATA,
          ),
          riskBoundaries: normalizeRiskBoundaries([
            ...safetyBoundaries,
            "no_protected_memory_write",
            "no_provider_config_change",
            "no_external_channel_sender_change",
            "no_language_corpus_modification",
          ]),
          nextStep:
            weak || status !== "eval_absorbed"
              ? "hold_module_learning_claim_until_eval_absorption_evidence_exists"
              : "reuse_eval_absorbed_module_rule_on_fresh_adjacent_task",
          rejectedContext: [
            "stored_source_only",
            "language_routing_candidate_artifacts",
            "old_lark_conversation_history",
          ],
        }),
        meta: {
          sourcePath: `${sourcePath}#row-${index + 1}`,
          sourceKind: "module_learning_review_receipt",
          generatedAt: readString(parsed.generatedAt),
        },
      };
    })
    .filter((entry): entry is DistillExample => Boolean(entry));
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
  const primaryModules = compactList(
    readStringArray(accepted.proposedPrimaryModules),
    MAX_PRIMARY_MODULES,
  );
  const supportingModules = compactList(
    readStringArray(accepted.proposedSupportingModules).filter(
      (entry) => !primaryModules.includes(entry),
    ),
    MAX_SUPPORTING_MODULES,
  );
  const requiredTools = compactList(
    readStringArray(accepted.proposedRequiredTools),
    MAX_REQUIRED_TOOLS,
  );
  const missingData = compactList(readStringArray(accepted.proposedMissingData), MAX_MISSING_DATA);
  const safetyText = [
    readString(accepted.candidateText),
    readString(accepted.userMessage),
    readString(accepted.proposedNextStep),
    readString((accepted.sample as Record<string, unknown> | undefined)?.distillableText),
  ]
    .filter(Boolean)
    .join("\n");
  const riskBoundaries = normalizeRiskBoundaries([
    ...readStringArray(accepted.proposedRiskBoundaries),
    ...inferRiskBoundariesFromText(safetyText),
  ]);
  const taskFamily = readString(accepted.proposedTaskFamily) ?? "brain_distillation_candidate";
  const rawNextStep =
    readString(accepted.proposedNextStep) ??
    "route_to_concrete_modules_then_review_before_visible_reply";
  const normalizedMissingData = compactList(
    normalizeMissingDataEntries(missingData),
    MAX_MISSING_DATA,
  );
  const nextStep = compactText(
    sanitizeNextStep(rawNextStep, normalizedMissingData),
    MAX_NEXT_STEP_CHARS,
  );
  if (primaryModules.length === 0 || requiredTools.length === 0) {
    return undefined;
  }
  const sourceSummary = truncate(
    compactJson({
      candidateText: compactText(candidateText, MAX_ACCEPTED_CANDIDATE_SUMMARY_CHARS),
      taskFamily,
      primaryModules,
      supportingModules,
      requiredTools,
      missingData: normalizedMissingData,
      review: accepted.review,
      noLanguageRoutingPromotion,
    }),
    560,
  );
  return {
    prompt: buildPrompt({
      sourceKind,
      userAsk: compactText(userAsk, MAX_DISTILL_USER_ASK_CHARS),
      sourceSummary,
    }),
    completion: buildCompletion({
      taskFamily,
      primaryModules,
      supportingModules,
      requiredTools,
      missingData: normalizedMissingData,
      riskBoundaries,
      nextStep,
      rejectedContext: compactList(
        [...readStringArray(accepted.proposedRejectedContext), ...DEFAULT_REJECTED_CONTEXT],
        MAX_REJECTED_CONTEXT,
      ),
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
    if (record.boundary === "local_module_learning_pipeline_plan") {
      const example = exampleFromModuleLearningPlanReceipt(record, relativePath);
      return example ? [example] : [];
    }
    if (
      record.boundary === "module_learning_pipeline_review" ||
      record.boundary === "module_learning_pipeline_review_only"
    ) {
      return exampleFromModuleLearningReview(record, relativePath);
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

async function collectExamplesFromFiles(
  files: string[],
  workspaceDir: string,
): Promise<DistillExample[]> {
  const examples: DistillExample[] = [];
  for (const filePath of files) {
    examples.push(...(await examplesFromFile(filePath, workspaceDir)));
  }
  return examples;
}

export function splitExamples(examples: DistillExample[]): {
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
  const moduleLearning = examples
    .filter(
      (example) =>
        example.meta.sourceKind === "module_learning_plan_receipt" ||
        example.meta.sourceKind === "module_learning_review_receipt",
    )
    .toSorted((a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath));
  // Synthetic generated rows are TRAIN-ONLY: keep test/valid on the real receipt
  // distribution so eval never scores the model on its own synthetic labels, and
  // the generalization holdout stays the sole rule-vs-memorization probe.
  const generated = examples
    .filter((example) => example.meta.sourceKind === "generalization_generator")
    .toSorted((a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath));
  const sorted = examples
    .filter(
      (example) =>
        example.meta.sourceKind !== "curated_seed" &&
        example.meta.sourceKind !== "brain_distillation_review" &&
        example.meta.sourceKind !== "module_learning_plan_receipt" &&
        example.meta.sourceKind !== "module_learning_review_receipt" &&
        example.meta.sourceKind !== "generalization_generator",
    )
    .toSorted((a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath));
  const testCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const validCount = Math.max(1, Math.floor(sorted.length * 0.1));
  return {
    test: sorted.slice(0, testCount),
    valid: sorted.slice(testCount, testCount + validCount),
    train: sorted
      .slice(testCount + validCount)
      .concat(reviewedBrain, moduleLearning, curated, generated),
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
    riskBoundaries?: string[];
    nextStep: string;
  }> = [
    {
      userAsk:
        "我持有 QQQ、TLT 和少量 NVDA，未来两周担心利率、AI capex、美元流动性。先规划内部模块，不要给交易建议。",
      sourceSummary:
        "clean portfolio risk planning request; needs modules before conclusion; no current market data supplied.",
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
        "finance_framework_core_inspect",
        "finance_framework_fx_dollar_producer",
        "finance_learning_capability_apply",
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
      userAsk:
        "美国财政赤字、Treasury refunding 和美债供给如果推高 term premium，会怎么传导到 TLT、QQQ、估值和我的组合风险？只做 research-only 内部模块、证据缺口和风险门，不要交易建议。",
      sourceSummary:
        "Qwen curriculum seed for Treasury supply and term-premium risk; route through rates, credit, FX, ETF, math, data provenance, portfolio risk, and review.",
      taskFamily: "treasury_supply_term_premium_portfolio_risk",
      primaryModules: [
        "macro_rates_inflation",
        "credit_liquidity",
        "fx_currency_liquidity",
        "etf_regime",
        "global_index_regime",
        "quant_math",
        "portfolio_risk_gates",
        "finance_data_gateway",
      ],
      supportingModules: [
        "data_provenance_quality",
        "source_registry",
        "causal_map",
        "review_panel",
        "control_room_summary",
      ],
      requiredTools: [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_fx_dollar_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "treasury_issuance_refunding_and_auction_calendar",
        "term_premium_real_yield_and_curve_inputs",
        "current_rates_and_inflation_inputs",
        "source_timestamp_and_vendor",
        "target_etf_price_and_regime_inputs",
        "position_weights_and_return_series",
        "portfolio_weights_and_risk_limits",
      ],
      riskBoundaries: [
        "duration_and_term_premium_not_standalone_trade_signal",
        "risk_gate_before_action_language",
        "no_trade_advice",
        ...BOUNDARIES,
      ],
      nextStep: "route_treasury_supply_to_rates_credit_fx_etf_math_and_risk_gates_before_summary",
    },
    {
      userAsk:
        "private credit、NBFI、leveraged loans 和半流动基金如果出现赎回压力，会不会通过非银杠杆、forced deleveraging、HYG 和 QQQ 影响风险偏好？先拆内部模块、来源缺口和风险边界，不要交易建议。",
      sourceSummary:
        "Qwen curriculum seed for private credit and nonbank leverage stress; route through credit, cross-asset liquidity, ETF regime, data provenance, portfolio risk, and review.",
      taskFamily: "private_credit_nonbank_leverage_stress_waterflow",
      primaryModules: [
        "credit_liquidity",
        "cross_asset_liquidity",
        "etf_regime",
        "global_index_regime",
        "quant_math",
        "portfolio_risk_gates",
        "finance_data_gateway",
        "data_provenance_quality",
      ],
      supportingModules: [
        "source_registry",
        "causal_map",
        "finance_learning_memory",
        "review_panel",
        "control_room_summary",
      ],
      requiredTools: [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "private_credit_borrower_stress_and_valuation_inputs",
        "nonbank_leverage_and_redemption_pressure_inputs",
        "credit_spreads_funding_and_liquidity_inputs",
        "leveraged_etf_or_semiliquid_structure_exposure_map",
        "source_timestamp_and_vendor",
        "portfolio_weights_and_risk_limits",
      ],
      riskBoundaries: [
        "private_credit_or_nbfi_stress_not_standalone_alpha",
        "liquidity_mismatch_requires_source_and_review",
        "risk_gate_before_action_language",
        "no_trade_advice",
        ...BOUNDARIES,
      ],
      nextStep: "map_private_credit_and_nonbank_leverage_to_liquidity_etf_risk_gates_and_review",
    },
    {
      userAsk:
        "AI capex、hyperscaler 预算、数据中心电力瓶颈、HBM 供应链和 QQQ 指数集中度如果一起变化，本地大脑要怎么拆 NVDA 基本面、供应链、电力约束、指数权重、组合风险和反方证据？",
      sourceSummary:
        "Qwen curriculum seed for AI capex infrastructure and index-concentration risk; route through fundamentals, valuation QC, event lifecycle, energy constraints, index regime, data provenance, portfolio risk, and review.",
      taskFamily: "ai_capex_power_grid_index_concentration_risk",
      primaryModules: [
        "company_fundamentals_value",
        "financial_modeling_valuation_qc",
        "thesis_catalyst_lifecycle",
        "event_driven",
        "global_index_regime",
        "us_equity_market_structure",
        "commodities_oil_gold",
        "portfolio_risk_gates",
      ],
      supportingModules: [
        "finance_data_gateway",
        "data_provenance_quality",
        "source_registry",
        "causal_map",
        "review_panel",
        "control_room_summary",
      ],
      requiredTools: [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_event_driven_producer",
        "finance_framework_commodities_oil_gold_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "hyperscaler_capex_guidance_and_budget_sources",
        "data_center_power_grid_and_energy_constraint_inputs",
        "supply_chain_hbm_gpu_delivery_and_inventory_inputs",
        "index_weight_concentration_and_overlap_inputs",
        "latest_company_fundamental_inputs",
        "model_assumptions_sensitivity_and_audit_inputs",
        "portfolio_weights_and_risk_limits",
        "thesis_catalyst_calendar_and_invalidation_evidence",
      ],
      riskBoundaries: [
        "ai_capex_story_not_standalone_alpha",
        "index_concentration_requires_weights_evidence",
        "no_unverified_filing_claims",
        "risk_gate_before_action_language",
        "no_trade_advice",
        ...BOUNDARIES,
      ],
      nextStep:
        "connect_ai_capex_to_fundamentals_power_supply_chain_index_concentration_and_portfolio_risk",
    },
    {
      userAsk:
        "霍尔木兹、OPEC 或原油库存冲击如果推高能源价格和 CPI/PCE 通胀，会怎么传导到美元、TLT、QQQ、股债相关性和我的组合风险？先拆来源、模块、水路和风险门，不要交易建议。",
      sourceSummary:
        "Qwen curriculum seed for energy supply shock; route through commodity supply data, inflation, FX, cross-asset liquidity, ETF regime, equity-bond hedge failure, portfolio risk, and review.",
      taskFamily: "energy_inflation_cross_asset_shock_risk",
      primaryModules: [
        "commodities_oil_gold",
        "macro_rates_inflation",
        "credit_liquidity",
        "cross_asset_liquidity",
        "fx_currency_liquidity",
        "etf_regime",
        "global_index_regime",
        "portfolio_risk_gates",
      ],
      supportingModules: [
        "finance_data_gateway",
        "data_provenance_quality",
        "source_registry",
        "causal_map",
        "review_panel",
        "control_room_summary",
      ],
      requiredTools: [
        "source_registry_lookup",
        "finance_data_gateway_snapshot",
        "finance_framework_commodities_oil_gold_producer",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_fx_dollar_producer",
        "finance_framework_portfolio_risk_gates_producer",
        "review_panel",
      ],
      missingData: [
        "oil_supply_demand_inventory_and_spare_capacity_inputs",
        "energy_inflation_cpi_pce_and_expectations_inputs",
        "source_timestamp_and_vendor",
        "current_rates_and_inflation_inputs",
        "fx_dollar_and_cross_asset_liquidity_inputs",
        "target_etf_price_and_regime_inputs",
        "portfolio_weights_and_risk_limits",
      ],
      riskBoundaries: [
        "commodity_framework_not_trade_signal",
        "supply_shock_requires_official_or_primary_source",
        "equity_bond_hedge_may_fail_under_supply_shock",
        "risk_gate_before_action_language",
        "no_trade_advice",
        ...BOUNDARIES,
      ],
      nextStep: "route_energy_supply_shock_to_inflation_fx_etf_and_portfolio_risk_review",
    },
    {
      userAsk:
        "本地训练池 6818、训练切片 2960、curated_seed 192、teacher review 6234、eval 213/213，这些分别代表什么？不要把样本数、训练权重和通过证明混在一起。",
      sourceSummary:
        "Qwen curriculum seed for local-brain sample trust accounting; separate dataset pool, train-slice weighting, gold samples, teacher material, and eval proof.",
      taskFamily: "local_brain_sample_trust_accounting",
      primaryModules: ["agent_workflow_memory", "eval_harness_design", "review_panel"],
      supportingModules: ["control_room_summary", "source_registry"],
      requiredTools: ["local_brain_training_plan", "local_brain_dataset_manifest", "review_panel"],
      missingData: [
        "current_dataset_manifest",
        "current_train_slice_manifest",
        "latest_hardened_eval_summary",
      ],
      riskBoundaries: [
        ...BOUNDARIES,
        "dataset_count_not_quality_claim",
        "teacher_review_not_absorption_proof",
        "eval_pass_not_training_sample_count",
      ],
      nextStep:
        "read_dataset_and_slice_manifests_then_report_gold_teacher_receipt_and_eval_proof_separately",
    },
    {
      userAsk:
        "老师蒸馏样本越堆越多，会不会把本地脑带偏？先做质量分层、去重、按失败族抽样，不要全量压过金样本。",
      sourceSummary:
        "Qwen curriculum seed for teacher-distillation quality control; teacher material must be bounded, stratified, deduped, and downstream-eval gated.",
      taskFamily: "teacher_distillation_quality_control",
      primaryModules: ["eval_harness_design", "agent_workflow_memory", "review_panel"],
      supportingModules: ["source_registry", "control_room_summary"],
      requiredTools: [
        "local_brain_train_slice_builder",
        "teacher_review_quality_audit",
        "review_panel",
      ],
      missingData: [
        "teacher_review_failure_family_counts",
        "duplicate_or_near_duplicate_teacher_reviews",
        "downstream_eval_family_coverage",
      ],
      riskBoundaries: [
        ...BOUNDARIES,
        "do_not_train_unbounded_teacher_style",
        "quality_tier_before_weight",
        "promotion_requires_eval_not_teacher_acceptance",
      ],
      nextStep:
        "stratify_teacher_reviews_by_quality_and_failure_family_before_selecting_bounded_train_slice",
    },
    {
      userAsk:
        "如果新增了商品、期权、仓位、外部学习这些蒸馏样本，怎么确认不是只存了教材而是真的会了？",
      sourceSummary:
        "Qwen curriculum seed for eval-family expansion after new training material; every new capability family needs adjacent eval proof.",
      taskFamily: "eval_family_expansion_after_training_material",
      primaryModules: ["eval_harness_design", "finance_learning_memory", "review_panel"],
      supportingModules: ["source_registry", "control_room_summary"],
      requiredTools: ["local_brain_hardened_eval", "targeted_eval_case_selector", "review_panel"],
      missingData: [
        "new_training_material_family_ids",
        "adjacent_prerequisite_eval_cases",
        "latest_candidate_failed_or_recovered_case_ids",
      ],
      riskBoundaries: [
        ...BOUNDARIES,
        "stored_material_not_learned_capability",
        "simple_prerequisite_eval_required",
        "parse_recovered_blocks_promotion",
      ],
      nextStep:
        "map_new_material_to_prerequisite_and_adjacent_eval_cases_before_claiming_absorption",
    },
    {
      userAsk:
        "module-learning plan receipt 和 review receipt 都进了训练池，这是不是说明模块已经学会了？",
      sourceSummary:
        "Qwen curriculum seed for module-learning truth boundary; plan/review receipts are workflow evidence, not eval-absorbed learning.",
      taskFamily: "module_learning_receipt_truth_boundary",
      primaryModules: ["finance_learning_memory", "source_registry", "review_panel"],
      supportingModules: ["eval_harness_design", "control_room_summary"],
      requiredTools: [
        "module_learning_pipeline_review",
        "module_learning_absorption_gate",
        "local_brain_eval",
      ],
      missingData: [
        "retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
        "fresh_adjacent_application_task",
      ],
      riskBoundaries: [
        ...BOUNDARIES,
        "plan_receipt_not_absorption",
        "review_receipt_not_live_capability",
        "keep_downrank_or_discard_required",
      ],
      nextStep:
        "report_plan_review_application_and_eval_absorption_as_separate_statuses_before_any_learning_claim",
    },
    {
      userAsk: "能不能直接告诉我该不该买 NVDA？",
      sourceSummary:
        "short finance boundary seed; buy/sell wording must become research-only gaps, risk gates, and no trade advice.",
      taskFamily: "plain_buy_sell_research_boundary",
      primaryModules: ["company_fundamentals_value", "portfolio_risk_gates", "review_panel"],
      supportingModules: ["source_registry", "control_room_summary"],
      requiredTools: ["finance_data_gateway_snapshot", "review_panel"],
      missingData: [
        "latest_10q_10k_or_earnings_release",
        "position_weights_cost_basis_and_risk_limits",
        "fresh_market_data_snapshot",
      ],
      riskBoundaries: [...BOUNDARIES, "no_trade_advice", "risk_gate_before_action_language"],
      nextStep: "convert_buy_sell_request_to_research_plan_and_missing_inputs",
    },
    {
      userAsk: "现在大盘怎么样，一句话说。",
      sourceSummary:
        "short market-status seed; must not invent current market data or skip source timestamps.",
      taskFamily: "plain_recent_market_brief_boundary",
      primaryModules: ["macro_rates_inflation", "etf_regime", "portfolio_risk_gates"],
      supportingModules: ["finance_data_gateway", "source_registry", "control_room_summary"],
      requiredTools: ["finance_data_gateway_snapshot", "review_panel"],
      missingData: ["fresh_market_data_snapshot", "source_timestamp_and_vendor"],
      riskBoundaries: [...BOUNDARIES, "no_unverified_current_market_claims", "no_trade_advice"],
      nextStep: "request_or_collect_timestamped_market_snapshot_before_summary",
    },
    {
      userAsk: "我只有 6818 个样本，是不是都很高质量？",
      sourceSummary:
        "sample-count boundary seed; total pool count is not quality, weighting, or promotion proof.",
      taskFamily: "dataset_count_quality_boundary",
      primaryModules: ["agent_workflow_memory", "eval_harness_design", "review_panel"],
      supportingModules: ["control_room_summary"],
      requiredTools: ["local_brain_dataset_manifest", "local_brain_train_slice_manifest"],
      missingData: ["sample_trust_tier_counts", "teacher_review_quality_summary"],
      riskBoundaries: [
        ...BOUNDARIES,
        "dataset_count_not_quality_claim",
        "sample_source_kind_required",
      ],
      nextStep: "separate_pool_count_source_tier_slice_weight_and_eval_proof",
    },
    {
      userAsk: "teacher review 有 6000 多条，那是不是比 curated_seed 更可靠？",
      sourceSummary:
        "teacher-vs-gold seed; teacher volume must not outrank hand-curated gold samples without quality and eval gates.",
      taskFamily: "teacher_volume_not_gold_quality",
      primaryModules: ["eval_harness_design", "review_panel", "agent_workflow_memory"],
      supportingModules: ["source_registry", "control_room_summary"],
      requiredTools: ["teacher_review_quality_audit", "local_brain_train_slice_manifest"],
      missingData: ["teacher_review_quality_tiers", "duplicate_teacher_review_groups"],
      riskBoundaries: [
        ...BOUNDARIES,
        "teacher_volume_not_quality",
        "curated_seed_highest_trust",
        "promotion_requires_eval_not_teacher_acceptance",
      ],
      nextStep: "rank_teacher_reviews_by_quality_and_keep_curated_seed_as_highest_trust",
    },
    {
      userAsk: "训练切片 2960 是不是等于只学了 2960 条？",
      sourceSummary:
        "train-slice weighting seed; slice rows are weighted training input, not unique sample count or learning proof.",
      taskFamily: "train_slice_weighting_boundary",
      primaryModules: ["agent_workflow_memory", "eval_harness_design"],
      supportingModules: ["control_room_summary", "review_panel"],
      requiredTools: ["local_brain_train_slice_manifest"],
      missingData: ["source_train_count", "written_source_kind_counts", "repeat_policy"],
      riskBoundaries: [
        ...BOUNDARIES,
        "train_slice_rows_not_unique_samples",
        "training_input_not_absorption_proof",
      ],
      nextStep: "report_unique_pool_slice_written_rows_repeat_policy_and_eval_separately",
    },
    {
      userAsk: "213/213 过了，是不是新知识都已经吸收了？",
      sourceSummary:
        "eval-proof boundary seed; passing current eval proves behavior on covered cases only, not all new knowledge.",
      taskFamily: "eval_pass_coverage_boundary",
      primaryModules: ["eval_harness_design", "review_panel"],
      supportingModules: ["finance_learning_memory", "control_room_summary"],
      requiredTools: ["local_brain_hardened_eval", "eval_registry_suite_summary"],
      missingData: ["eval_capability_suite_coverage", "new_material_family_to_case_map"],
      riskBoundaries: [
        ...BOUNDARIES,
        "eval_pass_not_universal_absorption",
        "coverage_family_required",
      ],
      nextStep: "map_passed_cases_to_capability_suites_before_absorption_claim",
    },
    {
      userAsk: "parseRecovered 也算能用吧？",
      sourceSummary:
        "promotion cleanliness seed; parseRecovered blocks promotion and must not become runtime capability proof.",
      taskFamily: "parse_recovered_promotion_boundary",
      primaryModules: ["eval_harness_design", "review_panel"],
      supportingModules: ["control_room_summary"],
      requiredTools: ["local_brain_hardened_eval", "promotion_audit"],
      missingData: ["parse_recovered_case_ids", "failed_case_ids"],
      riskBoundaries: [
        ...BOUNDARIES,
        "parse_recovered_blocks_promotion",
        "single_clean_adapter_only",
      ],
      nextStep: "keep_clean_champion_until_no_failed_parse_or_recovered_cases",
    },
    {
      userAsk: "Lark 里我说“最近市场”，它能不能自动知道我指 QQQ/TLT/NVDA？",
      sourceSummary:
        "short Lark context seed; local memory may cue scope but must not invent current data or old chat facts.",
      taskFamily: "short_lark_market_scope_boundary",
      primaryModules: ["control_room_summary", "finance_learning_memory", "portfolio_risk_gates"],
      supportingModules: ["source_registry", "review_panel"],
      requiredTools: ["memory_recall_scope", "finance_data_gateway_snapshot", "review_panel"],
      missingData: ["memory_recall_scope_or_relevant_receipts", "fresh_market_data_snapshot"],
      riskBoundaries: [
        ...BOUNDARIES,
        "old_lark_context_rejected",
        "no_unverified_current_market_claims",
      ],
      nextStep: "use_relevant_memory_scope_then_require_fresh_data_for_current_market",
    },
    {
      userAsk: "我问“大宗商品”，别只回答原油，要怎么分模块？",
      sourceSummary:
        "commodity scope seed; commodities route through oil, gold, inflation, FX, and portfolio risk before summary.",
      taskFamily: "commodity_scope_module_boundary",
      primaryModules: [
        "commodities_oil_gold",
        "macro_rates_inflation",
        "fx_currency_liquidity",
        "portfolio_risk_gates",
      ],
      supportingModules: ["finance_data_gateway", "source_registry", "review_panel"],
      requiredTools: ["finance_data_gateway_snapshot", "review_panel"],
      missingData: [
        "commodity_sub_asset_scope",
        "source_timestamp_and_vendor",
        "portfolio_exposure_context_if_relevant",
      ],
      riskBoundaries: [...BOUNDARIES, "commodity_framework_not_trade_signal", "no_trade_advice"],
      nextStep: "clarify_commodity_scope_then_route_to_macro_fx_and_portfolio_risk",
    },
    {
      userAsk: "期权 IV 很高，是不是该卖波动率？",
      sourceSummary:
        "options boundary seed; options research cannot become execution or sizing advice.",
      taskFamily: "options_volatility_execution_boundary",
      primaryModules: ["options_volatility", "portfolio_risk_gates", "review_panel"],
      supportingModules: ["finance_data_gateway", "source_registry", "control_room_summary"],
      requiredTools: ["finance_data_gateway_snapshot", "review_panel"],
      missingData: [
        "options_chain_timestamp_and_vendor",
        "position_weights_and_risk_limits",
        "volatility_regime_inputs",
      ],
      riskBoundaries: [...BOUNDARIES, "no_options_execution_advice", "no_trade_advice"],
      nextStep: "frame_iv_as_research_risk_not_trade_execution",
    },
    {
      userAsk: "我应该加仓还是减仓？",
      sourceSummary:
        "position sizing boundary seed; missing portfolio inputs must block action language.",
      taskFamily: "position_sizing_missing_inputs_boundary",
      primaryModules: ["portfolio_risk_gates", "quant_math", "review_panel"],
      supportingModules: ["finance_data_gateway", "control_room_summary"],
      requiredTools: ["portfolio_risk_snapshot", "review_panel"],
      missingData: [
        "position_weights_cost_basis_and_risk_limits",
        "return_series_or_price_history",
        "invalidation_level_or_rebalance_rule",
      ],
      riskBoundaries: [...BOUNDARIES, "risk_gate_before_action_language", "no_trade_advice"],
      nextStep: "ask_for_portfolio_inputs_and_return_research_only_risk_framework",
    },
    {
      userAsk: "网上有人说 AI capex 要崩，直接记住这个结论吗？",
      sourceSummary:
        "alternative source seed; social or blog claims stay hypothesis-only until source and follow-through checks pass.",
      taskFamily: "alternative_source_hypothesis_boundary",
      primaryModules: ["source_registry", "company_fundamentals_value", "review_panel"],
      supportingModules: ["causal_map", "portfolio_risk_gates"],
      requiredTools: ["source_registry_record", "review_panel"],
      missingData: [
        "source_url_or_local_source_path",
        "source_reliability_grade",
        "official_followup_or_primary_source",
      ],
      riskBoundaries: [
        ...BOUNDARIES,
        "alternative_source_hypothesis_only",
        "no_standalone_alpha_from_social_claims",
      ],
      nextStep: "treat_attention_story_as_hypothesis_until_source_and_followthrough_proof",
    },
    {
      userAsk: "研报目标价很高，本地脑能直接学成买入规则吗？",
      sourceSummary:
        "sell-side report seed; target price is not doctrine without assumptions, sensitivity, red team, and review.",
      taskFamily: "analyst_report_learning_boundary",
      primaryModules: ["source_registry", "financial_modeling_valuation_qc", "review_panel"],
      supportingModules: ["company_fundamentals_value", "portfolio_risk_gates"],
      requiredTools: [
        "source_registry_record",
        "finance_learning_retrieval_review",
        "review_panel",
      ],
      missingData: [
        "source_url_or_local_source_path",
        "assumptions_and_valuation_sensitivity",
        "red_team_invalidation_evidence",
      ],
      riskBoundaries: [
        ...BOUNDARIES,
        "analyst_target_not_trade_rule",
        "keep_downrank_or_discard_required",
      ],
      nextStep: "extract_assumptions_sensitivity_and_red_team_before_any_reusable_rule",
    },
    {
      userAsk: "如果两个数据源 ETF 权重不一样，就用哪个？",
      sourceSummary:
        "data conflict seed; ETF weights require issuer/official priority, timestamps, field definitions, and units.",
      taskFamily: "etf_weight_data_conflict_boundary",
      primaryModules: ["data_provenance_quality", "etf_regime", "portfolio_risk_gates"],
      supportingModules: ["source_registry", "review_panel"],
      requiredTools: ["finance_data_gateway_snapshot", "source_registry_lookup", "review_panel"],
      missingData: [
        "source_timestamp_and_vendor",
        "field_definition_and_adjusted_status",
        "official_or_issuer_reference",
      ],
      riskBoundaries: [...BOUNDARIES, "vendor_conflict_requires_provenance_gate"],
      nextStep: "prefer_official_scope_after_timestamp_field_and_unit_reconciliation",
    },
    {
      userAsk: "有一条 receipt 就能证明 live 修好了吗？",
      sourceSummary:
        "worktree/external-channel boundary seed; receipts prove local artifacts, not user-visible Lark behavior.",
      taskFamily: "receipt_not_live_visible_boundary",
      primaryModules: ["ops_audit", "lark_live_loop_debugger", "review_panel"],
      supportingModules: ["control_room_summary"],
      requiredTools: ["lark_loop_diagnose", "feishu_reply_flow_audit"],
      missingData: ["fresh_real_lark_inbound_and_outbound_seen", "live_runtime_restart_proof"],
      riskBoundaries: [...BOUNDARIES, "local_fixed_not_live_visible_fixed"],
      nextStep: "require_fresh_lark_inbound_outbound_before_live_visible_claim",
    },
    {
      userAsk: "能不能把 r6 的能力和 r2 一起用，两个 LoRA 不是更强吗？",
      sourceSummary:
        "adapter monotonicity seed; runtime must not serve dirty ensembles or parseRecovered challengers.",
      taskFamily: "single_clean_adapter_runtime_boundary",
      primaryModules: ["eval_harness_design", "review_panel"],
      supportingModules: ["control_room_summary"],
      requiredTools: ["promotion_audit", "local_brain_hardened_eval"],
      missingData: ["latest_clean_adapter", "latest_candidate_failed_or_recovered_case_ids"],
      riskBoundaries: [
        ...BOUNDARIES,
        "single_clean_adapter_only",
        "no_dirty_lora_ensemble",
        "parse_recovered_blocks_promotion",
      ],
      nextStep: "keep_selected_clean_adapter_until_challenger_passes_full_clean_promotion",
    },
    {
      userAsk: "训练还在跑时，能不能顺手重建切片或跑 eval？",
      sourceSummary:
        "overlap prevention seed; active guard/eval/MLX blocks rebuild, eval, provider writes, and live apply.",
      taskFamily: "heavy_process_overlap_boundary",
      primaryModules: ["ops_audit", "eval_harness_design", "agent_workflow_memory"],
      supportingModules: ["control_room_summary"],
      requiredTools: ["local_brain_training_plan", "process_check"],
      missingData: ["active_guard_eval_or_mlx_pid_state"],
      riskBoundaries: [...BOUNDARIES, "do_not_start_overlapping_training_or_eval"],
      nextStep: "check_active_pids_and_wait_for_idle_before_heavy_work",
    },
    {
      userAsk: "teacher 样本重复很多，会不会训练时反复灌同一种错法？",
      sourceSummary:
        "teacher dedup seed; duplicate review content needs hash stats and bounded sampling before training.",
      taskFamily: "teacher_review_dedup_boundary",
      primaryModules: ["eval_harness_design", "agent_workflow_memory", "review_panel"],
      supportingModules: ["source_registry", "control_room_summary"],
      requiredTools: ["teacher_review_quality_audit", "local_brain_train_slice_manifest"],
      missingData: ["duplicate_teacher_review_groups", "failure_family_counts"],
      riskBoundaries: [...BOUNDARIES, "dedup_before_teacher_weight", "quality_tier_before_weight"],
      nextStep: "hash_teacher_reviews_and_sample_by_failure_family_before_weighting",
    },
    {
      userAsk: "如果 eval 总分过了，但金融边界族没覆盖，能上线吗？",
      sourceSummary:
        "eval suite seed; total score must be broken down by capability family before runtime or learning claims.",
      taskFamily: "eval_suite_family_coverage_boundary",
      primaryModules: ["eval_harness_design", "review_panel"],
      supportingModules: ["portfolio_risk_gates", "control_room_summary"],
      requiredTools: ["local_brain_hardened_eval", "eval_registry_suite_summary"],
      missingData: ["capability_suite_pass_rates", "finance_boundary_case_coverage"],
      riskBoundaries: [
        ...BOUNDARIES,
        "total_eval_score_not_enough",
        "capability_family_coverage_required",
      ],
      nextStep: "report_suite_level_pass_fail_before_any_runtime_or_absorption_claim",
    },
    {
      userAsk: "如果一个复杂题过了，简单前置题没测，可以算进步吗？",
      sourceSummary:
        "monotonic eval seed; complex capability requires simple prerequisite and adjacent case proof.",
      taskFamily: "monotonic_prerequisite_eval_boundary",
      primaryModules: ["eval_harness_design", "review_panel"],
      supportingModules: ["control_room_summary"],
      requiredTools: ["local_brain_hardened_eval", "targeted_eval_case_selector"],
      missingData: ["simple_prerequisite_case", "adjacent_non_identical_scenario"],
      riskBoundaries: [
        ...BOUNDARIES,
        "simple_prerequisite_eval_required",
        "proof_required_before_claiming_transfer",
      ],
      nextStep: "run_prerequisite_and_adjacent_eval_with_complex_case",
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
      userAsk:
        "帮这个本地 agent 结构学习网上开源的 SKILL.md 工作流和本地已有 skills：先找候选、隔离审计、沉淀成可复用技能和本地大脑训练样本，不要改 provider config、外部通道发送器或 protected memory。",
      sourceSummary:
        "agent-skill distillation request requiring source review, isolated local skill install, eval harness, and protected-memory guardrails.",
      taskFamily: "agent_skill_pattern_distillation",
      primaryModules: [
        "skill_pattern_distillation",
        "agent_workflow_memory",
        "source_registry",
        "review_panel",
      ],
      supportingModules: ["eval_harness_design", "control_room_summary", "finance_learning_memory"],
      requiredTools: [
        "skill_harvester",
        "source_registry_lookup",
        "skill_isolation_review",
        "local_brain_eval",
        "review_panel",
      ],
      missingData: [
        "candidate_skill_source_or_local_skill_path",
        "target_workflow_acceptance_metric",
        "license_and_write_scope_review",
      ],
      riskBoundaries: [
        ...BOUNDARIES,
        "untrusted_external_skill",
        "evaluate_before_installing",
        "no_protected_memory_write",
        "no_provider_config_change",
        "no_external_channel_sender_change",
        "no_trading_execution_skill",
      ],
      nextStep:
        "collect_candidate_skill_sources_review_license_and_write_scope_then_distill_safe_workflow_into_local_skill_and_eval_case",
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
      riskBoundaries: seed.riskBoundaries ?? BOUNDARIES,
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

// Build DistillExample rows from the infinite generalization stream, drawn from
// the generator's TRAIN split so they never overlap the harness holdout probe.
// Each row is validated against its own case with scorePlan() before it is
// admitted, so a self-inconsistent synthetic label can never enter the training
// pool (fail closed instead of training the model toward a rejected answer).
export function buildGeneratedExamples(
  count: number,
  seed: number,
  holdoutFraction: number,
): DistillExample[] {
  const cases = generateCases(count, { seed, split: "train", holdoutFraction });
  const examples: DistillExample[] = [];
  for (const generated of cases) {
    const row = toDatasetRow(generated);
    const plan = JSON.parse(row.completion) as Parameters<typeof scorePlan>[0];
    const verdict = scorePlan(plan, generated);
    if (!verdict.ok) {
      throw new Error(
        `generated completion fails its own scorer for ${generated.id}: ${verdict.reasons.join(";")}`,
      );
    }
    examples.push({
      prompt: row.prompt,
      completion: row.completion,
      meta: {
        sourcePath: `generalization-generator/${generated.id}.json`,
        sourceKind: "generalization_generator",
      },
    });
  }
  return examples;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

async function writeJsonl(filePath: string, examples: DistillExample[]): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await fs.open(tempPath, "w");
  try {
    for (const example of examples) {
      await handle.write(
        `${JSON.stringify({
          prompt: example.prompt,
          completion: example.completion,
          meta: example.meta,
        })}\n`,
      );
    }
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const memoryDir = path.join(options.workspaceDir, "memory");
  const roots = [
    path.join(memoryDir, "lark-language-handoff-receipts"),
    path.join(memoryDir, "finance-learning-apply-usage-receipts"),
    path.join(memoryDir, "feishu-work-receipts"),
    path.join(memoryDir, "lark-brain-distillation-candidates"),
    path.join(memoryDir, "lark-brain-distillation-reviews"),
    path.join(memoryDir, "module-learning-pipeline-plan-receipts"),
    path.join(memoryDir, "module-learning-pipeline-reviews"),
  ];
  const files = (
    await Promise.all(roots.map((root) => collectFiles(root, options.maxFiles)))
  ).flat();
  const generatedExamples =
    options.mixGenerated > 0
      ? buildGeneratedExamples(
          options.mixGenerated,
          options.generatedSeed,
          options.generatedHoldoutFraction,
        )
      : [];
  const examples = (await collectExamplesFromFiles(files, options.workspaceDir))
    .concat(buildSeedExamples())
    .concat(generatedExamples);

  if (examples.length < 3) {
    throw new Error(`Not enough distillation examples: ${examples.length}`);
  }

  const splits = splitExamples(examples);
  await fs.mkdir(options.outDir, { recursive: true });
  await writeJsonl(path.join(options.outDir, "train.jsonl"), splits.train);
  await writeJsonl(path.join(options.outDir, "valid.jsonl"), splits.valid);
  await writeJsonl(path.join(options.outDir, "test.jsonl"), splits.test);

  const allSourceKinds = sourceKindCounts(examples);
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
    sourceKinds: allSourceKinds,
    trainSourceKinds: sourceKindCounts(splits.train),
    generatedMix: {
      boundary: "synthetic_rule_generated_train_only",
      requested: options.mixGenerated,
      admitted: generatedExamples.length,
      seed: options.generatedSeed,
      holdoutFraction: options.generatedHoldoutFraction,
      split: "train",
      inTestOrValid: false,
      note: "Infinite-stream rows are self-scored before admission and mixed into the train pool only; test/valid stay on the real receipt distribution and the generalization holdout stays the sole rule-vs-memorization probe.",
    },
    teacherReviewQuality: teacherReviewQualitySummary(examples),
    sampleTrust: {
      boundary: "local_brain_sample_trust_summary_only",
      sourceTrustTiers: SOURCE_KIND_TRUST_TIERS,
      sourceTrustTierCounts: trustTierCounts(examples),
      trainTrustTierCounts: trustTierCounts(splits.train),
      highestTrustSourceKind: "curated_seed",
      largestTeacherSourceKind: "brain_distillation_review",
      hardEvalProofSeparateFromTrainingSamples: true,
      teacherDistillationIsTrainingMaterialNotPromotionProof: true,
      planAndReviewReceiptsAreWorkflowEvidenceNotAbsorptionProof: true,
      recommendedNextHardening: [
        "expand_curated_seed_gold_set",
        "keep_teacher_reviews_bounded_in_train_slice",
        "stratify_teacher_reviews_by_failure_family_and_quality",
        "grow_hardened_eval_by_capability_family",
      ],
    },
    notTouched: [
      "external_channel_sender",
      "provider_config",
      "protected_repo_memory",
      "formal_lark_routing_corpus",
      "finance_doctrine",
    ],
  };
  await writeFileAtomic(path.join(options.outDir, "manifest.json"), `${compactJson(manifest)}\n`);

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
}

// Only run the build when invoked directly, so tests can import the exported
// helpers without triggering a dataset write (mirrors lcx-agent-exam.ts guard).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
