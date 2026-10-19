import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "../plugin-sdk/file-lock.js";
import {
  ALPACA_SAFETY_ACCOUNT_ARITHMETIC_CONDITIONS,
  isSafeAlpacaQuoteTiming,
  type AlpacaSafetyQuoteTiming,
  ALPACA_SAFETY_DIAGNOSTIC_STAGES,
  ALPACA_SAFETY_FAILURE_CODES,
} from "./finance-alpaca-safety-provider.js";
import type {
  AlpacaSafetyAccountArithmeticDiagnostic,
  AlpacaSafetyFailureCode,
  AlpacaSafetyDiagnosticStage,
} from "./finance-alpaca-safety-provider.js";
import {
  isSafeFinanceReadFailure,
  type FinanceReadFailureDiagnostic,
} from "./finance-alpaca-safety-transport.js";
import type {
  FinanceExecutionReconciliation,
  FinanceQuantityDifferenceIsolation,
} from "./finance-broker-reconciliation.js";
import type {
  FinanceExecutionIntent,
  FinanceExecutionFill,
  FinanceExecutionReceipt,
  FinanceOrderSide,
  FinanceRiskBudget,
} from "./finance-execution-adapter.js";
import {
  FinanceProtectedReductionError,
  type FinanceProtectedReductionDiagnostic,
} from "./finance-protection-coordination.js";
import { stableStringify } from "./stable-stringify.js";

export const FINANCE_EXECUTION_SAFETY_FAILURE_STAGES = [
  "state",
  "lock",
  "journal",
  "facts",
  "reservation",
  "execution",
  "receipt",
] as const;
export const FINANCE_EXECUTION_SAFETY_ATTEMPT_PHASES = [
  "not_started",
  "execute",
  "receipt",
] as const;
export const FINANCE_EXECUTION_SAFETY_ATTEMPT_DISPOSITIONS = [
  "not_started",
  "definite_rejection",
  "outcome_unresolved",
] as const;
export const FINANCE_EXECUTION_SAFETY_CONTROLLER_FAILURE_CATEGORIES = [
  "quote_binding_missing",
  "account_snapshot_unavailable",
  "execution_recovery_incomplete",
  "unresolved_execution_claims",
  "terminal_order_mismatch",
  "broker_reconciliation_blocked",
  "broker_reconciliation_unavailable",
  "positions_changed",
  "cash_changed",
] as const;
export const FINANCE_EXECUTION_SAFETY_FAILURE_CATEGORIES = [
  ...FINANCE_EXECUTION_SAFETY_CONTROLLER_FAILURE_CATEGORIES,
  "unexpected",
  "cancelled_or_expired",
] as const;
export const FINANCE_EXECUTION_SAFETY_FAILURE_OPERATIONS = [
  "create_state_directory",
  "resolve_state_directory",
  "wait_for_account_queue",
  "acquire_account_lock",
  "read_execution_journal",
  "read_account_safety_facts",
  "reserve_execution_claim",
  "execute_order",
  "record_execution_receipt",
] as const;

export type FinanceExecutionSafetyAttempt = Readonly<{
  phase: (typeof FINANCE_EXECUTION_SAFETY_ATTEMPT_PHASES)[number];
  disposition: (typeof FINANCE_EXECUTION_SAFETY_ATTEMPT_DISPOSITIONS)[number];
  venueResponse?: Readonly<{ httpStatus?: number; brokerCode?: number }>;
  protectedReduction?: FinanceProtectedReductionDiagnostic;
}>;

/** Typed adapter diagnostic. Only allowlisted numeric fields cross the persistence boundary. */
export class FinanceExecutionSafetyDispatchError extends Error {
  readonly executionStage: "pre_dispatch" | "venue_response" | "unclassified";
  readonly httpStatus?: number;
  readonly brokerCode?: number;

  constructor(params: {
    executionStage: "pre_dispatch" | "venue_response" | "unclassified";
    httpStatus?: number;
    brokerCode?: number;
    cause?: unknown;
  }) {
    if (
      (params.httpStatus !== undefined &&
        (!Number.isInteger(params.httpStatus) ||
          params.httpStatus < 100 ||
          params.httpStatus > 599)) ||
      (params.brokerCode !== undefined &&
        (!Number.isSafeInteger(params.brokerCode) || params.brokerCode < 0)) ||
      (params.executionStage !== "venue_response" &&
        (params.httpStatus !== undefined || params.brokerCode !== undefined)) ||
      (params.executionStage === "venue_response" &&
        (params.httpStatus === undefined ||
          params.httpStatus < 400 ||
          params.httpStatus >= 500 ||
          params.httpStatus === 408 ||
          params.httpStatus === 499))
    ) {
      throw new Error("invalid execution dispatch diagnostic");
    }
    super(
      "execution dispatch failed",
      params.cause === undefined ? undefined : { cause: params.cause },
    );
    this.name = "FinanceExecutionSafetyDispatchError";
    this.executionStage = params.executionStage;
    this.httpStatus = params.httpStatus;
    this.brokerCode = params.brokerCode;
  }
}

export type FinanceExecutionSafetyFailure = Readonly<{
  stage: (typeof FINANCE_EXECUTION_SAFETY_FAILURE_STAGES)[number];
  category: (typeof FINANCE_EXECUTION_SAFETY_FAILURE_CATEGORIES)[number];
  operation: (typeof FINANCE_EXECUTION_SAFETY_FAILURE_OPERATIONS)[number];
  provider?: Readonly<{
    reason: AlpacaSafetyFailureCode;
    stage?: AlpacaSafetyDiagnosticStage;
    accountArithmetic?: AlpacaSafetyAccountArithmeticDiagnostic;
    quoteTiming?: AlpacaSafetyQuoteTiming;
    transport?: FinanceReadFailureDiagnostic;
  }>;
  attempt?: FinanceExecutionSafetyAttempt;
}>;

type FinanceExecutionProtectiveOrderClaim = Readonly<{
  id: string;
  quantity: number;
  stopPrice: number;
  /** Omitted only by legacy stop claims. */
  orderType?: "stop" | "stop_limit";
  limitPrice?: number;
}>;

