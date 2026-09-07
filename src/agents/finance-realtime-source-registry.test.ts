import { describe, expect, it, vi } from "vitest";
import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import {
  createFinanceRealtimeSourceRegistry,
  inspectFinanceRealtimeSourceRegistry,
  resolveFinanceRealtimeSourceRegistryOptionsFromEnv,
  runFinanceRealtimeRefresh,
  type FinanceRealtimeSourceAdapter,
} from "./finance-realtime-source-registry.js";

const request = {
  instrument: "QQQ",
  assetClass: "etf",
  useCase: "realtime_source_registry_test",
  asOf: "2026-07-01T20:05:00.000Z",
  freshnessMaxMinutes: 90,
  requireOfficialReference: true,
} as const;

function observation(
  providerName: string,
  providerRole: FinanceDataGatewayObservationInput["providerRole"],
  value = 725.17,
): FinanceDataGatewayObservationInput {
  return {
    providerName,
    providerRole,
    sourceFamily: "market_data_api",
    observedAt: request.asOf,
    timezone: "UTC",
    delayStatus: "delayed",
    fields: [
      {
        name: "last_price",
        value,
        currency: "USD",
        adjusted: false,
        fieldDefinition: "delayed consolidated last price",
        sourceTimestamp: "2026-07-01T20:00:00.000Z",
        sourceUrlOrArtifact: `fixture://${providerName}/QQQ`,
      },
    ],
  };
}

function adapter(params: {
  id: string;
  providerRole: FinanceRealtimeSourceAdapter["providerRole"];
  priority: number;
  result: FinanceDataGatewayObservationInput | Error;
}): FinanceRealtimeSourceAdapter {
  return {
    id: params.id,
    providerName: params.id,
    providerRole: params.providerRole,
    priority: params.priority,
    supports: () => true,
    collect: async () => {
      if (params.result instanceof Error) {
        throw params.result;
      }
      return params.result;
    },
  };
}

