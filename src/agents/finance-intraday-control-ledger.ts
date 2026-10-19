import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { ConfiguredFinanceCallStateSchema } from "./configured-finance-model-adapter.js";
import { FinanceAccountEconomicFeedbackSchema } from "./finance-account-economic-feedback.js";
import {
  ALPACA_SAFETY_ACCOUNT_ARITHMETIC_CONDITIONS,
  ALPACA_SAFETY_DIAGNOSTIC_STAGES,
  ALPACA_SAFETY_FAILURE_CODES,
  ALPACA_SAFETY_QUOTE_DIAGNOSTIC_STAGES,
} from "./finance-alpaca-safety-provider.js";
import { isSafeFinanceReadFailure } from "./finance-alpaca-safety-transport.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  FINANCE_EXECUTION_SAFETY_FAILURE_CATEGORIES,
  FINANCE_EXECUTION_SAFETY_FAILURE_OPERATIONS,
  FINANCE_EXECUTION_SAFETY_FAILURE_STAGES,
  FINANCE_EXECUTION_SAFETY_ATTEMPT_DISPOSITIONS,
  FINANCE_EXECUTION_SAFETY_ATTEMPT_PHASES,
} from "./finance-execution-safety.js";
import {
  FinanceExpectationGapSchema,
  FinanceStrategyReassessmentSchema,
  FinanceStrategyFeedbackResponseSchema,
  FinanceStrategyReviewFeedbackSchema,
  FinanceBrokerExitFeedbackSchema,
  FinanceBrokerExitResponseSchema,
} from "./finance-expectation-gap.js";
import { FinanceIntradayRuleSummarySchema } from "./finance-intraday-paper.js";
import { FinanceStrategyCapitalBudgetSchema } from "./finance-portfolio-composition.js";
import { FINANCE_PROTECTED_REDUCTION_STAGES } from "./finance-protection-coordination.js";
import { financeIntradayControlLedgerPath } from "./finance-state-dir.js";
import { FinanceThesisDecisionContextSchema } from "./finance-thesis-decision-context.js";
import {
  FINANCE_TRADE_REVIEW_MAX_MODEL_CALLS,
  FINANCE_TRADE_REVIEW_MAX_TOOL_REQUESTS,
  FinanceTradeReviewFailureCodeSchema,
  FinanceTradeReviewContractStageSchema,
  FinanceTradeReviewModelCallEvidenceSchema,
  FinanceTradeReviewToolEvidenceSchema,
} from "./finance-trade-review-evidence.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Text = z.string().trim().min(1);
const Iso = z.string().datetime();
const ReadFailureSchema = z
  .object({
    code: z.string().max(259),
    cleanupStatus: z.enum(["confirmed", "unconfirmed"]).optional(),
  })
  .strict()
  .refine(isSafeFinanceReadFailure);
const QuoteTimingSchema = z
  .object({
    quoteAtMs: z.number().int().nonnegative(),
    checkedAtMs: z.number().int().nonnegative(),
    aheadMs: z.number().int(),
  })
  .strict()
  .refine((t) => t.aheadMs === t.quoteAtMs - t.checkedAtMs);
