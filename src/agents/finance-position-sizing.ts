/** Whole-unit sizing for one explicit entry scenario; never an execution authorization. */
export function calculateFinancePositionSize(params: {
  side: "buy" | "sell";
  entryPrice: number;
  stopPrice: number;
  riskBudget: number;
  maxNotional?: number;
  roundTripCostPerUnit?: number;
  fixedCosts?: number;
}) {
  for (const [name, value] of Object.entries(params)) {
    if (name === "side") {
      continue;
    }
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`${name} must be finite`);
    }
  }
  if (params.side !== "buy" && params.side !== "sell") {
    throw new Error("side must be buy or sell");
  }
  if (params.entryPrice <= 0 || params.stopPrice <= 0 || params.riskBudget <= 0) {
    throw new Error("entryPrice, stopPrice and riskBudget must be positive");
  }
  const stopDistance =
    params.side === "buy"
      ? params.entryPrice - params.stopPrice
      : params.stopPrice - params.entryPrice;
  if (stopDistance <= 0) {
    throw new Error("stop must be on the loss side of this entry");
  }
  const costPerUnit = params.roundTripCostPerUnit ?? 0;
  const fixedCosts = params.fixedCosts ?? 0;
  if (
    costPerUnit < 0 ||
    fixedCosts < 0 ||
    (params.maxNotional !== undefined && params.maxNotional < 0)
  ) {
    throw new Error("costs and maxNotional must be nonnegative");
  }
  const plannedRiskPerUnit = stopDistance + costPerUnit;
  if (!Number.isFinite(plannedRiskPerUnit)) {
    throw new Error("planned risk overflow");
  }
  const riskQuantity = Math.max(
    0,
    Math.ceil((params.riskBudget - fixedCosts) / plannedRiskPerUnit),
  );
  const capitalQuantity =
    params.maxNotional === undefined
      ? riskQuantity
      : Math.ceil(params.maxNotional / params.entryPrice);
  let quantity = Math.min(riskQuantity, capitalQuantity);
  if (!Number.isSafeInteger(quantity)) {
    throw new Error("computed quantity exceeds safe integer range");
  }
  // Check the candidate using component costs: division can round an exact whole size
  // slightly down (198 / 1.1). Only retain a rounded-up candidate if both budgets hold.
  if (
    quantity > 0 &&
    (quantity * stopDistance + quantity * costPerUnit + fixedCosts > params.riskBudget ||
      (params.maxNotional !== undefined && quantity * params.entryPrice > params.maxNotional))
  ) {
    quantity--;
  }
  const notional = quantity * params.entryPrice;
  const plannedStopLoss = quantity * stopDistance;
  const estimatedCosts = quantity > 0 ? quantity * costPerUnit + fixedCosts : 0;
  const plannedLoss = plannedStopLoss + estimatedCosts;
  if (![notional, plannedStopLoss, estimatedCosts, plannedLoss].every(Number.isFinite)) {
    throw new Error("sizing result overflow");
  }
  if (
    plannedLoss > params.riskBudget ||
    (params.maxNotional !== undefined && notional > params.maxNotional)
  ) {
    throw new Error("computed size exceeds the supplied budget");
  }
  return {
    action: "position_size",
    ...params,
    quantity,
    stopDistance,
    plannedRiskPerUnit,
    notional,
    plannedStopLoss,
    estimatedCosts,
    plannedLoss,
    costsProvided: params.roundTripCostPerUnit !== undefined || params.fixedCosts !== undefined,
    capitalLimitProvided: params.maxNotional !== undefined,
    guaranteedMaximumLoss: false,
    scope: "one_entry_scenario_whole_units_no_execution_authority",
    limitation:
      "Planned loss assumes the supplied entry and stop fill prices. Gaps, slippage and fees can exceed it. Omitted costs are excluded, not verified zero. Recalculate for every entry scenario and actual execution price.",
  };
}
