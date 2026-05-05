import { createHash } from "node:crypto";
import {
  normalizeLarkApiReplyForDistillation,
  type LarkApiReplyDistillationSample,
} from "./lark-api-reply-distillation.js";

export type LarkBrainDistillationCandidateSource =
  | "api_reply"
  | "lark_visible_reply"
  | "lark_user_utterance"
  | "teacher_review";

export type LarkBrainDistillationCandidateStatus =
  | "pending_brain_review"
  | "accepted_brain_plan"
  | "rejected_brain_plan"
  | "discarded";

export type LarkBrainDistillationCandidate = {
  id: string;
  source: LarkBrainDistillationCandidateSource;
  status: LarkBrainDistillationCandidateStatus;
  boundary: "brain_distillation_candidate";
  createdAt: string;
  sample: LarkApiReplyDistillationSample;
  userMessage?: string;
  candidateText?: string;
  proposedTaskFamily?: string;
  proposedPrimaryModules?: string[];
  proposedSupportingModules?: string[];
  proposedRequiredTools?: string[];
  proposedMissingData?: string[];
  proposedRiskBoundaries?: string[];
  proposedNextStep?: string;
  review?: {
    accepted: boolean;
    reviewer:
      | "api_teacher"
      | "human"
      | "deterministic_smoke"
      | "deterministic_review"
      | "minimax_m2_7_teacher";
    reason: string;
  };
  discardReason?: string;
};

export type LarkBrainDistillationCandidateArtifact = {
  schemaVersion: 1;
  boundary: "brain_distillation_candidate";
  generatedAt: string;
  noLanguageRoutingPromotion: true;
  noLiveSenderTouched: true;
  candidates: LarkBrainDistillationCandidate[];
};

export type LarkBrainDistillationReviewArtifact = {
  schemaVersion: 1;
  boundary: "brain_distillation_review";
  reviewedAt: string;
  noLanguageRoutingPromotion: true;
  noLiveSenderTouched: true;
  sourceArtifacts: string[];
  acceptedCandidates: LarkBrainDistillationCandidate[];
  rejectedCandidates: Array<{
    id: string;
    source: LarkBrainDistillationCandidateSource;
    reason: string;
  }>;
  counts: {
    sourceArtifacts: number;
    pendingCandidates: number;
    accepted: number;
    rejected: number;
    discarded: number;
  };
};

export const LARK_BRAIN_DISTILLATION_CANDIDATE_DIR = "memory/lark-brain-distillation-candidates";
export const LARK_BRAIN_DISTILLATION_REVIEW_DIR = "memory/lark-brain-distillation-reviews";

const DEFAULT_RISK_BOUNDARIES = [
  "research_only",
  "no_execution_authority",
  "evidence_required",
  "no_model_math_guessing",
];

