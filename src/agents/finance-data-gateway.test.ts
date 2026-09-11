import { describe, expect, it } from "vitest";
import { buildFinanceDataGatewaySnapshot } from "./finance-data-gateway.js";

function observation(
  providerName: string,
  providerRole: "primary_market_data" | "cross_check_market_data" | "official_or_issuer_reference",
  sourceTimestamp: string,
  value = 718.96,
) {
  return {
    providerName,
    providerRole,
    sourceFamily:
      providerRole === "official_or_issuer_reference"
        ? ("official_filing" as const)
        : ("market_data_api" as const),
    observedAt: "2026-09-07T10:15:00.000Z",
    timezone: "UTC",
    delayStatus:
      providerRole === "official_or_issuer_reference"
        ? ("official_lagged" as const)
        : ("end_of_day" as const),
    fields: [
      {
        name: "last_price",
        value,
        currency: "USD",
        adjusted: false,
        fieldDefinition: "last price",
        sourceTimestamp,
        sourceUrlOrArtifact: `fixture://${providerName}/QQQ`,
      },
    ],
  };
}

describe("finance data gateway cross-source audit", () => {
  it("routes timestamp-skewed but numerically equal sources to review", () => {
    const snapshot = buildFinanceDataGatewaySnapshot({
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "cross_source_skew_test",
      asOf: "2026-09-07T10:15:00.000Z",
      freshnessMaxMinutes: 60 * 24 * 5,
      crossSourceSkewMaxMinutes: 60 * 24,
      requireOfficialReference: false,
      observations: [
        observation("yahoo", "primary_market_data", "2026-09-04T20:00:00.000Z"),
        observation("nasdaq", "cross_check_market_data", "2026-09-03T00:00:00.000Z"),
      ],
    });

    expect(snapshot.conflicts).toHaveLength(0);
    expect(snapshot.qualityStatus).toBe("needs_review");
    expect(snapshot.freshnessWarnings).toContain(
      "last_price source timestamps differ by 2640m across providers",
    );
    expect(snapshot.requiredNextSteps).toContain("refresh_or_label_stale_fields");
  });

  it("allows aligned multi-source timestamps to remain ready", () => {
    const snapshot = buildFinanceDataGatewaySnapshot({
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "cross_source_aligned_test",
      asOf: "2026-09-07T10:15:00.000Z",
      freshnessMaxMinutes: 60 * 24 * 5,
      crossSourceSkewMaxMinutes: 60,
      requireOfficialReference: false,
      observations: [
        observation("yahoo", "primary_market_data", "2026-09-04T20:00:00.000Z"),
        observation("nasdaq", "cross_check_market_data", "2026-09-04T20:30:00.000Z"),
      ],
    });

    expect(snapshot.qualityStatus).toBe("ready");
  });
});
