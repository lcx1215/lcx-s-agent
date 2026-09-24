import { createHash } from "node:crypto";
import { z } from "zod";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  appendFinanceThesisEvidence,
  openFinanceThesis,
  readFinanceThesisLedger,
  type FinanceThesisEvidence,
  type FinanceThesisOpenInput,
} from "./finance-thesis-ledger.js";
import type { QualityHarnessClaim } from "./quality-harness-contract.js";

const Text = z.string().trim().min(1);

export const FinanceResearchThesisProposalSchema = z
  .object({
    claimId: Text,
    instrument: Text,
    rationale: Text.optional(),
    invalidationConditions: z.array(Text).min(1),
  })
  .strict();

export type FinanceResearchThesisProposal = z.infer<typeof FinanceResearchThesisProposalSchema>;

export type FinanceResearchThesisLearningResult = Readonly<{
  status: "not_eligible" | "no_proposals" | "persisted" | "partial" | "refused";
  reason?: string;
  ledgerDirectory?: string;
  observedAt?: string;
  recordCount?: number;
  headRef?: string | null;
  results: readonly Readonly<{
    thesisId: string;
    action: "opened" | "evidence_appended" | "unchanged" | "refused";
    recordRef?: string;
    reason?: string;
  }>[];
}>;

type ValidatedProposal = Readonly<{
  thesisId: string;
  instrument: string;
  claim: string;
  rationale: string;
  invalidationConditions: readonly string[];
  evidence: readonly FinanceThesisEvidence[];
}>;

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function thesisId(instrument: string, claim: string): string {
  return createHash("sha256")
    .update(JSON.stringify([instrument.trim().toUpperCase(), normalized(claim)]))
    .digest("hex");
}

function instrumentEvidenceMatches(
  evidence: FinanceCommitteeEvidence,
  instrument: string,
): boolean {
  const expectedId = `finance-model:${encodeURIComponent(instrument)}`;
  if (evidence.id === expectedId) {
    return true;
  }
  const text = evidence.text.toUpperCase();
  const symbol = instrument.toUpperCase();
  const index = text.indexOf(symbol);
  if (index < 0) {
    return false;
  }
  const isAlphaNumeric = (value: string | undefined) =>
    value !== undefined && /[A-Z0-9]/u.test(value);
  return !isAlphaNumeric(text[index - 1]) && !isAlphaNumeric(text[index + symbol.length]);
}

/** Validate proposals against this exact run's supported claims, evidence packet, and universe. */
export function validateFinanceResearchThesisProposals(params: {
  value: unknown;
  claims: readonly QualityHarnessClaim[];
  evidence: readonly FinanceCommitteeEvidence[];
  instruments: readonly string[];
  asOf: string;
  receiptReference: string;
  runId: string;
}): readonly ValidatedProposal[] {
  if (params.value === undefined) {
    return [];
  }
  const proposals = z.array(FinanceResearchThesisProposalSchema).parse(params.value);
  const claims = new Map(params.claims.map((claim) => [claim.id, claim]));
  const evidenceById = new Map(params.evidence.map((item) => [item.id, item]));
  const instruments = new Map(
    params.instruments.map((instrument) => [instrument.trim().toUpperCase(), instrument.trim()]),
  );
  const asOfMs = Date.parse(params.asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error("thesis proposal requires a valid research as-of timestamp");
  }

  const seenTheses = new Set<string>();
  return Object.freeze(
    proposals.map((proposal) => {
      const claim = claims.get(proposal.claimId);
      if (!claim || claim.status !== "supported") {
        throw new Error(`thesis proposal claim is not a supported claim: ${proposal.claimId}`);
      }
      const instrument = instruments.get(proposal.instrument.trim().toUpperCase());
      if (!instrument) {
        throw new Error(`thesis proposal instrument is outside this run's declared universe`);
      }
      const evidence = claim.evidenceIds.map((id) => {
        const item = evidenceById.get(id);
        if (!item) {
          throw new Error(`thesis proposal claim cites evidence missing from this run: ${id}`);
        }
        const timestamp = Date.parse(item.timestamp);
        if (!Number.isFinite(timestamp) || timestamp > asOfMs) {
          throw new Error(`thesis proposal cites evidence outside the run's as-of window: ${id}`);
        }
        return item;
      });
      if (evidence.length === 0) {
        throw new Error(`thesis proposal claim has no evidence: ${proposal.claimId}`);
      }
      if (!evidence.some((item) => instrumentEvidenceMatches(item, instrument))) {
        throw new Error(`thesis proposal lacks cited evidence tied to ${instrument}`);
      }
      const id = thesisId(instrument, claim.text);
      if (seenTheses.has(id)) {
        throw new Error(`duplicate thesis proposal for ${instrument}`);
      }
      seenTheses.add(id);
      return Object.freeze({
        thesisId: id,
        instrument,
        claim: claim.text,
        rationale: proposal.rationale ?? "",
        invalidationConditions: Object.freeze([...proposal.invalidationConditions]),
        evidence: Object.freeze(
          evidence.map((item) => ({
            id: `${params.runId}:${item.id}`,
            source: item.source,
            reference: `${params.receiptReference}#evidence=${encodeURIComponent(item.id)}`,
            summary: item.text,
          })),
        ),
      });
    }),
  );
}