export type FinanceExecutionSafetyFacts = Readonly<{
  reconciliation?: FinanceExecutionReconciliation;
  accountId: string;
  adapterId: string;
  venue: string;
  instrument: string;
  instrumentEvidence: Readonly<{
    source: string;
    observedAt: string;
    assetType: "spot_equity" | "spot_crypto";
    fullyPaid: boolean;
    marginEnabled: boolean;
    hedged: boolean;
  }>;
  snapshotId: string;
  source: string;
  observedAt: string;
  expiresAt: string;
  /** Exact latest durable claim included in this fresh account snapshot. */
  reconciledThroughClaimId?: string;
  positionQuantity: number;
  reservedSellQuantity?: number;
  protectiveOrderIds?: readonly string[];
  protectiveOrders?: readonly FinanceExecutionProtectiveOrderClaim[];
  openOrderIds: readonly string[];
  unresolvedOrderIds: readonly string[];
  account: Readonly<{
    status: string;
    tradingBlocked: boolean;
    equity: number;
    availableCash: number;
    peakEquity: number;
    currency: string;
    grossExposure: number;
  }>;
  quote: Readonly<{
    source: string;
    price: number;
    observedAt: string;
    expiresAt: string;
    currency: string;
  }>;
}>;
export type FinanceExecutionSafetyPolicy = Readonly<{
  quantityDifferenceIsolation?: FinanceQuantityDifferenceIsolation;
  planId: string;
  revision: string;
  riskModel: "fully_funded_unhedged_spot";
  authorizedSide: FinanceOrderSide;
  authorizedQuantity: number;
  expiresAt: string;
  maxPortfolioDrawdownFraction: number;
  maxGrossExposure: number;
  maxAccountAgeMs: number;
  maxQuoteAgeMs: number;
  maxInstrumentEvidenceAgeMs: number;
}>;
/** Opaque controller-issued capability; serializing it grants no execution authority. */
export type FinanceExecutionSafetyContext = Readonly<{ kind: "controller_execution_safety" }>;
export type FinanceExecutionSafetyContextInput = Readonly<{
  stateDir: string;
  accountId: string;
  adapterId: string;
  venue: string;
  intent: FinanceExecutionIntent;
  budget: FinanceRiskBudget;
  policy: FinanceExecutionSafetyPolicy;
  /** Called under the account lock; never a model-supplied callback or cached snapshot. */
  readFacts: (signal: AbortSignal) => Promise<FinanceExecutionSafetyFacts | undefined>;
}>;

export type FinanceExecutionSafetyContextFactory = (
  binding: Readonly<{
    intent: FinanceExecutionIntent;
    budget: FinanceRiskBudget;
    adapterId: string;
    venue: string;
  }>,
) => FinanceExecutionSafetyContext;

type Issued = FinanceExecutionSafetyContextInput & { used: boolean };
const issued = new WeakMap<FinanceExecutionSafetyContext, Issued>();
const queues = new Map<string, Promise<void>>();
const accountRoots = new Map<string, string>();
const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const fresh = (observed: string, expires: string, now: number) =>
  Number.isFinite(Date.parse(observed)) &&
  Date.parse(observed) <= now &&
  Date.parse(expires) > now &&
  Date.parse(expires) > Date.parse(observed);

/** Controller-only constructor: never expose this factory or its facts in a model tool schema. */
export function createFinanceExecutionSafetyContext(
  input: FinanceExecutionSafetyContextInput,
): FinanceExecutionSafetyContext {
  const token = Object.freeze({ kind: "controller_execution_safety" as const });
  const { readFacts, ...binding } = input;
  issued.set(token, { ...structuredClone(binding), readFacts, used: false });
  return token;
}

/** Fixed controller categories only; never persist raw exception text or credentials. */
export class FinanceExecutionSafetyFactsError extends Error {
  readonly category: (typeof FINANCE_EXECUTION_SAFETY_CONTROLLER_FAILURE_CATEGORIES)[number];
  readonly provider?: Readonly<{
    reason: AlpacaSafetyFailureCode;
    stage?: AlpacaSafetyDiagnosticStage;
    accountArithmetic?: AlpacaSafetyAccountArithmeticDiagnostic;
    quoteTiming?: AlpacaSafetyQuoteTiming;
    transport?: FinanceReadFailureDiagnostic;
  }>;

  constructor(
    category: (typeof FINANCE_EXECUTION_SAFETY_CONTROLLER_FAILURE_CATEGORIES)[number],
    provider?: {
      reason: AlpacaSafetyFailureCode;
      stage?: AlpacaSafetyDiagnosticStage;
      accountArithmetic?: AlpacaSafetyAccountArithmeticDiagnostic;
      quoteTiming?: AlpacaSafetyQuoteTiming;
      transport?: FinanceReadFailureDiagnostic;
    },
  ) {
    if (provider?.quoteTiming !== undefined && !isSafeAlpacaQuoteTiming(provider.quoteTiming)) {
      throw new Error("invalid quote timing diagnostic");
    }
    if (provider?.transport !== undefined && !isSafeFinanceReadFailure(provider.transport)) {
      throw new Error("invalid finance read diagnostic");
    }
    const accountArithmetic = provider?.accountArithmetic;
    const arithmeticValues = accountArithmetic?.values;
    const valuationRetry = accountArithmetic?.valuationRetry;
    const retryNumericKeys = [
      "firstGrossDrift",
      "retryGrossDrift",
      "firstCoherentTolerance",
      "retryCoherentTolerance",
    ] as const;
    const arithmeticKeys = [
      "equity",
      "cash",
      "shortMarketValue",
      "positionGross",
      "longMarketValue",
      "accountGross",
      "grossDrift",
      "grossDriftTolerance",
      "cashEquityResidual",
      "cashEquityTolerance",
      "controllerPeakEquity",
    ] as const;
    if (
      !FINANCE_EXECUTION_SAFETY_CONTROLLER_FAILURE_CATEGORIES.some((item) => item === category) ||
      (provider &&
        (!ALPACA_SAFETY_FAILURE_CODES.some((item) => item === provider.reason) ||
          (provider.stage !== undefined &&
            !ALPACA_SAFETY_DIAGNOSTIC_STAGES.some((item) => item === provider.stage)))) ||
      (accountArithmetic !== undefined &&
        (provider?.reason !== "alpaca_safety_facts_inconsistent" ||
          provider.stage !== "account_arithmetic" ||
          !Array.isArray(accountArithmetic.failedConditions) ||
          accountArithmetic.failedConditions.length === 0 ||
          accountArithmetic.failedConditions.some(
            (item) => !ALPACA_SAFETY_ACCOUNT_ARITHMETIC_CONDITIONS.includes(item),
          ) ||
          typeof accountArithmetic.trackNewHigh !== "boolean" ||
          !arithmeticValues ||
          Object.keys(arithmeticValues).length !== arithmeticKeys.length ||
          arithmeticKeys.some((key) => {
            const value = arithmeticValues[key];
            return value !== null && (typeof value !== "number" || !Number.isFinite(value));
          }) ||
          (valuationRetry !== undefined &&
            (!valuationRetry ||
              typeof valuationRetry !== "object" ||
              Object.keys(valuationRetry).length !== 6 ||
              typeof valuationRetry.cashStable !== "boolean" ||
              typeof valuationRetry.quantitiesStable !== "boolean" ||
              retryNumericKeys.some((key) => {
                const value = valuationRetry[key];
                return (
                  (value === null && key !== "firstGrossDrift" && key !== "retryGrossDrift") ||
                  (value !== null &&
                    (typeof value !== "number" || !Number.isFinite(value) || value < 0))
                );
              })))))
    ) {
      throw new Error("invalid finance execution safety failure classification");
    }
    super(
      provider
        ? `${category}:${provider.reason}${provider.stage ? `:${provider.stage}` : ""}`
        : category,
    );
    this.name = "FinanceExecutionSafetyFactsError";
    this.category = category;
    this.provider = provider
      ? Object.freeze({
          reason: provider.reason,
          ...(provider.transport ? { transport: { ...provider.transport } } : {}),
          ...(provider.quoteTiming ? { quoteTiming: { ...provider.quoteTiming } } : {}),
          ...(provider.stage === undefined ? {} : { stage: provider.stage }),
          ...(accountArithmetic === undefined
            ? {}
            : {
                accountArithmetic: {
                  failedConditions: [...accountArithmetic.failedConditions],
                  values: Object.fromEntries(
                    arithmeticKeys.map((key) => [key, arithmeticValues?.[key] ?? null]),
                  ) as AlpacaSafetyAccountArithmeticDiagnostic["values"],
                  trackNewHigh: accountArithmetic.trackNewHigh,
                  ...(valuationRetry
                    ? {
                        valuationRetry: {
                          firstGrossDrift: valuationRetry.firstGrossDrift,
                          retryGrossDrift: valuationRetry.retryGrossDrift,
                          firstCoherentTolerance: valuationRetry.firstCoherentTolerance,
                          retryCoherentTolerance: valuationRetry.retryCoherentTolerance,
                          cashStable: valuationRetry.cashStable,
                          quantitiesStable: valuationRetry.quantitiesStable,
                        },
                      }
                    : {}),
                },
              }),
        })
      : undefined;
  }
}

