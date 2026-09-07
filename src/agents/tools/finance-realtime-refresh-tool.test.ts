import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchImpl } from "../finance-live-market-source.js";
import { createFinanceRealtimeRefreshTool } from "./finance-realtime-refresh-tool.js";

const quoteBody = JSON.stringify({
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
});

const fakeFetch: FetchImpl = async () => ({
  ok: true,
  status: 200,
  text: async () => quoteBody,
});

describe("finance_realtime_source_refresh tool", () => {
  it("defaults to a no-network source inspection", async () => {
    const tool = createFinanceRealtimeRefreshTool({ workspaceDir: "/tmp/lcx-finance" });
    const result = await tool.execute("dry-1", {
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "tool_dry_run",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        liveFetch: false,
        noNetworkCalled: true,
        nextAction: expect.stringContaining("liveFetch=true"),
      }),
    );
  });

  it("writes an honest blocked receipt when the live source lacks cross-check evidence", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-realtime-tool-"));
    const tool = createFinanceRealtimeRefreshTool({ workspaceDir, fetchImpl: fakeFetch });
    const result = await tool.execute("live-1", {
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "tool_live_research",
      asOf: "2026-07-01T20:05:00.000Z",
      requireOfficialReference: false,
      liveFetch: true,
      writeReceipt: true,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        status: "blocked",
        receiptPath: expect.stringContaining("memory/finance-data-gateway/realtime/"),
        missingEvidence: expect.arrayContaining(["cross_check_market_data_provider"]),
        notTouched: expect.arrayContaining(["trading_execution"]),
      }),
    );
    const receiptPath = (result.details as { receiptPath: string }).receiptPath;
    await expect(fs.stat(path.join(workspaceDir, receiptPath))).resolves.toBeDefined();
  });
});
