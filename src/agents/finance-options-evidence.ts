import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
import { calculateBlackScholes } from "./tools/quant-math-tool.js";

type Row = Readonly<Record<string, unknown>>;

function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function finiteNumber(value: unknown): number | undefined {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(candidate) ? candidate : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const candidate = finiteNumber(value);
  return candidate !== undefined && candidate > 0 ? candidate : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const ordered = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function rounded(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function dateOnly(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
    return undefined;
  }
  const parsed = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === raw
    ? raw
    : undefined;
}

function optionField(data: Row, details: Row, ...names: readonly string[]): unknown {
  for (const name of names) {
    if (details[name] !== undefined) {
      return details[name];
    }
    if (data[name] !== undefined) {
      return data[name];
    }
  }
  return undefined;
}

export type FinanceOptionGreek = Readonly<{
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}>;

export type FinanceOptionContractEvidence = Readonly<{
  ticker: string;
  contractType: "call" | "put";
  strike: number;
  expiration: string;
  timeToExpiryYears: number;
  impliedVolatility: number;
  bid: number;
  ask: number;
  mid: number;
  spreadPct: number;
  openInterest: number | null;
  greeks: FinanceOptionGreek;
  providerName: string;
  sourceTimestamp: string;
  sourceUrlOrArtifact: string;
}>;

export type FinanceOptionsChainSummary = Readonly<{
  status: "usable" | "insufficient";
  underlyingSpot: number;
  underlyingSpotAt: string;
  evaluatedContracts: number;
  invalidContracts: number;
  staleContracts: number;
  eligibleContracts: number;
  medianImpliedVolatility: number | null;
  medianSpreadPct: number | null;
  putCallOpenInterestRatio: number | null;
  openInterestWeightedGamma: number | null;
  expirations: readonly Readonly<{
    expiration: string;
    contracts: number;
    medianImpliedVolatility: number;
    openInterest: number;
  }>[];
  representatives: readonly FinanceOptionContractEvidence[];
  warnings: readonly string[];
}>;

export type FinanceOptionsChainSummaryOptions = Readonly<{
  asOf: string;
  underlyingSpot: number;
  underlyingSpotAt: string;
  futureTimestampLimitMs?: number;
  maxSpreadPct?: number;
  minOpenInterest?: number;
  riskFreeRate?: number;
}>;

/**
 * Convert a provider chain into deterministic, research-only option evidence.
 *
 * The input remains source data; only contracts with a complete quote, expiry, IV and
 * liquidity fields are passed to the existing Black-Scholes implementation. The result is
 * descriptive evidence for the model, never an order or a contract recommendation.
 */
export function summarizeFinanceOptionsChain(
  rows: readonly FinanceMarketCollectionItem[],
  options: FinanceOptionsChainSummaryOptions,
): FinanceOptionsChainSummary {
  if (!Number.isFinite(options.underlyingSpot) || options.underlyingSpot <= 0) {
    throw new Error("options evidence requires a positive underlying spot");
  }
  const asOfMs = Date.parse(options.asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error("options evidence requires a valid asOf timestamp");
  }
  const futureTimestampLimitMs = options.futureTimestampLimitMs ?? asOfMs;
  const maxSpreadPct = options.maxSpreadPct ?? 0.25;
  const minOpenInterest = options.minOpenInterest ?? 1;
  const riskFreeRate = options.riskFreeRate ?? 0;
  if (!Number.isFinite(maxSpreadPct) || maxSpreadPct < 0) {
    throw new Error("options evidence maxSpreadPct must be non-negative");
  }
  if (!Number.isFinite(minOpenInterest) || minOpenInterest < 0) {
    throw new Error("options evidence minOpenInterest must be non-negative");
  }
  if (!Number.isFinite(riskFreeRate)) {
    throw new Error("options evidence riskFreeRate must be finite");
  }

  const contracts: FinanceOptionContractEvidence[] = [];
  let invalidContracts = 0;
  let staleContracts = 0;
  for (const row of rows) {
    const sourceTimestampMs = Date.parse(row.sourceTimestamp);
    if (!Number.isFinite(sourceTimestampMs) || sourceTimestampMs > futureTimestampLimitMs) {
      staleContracts += 1;
      continue;
    }
    const data = object(row.data);
    const details = object(data.details);
    const contractType = text(optionField(data, details, "contract_type", "contractType"));
    const ticker = text(optionField(data, details, "ticker", "symbol"));
    const strike = positiveNumber(optionField(data, details, "strike_price", "strike"));
    const expiration = dateOnly(
      optionField(data, details, "expiration_date", "expiration", "expiry"),
    );
    const impliedVolatility = positiveNumber(
      optionField(data, details, "implied_volatility", "impliedVolatility", "iv"),
    );
    const quote = object(data.last_quote ?? data.quote);
    const bid = positiveNumber(optionField(data, quote, "bid", "bid_price"));
    const ask = positiveNumber(optionField(data, quote, "ask", "ask_price"));
    const openInterest = finiteNumber(optionField(data, details, "open_interest", "openInterest"));
    const expiryMs = expiration ? Date.parse(`${expiration}T00:00:00.000Z`) : Number.NaN;
    const timeToExpiryYears = (expiryMs - asOfMs) / (365.25 * 86_400_000);
    if (
      (contractType !== "call" && contractType !== "put") ||
      !ticker ||
      strike === undefined ||
      !expiration ||
      impliedVolatility === undefined ||
      impliedVolatility > 5 ||
      bid === undefined ||
      ask === undefined ||
      ask < bid ||
      !Number.isFinite(timeToExpiryYears) ||
      timeToExpiryYears <= 0 ||
      (openInterest !== undefined && openInterest < 0)
    ) {
      invalidContracts += 1;
      continue;
    }
    const mid = (bid + ask) / 2;
    const spreadPct = (ask - bid) / mid;
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(spreadPct)) {
      invalidContracts += 1;
      continue;
    }
    let greeks: ReturnType<typeof calculateBlackScholes>;
    try {
      greeks = calculateBlackScholes({
        spot: options.underlyingSpot,
        strike,
        timeToExpiryYears,
        riskFreeRate,
        volatility: impliedVolatility,
        optionType: contractType,
      });
    } catch {
      invalidContracts += 1;
      continue;
    }
    contracts.push({
      ticker,
      contractType,
      strike,
      expiration,
      timeToExpiryYears: rounded(timeToExpiryYears, 8),
      impliedVolatility: rounded(impliedVolatility),
      bid: rounded(bid),
      ask: rounded(ask),
      mid: rounded(mid),
      spreadPct: rounded(spreadPct),
      openInterest: openInterest === undefined ? null : rounded(openInterest),
      greeks: {
        price: rounded(greeks.price),
        delta: rounded(greeks.delta),
        gamma: rounded(greeks.gamma),
        theta: rounded(greeks.theta),
        vega: rounded(greeks.vega),
        rho: rounded(greeks.rho),
      },
      providerName: row.providerName,
      sourceTimestamp: row.sourceTimestamp,
      sourceUrlOrArtifact: row.sourceUrlOrArtifact,
    });
  }

  const eligible = contracts.filter(
    (contract) =>
      contract.openInterest !== null &&
      contract.openInterest >= minOpenInterest &&
      contract.spreadPct <= maxSpreadPct,
  );
  const calls = eligible.filter((contract) => contract.contractType === "call");
  const puts = eligible.filter((contract) => contract.contractType === "put");
  const callOpenInterest = calls.reduce((sum, contract) => sum + (contract.openInterest ?? 0), 0);
  const putOpenInterest = puts.reduce((sum, contract) => sum + (contract.openInterest ?? 0), 0);
  const totalOpenInterest = callOpenInterest + putOpenInterest;
  const expirationMap = new Map<string, FinanceOptionContractEvidence[]>();
  for (const contract of eligible) {
    expirationMap.set(contract.expiration, [
      ...(expirationMap.get(contract.expiration) ?? []),
      contract,
    ]);
  }
  const expirations = [...expirationMap]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([expiration, values]) => ({
      expiration,
      contracts: values.length,
      medianImpliedVolatility: rounded(median(values.map((value) => value.impliedVolatility)) ?? 0),
      openInterest: rounded(values.reduce((sum, value) => sum + (value.openInterest ?? 0), 0)),
    }));
  const representatives = eligible
    .toSorted(
      (a, b) =>
        Math.abs(a.strike - options.underlyingSpot) - Math.abs(b.strike - options.underlyingSpot) ||
        a.spreadPct - b.spreadPct ||
        (b.openInterest ?? 0) - (a.openInterest ?? 0) ||
        a.expiration.localeCompare(b.expiration),
    )
    .slice(0, 6);
  const openInterestWeightedGamma =
    totalOpenInterest > 0
      ? rounded(
          eligible.reduce(
            (sum, contract) => sum + contract.greeks.gamma * (contract.openInterest ?? 0),
            0,
          ) / totalOpenInterest,
        )
      : null;
  const warnings: string[] = [
    "Greeks are Black-Scholes European estimates using provider IV, riskFreeRate=0, no dividend yield, and no American-exercise adjustment.",
    "Option evidence is research-only; no contract selection or options order authority is created.",
  ];
  if (rows.length === 0) {
    warnings.push("options_chain returned no records");
  }
  if (staleContracts > 0) {
    warnings.push(`excluded ${staleContracts} stale or future option record(s)`);
  }
  if (invalidContracts > 0) {
    warnings.push(`excluded ${invalidContracts} option record(s) with incomplete math inputs`);
  }
  if (eligible.length === 0) {
    warnings.push(
      `no contract passed liquidity gates (openInterest>=${minOpenInterest}, spreadPct<=${maxSpreadPct})`,
    );
  }
  return Object.freeze({
    status: eligible.length > 0 ? "usable" : "insufficient",
    underlyingSpot: rounded(options.underlyingSpot),
    underlyingSpotAt: options.underlyingSpotAt,
    evaluatedContracts: contracts.length,
    invalidContracts,
    staleContracts,
    eligibleContracts: eligible.length,
    medianImpliedVolatility: median(eligible.map((contract) => contract.impliedVolatility)),
    medianSpreadPct: median(eligible.map((contract) => contract.spreadPct)),
    putCallOpenInterestRatio:
      callOpenInterest > 0 ? rounded(putOpenInterest / callOpenInterest) : null,
    openInterestWeightedGamma,
    expirations,
    representatives,
    warnings,
  });
}

