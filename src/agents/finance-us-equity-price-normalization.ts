/** Deterministic price normalization for explicitly classified US equities and ETFs. */
export const US_EQUITY_PRICE_POLICY_VERSION = "alpaca_us_equity_stop_precision_v1" as const;

export type UsEquityPriceNormalizationProvenance = Readonly<{
  policyVersion: typeof US_EQUITY_PRICE_POLICY_VERSION;
  instrument: string;
  original: Readonly<{ entryPrice: number; stopPrice: number; targetPrice?: number }>;
  normalized: Readonly<{ entryPrice: number; stopPrice: number; targetPrice?: number }>;
  rewardRisk?: number;
}>;

export type NormalizeUsEquityProtectionPricesInput = Readonly<{
  instrument: string;
  assetClass: "us_equity" | "etf";
  side: "buy";
  entryPrice: number;
  stopPrice: number;
  targetPrice?: number;
  rewardRisk?: number;
}>;

export type NormalizeUsEquityProtectionPricesResult = Readonly<
  | {
      ok: true;
      stopPrice: number;
      targetPrice?: number;
      provenance: UsEquityPriceNormalizationProvenance;
    }
  | { ok: false; refusal: string }
>;

function tick(price: number): number {
  return price < 1 ? 0.0001 : 0.01;
}

function roundUpToTick(price: number): number {
  let normalized =
    Math.ceil((price - Number.EPSILON * Math.max(1, Math.abs(price)) * 4) / tick(price)) *
    tick(price);
  if (normalized >= 1 && price < 1) {
    normalized = Math.ceil((normalized - Number.EPSILON * 4) / 0.01) * 0.01;
  }
  return Number(normalized.toFixed(normalized < 1 ? 4 : 2));
}

export function isLegalUsEquityPrice(price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) {
    return false;
  }
  const scale = price < 1 ? 10_000 : 100;
  const scaled = price * scale;
  return (
    Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4
  );
}

/** Alpaca advanced-order stop-loss legs require at least one cent of clearance. */
export function isValidAlpacaLongStopDistance(stopPrice: number, referencePrice: number): boolean {
  if (!Number.isFinite(stopPrice) || !Number.isFinite(referencePrice) || stopPrice <= 0) {
    return false;
  }
  const clearance = referencePrice - stopPrice;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(referencePrice), Math.abs(stopPrice)) * 4;
  return clearance + epsilon >= 0.01;
}

export function normalizeUsEquityProtectionPrices(
  input: NormalizeUsEquityProtectionPricesInput,
): NormalizeUsEquityProtectionPricesResult {
  const instrument = input.instrument.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/u.test(instrument)) {
    return { ok: false, refusal: "US-equity price policy requires a plain US equity/ETF symbol" };
  }
  if (
    input.side !== "buy" ||
    !Number.isFinite(input.entryPrice) ||
    input.entryPrice <= 0 ||
    !Number.isFinite(input.stopPrice) ||
    input.stopPrice <= 0 ||
    input.stopPrice >= input.entryPrice
  ) {
    return { ok: false, refusal: "long protection requires finite prices with 0 < stop < entry" };
  }
  if (
    input.targetPrice !== undefined &&
    (!Number.isFinite(input.targetPrice) || input.targetPrice <= input.entryPrice)
  ) {
    return { ok: false, refusal: "long target must be finite and above entry" };
  }
  const rewardRisk =
    input.targetPrice === undefined
      ? input.rewardRisk
      : (input.targetPrice - input.entryPrice) / (input.entryPrice - input.stopPrice);
  if (input.targetPrice !== undefined && (!Number.isFinite(rewardRisk) || rewardRisk! <= 0)) {
    return { ok: false, refusal: "target and stop do not define a positive reward/risk ratio" };
  }
  const stopPrice = roundUpToTick(input.stopPrice);
  if (!isLegalUsEquityPrice(stopPrice) || stopPrice >= input.entryPrice) {
    return { ok: false, refusal: "upward stop tick normalization crosses or reaches entry" };
  }
  const targetPrice =
    rewardRisk === undefined
      ? undefined
      : roundUpToTick(input.entryPrice + (input.entryPrice - stopPrice) * rewardRisk);
  if (
    targetPrice !== undefined &&
    (!isLegalUsEquityPrice(targetPrice) || targetPrice <= input.entryPrice)
  ) {
    return { ok: false, refusal: "upward target tick normalization is invalid or crosses entry" };
  }
  const provenance: UsEquityPriceNormalizationProvenance = Object.freeze({
    policyVersion: US_EQUITY_PRICE_POLICY_VERSION,
    instrument,
    original: Object.freeze({
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      ...(input.targetPrice === undefined ? {} : { targetPrice: input.targetPrice }),
    }),
    normalized: Object.freeze({
      entryPrice: input.entryPrice,
      stopPrice,
      ...(targetPrice === undefined ? {} : { targetPrice }),
    }),
    ...(rewardRisk === undefined ? {} : { rewardRisk }),
  });
  return {
    ok: true,
    stopPrice,
    ...(targetPrice === undefined ? {} : { targetPrice }),
    provenance,
  };
}
