import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchImpl } from "../finance-live-market-source.js";
import * as collectionRegistry from "../finance-market-collection-registry.js";
import type { AnyAgentTool } from "./common.js";
import { createFinanceChartAnalysisTool } from "./finance-chart-analysis-tool.js";

beforeEach(() => {
  vi.stubEnv("LCX_ENABLE_YAHOO_PUBLIC_SOURCES", "1");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const fakeFetch: FetchImpl = async (url) => {
  if (url.includes("query2.finance.yahoo.com/v8/finance/chart/AAPL")) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          chart: {
            result: [
              {
                timestamp: Array.from(
                  { length: 3 },
                  (_unused, index) => 1_788_523_200 + index * 86_400,
                ),
                indicators: {
                  quote: [
                    {
                      open: [100, 101, 102],
                      high: [101, 102, 103],
                      low: [99, 100, 101],
                      close: [100, 101, 102],
                      volume: [1000, 1100, 1200],
                    },
                  ],
                },
              },
            ],
            error: null,
          },
        }),
    };
  }
  return { ok: false, status: 404, text: async () => "not found" };
};

function directBars() {
  return Array.from({ length: 21 }, (_unused, index) => {
    const close = 100 + index;
    return {
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      open: close - 1,
      high: close + 1,
      low: close - 2,
      close,
      volume: 1_000 + index * 10,
    };
  });
}