export class FinanceExecutionSafetyUncertainError extends Error {
  readonly code = "finance_execution_safety_unknown";
  constructor(
    readonly claimId: string,
    cause: unknown,
    readonly attempt: FinanceExecutionSafetyAttempt = Object.freeze({
      phase: "execute",
      disposition: "outcome_unresolved",
    }),
  ) {
    super("execution outcome unresolved; account safety claim retained until reconciliation", {
      cause,
    });
    this.name = "FinanceExecutionSafetyUncertainError";
  }
}

/** A typed dispatch failure whose durable terminal claim proves no open outcome remains. */
export class FinanceExecutionSafetyTerminalFailureError extends Error {
  constructor(
    readonly claimId: string,
    readonly status: "not_started" | "rejected",
    readonly attempt: FinanceExecutionSafetyAttempt,
    cause: unknown,
  ) {
    super("execution was not accepted by the venue", { cause });
    this.name = "FinanceExecutionSafetyTerminalFailureError";
  }
}

export type FinanceExecutionSafetyClaim = {
  id: string;
  run: string;
  instrument: string;
  notional: number;
  snapshotId: string;
  at: string;
  status: "reserved" | "confirmed" | "unknown" | "not_started" | "rejected" | "operator_retired";
  operatorRetirement?: Readonly<{
    authorizedBy: "user";
    authorizationRef: string;
    reason: string;
    brokerObservationRef: string;
    retiredAt: string;
    originalStatus: "reserved" | "unknown";
  }>;
  failure?: FinanceExecutionSafetyAttempt;
  binding?: Readonly<{
    accountId: string;
    adapterId: string;
    venue: string;
    intent: FinanceExecutionIntent;
    policy: FinanceExecutionSafetyPolicy;
    budget: FinanceRiskBudget;
    reconciliation?: FinanceExecutionReconciliation;
    protectiveOrders?: readonly FinanceExecutionProtectiveOrderClaim[];
    positionQuantity?: number;
  }>;
  fill?: FinanceExecutionFill;
  adapterKind?: "paper" | "venue";
  receipt?: FinanceExecutionReceipt;
  receiptIdentityVersion?: "account-v1";
};
async function readJournal(file: string): Promise<FinanceExecutionSafetyClaim[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return parseJournal(raw);
}
function parseJournal(raw: string): FinanceExecutionSafetyClaim[] {
  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value = JSON.parse(line) as FinanceExecutionSafetyClaim;
      if (
        !text(value.id) ||
        !text(value.run) ||
        !text(value.instrument) ||
        !positive(value.notional) ||
        !text(value.snapshotId) ||
        !Number.isFinite(Date.parse(value.at)) ||
        ![
          "reserved",
          "confirmed",
          "unknown",
          "not_started",
          "rejected",
          "operator_retired",
        ].includes(value.status) ||
        (value.status === "not_started" &&
          (!value.binding ||
            value.failure?.phase !== "not_started" ||
            value.failure.disposition !== "not_started" ||
            value.failure.venueResponse !== undefined ||
            value.fill !== undefined ||
            value.receipt !== undefined)) ||
        (value.status === "rejected" &&
          (!value.binding ||
            value.failure?.phase !== "execute" ||
            value.failure.disposition !== "definite_rejection" ||
            !Number.isInteger(value.failure.venueResponse?.httpStatus) ||
            value.failure.venueResponse!.httpStatus! < 400 ||
            value.failure.venueResponse!.httpStatus! >= 500 ||
            value.failure.venueResponse!.httpStatus === 408 ||
            value.failure.venueResponse!.httpStatus === 499 ||
            (value.failure.venueResponse!.brokerCode !== undefined &&
              (!Number.isSafeInteger(value.failure.venueResponse!.brokerCode) ||
                value.failure.venueResponse!.brokerCode < 0)) ||
            value.fill !== undefined ||
            value.receipt !== undefined)) ||
        (value.status === "operator_retired" &&
          (!value.binding ||
            value.binding.venue !== "alpaca:paper" ||
            !text(value.binding.accountId) ||
            value.id !==
              digest([
                value.binding.accountId,
                value.binding.venue,
                value.binding.intent.runAuthorizationId,
                value.binding.intent.intentId,
              ]) ||
            !value.operatorRetirement ||
            value.operatorRetirement.authorizedBy !== "user" ||
            !text(value.operatorRetirement.authorizationRef) ||
            value.operatorRetirement.authorizationRef.length > 500 ||
            !text(value.operatorRetirement.reason) ||
            value.operatorRetirement.reason.length > 1000 ||
            !/^(?:sha256:)?[a-f0-9]{64}$/.test(value.operatorRetirement.brokerObservationRef) ||
            !Number.isFinite(Date.parse(value.operatorRetirement.retiredAt)) ||
            !["reserved", "unknown"].includes(value.operatorRetirement.originalStatus) ||
            value.fill !== undefined ||
            value.receipt !== undefined ||
            value.adapterKind !== undefined))
      ) {
        throw new Error("invalid execution safety journal");
      }
      return value;
    });
  const prior = new Map<string, FinanceExecutionSafetyClaim>();
  for (const row of rows) {
    if (row.status === "operator_retired") {
      const previous = prior.get(row.id);
      if (
        !previous ||
        (previous.status !== "reserved" && previous.status !== "unknown") ||
        row.operatorRetirement?.originalStatus !== previous.status ||
        row.run !== previous.run ||
        row.instrument !== previous.instrument ||
        row.notional !== previous.notional ||
        row.snapshotId !== previous.snapshotId ||
        stableStringify(row.binding) !== stableStringify(previous.binding)
      ) {
        throw new Error("invalid execution safety journal");
      }
    }
    prior.set(row.id, row);
  }
  return rows;
}
async function appendJournal(file: string, claim: FinanceExecutionSafetyClaim): Promise<void> {
  const handle = await fs.open(file, "a", 0o600);
  try {
    await handle.writeFile(JSON.stringify(claim) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("execution safety cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Canonical gross-capacity predicate; callers supply already validated notional and reserve. */
export function financeExecutionGrossExposureIssue(params: {
  grossExposure: number;
  maxGrossExposure: number;
  notional: number;
  uncertaintyReserve: number;
  reducing: boolean;
}):
  | "execution_safety_portfolio_exposure_required"
  | "execution_safety_portfolio_exposure_exceeded"
  | null {
  if (
    !Number.isFinite(params.grossExposure) ||
    params.grossExposure < 0 ||
    !positive(params.maxGrossExposure)
  ) {
    return "execution_safety_portfolio_exposure_required";
  }
  if (
    !params.reducing &&
    params.grossExposure + params.notional + params.uncertaintyReserve > params.maxGrossExposure
  ) {
    return "execution_safety_portfolio_exposure_exceeded";
  }
  return null;
}

export async function withFinanceExecutionSafety(params: {
  context: FinanceExecutionSafetyContext | undefined;
  intent: FinanceExecutionIntent;
  budget: FinanceRiskBudget;
  adapterId: string;
  venue: string;
  adapterKind: "paper" | "venue";
  supportsProtectedReduction?: boolean;
  signal?: AbortSignal;
  recordedAt?: string;
  buildReceipt: (
    fill: FinanceExecutionFill,
    recordedAt: string,
    accountId: string,
  ) => FinanceExecutionReceipt;
  execute: (
    signal: AbortSignal,
    facts: FinanceExecutionSafetyFacts,
  ) => Promise<FinanceExecutionFill>;
}): Promise<
  | { ok: true; fill: FinanceExecutionFill; receipt: FinanceExecutionReceipt }
  | { ok: false; reasons: string[]; failure?: FinanceExecutionSafetyFailure }
> {
  const refuse = (reason: string, failure?: FinanceExecutionSafetyFailure) => ({
    ok: false as const,
    reasons: [reason],
    ...(failure ? { failure: Object.freeze({ ...failure }) } : {}),
  });
  const binding = params.context && issued.get(params.context);
  if (!binding) {
    return refuse("controller_execution_safety_context_required");
  }
  if (binding.used) {
    return refuse("execution_safety_context_already_consumed");
  }
  const { intent, budget, policy } = binding;
  if (
    digest(intent) !== digest(params.intent) ||
    digest(budget) !== digest(params.budget) ||
    binding.adapterId !== params.adapterId ||
    binding.venue !== params.venue
  ) {
    return refuse("execution_safety_binding_mismatch");
  }
  if (
    !text(binding.stateDir) ||
    !text(binding.accountId) ||
    !text(binding.venue) ||
    !text(policy.planId) ||
    !text(policy.revision) ||
    policy.riskModel !== "fully_funded_unhedged_spot"
  ) {
    return refuse("execution_safety_risk_model_or_binding_unsupported");
  }
  if (
    policy.authorizedSide !== intent.side ||
    !positive(policy.authorizedQuantity) ||
    intent.quantity > policy.authorizedQuantity ||
    !Number.isFinite(Date.parse(policy.expiresAt)) ||
    Date.parse(policy.expiresAt) <= Date.now()
  ) {
    return refuse("execution_safety_authorized_plan_exceeded_or_expired");
  }
  binding.used = true;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("execution safety authority expired")),
    Math.min(Date.parse(policy.expiresAt) - Date.now(), 2147483647),
  );
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  let releaseQueue: (() => void) | undefined;
  let key: string | undefined;
  let tail: Promise<void> | undefined;
  let failureStage: (typeof FINANCE_EXECUTION_SAFETY_FAILURE_STAGES)[number] = "state";
  let failureOperation: (typeof FINANCE_EXECUTION_SAFETY_FAILURE_OPERATIONS)[number] =
    "create_state_directory";
  let attemptPhase: FinanceExecutionSafetyAttempt["phase"] = "not_started";
  try {
    signal.throwIfAborted();
    await fs.mkdir(binding.stateDir, { recursive: true, mode: 0o700 });
    failureOperation = "resolve_state_directory";
    const root = await fs.realpath(binding.stateDir);
    const accountKey = digest([binding.venue, binding.accountId]);
    const registeredRoot = accountRoots.get(accountKey);
    if (registeredRoot !== undefined && registeredRoot !== root) {
      return refuse("execution_safety_account_root_conflict");
    }
    accountRoots.set(accountKey, root);
    key = path.join(root, `execution-safety-${digest([binding.venue, binding.accountId])}.jsonl`);
    const prior = queues.get(key) ?? Promise.resolve();
    const own = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    tail = prior.then(() => own);
    queues.set(key, tail);
    // Wait for the prior owner even after cancellation; then refuse before acquiring/dispatching.
    failureOperation = "wait_for_account_queue";
    await bounded(prior, signal);
    signal.throwIfAborted();
    failureStage = "lock";
    failureOperation = "acquire_account_lock";
    const lock = await acquireFileLock(key, {
      stale: Infinity,
      retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      signal.throwIfAborted();
      failureStage = "journal";
      failureOperation = "read_execution_journal";
      const journal = await readJournal(key);
      const latest = new Map(journal.map((claim) => [claim.id, claim]));
      if (
        [...latest.values()].some(
          (claim) => claim.status === "reserved" || claim.status === "unknown",
        )
      ) {
        return refuse("execution_safety_account_requires_reconciliation");
      }
      const id = digest([
        binding.accountId,
        binding.venue,
        intent.runAuthorizationId,
        intent.intentId,
      ]);
      if (latest.has(id)) {
        return refuse("execution_safety_intent_already_claimed");
      }
      failureStage = "facts";
      failureOperation = "read_account_safety_facts";
      const observed = await bounded(
        Promise.resolve().then(() => binding.readFacts(signal)),
        signal,
      );
      const facts = observed === undefined ? undefined : structuredClone(observed);
      const now = Date.now();
      if (
        !facts ||
        !text(facts.snapshotId) ||
        !text(facts.source) ||
        !fresh(facts.observedAt, facts.expiresAt, now) ||
        !fresh(facts.quote?.observedAt, facts.quote?.expiresAt, now) ||
        !text(facts.quote?.source) ||
        facts.quote.price !== intent.referencePrice ||
        facts.quote.observedAt !== intent.referencePriceAt
      ) {
        return refuse("execution_safety_fresh_account_and_quote_facts_required");
      }
      const ageOkay = (at: string, maxAge: number, checkedAt = now) =>
        Number.isFinite(Date.parse(at)) &&
        positive(maxAge) &&
        checkedAt >= Date.parse(at) &&
        checkedAt - Date.parse(at) <= maxAge;
      const instrumentEvidence = facts.instrumentEvidence;
      if (
        facts.accountId !== binding.accountId ||
        facts.adapterId !== binding.adapterId ||
        facts.venue !== binding.venue ||
        facts.instrument.trim().toUpperCase() !== intent.instrument.trim().toUpperCase() ||
        !instrumentEvidence ||
        !text(instrumentEvidence.source) ||
        !["spot_equity", "spot_crypto"].includes(instrumentEvidence.assetType) ||
        typeof instrumentEvidence.fullyPaid !== "boolean" ||
        !instrumentEvidence.fullyPaid ||
        typeof instrumentEvidence.marginEnabled !== "boolean" ||
        instrumentEvidence.marginEnabled ||
        typeof instrumentEvidence.hedged !== "boolean" ||
        instrumentEvidence.hedged ||
        !ageOkay(instrumentEvidence.observedAt, policy.maxInstrumentEvidenceAgeMs) ||
        !ageOkay(facts.observedAt, policy.maxAccountAgeMs) ||
        !ageOkay(facts.quote.observedAt, policy.maxQuoteAgeMs) ||
        !text(facts.account?.currency) ||
        facts.quote.currency !== facts.account.currency
      ) {
        return refuse("execution_safety_fact_identity_risk_model_currency_or_age_invalid");
      }
      const last = journal.at(-1);
      if (
        last &&
        (facts.reconciledThroughClaimId !== last.id ||
          Date.parse(facts.observedAt) < Date.parse(last.at) ||
          facts.snapshotId === last.snapshotId)
      ) {
        return refuse("execution_safety_snapshot_precedes_last_claim");
      }
      if (
        !Array.isArray(facts.openOrderIds) ||
        !Array.isArray(facts.unresolvedOrderIds) ||
        facts.openOrderIds.length ||
        facts.unresolvedOrderIds.length
      ) {
        return refuse("execution_safety_pending_orders_require_reconciliation");
      }
      if (
        typeof facts.positionQuantity !== "number" ||
        !Number.isFinite(facts.positionQuantity) ||
        facts.positionQuantity < 0 ||
        facts.account?.status !== "ACTIVE" ||
        typeof facts.account.tradingBlocked !== "boolean" ||
        facts.account.tradingBlocked
      ) {
        return refuse("execution_safety_account_or_position_not_usable");
      }
      const reconciliation = facts.reconciliation;
      const isolation = policy.quantityDifferenceIsolation;
      let uncertaintyReserve = 0;
      if (isolation && !reconciliation) {
        return refuse("execution_safety_reconciliation_scope_required");
      }
      if (reconciliation) {
        if (reconciliation.status === "restricted") {
          if (
            !isolation ||
            reconciliation.historyStatus !== "unresolved" ||
            !Array.isArray(reconciliation.quarantinedInstruments) ||
            !reconciliation.quarantinedInstruments.length ||
            !positive(reconciliation.uncertaintyReserve) ||
            !positive(isolation.maxUnexplainedNotional) ||
            reconciliation.uncertaintyReserve > isolation.maxUnexplainedNotional ||
            !reconciliation.quarantinedInstruments.every((symbol) =>
              isolation.instruments.includes(symbol),
            )
          ) {
            return refuse("execution_safety_reconciliation_scope_invalid");
          }
          if (
            reconciliation.quarantinedInstruments.includes(intent.instrument.trim().toUpperCase())
          ) {
            return refuse("execution_safety_instrument_quarantined");
          }
          uncertaintyReserve = reconciliation.uncertaintyReserve;
        } else if (
          reconciliation.status !== "ready" ||
          reconciliation.historyStatus !== "reconciled" ||
          reconciliation.uncertaintyReserve !== 0 ||
          reconciliation.quarantinedInstruments.length
        ) {
          return refuse("execution_safety_reconciliation_scope_invalid");
        }
      }

      const reservedSellQuantity = facts.reservedSellQuantity ?? 0;
      if (
        !Number.isFinite(reservedSellQuantity) ||
        reservedSellQuantity < 0 ||
        reservedSellQuantity > facts.positionQuantity ||
        (intent.side === "sell" &&
          intent.quantity > facts.positionQuantity - reservedSellQuantity &&
          !(
            params.supportsProtectedReduction === true &&
            params.venue === "alpaca:paper" &&
            facts.protectiveOrders?.length === 1 &&
            facts.protectiveOrders[0].quantity === facts.positionQuantity &&
            reservedSellQuantity === facts.positionQuantity
          ))
      ) {
        return refuse(
          "execution_safety_protection_change_requires_terminal_cancel_and_fresh_position",
        );
      }
      const reducing = intent.side === "sell" && intent.quantity <= facts.positionQuantity;
      if (intent.side === "sell" && !reducing) {
        return refuse("execution_safety_spot_cannot_open_or_cross_short");
      }
      const notional =
        intent.quantity *
        Math.max(intent.referencePrice, intent.limitPrice ?? intent.referencePrice);
      const targetAuthorization = intent.targetWeightAuthorization;
      if (targetAuthorization !== undefined) {
        if (
          !Number.isFinite(targetAuthorization.targetWeight) ||
          targetAuthorization.targetWeight < 0 ||
          targetAuthorization.targetWeight > 1 ||
          !Number.isFinite(targetAuthorization.driftBandFraction) ||
          targetAuthorization.driftBandFraction < 0 ||
          targetAuthorization.driftBandFraction > 1 ||
          !Number.isFinite(targetAuthorization.maxOrderNotional) ||
          targetAuthorization.maxOrderNotional < 0 ||
          !positive(facts.account.equity) ||
          !positive(facts.quote.price)
        ) {
          return refuse("execution_safety_target_weight_authorization_invalid");
        }
        const targetValue = targetAuthorization.targetWeight * facts.account.equity;
        const currentValue = facts.positionQuantity * facts.quote.price;
        const signedGap = targetValue - currentValue;
        if (
          !Number.isFinite(targetValue) ||
          !Number.isFinite(currentValue) ||
          !Number.isFinite(signedGap)
        ) {
          return refuse("execution_safety_target_weight_authorization_invalid");
        }
        const expectedSide = signedGap > 0 ? "buy" : signedGap < 0 ? "sell" : undefined;
        const outsideBand = Math.max(
          0,
          Math.abs(signedGap) - targetAuthorization.driftBandFraction * facts.account.equity,
        );
        const freshNotionalCeiling = Math.min(outsideBand, targetAuthorization.maxOrderNotional);
        if (expectedSide !== intent.side || freshNotionalCeiling <= 0) {
          return refuse("execution_safety_target_weight_drift_no_longer_authorizes_side");
        }
        if (notional > freshNotionalCeiling + 0.01) {
          return refuse("execution_safety_target_weight_drift_authorization_exceeded");
        }
      }
      const exposureIssue = financeExecutionGrossExposureIssue({
        grossExposure: facts.account.grossExposure,
        maxGrossExposure: policy.maxGrossExposure,
        notional,
        uncertaintyReserve,
        reducing,
      });
      if (exposureIssue) {
        return refuse(exposureIssue);
      }
      if (!reducing) {
        if (
          !positive(facts.account.equity - uncertaintyReserve) ||
          !positive(facts.account.peakEquity) ||
          facts.account.peakEquity < facts.account.equity ||
          !Number.isFinite(facts.account.availableCash) ||
          facts.account.availableCash - uncertaintyReserve < notional ||
          !positive(policy.maxPortfolioDrawdownFraction) ||
          policy.maxPortfolioDrawdownFraction > 1
        ) {
          return refuse("execution_safety_funding_and_survival_facts_required");
        }
        if (
          (facts.account.peakEquity - facts.account.equity + uncertaintyReserve) /
            facts.account.peakEquity >=
          policy.maxPortfolioDrawdownFraction
        ) {
          return refuse("execution_safety_authorized_drawdown_halt");
        }
        if (
          !positive(budget.maxOrderNotional) ||
          !positive(budget.maxInstrumentNotional) ||
          !Number.isSafeInteger(budget.maxOrdersPerRun) ||
          (budget.maxOrdersPerRun ?? 0) <= 0
        ) {
          return refuse("execution_safety_increase_requires_complete_budget");
        }
      }
      const runClaims = [...latest.values()].filter(
        (claim) => claim.run === intent.runAuthorizationId,
      );
      const instrumentUsed = runClaims
        .filter((claim) => claim.instrument === intent.instrument.trim().toUpperCase())
        .reduce((sum, claim) => sum + claim.notional, 0);
      if (
        (budget.maxOrderNotional !== undefined && notional > budget.maxOrderNotional) ||
        (!reducing &&
          budget.maxInstrumentNotional !== undefined &&
          Math.max(
            instrumentUsed,
            facts.positionQuantity *
              Math.max(intent.referencePrice, intent.limitPrice ?? intent.referencePrice),
          ) +
            notional >
            budget.maxInstrumentNotional) ||
        (budget.maxOrdersPerRun !== undefined && runClaims.length + 1 > budget.maxOrdersPerRun)
      ) {
        return refuse("execution_safety_durable_budget_exceeded");
      }
      signal.throwIfAborted();
      const claim: FinanceExecutionSafetyClaim = {
        id,
        run: intent.runAuthorizationId,
        instrument: intent.instrument.trim().toUpperCase(),
        notional,
        snapshotId: facts.snapshotId,
        at: new Date().toISOString(),
        status: "reserved",
        binding: {
          accountId: binding.accountId,
          adapterId: binding.adapterId,
          venue: binding.venue,
          intent,
          policy,
          budget,
          ...(facts.reconciliation ? { reconciliation: facts.reconciliation } : {}),
          ...(facts.protectiveOrders
            ? { protectiveOrders: facts.protectiveOrders, positionQuantity: facts.positionQuantity }
            : {}),
        },
      };
      failureStage = "reservation";
      failureOperation = "reserve_execution_claim";
      await appendJournal(key, claim);
      try {
        signal.throwIfAborted();
        const fill = await bounded(
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            const dispatchAt = Date.now();
            if (
              !fresh(facts.observedAt, facts.expiresAt, dispatchAt) ||
              !fresh(facts.quote.observedAt, facts.quote.expiresAt, dispatchAt) ||
              !ageOkay(facts.observedAt, policy.maxAccountAgeMs, dispatchAt) ||
              !ageOkay(facts.quote.observedAt, policy.maxQuoteAgeMs, dispatchAt) ||
              !ageOkay(instrumentEvidence.observedAt, policy.maxInstrumentEvidenceAgeMs, dispatchAt)
            ) {
              throw new FinanceExecutionSafetyDispatchError({ executionStage: "pre_dispatch" });
            }
            attemptPhase = "execute";
            failureStage = "execution";
            failureOperation = "execute_order";
            return params.execute(signal, facts);
          }),
          signal,
        );
        if (params.adapterKind === "venue" && !fill.terminalOrderIdentity?.terminal) {
          throw new Error("venue terminal order identity not observed");
        }
        attemptPhase = "receipt";
        failureStage = "receipt";
        failureOperation = "record_execution_receipt";
        const recordedAt = params.recordedAt ?? new Date().toISOString();
        const receipt = structuredClone(params.buildReceipt(fill, recordedAt, binding.accountId));
        await appendJournal(key, {
          ...claim,
          at: new Date().toISOString(),
          status: "confirmed",
          fill,
          adapterKind: params.adapterKind,
          receipt,
          receiptIdentityVersion: "account-v1",
        });
        return { ok: true, fill, receipt };
      } catch (error) {
        const baseAttempt: FinanceExecutionSafetyAttempt =
          attemptPhase !== "receipt" && error instanceof FinanceExecutionSafetyDispatchError
            ? Object.freeze({
                phase: error.executionStage === "pre_dispatch" ? "not_started" : "execute",
                disposition:
                  error.executionStage === "pre_dispatch"
                    ? "not_started"
                    : error.executionStage === "venue_response"
                      ? "definite_rejection"
                      : "outcome_unresolved",
                ...(error.executionStage === "venue_response"
                  ? {
                      venueResponse: Object.freeze({
                        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
                        ...(error.brokerCode === undefined ? {} : { brokerCode: error.brokerCode }),
                      }),
                    }
                  : {}),
              })
            : Object.freeze({
                phase: attemptPhase,
                disposition: attemptPhase === "not_started" ? "not_started" : "outcome_unresolved",
              });
        const attempt: FinanceExecutionSafetyAttempt =
          error instanceof FinanceProtectedReductionError
            ? Object.freeze({ ...baseAttempt, protectedReduction: error.diagnostic })
            : baseAttempt;
        failureStage =
          attempt.phase === "not_started"
            ? "reservation"
            : attempt.phase === "receipt"
              ? "receipt"
              : "execution";
        failureOperation =
          attempt.phase === "not_started"
            ? "reserve_execution_claim"
            : attempt.phase === "receipt"
              ? "record_execution_receipt"
              : "execute_order";
        const terminalStatus =
          error instanceof FinanceExecutionSafetyDispatchError &&
          error.executionStage === "pre_dispatch" &&
          attempt.phase === "not_started" &&
          attempt.disposition === "not_started"
            ? "not_started"
            : error instanceof FinanceExecutionSafetyDispatchError &&
                error.executionStage === "venue_response" &&
                attempt.phase === "execute" &&
                attempt.disposition === "definite_rejection"
              ? "rejected"
              : undefined;
        await appendJournal(key, {
          ...claim,
          at: new Date().toISOString(),
          status: terminalStatus ?? "unknown",
          failure: attempt,
        }).catch(() => {
          // The original reservation remains the account-level blocker if this append fails.
          throw new FinanceExecutionSafetyUncertainError(id, error, attempt);
        });
        if (terminalStatus) {
          throw new FinanceExecutionSafetyTerminalFailureError(id, terminalStatus, attempt, error);
        }
        throw new FinanceExecutionSafetyUncertainError(id, error, attempt);
      }
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof FinanceExecutionSafetyUncertainError) {
      throw error;
    }
    if (error instanceof FinanceExecutionSafetyTerminalFailureError) {
      throw error;
    }
    if (signal.aborted) {
      return refuse("execution_safety_cancelled_or_expired", {
        stage: failureStage,
        category: "cancelled_or_expired",
        operation: failureOperation,
      });
    }
    if (error instanceof FinanceExecutionSafetyFactsError) {
      return refuse(
        `execution_safety_${error.category}${error.provider ? `:${error.provider.reason}${error.provider.stage ? `:${error.provider.stage}` : ""}` : ""}`,
        {
          stage: failureStage,
          category: error.category,
          operation: failureOperation,
          ...(error.provider ? { provider: { ...error.provider } } : {}),
        },
      );
    }
    return refuse(`execution_safety_${failureStage}_unavailable`, {
      stage: failureStage,
      category: "unexpected",
      operation: failureOperation,
    });
  } finally {
    clearTimeout(timer);
    releaseQueue?.();
    if (key && tail) {
      const queuedKey = key;
      const queuedTail = tail;
      void queuedTail.then(() => {
        if (queues.get(queuedKey) === queuedTail) {
          queues.delete(queuedKey);
        }
      });
    }
  }
}

/** Read one append-only snapshot. A concurrent partial append makes parsing fail closed.
 * This never edits claims or grants reconciliation authority. */
export async function readFinanceExecutionSafetyClaims(params: {
  stateDir: string;
  accountId: string;
  venue: string;
  signal?: AbortSignal;
}): Promise<readonly FinanceExecutionSafetyClaim[]> {
  params.signal?.throwIfAborted();
  const root = await fs.realpath(params.stateDir);
  const file = path.join(
    root,
    `execution-safety-${digest([params.venue, params.accountId])}.jsonl`,
  );
  const handle = await fs.open(file, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    return [];
  }
  try {
    const max = 16 * 1024 * 1024;
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      params.signal?.throwIfAborted();
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) {
        break;
      }
      size += read.bytesRead;
    }
    params.signal?.throwIfAborted();
    if (size > max) {
      throw new Error("execution safety journal too large for bounded recovery");
    }
    const raw = buffer.subarray(0, size).toString("utf8");
    if (raw && !raw.endsWith("\n")) {
      throw new Error("incomplete execution safety journal snapshot");
    }
    const values = parseJournal(raw);
    const latest = new Map<string, FinanceExecutionSafetyClaim>();
    for (const claim of values) {
      // Delete before setting so order reflects each id's last durable append, not its first reserve.
      latest.delete(claim.id);
      latest.set(claim.id, claim);
    }
    return [...latest.values()];
  } finally {
    await handle.close();
  }
}

