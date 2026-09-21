/**
 * A macro source, for instruments the other sources cannot speak about.
 *
 * The sampler could only ever form a view on a company: chart structure works on anything with a
 * price, but the second source was analyst price targets, and an ETF has no analysts. Fusion asks
 * for two independent sources before it will state a direction, so every instrument the rules
 * actually trade — all of them ETFs — was sampled as a refusal and never as a call. Measured:
 * SPY refused on "1 distinct source(s) support buy, 2 required", and TLT, GLD and EEM on "no
 * source expressed a direction".
 *
 * This is the missing source. It is independent of price by construction: it reads official macro
 * series from FRED, which are not derived from the instrument's own bars at all.
 *
 * Two things here are deliberately narrow, because the failure this fixes was caused by a source
 * overclaiming:
 *
 * Every route states *why* that series is allowed to speak about that instrument. A bond fund's
 * price being the inverse of its yield is an identity; gold versus real yields is a strong
 * empirical relationship; a high yield credit spread standing in for equity risk appetite is
 * weaker. They are not equally strong claims, so they do not get the same confidence ceiling, and
 * the ceiling is on the record rather than buried in a constant.
 *
 * And a series that has not moved, or cannot be read, produces no signal at all. `undefined` means
 * this source has no opinion, which fusion counts as neither for nor against. Failing to fetch is
 * not a view, and neither is a flat line.
 */

import type { FinanceSignal } from "./finance-signal-fusion.js";

export type MacroObservation = Readonly<{ date: string; value: number }>;

export type MacroRoute = Readonly<{
  seriesId: string;
  /** Human-readable name of the series, used in the citation. */
  label: string;
  /**
   * `inverse`: a fall in the series is bullish — bond yields, real yields, credit spreads, the
   * dollar for assets priced outside it. `direct`: a rise is bullish — crude for a commodity
   * basket.
   */
  polarity: "inverse" | "direct";
  /**
   * Ceiling on how far this source is ever trusted. Not a claim about today: it is how strong the
   * relationship itself is, so the identity for long duration sits above the proxy for equity risk
   * appetite.
   */
  maxConfidence: number;
  /** Why this series may speak about this instrument. Kept next to the route so it can be argued with. */
  basis: string;
}>;

/**
 * Which macro series speaks for which instrument.
 *
 * Only instruments the plane actually trades are listed, and only where the relationship is one
 * that can be written down. An instrument with no route here gets no macro signal rather than a
 * plausible-looking neighbour.
 */
export const MACRO_ROUTES: Readonly<Record<string, MacroRoute>> = Object.freeze({
  TLT: {
    seriesId: "DGS10",
    label: "10y treasury constant maturity",
    polarity: "inverse",
    maxConfidence: 0.6,
    basis:
      "A long duration bond fund's price is the inverse of its yield by construction, so a falling 10y yield is the same statement as the fund appreciating.",
  },
  GLD: {
    seriesId: "DFII10",
    label: "10y TIPS real yield",
    polarity: "inverse",
    maxConfidence: 0.5,
    basis:
      "Gold pays no coupon, so the real yield is the cost of carrying it: as the 10y TIPS yield falls, holding gold gets cheaper.",
  },
  DBC: {
    seriesId: "DCOILWTICO",
    label: "WTI crude",
    polarity: "direct",
    maxConfidence: 0.45,
    basis:
      "Energy is the largest single weight in a broad commodity basket, so the basket largely follows crude. Weaker than the two above: a basket is not a barrel.",
  },
  SPY: {
    seriesId: "BAMLH0A0HYM2",
    label: "high yield credit spread",
    polarity: "inverse",
    maxConfidence: 0.45,
    basis:
      "A widening high yield spread is the credit market pricing stress, and equity has historically followed it. A proxy for risk appetite, not a valuation of the index.",
  },
  QQQ: {
    seriesId: "BAMLH0A0HYM2",
    label: "high yield credit spread",
    polarity: "inverse",
    maxConfidence: 0.45,
    basis:
      "Same proxy as SPY. Long duration equity is if anything more sensitive to funding conditions, but that is an argument about degree, not a different relationship, so the ceiling is unchanged.",
  },
  IWM: {
    seriesId: "BAMLH0A0HYM2",
    label: "high yield credit spread",
    polarity: "inverse",
    maxConfidence: 0.45,
    basis:
      "Same proxy as SPY. Small capitalisation issuers are more exposed to tight credit, but this is the same relationship and gets the same ceiling.",
  },
  EFA: {
    seriesId: "DTWEXBGS",
    label: "broad dollar index",
    polarity: "inverse",
    maxConfidence: 0.45,
    basis:
      "A stronger dollar mechanically depresses the dollar value of assets priced in other currencies. A translation effect, not a claim about those economies.",
  },
  EEM: {
    seriesId: "DTWEXBGS",
    label: "broad dollar index",
    polarity: "inverse",
    maxConfidence: 0.45,
    basis:
      "Same translation effect as EFA, historically stronger for emerging markets because their debt is often dollar denominated. Same ceiling: stronger sensitivity is not a stronger relationship.",
  },
});

/** How far back the trend is measured, in observations. */
export const MACRO_LOOKBACK_OBSERVATIONS = 20;

/**
 * Below this the series is treated as having not moved. Macro series drift on reporting noise, and
 * a source that calls every wobble a direction would be an eager second vote rather than evidence.
 */
export const MACRO_MIN_MOVE_PCT = 0.005;

/** Move considered a full-strength statement, used to scale `strength` between 0 and 1. */
export const MACRO_FULL_STRENGTH_MOVE_PCT = 0.05;

