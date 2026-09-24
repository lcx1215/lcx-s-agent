import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeIntradayControlLedgerPath } from "./finance-state-dir.js";
import { FinanceThesisDecisionContextSchema } from "./finance-thesis-decision-context.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Text = z.string().trim().min(1);
const Iso = z.string().datetime();

export const FinanceIntradayDecisionInput = z
  .object({
    signalId: Text,
    instrument: Text,
    sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    action: z.enum(["buy", "sell"]),
    reason: z.enum(["opening_range_breakout", "opening_range_stop", "reward_target"]),
    referencePrice: z.number().finite().positive(),
    referencePriceAt: Iso,
    stopPrice: z.number().finite().positive().optional(),
    targetPrice: z.number().finite().positive().optional(),
    datasetHeadRef: Hash,
    strategyRule: z.literal("opening_range_breakout_long_next_bar_v1"),
  })
  .strict();
export type FinanceIntradayDecisionInput = z.infer<typeof FinanceIntradayDecisionInput>;

const RecordSchema = z
  .object({
    schemaVersion: z.literal("lcx_finance_intraday_decision_v1"),
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: Iso,
    input: FinanceIntradayDecisionInput,
  })
  .strict();
export type FinanceIntradayDecisionRecord = z.infer<typeof RecordSchema> & { ref: string };

const ReviewFailureCode = z.enum([
  "output_contract",
  "reviewer_unavailable",
  "output_invalid",
  "output_truncated",
  "provider_auth",
  "provider_rate_limit",
  "process_error",
  "output_limit",
  "runtime_timeout",
  "call_budget_exhausted",
]);

