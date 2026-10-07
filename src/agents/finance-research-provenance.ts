/**
 * Shared evidence-preservation guidance and finance claim-origin labels.
 * These are annotations carried with research artifacts, not truth or source-quality verdicts.
 */
export const PARTIAL_EVIDENCE_PROMPT_GUIDANCE =
  "Use and retain useful partial evidence: text snippets, cropped charts, incomplete tables, uncertain reports and contradictory observations can inform bounded questions or hypotheses. Preserve original content, known source/time, missing context and confidence; unknown fields stay unknown. Retain known errors as labeled counterevidence or correction history. Assess completeness and correctness per claim and action, not as prerequisites for storage. Recheck only decision-critical gaps through existing tools; partial evidence does not supply missing execution authority or required numeric checks.";

export const FINANCE_RESEARCH_CLAIM_EPISTEMIC_CLASSES = [
  "source_observation",
  "source_report",
  "derived_measure",
  "estimate",
  "inference",
  "hypothesis",
  "unclassified",
] as const;
export type FinanceResearchClaimEpistemicClass =
  (typeof FINANCE_RESEARCH_CLAIM_EPISTEMIC_CLASSES)[number];

export function financeResearchClaimRequiresBasis(
  epistemicClass: FinanceResearchClaimEpistemicClass | undefined,
): boolean {
  return (
    epistemicClass === "derived_measure" ||
    epistemicClass === "estimate" ||
    epistemicClass === "inference" ||
    epistemicClass === "hypothesis"
  );
}

export const FINANCE_RESEARCH_EVIDENCE_RELATIONS = [
  "supports",
  "contradicts",
  "context",
  "unknown",
] as const;
export type FinanceResearchEvidenceRelation = (typeof FINANCE_RESEARCH_EVIDENCE_RELATIONS)[number];
