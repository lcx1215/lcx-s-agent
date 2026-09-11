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
        missingEvidence: expect.arrayContaining(["successful_finance_source_observation"]),
        notTouched: expect.arrayContaining(["trading_execution"]),
      }),
    );
    const receiptPath = (result.details as { receiptPath: string }).receiptPath;
    await expect(fs.stat(path.join(workspaceDir, receiptPath))).resolves.toBeDefined();
  });

  it("forwards a pre-aborted caller signal without dispatching a source request", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-realtime-cancelled-"));
    let fetchCalls = 0;
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, text: async () => quoteBody };
    };
    const controller = new AbortController();
    controller.abort(new Error("platform cancelled"));
    try {
      const tool = createFinanceRealtimeRefreshTool({ workspaceDir, fetchImpl });
      await expect(
        tool.execute(
          "cancelled",
          {
            instrument: "QQQ",
            assetClass: "etf",
            useCase: "tool_live_research",
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

  it("uses unique receipt paths for concurrent same-millisecond refreshes", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-realtime-concurrent-"));
    try {
      const tool = createFinanceRealtimeRefreshTool({ workspaceDir, fetchImpl: fakeFetch });
      const args = {
        instrument: "QQQ",
        assetClass: "etf",
        useCase: "tool_live_research",
        asOf: "2026-07-01T20:05:00.000Z",
        requireOfficialReference: false,
        liveFetch: true,
        writeReceipt: true,
      };
      const [first, second] = await Promise.all([
        tool.execute("same-ms-1", args),
        tool.execute("same-ms-2", args),
      ]);
      const firstPath = (first.details as { receiptPath: string }).receiptPath;
      const secondPath = (second.details as { receiptPath: string }).receiptPath;
      expect(firstPath).not.toBe(secondPath);
      await expect(fs.stat(path.join(workspaceDir, firstPath))).resolves.toBeDefined();
      await expect(fs.stat(path.join(workspaceDir, secondPath))).resolves.toBeDefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