function normalizeCandidateText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function buildCandidateId(params: {
  source: LarkBrainDistillationCandidateSource;
  contentHash: string;
  userMessage?: string;
}): string {
  const seed = [params.source, params.contentHash, params.userMessage ?? ""].join("\n");
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `pending-brain-distill-${hash}`;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function inferModules(text: string): string[] {
  const lower = text.toLowerCase();
  const modules: string[] = [];
  if (
    /google scholar|ssrn|nber|arxiv|论文|paper|working paper|网页|url|链接|source|citation/u.test(
      lower,
    )
  ) {
    modules.push("finance_learning_memory", "source_registry");
  }
  if (/因果|传导|机制|causal|scenario|invalidation|反证/u.test(lower)) {
    modules.push("causal_map");
  }
  if (/etf|qqq|spy|tlt|iwm|择时|timing|regime|均线|趋势/u.test(lower)) {
    modules.push("etf_regime");
  }
  if (/nvda|公司|基本面|fundamental|earnings|revenue|margin|capex|估值/u.test(lower)) {
    modules.push("company_fundamentals_value");
  }
  if (/数学|量化|波动|相关|回撤|var|dv01|beta|correlation|volatility|drawdown/u.test(lower)) {
    modules.push("quant_math");
  }
  if (/组合|持仓|仓位|风险|risk|sizing|敞口|exposure/u.test(lower)) {
    modules.push("portfolio_risk_gates");
  }
  if (/利率|通胀|fed|fomc|treasury|yield|duration|cpi/u.test(lower)) {
    modules.push("macro_rates_inflation");
  }
  if (/流动性|美元|credit|spread|liquidity|融资|资金/u.test(lower)) {
    modules.push("credit_liquidity");
  }
  return uniq(modules);
}

function inferMissingData(text: string, modules: readonly string[]): string[] {
  const missing: string[] = [];
  if (
    modules.includes("source_registry") &&
    !/(https?:\/\/|arxiv\.org|ssrn\.com|nber\.org|scholar\.google)/iu.test(text)
  ) {
    missing.push("source_url_or_local_source_path");
  }
  if (/google scholar|ssrn|nber|全覆盖|读过哪些|coverage|actual read/iu.test(text)) {
    missing.push("actual_reading_scope", "source_coverage_limits");
  }
  if (modules.includes("quant_math")) {
    missing.push("position_weights_and_return_series");
  }
  if (modules.includes("portfolio_risk_gates")) {
    missing.push("portfolio_weights_and_risk_limits");
  }
  if (modules.includes("company_fundamentals_value")) {
    missing.push("latest_company_fundamental_inputs");
  }
  return uniq(missing);
}

function inferRequiredTools(modules: readonly string[]): string[] {
  const tools: string[] = [];
  if (modules.includes("source_registry")) {
    tools.push(
      "finance_article_source_collection_preflight",
      "finance_article_source_registry_record",
      "finance_learning_retrieval_review",
    );
  }
  for (const module of modules) {
    if (module === "quant_math") {
      tools.push("quant_math");
    } else if (!["source_registry", "finance_learning_memory"].includes(module)) {
      tools.push(`finance_framework_${module}_producer`);
    }
  }
  tools.push("review_panel");
  return uniq(tools);
}

function inferTaskFamily(text: string, modules: readonly string[]): string {
  if (modules.includes("source_registry")) {
    return /google scholar|ssrn|nber|arxiv|论文|paper|working paper/iu.test(text)
      ? "external_scholarly_learning_planning"
      : "external_source_learning_planning";
  }
  if (modules.includes("quant_math") && modules.includes("portfolio_risk_gates")) {
    return "quant_math_portfolio_risk_planning";
  }
  if (modules.includes("company_fundamentals_value")) {
    return "fundamental_research_planning";
  }
  if (modules.length > 0) {
    return "finance_research_planning";
  }
  return "control_room_planning";
}

function inferNextStep(params: {
  text: string;
  missingData: readonly string[];
  modules: readonly string[];
}): string {
  if (params.missingData.includes("source_url_or_local_source_path")) {
    return "ask_for_source_url_or_local_file_before_learning_claim";
  }
  if (params.missingData.includes("actual_reading_scope")) {
    return "collect_source_list_then_report_actual_reading_scope_before_learning_claim";
  }
  if (params.missingData.includes("position_weights_and_return_series")) {
    return "request_position_weights_and_return_series_before_local_math";
  }
  if (params.modules.length > 0) {
    return "route_to_concrete_modules_then_review_before_visible_reply";
  }
  return "ask_for_current_subject_before_planning";
}

export function buildLarkBrainDistillationCandidate(params: {
  source: LarkBrainDistillationCandidateSource;
  payload: unknown;
  userMessage?: string;
  createdAt?: string;
  review?: LarkBrainDistillationCandidate["review"];
}): LarkBrainDistillationCandidate {
  const sample = normalizeLarkApiReplyForDistillation(params.payload);
  const candidateText = sample.distillableText
    ? normalizeCandidateText(sample.distillableText)
    : undefined;
  const joinedText = [params.userMessage, candidateText].filter(Boolean).join("\n");
  const modules = candidateText ? inferModules(joinedText) : [];
  const missingData = inferMissingData(joinedText, modules);
  const status: LarkBrainDistillationCandidateStatus =
    sample.disposition === "discard_binary" ||
    sample.disposition === "discard_empty" ||
    sample.disposition === "discard_secret" ||
    !candidateText
      ? "discarded"
      : params.review?.accepted
        ? "accepted_brain_plan"
        : "pending_brain_review";

  return {
    id: buildCandidateId({
      source: params.source,
      contentHash: sample.contentHash,
      userMessage: params.userMessage,
    }),
    source: params.source,
    status,
    boundary: "brain_distillation_candidate",
    createdAt: params.createdAt ?? new Date().toISOString(),
    sample,
    userMessage: params.userMessage,
    candidateText,
    proposedTaskFamily: candidateText ? inferTaskFamily(joinedText, modules) : undefined,
    proposedPrimaryModules: modules.length > 0 ? modules : undefined,
    proposedSupportingModules: candidateText ? ["review_panel", "control_room_summary"] : undefined,
    proposedRequiredTools: candidateText ? inferRequiredTools(modules) : undefined,
    proposedMissingData: candidateText ? missingData : undefined,
    proposedRiskBoundaries: candidateText ? DEFAULT_RISK_BOUNDARIES : undefined,
    proposedNextStep: candidateText
      ? inferNextStep({
          text: joinedText,
          missingData,
          modules,
        })
      : undefined,
    review: params.review,
    discardReason:
      status === "discarded"
        ? (sample.discardReason ?? "missing distillable brain text")
        : undefined,
  };
}

export function buildLarkBrainDistillationCandidateArtifact(params: {
  candidates: LarkBrainDistillationCandidate[];
  generatedAt?: string;
}): LarkBrainDistillationCandidateArtifact {
  return {
    schemaVersion: 1,
    boundary: "brain_distillation_candidate",
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    noLanguageRoutingPromotion: true,
    noLiveSenderTouched: true,
    candidates: params.candidates,
  };
}
