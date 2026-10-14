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
import { FinanceHttpBodyAbortError } from "./finance-http-body.js";
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
  it.each(["late_response", "read_rejection"] as const)(
    "stops cancelled history without writing a late page or sync receipt: %s",
    async (mode) => {
      const controller = new AbortController();
      const cancelled = new Error("synthetic history cancellation");
      const requests: string[] = [];
      const options = await setup(async (raw) => {
        const pathname = new URL(raw).pathname;
        requests.push(pathname);
        if (pathname === "/v2/account") {
          return reply({ id: "synthetic-account" });
        }
        controller.abort(cancelled);
        if (mode === "read_rejection") {
          throw cancelled;
        }
        return reply([]);
      });
      await expect(syncAlpacaPaperHistory({ ...options, signal: controller.signal })).rejects.toBe(
        cancelled,
      );
      expect(requests).toEqual(["/v2/account", "/v2/orders"]);
      expect(
        (
          await readFinanceBrokerHistoryRecords(
            options.directory,
            options.accountId,
            "alpaca:paper",
          )
        ).records,
      ).toEqual([]);
    },
  );

  it("stops cancelled history while retaining earlier pages and confirmed cleanup", async () => {
    const controller = new AbortController();
    const cleanup = new FinanceHttpBodyAbortError("confirmed");
    const requests: string[] = [];
    const options = await setup(async (raw) => {
      const pathname = new URL(raw).pathname;
      requests.push(pathname);
      if (pathname === "/v2/account") {
        return reply({ id: "synthetic-account" });
      }
      if (pathname === "/v2/orders") {
        return reply([{ id: "saved", submitted_at: "2025-01-02T00:00:00Z" }]);
      }
      controller.abort();
      throw cleanup;
    });
    await expect(syncAlpacaPaperHistory({ ...options, signal: controller.signal })).rejects.toBe(
      cleanup,
    );
    expect(requests).toEqual(["/v2/account", "/v2/orders", "/v2/account/activities"]);
    const history = await readFinanceBrokerHistoryRecords(
      options.directory,
      options.accountId,
      "alpaca:paper",
    );
    expect(history.records).toHaveLength(1);
    expect(history.records[0]?.body.payload).toEqual([
      { id: "saved", submitted_at: "2025-01-02T00:00:00Z" },
    ]);
    expect(history.records[0]?.body.query).toMatch(/^orders:/u);
  });
  it("retains only requested streams while reporting all unique observations and stale revisions", async () => {
    const { directory, accountId } = await setup(async () => reply([]));
    const append = (query: string, payload: Record<string, unknown>[]) =>
      appendFinanceBrokerHistory(directory, {
        kind: "broker_history",
        accountId,
        venue: "alpaca:paper",
        query,
        cursor: "",
        payload,
      });
    await append("orders:new", [
      { id: "same", updated_at: "2026-10-08T00:00:00Z", status: "filled" },
    ]);
    await append("orders:old", [{ id: "same", updated_at: "2026-10-07T00:00:00Z", status: "new" }]);
    await append("activities:partial", [{ id: "same", fragment: "useful incomplete evidence" }]);
    await append("reconciliation:large", [
      { observedAt: "2026-10-08T00:00:00Z", positions: [{ symbol: "SPY" }] },
    ]);
    await append("sync_receipt:complete", [{ status: "raw_history_synced" }]);
    const full = await readFinanceBrokerHistory(directory, accountId);
    const selected = await readFinanceBrokerHistory(directory, accountId, {
      streams: ["orders", "activities"],
    });
    expect(selected.facts).toEqual(
      full.facts.filter(({ stream }) => ["orders", "activities"].includes(stream)),
    );
    expect(selected).toMatchObject({
      pageCount: 5,
      totalFactCount: 4,
      observationCount: 3,
      omittedFactCount: 2,
      headRef: full.headRef,
    });
    expect(selected.facts[0]?.fact.status).toBe("filled");
    expect(selected.facts[1]?.fact.fragment).toBe("useful incomplete evidence");
    expect((await readFinanceBrokerHistory(directory, accountId, { streams: [] })).facts).toEqual(
      [],
    );
  });
  it("retains native parent legs and child facts without counting legs as pagination rows", async () => {
    const urls: URL[] = [];
    const options = await setup(async (raw) => {
      const url = new URL(raw);
      urls.push(url);
      return url.pathname === "/v2/account"
        ? reply({ id: "synthetic-account" })
        : url.pathname.endsWith("activities")
          ? reply([])
          : reply(
              Array.from({ length: 250 }, (_, i) => ({
                id: `entry-${i}`,
                submitted_at: "2025-01-02T00:00:00Z",
                order_class: "oto",
                legs: [{ id: `stop-${i}`, submitted_at: null, type: "stop", status: "held" }],
              })),
            );
    });
    const synced = await syncAlpacaPaperHistory(options);
    expect(synced.status).toBe("raw_history_synced");
    expect(synced.streams[0].pages).toBe(1);
    expect(urls.filter((url) => url.pathname === "/v2/orders")).toHaveLength(1);
    expect(urls.find((url) => url.pathname === "/v2/orders")?.searchParams.get("nested")).toBe(
      "true",
    );
    const history = await readFinanceBrokerHistory(options.directory, options.accountId);
    const orders = history.facts.filter(({ stream }) => stream === "orders");
    expect(orders).toHaveLength(500);
    expect(orders.find(({ fact }) => fact.id === "entry-0")?.fact.legs).toEqual([
      { id: "stop-0", submitted_at: null, type: "stop", status: "held" },
    ]);
    expect(orders.find(({ fact }) => fact.id === "stop-0")?.fact.status).toBe("held");
    expect((await readFinancePositionRecords(options.directory)).receipts).toHaveLength(0);
    await syncAlpacaPaperHistory(options);
    expect((await readFinanceBrokerHistory(options.directory, options.accountId)).facts).toEqual(
      history.facts,
    );
  });

  it.each([{ legs: [null] }, { legs: [{ type: "stop" }] }, { legs: "invalid" }])(
    "refuses malformed native child orders %j",
    async ({ legs }) => {
      const options = await setup(async (url) =>
        url.endsWith("/account")
          ? reply({ id: "synthetic-account" })
          : url.includes("/activities")
            ? reply([])
            : reply([{ id: "entry", submitted_at: "2025-01-02T00:00:00Z", legs }]),
      );
      expect((await syncAlpacaPaperHistory(options)).status).toBe("incomplete");
      expect(
        (await readFinanceBrokerHistory(options.directory, options.accountId)).facts.filter(
          ({ stream }) => stream === "orders",
        ),
      ).toEqual([]);
    },
  );

  it("projects the newest order revision without losing raw history or merging activity IDs", async () => {
    const options = await setup(async () => reply([]));
    const append = (query: string, fact: Record<string, unknown>) =>
      appendFinanceBrokerHistory(options.directory, {
        kind: "broker_history",
        accountId: options.accountId,
        venue: "alpaca:paper",
        query,
        cursor: "",
        payload: [fact],
      });
    await append("orders:first", {
      id: "same",
      status: "partially_filled",
      updated_at: "2025-01-02T00:00:00Z",
    });
    await append("orders:second", {
      id: "same",
      status: "filled",
      updated_at: "2025-01-02T00:01:00Z",
    });
    await append("orders:stale", { id: "same", status: "new", updated_at: "2025-01-01T00:00:00Z" });
    await append("orders:undated", { id: "same", status: "new" });
    await append("activities:first", { id: "same", activity_type: "FILL" });
    const history = await readFinanceBrokerHistory(options.directory, options.accountId);
    expect(history.facts.filter(({ stream }) => stream === "orders")).toEqual([
      {
        stream: "orders",
        fact: { id: "same", status: "filled", updated_at: "2025-01-02T00:01:00Z" },
      },
    ]);
    expect(history.facts.filter(({ stream }) => stream === "activities")).toHaveLength(1);
    expect(
      (await readFinanceBrokerHistoryRecords(options.directory, options.accountId, "alpaca:paper"))
        .records,
    ).toHaveLength(5);
    expect(history.positionsReconciled).toBe(false);
    expect(history.feesInterpreted).toBe(false);
  });
  it("uses the latest observation for undated activities and retains distinct fee identities", async () => {
    const options = await setup(async () => reply([]));
    for (const [cursor, payload] of [
      [
        "first",
        [
          { id: "fee", net_amount: "-0.01" },
          { id: "other", net_amount: "-0.01" },
        ],
      ],
      ["second", [{ id: "fee", net_amount: "-0.02" }]],
    ] as const) {
      await appendFinanceBrokerHistory(options.directory, {
        kind: "broker_history",
        accountId: options.accountId,
        venue: "alpaca:paper",
        query: "activities:test",
        cursor,
        payload: [...payload],
      });
    }
    const history = await readFinanceBrokerHistory(options.directory, options.accountId);
    expect(history.facts.map(({ fact }) => [fact.id, fact.net_amount])).toEqual([
      ["other", "-0.01"],
      ["fee", "-0.02"],
    ]);
  });

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
                type: "partial_fill",
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
  it.each([
    {},
    { id: "invalid" },
    {
      id: "fill-without-execution-type",
      activity_type: "FILL",
      transaction_time: "2025-01-02T00:00:00Z",
    },
    {
      id: "unsupported-fill-execution-type",
      activity_type: "FILL",
      type: "trade_bust",
      transaction_time: "2025-01-02T00:00:00Z",
    },
  ])("rejects malformed short-page facts %j", async (row) => {
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
        ? reply({
            id: "synthetic-account",
            created_at: "2025-01-01T00:00:00Z",
            currency: "USD",
            cash: "0",
          })
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
