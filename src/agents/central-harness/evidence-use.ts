import { createHash } from "node:crypto";
import { assertValidLcxOntologyEdges, type LcxOntologyEdge } from "../../shared/lcx-ontology.js";
import type { CompactBacklogEntry } from "./harness-loop.js";
import type { CentralEvidenceUse, CentralPerception, CentralVerifiedEvidenceUse } from "./types.js";

/** Verify delivery and identity, never the truth of a model-authored judgment. */
export function verifyCentralEvidenceUse(
  uses: readonly CentralEvidenceUse[],
  perception: CentralPerception,
) {
  const reads = perception.backlog.flatMap((entry) =>
    Array.isArray(entry.outcomes)
      ? (entry.outcomes.filter(
          (step) => step && typeof step === "object",
        ) as CompactBacklogEntry["outcomes"])
      : [],
  );
  const verified: CentralVerifiedEvidenceUse[] = uses.map((use) => {
    const read = reads.find(
      (step) =>
        step.ownerId === "artifact_memory_recall" &&
        step.status === "ran_ok" &&
        step.args?.id === use.artifactId &&
        step.args?.field === use.field &&
        step.outcome?.artifactId === use.artifactId &&
        step.outcome?.field === use.field &&
        step.outcome?.sourceSha256 === use.sourceSha256,
    );
    const known = reads.flatMap((step) =>
      step.resultArtifact?.id === use.artifactId && step.resultArtifact.sha256
        ? [step.resultArtifact.sha256]
        : [],
    );
    const outcome = read?.outcome;
    const scope = outcome?.selectionScope as Record<string, unknown> | undefined;
    const invalid = !read
      ? "matching_read_not_delivered"
      : known.some((hash) => hash !== use.sourceSha256)
        ? "source_hash_conflict"
        : Object.entries(use.scope ?? {}).some(([key, value]) => scope?.[key] !== value)
          ? "source_scope_mismatch"
          : typeof outcome?.sourceObservedAt === "string" &&
              Date.parse(outcome.sourceObservedAt) > Date.parse(perception.observedAt)
            ? "source_after_decision_cutoff"
            : undefined;
    if (invalid) {
      return { ...use, verification: "invalid_reference", gap: invalid };
    }
    const complete =
      outcome?.available === true &&
      Object.hasOwn(outcome, "selectedValue") &&
      !read?.outcomeDroppedKeys?.includes("selectedValue");
    return {
      ...use,
      ...(scope && Object.keys(scope).length
        ? { scope: scope as CentralVerifiedEvidenceUse["scope"] }
        : {}),
      verification: complete && use.effect !== "unresolved" ? "reference_verified" : "unresolved",
      ...(!complete ? { gap: "selected_content_not_delivered" } : {}),
      ...(complete
        ? {
            sourceValueSha256: createHash("sha256")
              .update(JSON.stringify(outcome.selectedValue))
              .digest("hex"),
          }
        : {}),
    };
  });
  return verified;
}

/** Existing ontology relations tie a source-bound judgment to its business scope. */
export function centralEvidenceUseEdges(
  runId: string,
  uses: readonly CentralVerifiedEvidenceUse[],
): LcxOntologyEdge[] {
  const edges: LcxOntologyEdge[] = [];
  for (const [index, use] of uses.entries()) {
    if (use.verification !== "reference_verified") {
      continue;
    }
    const claim = { type: "claim" as const, id: `${runId}:evidence-use:${index}` };
    edges.push({
      relation: "derived_from",
      subject: claim,
      object: { type: "artifact", id: use.artifactId },
    });
    edges.push({ relation: "observed_as", subject: claim, object: { type: "receipt", id: runId } });
    for (const [kind, id] of Object.entries(use.scope ?? {})) {
      for (const value of Array.isArray(id) ? id : [id]) {
        edges.push({
          relation: "scoped_to",
          subject: claim,
          object: {
            type: kind === "ruleId" ? "policy" : "domain_entity",
            id: `${kind === "instruments" ? "instrument" : kind}:${value}`,
          },
        });
      }
    }
  }
  assertValidLcxOntologyEdges(edges, "central evidence-use edges");
  return edges;
}
