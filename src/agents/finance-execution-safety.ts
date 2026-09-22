import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "../plugin-sdk/file-lock.js";
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
import { stableStringify } from "./stable-stringify.js";

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
  /** Exact last confirmed claim included in this fresh account snapshot. */
  reconciledThroughClaimId?: string;
  positionQuantity: number;
  reservedSellQuantity?: number;
  protectiveOrderIds?: readonly string[];
  protectiveOrders?: readonly { id: string; quantity: number; stopPrice: number }[];
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

export class FinanceExecutionSafetyUncertainError extends Error {
  readonly code = "finance_execution_safety_unknown";
  constructor(
    readonly claimId: string,
    cause: unknown,
  ) {
    super("execution outcome unresolved; account safety claim retained until reconciliation", {
      cause,
    });
    this.name = "FinanceExecutionSafetyUncertainError";
  }
}

export type FinanceExecutionSafetyClaim = {
  id: string;
  run: string;
  instrument: string;
  notional: number;
  snapshotId: string;
  at: string;
  status: "reserved" | "confirmed" | "unknown";
  binding?: Readonly<{
    accountId: string;
    adapterId: string;
    venue: string;
    intent: FinanceExecutionIntent;
    policy: FinanceExecutionSafetyPolicy;
    budget: FinanceRiskBudget;
    reconciliation?: FinanceExecutionReconciliation;
    protectiveOrders?: readonly { id: string; quantity: number; stopPrice: number }[];
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
  return raw
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
        !["reserved", "confirmed", "unknown"].includes(value.status)
      ) {
        throw new Error("invalid execution safety journal");
      }
      return value;
    });
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
  | { ok: false; reasons: string[] }
> {
  const refuse = (reason: string) => ({ ok: false as const, reasons: [reason] });
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
  try {
    signal.throwIfAborted();
    await fs.mkdir(binding.stateDir, { recursive: true, mode: 0o700 });
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
    await bounded(prior, signal);
    signal.throwIfAborted();
    const lock = await acquireFileLock(key, {
      stale: Infinity,
      retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      signal.throwIfAborted();
      const journal = await readJournal(key);
      const latest = new Map(journal.map((claim) => [claim.id, claim]));
      if ([...latest.values()].some((claim) => claim.status !== "confirmed")) {
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
      if (
        !Number.isFinite(facts.account.grossExposure) ||
        facts.account.grossExposure < 0 ||
        !positive(policy.maxGrossExposure)
      ) {
        return refuse("execution_safety_portfolio_exposure_required");
      }
      if (
        !reducing &&
        facts.account.grossExposure + notional + uncertaintyReserve > policy.maxGrossExposure
      ) {
        return refuse("execution_safety_portfolio_exposure_exceeded");
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
              throw new Error("execution safety facts expired before dispatch");
            }
            return params.execute(signal, facts);
          }),
          signal,
        );
        if (params.adapterKind === "venue" && !fill.terminalOrderIdentity?.terminal) {
          throw new Error("venue terminal order identity not observed");
        }
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
        await appendJournal(key, {
          ...claim,
          at: new Date().toISOString(),
          status: "unknown",
        }).catch(() => undefined);
        throw new FinanceExecutionSafetyUncertainError(id, error);
      }
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof FinanceExecutionSafetyUncertainError) {
      throw error;
    }
    return refuse(
      signal.aborted
        ? "execution_safety_cancelled_or_expired"
        : "execution_safety_state_unavailable",
    );
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
    return [...new Map(values.map((claim) => [claim.id, claim])).values()];
  } finally {
    await handle.close();
  }
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
        if (claim.status === "confirmed") {
          continue;
        }
        const binding = claim.binding;
        if (
          !binding ||
          binding.accountId !== params.accountId ||
          binding.venue !== params.venue ||
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
