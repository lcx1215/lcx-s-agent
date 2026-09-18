/**
 * Liquidation model for a delta-neutral carry book.
 *
 * The book is long spot + short perpetual. Its *net* P&L is tiny and safe, but
 * the short leg carries margin on its own, and the margin is what gets taken
 * out. Whether the trade can die depends entirely on one operational question:
 *
 *   can the spot leg's unrealised gain be posted as perp margin?
 *
 * - If yes (cross-margin, or an operator who transfers fast enough), the short
 *   leg only has to survive the *basis* moving against it. The measured basis is
 *   ~0.03%, so the margin buffer is enormous and liquidation is not the risk.
 * - If no (isolated margin), the short leg has to survive the *outright price*
 *   rising, which over a multi-year hold it will not. The position is liquidated,
 *   and what is left is unhedged long spot -- a different, worse trade.
 *
 * Both are reported, because the difference is not a market property. It is a
 * decision about collateral, and it decides whether this trade is viable.
 *
 * All figures are per unit of notional.
 */

export type MarginPoint = {
  t: number;
  perpClose: number;
  spotPrice: number;
  /** Funding rate received by the short leg over the interval. */
  funding: number;
};

export type LiquidationOptions = {
  marginRatio: number;
  maintenanceMarginRate: number;
  collateralTransfer: boolean;
};

export type LiquidationRisk = {
  collateralTransfer: boolean;
  liquidated: boolean;
  firstLiquidationAt: string | null;
  /** Smallest (perp leg equity / notional - maintenance margin) over the path. */
  minBufferRatio: number;
  /** Margin ratio that would have been needed to never liquidate. */
  requiredMarginRatio: number;
  /** Worst adverse move of the perpetual leg, measured from entry. */
  worstAdverseMove: number;
  /** Worst adverse move of the basis, measured from entry. */
  worstBasisMove: number;
};

export const DEFAULT_LIQUIDATION_OPTIONS: LiquidationOptions = {
  marginRatio: 0.5,
  maintenanceMarginRate: 0.005,
  collateralTransfer: true,
};

export function assessLiquidation(
  points: MarginPoint[],
  opts: Partial<LiquidationOptions> = {},
): LiquidationRisk {
  const { marginRatio, maintenanceMarginRate, collateralTransfer } = {
    ...DEFAULT_LIQUIDATION_OPTIONS,
    ...opts,
  };

  if (points.length === 0) {
    return {
      collateralTransfer,
      liquidated: false,
      firstLiquidationAt: null,
      minBufferRatio: Number.NaN,
      requiredMarginRatio: Number.NaN,
      worstAdverseMove: 0,
      worstBasisMove: 0,
    };
  }

  const perp0 = points[0].perpClose;
  const spot0 = points[0].spotPrice;
  const basis0 = perp0 / spot0 - 1;

  let fundingCum = 0;
  let minBuffer = Number.POSITIVE_INFINITY;
  let requiredMargin = marginRatio;
  let worstAdverse = 0;
  let worstBasis = 0;
  let liquidated = false;
  let firstAt: string | null = null;

  for (const p of points) {
    fundingCum += p.funding;

    const perpMove = p.perpClose / perp0 - 1; // adverse for a short when positive
    const spotGain = p.spotPrice / spot0 - 1;
    const transferable = collateralTransfer ? Math.max(0, spotGain) : 0;

    // Perp leg equity, per unit notional.
    const equity = marginRatio + transferable + fundingCum - perpMove;
    const buffer = equity - maintenanceMarginRate;

    minBuffer = Math.min(minBuffer, buffer);
    worstAdverse = Math.max(worstAdverse, perpMove);
    worstBasis = Math.max(worstBasis, p.perpClose / p.spotPrice - 1 - basis0);
    requiredMargin = Math.max(
      requiredMargin,
      maintenanceMarginRate - transferable - fundingCum + perpMove,
    );

    if (buffer < 0) {
      // After liquidation the book is no longer delta-neutral, so the result
      // past this point would describe a different strategy. Stop here.
      liquidated = true;
      firstAt = new Date(p.t).toISOString();
      break;
    }
  }

  return {
    collateralTransfer,
    liquidated,
    firstLiquidationAt: firstAt,
    minBufferRatio: minBuffer,
    requiredMarginRatio: requiredMargin,
    worstAdverseMove: worstAdverse,
    worstBasisMove: worstBasis,
  };
}
