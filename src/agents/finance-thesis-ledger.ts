/**
 * The durable thesis ledger.
 *
 * A thesis is a claim the owner made about an instrument, together with the conditions that
 * would prove it wrong. Before this ledger existed, `thesis` was vocabulary in the ontology
 * (`LCX_ONTOLOGY_DOMAIN_ENTITY_TYPES`) plus prompt content plus an answer requirement —
 * real, but not a stored object, so nothing survived the run that produced it. This stores it.
 *
 * Following the repository rule, **events are stored, derived state is not**. So:
 *
 * - Records are `opened`, `evidence_appended`, or `transition`. There is no `state` column and no
 *   `from` field: the current state is whatever replaying the stream produces, and `from` is
 *   always available by replay. Storing either would create a second source of truth that can
 *   drift from the events it claims to summarise.
 * - Closing is a transition to a terminal state (`invalidated` / `realised`). Re-opening is not
 *   modelled: a closed thesis is history, and a new belief is a new thesis.
 *
 * A thesis confers no execution authority. Every record carries `executionAuthority: "none"`
 * so that boundary is stated by the record itself rather than by whoever reads it.
 */

import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES } from "../shared/lcx-ontology.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  FinanceExpectationGapSchema,
  type FinanceExpectationGap,
} from "./finance-expectation-gap.js";
import {
  FINANCE_RESEARCH_CLAIM_EPISTEMIC_CLASSES,
  FINANCE_RESEARCH_EVIDENCE_RELATIONS,
  financeResearchClaimRequiresBasis,
  type FinanceResearchClaimEpistemicClass,
  type FinanceResearchEvidenceRelation,
} from "./finance-research-provenance.js";
import { financeThesisLedgerPath } from "./finance-state-dir.js";

const Text = z.string().trim().min(1);
const Iso = z.string().datetime();
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const ThesisId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/u);

const FINANCE_THESIS_RECORD_SCHEMA_V1 = "lcx_finance_thesis_record_v1" as const;
const FINANCE_THESIS_RECORD_SCHEMA_V2 = "lcx_finance_thesis_record_v2" as const;
export const FINANCE_THESIS_RECORD_SCHEMA = "lcx_finance_thesis_record_v3" as const;

export const FINANCE_THESIS_CLAIM_EPISTEMIC_CLASSES = FINANCE_RESEARCH_CLAIM_EPISTEMIC_CLASSES;
export type FinanceThesisClaimEpistemicClass = FinanceResearchClaimEpistemicClass;
export const FINANCE_THESIS_EVIDENCE_RELATIONS = FINANCE_RESEARCH_EVIDENCE_RELATIONS;
export type FinanceThesisEvidenceRelation = FinanceResearchEvidenceRelation;

/** A thesis is opened into `active` and leaves it exactly once. */
export const FINANCE_THESIS_STATES = ["active", "invalidated", "realised"] as const;
export type FinanceThesisState = (typeof FINANCE_THESIS_STATES)[number];

/** States a thesis may be transitioned *to*. `active` is only ever entered by opening. */
export const FINANCE_THESIS_TRANSITIONS = ["invalidated", "realised"] as const;
export type FinanceThesisTransitionState = (typeof FINANCE_THESIS_TRANSITIONS)[number];

const EvidenceLink = z
  .object({
    id: Text,
    source: Text,
    reference: Text,
    summary: Text.optional(),
  })
  .strict();
const EvidenceLinkV3 = z
  .object({
    id: Text,
    source: Text,
    reference: Text,
    summary: Text.optional(),
    relation: z.enum(FINANCE_THESIS_EVIDENCE_RELATIONS),
    /** Research packet as-of; not the underlying source publication timestamp. */
    evidenceAsOf: Iso.optional(),
  })
  .strict();
const EvidenceLinkInput = z
  .object({
    id: Text,
    source: Text,
    reference: Text,
    summary: Text.optional(),
    relation: z.enum(FINANCE_THESIS_EVIDENCE_RELATIONS).optional(),
    evidenceAsOf: Iso.optional(),
  })
  .strict();
