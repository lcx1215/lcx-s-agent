import { z } from "zod";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { validateFinanceResearchThesisProposals } from "./finance-research-thesis-learning.js";
import {
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
} from "./finance-strategy-rule-ledger.js";
import type { QualityHarnessClaim } from "./quality-harness-contract.js";

const Text = z.string().trim().min(1).max(240);
export const FinanceResearchStrategyProposalSchema = z
  .object({
    claimId: Text,
    form: Text,
    formVersion: Text.optional(),
    instruments: z.array(Text).min(1).max(100),
    emits: Text,
    schedule: z.object({ kind: Text, at: Text.optional(), timezone: Text.optional() }).strict(),
    body: z
      .record(z.string(), z.unknown())
      .refine(
        (value) =>
          Object.keys(value).length > 0 && Buffer.byteLength(JSON.stringify(value)) <= 16384,
        "method body must be nonempty and bounded",
      ),
    invalidationConditions: z.array(Text).min(1).max(12),
  })
  .strict();

/** Reviewed method proposals enter the original draft ledger, never an activation or order. */
export async function persistFinanceResearchStrategyLearning(params: {
  directory: string;
  eligible: boolean;
  value: unknown;
  claims: readonly QualityHarnessClaim[];
  evidence: readonly FinanceCommitteeEvidence[];
  instruments: readonly string[];
  asOf: string;
  observedAt: string;
  receiptReference: string;
  runId: string;
}) {
  if (!params.eligible) {
    return { status: "not_eligible", results: [] };
  }
  z.string().datetime().parse(params.observedAt);
  const proposals = z
    .array(FinanceResearchStrategyProposalSchema)
    .max(8)
    .parse(params.value ?? []);
  if (!proposals.length) {
    return { status: "no_proposals", results: [] };
  }
  if (
    !params.runId.trim() ||
    !params.receiptReference.trim() ||
    Date.parse(params.observedAt) < Date.parse(params.asOf)
  ) {
    throw new Error("method proposal requires original research receipt and ordered cutoff");
  }
  if (
    new Set(params.evidence.map((item) => item.id)).size !== params.evidence.length ||
    new Set(params.claims.map((claim) => claim.id)).size !== params.claims.length
  ) {
    throw new Error("ambiguous method source or claim identity");
  }
  const inputs = proposals.map((proposal) => {
    // Reuse exact claim/basis/source/as-of/instrument qualification; a valid rule envelope
    // alone says nothing about its evidence, implementation, or economic usefulness.
    validateFinanceResearchThesisProposals({
      value: proposal.instruments.map((instrument) => ({
        claimId: proposal.claimId,
        instrument,
        invalidationConditions: proposal.invalidationConditions,
      })),
      claims: params.claims,
      evidence: params.evidence,
      instruments: params.instruments,
      asOf: params.asOf,
      receiptReference: params.receiptReference,
      runId: params.runId,
    });
    const method = {
      form: proposal.form,
      ...(proposal.formVersion ? { formVersion: proposal.formVersion } : {}),
      instruments: [
        ...new Set(proposal.instruments.map((instrument) => instrument.toUpperCase())),
      ].toSorted(),
      emits: proposal.emits,
      schedule: proposal.schedule,
      body: proposal.body,
    };
    if (method.instruments.length !== proposal.instruments.length) {
      throw new Error("duplicate method instruments");
    }
    const claim = params.claims.find((item) => item.id === proposal.claimId)!;
    return {
      kind: "declared" as const,
      ruleId: `research_${caseflowFingerprint(method).slice(0, 48)}`,
      ...method,
      observedAt: params.observedAt,
      provenance: {
        origin: "verified_finance_research",
        revision: params.runId,
        researchReceiptReference: params.receiptReference,
        claimId: claim.id,
        mechanism: claim.text,
        invalidationConditions: proposal.invalidationConditions,
        evidence: claim.evidenceIds.map((id) => ({
          id,
          sha256: caseflowFingerprint(params.evidence.find((item) => item.id === id)),
        })),
        boundary: "draft_only_implementation_validation_and_separate_activation_required",
      },
    };
  });
  if (new Set(inputs.map((input) => input.ruleId)).size !== inputs.length) {
    throw new Error("duplicate method proposals");
  }
  const prior = await readFinanceStrategyRuleLedger(params.directory);
  const results = [];
  for (const input of inputs) {
    const existing = prior.ledger.rules.find((rule) => rule.ruleId === input.ruleId);
    if (existing) {
      // Content-derived identity is immutable, including retired history. Never reactivate
      // or replace an earlier rule merely because another research run proposed it again.
      const declaration = existing.transitions.find((record) => record.body.kind === "declared");
      if (
        !declaration ||
        declaration.body.kind !== "declared" ||
        caseflowFingerprint({
          form: existing.form,
          ...(existing.formVersion ? { formVersion: existing.formVersion } : {}),
          instruments: existing.instruments,
          emits: existing.emits,
          schedule: existing.schedule,
          body: existing.body,
        }) !==
          caseflowFingerprint({
            form: input.form,
            ...(input.formVersion ? { formVersion: input.formVersion } : {}),
            instruments: input.instruments,
            emits: input.emits,
            schedule: input.schedule,
            body: input.body,
          })
      ) {
        throw new Error("method identity conflict");
      }
      results.push({
        ruleId: input.ruleId,
        action: "unchanged",
        state: existing.state,
        declarationRef: declaration.ref,
      });
      continue;
    }
    const saved = await declareFinanceStrategyRule(params.directory, input);
    results.push({
      ruleId: input.ruleId,
      action: "declared",
      state: "draft",
      declarationRef: saved.record.ref,
    });
  }
  return {
    status: "persisted",
    executionAuthority: "none",
    results,
    nextStep:
      "original_form_implementation_validation_then_independent_activation_and_original_execution_gates",
  };
}
