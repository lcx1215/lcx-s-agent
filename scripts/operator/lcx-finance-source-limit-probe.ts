#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ApiCallError,
  runApiSourceCall,
  type ApiCallReceipt,
} from "../../src/agents/api-call-contract.js";
import { createFinanceNativeFetch } from "../../src/agents/finance-live-market-source.js";
import {
  createFinanceMarketCollectionRegistry,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
  type FinanceMarketCollectionRequest,
} from "../../src/agents/finance-market-collection-registry.js";
import {
  createFinanceRealtimeSourceRegistry,
  resolveFinanceRealtimeSourceRegistryOptionsFromEnv,
} from "../../src/agents/finance-realtime-source-registry.js";
import { financeProviderId } from "../../src/agents/finance-source-health.js";
import { classifyFinanceQuotaBody } from "../../src/agents/finance-source-quota-policy.js";
import {
  financeQuotaProbesDir,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.ts";

// Representative read-only routes; this does not assert independent quotas per route.
const selected: Record<string, string> = {
  yahoo: "yahoo_public_chart",
  binance: "binance_public_crypto_ticker",
  kraken: "kraken_public_crypto_ticker",
  coinbase: "coinbase_exchange_public_crypto_ticker",
  bybit: "bybit_public_crypto_ticker",
  okx: "okx_public_crypto_ticker",
  bitstamp: "bitstamp_public_crypto_ticker",
  coincap: "coincap_public_crypto_asset",
  nasdaq: "nasdaq_exchange_quote",
  stooq: "stooq_public_daily",
  sec: "sec_edgar_official_reference",
  invesco: "invesco_qqq_issuer_reference",
  alpha_vantage: "alpha_vantage_income_statement",
  coingecko: "coingecko_public_crypto_price",
  massive: "massive_ticker_directory",
  alpaca: "alpaca_us_equity_latest_quote",
  finnhub: "finnhub_us_equity_quote",
  twelve_data: "twelve_data_us_equity_quote",
  fmp: "fmp_free_basic_company_profile",
  fred: "fred_macro_series",
  bls: "bls_public_macro_series",
  treasury: "treasury_fiscal_debt_to_penny",
  gdelt: "gdelt_public_news",
  google_news: "google_news_rss",
};
const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const attempts = Number(value("--max-attempts") ?? 1);
const intervalMs = Number(value("--interval-ms") ?? 1000);
const provider = value("--provider");
const sourceId = value("--source-id");
if (sourceId && (!provider || financeProviderId(sourceId) !== provider)) {
  throw new Error("source override must match the selected provider");
}
const concurrency = Number(value("--concurrency") ?? 1);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error("probe concurrency must be 1-4");
}
if (
  !Number.isSafeInteger(attempts) ||
  attempts < 1 ||
  attempts > 251 ||
  !Number.isFinite(intervalMs) ||
  intervalMs < 0
) {
  throw new Error("invalid bounded probe parameters");
}
if (provider && !selected[provider]) {
  throw new Error("unknown provider");
}
if (attempts > 1 && !args.includes("--exhaust-free-quota")) {
  throw new Error("repeated probes require explicit free-quota authorization");
}
if (!args.includes("--live")) {
  console.log(
    JSON.stringify({
      networkCalled: false,
      providers: provider ? { [provider]: selected[provider] } : selected,
      attempts,
      intervalMs,
    }),
  );
} else {
  const root = financeQuotaProbesDir(resolveFinanceStateDir().directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  for (const [providerId, defaultAdapterId] of Object.entries(selected)) {
    const adapterId = sourceId ?? defaultAdapterId;
    if (provider && providerId !== provider) {
      continue;
    }
    const observations: unknown[] = [];
    let stopReason = "bounded_sample_not_an_upper_limit";
    const startedAt = new Date().toISOString();
    async function probe(index: number) {
      if (index > 0 && intervalMs > 0) {
        await delay(index * intervalMs);
      }
      let bodyRateLimited = false;
      const native = createFinanceNativeFetch(adapterId === "gdelt_public_news_titles");
      const fetchImpl: typeof native = async (url, init) => {
        if (stopReason !== "bounded_sample_not_an_upper_limit") {
          throw new ApiCallError("cancelled");
        }
        const response = await native(url, init);
        const body = await response.text();
        // Retain only the classification; provider errors may echo credentials.
        bodyRateLimited ||= classifyFinanceQuotaBody(body) !== undefined;
        return { ...response, text: async () => body };
      };
      const collection = createFinanceMarketCollectionRegistry({
        ...resolveFinanceMarketCollectionRegistryOptionsFromEnv(),
        fetchImpl,
      }).find((a) => a.id === adapterId);
      const realtime = createFinanceRealtimeSourceRegistry({
        ...resolveFinanceRealtimeSourceRegistryOptionsFromEnv(),
        fetchImpl,
      }).find((a) => a.id === adapterId);
      const adapter = collection ?? realtime;
      if (!adapter) {
        stopReason = "not_configured_or_disabled";
        return;
      }
      const apiCalls: ApiCallReceipt[] = [];
      let collected = false;
      try {
        await runApiSourceCall(
          {
            provider: providerId,
            source: adapterId,
            operation: "quota_probe",
            timeoutMs: 20_000,
            retry: { attempts: 1 },
            onReceipt: (receipt) => apiCalls.push(receipt),
          },
          async (signal) => {
            const asOf = new Date().toISOString();
            if (collection) {
              const samples: Record<string, Partial<FinanceMarketCollectionRequest>> = {
                alpha_vantage: { collection: "financial_statements" },
                fmp: { collection: "company_profile" },
                fred: {
                  collection: "macro_series",
                  instrument: "GDP",
                  assetClass: "macro",
                  seriesId: "GDP",
                },
                bls: {
                  collection: "macro_series",
                  instrument: "CUUR0000SA0",
                  assetClass: "macro",
                  seriesId: "CUUR0000SA0",
                },
                treasury: {
                  collection: "macro_series",
                  instrument: "debt_to_penny",
                  assetClass: "macro",
                  seriesId: "debt_to_penny",
                },
              };
              const overrides = samples[providerId] ?? {};
              await collection.collect(
                {
                  instrument: "AAPL",
                  assetClass: "us_equity",
                  collection: "news",
                  limit: 1,
                  ...overrides,
                  ...collection.sampleRequest,
                  asOf,
                },
                signal,
              );
            } else if (realtime) {
              const crypto = [
                "binance",
                "kraken",
                "coinbase",
                "bybit",
                "okx",
                "bitstamp",
                "coincap",
                "coingecko",
              ].includes(financeProviderId(adapterId));
              await realtime.collect(
                {
                  instrument: crypto
                    ? "BTCUSDT"
                    : ["invesco", "sec"].includes(providerId)
                      ? "QQQ"
                      : "AAPL",
                  assetClass: crypto ? "crypto" : "us_equity",
                  useCase: "research_only",
                  asOf,
                },
                signal,
              );
            }
          },
        );
        collected = true;
      } catch {
        /* Detailed sanitized transport outcomes are retained below. */
      }
      const calls = apiCalls.filter((call) => call.operation === "http_get");
      observations.push({ index: index + 1, collected, bodyRateLimited, calls });
      console.log(
        JSON.stringify({
          provider: providerId,
          index: index + 1,
          collected,
          bodyRateLimited,
          calls: calls.map((c) => ({
            status: c.httpStatus,
            error: c.transportError,
            quota: c.rateLimitHeaders,
          })),
        }),
      );
      if (bodyRateLimited || calls.some((call) => call.rateLimited)) {
        stopReason = "rate_limit_observed";
        return;
      }
      if (
        stopReason === "bounded_sample_not_an_upper_limit" &&
        calls.some((call) => [401, 403, 402].includes(call.httpStatus ?? 0))
      ) {
        stopReason = "access_or_entitlement_blocked";
        return;
      }
      if (!collected && stopReason === "bounded_sample_not_an_upper_limit") {
        stopReason = "transport_or_payload_failed_not_a_quota_limit";
        return;
      }
    }
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (nextIndex < attempts && stopReason === "bounded_sample_not_an_upper_limit") {
          await probe(nextIndex++);
        }
      }),
    );
    const result = {
      schemaVersion: "lcx_finance_quota_probe_v1",
      provider: providerId,
      adapterId,
      startedAt,
      finishedAt: new Date().toISOString(),
      maxAttempts: attempts,
      concurrency,
      intervalMs,
      stopReason,
      observations,
      boundary: "sampled_route_current_account_and_network_not_universal_limit",
      noPaidOverageAuthorized: true,
    };
    const file = path.join(root, `${runId}-${providerId}.json`);
    await fs.writeFile(file, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ provider: providerId, stopReason, receiptPath: file }));
  }
}