export type FinanceThesisEvidence = z.infer<typeof EvidenceLinkV3>;
export type FinanceThesisEvidenceInput = z.infer<typeof EvidenceLinkInput>;

export const FinanceThesisApplicabilitySchema = z
  .object({
    horizon: z.enum(["intraday", "swing", "long_term"]),
    validUntil: Iso,
  })
  .strict();
export type FinanceThesisApplicability = z.infer<typeof FinanceThesisApplicabilitySchema>;

export const FinanceThesisOpenInput = z
  .object({
    thesisId: ThesisId,
    instrument: Text,
    claim: Text,
    claimEpistemicClass: z.enum(FINANCE_THESIS_CLAIM_EPISTEMIC_CLASSES).optional(),
    claimBasis: Text.max(2_000).optional(),
    applicability: FinanceThesisApplicabilitySchema.optional(),
    expectationGap: FinanceExpectationGapSchema.optional(),
    rationale: Text.optional(),
    evidence: z.array(EvidenceLinkInput).min(1),
    invalidationConditions: z.array(Text).min(1),
    observedAt: Iso,
  })
  .strict();
export type FinanceThesisOpenInput = z.infer<typeof FinanceThesisOpenInput>;

export const FinanceThesisTransitionInput = z
  .object({
    thesisId: ThesisId,
    to: z.enum(FINANCE_THESIS_TRANSITIONS),
    reason: Text,
    evidence: z.array(EvidenceLinkInput).optional(),
    observedAt: Iso,
  })
  .strict();
export type FinanceThesisTransitionInput = z.infer<typeof FinanceThesisTransitionInput>;

export const FinanceThesisEvidenceAppendInput = z
  .object({
    thesisId: ThesisId,
    evidence: z.array(EvidenceLinkInput).min(1),
    observedAt: Iso,
  })
  .strict();
export type FinanceThesisEvidenceAppendInput = z.infer<typeof FinanceThesisEvidenceAppendInput>;

const OpenedBodyV2 = z
  .object({
    kind: z.literal("opened"),
    thesisId: ThesisId,
    instrument: Text,
    claim: Text,
    rationale: Text.optional(),
    evidence: z.array(EvidenceLink).min(1),
    invalidationConditions: z.array(Text).min(1),
    observedAt: Iso,
  })
  .strict();

const OpenedBodyV3 = z
  .object({
    kind: z.literal("opened"),
    thesisId: ThesisId,
    instrument: Text,
    claim: Text,
    claimEpistemicClass: z.enum(FINANCE_THESIS_CLAIM_EPISTEMIC_CLASSES),
    claimBasis: Text.nullable(),
    applicability: FinanceThesisApplicabilitySchema.optional(),
    expectationGap: FinanceExpectationGapSchema.optional(),
    rationale: Text.optional(),
    evidence: z.array(EvidenceLinkV3).min(1),
    invalidationConditions: z.array(Text).min(1),
    observedAt: Iso,
  })
  .strict();

const TransitionBodyV2 = z
  .object({
    kind: z.literal("transition"),
    thesisId: ThesisId,
    to: z.enum(FINANCE_THESIS_TRANSITIONS),
    reason: Text,
    evidence: z.array(EvidenceLink).optional(),
    observedAt: Iso,
  })
  .strict();

const TransitionBodyV3 = z
  .object({
    kind: z.literal("transition"),
    thesisId: ThesisId,
    to: z.enum(FINANCE_THESIS_TRANSITIONS),
    reason: Text,
    evidence: z.array(EvidenceLinkV3).optional(),
    observedAt: Iso,
  })
  .strict();

const EvidenceAppendedBodyV2 = z
  .object({
    kind: z.literal("evidence_appended"),
    thesisId: ThesisId,
    evidence: z.array(EvidenceLink).min(1),
    observedAt: Iso,
  })
  .strict();

const EvidenceAppendedBodyV3 = z
  .object({
    kind: z.literal("evidence_appended"),
    thesisId: ThesisId,
    evidence: z.array(EvidenceLinkV3).min(1),
    observedAt: Iso,
  })
  .strict();

