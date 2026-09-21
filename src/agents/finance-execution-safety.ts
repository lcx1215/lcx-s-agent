import type {
  FinanceExecutionIntent,
  FinanceOrderSide,
  FinanceRiskBudget,
} from "./finance-execution-adapter.js";

export type FinanceExecutionSafetyFacts = Readonly<{
  snapshotId: string;
  source: string;
  observedAt: string;
  expiresAt: string;
  /** Exact last confirmed claim included in this fresh account snapshot. */
  reconciledThroughClaimId?: string;
  positionQuantity: number;
  openOrderIds: readonly string[];
  unresolvedOrderIds: readonly string[];
  account: Readonly<{
    status: string;
    tradingBlocked: boolean;
    equity: number;
    peakEquity: number;
  }>;
  quote: Readonly<{ source: string; price: number; observedAt: string; expiresAt: string }>;
}>;
export type FinanceExecutionSafetyPolicy = Readonly<{
  planId: string;
  revision: string;
  riskModel: "fully_funded_unhedged_spot";
  authorizedSide: FinanceOrderSide;
  authorizedQuantity: number;
  expiresAt: string;
  maxPortfolioDrawdownFraction: number;
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
  readFacts: () => Promise<FinanceExecutionSafetyFacts | undefined>;
}>;
