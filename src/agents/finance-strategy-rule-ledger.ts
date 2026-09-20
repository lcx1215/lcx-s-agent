/**
 * The durable strategy-rule ledger.
 *
 * A strategy rule is a *declaration* of how the owner intends to trade: its form, what it reads,
 * what it emits, when it runs, and where it came from. Before this ledger existed there was no
 * place to put one — `finance-strategy-method-catalog.ts` is a frozen catalogue of *method kinds*
 * and `selectFinanceStrategyMethodIds(ask)` is stateless keyword matching over a question string.
 * Neither stores a rule, so nothing survived the run that produced it. This stores it.
 *
 * ### The compatibility constraint this module exists to satisfy
 *
 * Quant strategies come in unbounded shapes — Pine scripts, Python callables, expression DSLs,
 * external signal webhooks, portfolio optimisers, hand-written checklists. Any ledger that
 * enumerates those shapes becomes the thing every new shape has to be fitted into, and the
 * owner's ability to absorb an outside idea is then gated on a schema change here.
 *
 * So this ledger validates **only the envelope**. Specifically:
 *
 * - `form` is an **open string**, not an enum. `"pine"`, `"python"`, `"expression"`,
 *   `"webhook_signal"` or anything else are equally admissible, and a form nobody has heard of
 *   yet is fine — it is a name, not a capability claim.
 * - `body` is an **opaque payload**. The ledger requires it to be a non-empty plain object and
 *   otherwise does not look inside. Each form owns its own body shape and its own validation,
 *   wherever that form is implemented.
 *
 * A new quant shape is therefore a new `form` value plus its own body contract, with **no change
 * to this ledger and no migration**. That is the whole point.
 *
 * ### Following the repository rule: events are stored, derived state is not
 *
 * - The record kinds are `declared`, `activated` and `retired`. There is no `state` column: the
 *   current state is whatever replaying the stream produces.
 * - `retired` is terminal. There is no un-retire: a retired rule is history, and bringing a rule
 *   back is a new declaration under a new id, so the record of *why* it was retired is not
 *   silently overwritten.
 *
 * ### Declaration is not authorization, and neither is execution
 *
 * This is the property that matters most for automated trading, so it is stated here rather than
 * left to whoever reads the record:
 *
 * - **Declaring** a rule records intent. It confers nothing.
 * - **Activating** a rule is the owner's explicit act of authorising it to run. It is a separate
 *   event so that "someone wrote a rule down" can never be mistaken for "someone armed it".
 * - **Executing** a rule is not this ledger's business at all. Every record carries
 *   `executionAuthority: "none"`. Execution still requires a declared execution adapter, and the
 *   only shipped adapter is `paper`.
 *
 * The ledger is deliberately **not** an evaluation surface. It has no score, no ranking and no
 * promotion mechanics. Scoring candidate rules against each other is the factor/alpha evolution
 * loop, which is a separate piece of work with its own acceptance gates; giving this ledger
 * scoring fields would quietly pre-empt a decision that has not been made.
 */

import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES } from "../shared/lcx-ontology.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeStrategyRuleLedgerPath } from "./finance-state-dir.js";

const Text = z.string().trim().min(1);
const Iso = z.string().datetime();
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const RuleId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/u);

export const FINANCE_STRATEGY_RULE_RECORD_SCHEMA = "lcx_finance_strategy_rule_record_v1" as const;

/** A declared rule is not yet authorised; `active` is entered only by an explicit activation. */
export const FINANCE_STRATEGY_RULE_STATES = ["draft", "active", "retired"] as const;
export type FinanceStrategyRuleState = (typeof FINANCE_STRATEGY_RULE_STATES)[number];

/**
 * Opaque by design. The ledger insists only that it is a non-empty plain object, because an empty
 * payload is not a rule — it is a name. What is inside belongs to whichever `form` is declared.
 */
const RuleBody = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0,
  { message: "rule body must be a non-empty plain object; its shape belongs to the declared form" },
);

