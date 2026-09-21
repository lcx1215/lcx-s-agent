/**
 * Ask every registered source what it supports, run it, and report what came
 * back.
 *
 * The registry carries on the order of a hundred and seventy routes and only a
 * handful had ever been called, so choosing a source was guesswork presented as
 * design. This replaces guessing with measurement.
 *
 * Two things matter more than the happy path:
 *
 * 1. Some adapters reject or over-filter when a date window is supplied - SEC
 *    filings returned nothing with one and works without one. So each probe is
 *    tried bare first and only retried with a window when the bare attempt came
 *    up empty. Without that, this tool reports working sources as dead.
 * 2. Failures are returned as prominently as successes. A source that is
 *    registered but silent is exactly what needs to be visible, and a coverage
 *    claim built on untested routes is not coverage.
 *
 * Fan-out is capped: a full sweep is hundreds of provider calls, which is slow
 * and rude to free tiers.
 */

import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import {
  createFinanceMarketCollectionRegistry,
  runFinanceMarketCollectionRefresh,
} from "./finance-market-collection-registry.js";
import { withFinanceQuotaLane } from "./finance-source-quota.js";

export type SweepRow = Readonly<{
  adapterId: string;
  collection: string;
  records: number;
  status: "ok" | "error";
  fields: readonly string[];
  error?: string;
}>;

export type SweepResult = Readonly<{
  instrument: string;
  asOf: string;
  adaptersSeen: number;
  attempts: number;
  working: readonly SweepRow[];
  failed: readonly SweepRow[];
  capped: boolean;
}>;

const CANDIDATE_COLLECTIONS = [
  "eod_history",
  "company_profile",
  "financial_statements",
  "analyst_estimates",
  "ownership",
  "news",
  "sec_filings",
  "dividends",
  "splits",
  "earnings",
  "earnings_calendar",
  "economic_calendar",
  "quote",
  "macro",
  "fred_series",
  "treasury",
  "transcripts",
  "etf_holdings",
  "insider",
] as const;

export const DEFAULT_SWEEP_MAX_ATTEMPTS = 40;
const COLLECTIONS_PER_ADAPTER = 3;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function keyFrom(env: Record<string, unknown>, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value : "";
}

/**
 * A sweep asks every registered adapter what it supports, which is measurement rather than the
 * loop's own work. It therefore declares the `diagnostics` lane at the point of use: one
 * afternoon's sweep spent 195 of FMP's 250 daily calls and left production sampling refused for
 * the rest of the day, which read downstream as "this source has no opinion".
 */
export function sweepFinanceSources(
  params: {
    instrument?: string;
    maxAttempts?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SweepResult> {
  return withFinanceQuotaLane("diagnostics", () => sweepFinanceSourcesInner(params));
}

async function sweepFinanceSourcesInner(
  params: {
    instrument?: string;
    maxAttempts?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SweepResult> {
  const env = (resolveFinanceCredentialEnv(params.env ?? process.env) ?? {}) as Record<
    string,
    unknown
  >;
  const instrument = (params.instrument ?? "AAPL").trim().toUpperCase() || "AAPL";
  const maxAttempts = Math.max(1, Math.floor(params.maxAttempts ?? DEFAULT_SWEEP_MAX_ATTEMPTS));

  const registry = createFinanceMarketCollectionRegistry({
    fmpApiKey: keyFrom(env, "FMP_API_KEY"),
    alphaVantageApiKey: keyFrom(env, "ALPHA_VANTAGE_API_KEY"),
    massiveApiKey: keyFrom(env, "MASSIVE_API_KEY"),
    finnhubApiKey: keyFrom(env, "FINNHUB_API_KEY"),
    twelveDataApiKey: keyFrom(env, "TWELVE_DATA_API_KEY"),
    fredApiKey: keyFrom(env, "FRED_API_KEY"),
  }) as unknown as ReadonlyArray<{
    id: string;
    supports?: (request: unknown) => boolean;
  }>;

  const asOf = new Date().toISOString();
  const fromDate = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const toDate = asOf.slice(0, 10);

  const working: SweepRow[] = [];
  const failed: SweepRow[] = [];
  let attempts = 0;
  let capped = false;

  for (const adapter of registry) {
    if (typeof adapter.supports !== "function") {
      continue;
    }
    let matched = 0;
    for (const collection of CANDIDATE_COLLECTIONS) {
      if (attempts >= maxAttempts) {
        capped = true;
        break;
      }
      let supported = false;
      try {
        supported = adapter.supports({ collection, instrument, assetClass: "us_equity", asOf });
      } catch {
        supported = false;
      }
      if (!supported) {
        continue;
      }
      matched += 1;
      attempts += 1;
      try {
        let result = await runFinanceMarketCollectionRefresh({
          request: { collection, instrument, assetClass: "us_equity", asOf, limit: 5 } as never,
          adapters: [adapter] as never,
        });
        if ((result.records ?? []).length === 0) {
          result = await runFinanceMarketCollectionRefresh({
            request: {
              collection,
              instrument,
              assetClass: "us_equity",
              asOf,
              limit: 5,
              fromDate,
              toDate,
            } as never,
            adapters: [adapter] as never,
          });
        }
        const records = result.records ?? [];
        const first = records[0] as { data?: Record<string, unknown> } | undefined;
        const row: SweepRow = {
          adapterId: adapter.id,
          collection,
          records: records.length,
          status: "ok",
          fields: first?.data ? Object.keys(first.data).slice(0, 8) : [],
        };
        (records.length > 0 ? working : failed).push(row);
      } catch (error) {
        failed.push({
          adapterId: adapter.id,
          collection,
          records: 0,
          status: "error",
          fields: [],
          error: text(String(error)).slice(0, 120),
        });
      }
      if (matched >= COLLECTIONS_PER_ADAPTER) {
        break;
      }
    }
    if (capped) {
      break;
    }
  }

  return {
    instrument,
    asOf,
    adaptersSeen: registry.length,
    attempts,
    working,
    failed,
    capped,
  };
}
