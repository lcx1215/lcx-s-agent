// Local-brain generalization harness (philosophy: make "learn the rule" cheaper
// than "memorize the 213 fixed cases").
//
// The existing eval (scripts/operator/local-brain-distill-eval.ts) trains/measures
// Qwen on a FIXED bank of ~96 hand-written EvalCases. A 0.6B model's lowest-loss
// solution on a fixed bank is a lookup table, which is exactly why it stays
// brittle. This module attacks that at the root:
//
//   1. A feature space: each task is a vector of independent features
//      (asset classes, whether data was supplied, learning vs research intent,
//      trade wording, cross-market, old-context pollution, ...).
//   2. A DETERMINISTIC label rule feature-vector -> (requiredModules,
//      minModuleMatches, requiredMissingData, requiredRiskBoundaries,
//      forbiddenModules). Because the label is a pure function of the features,
//      we can generate infinite (ask, label) pairs — memorization becomes
//      impossible, the rule becomes the cheapest solution.
//   3. Template + paraphrase rendering of the natural-language ask, so surface
//      form varies while the underlying label is invariant.
//   4. A seeded RNG + a held-out split keyed on the feature signature, so the
//      test set contains feature COMBINATIONS the training stream never emits.
//      That is what actually quantifies "did it learn the rule, or memorize?".
//
// It also ships a reference scorer that mirrors evaluate() in the eval script,
// so a model's JSON plan can be graded against generated cases with the same
// 7-condition contract used in production.

import {
  LOCAL_BRAIN_CONTRACT_HINTS,
  LOCAL_BRAIN_MODULE_TAXONOMY,
  LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS,
  packLocalBrainModuleFields,
} from "./local-brain-taxonomy.js";

export type AssetClass =
  | "us_equity"
  | "a_share"
  | "index"
  | "etf"
  | "crypto"
  | "commodity"
  | "fx"
  | "options"
  | "bond_duration";

// The independent feature axes. A concrete task is one point in this space.
export type TaskFeatures = {
  assetClasses: AssetClass[];
  dataSupplied: boolean; // did the user provide a fresh, timestamped data source?
  learningRequest: boolean; // "learn this paper / repo" style intake
  sourceSupplied: boolean; // for learning: was a URL / local path given?
  tradeWording: boolean; // buy/sell/add/position-size wording present
  portfolioContext: boolean; // user mentions holdings / weights
  crossMarket: boolean; // spans >= 2 distinct markets (us/a-share/index/crypto)
  oldContextPollution: boolean; // prior External thread that must be rejected
  redTeam: boolean; // explicit invalidation / counter-thesis requested
  // Production-aligned semantic dimensions (only meaningful with a company/asset):
  fundamentalsDeep: boolean; // value-investing / deep fundamental research intent
  eventRisk: boolean; // earnings / FOMC / CPI event-driven framing
  technicalTiming: boolean; // chart / price-volume timing framing
  valuationModeling: boolean; // DCF / comps / financial-model build request
  // Meta-skill: a terse plain-language phrase that must be abstracted into a
  // problem family (original example -> failure family -> adjacent scenario ->
  // shared contract -> regression proof) BEFORE any literal short answer.
  abstractionTransfer: boolean;
};

export type GeneratedCase = {
  id: string;
  userAsk: string;
  sourceSummary: string;
  features: TaskFeatures;
  // Same shape the eval scorer consumes:
  requiredModules: string[];
  forbiddenModules: string[];
  minModuleMatches: number;
  requiredMissingData: string[];
  requiredRiskBoundaries: string[];
  // The signature used for train/test partitioning.
  featureSignature: string;
};

const MODULE_SET = new Set<string>(LOCAL_BRAIN_MODULE_TAXONOMY);

function assertModule(id: string): string {
  if (!MODULE_SET.has(id)) {
    throw new Error(`generator referenced unknown module id: ${id}`);
  }
  return id;
}