describe("finance realtime source registry", () => {
  it("inspects preferred and fallback adapters without calling the network", () => {
    let calls = 0;
    const source: FinanceRealtimeSourceAdapter = {
      ...adapter({
        id: "primary-fixture",
        providerRole: "primary_market_data",
        priority: 1,
        result: observation("primary-fixture", "primary_market_data"),
      }),
      collect: async () => {
        calls += 1;
        return observation("primary-fixture", "primary_market_data");
      },
    };

    const inspection = inspectFinanceRealtimeSourceRegistry(request, [source]);

    expect(inspection.candidateAdapters).toEqual([
      expect.objectContaining({ id: "primary-fixture", priority: 1 }),
    ]);
    expect(inspection.noNetworkCalled).toBe(true);
    expect(calls).toBe(0);
  });

  it("continues after a preferred adapter fails and preserves the gateway evidence gate", async () => {
    const receipt = await runFinanceRealtimeRefresh({
      request,
      adapters: [
        adapter({
          id: "primary-preferred",
          providerRole: "primary_market_data",
          priority: 1,
          result: new Error("429 from preferred source"),
        }),
        adapter({
          id: "primary-fallback",
          providerRole: "primary_market_data",
          priority: 2,
          result: observation("primary-fallback", "primary_market_data"),
        }),
        adapter({
          id: "cross-check",
          providerRole: "cross_check_market_data",
          priority: 1,
          result: observation("cross-check", "cross_check_market_data"),
        }),
        adapter({
          id: "issuer",
          providerRole: "official_or_issuer_reference",
          priority: 1,
          result: observation("issuer", "official_or_issuer_reference"),
        }),
      ],
    });

    expect(receipt.status).toBe("ready");
    expect(receipt.snapshot?.qualityStatus).toBe("ready");
    expect(receipt.sourceAttempts).toEqual([
      expect.objectContaining({ adapterId: "primary-preferred", status: "failed" }),
      expect.objectContaining({ adapterId: "primary-fallback", status: "succeeded" }),
      expect.objectContaining({ adapterId: "cross-check", status: "succeeded" }),
      expect.objectContaining({ adapterId: "issuer", status: "succeeded" }),
    ]);
    expect(receipt.notTouched).toContain("trading_execution");
  });

  it("does not hide a conflict when two healthy sources disagree", async () => {
    const receipt = await runFinanceRealtimeRefresh({
      request: { ...request, requireOfficialReference: false },
      adapters: [
        adapter({
          id: "primary",
          providerRole: "primary_market_data",
          priority: 1,
          result: observation("primary", "primary_market_data", 725.17),
        }),
        adapter({
          id: "cross-check",
          providerRole: "cross_check_market_data",
          priority: 1,
          result: observation("cross-check", "cross_check_market_data", 726.01),
        }),
      ],
    });

    expect(receipt.status).toBe("needs_review");
    expect(receipt.snapshot?.conflicts).toHaveLength(1);
    expect(receipt.requiredNextSteps).toContain("run_data_provenance_quality_review");
  });

  it("keeps the default public source explicitly injectable and delayed", () => {
    const registry = createFinanceRealtimeSourceRegistry({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    currency: "USD",
                    regularMarketPrice: 725.17,
                    regularMarketTime: 1782936000,
                  },
                },
              ],
              error: null,
            },
          }),
      }),
    });

    expect(registry).toHaveLength(13);
    expect(registry.map((adapter) => adapter.id)).toEqual([
      "yahoo_public_chart",
      "binance_public_crypto_ticker",
      "kraken_public_crypto_ticker",
      "coinbase_exchange_public_crypto_ticker",
      "bybit_public_crypto_ticker",
      "okx_public_crypto_ticker",
      "bitstamp_public_crypto_ticker",
      "coincap_public_crypto_asset",
      "nasdaq_exchange_quote",
      "stooq_public_daily",
      "sec_edgar_official_reference",
      "sec_edgar_companyfacts",
      "invesco_qqq_issuer_reference",
    ]);
    expect(registry[0]?.providerRole).toBe("primary_market_data");
  });

  it("filters the registry to crypto sources without calling equity adapters", () => {
    const registry = createFinanceRealtimeSourceRegistry();
    const inspection = inspectFinanceRealtimeSourceRegistry(
      {
        instrument: "BTCUSDT",
        assetClass: "crypto",
        useCase: "crypto_registry_inspection",
        asOf: "2026-09-07T10:45:00.000Z",
        requireOfficialReference: false,
      },
      registry,
    );
    expect(inspection.candidateAdapters.map((adapter) => adapter.id)).toEqual([
      "binance_public_crypto_ticker",
      "kraken_public_crypto_ticker",
      "coinbase_exchange_public_crypto_ticker",
      "bybit_public_crypto_ticker",
      "okx_public_crypto_ticker",
      "bitstamp_public_crypto_ticker",
      "coincap_public_crypto_asset",
    ]);
  });

  it("resolves optional provider credentials by name without exposing their values", () => {
    const options = resolveFinanceRealtimeSourceRegistryOptionsFromEnv({
      MASSIVE_API_KEY: "massive-secret",
      ALPACA_API_KEY_ID: "alpaca-id",
      ALPACA_API_SECRET_KEY: "alpaca-secret",
      FINNHUB_API_KEY: "finnhub-secret",
      TWELVE_DATA_API_KEY: "twelve-secret",
    });
    expect(options).toEqual({
      alphaVantageApiKey: undefined,
      coinGeckoApiKey: undefined,
      coinCapApiKey: undefined,
      massiveApiKey: "massive-secret",
      alpacaApiKeyId: "alpaca-id",
      alpacaApiSecretKey: "alpaca-secret",
      alpacaFeed: undefined,
      finnhubApiKey: "finnhub-secret",
      twelveDataApiKey: "twelve-secret",
    });
  });
});

describe("realtime API transport governance", () => {
  it("aborts the built-in Yahoo HTTP request at the registry deadline", async () => {
    let httpSignal: AbortSignal | undefined;
    let calls = 0;
    const adapters = createFinanceRealtimeSourceRegistry({
      fetchImpl: async (_url, init) => {
        calls += 1;
        httpSignal = init?.signal;
        return new Promise(() => {});
      },
    }).filter((entry) => entry.id === "yahoo_public_chart");
    const receipt = await runFinanceRealtimeRefresh({
      request,
      adapters,
      timeoutMs: 10,
      correlationId: "refresh-test",
    });
    expect(httpSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(receipt.status).toBe("blocked");
    expect(receipt.sourceAttempts[0].apiCalls).toEqual([
      expect.objectContaining({
        operation: "http_get",
        status: "timed_out",
        correlationId: "refresh-test",
      }),
      expect.objectContaining({ operation: "collect", status: "timed_out" }),
    ]);
  });

  it("does not invoke any adapter when refresh is already cancelled", async () => {
    const collect = vi.fn();
    const source = {
      ...adapter({
        id: "cancel-test",
        providerRole: "primary_market_data",
        priority: 1,
        result: new Error("unused"),
      }),
      collect,
    };
    const receipt = await runFinanceRealtimeRefresh({
      request,
      adapters: [source],
      signal: AbortSignal.abort("secret-reason"),
    });
    expect(collect).not.toHaveBeenCalled();
    expect(receipt.adaptersCalled).toBe(false);
    expect(receipt.sourceAttempts[0].apiCalls?.[0].status).toBe("cancelled");
    expect(JSON.stringify(receipt)).not.toContain("secret-reason");
  });
});