const FinanceIntradayExecutionSafetyFailureRecord = z
  .object({
    stage: z.enum(FINANCE_EXECUTION_SAFETY_FAILURE_STAGES),
    category: z.enum(FINANCE_EXECUTION_SAFETY_FAILURE_CATEGORIES),
    operation: z.enum(FINANCE_EXECUTION_SAFETY_FAILURE_OPERATIONS).optional(),
    provider: z
      .object({
        reason: z.enum(ALPACA_SAFETY_FAILURE_CODES),
        quoteTiming: QuoteTimingSchema.optional(),
        transport: ReadFailureSchema.optional(),
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
            valuationRetry: z
              .object({
                firstGrossDrift: z.number().finite().nonnegative().nullable(),
                retryGrossDrift: z.number().finite().nonnegative().nullable(),
                firstCoherentTolerance: z.number().finite().nonnegative(),
                retryCoherentTolerance: z.number().finite().nonnegative(),
                cashStable: z.boolean(),
                quantitiesStable: z.boolean(),
              })
              .strict()
              .optional(),
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
        protectedReduction: z
          .object({
            stage: z.enum(FINANCE_PROTECTED_REDUCTION_STAGES),
            cancellationConfirmed: z.boolean(),
            sellExecutionEntered: z.boolean(),
            filledQuantity: z.number().finite().nonnegative().optional(),
            protectionRestored: z.boolean(),
            readFailure: ReadFailureSchema.optional(),
            cancelled: z.boolean().optional(),
            orderRequestState: z.enum(["not_started", "invoked", "unknown"]).optional(),
          })
          .strict()
          .optional(),
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
    strategyRule: Text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/u),
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
    ruleContract: FinanceIntradayRuleSummarySchema.optional(),
    capitalBudget: FinanceStrategyCapitalBudgetSchema.optional(),
    plannedQuantity: z.number().finite().positive().optional(),
    plannedNotional: z.number().finite().positive().optional(),
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
    accountId: Text.optional(),
    strategyFeedback: FinanceStrategyReviewFeedbackSchema.optional(),
    brokerExitFeedback: FinanceBrokerExitFeedbackSchema.optional(),
    accountEconomics: FinanceAccountEconomicFeedbackSchema.optional(),
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
    strategyReassessment: FinanceStrategyReassessmentSchema.optional(),
    strategyFeedbackResponse: FinanceStrategyFeedbackResponseSchema.optional(),
    brokerExitResponse: z.array(FinanceBrokerExitResponseSchema).min(1).max(2).optional(),
  })
  .strict();

export const FinanceIntradayDecisionReviewReceiptSchema = z
  .object({
    request: IntradayReviewRequestSchema,
    status: z.enum(["completed", "failed"]),
    attempted: z.boolean(),
    modelCalls: z.number().int().nonnegative().max(FINANCE_TRADE_REVIEW_MAX_MODEL_CALLS).optional(),
    provider: Text,
    modelId: Text,
    latencyMs: z.number().finite().nonnegative(),
    transport: ConfiguredFinanceCallStateSchema.optional(),
    providerCallObserved: z.boolean(),
    adapterAttested: z.boolean(),
    requestIdSha256: Hash.optional(),
    taskObjectiveSha256: Hash.optional(),
    quoteApprovalPolicy: z.literal("within_reviewed_bid_ask_v1").optional(),
    executionQuoteValidation: z
      .object({
        policy: z.enum(["exact", "within_reviewed_bid_ask_v1"]),
        checkedAt: Iso,
        status: z.enum(["unchanged", "inside_reviewed_bid_ask", "refused"]),
        reason: Text.optional(),
        quote: IntradayReviewCandidateSchema.shape.executionQuote,
      })
      .strict()
      .optional(),
    toolEvidence: FinanceTradeReviewToolEvidenceSchema.array()
      .max(FINANCE_TRADE_REVIEW_MAX_TOOL_REQUESTS)
      .optional(),
    modelCallEvidence: FinanceTradeReviewModelCallEvidenceSchema.array()
      .max(FINANCE_TRADE_REVIEW_MAX_MODEL_CALLS)
      .optional(),
    decision: IntradayReviewDecisionSchema.optional(),
    failureCode: FinanceTradeReviewFailureCodeSchema.optional(),
    outputContractStage: FinanceTradeReviewContractStageSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.outputContractStage !== undefined &&
      (receipt.status !== "failed" || receipt.failureCode !== "output_contract")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contract diagnostic requires output_contract failure",
      });
    }
    const candidateId = receipt.request.candidates[0]?.candidateId;
    const decision = receipt.decision;
    const feedback = receipt.request.strategyFeedback;
    if (
      decision &&
      ((decision.strategyReassessment && decision.decision !== "veto") ||
        (feedback
          ? decision.strategyFeedbackResponse?.signalId !== feedback.signalId
          : decision.strategyFeedbackResponse !== undefined) ||
        (decision.strategyFeedbackResponse?.disposition === "still_relevant" &&
          !decision.strategyReassessment))
    ) {
      context.addIssue({
        code: "custom",
        message: "strategy feedback must be explicitly reassessed for this exact prior signal",
      });
    }
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
    tradeDecisionReviewHistory: z
      .array(FinanceIntradayDecisionReviewReceiptSchema)
      .max(1)
      .optional(),
    executionFailure: z
      .object({
        stage: z.enum([
          "position_receipts",
          "safety_claims",
          "strategy_binding",
          "account_book",
          "owned_positions",
          "initial_quote",
          "decision_context",
          "model_review",
          "refresh_quote",
          "final_strategy_binding",
          "order_dispatch",
          "fill_projection",
        ]),
        category: z.enum(["deadline_exceeded", "cancelled", "unexpected"]),
        cleanupStatus: z.enum(["confirmed", "unconfirmed"]).optional(),
        elapsedMs: z.number().int().nonnegative(),
        /** Current operation only; elapsedMs remains cumulative for legacy readers. */
        stageElapsedMs: z.number().int().nonnegative().optional(),
        account: z
          .object({
            stage: z.enum([
              "execution_recovery",
              "broker_reconciliation",
              "safety_claims",
              "terminal_order",
              "safety_facts",
            ]),
            code: z.string().max(512),
            cleanupStatus: z.enum(["confirmed", "unconfirmed"]).optional(),
            elapsedMs: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
        quote: z
          .object({
            reason: z.enum(ALPACA_SAFETY_FAILURE_CODES),
            quoteTiming: QuoteTimingSchema.optional(),
            transport: ReadFailureSchema.optional(),
            stage: z.enum(ALPACA_SAFETY_QUOTE_DIAGNOSTIC_STAGES).optional(),
            httpStatus: z.number().int().min(100).max(599).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine(
        (failure) =>
          failure.stageElapsedMs === undefined || failure.stageElapsedMs <= failure.elapsedMs,
        { message: "operation elapsed time cannot exceed total elapsed time" },
      )
      .refine(
        (failure) =>
          failure.quote === undefined ||
          ((failure.stage === "initial_quote" || failure.stage === "refresh_quote") &&
            failure.category === "unexpected"),
        { message: "quote diagnostics require an unexpected preparation quote failure" },
      )
      .optional(),
  })
  .strict();

/** Current writes require a concrete operation for every safety failure. */
export const FinanceIntradayOutcomeInput = FinanceIntradayOutcomeBase.extend({
  executionSafetyFailure: FinanceIntradayExecutionSafetyFailureInput.optional(),
}).strict();
export type FinanceIntradayOutcomeInput = z.infer<typeof FinanceIntradayOutcomeInput>;

/** Reads remain compatible with older outcomes that stored only stage and category. */
export const FinanceIntradayOutcomeRecord = FinanceIntradayOutcomeBase.extend({
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
  options: { asOf?: string } = {},
): Promise<FinanceIntradayOutcomeRecord | null> {
  const asOf =
    options.asOf === undefined ? undefined : new Date(Iso.parse(options.asOf)).toISOString();
  try {
    await fs.stat(financeIntradayControlLedgerPath(directory));
  } catch {
    return null;
  }
  const db = open(directory);
  try {
    const row = db
      .prepare(
        asOf === undefined
          ? "SELECT body FROM finance_intraday_outcomes WHERE signal_id=?"
          : "SELECT body FROM finance_intraday_outcomes WHERE signal_id=? AND recorded_at<=?",
      )
      .get(...(asOf === undefined ? [signalId] : [signalId, asOf])) as
      | { body?: unknown }
      | undefined;
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

/** Read a bounded set of outcomes with one SQLite connection for a research evidence packet. */
export async function readFinanceIntradayOutcomes(
  directory: string,
  signalIds: readonly string[],
  options: { asOf?: string } = {},
): Promise<ReadonlyMap<string, FinanceIntradayOutcomeRecord>> {
  const asOf =
    options.asOf === undefined ? undefined : new Date(Iso.parse(options.asOf)).toISOString();
  const uniqueSignalIds = [...new Set(signalIds.map((signalId) => Text.parse(signalId)))];
  const outcomes = new Map<string, FinanceIntradayOutcomeRecord>();
  if (uniqueSignalIds.length === 0) {
    return outcomes;
  }
  try {
    await fs.stat(financeIntradayControlLedgerPath(directory));
  } catch {
    return outcomes;
  }
  const db = open(directory);
  try {
    // Stay below older SQLite builds' bind-parameter limit while still avoiding one
    // connection and query per intraday signal.
    for (let offset = 0; offset < uniqueSignalIds.length; offset += 500) {
      const ids = uniqueSignalIds.slice(offset, offset + 500);
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT signal_id, body FROM finance_intraday_outcomes
           WHERE signal_id IN (${placeholders})${asOf === undefined ? "" : " AND recorded_at<=?"}`,
        )
        .all(...ids, ...(asOf === undefined ? [] : [asOf])) as Array<{
        signal_id?: unknown;
        body?: unknown;
      }>;
      for (const row of rows) {
        if (typeof row.signal_id !== "string" || typeof row.body !== "string") {
          throw new Error("invalid intraday outcome record");
        }
        const outcome = FinanceIntradayOutcomeRecord.parse(JSON.parse(row.body));
        if (outcome.signalId !== row.signal_id) {
          throw new Error("intraday outcome signal binding mismatch");
        }
        if ((outcome.status === "placed") !== Boolean(outcome.receiptId)) {
          throw new Error("intraday outcome receipt binding mismatch");
        }
        outcomes.set(row.signal_id, outcome);
      }
    }
    return outcomes;
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
  options: { instrument?: string; sessionDate?: string; asOf?: string } = {},
): Promise<readonly FinanceIntradayDecisionRecord[]> {
  const asOf =
    options.asOf === undefined ? undefined : new Date(Iso.parse(options.asOf)).toISOString();
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
          (!options.sessionDate || record.input.sessionDate === options.sessionDate) &&
          (asOf === undefined || record.recordedAt <= asOf),
      ),
    );
  } finally {
    db.close();
  }
}

/** Read-only bounded execution coverage; a placement is not a fill or profit. */
export async function readFinanceIntradayExecutionCoverage(
  directory: string,
  asOf = new Date().toISOString(),
) {
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
      .prepare(`SELECT d.ref, d.body, d.signal_id, o.body AS outcome, o.recorded_at AS outcomeRecordedAt
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
    const strategyScopes = new Set<string>();
    const strategyReassessments: {
      signalId: string;
      accountId: string;
      instrument: string;
      ruleId: string;
      observedAt: string;
      reassessment: z.infer<typeof FinanceStrategyReassessmentSchema>;
    }[] = [];
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
      const review = outcome?.tradeDecisionReview;
      if (
        review?.status === "completed" &&
        review.request.accountId &&
        (review.decision?.strategyReassessment || review.decision?.strategyFeedbackResponse)
      ) {
        const scope = [
          review.request.accountId,
          record.input.instrument,
          record.input.strategyRule,
          record.input.strategyBinding?.activationRef,
        ].join(":");
        const at = Date.parse(review.request.asOf),
          cutoff = Date.parse(asOf);
        if (
          !strategyScopes.has(scope) &&
          Date.parse(record.recordedAt) <= cutoff &&
          typeof row.outcomeRecordedAt === "string" &&
          Date.parse(row.outcomeRecordedAt) <= cutoff &&
          at <= cutoff &&
          at + 86400000 > cutoff
        ) {
          strategyScopes.add(scope);
          if (review.decision.strategyReassessment && strategyReassessments.length < 2) {
            strategyReassessments.push({
              signalId: record.input.signalId,
              accountId: review.request.accountId,
              instrument: record.input.instrument,
              ruleId: record.input.strategyRule,
              observedAt: review.request.asOf,
              reassessment: review.decision.strategyReassessment,
            });
          }
        }
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
      ...(strategyReassessments.length ? { strategyReassessments } : {}),
      interpretation:
        "Historical signal coverage, not current market readiness. Placed is not filled. Refusal can be correct; missed-opportunity PnL is not assessed. Never replay an unresolved signal automatically.",
    };
  } finally {
    db.close();
  }
}

/** Project the most recent scoped appraisal from the original outcome book; no second state. */
export async function readFinanceIntradayStrategyFeedback(
  directory: string,
  params: {
    accountId: string;
    instrument: string;
    ruleId: string;
    activationRef: string;
    asOf: string;
    excludeSignalId: string;
  },
): Promise<z.infer<typeof FinanceStrategyReviewFeedbackSchema> | undefined> {
  const cutoff = Date.parse(params.asOf);
  if (!Number.isFinite(cutoff)) {
    throw new Error("invalid strategy feedback cutoff");
  }
  const filename = financeIntradayControlLedgerPath(directory);
  try {
    await fs.stat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT d.ref, d.body, o.body AS outcome, o.recorded_at
      FROM finance_intraday_decisions d JOIN finance_intraday_outcomes o ON o.signal_id=d.signal_id
      WHERE d.signal_id<>? AND o.recorded_at<=? AND o.recorded_at>=?
      AND json_extract(d.body,'$.input.instrument')=?
      AND json_extract(d.body,'$.input.strategyRule')=?
      AND json_extract(d.body,'$.input.strategyBinding.activationRef')=?
      AND json_extract(o.body,'$.tradeDecisionReview.request.accountId')=?
      AND json_extract(o.body,'$.tradeDecisionReview.status')='completed'
      AND (json_type(o.body,'$.tradeDecisionReview.decision.strategyReassessment')='object'
        OR json_type(o.body,'$.tradeDecisionReview.decision.strategyFeedbackResponse')='object')
      ORDER BY o.recorded_at DESC, d.sequence DESC LIMIT 1`)
      .get(
        params.excludeSignalId,
        params.asOf,
        new Date(cutoff - 86400000).toISOString(),
        params.instrument,
        params.ruleId,
        params.activationRef,
        params.accountId,
      );
    if (!row) {
      return undefined;
    }
    if (
      typeof row.body !== "string" ||
      typeof row.outcome !== "string" ||
      row.outcome.length > 131072 ||
      caseflowFingerprint(JSON.parse(row.body)) !== row.ref
    ) {
      throw new Error("strategy feedback source unavailable or integrity mismatch");
    }
    const decision = RecordSchema.parse(JSON.parse(row.body));
    const outcome = FinanceIntradayOutcomeRecord.parse(JSON.parse(row.outcome));
    const review = outcome.tradeDecisionReview!;
    const at = Date.parse(review.request.asOf);
    if (
      outcome.signalId !== decision.input.signalId ||
      review.decision?.candidateId !== outcome.signalId ||
      review.request.candidates[0].instrument !== params.instrument ||
      review.request.candidates[0].strategyRule !== params.ruleId ||
      Date.parse(decision.recordedAt) > cutoff ||
      at > cutoff ||
      !Number.isFinite(at)
    ) {
      throw new Error("strategy feedback scope or cutoff mismatch");
    }
    if (at + 86400000 <= cutoff || !review.decision.strategyReassessment) {
      return undefined;
    }
    return FinanceStrategyReviewFeedbackSchema.parse({
      origin: "model_hypothesis",
      signalId: outcome.signalId,
      decisionRef: row.ref,
      outcomeRef: caseflowFingerprint(outcome),
      accountId: params.accountId,
      instrument: params.instrument,
      ruleId: params.ruleId,
      activationRef: params.activationRef,
      observedAt: review.request.asOf,
      expiresAt: new Date(at + 86400000).toISOString(),
      reassessment: review.decision.strategyReassessment,
    });
  } finally {
    db.close();
  }
}