const IntradayReviewCandidateSchema = z
  .object({
    candidateId: Text,
    instrument: Text,
    side: z.enum(["buy", "sell"]),
    strategyRule: Text,
    signalReason: z.enum(["opening_range_breakout", "opening_range_stop", "reward_target"]),
    signalReferencePrice: z.number().finite().positive(),
    signalReferencePriceAt: Iso,
    stopPrice: z.number().finite().positive().optional(),
    targetPrice: z.number().finite().positive().optional(),
    datasetHeadRef: Hash,
    intradayOwnedQuantity: z.number().finite(),
    brokerPositionQuantity: z.number().finite(),
    executionQuote: z
      .object({
        referencePrice: z.number().finite().positive(),
        referencePriceAt: Iso,
        bidPrice: z.number().finite().positive().optional(),
        askPrice: z.number().finite().positive().optional(),
        feed: Text.optional(),
        priceBasis: z.enum(["bid", "ask", "reference"]).optional(),
        sourceUrlOrArtifact: Text,
        ageMs: z.number().finite().nonnegative(),
        maxAgeMs: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

const IntradayReviewRequestSchema = z
  .object({
    schemaVersion: z.literal("lcx_finance_intraday_trade_decision_review_v1"),
    venue: z.literal("alpaca:paper"),
    asOf: Iso,
    signalAnchor: Text,
    ruleIds: z.array(Text).min(1),
    equity: z.number().finite().positive(),
    caps: z
      .object({
        maxOrderNotional: z.number().finite().positive(),
        maxInstrumentNotional: z.number().finite().positive(),
        maxOrdersPerRun: z.number().int().positive(),
      })
      .strict(),
    positionBookObservedAt: Iso,
    reconciliation: z
      .object({
        status: Text,
        historyStatus: Text.optional(),
        uncertaintyReserve: z.number().finite().nonnegative().optional(),
        quarantinedInstruments: z.array(Text).optional(),
      })
      .strict(),
    positions: z.array(
      z
        .object({
          instrument: Text,
          quantity: z.number().finite(),
          marketValue: z.number().finite(),
        })
        .strict(),
    ),
    decisionContext: FinanceThesisDecisionContextSchema.optional(),
    candidates: z.array(IntradayReviewCandidateSchema).length(1),
  })
  .strict();

const IntradayReviewDecisionSchema = z
  .object({
    candidateId: Text,
    decision: z.enum(["approve", "veto"]),
    rationale: Text.max(800),
  })
  .strict();

export const FinanceIntradayDecisionReviewReceiptSchema = z
  .object({
    request: IntradayReviewRequestSchema,
    status: z.enum(["completed", "failed"]),
    attempted: z.boolean(),
    provider: Text,
    modelId: Text,
    latencyMs: z.number().finite().nonnegative(),
    providerCallObserved: z.boolean(),
    adapterAttested: z.boolean(),
    requestIdSha256: Hash.optional(),
    decision: IntradayReviewDecisionSchema.optional(),
    failureCode: ReviewFailureCode.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const candidateId = receipt.request.candidates[0]?.candidateId;
    if (receipt.status === "completed") {
      if (
        !receipt.attempted ||
        !receipt.decision ||
        receipt.decision.candidateId !== candidateId ||
        receipt.failureCode !== undefined
      ) {
        context.addIssue({ code: "custom", message: "completed review must bind one decision" });
      }
    } else if (receipt.decision !== undefined || receipt.failureCode === undefined) {
      context.addIssue({ code: "custom", message: "failed review requires a failure code only" });
    }
  });
export type FinanceIntradayDecisionReviewReceipt = z.infer<
  typeof FinanceIntradayDecisionReviewReceiptSchema
>;

const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "append-only durable intraday signal decisions",
    sql: `
      CREATE TABLE finance_intraday_decisions (
        ref TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL UNIQUE,
        body TEXT NOT NULL
      );
      CREATE TRIGGER finance_intraday_decisions_no_update BEFORE UPDATE ON finance_intraday_decisions BEGIN SELECT RAISE(ABORT,'intraday decisions are append-only'); END;
      CREATE TRIGGER finance_intraday_decisions_no_delete BEFORE DELETE ON finance_intraday_decisions BEGIN SELECT RAISE(ABORT,'intraday decisions are append-only'); END;
    `,
  },
  {
    version: 2,
    description: "one durable terminal execution outcome per intraday signal",
    sql: `
      CREATE TABLE finance_intraday_outcomes (
        signal_id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TRIGGER finance_intraday_outcomes_no_update BEFORE UPDATE ON finance_intraday_outcomes BEGIN SELECT RAISE(ABORT,'intraday outcomes are append-only'); END;
      CREATE TRIGGER finance_intraday_outcomes_no_delete BEFORE DELETE ON finance_intraday_outcomes BEGIN SELECT RAISE(ABORT,'intraday outcomes are append-only'); END;
    `,
  },
];

export const FinanceIntradayOutcomeInput = z
  .object({
    signalId: Text,
    status: z.enum(["placed", "refused", "uncertain"]),
    receiptId: Text.optional(),
    reasons: z.array(Text),
    tradeDecisionReview: FinanceIntradayDecisionReviewReceiptSchema.optional(),
  })
  .strict();
export type FinanceIntradayOutcomeInput = z.infer<typeof FinanceIntradayOutcomeInput>;

export async function appendFinanceIntradayOutcome(
  directory: string,
  rawInput: FinanceIntradayOutcomeInput,
): Promise<Readonly<{ input: FinanceIntradayOutcomeInput; appended: boolean }>> {
  const input = FinanceIntradayOutcomeInput.parse(rawInput);
  if ((input.status === "placed") !== Boolean(input.receiptId)) {
    throw new Error("placed intraday outcome requires one receiptId and non-placed forbids it");
  }
  const db = open(directory);
  try {
    const existing = db
      .prepare("SELECT body FROM finance_intraday_outcomes WHERE signal_id=?")
      .get(input.signalId) as { body?: unknown } | undefined;
    if (existing) {
      if (typeof existing.body !== "string") {
        throw new Error("invalid intraday outcome record");
      }
      const stored = FinanceIntradayOutcomeInput.parse(JSON.parse(existing.body));
      if (caseflowFingerprint(stored) !== caseflowFingerprint(input)) {
        throw new Error("intraday outcome conflict");
      }
      return Object.freeze({ input: stored, appended: false });
    }
    db.prepare(
      "INSERT INTO finance_intraday_outcomes(signal_id,recorded_at,body) VALUES (?,?,?)",
    ).run(input.signalId, new Date().toISOString(), JSON.stringify(input));
    return Object.freeze({ input, appended: true });
  } finally {
    db.close();
  }
}

export async function readFinanceIntradayOutcome(
  directory: string,
  signalId: string,
): Promise<FinanceIntradayOutcomeInput | null> {
  try {
    await fs.stat(financeIntradayControlLedgerPath(directory));
  } catch {
    return null;
  }
  const db = open(directory);
  try {
    const row = db
      .prepare("SELECT body FROM finance_intraday_outcomes WHERE signal_id=?")
      .get(signalId) as { body?: unknown } | undefined;
    if (!row) {
      return null;
    }
    if (typeof row.body !== "string") {
      throw new Error("invalid intraday outcome record");
    }
    return FinanceIntradayOutcomeInput.parse(JSON.parse(row.body));
  } finally {
    db.close();
  }
}

type Database = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

function open(directory: string): Database {
  const { DatabaseSync } = requireNodeSqlite();
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);
  const filename = financeIntradayControlLedgerPath(directory);
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  applySqliteMigrations({
    db,
    ledgerTable: "finance_intraday_control_migrations",
    migrations: MIGRATIONS,
  });
  return db;
}

function readRows(db: Database): FinanceIntradayDecisionRecord[] {
  const rows = db
    .prepare("SELECT ref, body FROM finance_intraday_decisions ORDER BY sequence")
    .all() as Array<{ ref?: unknown; body?: unknown }>;
  let previousRef: string | null = null;
  return rows.map((row, index) => {
    if (typeof row.ref !== "string" || typeof row.body !== "string") {
      throw new Error("invalid intraday decision record");
    }
    const raw: unknown = JSON.parse(row.body);
    if (caseflowFingerprint(raw) !== row.ref) {
      throw new Error("intraday decision integrity mismatch");
    }
    const record = RecordSchema.parse(raw);
    if (record.sequence !== index + 1 || record.previousRef !== previousRef) {
      throw new Error("intraday decision chain mismatch");
    }
    previousRef = row.ref;
    return { ...record, ref: row.ref };
  });
}

export async function appendFinanceIntradayDecision(
  directory: string,
  rawInput: FinanceIntradayDecisionInput,
): Promise<Readonly<{ record: FinanceIntradayDecisionRecord; appended: boolean }>> {
  const input = FinanceIntradayDecisionInput.parse(rawInput);
  const db = open(directory);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const records = readRows(db);
      const existing = records.find((record) => record.input.signalId === input.signalId);
      if (existing) {
        if (caseflowFingerprint(existing.input) !== caseflowFingerprint(input)) {
          throw new Error("intraday signalId conflict");
        }
        db.exec("COMMIT");
        return Object.freeze({ record: existing, appended: false });
      }
      const record = RecordSchema.parse({
        schemaVersion: "lcx_finance_intraday_decision_v1",
        sequence: records.length + 1,
        previousRef: records.at(-1)?.ref ?? null,
        recordedAt: new Date().toISOString(),
        input,
      });
      const ref = caseflowFingerprint(record);
      db.prepare(
        "INSERT INTO finance_intraday_decisions(ref,signal_id,sequence,body) VALUES (?,?,?,?)",
      ).run(ref, input.signalId, record.sequence, JSON.stringify(record));
      db.exec("COMMIT");
      return Object.freeze({ record: { ...record, ref }, appended: true });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function readFinanceIntradayDecisions(
  directory: string,
  options: { instrument?: string; sessionDate?: string } = {},
): Promise<readonly FinanceIntradayDecisionRecord[]> {
  try {
    await fs.stat(financeIntradayControlLedgerPath(directory));
  } catch {
    return Object.freeze([]);
  }
  const db = open(directory);
  try {
    return Object.freeze(
      readRows(db).filter(
        (record) =>
          (!options.instrument || record.input.instrument === options.instrument) &&
          (!options.sessionDate || record.input.sessionDate === options.sessionDate),
      ),
    );
  } finally {
    db.close();
  }
}
