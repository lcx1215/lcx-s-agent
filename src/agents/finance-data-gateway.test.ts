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

  it("blocks and excludes post-cutoff fields from historical evidence", () => {
    const snapshot = buildFinanceDataGatewaySnapshot({
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "historical_cutoff_test",
      asOf: "2026-09-07T10:15:00.000Z",
      requireOfficialReference: false,
      observations: [
        observation("future-yahoo", "primary_market_data", "2026-09-08T20:00:00.000Z", 800),
        observation("historical-nasdaq", "cross_check_market_data", "2026-09-04T20:30:00.000Z"),
      ],
    });

    expect(snapshot.qualityStatus).toBe("blocked");
    expect(snapshot.missingEvidence).toContain("post_cutoff_observations");
    expect(snapshot.requiredNextSteps).toContain("review_future_dated_observations");
    expect(snapshot.freshnessWarnings).toContain(
      "last_price from future-yahoo is newer than requested asOf 2026-09-07T10:15:00.000Z",
    );
    expect(snapshot.normalizedFields.every((field) => field.sourceTimestamp <= snapshot.asOf)).toBe(
      true,
    );
  });

  it("allows collection-time fields for an explicit live-now run", () => {
    const snapshot = buildFinanceDataGatewaySnapshot({
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "live_now_cutoff_test",
      asOf: "2026-09-07T10:15:00.000Z",
      asOfMode: "live_now",
      freshnessMaxMinutes: 60 * 24 * 5,
      requireOfficialReference: false,
      observations: [
        observation("live-yahoo", "primary_market_data", "2026-09-08T20:00:00.000Z", 800),
        observation("live-nasdaq", "cross_check_market_data", "2026-09-08T20:30:00.000Z", 800),
      ],
    });

    expect(snapshot.qualityStatus).toBe("ready");
    expect(snapshot.missingEvidence).not.toContain("post_cutoff_observations");
    expect(snapshot.freshnessWarnings).not.toContain(
      "last_price from live-yahoo is newer than requested asOf 2026-09-07T10:15:00.000Z",
    );
    expect(snapshot.normalizedFields.some((field) => field.sourceTimestamp > snapshot.asOf)).toBe(
      true,
    );
  });

  it("blocks implausibly future timestamps in live-now mode", () => {
    const asOf = new Date().toISOString();
    const future = new Date(Date.parse(asOf) + 10 * 60_000).toISOString();
    const snapshot = buildFinanceDataGatewaySnapshot({
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "live_now_future_skew_test",
      asOf,
      asOfMode: "live_now",
      requireOfficialReference: false,
      observations: [
        observation("future-yahoo", "primary_market_data", future, 800),
        observation("future-nasdaq", "cross_check_market_data", future, 800),
      ],
    });

    expect(snapshot.qualityStatus).toBe("blocked");
    expect(snapshot.missingEvidence).toContain("implausible_future_observations");
    expect(snapshot.requiredNextSteps).toContain("review_implausible_future_observations");
    expect(snapshot.freshnessWarnings).toContain(
      "last_price from future-yahoo exceeds the live-now future skew limit",
    );
    expect(snapshot.normalizedFields).toHaveLength(0);
  });
});

/**
 * `freshnessMaxMinutes` and `crossSourceSkewMaxMinutes` are the same pair of tunables, and only one
 * of them was guarded. Measured with a 30-day-old field: the default, `0` and `-1` all produced a
 * staleness warning and the `refresh_or_label_stale_fields` next step, while `NaN` and `Infinity`
 * produced neither -- a snapshot that can never be stale. The guard next door already established the
 * convention for this pair, so the fix adds the same one rather than inventing a new shape.
 *
 * The input reuses this file's `observation()` helper so the fixture stays type-correct rather than
 * being hand-rolled beside it.
 */
describe("the freshness window is validated like its sibling", () => {
  const staleAt = "2026-08-21T00:00:00.000Z";
  const staleInput = (freshnessMaxMinutes?: number) => ({
    instrument: "QQQ",
    assetClass: "etf",
    useCase: "freshness_window_test",
    asOf: "2026-09-20T00:00:00.000Z",
    requireOfficialReference: false,
    ...(freshnessMaxMinutes === undefined ? {} : { freshnessMaxMinutes }),
    observations: [observation("p1", "official_or_issuer_reference", staleAt)],
  });

  it("still flags a stale field under the default window", () => {
    const snapshot = buildFinanceDataGatewaySnapshot(staleInput());
    expect(snapshot.freshnessWarnings.join(" ")).toMatch(/old/);
    expect(snapshot.requiredNextSteps).toContain("refresh_or_label_stale_fields");
  });

  it("still accepts zero, which means everything must be current", () => {
    const snapshot = buildFinanceDataGatewaySnapshot(staleInput(0));
    expect(snapshot.requiredNextSteps).toContain("refresh_or_label_stale_fields");
  });

  it("refuses a window that would silently remove the staleness check", () => {
    for (const freshnessMaxMinutes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => buildFinanceDataGatewaySnapshot(staleInput(freshnessMaxMinutes))).toThrow(
        /freshnessMaxMinutes must be a non-negative number/,
      );
    }
  });
});