function openInput(proposal: ValidatedProposal, observedAt: string): FinanceThesisOpenInput {
  const rationale = [
    "Unadopted model-generated research candidate; independently revalidate with fresh evidence before each use.",
    proposal.rationale,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    thesisId: proposal.thesisId,
    instrument: proposal.instrument,
    claim: proposal.claim,
    rationale,
    evidence: [...proposal.evidence],
    invalidationConditions: [...proposal.invalidationConditions],
    observedAt,
  };
}

function sameConditions(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left.map(normalized)) === JSON.stringify(right.map(normalized));
}

/** Persist only a fully gated research result; no path in this module reaches trading execution. */
export async function persistFinanceResearchThesisLearning(params: {
  directory: string;
  eligible: boolean;
  proposals: readonly ValidatedProposal[];
  observedAt: string;
}): Promise<FinanceResearchThesisLearningResult> {
  if (!params.eligible) {
    return Object.freeze({
      status: "not_eligible",
      reason: "source, committee, or quality research gate did not pass",
      ledgerDirectory: params.directory,
      results: Object.freeze([]),
    });
  }
  if (params.proposals.length === 0) {
    return Object.freeze({
      status: "no_proposals",
      ledgerDirectory: params.directory,
      results: Object.freeze([]),
    });
  }

  let operations: {
    proposal: ValidatedProposal;
    action: "opened" | "evidence_appended" | "unchanged";
  }[];
  try {
    const ledger = await readFinanceThesisLedger(params.directory);
    const byId = new Map(ledger.theses.map((item) => [item.thesisId, item]));
    operations = params.proposals.map((proposal) => {
      const existing = byId.get(proposal.thesisId);
      if (!existing) {
        return { proposal, action: "opened" as const };
      }
      if (existing.state !== "active") {
        throw new Error(`thesis ${proposal.thesisId} is closed; automatic reopening is refused`);
      }
      if (
        existing.instrument !== proposal.instrument ||
        normalized(existing.claim) !== normalized(proposal.claim) ||
        !sameConditions(existing.invalidationConditions, proposal.invalidationConditions)
      ) {
        throw new Error(`thesis ${proposal.thesisId} changed claim or invalidation conditions`);
      }
      const existingEvidenceIds = new Set(existing.evidence.map((item) => item.id));
      const newEvidence = proposal.evidence.filter((item) => !existingEvidenceIds.has(item.id));
      return {
        proposal: { ...proposal, evidence: Object.freeze(newEvidence) },
        action: newEvidence.length === 0 ? ("unchanged" as const) : ("evidence_appended" as const),
      };
    });
  } catch (error) {
    return Object.freeze({
      status: "refused",
      reason: error instanceof Error ? error.message : String(error),
      ledgerDirectory: params.directory,
      results: Object.freeze([]),
    });
  }

  const results: Array<{
    thesisId: string;
    action: "opened" | "evidence_appended" | "unchanged" | "refused";
    recordRef?: string;
    reason?: string;
  }> = [];
  for (const operation of operations) {
    try {
      if (operation.action === "unchanged") {
        results.push({ thesisId: operation.proposal.thesisId, action: "unchanged" });
        continue;
      }
      const result =
        operation.action === "opened"
          ? await openFinanceThesis(
              params.directory,
              openInput(operation.proposal, params.observedAt),
            )
          : await appendFinanceThesisEvidence(params.directory, {
              thesisId: operation.proposal.thesisId,
              evidence: [...operation.proposal.evidence],
              observedAt: params.observedAt,
            });
      results.push({
        thesisId: operation.proposal.thesisId,
        action: result.appended ? operation.action : "unchanged",
        recordRef: result.record.ref,
      });
    } catch (error) {
      results.push({
        thesisId: operation.proposal.thesisId,
        action: "refused",
        reason: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  const refused = results.some((item) => item.action === "refused");
  const persisted = results.some(
    (item) => item.action === "opened" || item.action === "evidence_appended",
  );
  let updated: Awaited<ReturnType<typeof readFinanceThesisLedger>>;
  try {
    updated = await readFinanceThesisLedger(params.directory);
  } catch (error) {
    return Object.freeze({
      status: persisted ? "partial" : "refused",
      reason: `ledger was written or attempted but could not be re-read: ${error instanceof Error ? error.message : String(error)}`,
      observedAt: params.observedAt,
      ledgerDirectory: params.directory,
      results: Object.freeze(results),
    });
  }
  return Object.freeze({
    status: refused ? (persisted ? "partial" : "refused") : "persisted",
    observedAt: params.observedAt,
    ledgerDirectory: params.directory,
    recordCount: updated.recordCount,
    headRef: updated.headRef,
    results: Object.freeze(results),
  });
}
