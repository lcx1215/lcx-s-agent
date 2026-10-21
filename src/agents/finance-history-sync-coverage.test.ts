import { expect, it } from "vitest";
import { financeBrokerHistoryCoverage } from "./finance-history-sync-coverage.js";

const seal = {
  accountId: "account",
  venue: "alpaca:paper",
  status: "raw_history_synced",
  accountCreatedAt: "2025-01-01T00:00:00Z",
  after: "2024-12-31T00:00:00Z",
  until: "2025-02-01T00:00:00Z",
};
it("admits inception-wide history through the exact requested cutoff", () => {
  expect(
    financeBrokerHistoryCoverage(seal, "account", ["2025-01-02T15:00:00Z"], seal.until),
  ).toMatchObject({ through: "2025-02-01T00:00:00.000Z" });
});
it.each([
  { after: "2025-01-02T00:00:00Z" },
  { accountCreatedAt: undefined },
  { accountId: "other" },
  { venue: "alpaca:live" },
  { status: "incomplete" },
  { after: seal.until },
  { until: "2024-12-30T00:00:00Z" },
  { until: "2099-01-01T00:00:00Z" },
  { after: "2024-12-31T00:00:00" },
  { accountCreatedAt: "2025-02-30T00:00:00Z" },
  { until: "invalid" },
])("holds invalid/narrow/missing coverage %j", (change) => {
  expect(financeBrokerHistoryCoverage({ ...seal, ...change }, "account", [])).toBeUndefined();
});
it.each(["2024-12-31T12:00:00Z", "2025-02-02T00:00:00Z", "invalid"])(
  "rejects known quantity evidence outside coverage: %s",
  (event) => {
    expect(financeBrokerHistoryCoverage(seal, "account", [event])).toBeUndefined();
  },
);
it("holds an old seal when the caller requires later coverage", () => {
  expect(financeBrokerHistoryCoverage(seal, "account", [], "2025-02-01T00:00:01Z")).toBeUndefined();
});
it("keeps legacy status-only receipts non-authoritative", () => {
  expect(
    financeBrokerHistoryCoverage({ status: "raw_history_synced" }, "account", []),
  ).toBeUndefined();
});
