/**
 * The cost and risk paths the liquidation model does not cover.
 *
 * `liquidation.ts` answers "does the short leg survive?". Three things can still
 * kill or erode the trade, and all three were previously listed as unmodelled:
 *
 * 1. Spot-leg leverage. The base model assumes the spot leg is fully paid. Lever
 *    it and a *price fall* liquidates that leg -- the second liquidation path,
 *    and the one that bites in a bear market.
 * 2. Collateral movement. Keeping a cross-margin book alive means topping up the
 *    perp margin as the buffer drains. Each transfer costs, and the number of
 *    transfers is a property of the path, not of the endpoint.
 * 3. Hedge rebalancing. A delta-neutral book drifts out of neutral and has to be
 *    rebalanced. Each rebalance pays the spread.
 *
 * Every figure is per unit of notional, matching the rest of the module set.
 */

// ---------------------------------------------------------------- spot leg

export type SpotLegOptions = {
  /** 1 = fully paid. 2 = 2x leverage. */
  spotLeverage: number;
  maintenanceMarginRate: number;
};

export type SpotLegRisk = {
  spotLeverage: number;
  /** Worst fall of the price series from its running peak, as a negative ratio. */
  worstSpotDrop: number;
  /** Price fall that liquidates the levered spot leg. */
  liquidationDrop: number;
  liquidated: boolean;
  /** Highest spot leverage that would have survived the measured window. */
  maxSafeLeverage: number;
};

export const DEFAULT_SPOT_LEG_OPTIONS: SpotLegOptions = {
  spotLeverage: 1,
  maintenanceMarginRate: 0.005,
};

/**
 * Risk of the long spot leg.
 *
 * `priceCloses` is the price path over the holding window. The caller passes the
 * perp series, which stands in for the spot path: the measured basis is a few
 * basis points, so the two price paths are the same for this purpose. That is a
 * deliberate approximation and it is stated rather than hidden.
 */
export function assessSpotLeg(
  priceCloses: readonly number[],
  opts: Partial<SpotLegOptions> = {},
): SpotLegRisk {
  const { spotLeverage, maintenanceMarginRate } = { ...DEFAULT_SPOT_LEG_OPTIONS, ...opts };
  const valid = priceCloses.filter((c) => Number.isFinite(c) && c > 0);

  // Liquidation for a levered long: the loss equals the posted margin less the
  // maintenance requirement, i.e. a fall of (1/L - mmr).
  const liquidationDrop = 1 / spotLeverage - maintenanceMarginRate;

  if (valid.length < 2) {
    return {
      spotLeverage,
      worstSpotDrop: Number.NaN,
      liquidationDrop,
      liquidated: false,
      maxSafeLeverage: Number.NaN,
    };
  }

  let peak = valid[0];
  let worstDrop = 0;
  for (const c of valid) {
    peak = Math.max(peak, c);
    worstDrop = Math.min(worstDrop, c / peak - 1);
  }

  const depth = Math.abs(worstDrop);
  // Survive the worst fall with the maintenance margin still intact.
  const maxSafeLeverage =
    depth + maintenanceMarginRate >= 1 ? 1 : 1 / (depth + maintenanceMarginRate);

  return {
    spotLeverage,
    worstSpotDrop: worstDrop,
    liquidationDrop,
    liquidated: depth >= liquidationDrop,
    maxSafeLeverage,
  };
}

// ---------------------------------------------------- transfer + rebalance

export type CarryCostOptions = {
  /** Basis points paid each time collateral crosses between legs. */
  collateralTransferCostBps: number;
  /** Buffer ratio below which the operator must top the perp margin up. */
  topUpThreshold: number;
  /** Basis points paid each time the hedge is rebalanced. */
  rebalanceSlippageBps: number;
  /** Hedge drift (fraction of notional) that triggers a rebalance. */
  driftBand: number;
};

export const DEFAULT_CARRY_COST_OPTIONS: CarryCostOptions = {
  collateralTransferCostBps: 2,
  topUpThreshold: 0.25,
  rebalanceSlippageBps: 5,
  driftBand: 0.05,
};

export type CarryCosts = {
  /** Times the perp margin buffer fell through the top-up threshold. */
  collateralTransfers: number;
  collateralTransferCost: number;
  /** Times the hedge drifted outside the band and had to be rebalanced. */
  rebalances: number;
  rollSlippageCost: number;
  /** Both costs together, per unit notional, over the window. */
  totalCost: number;
  /** The same cost expressed as a drag on the annualised return. */
  annualisedDrag: number;
};

export type CostPathPoint = {
  perpClose: number;
  spotPrice: number;
  funding: number;
};

export function assessCarryCosts(
  points: readonly CostPathPoint[],
  opts: Partial<CarryCostOptions> = {},
  marginRatio = 0.5,
  maintenanceMarginRate = 0.005,
  windowDays = 365,
): CarryCosts {
  const cfg = { ...DEFAULT_CARRY_COST_OPTIONS, ...opts };
  const empty: CarryCosts = {
    collateralTransfers: 0,
    collateralTransferCost: 0,
    rebalances: 0,
    rollSlippageCost: 0,
    totalCost: 0,
    annualisedDrag: 0,
  };
  if (points.length < 2) {
    return empty;
  }

  const perp0 = points[0].perpClose;
  const spot0 = points[0].spotPrice;
  let fundingCum = 0;
  let inTopUp = false;
  let transfers = 0;

  for (const p of points) {
    fundingCum += p.funding;
    const perpMove = p.perpClose / perp0 - 1;
    const spotGain = p.spotPrice / spot0 - 1;
    // Same cross-margin equity as liquidation.ts: the spot gain collateralises.
    const equity = marginRatio + Math.max(0, spotGain) + fundingCum - perpMove;
    const buffer = equity - maintenanceMarginRate;

    // Count a transfer when the buffer enters the top-up zone, not on every
    // point spent inside it -- an operator tops up once, then waits.
    if (buffer < cfg.topUpThreshold) {
      if (!inTopUp) {
        transfers += 1;
        inTopUp = true;
      }
    } else if (buffer > cfg.topUpThreshold * 1.5) {
      inTopUp = false;
    }
  }

  // Hedge drift: the short perp and the long spot are different instruments, so
  // their notionals diverge by the basis. Count band crossings, not magnitude.
  let rebalances = 0;
  let lastDrift = 0;
  for (const p of points) {
    const drift = Math.abs(p.perpClose / p.spotPrice - 1);
    if (Math.abs(drift - lastDrift) >= cfg.driftBand) {
      rebalances += 1;
      lastDrift = drift;
    }
  }

  const collateralTransferCost = transfers * (cfg.collateralTransferCostBps / 10_000);
  const rollSlippageCost = rebalances * (cfg.rebalanceSlippageBps / 10_000);
  const totalCost = collateralTransferCost + rollSlippageCost;
  const years = Math.max(windowDays / 365, 1 / 365);

  return {
    collateralTransfers: transfers,
    collateralTransferCost,
    rebalances,
    rollSlippageCost,
    totalCost,
    annualisedDrag: totalCost / years,
  };
}
