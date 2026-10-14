import { LCX_FINANCE_RULE_HANDOFF_CONTRACT } from "../../shared/lcx-ontology.js";
import type { CompactBacklogEntry } from "./harness-loop.js";
import type { CentralPerception, CentralRunReceipt } from "./types.js";

export type CentralRuleHandoff = Readonly<{
  proofLevel: "receipt_observation";
  semanticAdoption: "not_proven";
  observations: readonly Readonly<{
    stage: "source" | "read" | "judgment" | "reference" | "transport" | "gate";
    status:
      | "content_gap"
      | "read_failed"
      | "awaiting_judgment"
      | "judgment_unattributed"
      | "reference_rejected"
      | "impact_reported"
      | "unresolved"
      | "previously_reported"
      | "transport_failed"
      | "source_unavailable"
      | "awaiting_content"
      | "normal_block"
      | "not_observed"
      | "metadata_only";
    // Rule metadata cannot establish use of its body.
    // Normal stops and unobserved dispatch are not damage.
    artifactId?: string;
    field?: string;
    gap?: string;
    owner: string;
    next: string;
    childFields?: readonly string[];
    observationOrigin?: "current_cycle" | "prior_cycle";
    observedAt?: string;
  }>[];
  observationsOmitted?: number;
  /** This is the actual host gate outcome, not a model's claim of broker readiness. */
  gate: "blocked" | "no_block_observed";
}>;

const owner = (index: number) => LCX_FINANCE_RULE_HANDOFF_CONTRACT.stages[index].owner;
const text = (value: unknown, max = 512) =>
  typeof value === "string" ? value.slice(0, max) : undefined;
const ruleField = (field: unknown) =>
  typeof field === "string" &&
  /\/(?:rules|activeRules|ruleSummary|frozenRule)(?:\/|$)/u.test(field);
const containsBody = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(containsBody);
  }
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.hasOwn(value, "body") || Object.hasOwn(value, "frozenRule"))
  );
};
const bodyField = (field: string, value: unknown) =>
  /\/(?:body|frozenRule)(?:\/|$)/u.test(field) || containsBody(value);
type Read = CompactBacklogEntry["outcomes"][number];
const isRuleRead = (step: Read) =>
  step.ownerId === "artifact_memory_recall" &&
  (step.args?.action === "read" || step.outcome?.action === "read") &&
  ruleField(step.args?.field);

