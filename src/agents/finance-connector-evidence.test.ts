import { describe, expect, it } from "vitest";
import { mapConnectorPayloadToObservation } from "./finance-connector-evidence.js";

const SEC_PAYLOAD = {
  name: "Apple Inc.",
  tickers: ["AAPL"],
  sic: "3571",
  filings: {
    recent: {
      form: ["4", "4", "3"],
      filingDate: ["2026-09-17", "2026-09-10", "2026-09-01"],
    },
  },
};

describe("connector payload to gateway evidence", () => {
  it("maps a live-shaped SEC submissions payload into gated fields", () => {
    const mapped = mapConnectorPayloadToObservation({
      connectorId: "sec_edgar_rest",
      payload: SEC_PAYLOAD,
      sourceUrlOrArtifact: "https://data.sec.gov/submissions/CIK0000320193.json",
      observedAt: "2026-09-20T00:00:00.000Z",
    });
    expect(mapped.unmappedReason).toBeUndefined();
    const observation = mapped.observation;
    expect(observation).toBeDefined();
    expect(observation?.providerRole).toBe("official_or_issuer_reference");
    expect(observation?.sourceFamily).toBe("official_filing");
    const byName = new Map((observation?.fields ?? []).map((field) => [field.name, field]));
    expect(byName.get("recent_filing_count")?.value).toBe(3);
    expect(byName.get("latest_filing_date")?.value).toBe("2026-09-17");
    expect(byName.get("latest_filing_form")?.value).toBe("4");
    expect(byName.get("registrant_name")?.value).toBe("Apple Inc.");
    for (const value of byName.values()) {
      expect(value.fieldDefinition).toBeTruthy();
      expect(value.sourceUrlOrArtifact).toMatch(/^https:\/\//);
      expect(Number.isFinite(Date.parse(value.sourceTimestamp))).toBe(true);
    }
  });

  it("falls back to the collection instant when the payload carries no event date", () => {
    const mapped = mapConnectorPayloadToObservation({
      connectorId: "sec_edgar_rest",
      payload: { name: "No Filings Co", filings: { recent: {} } },
      sourceUrlOrArtifact: "https://data.sec.gov/submissions/CIK9999999999.json",
      observedAt: "2026-09-20T00:00:00.000Z",
    });
    const fields = mapped.observation?.fields ?? [];
    expect(fields.every((entry) => entry.sourceTimestamp === "2026-09-20T00:00:00.000Z")).toBe(
      true,
    );
    expect(fields.some((entry) => entry.name === "latest_filing_date")).toBe(false);
  });

  it("reports connectors without a declared mapping instead of inventing fields", () => {
    const mapped = mapConnectorPayloadToObservation({
      connectorId: "factset_mcp",
      payload: { anything: 1 },
      sourceUrlOrArtifact: "https://mcp.factset.com/mcp",
    });
    expect(mapped.observation).toBeUndefined();
    expect(mapped.unmappedReason).toBe("no_field_mapping_declared_for_this_connector");
  });
});
