import { calculateBlackScholes } from "./tools/quant-math-tool.js";

export type GammaScalpingReplayInput = Readonly<{
  // Deliberately synthetic: no quote ingestion or broker interpretation here.
  samples: readonly Readonly<{ elapsedDays: number; spot: number; impliedVolatility: number }>[];
  strike: number;
  expiryDays: number;
  contractsPerLeg: number;
  contractMultiplier: number;
  hedgeEnabled: boolean;
  deltaBandShares: number;
  hedgeLotShares: number;
  maxHedgeShares: number;
  optionHalfSpreadPerShare: number;
  optionCommissionPerContract: number;
  stockHalfSpreadAndSlippagePerShare: number;
  stockCommissionPerShare: number;
  cashBorrowRateAnnual: number;
  shortBorrowRateAnnual: number;
}>;

function finite(value: number, label: string, minimum: number, strict = false) {
  if (!Number.isFinite(value) || (strict ? value <= minimum : value < minimum)) {
    throw new Error(`${label} must be finite and ${strict ? ">" : ">="} ${minimum}`);
  }
}

function finiteCalculation<T extends Record<string, number>>(values: T): T {
  if (!Object.values(values).every(Number.isFinite)) {
    throw new Error("replay calculation must remain finite; numeric range exceeded");
  }
  return values;
}

function validate(input: GammaScalpingReplayInput) {
  if (input.samples.length < 2 || input.samples[0].elapsedDays !== 0) {
    throw new Error("samples must start at elapsedDays=0 and contain at least two observations");
  }
  for (const key of [
    "strike",
    "expiryDays",
    "contractsPerLeg",
    "contractMultiplier",
    "hedgeLotShares",
  ] as const) {
    finite(input[key], key, 0, true);
  }
  for (const key of [
    "deltaBandShares",
    "maxHedgeShares",
    "optionHalfSpreadPerShare",
    "optionCommissionPerContract",
    "stockHalfSpreadAndSlippagePerShare",
    "stockCommissionPerShare",
    "cashBorrowRateAnnual",
    "shortBorrowRateAnnual",
  ] as const) {
    finite(input[key], key, 0);
  }
  if (
    !Number.isSafeInteger(input.contractsPerLeg) ||
    !Number.isSafeInteger(input.contractMultiplier) ||
    !Number.isSafeInteger(input.contractsPerLeg * input.contractMultiplier)
  ) {
    throw new Error("contractsPerLeg, contractMultiplier and their product must be safe integers");
  }
  if (typeof input.hedgeEnabled !== "boolean") {
    throw new Error("hedgeEnabled must be explicit");
  }
  input.samples.forEach((sample, index) => {
    finite(sample.elapsedDays, "elapsedDays", 0);
    finite(sample.spot, "spot", 0, true);
    finite(sample.impliedVolatility, "impliedVolatility", 0, true);
    if (
      sample.elapsedDays > input.expiryDays ||
      (index > 0 && sample.elapsedDays <= input.samples[index - 1].elapsedDays)
    ) {
      throw new Error("sample times must strictly increase and not exceed expiryDays");
    }
  });
}

function straddle(input: GammaScalpingReplayInput, index: number) {
  const sample = input.samples[index];
  const units = input.contractsPerLeg * input.contractMultiplier;
  const remaining = input.expiryDays - sample.elapsedDays;
  if (remaining === 0) {
    // Final intrinsic settlement; terminal Greeks are unused, not expiry estimates.
    return finiteCalculation({
      value: units * Math.abs(sample.spot - input.strike),
      delta: 0,
      gamma: 0,
      theta: 0,
      vega: 0,
    });
  }
  const common = {
    spot: sample.spot,
    strike: input.strike,
    timeToExpiryYears: remaining / 365,
    riskFreeRate: 0,
    volatility: sample.impliedVolatility,
  };
  const call = calculateBlackScholes({ ...common, optionType: "call" });
  const put = calculateBlackScholes({ ...common, optionType: "put" });
  return finiteCalculation({
    value: units * (call.price + put.price),
    delta: units * (call.delta + put.delta),
    gamma: units * (call.gamma + put.gamma),
    theta: units * (call.theta + put.theta),
    vega: units * (call.vega + put.vega),
  });
}

/** Frozen-path teaching experiment: European, no dividends, zero mark discount rate.
 * Cash borrowing and short-stock fees are explicit costs; positive cash earns zero.
 * Synthetic mid-price fills are assumptions, never executable quotes or trade signals.
 */