/** Open objects: unknown keys are carried through rather than stripped. */
const Schedule = z
  .object({
    kind: Text,
    at: Text.optional(),
    cron: Text.optional(),
    timezone: Text.optional(),
  })
  .passthrough();

const Provenance = z
  .object({
    origin: Text.optional(),
    revision: Text.optional(),
    license: Text.optional(),
    readScope: Text.optional(),
    notes: Text.optional(),
  })
  .passthrough()
  .optional();

export type FinanceStrategyRuleSchedule = z.infer<typeof Schedule>;
export type FinanceStrategyRuleProvenance = z.infer<typeof Provenance>;

const DeclaredBody = z
  .object({
    kind: z.literal("declared"),
    ruleId: RuleId,
    /**
     * The strategy's shape, as an open string. Anything is admissible; the ledger does not
     * interpret it and does not need to. Pair with `formVersion` when a form itself evolves.
     */
    form: Text,
    formVersion: Text.optional(),
    displayName: Text.optional(),
    /**
     * Instruments the rule may trade. Following the risk-budget idiom, an empty list admits
     * nothing rather than everything — a rule scoped to no instrument cannot run.
     */
    instruments: z.array(Text),
    /** What the rule produces, as an open string: `target_weights`, `orders`, `signal`, ... */
    emits: Text,
    schedule: Schedule,
    body: RuleBody,
    provenance: Provenance,
    observedAt: Iso,
  })
  .strict();

const ActivatedBody = z
  .object({
    kind: z.literal("activated"),
    ruleId: RuleId,
    reason: Text.optional(),
    observedAt: Iso,
  })
  .strict();

const RetiredBody = z
  .object({
    kind: z.literal("retired"),
    ruleId: RuleId,
    reason: Text.optional(),
    observedAt: Iso,
  })
  .strict();

export const FinanceStrategyRuleBodySchema = z.discriminatedUnion("kind", [
  DeclaredBody,
  ActivatedBody,
  RetiredBody,
]);
export type FinanceStrategyRuleBody = z.infer<typeof FinanceStrategyRuleBodySchema>;

export type FinanceStrategyRuleDeclaredBody = z.infer<typeof DeclaredBody>;

export type FinanceStrategyRuleRecord = Readonly<{
  schemaVersion: typeof FINANCE_STRATEGY_RULE_RECORD_SCHEMA;
  recordKey: string;
  sequence: number;
  previousRef: string | null;
  ref: string;
  recordedAt: string;
  executionAuthority: (typeof LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES)[number];
  body: FinanceStrategyRuleBody;
}>;

function databasePath(directory: string): string {
  return financeStrategyRuleLedgerPath(directory);
}

