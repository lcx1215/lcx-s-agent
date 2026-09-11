import { createHash } from "node:crypto";
import type { LogicalAgentTaskResult } from "./logical-agent-pool.js";
import type {
  QualityHarnessArtifact,
  QualityHarnessEvidence,
  QualityHarnessReview,
  QualityHarnessStageOutput,
} from "./quality-harness-contract.js";

export const RECONCILABLE_REVIEW_ROLES = [
  "financial_extraction",
  "news_classification",
  "risk_check",
  "portfolio_exposure",
  "adversarial_challenge",
] as const;

export type QualityFinding = Readonly<{
  id: string;
  role: string;
  category: "critical" | "evidence_gap" | "verdict";
  text: string;
}>;
export type QualityFindingPacket = Readonly<{
  artifactSha256: string;
  evidenceSha256: string;
  findings: readonly QualityFinding[];
}>;
export type QualityFindingResolution = Readonly<{
  findingId: string;
  status: "resolved" | "unresolved";
  evidenceIds: readonly string[];
  artifactQuote: string;
  artifactClaimId?: string;
  rationale: string;
}>;
export type QualityFindingClosure = Readonly<{
  artifactSha256: string;
  evidenceSha256: string;
  resolutions: readonly QualityFindingResolution[];
}>;
export type QualityFindingReceipt = QualityFinding &
  Readonly<{
    status: "resolved" | "unresolved";
    artifactSha256: string;
    evidenceSha256: string;
    reviewer?: string;
    closureFailure?: string;
    resolution?: QualityFindingResolution;
  }>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function collectQualityFindings(
  reviews: readonly { role: string; review: QualityHarnessReview }[],
): QualityFinding[] {
  return reviews.flatMap(({ role, review }) => {
    if (!(RECONCILABLE_REVIEW_ROLES as readonly string[]).includes(role)) {
      return [];
    }
    const entries: { category: QualityFinding["category"]; text: string }[] = [
      ...review.criticalFindings.map((text) => ({ category: "critical" as const, text })),
      ...review.evidenceGaps.map((text) => ({ category: "evidence_gap" as const, text })),
    ];
    if (review.verdict !== "pass" && entries.length === 0) {
      entries.push({ category: "verdict", text: `review verdict=${review.verdict}` });
    }
    return entries.map((entry, index) => ({
      ...entry,
      role,
      id: digest([role, review.verdict, index, entry]),
    }));
  });
}

export function qualityFindingPacket(
  artifact: QualityHarnessArtifact,
  evidence: readonly QualityHarnessEvidence[],
  findings: readonly QualityFinding[],
): QualityFindingPacket {
  return { artifactSha256: digest(artifact), evidenceSha256: digest(evidence), findings };
}

/** A later pass alone never clears earlier findings; require a version-bound independent review. */
export function reconcileQualityFindings(
  tasks: readonly LogicalAgentTaskResult<QualityHarnessStageOutput>[],
  artifact: QualityHarnessArtifact | undefined,
  evidence: readonly QualityHarnessEvidence[],
): QualityFindingReceipt[] {
  const reviews = tasks.flatMap((task) =>
    task.status === "completed" && task.output?.kind === "review"
      ? [{ role: task.agentId, review: task.output.review }]
      : [],
  );
  const findings = collectQualityFindings(reviews);
  if (!artifact) {
    return findings.map((finding) => ({
      ...finding,
      status: "unresolved",
      artifactSha256: "",
      evidenceSha256: "",
    }));
  }
  const packet = qualityFindingPacket(artifact, evidence, findings);
  const precheck = tasks.find((task) => task.taskId === "final_precheck");
  const review =
    precheck?.status === "completed" && precheck.output?.kind === "review"
      ? precheck.output.review
      : undefined;
  const closure = review?.findingClosure;
  const actualModel = (id: string) => {
    const call = tasks
      .find((task) => task.taskId === id)
      ?.modelCalls?.filter(
        (entry) =>
          entry.outcome === "completed" &&
          entry.realModelInferenceObserved &&
          entry.evidence === "adapter-attested",
      )
      .at(-1);
    return call ? `${call.provider}/${call.modelId}` : undefined;
  };
  const reviewer = actualModel("final_precheck");
  const draft = actualModel("research_draft");
  const formatter = actualModel("formatting");
  const resolutions = closure?.resolutions ?? [];
  const ids = new Set(findings.map((finding) => finding.id));
  const valid =
    !!reviewer &&
    !!draft &&
    !!formatter &&
    reviewer !== draft &&
    reviewer !== formatter &&
    review?.verdict === "pass" &&
    review.criticalFindings.length === 0 &&
    review.evidenceGaps.length === 0 &&
    closure?.artifactSha256 === packet.artifactSha256 &&
    closure.evidenceSha256 === packet.evidenceSha256 &&
    resolutions.length === findings.length &&
    new Set(resolutions.map((entry) => entry.findingId)).size === findings.length &&
    resolutions.every((entry) => ids.has(entry.findingId));
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  const text = [artifact.answer, ...artifact.claims.map((claim) => claim.text)].join("\n");
  return findings.map((finding) => {
    const supplied = resolutions.find((entry) => entry.findingId === finding.id);
    const claim = supplied?.artifactClaimId
      ? artifact.claims.find((entry) => entry.id === supplied.artifactClaimId)
      : undefined;
    const anchorValid =
      !supplied?.artifactClaimId ||
      (!!claim && (!supplied.artifactQuote || claim.text.includes(supplied.artifactQuote)));
    const resolution =
      supplied && claim && !supplied.artifactQuote
        ? { ...supplied, artifactQuote: claim.text }
        : supplied;
    const source = reviews.find((entry) => entry.role === finding.role)?.review;
    const resolved =
      valid &&
      anchorValid &&
      source?.verdict !== "reject" &&
      finding.category !== "verdict" &&
      resolution?.status === "resolved" &&
      resolution.rationale.trim().length > 0 &&
      resolution.artifactQuote.trim().length > 0 &&
      text.includes(resolution.artifactQuote) &&
      resolution.evidenceIds.length > 0 &&
      resolution.evidenceIds.every((id) => evidenceIds.has(id));
    return {
      ...finding,
      artifactSha256: packet.artifactSha256,
      evidenceSha256: packet.evidenceSha256,
      status: resolved ? "resolved" : "unresolved",
      ...(!resolved
        ? {
            closureFailure: !valid
              ? "closure_missing_or_invalid"
              : !anchorValid
                ? "artifact_claim_anchor_invalid"
                : source?.verdict === "reject"
                  ? "source_review_rejected"
                  : finding.category === "verdict"
                    ? "finding_without_details"
                    : resolution?.status !== "resolved"
                      ? "reviewer_left_unresolved"
                      : !resolution.evidenceIds.length ||
                          resolution.evidenceIds.some((id) => !evidenceIds.has(id))
                        ? "resolution_evidence_invalid"
                        : "artifact_quote_not_found",
          }
        : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(resolution ? { resolution } : {}),
    };
  });
}