const LegacyRecordBody = z.discriminatedUnion("kind", [OpenedBodyV2, TransitionBodyV2]);
const RecordBodyV2 = z.discriminatedUnion("kind", [
  OpenedBodyV2,
  TransitionBodyV2,
  EvidenceAppendedBodyV2,
]);
const RecordBodyV3 = z.discriminatedUnion("kind", [
  OpenedBodyV3,
  TransitionBodyV3,
  EvidenceAppendedBodyV3,
]);
const StoredRecordV1 = z
  .object({
    schemaVersion: z.literal(FINANCE_THESIS_RECORD_SCHEMA_V1),
    recordKey: Text,
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: Iso,
    executionAuthority: z.enum(LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES),
    body: LegacyRecordBody,
  })
  .strict();
const StoredRecordV2 = z
  .object({
    schemaVersion: z.literal(FINANCE_THESIS_RECORD_SCHEMA_V2),
    recordKey: Text,
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: Iso,
    executionAuthority: z.enum(LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES),
    body: RecordBodyV2,
  })
  .strict();

export type FinanceThesisRecordBody = z.infer<typeof RecordBodyV3>;

const StoredRecordV3 = z
  .object({
    schemaVersion: z.literal(FINANCE_THESIS_RECORD_SCHEMA),
    recordKey: Text,
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: Iso,
    executionAuthority: z.enum(LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES),
    body: RecordBodyV3,
  })
  .strict();
export type FinanceThesisRecord =
  | (z.infer<typeof StoredRecordV1> & { ref: string })
  | (z.infer<typeof StoredRecordV2> & { ref: string })
  | (z.infer<typeof StoredRecordV3> & { ref: string });

/**
 * The ledger file is generation-suffixed (`thesis-ledger_1.sqlite`). `finance-state-dir.ts`
 * owns that name so the writers and the agent-side readers cannot disagree about it.
 */
const databasePath = financeThesisLedgerPath;