export function renderFinanceOptionsEvidence(
  summary: FinanceOptionsChainSummary,
  jobId: string,
): string {
  const representativeText = summary.representatives
    .map(
      (contract) =>
        `${contract.ticker} ${contract.contractType} K=${contract.strike} exp=${contract.expiration} IV=${contract.impliedVolatility} mid=${contract.mid} spread=${contract.spreadPct} delta=${contract.greeks.delta} gamma=${contract.greeks.gamma} theta=${contract.greeks.theta} vega=${contract.greeks.vega} OI=${contract.openInterest ?? "unknown"}`,
    )
    .join("; ");
  return [
    `Options chain (${summary.status}); job=${jobId}; underlying spot=${summary.underlyingSpot} observed=${summary.underlyingSpotAt}; evaluated=${summary.evaluatedContracts}, eligible=${summary.eligibleContracts}; median IV=${summary.medianImpliedVolatility ?? "unknown"}; median bid-ask spread=${summary.medianSpreadPct ?? "unknown"}; put/call OI ratio=${summary.putCallOpenInterestRatio ?? "unknown"}; OI-weighted gamma=${summary.openInterestWeightedGamma ?? "unknown"}.`,
    `Expiry buckets=${JSON.stringify(summary.expirations)}. Representative contracts=${representativeText || "none"}.`,
    `Warnings=${summary.warnings.join(" ")}`,
  ].join(" ");
}
