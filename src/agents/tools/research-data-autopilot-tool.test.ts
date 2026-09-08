import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FetchImpl } from "../finance-live-market-source.js";
import { createResearchDataAutopilotTool } from "./research-data-autopilot-tool.js";

const fakeFetch: FetchImpl = async (url) => {
  if (url.includes("news.google.com/rss/search")) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        `<?xml version="1.0"?><rss><channel><item><title>Google AAPL</title><link>https://example.test/google-aapl</link><pubDate>Mon, 07 Sep 2026 13:00:00 GMT</pubDate></item></channel></rss>`,
    };
  }
  if (url.includes("feeds.finance.yahoo.com/rss/2.0/headline")) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        `<?xml version="1.0"?><rss><channel><item><title>Yahoo AAPL</title><link>https://example.test/yahoo-aapl</link><pubDate>Mon, 07 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>`,
    };
  }
  if (url.includes("api.gdeltproject.org/api/v2/doc/doc")) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          articles: [
            {
              url: "https://example.test/autopilot-news",
              title: "Autopilot news",
              seendate: "20260907T130000Z",
            },
          ],
        }),
    };
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({}),
  };
};

describe("research_data_autopilot tool", () => {
  it("inspects the canonical quote registry without choosing a provider manually", async () => {
    const tool = createResearchDataAutopilotTool({ workspaceDir: "/tmp/lcx-autopilot" });
    const result = await tool.execute("inspect-1", {
      intent: "quote",
      target: "AAPL",
      liveFetch: false,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        autoSelectedSources: true,
        liveFetch: false,
        result: expect.objectContaining({
          noNetworkCalled: true,
          candidateAdapters: expect.arrayContaining([
            expect.objectContaining({ id: "yahoo_public_chart" }),
            expect.objectContaining({ id: "sec_edgar_companyfacts" }),
          ]),
        }),
      }),
    );
  });

  it("autonomously routes public news through the registry and returns its receipt", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-autopilot-tool-"));
    const tool = createResearchDataAutopilotTool({ workspaceDir, fetchImpl: fakeFetch });
    const result = await tool.execute("live-1", {
      intent: "news",
      target: "AAPL",
      liveFetch: true,
      writeReceipt: true,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        autoSelectedSources: true,
        result: expect.objectContaining({
          status: "ready",
          selectedSourceIds: ["gdelt_public_news", "google_news_rss", "yahoo_finance_rss"],
        }),
        receiptPath: expect.stringContaining("memory/research-data-autopilot/"),
      }),
    );
    const receiptPath = (result.details as { receiptPath: string }).receiptPath;
    await expect(fs.stat(path.join(workspaceDir, receiptPath))).resolves.toBeDefined();
  });
});

it("makes extended financial datasets available through the agent-facing router", async () => {
  vi.stubEnv("FMP_API_KEY", "fixture-key");
  try {
    const tool = createResearchDataAutopilotTool({ workspaceDir: "/tmp/lcx-autopilot" });
    const result = await tool.execute("holdings-inspect", {
      intent: "etf_holdings",
      target: "SPY",
      liveFetch: false,
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          noNetworkCalled: true,
          candidateAdapters: expect.arrayContaining([
            expect.objectContaining({ id: "fmp_etf_holdings" }),
          ]),
        }),
      }),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