/**
 * Turn a macro series into a directional signal, or into nothing at all.
 *
 * `undefined` is a first-class answer here: it means this source has no opinion, which fusion
 * counts as neither supporting nor opposing a side. Everything that could go wrong — a missing
 * series, a flat line, a value that is not a number — lands on that answer rather than on a
 * fabricated direction.
 */
export function macroTrendSignal(params: {
  route: MacroRoute;
  observations: readonly MacroObservation[];
  observedAt: string;
  lookbackObservations?: number;
  minMovePct?: number;
}): FinanceSignal | undefined {
  const usable = params.observations
    .filter((point) => Number.isFinite(point.value) && typeof point.date === "string")
    .toSorted((left, right) => left.date.localeCompare(right.date));
  if (usable.length < 2) {
    return undefined;
  }

  const latest = usable[usable.length - 1];
  const lookback = params.lookbackObservations ?? MACRO_LOOKBACK_OBSERVATIONS;
  const prior = usable[Math.max(0, usable.length - 1 - lookback)];
  if (prior === undefined || prior.date === latest.date) {
    return undefined;
  }
  if (!(Math.abs(prior.value) > 0)) {
    return undefined;
  }

  const movePct = (latest.value - prior.value) / Math.abs(prior.value);
  if (!Number.isFinite(movePct) || Math.abs(movePct) < (params.minMovePct ?? MACRO_MIN_MOVE_PCT)) {
    return undefined;
  }

  const bullish = params.route.polarity === "inverse" ? movePct < 0 : movePct > 0;
  const strength = Math.min(1, Math.abs(movePct) / MACRO_FULL_STRENGTH_MOVE_PCT);

  return Object.freeze({
    sourceId: `fred:${params.route.seriesId}`,
    kind: "macro",
    direction: bullish ? "buy" : "sell",
    strength: Number(strength.toFixed(4)),
    confidence: params.route.maxConfidence,
    observedAt: params.observedAt,
    ref:
      `${params.route.label} ${prior.date}=${prior.value} → ${latest.date}=${latest.value} ` +
      `(${(movePct * 100).toFixed(2)}%)`,
  });
}

/** The route for an instrument, if one has been argued for. */
export function macroRouteFor(instrument: string): MacroRoute | undefined {
  return MACRO_ROUTES[instrument.trim().toUpperCase()];
}

/**
 * What feeds a route: a function from a FRED series id to its observations.
 */
export type MacroSeriesSupplier = (seriesId: string) => Promise<readonly MacroObservation[]>;

/**
 * FRED's public CSV endpoint: the same host and path the repo already uses for index history, and it
 * needs no API key.
 *
 * This exists because the keyed adapter is not the only way to reach these series, and the sampler
 * used to have only that one way. `FRED_API_KEY` is absent here -- `~/.openclaw/.env` names it and
 * sets none of them -- so `defaultMacroFor` returned `undefined`, the sampler's
 * `if (params.macroFor !== undefined && route !== undefined)` skipped the whole leg, and the
 * comment there said the absence was not a failure. An instrument therefore kept one fewer source
 * and nothing anywhere said so. Measured against the live endpoint, `?id=DGS10` answers 200 with
 * real observations.
 *
 * Deliberately not a *silent* better-than-nothing: if the endpoint cannot be read, this throws and
 * the caller's existing "macro leg failed" warning names the instrument. What it must never do is
 * return a value that looks like the series.
 */
export async function fetchPublicFredMacroSeries(
  seriesId: string,
  options: {
    fetchText?: (url: string) => Promise<string>;
    asOf?: string;
    windowDays?: number;
  } = {},
): Promise<readonly MacroObservation[]> {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const windowDays = options.windowDays ?? 500;
  const from = isoDayOffset(asOf, -windowDays);
  const url =
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}` +
    `&cosd=${from}&coed=${asOf}`;
  const text = await (options.fetchText ?? defaultFetchText)(url);
  return parseFredMacroCsv(text, seriesId);
}

export function createPublicFredMacroSeriesSupplier(
  options: Parameters<typeof fetchPublicFredMacroSeries>[1] = {},
): MacroSeriesSupplier {
  return async (seriesId) => fetchPublicFredMacroSeries(seriesId, options);
}

/** The CSV the public endpoint returns: a header naming the series, then `date,value` rows. */
export function parseFredMacroCsv(text: string, seriesId: string): readonly MacroObservation[] {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const header = lines.shift();
  if (header !== `observation_date,${seriesId}`) {
    throw new Error(`unexpected FRED CSV schema for ${seriesId}: ${header ?? "(empty)"}`);
  }
  const observations: MacroObservation[] = [];
  for (const line of lines) {
    const columns = line.split(",");
    if (columns.length !== 2) {
      throw new Error(`invalid FRED CSV row for ${seriesId}: ${line}`);
    }
    const [date, raw] = columns;
    // FRED writes '.' for a missing observation. A gap is a gap, not a zero.
    if (raw === "." || raw.trim() === "") {
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`invalid FRED observation for ${seriesId}: ${line}`);
    }
    observations.push(Object.freeze({ date, value }));
  }
  return observations;
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`FRED public CSV ${response.status} for ${url}`);
  }
  return response.text();
}

function isoDayOffset(isoDay: string, days: number): string {
  const epoch = Date.parse(`${isoDay}T00:00:00Z`);
  if (!Number.isFinite(epoch)) {
    throw new Error(`not an ISO day: ${isoDay}`);
  }
  return new Date(epoch + days * 86_400_000).toISOString().slice(0, 10);
}