/**
 * Operator-only retirement of one explicitly authorized Paper pending claim.
 * This appends an audit marker; it never represents broker cancellation or fill.
 */
export async function retireFinancePaperExecutionClaim(params: {
  stateDir: string;
  accountId: string;
  claimId: string;
  authorizationRef: string;
  reason: string;
  brokerObservationRef: string;
  expectedJournalHash: string;
  signal?: AbortSignal;
}): Promise<Readonly<{ retired: true; alreadyRetired: boolean; journalHash: string }>> {
  if (
    !text(params.accountId) ||
    !text(params.claimId) ||
    !text(params.authorizationRef) ||
    params.authorizationRef.length > 500 ||
    !text(params.reason) ||
    params.reason.length > 1000 ||
    !/^(?:sha256:)?[a-f0-9]{64}$/.test(params.brokerObservationRef) ||
    !/^[a-f0-9]{64}$/.test(params.expectedJournalHash)
  ) {
    throw new Error("invalid Paper execution retirement proof");
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(params.signal ? [params.signal] : []),
  ]);
  signal.throwIfAborted();
  const root = await fs.realpath(params.stateDir);
  const accountKey = digest(["alpaca:paper", params.accountId]);
  const registeredRoot = accountRoots.get(accountKey);
  if (registeredRoot !== undefined && registeredRoot !== root) {
    throw new Error("execution safety account root conflict");
  }
  accountRoots.set(accountKey, root);
  const file = path.join(root, `execution-safety-${accountKey}.jsonl`);
  const prior = queues.get(file) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const own = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = prior.then(() => own);
  queues.set(file, tail);
  try {
    await bounded(prior, signal);
    signal.throwIfAborted();
    const lock = await acquireFileLock(file, {
      stale: Infinity,
      retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      let raw: string;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("Paper execution retirement claim not found", { cause: error });
        }
        throw new Error("Paper execution retirement journal unavailable", { cause: error });
      }
      const journalHash = createHash("sha256").update(raw).digest("hex");
      if (journalHash !== params.expectedJournalHash) {
        throw new Error("Paper execution retirement journal conflict");
      }
      const journal = parseJournal(raw);
      const latest = new Map<string, FinanceExecutionSafetyClaim>();
      for (const claim of journal) {
        latest.delete(claim.id);
        latest.set(claim.id, claim);
      }
      const claim = latest.get(params.claimId);
      if (!claim?.binding || claim.binding.accountId !== params.accountId) {
        throw new Error("Paper execution retirement claim not found");
      }
      if (claim.status === "operator_retired") {
        const proof = claim.operatorRetirement;
        if (
          proof?.authorizedBy === "user" &&
          proof.authorizationRef === params.authorizationRef &&
          proof.reason === params.reason &&
          proof.brokerObservationRef === params.brokerObservationRef
        ) {
          return { retired: true, alreadyRetired: true, journalHash };
        }
        throw new Error("Paper execution claim already retired under different proof");
      }
      if (
        (claim.status !== "reserved" && claim.status !== "unknown") ||
        claim.adapterKind !== undefined ||
        claim.binding.venue !== "alpaca:paper" ||
        claim.id !==
          digest([
            claim.binding.accountId,
            claim.binding.venue,
            claim.binding.intent.runAuthorizationId,
            claim.binding.intent.intentId,
          ])
      ) {
        throw new Error("Paper execution retirement claim is not eligible");
      }
      const { failure: _failure, fill: _fill, receipt: _receipt, ...base } = claim;
      const at = new Date().toISOString();
      const retired: FinanceExecutionSafetyClaim = {
        ...base,
        at,
        status: "operator_retired",
        operatorRetirement: {
          authorizedBy: "user",
          authorizationRef: params.authorizationRef,
          reason: params.reason,
          brokerObservationRef: params.brokerObservationRef,
          retiredAt: at,
          originalStatus: claim.status,
        },
      };
      await appendJournal(file, retired);
      return {
        retired: true,
        alreadyRetired: false,
        journalHash: createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex"),
      };
    } finally {
      await lock.release();
    }
  } finally {
    releaseQueue();
    void tail.then(() => {
      if (queues.get(file) === tail) {
        queues.delete(file);
      }
    });
  }
}

