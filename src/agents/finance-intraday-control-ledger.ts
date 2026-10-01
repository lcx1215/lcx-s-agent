import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  ALPACA_SAFETY_ACCOUNT_ARITHMETIC_CONDITIONS,
  ALPACA_SAFETY_DIAGNOSTIC_STAGES,
  ALPACA_SAFETY_FAILURE_CODES,
} from "./finance-alpaca-safety-provider.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  FINANCE_EXECUTION_SAFETY_FAILURE_CATEGORIES,
  FINANCE_EXECUTION_SAFETY_FAILURE_OPERATIONS,
  FINANCE_EXECUTION_SAFETY_FAILURE_STAGES,
  FINANCE_EXECUTION_SAFETY_ATTEMPT_DISPOSITIONS,
  FINANCE_EXECUTION_SAFETY_ATTEMPT_PHASES,
} from "./finance-execution-safety.js";
import { FinanceExpectationGapSchema } from "./finance-expectation-gap.js";
import { financeIntradayControlLedgerPath } from "./finance-state-dir.js";
import { FinanceThesisDecisionContextSchema } from "./finance-thesis-decision-context.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Text = z.string().trim().min(1);
const Iso = z.string().datetime();
const FinanceIntradayExecutionSafetyFailureRecord = z
  .object({
    stage: z.enum(FINANCE_EXECUTION_SAFETY_FAILURE_STAGES),
    category: z.enum(FINANCE_EXECUTION_SAFETY_FAILURE_CATEGORIES),
    operation: z.enum(FINANCE_EXECUTION_SAFETY_FAILURE_OPERATIONS).optional(),
    provider: z
      .object({
        reason: z.enum(ALPACA_SAFETY_FAILURE_CODES),
        stage: z.enum(ALPACA_SAFETY_DIAGNOSTIC_STAGES).optional(),
        accountArithmetic: z
          .object({
            failedConditions: z.array(z.enum(ALPACA_SAFETY_ACCOUNT_ARITHMETIC_CONDITIONS)).min(1),
            values: z
              .object({
                equity: z.number().finite().nullable(),
                cash: z.number().finite().nullable(),
                shortMarketValue: z.number().finite().nullable(),
                positionGross: z.number().finite().nullable(),
                longMarketValue: z.number().finite().nullable(),
                accountGross: z.number().finite().nullable(),
                grossDrift: z.number().finite().nullable(),
                grossDriftTolerance: z.number().finite().nullable(),
                cashEquityResidual: z.number().finite().nullable(),
                cashEquityTolerance: z.number().finite().nullable(),
                controllerPeakEquity: z.number().finite().nullable(),
              })
              .strict(),
            trackNewHigh: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    attempt: z
      .object({
        phase: z.enum(FINANCE_EXECUTION_SAFETY_ATTEMPT_PHASES),
        disposition: z.enum(FINANCE_EXECUTION_SAFETY_ATTEMPT_DISPOSITIONS),
        venueResponse: z
          .object({
            httpStatus: z.number().int().min(100).max(599).optional(),
            brokerCode: z.number().int().nonnegative().safe().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const FinanceIntradayExecutionSafetyFailureInput =
  FinanceIntradayExecutionSafetyFailureRecord.extend({
    operation: z.enum(FINANCE_EXECUTION_SAFETY_FAILURE_OPERATIONS),
  });
const StrategyBinding = z
  .object({
    declarationRef: Hash,
    activationRef: Hash,
    declaredInstruments: z.array(Text).min(1),
    parameters: z
      .object({
        openingRangeBars: z.number().int().min(2).max(12),
        rewardRisk: z.number().finite().positive().max(10),
        intervalSeconds: z.union([z.literal(60), z.literal(300), z.literal(900)]),
        feed: z.enum(["iex", "sip"]),
      })
      .strict(),
    scope: z.enum([
      "strategy_universe",
      "system_universe",
      "managed_position_exit",
      "explicit_diagnostic",
    ]),
    marketSession: z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        openAt: Iso,
        closeAt: Iso,
        openMinute: z.number().int().min(0).max(1439),
        closeMinute: z.number().int().min(1).max(1440),
        observedAt: Iso,
        calendarRef: Hash,
        sourceUrlOrArtifact: Text,
      })
      .strict()
      .optional(),
    universeSnapshotRef: Hash.optional(),
    managedExitProof: z
      .object({
        accountId: Text,
        entryDecisionRef: Hash,
        entryReceiptId: Text,
        positionQuantity: z.number().finite().positive(),
      })
      .strict()
      .optional(),
    priceNormalization: z
      .object({
        policyVersion: z.literal("alpaca_us_equity_stop_precision_v1"),
        instrument: Text,
        original: z
          .object({
            entryPrice: z.number().finite().positive(),
            stopPrice: z.number().finite().positive(),
            targetPrice: z.number().finite().positive().optional(),
          })
          .strict(),
        normalized: z
          .object({
            entryPrice: z.number().finite().positive(),
            stopPrice: z.number().finite().positive(),
            targetPrice: z.number().finite().positive().optional(),
          })
          .strict(),
        rewardRisk: z.number().finite().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.scope === "system_universe" && binding.universeSnapshotRef === undefined) {
      context.addIssue({
        code: "custom",
        message: "system-universe decision requires its validated snapshot reference",
      });
    }
    if (binding.scope !== "system_universe" && binding.universeSnapshotRef !== undefined) {
      context.addIssue({
        code: "custom",
        message: "only system-universe decisions may carry a universe snapshot reference",
      });
    }
  });
export type FinanceIntradayStrategyBinding = z.infer<typeof StrategyBinding>;

export const FinanceIntradayDecisionInput = z
  .object({
    signalId: Text,
    instrument: Text,
    sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    action: z.enum(["buy", "sell"]),
    reason: z.enum(["opening_range_breakout", "opening_range_stop", "reward_target", "pre_close"]),
    referencePrice: z.number().finite().positive(),
    referencePriceAt: Iso,
    stopPrice: z.number().finite().positive().optional(),
    targetPrice: z.number().finite().positive().optional(),
    datasetHeadRef: Hash,
    strategyRule: z.enum([
      "opening_range_breakout_long_next_bar_v1",
      "opening_range_breakout_long_pre_close_v2",
      "opening_range_breakout_long_dynamic_universe_v3",
    ]),
    /** Optional only for backward reading; the execution owner rejects legacy unbound signals. */
    strategyBinding: StrategyBinding.optional(),
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
  "provider_payment_required",
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
    signalReason: z.enum([
      "opening_range_breakout",
      "opening_range_stop",
      "reward_target",
      "pre_close",
    ]),
    signalReferencePrice: z.number().finite().positive(),
    signalReferencePriceAt: Iso,
    stopPrice: z.number().finite().positive().optional(),
    targetPrice: z.number().finite().positive().optional(),
    datasetHeadRef: Hash,
    marketSession: z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        openAt: Iso,
        closeAt: Iso,
        openMinute: z.number().int().min(0).max(1439),
        closeMinute: z.number().int().min(1).max(1440),
        observedAt: Iso,
        calendarRef: Hash,
        sourceUrlOrArtifact: Text,
      })
      .strict()
      .optional(),
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
    expectationGap: FinanceExpectationGapSchema.optional(),
  })
  .strict();

export const FinanceIntradayDecisionReviewReceiptSchema = z
  .object({
    request: IntradayReviewRequestSchema,
    status: z.enum(["completed", "failed"]),
    attempted: z.boolean(),
    modelCalls: z.number().int().nonnegative().max(2).optional(),
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

const FinanceIntradayOutcomeBase = z
  .object({
    signalId: Text,
    status: z.enum(["placed", "refused", "uncertain"]),
    receiptId: Text.optional(),
    reasons: z.array(Text),
    tradeDecisionReview: FinanceIntradayDecisionReviewReceiptSchema.optional(),
  })
  .strict();

/** Current writes require a concrete operation for every safety failure. */
export const FinanceIntradayOutcomeInput = FinanceIntradayOutcomeBase.extend({
  executionSafetyFailure: FinanceIntradayExecutionSafetyFailureInput.optional(),
}).strict();
export type FinanceIntradayOutcomeInput = z.infer<typeof FinanceIntradayOutcomeInput>;

/** Reads remain compatible with older outcomes that stored only stage and category. */
const FinanceIntradayOutcomeRecord = FinanceIntradayOutcomeBase.extend({
  executionSafetyFailure: FinanceIntradayExecutionSafetyFailureRecord.optional(),
}).strict();
export type FinanceIntradayOutcomeRecord = z.infer<typeof FinanceIntradayOutcomeRecord>;

export async function appendFinanceIntradayOutcome(
  directory: string,
  rawInput: FinanceIntradayOutcomeInput,
): Promise<Readonly<{ input: FinanceIntradayOutcomeRecord; appended: boolean }>> {
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
      const stored = FinanceIntradayOutcomeRecord.parse(JSON.parse(existing.body));
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
): Promise<FinanceIntradayOutcomeRecord | null> {
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
    return FinanceIntradayOutcomeRecord.parse(JSON.parse(row.body));
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

/** Read-only bounded execution coverage; a placement is not a fill or profit. */
export async function readFinanceIntradayExecutionCoverage(directory: string) {
  const filename = financeIntradayControlLedgerPath(directory);
  try {
    await fs.stat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent" as const };
    }
    throw error;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = db
      .prepare(`SELECT d.ref, d.body, d.signal_id, o.body AS outcome
      FROM finance_intraday_decisions d LEFT JOIN finance_intraday_outcomes o ON o.signal_id=d.signal_id
      ORDER BY d.sequence DESC LIMIT 100`)
      .all();
    const counts = {
      candidates: rows.length,
      placed: 0,
      refused: 0,
      uncertain: 0,
      missingOutcome: 0,
    };
    const reasons = new Map<string, number>();
    const safetyFailures = new Map<
      string,
      z.infer<typeof FinanceIntradayExecutionSafetyFailureRecord> & { count: number }
    >();
    const unresolved: { signalId: string; action: string; reason: string; status: string }[] = [];
    const signalTimes: string[] = [];
    for (const row of rows) {
      if (typeof row.body !== "string" || caseflowFingerprint(JSON.parse(row.body)) !== row.ref) {
        throw new Error("intraday coverage decision integrity mismatch");
      }
      const record = RecordSchema.parse(JSON.parse(row.body));
      if (record.input.signalId !== row.signal_id) {
        throw new Error("intraday coverage signal binding mismatch");
      }
      const at = record.input.referencePriceAt;
      signalTimes.push(at);
      const outcome =
        row.outcome === null
          ? null
          : FinanceIntradayOutcomeRecord.parse(JSON.parse(String(row.outcome)));
      if (outcome && outcome.signalId !== record.input.signalId) {
        throw new Error("intraday coverage outcome binding mismatch");
      }
      if (outcome && (outcome.status === "placed") !== Boolean(outcome.receiptId)) {
        throw new Error("intraday coverage receipt binding mismatch");
      }
      if (outcome) {
        counts[outcome.status]++;
      } else {
        counts.missingOutcome++;
      }
      for (const reason of new Set(outcome?.reasons ?? [])) {
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      if (outcome?.executionSafetyFailure) {
        const failure = outcome.executionSafetyFailure;
        const key = [
          failure.stage,
          failure.category,
          failure.operation ?? "",
          failure.provider?.reason ?? "",
          failure.provider?.stage ?? "",
        ].join(":");
        const current = safetyFailures.get(key);
        safetyFailures.set(key, {
          ...failure,
          count: (current?.count ?? 0) + 1,
        });
      }
      if (outcome?.status !== "placed" && unresolved.length < 4) {
        unresolved.push({
          signalId: record.input.signalId,
          action: record.input.action,
          reason: record.input.reason,
          status: outcome?.status ?? "missing_outcome",
        });
      }
    }
    return {
      status: "present" as const,
      scope: "latest_100_recorded_signals",
      limit: 100,
      newestSignalAt: signalTimes.toSorted().at(-1) ?? null,
      oldestSignalAt: signalTimes.toSorted().at(0) ?? null,
      ...counts,
      allRecordedCandidatesUnexecuted: counts.candidates > 0 && counts.placed === 0,
      needsExecutionInspection:
        counts.uncertain > 0 ||
        counts.missingOutcome > 0 ||
        (counts.candidates > 0 && counts.placed === 0),
      topReasons: [...reasons]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([reason, count]) => ({ reason: reason.slice(0, 240), count })),
      topExecutionSafetyFailures: [...safetyFailures.values()]
        .toSorted((a, b) => b.count - a.count)
        .slice(0, 4),
      recentUnexecuted: unresolved,
      interpretation:
        "Historical signal coverage, not current market readiness. Placed is not filled. Refusal can be correct; missed-opportunity PnL is not assessed. Never replay an unresolved signal automatically.",
    };
  } finally {
    db.close();
  }
}
