/**
 * Shared labels for finance claim origin and its relationship to cited evidence.
 * These are annotations carried with research artifacts, not truth or source-quality verdicts.
 */
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
