import { z } from "zod";
import { FinanceExpectationGapSchema } from "./finance-expectation-gap.js";
import {
  buildFinanceFundamentalDecisionContext,
  FinanceFundamentalDecisionContextSchema,
} from "./finance-fundamental-decision-context.js";
import {
  FINANCE_THESIS_CLAIM_EPISTEMIC_CLASSES,
  FINANCE_THESIS_EVIDENCE_RELATIONS,
  readFinanceThesisLedger,
  FinanceThesisApplicabilitySchema,
  type FinanceThesisApplicability,
} from "./finance-thesis-ledger.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Text = z.string().trim().min(1);

const EvidenceSchema = z
  .object({
    id: Text.max(120),
    source: Text.max(120),
    reference: Text.max(240),
    summary: Text.max(240).optional(),
    relation: z.enum(FINANCE_THESIS_EVIDENCE_RELATIONS).optional(),
    evidenceAsOf: z.string().datetime().optional(),
  })
  .strict();

const ThesisSchema = z
  .object({
    thesisId: Text.max(64),
    instrument: Text.max(120),
    claim: Text.max(480),
    claimEpistemicClass: z.enum(FINANCE_THESIS_CLAIM_EPISTEMIC_CLASSES).optional(),
    claimBasis: Text.max(1_000).nullable().optional(),
    rationale: Text.max(320).nullable(),
    expectationGap: FinanceExpectationGapSchema.optional(),
    openedAt: z.string().datetime(),
    applicability: FinanceThesisApplicabilitySchema.optional(),
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
    excludedThesisCount: z.number().int().nonnegative().optional(),
    horizon: z.enum(["intraday", "swing", "long_term"]).optional(),
    fundamentals: FinanceFundamentalDecisionContextSchema.optional(),
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
  horizon?: FinanceThesisApplicability["horizon"];
}): Promise<FinanceThesisDecisionContext> {
  const ledger = await readFinanceThesisLedger(params.directory, { asOf: params.asOf });
  const instruments = new Set(params.instruments.map((item) => item.trim().toUpperCase()));
  const activeCount = ledger.theses.filter((thesis) => thesis.state === "active").length;
  const active = ledger.theses
    .filter((thesis) => thesis.state === "active")
    .filter(
      (thesis) =>
        !params.horizon ||
        (instruments.has(thesis.instrument.trim().toUpperCase()) &&
          thesis.applicability?.horizon === params.horizon &&
          Date.parse(thesis.applicability.validUntil) > Date.parse(params.asOf)),
    )
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
    claimEpistemicClass: thesis.claimEpistemicClass,
    claimBasis: thesis.claimBasis === null ? null : bounded(thesis.claimBasis, 1_000),
    rationale: thesis.rationale === null ? null : bounded(thesis.rationale, 320),
    ...(thesis.expectationGap ? { expectationGap: thesis.expectationGap } : {}),
    openedAt: thesis.openedAt,
    ...(thesis.applicability ? { applicability: thesis.applicability } : {}),
    invalidationConditions: thesis.invalidationConditions
      .slice(0, 5)
      .map((condition) => bounded(condition, 240)),
    // Put counterevidence first so a bounded projection cannot hide it behind early support.
    evidence: thesis.evidence
      .toSorted(
        (left, right) =>
          Number(right.relation === "contradicts") - Number(left.relation === "contradicts"),
      )
      .slice(0, 4)
      .map((item) => ({
        id: bounded(item.id, 120),
        source: bounded(item.source, 120),
        reference: bounded(item.reference, 240),
        ...(item.summary === undefined ? {} : { summary: bounded(item.summary, 240) }),
        ...(item.relation === undefined ? {} : { relation: item.relation }),
        ...(item.evidenceAsOf === undefined ? {} : { evidenceAsOf: item.evidenceAsOf }),
      })),
    omittedEvidenceCount: Math.max(0, thesis.evidence.length - 4),
  }));

  return FinanceThesisDecisionContextSchema.parse({
    schemaVersion: "lcx_finance_thesis_decision_context_v1",
    observedAt: params.asOf,
    ledgerHeadRef: ledger.headRef,
    fundamentals: buildFinanceFundamentalDecisionContext(params),
    activeThesisCount: activeCount,
    ...(params.horizon
      ? { horizon: params.horizon, excludedThesisCount: activeCount - active.length }
      : {}),
    theses,
    omittedThesisCount: Math.max(0, active.length - theses.length),
  });
}
