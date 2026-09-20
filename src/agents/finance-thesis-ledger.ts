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
 * - The two record kinds are `opened` and `transition`. There is no `state` column and no
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
import { financeThesisLedgerPath } from "./finance-state-dir.js";

const Text = z.string().trim().min(1);
const Iso = z.string().datetime();
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const ThesisId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/u);

export const FINANCE_THESIS_RECORD_SCHEMA = "lcx_finance_thesis_record_v1" as const;

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
export type FinanceThesisEvidence = z.infer<typeof EvidenceLink>;

export const FinanceThesisOpenInput = z
  .object({
    thesisId: ThesisId,
    instrument: Text,
    claim: Text,
    rationale: Text.optional(),
    evidence: z.array(EvidenceLink).min(1),
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
    evidence: z.array(EvidenceLink).optional(),
    observedAt: Iso,
  })
  .strict();
export type FinanceThesisTransitionInput = z.infer<typeof FinanceThesisTransitionInput>;

const OpenedBody = z
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

const TransitionBody = z
  .object({
    kind: z.literal("transition"),
    thesisId: ThesisId,
    to: z.enum(FINANCE_THESIS_TRANSITIONS),
    reason: Text,
    evidence: z.array(EvidenceLink).optional(),
    observedAt: Iso,
  })
  .strict();

const RecordBody = z.discriminatedUnion("kind", [OpenedBody, TransitionBody]);
export type FinanceThesisRecordBody = z.infer<typeof RecordBody>;

const StoredRecordSchema = z
  .object({
    schemaVersion: z.literal(FINANCE_THESIS_RECORD_SCHEMA),
    recordKey: Text,
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: Iso,
    executionAuthority: z.enum(LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES),
    body: RecordBody,
  })
  .strict();
export type FinanceThesisRecord = z.infer<typeof StoredRecordSchema> & { ref: string };

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
    const record = StoredRecordSchema.parse(raw);
    if (record.sequence !== index + 1 || record.previousRef !== previousRef) {
      throw new Error("thesis record chain mismatch");
    }
    previousRef = row.ref;
    return { ...record, ref: row.ref };
  });
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
  headRef: string | null;
}>;

/**
 * Project the recorded events into the current state of each thesis.
 *
 * Opening produces `active`; each later transition replaces it. Because nothing is stored but
 * the events, an `asOf` view is just a shorter prefix of the same stream — there is no
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
      rationale: string | null;
      openedAt: string;
      invalidationConditions: readonly string[];
      evidence: readonly FinanceThesisEvidence[];
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
        rationale: body.rationale ?? null,
        openedAt: body.observedAt,
        invalidationConditions: body.invalidationConditions,
        evidence: body.evidence,
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
    existing.transitions.push({
      to: body.to,
      reason: body.reason,
      evidence: body.evidence ?? [],
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
        if (caseflowFingerprint(existing.body) !== caseflowFingerprint(body)) {
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
      if (body.kind === "transition") {
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
      } else if (records.some((item) => item.body.thesisId === body.thesisId)) {
        throw new Error(`thesis ${body.thesisId} is already open`);
      }

      const record = StoredRecordSchema.parse({
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
  const evidenceIds = new Set(data.evidence.map((item) => item.id));
  if (evidenceIds.size !== data.evidence.length) {
    throw new Error("duplicate thesis evidence id");
  }
  return appendRecord(directory, { kind: "opened", ...data }, `opened:${data.thesisId}`);
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
    { kind: "transition", ...data },
    `transition:${data.thesisId}@${data.observedAt}`,
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
      headRef: records.at(-1)?.ref ?? null,
    });
  } finally {
    db.close();
  }
}