// Map each asset class to its dedicated market-structure module(s). Mirrors the
// "do not collapse into generic macro/ETF labels" doctrine in the taxonomy.
const ASSET_CLASS_MODULES: Record<AssetClass, string[]> = {
  us_equity: ["us_equity_market_structure", "company_fundamentals_value"],
  a_share: ["china_a_share_policy_flow"],
  index: ["global_index_regime"],
  etf: ["etf_regime"],
  crypto: ["crypto_market_structure"],
  commodity: ["commodities_oil_gold"],
  fx: ["fx_currency_liquidity"],
  options: ["options_volatility"],
  bond_duration: ["macro_rates_inflation", "credit_liquidity"],
};

const ASSET_CLASS_MISSING_DATA: Partial<Record<AssetClass, string[]>> = {
  us_equity: ["latest_company_fundamental_inputs"],
  crypto: ["crypto_liquidity_volatility_custody_and_regulatory_inputs"],
  commodity: ["commodity_curve_roll_yield_and_inventory_inputs"],
  options: ["options_iv_skew_gamma_and_event_calendar"],
  a_share: ["china_a_share_policy_liquidity_and_northbound_inputs"],
};

type DerivedLabel = {
  requiredModules: string[];
  forbiddenModules: string[];
  requiredMissingData: string[];
  requiredRiskBoundaries: string[];
  minModuleMatches: number;
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].toSorted();
}

