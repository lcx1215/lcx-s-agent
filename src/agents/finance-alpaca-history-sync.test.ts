import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFinanceBrokerHistory, syncAlpacaPaperHistory } from "./finance-alpaca-history-sync.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import {
  appendFinanceExecutionReceipt,
  readFinancePositionRecords,
} from "./finance-position-ledger.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function setup(read: FinanceUncachedFetch) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpaca-history-"));
  dirs.push(directory);
  return {
    directory,
    accountId: "synthetic-account",
    after: "2025-01-01T00:00:00Z",
    until: "2025-02-01T00:00:00Z",
    credentials: { keyId: "fake", secretKey: "fake" },
    read,
  };
}
function reply(value: unknown) {
  return { status: 200, body: JSON.stringify(value) };
}
describe("Alpaca raw history sync", () => {
  it("stores partial fills, cancelled orders and fees without manufacturing receipts; replay is idempotent", async () => {
    const options = await setup(async (url) =>
      url.endsWith("/account")
        ? reply({ id: "synthetic-account" })
        : url.includes("/activities")
          ? reply([{ id: "fee-1", activity_type: "FEE", net_amount: "-0.01" }])
          : reply([
              { id: "partial", status: "partially_filled", filled_qty: "0.2" },
              { id: "cancel", status: "canceled", filled_qty: "0" },
            ]),
    );
    await appendFinanceExecutionReceipt(options.directory, {
      schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
      receiptId: "existing-spy",
      accountId: options.accountId,
      intentId: "existing",
      runAuthorizationId: "synthetic",
      adapterId: "alpaca",
      adapterKind: "venue",
      venue: "alpaca:paper",
      instrument: "SPY",
      side: "buy",
      orderType: "market",
      quantity: 1,
      referencePrice: 100,
      referencePriceAt: "2025-01-02T00:00:00Z",
      notional: 100,
      fill: {
        filledQuantity: 1,
        fillPrice: 100,
        filledAt: "2025-01-02T00:00:00Z",
        venueRef: "existing-spy",
        terminalOrderIdentity: { orderId: "existing-spy", terminal: true },
      },
      executionAuthority: "declared_execution_adapter_required",
      recordedAt: "2025-01-02T00:00:00Z",
    });
    expect((await syncAlpacaPaperHistory(options)).status).toBe("raw_history_synced");
    await syncAlpacaPaperHistory(options);
    const read = await readFinancePositionRecords(options.directory);
    expect(read.receipts).toHaveLength(1);
    expect(read.receipts[0]?.receiptId).toBe("existing-spy");
    expect(
      read.records.filter(
        (row) => row.body.kind === "broker_history" && !row.body.query.startsWith("sync_receipt"),
      ),
    ).toHaveLength(2);
    const history = await readFinanceBrokerHistory(options.directory, options.accountId);
    expect(history.facts.some((item) => item.fact.activity_type === "FEE")).toBe(true);
    expect((await readFinanceBrokerHistory(options.directory, "other-account")).facts).toEqual([]);
  });
  it("advances activity tokens and overlaps order timestamps until a short page", async () => {
    const urls: URL[] = [];
    const options = await setup(async (raw) => {
      const url = new URL(raw);
      urls.push(url);
      if (url.pathname === "/v2/account") {
        return reply({ id: "synthetic-account" });
      }
      if (url.pathname.endsWith("activities")) {
        return reply(
          url.searchParams.has("page_token")
            ? []
            : Array.from({ length: 100 }, (_, i) => ({ id: `activity-${i}` })),
        );
      }
      return reply(
        url.searchParams.get("after") === "2025-01-01T00:00:00Z"
          ? Array.from({ length: 500 }, (_, i) => ({
              id: `order-${i}`,
              submitted_at: "2025-01-02T00:00:00Z",
            }))
          : [],
      );
    });
    expect((await syncAlpacaPaperHistory(options)).status).toBe("raw_history_synced");
    expect(urls.some((url) => url.searchParams.get("page_token") === "activity-99")).toBe(true);
    expect(urls.some((url) => url.searchParams.get("after") === "2025-01-01T23:59:59.999Z")).toBe(
      true,
    );
  });
  it("preserves retrieved pages on stalled pagination and can rerun from the same window", async () => {
    let recovered = false;
    const options = await setup(async (url) =>
      url.endsWith("/account")
        ? reply({ id: "synthetic-account" })
        : url.includes("/activities")
          ? reply([])
          : reply(
              recovered
                ? []
                : Array.from({ length: 500 }, (_, i) => ({
                    id: `${i}`,
                    submitted_at: "2025-01-02T00:00:00Z",
                  })),
            ),
    );
    expect((await syncAlpacaPaperHistory(options)).status).toBe("incomplete");
    expect(
      (await readFinanceBrokerHistory(options.directory, options.accountId)).pageCount,
    ).toBeGreaterThan(0);
    recovered = true;
    expect((await syncAlpacaPaperHistory(options)).status).toBe("raw_history_synced");
  });
  it("does not write for another account; malformed endpoint data is incomplete", async () => {
    const wrong = await setup(async () => reply({ id: "other" }));
    await expect(syncAlpacaPaperHistory(wrong)).rejects.toThrow("identity mismatch");
    expect(await fs.readdir(wrong.directory)).toEqual([]);
    const malformed = await setup(async (url) =>
      url.endsWith("/account") ? reply({ id: "synthetic-account" }) : reply({ unsupported: true }),
    );
    expect((await syncAlpacaPaperHistory(malformed)).status).toBe("incomplete");
  });
});
