import { z } from "zod";
import { readFinanceThesisLedger } from "./finance-thesis-ledger.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Text = z.string().trim().min(1);

const EvidenceSchema = z
  .object({
    id: Text.max(120),
    source: Text.max(120),
    reference: Text.max(240),
    summary: Text.max(240).optional(),
  })
  .strict();

const ThesisSchema = z
  .object({
    thesisId: Text.max(64),
    instrument: Text.max(120),
    claim: Text.max(480),
    rationale: Text.max(320).nullable(),
    openedAt: z.string().datetime(),
    invalidationConditions: z.array(Text.max(240)).max(5),
    evidence: z.array(EvidenceSchema).max(4),
    omittedEvidenceCount: z.number().int().nonnegative(),
  })
  .strict();

export const FinanceThesisDecisionContextSchema = z
  .object({
    schemaVersion: z.literal("lcx_finance_thesis_decision_context_v1"),
    observedAt: z.string().datetime(),
    ledgerHeadRef: Hash.nullable(),
    activeThesisCount: z.number().int().nonnegative(),
    theses: z.array(ThesisSchema).max(8),
    omittedThesisCount: z.number().int().nonnegative(),
  })
  .strict();

export type FinanceThesisDecisionContext = z.infer<typeof FinanceThesisDecisionContextSchema>;

const MAX_THESIS_COUNT = 8;

function bounded(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Read the existing thesis ledger into a bounded per-decision projection; it creates no store. */
export async function buildFinanceThesisDecisionContext(params: {
  directory: string;
  asOf: string;
  instruments: readonly string[];
}): Promise<FinanceThesisDecisionContext> {
  const ledger = await readFinanceThesisLedger(params.directory, { asOf: params.asOf });
  const instruments = new Set(params.instruments.map((item) => item.trim().toUpperCase()));
  const active = ledger.theses
    .filter((thesis) => thesis.state === "active")
    .toSorted((left, right) => {
      const leftMatches = instruments.has(left.instrument.trim().toUpperCase());
      const rightMatches = instruments.has(right.instrument.trim().toUpperCase());
      if (leftMatches !== rightMatches) {
        return leftMatches ? -1 : 1;
      }
      return (
        right.openedAt.localeCompare(left.openedAt) || left.thesisId.localeCompare(right.thesisId)
      );
    });
  const theses = active.slice(0, MAX_THESIS_COUNT).map((thesis) => ({
    thesisId: bounded(thesis.thesisId, 64),
    instrument: bounded(thesis.instrument, 120),
    claim: bounded(thesis.claim, 480),
    rationale: thesis.rationale === null ? null : bounded(thesis.rationale, 320),
    openedAt: thesis.openedAt,
    invalidationConditions: thesis.invalidationConditions
      .slice(0, 5)
      .map((condition) => bounded(condition, 240)),
    evidence: thesis.evidence.slice(0, 4).map((item) => ({
      id: bounded(item.id, 120),
      source: bounded(item.source, 120),
      reference: bounded(item.reference, 240),
      ...(item.summary === undefined ? {} : { summary: bounded(item.summary, 240) }),
    })),
    omittedEvidenceCount: Math.max(0, thesis.evidence.length - 4),
  }));

  return FinanceThesisDecisionContextSchema.parse({
    schemaVersion: "lcx_finance_thesis_decision_context_v1",
    observedAt: params.asOf,
    ledgerHeadRef: ledger.headRef,
    activeThesisCount: active.length,
    theses,
    omittedThesisCount: Math.max(0, active.length - theses.length),
  });
}
