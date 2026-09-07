import { describe, expect, it } from "vitest";
import type { FinanceDataGatewayObservationInput } from "./finance-data-gateway.js";
import {
  createFinanceRealtimeSourceRegistry,
  inspectFinanceRealtimeSourceRegistry,
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

    expect(registry).toHaveLength(9);
    expect(registry.map((adapter) => adapter.id)).toEqual([
      "yahoo_public_chart",
      "binance_public_crypto_ticker",
      "kraken_public_crypto_ticker",
      "coinbase_exchange_public_crypto_ticker",
      "coincap_public_crypto_asset",
      "nasdaq_exchange_quote",
      "stooq_public_daily",
      "sec_edgar_official_reference",
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
      "coincap_public_crypto_asset",
    ]);
  });
});
