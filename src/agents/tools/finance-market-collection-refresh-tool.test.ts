import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchImpl } from "../finance-live-market-source.js";
import { createFinanceMarketCollectionRefreshTool } from "./finance-market-collection-refresh-tool.js";

describe("finance_market_collection_refresh tool", () => {
  it("preserves caller cancellation identity when cancelled during collection", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-collection-abort-"));
    const controller = new AbortController();
    const reason = new DOMException("host deadline", "AbortError");
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls++;
      controller.abort(reason);
      throw reason;
    };
    try {
      const tool = createFinanceMarketCollectionRefreshTool({ workspaceDir, fetchImpl });
      await expect(
        tool.execute(
          "during-collection",
          {
            instrument: "BTC",
            assetClass: "crypto",
            collection: "options_chain",
            asOfMode: "live_now",
            sourceIds: ["deribit_public_option_summary"],
            liveFetch: true,
            writeReceipt: true,
          },
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(calls).toBe(1);
      await expect(fs.stat(path.join(workspaceDir, "memory"))).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
  it("does not dispatch or write a receipt after caller cancellation", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "finance-market-collection-cancelled-"),
    );
    let fetchCalls = 0;
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ Symbol: "AAPL" }) };
    };
    const controller = new AbortController();
    controller.abort(new Error("platform cancelled"));
    try {
      const tool = createFinanceMarketCollectionRefreshTool({ workspaceDir, fetchImpl });
      await expect(
        tool.execute(
          "cancelled",
          {
            instrument: "AAPL",
            assetClass: "us_equity",
            collection: "company_profile",
            liveFetch: true,
            writeReceipt: true,
          },
          controller.signal,
        ),
      ).rejects.toThrow("platform cancelled");
      expect(fetchCalls).toBe(0);
      await expect(fs.stat(path.join(workspaceDir, "memory"))).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

it("passes live-now Deribit evidence through the original tool and retains exact raw bytes", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-deribit-tool-"));
  const body = JSON.stringify({
    jsonrpc: "2.0",
    result: [
      {
        instrument_name: "BTC-30OCT26-100000-C",
        base_currency: "BTC",
        quote_currency: "BTC",
        creation_timestamp: Date.now(),
        mark_price: 0.025,
        open_interest: 12,
        mark_iv: 50,
      },
    ],
  });
  let fetchCalls = 0;
  const fetchImpl: FetchImpl = async () => {
    fetchCalls++;
    return { ok: true, status: 200, text: async () => body };
  };
  try {
    const tool = createFinanceMarketCollectionRefreshTool({ workspaceDir, fetchImpl });
    const base = {
      instrument: "BTC",
      assetClass: "crypto",
      collection: "options_chain",
      sourceIds: ["deribit_public_option_summary"],
      liveFetch: true,
      writeReceipt: true,
    };
    const historical = await tool.execute("historical", { ...base, asOfMode: "historical" });
    expect((historical.details as { status: string }).status).toBe("blocked");
    expect(fetchCalls).toBe(0);
    const result = await tool.execute("live", { ...base, asOfMode: "live_now" });
    const payload = result.details as {
      status: string;
      receiptPath: string;
      records: {
        sourceUrlOrArtifact: string;
        data: { sourceResponseSha256: string; mark_iv: number };
      }[];
    };
    expect(payload.status).toBe("ready");
    expect(payload.records[0].data.mark_iv).toBe(50);
    expect(fetchCalls).toBe(1);
    const raw = await fs.readFile(
      path.join(workspaceDir, payload.records[0].sourceUrlOrArtifact),
      "utf8",
    );
    expect(raw).toBe(body);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      payload.records[0].data.sourceResponseSha256,
    );
    const saved = JSON.parse(
      await fs.readFile(path.join(workspaceDir, payload.receiptPath), "utf8"),
    );
    expect(saved.request.asOfMode).toBe("live_now");
    expect(saved.records[0].data.mark_iv).toBe(50);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
