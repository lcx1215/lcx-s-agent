export type AnswerAuditPolicy = {
  boundary: "bounded_answer_review";
  owner: "local_answer_context_review_panel";
  candidateAuthority: "model_candidate_not_final_authority";
  providerCouncilRole: "not_requested" | "required_for_high_value_or_evidence_sensitive_answer";
  qwenRole: "challenger_only_not_final_authority" | "not_requested" | "blocked_by_local_contract";
  qwenChallengeRounds: 0 | 1;
  providerCouncilRounds: 0 | 1;
  modelRewriteBudget: 0 | 2;
  maxTotalReviewRounds: number;
};

export type AnswerAuditWorkOrder = {
  validation?: {
    qwenChallenge?: {
      status?: "recommended" | "blocked" | "not_requested";
    };
  };
};

export function buildAnswerAuditPolicy(params: {
  workOrder?: AnswerAuditWorkOrder;
}): AnswerAuditPolicy {
  const qwenStatus = params.workOrder?.validation?.qwenChallenge?.status;
  const qwenChallengeRounds = qwenStatus === "recommended" ? 1 : 0;
  const providerCouncilRounds = params.workOrder ? 1 : 0;
  const modelRewriteBudget = params.workOrder ? 2 : 0;
  const qwenRole =
    qwenStatus === "recommended"
      ? "challenger_only_not_final_authority"
      : qwenStatus === "blocked"
        ? "blocked_by_local_contract"
        : "not_requested";
  return {
    boundary: "bounded_answer_review",
    owner: "local_answer_context_review_panel",
    candidateAuthority: "model_candidate_not_final_authority",
    providerCouncilRole:
      providerCouncilRounds === 1
        ? "required_for_high_value_or_evidence_sensitive_answer"
        : "not_requested",
    qwenRole,
    qwenChallengeRounds,
    providerCouncilRounds,
    modelRewriteBudget,
    maxTotalReviewRounds: 1 + providerCouncilRounds + qwenChallengeRounds + modelRewriteBudget,
  };
}
