import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  readFinanceBrokerHistory,
  syncConfiguredAlpacaPaperHistory,
  syncAlpacaPaperHistory,
} from "./finance-alpaca-history-sync.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import {
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  appendFinanceBrokerHistory,
  readFinanceBrokerHistoryRecords,
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
          ? reply([{ id: "fee-1", activity_type: "JNLC", date: "2025-01-02", net_amount: "-0.01" }])
          : reply([
              {
                id: "partial",
                submitted_at: "2025-01-02T00:00:00Z",
                status: "partially_filled",
                filled_qty: "0.2",
              },
              {
                id: "cancel",
                submitted_at: "2025-01-02T00:00:00Z",
                status: "canceled",
                filled_qty: "0",
              },
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
    expect(read.records).toHaveLength(1);
    const history = await readFinanceBrokerHistory(options.directory, options.accountId);
    expect(history.facts.some((item) => item.fact.activity_type === "JNLC")).toBe(true);
    expect((await readFinanceBrokerHistory(options.directory, "other-account")).facts).toEqual([]);
  });
  it("keeps legacy main receipt/mark reader compatible and isolates venue", async () => {
    const options = await setup(async (url) =>
      url.endsWith("/account") ? reply({ id: "synthetic-account" }) : reply([]),
    );
    await appendFinancePositionMark(options.directory, {
      instrument: "SPY",
      price: 100,
      at: "2025-01-02T00:00:00Z",
    });
    await syncAlpacaPaperHistory(options);
    await appendFinanceBrokerHistory(options.directory, {
      kind: "broker_history",
      accountId: options.accountId,
      venue: "other:venue",
      query: "orders:other",
      cursor: "",
      payload: [{ id: "other-venue" }],
    });
    expect(
      (await readFinanceBrokerHistoryRecords(options.directory, options.accountId, "other:venue"))
        .records,
    ).toHaveLength(1);
    expect(
      (await readFinanceBrokerHistory(options.directory, options.accountId)).facts.some(
        (item) => item.fact.id === "other-venue",
      ),
    ).toBe(false);
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    const legacy = execFileSync(
      "git",
      ["show", "3f42be4d2b26b03db2eb70b4d256bd887d6eae3e:src/agents/finance-position-ledger.ts"],
      {
        cwd: sourceDir,
        encoding: "utf8",
      },
    );
    // Run the actual old module's strict parser, only relocating its imports.
    expect(legacy).not.toContain('z.literal("broker_history")');
    const relocated = legacy.replace(/from "(\.[^"]+)"/g, (_whole, relative: string) => {
      const target = path.resolve(sourceDir, relative.replace(/\.js$/, ".ts"));
      return `from "${pathToFileURL(target).href}"`;
    });
    const legacyPath = path.join(options.directory, "legacy-ledger.ts");
    await fs.writeFile(legacyPath, relocated);
    // Bare package resolution still comes from the existing installation, no install.
    await fs.symlink(
      path.resolve(sourceDir, "../../node_modules"),
      path.join(options.directory, "node_modules"),
    );
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const {readFinancePositionRecords}=await import(${JSON.stringify(pathToFileURL(legacyPath).href)}); const r=await readFinancePositionRecords(${JSON.stringify(options.directory)}); console.log(JSON.stringify({receipts:r.receipts.length,marks:r.marks.length}));`,
      ],
      { cwd: path.resolve(sourceDir, "../.."), encoding: "utf8" },
    );
    expect(JSON.parse(output.trim())).toEqual({ receipts: 0, marks: 1 });
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
            : Array.from({ length: 100 }, (_, i) => ({
                id: `activity-${i}`,
                activity_type: "FILL",
                transaction_time: "2025-01-02T00:00:00Z",
              })),
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
  it.each([{}, { id: "invalid" }])("rejects malformed short-page facts %j", async (row) => {
    const options = await setup(async (url) =>
      url.endsWith("/account") ? reply({ id: "synthetic-account" }) : reply([row]),
    );
    expect((await syncAlpacaPaperHistory(options)).status).toBe("incomplete");
    const history = await readFinanceBrokerHistory(options.directory, options.accountId);
    expect(history.facts.every((item) => item.stream === "sync_receipt")).toBe(true);
  });
  it("discovers account/start and uses fixed control clock with directory-scoped credentials", async () => {
    const urls: URL[] = [];
    const options = await setup(async (raw) => {
      const url = new URL(raw);
      urls.push(url);
      return url.pathname === "/v2/account"
        ? reply({ id: "synthetic-account", created_at: "2025-01-01T00:00:00Z" })
        : reply([]);
    });
    await fs.writeFile(
      path.join(options.directory, "credentials.env"),
      "ALPACA_API_KEY_ID=fake\nALPACA_API_SECRET_KEY=fake\n",
    );
    const result = await syncConfiguredAlpacaPaperHistory({
      directory: options.directory,
      env: {},
      read: options.read,
      now: () => new Date("2025-02-01T00:00:00Z"),
    });
    expect(result.accountId).toBe("synthetic-account");
    expect(result.after).toBe("2025-01-01T00:00:00Z");
    expect(result.until).toBe("2025-02-01T00:00:00.000Z");
    expect(urls.every((url) => url.hostname === "paper-api.alpaca.markets")).toBe(true);
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