/** Diagnose only observed handoffs. No rereads, retries, promotion or business-state writes. */
export function diagnoseCentralRuleHandoff(
  receipt: CentralRunReceipt,
  perception: CentralPerception,
): CentralRuleHandoff | undefined {
  const prior = perception.backlog.flatMap((entry) =>
    Array.isArray(entry.outcomes)
      ? (entry.outcomes.filter(
          (step) => step && typeof step === "object",
        ) as CompactBacklogEntry["outcomes"])
      : [],
  );
  const current: Read[] = receipt.steps.map((step) => ({
    ...step,
    sourceObservedAt: receipt.observedAt,
    reason: step.gateReason ?? step.failureReason,
  }));
  const reads = [...prior, ...current].filter(isRuleRead);
  const origin = (step: Read) => ({
    observationOrigin: current.includes(step)
      ? ("current_cycle" as const)
      : ("prior_cycle" as const),
    ...(text(step.sourceObservedAt, 64) ? { observedAt: text(step.sourceObservedAt, 64) } : {}),
  });
  const uses = receipt.evidenceUse ?? [];
  const source = [...prior, ...current].findLast(
    (step) => step.ownerId === "finance_strategy_rule_ledger_read",
  );
  if (!reads.length && !source && !uses.some((use) => ruleField(use.field))) {
    return undefined;
  }
  const observations: CentralRuleHandoff["observations"][number][] = [];
  if (receipt.brainCall.outcome === "failed") {
    const transport = receipt.brainCall.modelCall?.transport;
    const reason = text(receipt.brainCall.reason, 160) ?? "brain_failed";
    const paymentRequired =
      transport?.httpStatus === 402 || reason.includes("provider_payment_required");
    const next = paymentRequired
      ? "The provider requires payment; leave the brain unavailable and failed actions stopped. Do not trigger a paid rerun."
      : "Check the original adapter deadline and cleanup receipt; keep failed actions stopped.";
    observations.push({
      stage: "transport",
      status: "transport_failed",
      observationOrigin: "current_cycle",
      observedAt: receipt.observedAt,
      owner: "src/agents/configured-finance-model-adapter.ts",
      gap: transport?.cleanupStatus === "unconfirmed" ? "cleanup_unconfirmed" : reason,
      next:
        transport?.cleanupStatus === "unconfirmed"
          ? `${next} Local cleanup remains unconfirmed; original failure: ${reason}.`
          : next,
    });
  }
  if (!reads.length && source) {
    observations.push({
      ...origin(source),
      stage: "source",
      status:
        source.status === "blocked_by_gate"
          ? "normal_block"
          : source.status === "approved" || source.status === "skipped"
            ? "not_observed"
            : source.status === "ran_failed" || source.outcome?.ok === false
              ? "source_unavailable"
              : "awaiting_content",
      ...(source.resultArtifact?.id ? { artifactId: source.resultArtifact.id } : {}),
      owner: owner(0),
      ...(source.outcome?.reason || source.reason
        ? { gap: text(source.outcome?.reason ?? source.reason, 120) }
        : {}),
      next:
        source.status === "blocked_by_gate"
          ? "Inspect the original host gate reason; keep the block and do not bypass it."
          : source.status === "approved" || source.status === "skipped" || !source.outcome
            ? "Inspect the original dispatch receipt; this source handoff is not observed."
            : source.status === "ran_failed" || source.outcome.ok === false
              ? "Check the original ledger absence or owner failure before inspecting rule content."
              : source.args?.includeBodies === true
                ? "Read one relevant rule body field from the registered original result before judging its content."
                : "Select the specific rule with includeBodies=true at the original ledger reader; metadata is insufficient.",
    });
  }
  for (const use of uses.filter((use) => ruleField(use.field))) {
    const read = reads.findLast(
      (step) => step.args?.id === use.artifactId && step.args?.field === use.field,
    );
    const metadataOnly =
      use.verification === "reference_verified" &&
      !bodyField(use.field, read?.outcome?.selectedValue);
    observations.push({
      stage: "reference",
      observationOrigin: "current_cycle",
      observedAt: receipt.observedAt,
      status:
        use.verification === "invalid_reference"
          ? "reference_rejected"
          : use.verification === "unresolved"
            ? "unresolved"
            : metadataOnly
              ? "metadata_only"
              : "impact_reported",
      artifactId: use.artifactId,
      field: use.field,
      ...(use.gap ? { gap: use.gap } : {}),
      owner:
        use.verification === "invalid_reference"
          ? "src/agents/central-harness/evidence-use.ts"
          : owner(2),
      next: metadataOnly
        ? "The cited field is rule metadata; select the relevant body/exit/stop condition before claiming content impact."
        : use.verification === "reference_verified"
          ? "Compare the cited rule fact with the stated judgment and later outcome; adoption remains unproven."
          : use.gap === "selected_content_not_delivered"
            ? "Read one exact child field from the same artifact before claiming rule impact."
            : "Resolve the stated source, scope or evidence gap before claiming rule impact.",
    });
  }
  // Latest attempt wins for an exact field. A child read never proves the whole parent was consumed.
  const latest = new Map<string, Read>();
  for (const read of reads) {
    const key = JSON.stringify([read.args?.id, read.args?.field]);
    latest.delete(key);
    latest.set(key, read);
  }
  for (const read of [...latest.values()].toReversed()) {
    if (uses.some((use) => use.artifactId === read.args?.id && use.field === read.args?.field)) {
      continue;
    }
    const outcome = read.outcome;
    const identity = { artifactId: text(read.args?.id, 96), field: text(read.args?.field) };
    const complete =
      read.status === "ran_ok" &&
      outcome?.available === true &&
      Object.hasOwn(outcome, "selectedValue") &&
      !read.outcomeDroppedKeys?.includes("selectedValue");
    const previousUse = perception.backlog.some(
      (entry) =>
        Array.isArray(entry.evidenceUse) &&
        entry.evidenceUse.some(
          (use) =>
            use.artifactId === identity.artifactId &&
            use.field === identity.field &&
            use.sourceSha256 === outcome?.sourceSha256 &&
            use.verification === "reference_verified",
        ),
    );
    const failed = read.status !== "ran_ok" || outcome?.available !== true;
    const unobserved =
      read.status === "approved" ||
      read.status === "skipped" ||
      (read.status === "ran_ok" && outcome === undefined);
    const metadataOnly = complete && !bodyField(identity.field ?? "", outcome?.selectedValue);
    const currentRead = current.includes(read);
    const originalSource = [...prior, ...current].findLast(
      (step) =>
        typeof read.args?.id === "string" &&
        step.ownerId === "finance_strategy_rule_ledger_read" &&
        step.resultArtifact?.id === read.args?.id,
    );
    const missingBodyField =
      failed &&
      (outcome?.gap === "artifact_field_missing" ||
        outcome?.selectionGap === "artifact_field_missing") &&
      /\/body(?:\/|$)/u.test(identity.field ?? "");
    const bodyNotRequested =
      missingBodyField &&
      originalSource?.args !== undefined &&
      originalSource.args.includeBodies !== true &&
      !originalSource.argsDroppedKeys?.includes("includeBodies");
    observations.push({
      ...identity,
      ...origin(read),
      stage: complete ? "judgment" : "read",
      status:
        read.status === "blocked_by_gate"
          ? "normal_block"
          : unobserved
            ? "not_observed"
            : failed
              ? "read_failed"
              : !complete
                ? "content_gap"
                : metadataOnly
                  ? "metadata_only"
                  : previousUse
                    ? "previously_reported"
                    : currentRead ||
                        receipt.actionsProposed > 0 ||
                        receipt.brainCall.outcome !== "completed"
                      ? "awaiting_judgment"
                      : "judgment_unattributed",
      ...(!complete
        ? {
            gap:
              text(outcome?.selectionGap, 120) ??
              text(outcome?.gap, 120) ??
              text(read.reason, 120) ??
              (failed ? "source_or_field_unavailable" : "selected_content_not_delivered"),
          }
        : {}),
      owner: bodyNotRequested
        ? owner(0)
        : failed || metadataOnly
          ? owner(1)
          : !complete
            ? owner(3)
            : owner(2),
      next:
        read.status === "blocked_by_gate"
          ? "Inspect the original host gate reason; keep the block and do not bypass it."
          : unobserved
            ? "Dispatch or digest is not observed; inspect the original receipt before treating this as a source failure."
            : metadataOnly
              ? "Only rule metadata was delivered; select the specific rule body for the question."
              : bodyNotRequested
                ? "The original ledger result did not request rule bodies. Select this rule with includeBodies=true at the original ledger reader; do not reread the same absent immutable field."
                : missingBodyField
                  ? "This immutable body field is absent. Inspect its original owner; if it is a metadata-only finance ledger result, select the specific rule with includeBodies=true."
                  : failed
                    ? "Check the original artifact id, source and field at the recall owner; preserve the gap."
                    : !complete
                      ? Array.isArray(outcome?.selectionHints) && outcome.selectionHints.length
                        ? "Choose one child field for the unresolved question; keep the original artifact and hash."
                        : "No child pointer delivered; inspect the original field shape or source before another read."
                      : previousUse
                        ? "Prior impact was reported; verify subsequent outcome without claiming semantic adoption."
                        : "Use the delivered rule fact to explain retain/change/unresolved in the next judgment.",
      ...(!complete && Array.isArray(outcome?.selectionHints)
        ? {
            childFields: outcome.selectionHints
              .flatMap((hint: unknown) => {
                const field =
                  hint && typeof hint === "object" ? Reflect.get(hint, "field") : undefined;
                return typeof field === "string" ? [field.slice(0, 512)] : [];
              })
              .toSorted((a, b) => Number(b.endsWith("/body")) - Number(a.endsWith("/body")))
              .slice(0, 3),
          }
        : {}),
    });
  }
  const kept = observations.slice(0, 4);
  return {
    proofLevel: "receipt_observation",
    semanticAdoption: "not_proven",
    observations: kept,
    ...(observations.length > kept.length
      ? { observationsOmitted: observations.length - kept.length }
      : {}),
    gate: receipt.actionsBlockedByGate > 0 ? "blocked" : "no_block_observed",
  };
}

/** Keep diagnostics in the original bounded feedback path, with explicit omissions. */
export function compactRuleHandoff(diagnostic: CentralRuleHandoff): CentralRuleHandoff {
  const observations: CentralRuleHandoff["observations"][number][] = [];
  for (const observation of diagnostic.observations) {
    if (
      Buffer.byteLength(
        JSON.stringify({ ...diagnostic, observations: [...observations, observation] }),
      ) <= 1400
    ) {
      observations.push(observation);
    }
  }
  return {
    ...diagnostic,
    observations,
    observationsOmitted:
      (diagnostic.observationsOmitted ?? 0) + diagnostic.observations.length - observations.length,
  };
}
