import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchImpl } from "../finance-live-market-source.js";
import type { AnyAgentTool } from "./common.js";
import { createFinanceChartAnalysisTool } from "./finance-chart-analysis-tool.js";

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
      receiptPath: string;
    };
    expect(details.status).toBe("ready");
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
          selectedSourceIds: ["yahoo_public_eod_history"],
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
    const visionTool = {
      execute: async () => {
        visionCalls += 1;
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