// The deterministic feature -> label function. This is the "rule" we want the
// model to learn instead of a lookup table. Every clause is a documented,
// checkable mapping from a feature to a label element, aligned with the
// contract hints in local-brain-taxonomy.ts and the scorer in the eval script.
export function deriveLabel(features: TaskFeatures): DerivedLabel {
  const modules: string[] = [];
  const missingData: string[] = [];
  const riskBoundaries: string[] = ["research_only"];

  // (a) Every asset class pulls in its dedicated module(s) + missing data.
  for (const assetClass of features.assetClasses) {
    modules.push(...ASSET_CLASS_MODULES[assetClass]);
    missingData.push(...(ASSET_CLASS_MISSING_DATA[assetClass] ?? []));
  }

  // (b) Any market-facing task always routes through risk gates + review +
  //     a plain-language control-room summary (analyst decomposition doctrine).
  if (features.assetClasses.length > 0) {
    modules.push("portfolio_risk_gates", "review_panel", "control_room_summary");
  }

  // (c) Fresh numbers must pass the data gateway + provenance; if no source was
  //     supplied, the plan must name the missing snapshot rather than invent it.
  if (features.assetClasses.length > 0 && !features.dataSupplied) {
    modules.push("finance_data_gateway", "data_provenance_quality", "source_registry");
    missingData.push("fresh_market_data_snapshot", "source_timestamp_and_vendor");
    riskBoundaries.push("no_unverified_current_market_data");
  }

  // (d) Portfolio context needs quant math + weights/return series.
  if (features.portfolioContext) {
    modules.push("quant_math", "portfolio_risk_gates");
    missingData.push("position_weights_and_return_series");
  }

  // (e) Trade wording must be converted to research-only preflight with a gate.
  if (features.tradeWording) {
    riskBoundaries.push("risk_gate_before_action_language", "no_trade_advice");
  }

  // (f) Cross-market tasks add cross-asset liquidity + FX and a no-cross-claim
  //     boundary; crypto in the mix forbids leverage.
  if (features.crossMarket) {
    modules.push("cross_asset_liquidity", "fx_currency_liquidity", "macro_rates_inflation");
    riskBoundaries.push("no_unverified_cross_market_claims");
  }
  if (features.assetClasses.includes("crypto")) {
    riskBoundaries.push("no_high_leverage_crypto");
  }

  // (g) Red-team requests require an explicit invalidation boundary + evidence.
  if (features.redTeam) {
    riskBoundaries.push("red_team_invalidation_required");
    missingData.push("red_team_invalidation_evidence");
  }

  const hasAsset = features.assetClasses.length > 0;

  // (i) Deep fundamentals / value-investing: anchor on company_fundamentals_value
  //     + causal_map; require filing evidence; fundamentals-first boundary.
  //     Mirrors value_investing_fundamental_core / single_company_fundamental_risk.
  if (hasAsset && features.fundamentalsDeep) {
    modules.push("company_fundamentals_value", "causal_map");
    missingData.push("latest_company_fundamental_inputs");
    riskBoundaries.push("no_unverified_filing_claims");
  }

  // (j) Event risk (earnings/FOMC/CPI): event_driven module + a no-same-day
  //     boundary. Mirrors fomc_cpi_event_risk_preflight / event_gap cases.
  if (hasAsset && features.eventRisk) {
    modules.push("event_driven");
    riskBoundaries.push("no_trade_advice");
  }

  // (k) Technical timing: technical_timing is a timing context, never standalone
  //     alpha; needs price/volume inputs. Mirrors technical_timing_not_standalone_alpha.
  if (hasAsset && features.technicalTiming) {
    modules.push("technical_timing");
    missingData.push("price_volume_breadth_and_technical_regime_inputs");
    riskBoundaries.push("technical_timing_not_standalone_alpha");
  }

  // (l) Valuation modeling (DCF/comps): financial_modeling_valuation_qc +
  //     research_artifact_qc; require model assumptions; no model-math guessing.
  //     Mirrors financial_modeling_valuation_qc_chain.
  if (hasAsset && features.valuationModeling) {
    modules.push("financial_modeling_valuation_qc", "research_artifact_qc");
    missingData.push(
      "model_assumptions_sensitivity_and_audit_inputs",
      "valuation_range_and_margin_of_safety_inputs",
    );
    riskBoundaries.push("no_model_math_guessing");
  }

  // (m) Abstraction-transfer meta-skill: a terse plain-language phrase must first
  //     be abstracted into a problem family before any literal short answer.
  //     Mirrors abstraction_transfer_repair_protocol / plain_language_hidden_complexity_intake.
  if (features.abstractionTransfer) {
    modules.push("agent_workflow_memory", "eval_harness_design", "review_panel");
    missingData.push(
      "original_example",
      "abstracted_failure_family",
      "adjacent_non_identical_scenario",
      "shared_contract",
      "regression_proof",
    );
    riskBoundaries.push(
      "do_not_stop_at_original_example",
      "proof_required_before_claiming_transfer",
    );
  }

  // (h) Learning-intake tasks use the internalization chain; a missing source
  //     is the dominant gap and suppresses finance-module requirements.
  if (features.learningRequest) {
    modules.push(
      "finance_learning_memory",
      "source_registry",
      "eval_harness_design",
      "review_panel",
    );
    if (!features.sourceSupplied) {
      missingData.push("source_url_or_local_source_path");
    } else {
      missingData.push(
        "actual_reading_scope",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
      );
      riskBoundaries.push("no_model_internal_learning_claim_without_eval");
    }
  }

  const requiredModules = uniqueSorted(modules.map(assertModule));
  // The completion can carry at most PACK_CAP module ids (primary 8 +
  // supporting 6 + required_tools 6). minModuleMatches scales with complexity
  // (eval bank's 60-85% band) but is clamped to what a valid completion can
  // actually satisfy, so a correctly-packed oracle plan never fails its own
  // scorer even when requiredModules exceeds the cap.
  const PACK_CAP = 20;
  const floor = features.assetClasses.length === 0 && features.learningRequest ? 2 : 1;
  const minModuleMatches = Math.min(
    Math.min(requiredModules.length, PACK_CAP),
    Math.max(floor, Math.floor(requiredModules.length * 0.7)),
  );

  return {
    requiredModules,
    // A learning-source audit (no source yet) must NOT fan out into finance
    // modules — forbid them, mirroring external_source_missing_url cases.
    forbiddenModules:
      features.learningRequest && !features.sourceSupplied && features.assetClasses.length === 0
        ? [...ASSET_CLASS_MODULES.us_equity, "etf_regime", "macro_rates_inflation"]
        : [],
    requiredMissingData: uniqueSorted(missingData),
    requiredRiskBoundaries: uniqueSorted(riskBoundaries),
    minModuleMatches,
  };
}