describe("finance_chart_analysis tool", () => {
  it.each([
    {
      window: { asOf: "2026-01-10T00:00:00.000Z" },
      count: 10,
      first: "2026-01-01",
      last: "2026-01-10",
    },
    { window: { fromDate: "2026-01-10" }, count: 12, first: "2026-01-10", last: "2026-01-21" },
    { window: { toDate: "2026-01-10" }, count: 10, first: "2026-01-01", last: "2026-01-10" },
    { window: { asOf: "2025-12-31T23:59:59.000Z" }, count: 0, first: undefined, last: undefined },
  ])(
    "keeps supplied bars inside the requested window $window",
    async ({ window, count, first, last }) => {
      const result = await createFinanceChartAnalysisTool().execute("supplied-window", {
        instrument: "AAPL",
        ...window,
        includeBars: true,
        bars: directBars().map((bar) => ({
          ...bar,
          providerName: "fixture",
          sourceTimestamp: `${bar.date}T00:00:00.000Z`,
        })),
      });
      expect(result.details).toMatchObject({
        status: count >= 2 ? "needs_review" : "blocked",
        normalizedBarCount: count,
        droppedBarCount: 21 - count,
        sourceReceipt: {
          missingEvidence: expect.arrayContaining(["supplied_bars_outside_requested_window"]),
        },
      });
      const details = result.details as { bars: Array<{ date: string }> };
      expect(details.bars[0]?.date).toBe(first);
      expect(details.bars.at(-1)?.date).toBe(last);
    },
  );

  it("does not let an out-of-window provider choose the supplied source series", async () => {
    const rows = directBars();
    const result = await createFinanceChartAnalysisTool().execute("eligible-series", {
      instrument: "AAPL",
      asOf: "2026-01-10T00:00:00.000Z",
      bars: [
        { ...rows[20], providerName: "future-only" },
        ...rows.slice(0, 2).map((bar) => ({ ...bar, providerName: "eligible" })),
      ],
    });
    expect(result.details).toMatchObject({
      status: "needs_review",
      normalizedBarCount: 2,
      droppedBarCount: 1,
      analysis: { features: { totalReturnPct: expect.closeTo(1, 6) } },
    });
  });

  it("reports actual timestamp extrema across interleaved source records", async () => {
    const rows = [2, 0, 3, 1].map((index, order) => ({
      providerName: order < 2 ? "a" : "b",
      sourceTimestamp: `2026-01-0${index + 1}T00:00:00.000Z`,
      delayStatus: "end_of_day",
      sourceUrlOrArtifact: "fixture:chart",
      data: directBars()[index],
    }));
    vi.spyOn(collectionRegistry, "runFinanceMarketCollectionRefresh").mockResolvedValue({
      status: "ready",
      selectedSourceIds: ["fixture-a", "fixture-b"],
      records: rows,
      sourceAttempts: [],
      missingEvidence: [],
      requiredNextSteps: [],
    } as unknown as Awaited<
      ReturnType<typeof collectionRegistry.runFinanceMarketCollectionRefresh>
    >);
    const result = await createFinanceChartAnalysisTool().execute("source-range", {
      instrument: "AAPL",
      liveFetch: true,
      asOf: "2026-01-10T00:00:00.000Z",
    });
    expect(result.details).toMatchObject({
      sourceReceipt: {
        sourceTimestampRange: {
          first: "2026-01-01T00:00:00.000Z",
          last: "2026-01-04T00:00:00.000Z",
        },
      },
    });
  });

  it("does not report a currency switch as investment return", async () => {
    const tool = createFinanceChartAnalysisTool({ workspaceDir: "/tmp/lcx-chart-tool" });
    const records = directBars()
      .slice(0, 6)
      .map((row, index) => {
        const close = index < 3 ? 100 + index : 800 + index;
        return {
          providerName: "same-provider",
          data: {
            ...row,
            currency: index < 3 ? "USD" : "HKD",
            open: close - 1,
            high: close + 1,
            low: close - 2,
            close,
          },
        };
      });
    const result = await tool.execute("currency-boundary", {
      instrument: "AAPL",
      bars: records,
      writeReceipt: false,
    });
    expect(result.details).toMatchObject({
      status: "needs_review",
      normalizedBarCount: 3,
      droppedBarCount: 3,
      analysis: { features: { totalReturnPct: expect.closeTo(2, 6) } },
    });
  });

  it("analyzes provided bars and writes an inspectable receipt", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-chart-tool-"));
    const tool = createFinanceChartAnalysisTool({ workspaceDir });
    const result = await tool.execute("direct-1", {
      instrument: "AAPL",
      bars: directBars(),
      writeReceipt: true,
    });
    const details = result.details as {
      status: string;
      analysis: { features: { sma20?: number } };
      sourceReceipt: { missingEvidence?: readonly string[] };
      receiptPath: string;
    };
    expect(details.status).toBe("needs_review");
    expect(details.sourceReceipt).toEqual(
      expect.objectContaining({ missingEvidence: ["supplied_bars_provenance"] }),
    );
    expect(details.analysis.features.sma20).toBeCloseTo(110.5, 6);
    await expect(fs.stat(path.join(workspaceDir, details.receiptPath))).resolves.toBeDefined();
  });

  it("routes live history through the canonical source registry", async () => {
    const tool = createFinanceChartAnalysisTool({
      workspaceDir: "/tmp/lcx-chart-tool",
      fetchImpl: fakeFetch,
    });
    const result = await tool.execute("live-1", {
      instrument: "AAPL",
      asOf: "2026-09-07T14:00:00.000Z",
      limit: 10,
      liveFetch: true,
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "ready",
        normalizedBarCount: 3,
        sourceReceipt: expect.objectContaining({
          selectedSourceIds: expect.arrayContaining(["yahoo_public_eod_history"]),
        }),
      }),
    );
  });

  it("attaches an image block for a native vision handoff", async () => {
    const tool = createFinanceChartAnalysisTool({
      workspaceDir: "/tmp/lcx-chart-tool",
      modelHasVision: true,
      nativeVisionModelRef: "openai/gpt-5-mini",
    });
    const result = await tool.execute("image-1", {
      instrument: "AAPL",
      bars: directBars(),
      image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        visual: expect.objectContaining({
          imageAttached: true,
          handoff: "native_vision_can_review_the_attached_image",
          provenance: expect.objectContaining({
            schemaVersion: "lcx_finance_chart_visual_provenance_v1",
            imageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            promptContract: "lcx_finance_chart_native_handoff_v1",
            execution: "native_vision_handoff",
            provider: "openai",
            model: "gpt-5-mini",
            latencyMs: null,
            uncertainty: "pending_native_model_review",
          }),
        }),
      }),
    );
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
  });

  it("uses the configured image tool when the primary model has no vision", async () => {
    let visionCalls = 0;
    let visionImage: unknown;
    const visionTool = {
      execute: async (_toolCallId: unknown, args: unknown) => {
        visionCalls += 1;
        visionImage = (args as { image?: unknown }).image;
        return {
          content: [{ type: "text", text: "visible chart context" }],
          details: { model: "test-vlm" },
        };
      },
    } as unknown as AnyAgentTool;
    const tool = createFinanceChartAnalysisTool({
      workspaceDir: "/tmp/lcx-chart-tool",
      modelHasVision: false,
      visionTool,
    });
    const result = await tool.execute("image-2", {
      instrument: "AAPL",
      bars: directBars(),
      image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
    });
    expect(visionCalls).toBe(1);
    expect(visionImage).toBe(`data:image/png;base64,${ONE_PIXEL_PNG_B64}`);
    expect(result.details).toEqual(
      expect.objectContaining({
        visual: expect.objectContaining({
          imageLoaded: true,
          imageAttached: false,
          handoff: "configured_vision_tool_completed",
          visionAnalysis: expect.objectContaining({ text: "visible chart context" }),
          provenance: expect.objectContaining({
            schemaVersion: "lcx_finance_chart_visual_provenance_v1",
            imageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            promptContract: "lcx_finance_chart_visual_review_v1",
            execution: "configured_vision_tool",
            provider: null,
            model: "test-vlm",
            latencyMs: expect.any(Number),
            uncertainty: "reported_in_unstructured_model_text",
          }),
        }),
      }),
    );
  });
});

it("rejects an unknown source before fetching a chart", async () => {
  let called = false;
  const tool = createFinanceChartAnalysisTool({
    workspaceDir: "/tmp/chart-source-selection",
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected fetch");
    },
  });
  await expect(
    tool.execute("unknown-source", {
      instrument: "AAPL",
      sourceIds: ["not-a-registered-source"],
      liveFetch: true,
    }),
  ).rejects.toThrow("unknown finance chart source adapter");
  expect(called).toBe(false);
});
