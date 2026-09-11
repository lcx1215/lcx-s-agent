import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchImpl } from "../finance-live-market-source.js";
import { createFinanceMarketCollectionRefreshTool } from "./finance-market-collection-refresh-tool.js";

describe("finance_market_collection_refresh tool", () => {
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