// Small deterministic PRNG (mulberry32) so every run is reproducible from a seed.
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)];
}

const ALL_ASSET_CLASSES: AssetClass[] = [
  "us_equity",
  "a_share",
  "index",
  "etf",
  "crypto",
  "commodity",
  "fx",
  "options",
  "bond_duration",
];

const DISTINCT_MARKETS: Set<AssetClass> = new Set(["us_equity", "a_share", "index", "crypto"]);

// Draw a random, internally-consistent feature vector.
// Seeded Fisher-Yates shuffle: unbiased and stable, unlike sort(random).
function shuffle<T>(rng: () => number, values: readonly T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sampleFeatures(rng: () => number): TaskFeatures {
  const learningRequest = rng() < 0.22;
  // Learning-only intake often has no asset class; otherwise pick 1-3 classes.
  const assetCount = learningRequest && rng() < 0.5 ? 0 : 1 + Math.floor(rng() * 3);
  const shuffled = shuffle(rng, ALL_ASSET_CLASSES);
  const assetClasses = shuffled.slice(0, assetCount);
  const distinctMarkets = new Set(assetClasses.filter((a) => DISTINCT_MARKETS.has(a)));
  const hasAsset = assetClasses.length > 0;
  const hasEquity = assetClasses.includes("us_equity");
  return {
    assetClasses,
    dataSupplied: rng() < 0.35,
    learningRequest,
    sourceSupplied: learningRequest ? rng() < 0.5 : false,
    tradeWording: hasAsset && rng() < 0.4,
    portfolioContext: hasAsset && rng() < 0.45,
    crossMarket: distinctMarkets.size >= 2,
    oldContextPollution: rng() < 0.3,
    redTeam: hasAsset && rng() < 0.3,
    // Deep-fundamentals / valuation framing is most natural for single-name
    // equity; event and technical framing apply to any asset.
    fundamentalsDeep: hasEquity && rng() < 0.4,
    eventRisk: hasAsset && rng() < 0.3,
    technicalTiming: hasAsset && rng() < 0.35,
    valuationModeling: hasEquity && rng() < 0.3,
    // Short plain-language asks (often no explicit asset) trigger abstraction.
    abstractionTransfer: rng() < 0.18,
  };
}

// A stable signature of the label-relevant feature combination. The held-out
// split is keyed on this so the test set holds feature COMBINATIONS the train
// stream never produces — the real memorization-vs-rule probe.
export function featureSignature(features: TaskFeatures): string {
  return [
    `ac:${[...features.assetClasses].toSorted().join("+") || "none"}`,
    `ds:${Number(features.dataSupplied)}`,
    `lr:${Number(features.learningRequest)}`,
    `ss:${Number(features.sourceSupplied)}`,
    `tw:${Number(features.tradeWording)}`,
    `pc:${Number(features.portfolioContext)}`,
    `xm:${Number(features.crossMarket)}`,
    `rt:${Number(features.redTeam)}`,
    `fd:${Number(features.fundamentalsDeep)}`,
    `ev:${Number(features.eventRisk)}`,
    `tt:${Number(features.technicalTiming)}`,
    `vm:${Number(features.valuationModeling)}`,
    `at:${Number(features.abstractionTransfer)}`,
  ].join("|");
}

// FNV-1a hash -> [0,1), used to assign a signature to train vs held-out
// deterministically (same signature always lands on the same side).
function hashUnit(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967296;
}

export const GENERALIZATION_CASE_SCHEMA_VERSION = "lcx_generalization_case_v1";
export const GENERALIZATION_GENERATOR_ID = "local-brain-generalization-harness";
export const GENERALIZATION_GENERATOR_VERSION = "feature-signature-v1";

export type GeneralizationCaseProvenance = {
  schemaVersion: typeof GENERALIZATION_CASE_SCHEMA_VERSION;
  generator: typeof GENERALIZATION_GENERATOR_ID;
  generatorVersion: typeof GENERALIZATION_GENERATOR_VERSION;
  split: "train" | "holdout";
  seed: number;
  holdoutFraction: number;
};

export function isFeatureSignatureHeldOut(signature: string, holdoutFraction: number): boolean {
  return hashUnit(signature) < holdoutFraction;
}

export function isHeldOut(features: TaskFeatures, holdoutFraction: number): boolean {
  return isFeatureSignatureHeldOut(featureSignature(features), holdoutFraction);
}

const ASSET_PHRASES: Record<AssetClass, string[]> = {
  us_equity: ["美股科技股", "NVDA", "US tech names", "QQQ 成分股"],
  a_share: ["A股", "China A-shares", "沪深300"],
  index: ["纳指", "标普500", "global indices"],
  etf: ["QQQ", "TLT", "一篮子 ETF"],
  crypto: ["BTC", "加密币", "ETH 流动性"],
  commodity: ["原油", "黄金", "大宗商品"],
  fx: ["美元", "美元/人民币", "the dollar"],
  options: ["期权 IV", "options skew", "隐含波动率"],
  bond_duration: ["长端利率", "TLT 久期", "Treasury yields"],
};

// Render a natural-language ask that varies in surface form while keeping the
// label invariant. Paraphrase variety is deliberate: it punishes lookup-table
// solutions that key on exact wording and rewards the underlying rule.
function renderAsk(features: TaskFeatures, rng: () => number): string {
  const assets = features.assetClasses.map((a) => pick(rng, ASSET_PHRASES[a]));
  const parts: string[] = [];

  if (features.oldContextPollution) {
    parts.push(pick(rng, ["先别管刚才 External 上的旧对话，", "忽略之前那条线程，", "换个话题，"]));
  }
  if (features.abstractionTransfer) {
    parts.push(
      pick(rng, [
        "别按字面短答，先把它抽象成问题族再拆，",
        "这是一句很短的话，先抽象成 failure family 再决定模块，",
        "不要只修这一句，抽象成问题族并留回归证明，",
      ]),
    );
  }
  if (features.learningRequest) {
    const what = features.sourceSupplied
      ? pick(rng, ["arxiv.org/abs/2601.17021 这篇论文", "这个 GitHub 开源项目", "我给的这份研报"])
      : pick(rng, ["一个我听说的宏观策略", "某篇金融论文", "一个开源项目"]);
    parts.push(`帮本地大脑学习并内化${what}`);
    if (!features.sourceSupplied) {
      parts.push(pick(rng, ["（我还没给链接或本地文件）", "，但我还没提供来源", "，来源待补"]));
    }
  }
  if (assets.length > 0) {
    const verb = features.tradeWording
      ? pick(rng, ["要不要买入", "该不该加仓", "现在能不能上仓位"])
      : pick(rng, ["怎么研究", "如何拆解风险", "怎么分析"]);
    const holding = features.portfolioContext
      ? pick(rng, ["我持有", "组合里有", "我仓位包含"])
      : "";
    parts.push(`${holding}${assets.join("、")}，${verb}`);
  }
  if (features.crossMarket) {
    parts.push(pick(rng, ["要做跨市场连贯分析", "关注它们之间的联动", "跨资产一起看"]));
  }
  if (features.redTeam) {
    parts.push(
      pick(rng, ["还要一轮反方论证：如果判断错了哪些数据会证伪", "并给出证伪条件", "加上红队反证"]),
    );
  }
  if (features.fundamentalsDeep) {
    parts.push(
      pick(rng, ["，重点是基本面和内在价值", "，先看收入质量、护城河和估值", "，做深度基本面研究"]),
    );
  }
  if (features.eventRisk) {
    parts.push(
      pick(rng, ["，财报和 FOMC 前的事件风险", "，考虑 CPI/财报事件窗口", "，事件驱动视角"]),
    );
  }
  if (features.technicalTiming) {
    parts.push(pick(rng, ["，技术面只作 timing 参考", "，结合量价择时背景", "，看技术面 timing"]));
  }
  if (features.valuationModeling) {
    parts.push(pick(rng, ["，还要 DCF/comps 估值模型", "，做财务建模和估值 QC", "，建估值模型"]));
  }
  if (assets.length > 0) {
    parts.push(
      pick(rng, ["，research-only，不要交易建议", "，只做研究不要下单", "，不要给买卖点"]),
    );
  }
  const ask = parts.join("").trim();
  return ask || "重新来一遍。";
}

let caseCounter = 0;

// Produce one fully-labeled generated case from a feature vector.
export function generateCase(features: TaskFeatures, rng: () => number): GeneratedCase {
  const label = deriveLabel(features);
  const signature = featureSignature(features);
  caseCounter += 1;
  return {
    id: `gen_${caseCounter}_${hashUnit(signature).toFixed(6).slice(2)}`,
    userAsk: renderAsk(features, rng),
    sourceSummary: `generated case for feature signature ${signature}`,
    features,
    requiredModules: label.requiredModules,
    forbiddenModules: label.forbiddenModules,
    minModuleMatches: label.minModuleMatches,
    requiredMissingData: label.requiredMissingData,
    requiredRiskBoundaries: label.requiredRiskBoundaries,
    featureSignature: signature,
  };
}

// Count the "hard" dimensions that layer complexity on top of a base ask.
// Used to define a strict complexity ordering between a case and its prerequisite.
export function complexityDegree(features: TaskFeatures): number {
  return (
    features.assetClasses.length +
    Number(features.crossMarket) +
    Number(features.portfolioContext) +
    Number(features.tradeWording) +
    Number(features.redTeam) +
    Number(features.fundamentalsDeep) +
    Number(features.eventRisk) +
    Number(features.technicalTiming) +
    Number(features.valuationModeling) +
    Number(features.abstractionTransfer) +
    Number(features.learningRequest)
  );
}

// Derive a strictly-simpler prerequisite feature vector for a complex case:
// keep at most one asset class and strip every advanced dimension. The eval
// doctrine (abstraction_transfer / prerequisiteCaseIds) requires that if a hard
// case passes, the simple prerequisite must pass too — so a training/eval set
// can pair them. Returns undefined when the case is already minimal.
export function prerequisiteFeatures(features: TaskFeatures): TaskFeatures | undefined {
  if (complexityDegree(features) <= 1) {
    return undefined;
  }
  return {
    assetClasses: features.assetClasses.slice(0, 1),
    dataSupplied: features.dataSupplied,
    learningRequest: false,
    sourceSupplied: false,
    tradeWording: false,
    portfolioContext: false,
    crossMarket: false,
    oldContextPollution: features.oldContextPollution,
    redTeam: false,
    fundamentalsDeep: false,
    eventRisk: false,
    technicalTiming: false,
    valuationModeling: false,
    abstractionTransfer: false,
  };
}

// Stream N cases from a seed, optionally restricted to train-only or held-out.
export function generateCases(
  count: number,
  options: { seed?: number; split?: "all" | "train" | "holdout"; holdoutFraction?: number } = {},
): GeneratedCase[] {
  const rng = makeRng(options.seed ?? 1);
  const split = options.split ?? "all";
  const holdoutFraction = options.holdoutFraction ?? 0.2;
  const cases: GeneratedCase[] = [];
  let guard = 0;
  while (cases.length < count && guard < count * 50) {
    guard += 1;
    const features = sampleFeatures(rng);
    if (split === "train" && isHeldOut(features, holdoutFraction)) {
      continue;
    }
    if (split === "holdout" && !isHeldOut(features, holdoutFraction)) {
      continue;
    }
    cases.push(generateCase(features, rng));
  }
  return cases;
}

// Emit each generated case immediately followed by its strict prerequisite
// (when it has one), so a training/eval set always contains the simpler case a
// hard case depends on. This operationalizes the "prove the simple prerequisite
// and the adjacent case both pass" doctrine from the eval bank.
export function generateCasesWithPrerequisites(
  count: number,
  options: { seed?: number; split?: "all" | "train" | "holdout"; holdoutFraction?: number } = {},
): GeneratedCase[] {
  const rng = makeRng(options.seed ?? 1);
  const split = options.split ?? "all";
  const holdoutFraction = options.holdoutFraction ?? 0.2;
  const out: GeneratedCase[] = [];
  let guard = 0;
  while (out.length < count && guard < count * 50) {
    guard += 1;
    const features = sampleFeatures(rng);
    if (split === "train" && isHeldOut(features, holdoutFraction)) {
      continue;
    }
    if (split === "holdout" && !isHeldOut(features, holdoutFraction)) {
      continue;
    }
    out.push(generateCase(features, rng));
    const prereq = prerequisiteFeatures(features);
    if (prereq && out.length < count) {
      out.push(generateCase(prereq, rng));
    }
  }
  return out;
}

// Reference scorer: mirrors evaluate() in local-brain-distill-eval.ts (the
// 7-condition contract). Lets us grade any JSON plan against a generated case
// with the exact production pass/fail semantics, without importing the eval
// script's top-level side effects.
export type PlanOutput = {
  task_family?: unknown;
  primary_modules?: unknown;
  supporting_modules?: unknown;
  required_tools?: unknown;
  missing_data?: unknown;
  risk_boundaries?: unknown;
  next_step?: unknown;
  rejected_context?: unknown;
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function scorePlan(
  output: PlanOutput,
  target: GeneratedCase,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const missingKeys = REQUIRED_KEYS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(output, key),
  );
  if (missingKeys.length > 0) {
    reasons.push(`missing_keys:${missingKeys.join(",")}`);
  }
  const modules = new Set([
    ...asStringArray(output.primary_modules),
    ...asStringArray(output.supporting_modules),
    ...asStringArray(output.required_tools),
  ]);
  const matched = target.requiredModules.filter((m) => modules.has(m));
  if (matched.length < target.minModuleMatches) {
    reasons.push(`module_matches:${matched.length}<${target.minModuleMatches}`);
  }
  const forbiddenHit = target.forbiddenModules.filter((m) => modules.has(m));
  if (forbiddenHit.length > 0) {
    reasons.push(`forbidden_modules:${forbiddenHit.join(",")}`);
  }
  const missingData = asStringArray(output.missing_data);
  const missingReqData = target.requiredMissingData.filter((d) => !missingData.includes(d));
  if (missingReqData.length > 0) {
    reasons.push(`missing_required_data:${missingReqData.join(",")}`);
  }
  const risk = asStringArray(output.risk_boundaries);
  const missingReqRisk = target.requiredRiskBoundaries.filter((r) => !risk.includes(r));
  if (missingReqRisk.length > 0) {
    reasons.push(`missing_risk_boundaries:${missingReqRisk.join(",")}`);
  }
  const boundaryOk = risk.includes("research_only") || risk.includes("no_execution_authority");
  if (!boundaryOk) {
    reasons.push("boundary_missing");
  }
  if (!asStringArray(output.rejected_context).includes("old_external_conversation_history")) {
    reasons.push("old_context_not_rejected");
  }
  return { ok: reasons.length === 0, reasons };
}

// The oracle plan: a perfect rule-follower. It computes the plan directly from
// the label (which is itself a pure function of features). Used to prove the
// generated cases are internally satisfiable, and as the ceiling for scoring.
export function oraclePlan(target: GeneratedCase): PlanOutput {
  return {
    task_family: "generated_router_task",
    primary_modules: target.requiredModules.slice(0, 8),
    supporting_modules: target.requiredModules.slice(8, 14),
    required_tools: target.requiredModules.slice(14, 20),
    missing_data: target.requiredMissingData,
    risk_boundaries: [...new Set([...target.requiredRiskBoundaries, "research_only"])],
    next_step: "route_to_modules",
    rejected_context: ["old_external_conversation_history"],
  };
}

// ---------------------------------------------------------------------------
// Infinite training-stream integration.
//
// Emit rows byte-compatible with the real MLX-LM dataset
// (~/.openclaw/local-brain-trainer/datasets/thought-flow-v1/train.jsonl):
// each row is {prompt, completion, meta}. The prompt mirrors buildPrompt() and
// the completion mirrors buildCompletion() in local-brain-distill-dataset.ts,
// so these rows can be concatenated into (or fully replace) the training set.
//
// Because every row is generated from a fresh feature vector, the training
// stream never repeats — memorization stops being the lowest-loss solution,
// which is the whole point of feeding this into training rather than the fixed
// bank.
// ---------------------------------------------------------------------------

export type DatasetRow = {
  prompt: string;
  completion: string;
  meta: {
    source: "generalization_generator";
    featureSignature: string;
    id: string;
  };
};

// Mirror of buildPrompt() in local-brain-distill-dataset.ts (kept in sync by
// reusing the same shared taxonomy constants).
function buildDatasetPrompt(userAsk: string, sourceSummary: string): string {
  return [
    "You are the LCX Agent local auxiliary thought-flow model.",
    "Task: produce a concise control-room planning packet for the main agent.",
    "Do not answer the user's finance question directly.",
    "/no_think",
    "Do not emit chain-of-thought, markdown, or <think> blocks; output only the JSON object.",
    "Keep the JSON compact: short arrays, short next_step, no explanation inside or outside JSON.",
    `Output contract: ${LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS.join(" ")}`,
    'Use this exact compact shape: {"task_family":"snake_case","primary_modules":[],"supporting_modules":[],"required_tools":[],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"snake_case_action","rejected_context":["old_external_conversation_history"]}',
    "Think like a careful human financial analyst: clarify objective, recall local memory and learned rules, split causal layers, identify missing evidence, route to review, then summarize for the control room.",
    "Do not invent current or timestamped market data, execution approval, or durable memory writes.",
    `Allowed module ids: ${LOCAL_BRAIN_MODULE_TAXONOMY.join(", ")}.`,
    "For finance tasks, choose concrete module ids from the allowed list instead of generic finance labels.",
    `Core planning hints: ${LOCAL_BRAIN_CONTRACT_HINTS.slice(0, 4).join(" ")}`,
    "Return only JSON with keys: task_family, primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, next_step, rejected_context.",
    "",
    "source_kind: generalization_generator",
    `user_or_task: ${userAsk}`,
    `source_summary: ${sourceSummary}`,
  ].join("\n");
}

// Build the target completion from the label, packed into the module-field caps
// exactly like buildCompletion(). The completion is guaranteed to pass
// scorePlan() against its own case (asserted in tests) — we never train the
// model toward an answer the production scorer would reject.
function buildDatasetCompletion(target: GeneratedCase): string {
  const packed = packLocalBrainModuleFields(target.requiredModules, [], []);
  const plan = {
    task_family: "finance_research_planning",
    primary_modules: packed.primary_modules,
    supporting_modules: packed.supporting_modules,
    required_tools: packed.required_tools,
    missing_data: target.requiredMissingData,
    risk_boundaries: [...new Set(["research_only", ...target.requiredRiskBoundaries])],
    next_step: "route_to_concrete_modules_then_review",
    rejected_context: ["old_external_conversation_history"],
  };
  return JSON.stringify(plan);
}

export function toDatasetRow(target: GeneratedCase): DatasetRow {
  return {
    prompt: buildDatasetPrompt(target.userAsk, target.sourceSummary),
    completion: buildDatasetCompletion(target),
    meta: {
      source: "generalization_generator",
      featureSignature: target.featureSignature,
      id: target.id,
    },
  };
}