export function replayGammaScalping(input: GammaScalpingReplayInput) {
  validate(input);
  const units = input.contractsPerLeg * input.contractMultiplier;
  const optionTradingCost = () =>
    2 *
    (units * input.optionHalfSpreadPerShare +
      input.contractsPerLeg * input.optionCommissionPerContract);
  const initial = straddle(input, 0);
  let cash = -initial.value;
  let hedgeShares = 0;
  let optionCosts = optionTradingCost();
  let hedgeCosts = 0;
  let financingCosts = 0;
  let shortBorrowCosts = 0;
  let hedgePnl = 0;
  cash -= optionCosts;
  const attribution = { residualDelta: 0, gamma: 0, theta: 0, vega: 0, approximationResidual: 0 };
  const rows: {
    elapsedDays: number;
    spot: number;
    optionValue: number;
    optionDeltaShares: number;
    hedgeTradeShares: number;
    hedgeShares: number;
    residualDeltaShares: number;
    cash: number;
    netPnl: number;
  }[] = [];
  let previous = initial;
  for (let index = 0; index < input.samples.length; index += 1) {
    const sample = input.samples[index];
    const current = straddle(input, index);
    if (index > 0) {
      const before = input.samples[index - 1];
      const days = sample.elapsedDays - before.elapsedDays;
      const move = sample.spot - before.spot;
      const funding = (Math.max(-cash, 0) * input.cashBorrowRateAnnual * days) / 365;
      const borrow =
        (Math.max(-hedgeShares, 0) * before.spot * input.shortBorrowRateAnnual * days) / 365;
      financingCosts += funding;
      shortBorrowCosts += borrow;
      cash -= funding + borrow;
      hedgePnl += hedgeShares * move;
      const delta = (previous.delta + hedgeShares) * move;
      const gamma = 0.5 * previous.gamma * move ** 2;
      const theta = previous.theta * days; // Existing math tool reports calendar-day theta.
      const vega = previous.vega * (sample.impliedVolatility - before.impliedVolatility) * 100;
      attribution.residualDelta += delta;
      attribution.gamma += gamma;
      attribution.theta += theta;
      attribution.vega += vega;
      attribution.approximationResidual +=
        current.value - previous.value + hedgeShares * move - delta - gamma - theta - vega;
    }
    const terminal = index === input.samples.length - 1;
    let trade = 0;
    if (terminal) {
      trade = -hedgeShares;
      cash += current.value;
      // An early exit crosses both option spreads; expiry settles intrinsic instead.
      const exitCost = sample.elapsedDays < input.expiryDays ? optionTradingCost() : 0;
      optionCosts += exitCost;
      cash -= exitCost;
    } else if (
      input.hedgeEnabled &&
      (index === 0 || Math.abs(current.delta + hedgeShares) > input.deltaBandShares)
    ) {
      const target = Math.round(-current.delta / input.hedgeLotShares) * input.hedgeLotShares;
      if (Math.abs(target) > input.maxHedgeShares) {
        throw new Error(
          "rounded hedge target exceeds maxHedgeShares; replay invalid, not a clipped fill",
        );
      }
      trade = target - hedgeShares;
    }
    const cost =
      Math.abs(trade) * (input.stockHalfSpreadAndSlippagePerShare + input.stockCommissionPerShare);
    hedgeCosts += cost;
    cash -= trade * sample.spot + cost;
    hedgeShares += trade;
    rows.push(
      finiteCalculation({
        elapsedDays: sample.elapsedDays,
        spot: sample.spot,
        optionValue: current.value,
        optionDeltaShares: current.delta,
        hedgeTradeShares: trade,
        hedgeShares,
        residualDeltaShares: terminal ? 0 : current.delta + hedgeShares,
        cash,
        netPnl: cash + hedgeShares * sample.spot + (terminal ? 0 : current.value),
      }),
    );
    previous = current;
  }
  const optionMarkPnl = previous.value - initial.value;
  const totalCosts = optionCosts + hedgeCosts + financingCosts + shortBorrowCosts;
  finiteCalculation({ optionMarkPnl, hedgePnl, totalCosts, ...attribution });
  return {
    boundary: "synthetic_research_only" as const,
    executionAuthority: "none" as const,
    initialPremium: initial.value,
    optionMarkPnl,
    hedgePnl,
    optionCosts,
    hedgeCosts,
    financingCosts,
    shortBorrowCosts,
    totalCosts,
    netPnl: cash,
    attribution,
    rows,
    reconciliationResidual: cash - (optionMarkPnl + hedgePnl - totalCosts),
    limitations: [
      "Synthetic European non-dividend mid-price observations; zero discount rate; positive cash earns zero.",
      "Borrow/funding accrue simply on prior-observation exposure; no margin, tax, assignment, market impact or quote validation.",
      "Discrete Greek attribution is approximate; its residual includes higher orders and cross terms.",
      "No provider calls, broker orders, short-borrow availability or performance inference.",
    ],
  };
}