/** Journal data is untrusted at runtime, even when its static claim type is valid.
 * Validate before a resolver can mistake malformed protection for free inventory. */
function validRecoveryProtection(binding: NonNullable<FinanceExecutionSafetyClaim["binding"]>) {
  const { protectiveOrders, positionQuantity, intent } = binding;
  if (protectiveOrders === undefined) {
    // Historical ordinary claims have neither field. Do not reinterpret a detached
    // position snapshot as a claim without protection metadata.
    return positionQuantity === undefined;
  }
  if (
    !Array.isArray(protectiveOrders) ||
    typeof positionQuantity !== "number" ||
    !Number.isFinite(positionQuantity) ||
    positionQuantity < 0 ||
    !positive(intent.quantity) ||
    (intent.side === "sell" && intent.quantity > positionQuantity)
  ) {
    return false;
  }
  const ids = new Set<string>();
  let reserved = 0;
  for (const order of protectiveOrders) {
    if (
      !order ||
      typeof order !== "object" ||
      Array.isArray(order) ||
      !text(order.id) ||
      ids.has(order.id) ||
      !positive(order.quantity) ||
      !positive(order.stopPrice) ||
      ![undefined, "stop", "stop_limit"].includes(order.orderType) ||
      ((order.orderType ?? "stop") === "stop" && order.limitPrice !== undefined) ||
      (order.orderType === "stop_limit" &&
        (!positive(order.limitPrice) || order.limitPrice > order.stopPrice))
    ) {
      return false;
    }
    ids.add(order.id);
    reserved += order.quantity;
  }
  if (!Number.isFinite(reserved) || reserved > positionQuantity) {
    return false;
  }
  // The dispatch gate only admits a protected sell against one whole-position stop.
  return (
    intent.side !== "sell" ||
    intent.quantity <= positionQuantity - reserved ||
    (protectiveOrders.length === 1 && protectiveOrders[0].quantity === positionQuantity)
  );
}