const THESIS_LEDGER_MIGRATION_LEDGER = "finance_thesis_migrations";
const THESIS_LEDGER_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "append-only thesis ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_thesis_records (
        kind TEXT NOT NULL, record_key TEXT NOT NULL, sequence INTEGER NOT NULL,
        ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
        PRIMARY KEY(kind,record_key), UNIQUE(sequence)
      );
      CREATE TRIGGER IF NOT EXISTS finance_thesis_no_update BEFORE UPDATE ON finance_thesis_records BEGIN SELECT RAISE(ABORT,'thesis records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS finance_thesis_no_delete BEFORE DELETE ON finance_thesis_records BEGIN SELECT RAISE(ABORT,'thesis records are append-only'); END;
    `,
  },
];

type ThesisDatabase = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

/**
 * Read every record and re-verify the chain. A row whose stored `ref` no longer matches its
 * body, or whose sequence or back-link is off, is a hard error rather than a silent skip.
 */
function readStoredRecords(db: ThesisDatabase): FinanceThesisRecord[] {
  const rows = db.prepare("SELECT ref, body FROM finance_thesis_records ORDER BY sequence").all();
  let previousRef: string | null = null;
  return rows.map((row, index) => {
    if (typeof row.body !== "string" || typeof row.ref !== "string") {
      throw new Error("invalid thesis record");
    }
    const raw: unknown = JSON.parse(row.body);
    if (caseflowFingerprint(raw) !== row.ref) {
      throw new Error("thesis record integrity mismatch");
    }
    const legacyRecord = StoredRecordV1.safeParse(raw);
    const versionTwoRecord = legacyRecord.success ? undefined : StoredRecordV2.safeParse(raw);
    const record = legacyRecord.success
      ? legacyRecord.data
      : versionTwoRecord?.success
        ? versionTwoRecord.data
        : StoredRecordV3.parse(raw);
    if (record.sequence !== index + 1 || record.previousRef !== previousRef) {
      throw new Error("thesis record chain mismatch");
    }
    previousRef = row.ref;
    return { ...record, ref: row.ref };
  });
}

function normalizeStoredEvidence(
  item: FinanceThesisEvidenceInput | FinanceThesisEvidence,
): FinanceThesisEvidence {
  const { id, source, reference, summary } = item;
  const relation = item.relation ?? "unknown";
  const evidenceAsOf = "evidenceAsOf" in item ? item.evidenceAsOf : undefined;
  return {
    id,
    source,
    reference,
    ...(summary === undefined ? {} : { summary }),
    relation,
    ...(evidenceAsOf === undefined ? {} : { evidenceAsOf }),
  };
}

function projectLegacyBody(
  body: FinanceThesisRecordBody,
): z.infer<typeof RecordBodyV2> | undefined {
  const legacyEvidence = (items: readonly FinanceThesisEvidence[]) => {
    if (items.some((item) => item.relation !== "unknown" || item.evidenceAsOf !== undefined)) {
      return undefined;
    }
    return items.map(({ id, source, reference, summary }) => ({
      id,
      source,
      reference,
      ...(summary === undefined ? {} : { summary }),
    }));
  };

  if (body.kind === "opened") {
    if (
      body.claimEpistemicClass !== "unclassified" ||
      body.claimBasis !== null ||
      body.expectationGap !== undefined
    ) {
      return undefined;
    }
    const evidence = legacyEvidence(body.evidence);
    if (!evidence) {
      return undefined;
    }
    return {
      kind: body.kind,
      thesisId: body.thesisId,
      instrument: body.instrument,
      claim: body.claim,
      ...(body.rationale === undefined ? {} : { rationale: body.rationale }),
      evidence,
      invalidationConditions: body.invalidationConditions,
      observedAt: body.observedAt,
    };
  }

  const evidence = body.evidence === undefined ? undefined : legacyEvidence(body.evidence);
  if (body.evidence !== undefined && !evidence) {
    return undefined;
  }
  return body.kind === "transition"
    ? {
        kind: body.kind,
        thesisId: body.thesisId,
        to: body.to,
        reason: body.reason,
        ...(evidence === undefined ? {} : { evidence }),
        observedAt: body.observedAt,
      }
    : evidence === undefined
      ? undefined
      : {
          kind: body.kind,
          thesisId: body.thesisId,
          evidence,
          observedAt: body.observedAt,
        };
}

export type FinanceThesisTransition = Readonly<{
  to: FinanceThesisTransitionState;
  reason: string;
  evidence: readonly FinanceThesisEvidence[];
  observedAt: string;
  recordedAt: string;
}>;

export type FinanceThesis = Readonly<{
  thesisId: string;
  instrument: string;
  claim: string;
  claimEpistemicClass: FinanceThesisClaimEpistemicClass;
  claimBasis: string | null;
  applicability?: FinanceThesisApplicability;
  expectationGap?: FinanceExpectationGap;
  rationale: string | null;
  /** Derived by replay, never stored. */
  state: FinanceThesisState;
  openedAt: string;
  invalidationConditions: readonly string[];
  evidence: readonly FinanceThesisEvidence[];
  transitions: readonly FinanceThesisTransition[];
  /** `null` while the thesis is still `active`. */
  closedAt: string | null;
}>;

export type FinanceThesisLedger = Readonly<{
  theses: readonly FinanceThesis[];
  recordCount: number;
  openedRecordCount: number;
  transitionRecordCount: number;
  evidenceAppendRecordCount: number;
  headRef: string | null;
}>;

/**
 * Project the recorded events into the current state of each thesis.
 *
 * Opening produces `active`; evidence appends preserve it; a terminal transition closes it.
 * Because nothing is stored but the events, an `asOf` view is a filtered history — there is no
 * historical state column to disagree with it.
 */
export function projectFinanceTheses(
  records: readonly FinanceThesisRecord[],
): readonly FinanceThesis[] {
  const drafts = new Map<
    string,
    {
      instrument: string;
      claim: string;
      claimEpistemicClass: FinanceThesisClaimEpistemicClass;
      claimBasis: string | null;
      applicability?: FinanceThesisApplicability;
      expectationGap?: FinanceExpectationGap;
      rationale: string | null;
      openedAt: string;
      invalidationConditions: readonly string[];
      evidence: FinanceThesisEvidence[];
      transitions: FinanceThesisTransition[];
      closedAt: string | null;
    }
  >();

  for (const record of records) {
    const body = record.body;
    const existing = drafts.get(body.thesisId);
    if (body.kind === "opened") {
      if (existing) {
        throw new Error(`thesis ${body.thesisId} is already open`);
      }
      drafts.set(body.thesisId, {
        instrument: body.instrument,
        claim: body.claim,
        claimEpistemicClass:
          "claimEpistemicClass" in body ? body.claimEpistemicClass : "unclassified",
        claimBasis: "claimBasis" in body ? body.claimBasis : null,
        ...("applicability" in body && body.applicability
          ? { applicability: body.applicability }
          : {}),
        ...("expectationGap" in body && body.expectationGap
          ? { expectationGap: body.expectationGap }
          : {}),
        rationale: body.rationale ?? null,
        openedAt: body.observedAt,
        invalidationConditions: body.invalidationConditions,
        evidence: body.evidence.map(normalizeStoredEvidence),
        transitions: [],
        closedAt: null,
      });
      continue;
    }
    if (!existing) {
      throw new Error(`thesis ${body.thesisId} has no opening record`);
    }
    if (existing.closedAt !== null) {
      throw new Error(
        `thesis ${body.thesisId} was already closed at ${existing.closedAt}; a closed thesis is history`,
      );
    }
    if (body.kind === "evidence_appended") {
      const existingEvidenceIds = new Set(existing.evidence.map((item) => item.id));
      if (body.evidence.some((item) => existingEvidenceIds.has(item.id))) {
        throw new Error(`thesis ${body.thesisId} contains duplicate evidence ids`);
      }
      existing.evidence.push(...body.evidence.map(normalizeStoredEvidence));
      continue;
    }
    existing.transitions.push({
      to: body.to,
      reason: body.reason,
      evidence: (body.evidence ?? []).map(normalizeStoredEvidence),
      observedAt: body.observedAt,
      recordedAt: record.recordedAt,
    });
    existing.closedAt = body.observedAt;
  }

  return [...drafts.entries()].map(([thesisId, draft]) =>
    Object.freeze({
      thesisId,
      instrument: draft.instrument,
      claim: draft.claim,
      claimEpistemicClass: draft.claimEpistemicClass,
      claimBasis: draft.claimBasis,
      ...(draft.applicability ? { applicability: draft.applicability } : {}),
      ...(draft.expectationGap ? { expectationGap: draft.expectationGap } : {}),
      rationale: draft.rationale,
      state: draft.transitions.at(-1)?.to ?? "active",
      openedAt: draft.openedAt,
      invalidationConditions: draft.invalidationConditions,
      evidence: draft.evidence,
      transitions: Object.freeze([...draft.transitions]),
      closedAt: draft.closedAt,
    }),
  );
}

function openDatabase(directory: string): ThesisDatabase {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath(directory));
  chmodSync(databasePath(directory), 0o600);
  // auto_vacuum must be set before the first journal_mode=WAL write: switching to WAL
  // initialises the database file and silently freezes auto_vacuum afterwards.
  db.exec(
    `PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
  );
  applySqliteMigrations({
    db,
    ledgerTable: THESIS_LEDGER_MIGRATION_LEDGER,
    migrations: THESIS_LEDGER_MIGRATIONS,
  });
  return db;
}

