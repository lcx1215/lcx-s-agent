import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => vi.stubEnv("LCX_ENABLE_YAHOO_PUBLIC_SOURCE", "0"));

  it.each([
    {
      name: "enabled through the existing environment",
      env: "1",
      enabled: undefined,
      visible: true,
    },
    { name: "enabled by the existing caller option", env: "0", enabled: true, visible: true },
    {
      name: "explicitly disabled despite environment opt-in",
      env: "1",
      enabled: false,
      visible: false,
    },
    { name: "not enabled", env: "0", enabled: undefined, visible: false },
  ])(
    "propagates Yahoo's $name without advertising US fallbacks for FX",
    async ({ env, enabled, visible }) => {
      vi.stubEnv("LCX_ENABLE_YAHOO_PUBLIC_SOURCE", env);
      const fetchImpl = vi.fn<FetchImpl>();
      const result = await createFinanceRealtimeRefreshTool({
        workspaceDir: "/tmp/lcx-finance-yahoo-contract",
        fetchImpl,
        includeYahooPublicSource: enabled,
      }).execute("yahoo-inspection", {
        instrument: "EURUSD=X",
        assetClass: "fx",
        useCase: "tool_existing_source_opt_in",
        liveFetch: false,
        writeReceipt: false,
      });
      const details = result.details as {
        candidateAdapters: Array<{ id: string }>;
        noNetworkCalled: boolean;
      };
      const candidates = details.candidateAdapters.map((adapter) => adapter.id);
      expect(candidates.includes("yahoo_public_chart")).toBe(visible);
      expect(candidates).not.toContain("nasdaq_exchange_quote");
      expect(candidates).not.toContain("stooq_public_daily");
      expect(details.noNetworkCalled).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

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
        nextTool: "finance_data_gateway_snapshot",
        nextReviewTarget: "data_provenance_quality_review_input",
        retryOnlyAfter: "new_or_corrected_source_observations",
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

  it.each([
    { instrument: "QQQ", callId: "refresh-".repeat(50) },
    { instrument: "A".repeat(300), callId: "long-instrument" },
  ])("retains a receipt for long identifiers ($callId)", async ({ instrument, callId }) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-realtime-long-"));
    try {
      const tool = createFinanceRealtimeRefreshTool({ workspaceDir, fetchImpl: fakeFetch });
      const result = await tool.execute(callId, {
        instrument,
        assetClass: "etf",
        useCase: "tool_receipt_length",
        asOf: "2026-07-01T20:05:00.000Z",
        requireOfficialReference: false,
        liveFetch: true,
        writeReceipt: true,
      });
      const details = result.details as { receiptPath: string };
      expect(Buffer.byteLength(path.basename(details.receiptPath))).toBeLessThanOrEqual(255);
      const saved = JSON.parse(
        await fs.readFile(path.join(workspaceDir, details.receiptPath), "utf8"),
      );
      expect(saved.request.instrument).toBe(instrument);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.each(["mkdir", "write", "rename"])("honors cancellation during receipt %s", async (stage) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-realtime-cancel-"));
    const controller = new AbortController();
    const reason = new Error(`cancel during ${stage}`);
    try {
      if (stage === "mkdir") {
        const mkdir = fs.mkdir.bind(fs);
        vi.spyOn(fs, "mkdir").mockImplementationOnce(async (target, options) => {
          const result = await mkdir(target, options);
          controller.abort(reason);
          return result;
        });
      } else if (stage === "write") {
        const write = fs.writeFile.bind(fs);
        vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
          await write(...args);
          controller.abort(reason);
        });
      } else {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
          await rename(...args);
          controller.abort(reason);
        });
      }
      const tool = createFinanceRealtimeRefreshTool({ workspaceDir, fetchImpl: fakeFetch });
      await expect(
        tool.execute(
          "cancel-receipt",
          {
            instrument: "QQQ",
            assetClass: "etf",
            useCase: "tool_receipt_cancel",
            asOf: "2026-07-01T20:05:00.000Z",
            requireOfficialReference: false,
            liveFetch: true,
            writeReceipt: true,
          },
          controller.signal,
        ),
      ).rejects.toBe(reason);
      const directory = path.join(workspaceDir, "memory", "finance-data-gateway", "realtime");
      const files = await fs.readdir(directory);
      if (stage === "rename") {
        expect(files).toHaveLength(1);
        expect(
          JSON.parse(await fs.readFile(path.join(directory, files[0]), "utf8")).request.instrument,
        ).toBe("QQQ");
      } else {
        expect(files).toEqual([]);
      }
    } finally {
      vi.restoreAllMocks();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("cleans incomplete receipt writes without publishing partial JSON", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-realtime-partial-"));
    const write = fs.writeFile.bind(fs);
    try {
      vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
        await write(file, '{"partial":');
        throw new Error("synthetic disk failure");
      });
      const tool = createFinanceRealtimeRefreshTool({ workspaceDir, fetchImpl: fakeFetch });
      await expect(
        tool.execute("partial-receipt", {
          instrument: "QQQ",
          assetClass: "etf",
          useCase: "tool_receipt_partial",
          asOf: "2026-07-01T20:05:00.000Z",
          requireOfficialReference: false,
          liveFetch: true,
          writeReceipt: true,
        }),
      ).rejects.toThrow("synthetic disk failure");
      expect(
        await fs.readdir(path.join(workspaceDir, "memory", "finance-data-gateway", "realtime")),
      ).toEqual([]);
    } finally {
      vi.restoreAllMocks();
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