/** Controller-only broker reconciliation under the same lock as order dispatch.
 * No callback result means unresolved, never permission to resend the order. */
export async function reconcileFinanceExecutionClaims(params: {
  stateDir: string;
  accountId: string;
  venue: string;
  signal?: AbortSignal;
  resolve: (
    claim: Readonly<FinanceExecutionSafetyClaim>,
    signal: AbortSignal,
  ) => Promise<FinanceExecutionFill | undefined>;
}) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(params.signal ? [params.signal] : []),
  ]);
  signal.throwIfAborted();
  const root = await fs.realpath(params.stateDir);
  const accountKey = digest([params.venue, params.accountId]);
  const registeredRoot = accountRoots.get(accountKey);
  if (registeredRoot !== undefined && registeredRoot !== root) {
    throw new Error("execution safety account root conflict");
  }
  accountRoots.set(accountKey, root);
  const file = path.join(root, `execution-safety-${accountKey}.jsonl`);
  const prior = queues.get(file) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const own = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = prior.then(() => own);
  queues.set(file, tail);
  try {
    await bounded(prior, signal);
    signal.throwIfAborted();
    const lock = await acquireFileLock(file, {
      stale: Infinity,
      retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    const result = { confirmed: [] as string[], unresolved: [] as string[] };
    try {
      const claims = await readFinanceExecutionSafetyClaims(params);
      for (const claim of claims) {
        signal.throwIfAborted();
        if (
          claim.status === "confirmed" ||
          claim.status === "not_started" ||
          claim.status === "rejected" ||
          claim.status === "operator_retired"
        ) {
          continue;
        }
        const binding = claim.binding;
        if (
          !binding ||
          binding.accountId !== params.accountId ||
          binding.venue !== params.venue ||
          !validRecoveryProtection(binding) ||
          claim.id !==
            digest([
              binding.accountId,
              binding.venue,
              binding.intent.runAuthorizationId,
              binding.intent.intentId,
            ])
        ) {
          result.unresolved.push(claim.id);
          continue;
        }
        // Clone before handing a claim to an adapter so it cannot rewrite authority.
        const fill = await bounded(
          Promise.resolve().then(() => params.resolve(structuredClone(claim), signal)),
          signal,
        );
        signal.throwIfAborted();
        if (!fill) {
          result.unresolved.push(claim.id);
          continue;
        }
        if (
          fill.terminalOrderIdentity?.terminal !== true ||
          !text(fill.terminalOrderIdentity.orderId) ||
          !Number.isFinite(fill.filledQuantity) ||
          fill.filledQuantity < 0 ||
          fill.filledQuantity > binding.intent.quantity ||
          !Number.isFinite(fill.fillPrice) ||
          fill.fillPrice < 0 ||
          (fill.filledQuantity > 0 && fill.fillPrice <= 0) ||
          !Number.isFinite(Date.parse(fill.filledAt)) ||
          !text(fill.venueRef)
        ) {
          throw new Error("invalid reconciled terminal fill");
        }
        const { buildFinanceExecutionReceipt } = await import("./finance-execution-adapter.js");
        const at = new Date().toISOString();
        const receipt = buildFinanceExecutionReceipt({
          intent: binding.intent,
          adapter: { id: binding.adapterId, venue: binding.venue, kind: "venue" },
          fill,
          recordedAt: at,
          accountId: binding.accountId,
          identityVersion: "account-v1",
        });
        await appendJournal(file, {
          ...claim,
          at,
          status: "confirmed",
          fill,
          adapterKind: "venue",
          receipt,
          receiptIdentityVersion: "account-v1",
        });
        result.confirmed.push(claim.id);
      }
      return result;
    } finally {
      await lock.release();
    }
  } finally {
    releaseQueue();
    void tail.then(() => {
      if (queues.get(file) === tail) {
        queues.delete(file);
      }
    });
  }
}