export type FinanceThesisAppend = Readonly<{
  record: FinanceThesisRecord;
  /** `false` when the identical record was already present: append-only, and idempotent. */
  appended: boolean;
  recordCount: number;
  headRef: string | null;
}>;

async function appendRecord(
  directory: string,
  body: FinanceThesisRecordBody,
  recordKey: string,
): Promise<FinanceThesisAppend> {
  const observed = Date.parse(body.observedAt);
  if (!Number.isFinite(observed)) {
    throw new Error("thesis record requires an ISO observation timestamp");
  }
  if (observed > Date.now()) {
    // A thesis dated in the future is not an observation, and admitting one would let a
    // belief about tomorrow be read as one held today.
    throw new Error("thesis record observation cannot be dated in the future");
  }
  const db = openDatabase(directory);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const records = readStoredRecords(db);
      const existing = records.find(
        (item) => item.body.kind === body.kind && item.recordKey === recordKey,
      );
      if (existing) {
        const legacyBody = projectLegacyBody(body);
        if (
          caseflowFingerprint(existing.body) !== caseflowFingerprint(body) &&
          (!legacyBody || caseflowFingerprint(existing.body) !== caseflowFingerprint(legacyBody))
        ) {
          throw new Error(
            `thesis record ${recordKey} already recorded with different content; ` +
              "the ledger is append-only and has no correction path",
          );
        }
        db.exec("COMMIT");
        return Object.freeze({
          record: existing,
          appended: false,
          recordCount: records.length,
          headRef: records.at(-1)?.ref ?? null,
        });
      }

      // Reject against the recorded events, not against a stored state column: the state to
      // transition *from* is whatever replaying the stream says, so there is nothing for a
      // stored column to disagree with.
      if (body.kind === "transition" || body.kind === "evidence_appended") {
        const opened = records.find(
          (item) => item.body.kind === "opened" && item.body.thesisId === body.thesisId,
        );
        if (!opened) {
          throw new Error(`thesis ${body.thesisId} has no opening record`);
        }
        const closed = records.some(
          (item) => item.body.kind === "transition" && item.body.thesisId === body.thesisId,
        );
        if (closed) {
          throw new Error(`thesis ${body.thesisId} is already closed; a closed thesis is history`);
        }
        if (body.kind === "evidence_appended") {
          const priorEvidenceIds = new Set(
            records.flatMap(({ body: prior }) => {
              if (
                prior.thesisId !== body.thesisId ||
                (prior.kind !== "opened" && prior.kind !== "evidence_appended")
              ) {
                return [];
              }
              return prior.evidence.map((entry) => entry.id);
            }),
          );
          if (body.evidence.some((item) => priorEvidenceIds.has(item.id))) {
            throw new Error(`thesis ${body.thesisId} already contains an evidence id`);
          }
        }
      } else if (records.some((item) => item.body.thesisId === body.thesisId)) {
        throw new Error(`thesis ${body.thesisId} is already open`);
      }

      const record = StoredRecordV3.parse({
        schemaVersion: FINANCE_THESIS_RECORD_SCHEMA,
        recordKey,
        sequence: records.length + 1,
        previousRef: records.at(-1)?.ref ?? null,
        recordedAt: new Date().toISOString(),
        executionAuthority: "none",
        body,
      });
      const ref = caseflowFingerprint(record);
      db.prepare(
        "INSERT INTO finance_thesis_records(kind,record_key,sequence,ref,body) VALUES (?,?,?,?,?)",
      ).run(body.kind, recordKey, record.sequence, ref, JSON.stringify(record));
      db.exec("COMMIT");
      return Object.freeze({
        record: { ...record, ref },
        appended: true,
        recordCount: records.length + 1,
        headRef: ref,
      });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Record that a thesis was opened. Idempotent by `(kind, thesisId)`. */
export async function openFinanceThesis(
  directory: string,
  input: unknown,
): Promise<FinanceThesisAppend> {
  const data = FinanceThesisOpenInput.parse(input);
  if (
    data.applicability &&
    Date.parse(data.applicability.validUntil) <= Date.parse(data.observedAt)
  ) {
    throw new Error("thesis applicability must expire after its observation");
  }
  const claimEpistemicClass = data.claimEpistemicClass ?? "unclassified";
  if (financeResearchClaimRequiresBasis(claimEpistemicClass) && !data.claimBasis?.trim()) {
    throw new Error("derived, estimated, inferred, or hypothesized thesis claims require a basis");
  }
  const evidenceIds = new Set(data.evidence.map((item) => item.id));
  if (evidenceIds.size !== data.evidence.length) {
    throw new Error("duplicate thesis evidence id");
  }
  return appendRecord(
    directory,
    {
      kind: "opened",
      ...data,
      claimEpistemicClass,
      claimBasis: data.claimBasis ?? null,
      evidence: data.evidence.map(normalizeStoredEvidence),
    },
    `opened:${data.thesisId}`,
  );
}

/**
 * Record that a thesis left `active`. Idempotent by `(thesisId, observedAt)` — one transition
 * per thesis per observation time — and refused once the thesis is closed.
 */
export async function transitionFinanceThesis(
  directory: string,
  input: unknown,
): Promise<FinanceThesisAppend> {
  const data = FinanceThesisTransitionInput.parse(input);
  const evidence = data.evidence ?? [];
  const evidenceIds = new Set(evidence.map((item) => item.id));
  if (evidenceIds.size !== evidence.length) {
    throw new Error("duplicate thesis evidence id");
  }
  return appendRecord(
    directory,
    {
      kind: "transition",
      thesisId: data.thesisId,
      to: data.to,
      reason: data.reason,
      ...(data.evidence === undefined
        ? {}
        : { evidence: data.evidence.map(normalizeStoredEvidence) }),
      observedAt: data.observedAt,
    },
    `transition:${data.thesisId}@${data.observedAt}`,
  );
}

/** Add new evidence to an active thesis without changing its claim or invalidation conditions. */
export async function appendFinanceThesisEvidence(
  directory: string,
  input: unknown,
): Promise<FinanceThesisAppend> {
  const data = FinanceThesisEvidenceAppendInput.parse(input);
  const evidenceIds = new Set(data.evidence.map((item) => item.id));
  if (evidenceIds.size !== data.evidence.length) {
    throw new Error("duplicate thesis evidence id");
  }
  return appendRecord(
    directory,
    { kind: "evidence_appended", ...data, evidence: data.evidence.map(normalizeStoredEvidence) },
    `evidence:${data.thesisId}@${data.observedAt}`,
  );
}

function tableExists(db: ThesisDatabase, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return row !== undefined;
}

/**
 * Read the book, projecting the recorded events into each thesis's current state.
 *
 * An absent database is an empty book, not an error. A database that exists but has no table
 * (a run that died before its first migration) is also an empty book — checked explicitly
 * against `sqlite_master` rather than by matching a driver error string.
 */
export async function readFinanceThesisLedger(
  directory: string,
  options: { asOf?: string } = {},
): Promise<FinanceThesisLedger> {
  try {
    await fs.access(databasePath(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({
        theses: Object.freeze([]),
        recordCount: 0,
        openedRecordCount: 0,
        transitionRecordCount: 0,
        evidenceAppendRecordCount: 0,
        headRef: null,
      });
    }
    throw error;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath(directory), { readOnly: true });
  try {
    if (!tableExists(db, "finance_thesis_records")) {
      return Object.freeze({
        theses: Object.freeze([]),
        recordCount: 0,
        openedRecordCount: 0,
        transitionRecordCount: 0,
        evidenceAppendRecordCount: 0,
        headRef: null,
      });
    }
    const stored = readStoredRecords(db);
    const asOf = options.asOf?.trim() ?? "";
    const records =
      asOf.length === 0
        ? stored
        : stored.filter((record) => record.body.observedAt.localeCompare(asOf) <= 0);
    return Object.freeze({
      theses: Object.freeze(projectFinanceTheses(records)),
      recordCount: records.length,
      openedRecordCount: records.filter((record) => record.body.kind === "opened").length,
      transitionRecordCount: records.filter((record) => record.body.kind === "transition").length,
      evidenceAppendRecordCount: records.filter(
        (record) => record.body.kind === "evidence_appended",
      ).length,
      headRef: records.at(-1)?.ref ?? null,
    });
  } finally {
    db.close();
  }
}
