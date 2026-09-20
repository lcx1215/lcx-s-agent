import {
  createPaperExecutionAdapter,
  placeFinanceOrder,
  type FinanceExecutionReceipt,
  type FinanceRiskBudget,
} from "./finance-execution-adapter.js";
import {
  compileExecutionIntent,
  type FinanceResearchConclusion,
} from "./finance-intent-compiler.js";
import type { FinanceStrategyClass } from "./finance-mandate.js";

/**
 * The missing call site: conclusion -> compiled intent -> paper fill -> receipt.
 *
 * Every element already existed (intake, compiler, execution adapter, paper venue) but
 * nothing chained them, so the system could judge and could execute yet never decided.
 * This wires them together and owns nothing else: no model call, no prediction, no
 * market data. Risk control stays where it belongs -- inside the compiler (sizing from a
 * declared stop) and the placement guard (declared budget caps).
 *
 * "Paper" means the fill is simulated at the intent's own reference price and labelled
 * `venueRef: paper:...`, so no downstream consumer can mistake it for a market
 * observation. It does not relax any gate: placement still requires `live_execution`
 * mode and an explicit run authorization.
 */

export const FINANCE_PAPER_ADAPTER_ID = "paper";

export type FinancePaperRunRequest = Readonly<{
  conclusion: FinanceResearchConclusion;
  /** Observed price and the time it belongs to. "Now" is never assumed. */
  market: { referencePrice: number; referencePriceAt: string };
  /** Account equity in the same currency as the reference price. */
  equity: number;
  /** The explicit authorization that admitted this run. Empty is refused. */
  runAuthorizationId: string;
  /**
   * Required, never defaulted. A budget is a boundary someone chose; inheriting one
   * silently would be the opposite of a control. An `unattended` budget must declare
   * every cap or placement refuses it.
   */
  budget: FinanceRiskBudget;
  /** Instruments the paper adapter admits. An empty list admits nothing. */
  instruments: readonly string[];
  slippageBps?: number;
  strategyClass?: FinanceStrategyClass;
  minConviction?: number;
  committedInstrumentNotional?: number;
  ordersPlacedThisRun?: number;
  recordedAt?: string;
}>;

export type FinancePaperRunResult = Readonly<
  | { ok: true; receipt: FinanceExecutionReceipt; notes: readonly string[] }
  | { ok: false; stage: "compile" | "place"; refusals: readonly string[] }
>;

export async function runFinancePaperOrder(
  request: FinancePaperRunRequest,
): Promise<FinancePaperRunResult> {
  if (request.conclusion.conclusionId.trim().length === 0) {
    return {
      ok: false,
      stage: "compile",
      refusals: Object.freeze(["refuse: conclusion needs an id; the intent id derives from it"]),
    };
  }

  const compiled = compileExecutionIntent({
    conclusion: request.conclusion,
    market: request.market,
    equity: request.equity,
    runAuthorizationId: request.runAuthorizationId,
    ...(request.strategyClass === undefined ? {} : { strategyClass: request.strategyClass }),
    ...(request.minConviction === undefined ? {} : { minConviction: request.minConviction }),
  });
  if (!compiled.ok) {
    return Object.freeze({ ok: false, stage: "compile", refusals: compiled.refusals });
  }

  const adapter = createPaperExecutionAdapter({
    id: FINANCE_PAPER_ADAPTER_ID,
    instruments: request.instruments,
    ...(request.slippageBps === undefined ? {} : { slippageBps: request.slippageBps }),
  });

  const placed = await placeFinanceOrder({
    mode: "live_execution",
    intent: compiled.intent,
    budget: request.budget,
    adapters: [adapter],
    executionAdapterId: adapter.id,
    committedInstrumentNotional: request.committedInstrumentNotional ?? 0,
    ordersPlacedThisRun: request.ordersPlacedThisRun ?? 0,
    ...(request.recordedAt === undefined ? {} : { recordedAt: request.recordedAt }),
  });

  if (placed.status !== "placed" || placed.receipt === undefined) {
    return Object.freeze({ ok: false, stage: "place", refusals: placed.refusalReasons });
  }

  return Object.freeze({
    ok: true,
    receipt: placed.receipt,
    notes: compiled.notes,
  });
}