const STRATEGY_RULE_MIGRATION_LEDGER = "finance_strategy_rule_migrations";
const STRATEGY_RULE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "append-only strategy rule ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_strategy_rule_records (
        kind TEXT NOT NULL, record_key TEXT NOT NULL, sequence INTEGER NOT NULL,
        ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
        PRIMARY KEY(kind,record_key), UNIQUE(sequence)
      );
      CREATE TRIGGER IF NOT EXISTS finance_strategy_rule_no_update BEFORE UPDATE ON finance_strategy_rule_records BEGIN SELECT RAISE(ABORT,'strategy rule records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS finance_strategy_rule_no_delete BEFORE DELETE ON finance_strategy_rule_records BEGIN SELECT RAISE(ABORT,'strategy rule records are append-only'); END;
    `,
  },
];

type RuleDatabase = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

/**
 * Read every record and re-verify the chain. A row whose stored `ref` no longer matches its body,
 * or whose sequence or back-link is off, is a hard error rather than a silent skip.
 */
function readStoredRecords(db: RuleDatabase): FinanceStrategyRuleRecord[] {
  const rows = db
    .prepare("SELECT ref, body FROM finance_strategy_rule_records ORDER BY sequence")
    .all() as unknown as ReadonlyArray<{ ref: string; body: string }>;
  let previousRef: string | null = null;
  return rows.map((row, index) => {
    const parsed = FinanceStrategyRuleRecordSchema.parse(JSON.parse(row.body));
    if (parsed.sequence !== index + 1) {
      throw new Error(
        `strategy rule ledger sequence mismatch at ${index + 1}: stored ${parsed.sequence}`,
      );
    }
    if (parsed.previousRef !== previousRef) {
      throw new Error(`strategy rule ledger chain broken at ${index + 1}`);
    }
    if (caseflowFingerprint(parsed.body) !== row.ref) {
      throw new Error(`strategy rule record ${parsed.recordKey} does not match its stored ref`);
    }
    previousRef = row.ref;
    return parsed;
  });
}

const FinanceStrategyRuleRecordSchema = z.object({
  schemaVersion: z.literal(FINANCE_STRATEGY_RULE_RECORD_SCHEMA),
  recordKey: z.string(),
  sequence: z.number().int().positive(),
  previousRef: z.string().nullable(),
  ref: Hash,
  recordedAt: Iso,
  executionAuthority: z.enum(LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES),
  body: FinanceStrategyRuleBodySchema,
});

export type FinanceStrategyRule = Readonly<{
  ruleId: string;
  state: FinanceStrategyRuleState;
  form: string;
  formVersion: string | null;
  displayName: string | null;
  instruments: readonly string[];
  emits: string;
  schedule: FinanceStrategyRuleSchedule;
  body: Record<string, unknown>;
  provenance: FinanceStrategyRuleProvenance | null;
  /** Wall-clock instant the `declared` record was written. */
  declaredAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  /**
   * The instant the rule's paper period began **as the owner declared it** (`observedAt`), not
   * as the writer happened to record it.
   *
   * These are the only clocks a replay may use. `declaredAt` / `activatedAt` are wall-clock
   * write times, so any projection that windows history from them is not replayable: at an
   * `asOf` in the past the window start lands after the window end and every observation
   * silently drops out, which reads as "nothing adverse happened" rather than "unjudgeable".
   */
  startObservedAt: string;
  activeObservedAt: string | null;
  /** Every lifecycle event, oldest first, so a reader never has to guess at the ordering. */
  transitions: readonly FinanceStrategyRuleRecord[];
}>;

export type FinanceStrategyRuleLedger = Readonly<{
  rules: readonly FinanceStrategyRule[];
  recordCount: number;
  declaredRecordCount: number;
  activatedRecordCount: number;
  retiredRecordCount: number;
  headRef: string | null;
}>;

function emptyLedger(): FinanceStrategyRuleLedger {
  return Object.freeze({
    rules: Object.freeze([]) as readonly FinanceStrategyRule[],
    recordCount: 0,
    declaredRecordCount: 0,
    activatedRecordCount: 0,
    retiredRecordCount: 0,
    headRef: null,
  });
}

export function projectFinanceStrategyRules(
  records: readonly FinanceStrategyRuleRecord[],
): FinanceStrategyRuleLedger {
  if (records.length === 0) {
    return emptyLedger();
  }
  const drafts = new Map<string, ReturnType<typeof newDraft>>();
  const order: string[] = [];
  const events = new Map<string, FinanceStrategyRuleRecord[]>();

  const ensure = (ruleId: string) => {
    let draft = drafts.get(ruleId);
    if (draft === undefined) {
      draft = newDraft(ruleId);
      drafts.set(ruleId, draft);
      order.push(ruleId);
      events.set(ruleId, []);
    }
    return draft;
  };

  for (const record of records) {
    const body = record.body;
    const ruleId = body.ruleId;
    const draft = ensure(ruleId);
    events.get(ruleId)?.push(record);
    if (body.kind === "declared") {
      draft.form = body.form;
      draft.formVersion = body.formVersion ?? null;
      draft.displayName = body.displayName ?? null;
      draft.instruments = Object.freeze([...body.instruments]);
      draft.emits = body.emits;
      draft.schedule = Object.freeze({ ...body.schedule });
      draft.body = Object.freeze({ ...body.body });
      draft.provenance =
        body.provenance === undefined ? null : Object.freeze({ ...body.provenance });
      draft.declaredAt = record.recordedAt;
      draft.startObservedAt = body.observedAt;
    } else if (body.kind === "activated") {
      draft.activatedAt = record.recordedAt;
      draft.activeObservedAt = body.observedAt;
    } else {
      draft.retiredAt = record.recordedAt;
    }
  }

  const rules = order.map((ruleId) => {
    const draft = drafts.get(ruleId)!;
    const activatedAt = draft.activatedAt;
    const retiredAt = draft.retiredAt;
    const state: FinanceStrategyRuleState =
      retiredAt !== null ? "retired" : activatedAt !== null ? "active" : "draft";
    return Object.freeze({
      ruleId,
      state,
      form: draft.form,
      formVersion: draft.formVersion,
      displayName: draft.displayName,
      instruments: draft.instruments,
      emits: draft.emits,
      schedule: draft.schedule,
      body: draft.body,
      provenance: draft.provenance,
      declaredAt: draft.declaredAt,
      activatedAt,
      retiredAt,
      startObservedAt: draft.startObservedAt,
      activeObservedAt: draft.activeObservedAt,
      transitions: Object.freeze([...(events.get(ruleId) ?? [])]),
    });
  });

  let declaredRecordCount = 0;
  let activatedRecordCount = 0;
  let retiredRecordCount = 0;
  for (const record of records) {
    if (record.body.kind === "declared") {
      declaredRecordCount += 1;
    } else if (record.body.kind === "activated") {
      activatedRecordCount += 1;
    } else {
      retiredRecordCount += 1;
    }
  }

  return Object.freeze({
    rules: Object.freeze(rules),
    recordCount: records.length,
    declaredRecordCount,
    activatedRecordCount,
    retiredRecordCount,
    headRef: records.at(-1)?.ref ?? null,
  });
}

function newDraft(ruleId: string) {
  return {
    ruleId,
    form: "",
    formVersion: null as string | null,
    displayName: null as string | null,
    instruments: Object.freeze([]) as readonly string[],
    emits: "",
    schedule: Object.freeze({ kind: "manual" }) as FinanceStrategyRuleSchedule,
    body: Object.freeze({}) as Record<string, unknown>,
    provenance: null as FinanceStrategyRuleProvenance | null,
    declaredAt: "",
    activatedAt: null as string | null,
    retiredAt: null as string | null,
    startObservedAt: "",
    activeObservedAt: null as string | null,
  };
}

function openDatabase(directory: string): RuleDatabase {
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
    ledgerTable: STRATEGY_RULE_MIGRATION_LEDGER,
    migrations: STRATEGY_RULE_MIGRATIONS,
  });
  return db;
}

export type FinanceStrategyRuleAppend = Readonly<{
  record: FinanceStrategyRuleRecord;
  /** `false` when the identical record was already present: append-only, and idempotent. */
  appended: boolean;
  recordCount: number;
  headRef: string | null;
}>;

async function appendRecord(
  directory: string,
  body: FinanceStrategyRuleBody,
  recordKey: string,
): Promise<FinanceStrategyRuleAppend> {
  const observed = Date.parse(body.observedAt);
  if (!Number.isFinite(observed)) {
    throw new Error("strategy rule record requires an ISO observation timestamp");
  }
  if (observed > Date.now()) {
    throw new Error("strategy rule record observation cannot be dated in the future");
  }
  const db = openDatabase(directory);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const records = readStoredRecords(db);
      const existing = records.find(
        (item) => item.body.kind === body.kind && item.recordKey === recordKey,
      );
      if (existing && caseflowFingerprint(existing.body) === caseflowFingerprint(body)) {
        // Exact replay of a record already in the book: append-only and idempotent, not an error.
        db.exec("COMMIT");
        return Object.freeze({
          record: existing,
          appended: false,
          recordCount: records.length,
          headRef: records.at(-1)?.ref ?? null,
        });
      }
      // Any other duplicate falls through to the lifecycle guards below, which name the
      // situation ("already active") instead of the generic "different content". The UNIQUE
      // constraint on (kind, record_key) remains a backstop, not the primary path.

      // Validated against the recorded events, never against a stored state column.
      const forRule = records.filter((item) => item.body.ruleId === body.ruleId);
      if (body.kind === "declared") {
        if (forRule.length > 0) {
          throw new Error(`strategy rule ${body.ruleId} is already declared`);
        }
      } else if (body.kind === "activated") {
        if (!forRule.some((item) => item.body.kind === "declared")) {
          throw new Error(`strategy rule ${body.ruleId} has no declaration record`);
        }
        if (forRule.some((item) => item.body.kind === "retired")) {
          throw new Error(`strategy rule ${body.ruleId} is retired; a retired rule is history`);
        }
        if (forRule.some((item) => item.body.kind === "activated")) {
          throw new Error(`strategy rule ${body.ruleId} is already active`);
        }
      } else {
        if (!forRule.some((item) => item.body.kind === "declared")) {
          throw new Error(`strategy rule ${body.ruleId} has no declaration record`);
        }
        if (forRule.some((item) => item.body.kind === "retired")) {
          throw new Error(`strategy rule ${body.ruleId} is already retired`);
        }
      }

      const sequence = records.length + 1;
      const previousRef = records.at(-1)?.ref ?? null;
      const stored = {
        schemaVersion: FINANCE_STRATEGY_RULE_RECORD_SCHEMA,
        recordKey,
        sequence,
        previousRef,
        ref: caseflowFingerprint(body),
        recordedAt: new Date().toISOString(),
        executionAuthority: "none" as const,
        body,
      };
      const parsed = FinanceStrategyRuleRecordSchema.parse(stored);
      db.prepare(
        "INSERT INTO finance_strategy_rule_records(kind,record_key,sequence,ref,body) VALUES(?,?,?,?,?)",
      ).run(parsed.body.kind, recordKey, sequence, parsed.ref, JSON.stringify(parsed));
      db.exec("COMMIT");
      return Object.freeze({
        record: parsed,
        appended: true,
        recordCount: sequence,
        headRef: parsed.ref,
      });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function declareFinanceStrategyRule(
  directory: string,
  input: unknown,
): Promise<FinanceStrategyRuleAppend> {
  const parsed = DeclaredBody.parse(input);
  return appendRecord(directory, parsed, `declared:${parsed.ruleId}`);
}

export async function activateFinanceStrategyRule(
  directory: string,
  input: unknown,
): Promise<FinanceStrategyRuleAppend> {
  const parsed = ActivatedBody.parse(input);
  return appendRecord(directory, parsed, `activated:${parsed.ruleId}`);
}

export async function retireFinanceStrategyRule(
  directory: string,
  input: unknown,
): Promise<FinanceStrategyRuleAppend> {
  const parsed = RetiredBody.parse(input);
  return appendRecord(directory, parsed, `retired:${parsed.ruleId}`);
}

export type FinanceStrategyRuleLedgerRead = Readonly<{
  ledger: FinanceStrategyRuleLedger;
  recordCount: number;
  headRef: string | null;
  databasePresent: boolean;
}>;

export async function readFinanceStrategyRuleLedger(
  directory: string,
  options: Readonly<{ asOf?: string }> = {},
): Promise<FinanceStrategyRuleLedgerRead> {
  const asOf = options.asOf;
  const databasePresent = await fs.stat(databasePath(directory)).then(
    () => true,
    () => false,
  );
  if (!databasePresent) {
    return Object.freeze({
      ledger: emptyLedger(),
      recordCount: 0,
      headRef: null,
      databasePresent: false,
    });
  }
  const db = openDatabase(directory);
  try {
    const stored = readStoredRecords(db);
    const records =
      asOf === undefined || asOf.length === 0
        ? stored
        : stored.filter((record) => record.body.observedAt.localeCompare(asOf) <= 0);
    const ledger = projectFinanceStrategyRules(records);
    return Object.freeze({
      ledger,
      recordCount: stored.length,
      headRef: stored.at(-1)?.ref ?? null,
      databasePresent: true,
    });
  } finally {
    db.close();
  }
}
