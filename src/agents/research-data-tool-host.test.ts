import { describe, expect, it } from "vitest";
import { createResearchDataToolHost } from "./research-data-tool-host.js";
const host = createResearchDataToolHost({ workspaceDir: "/tmp/research-data-host-test" });
describe("shared research data host", () => {
  it("publishes existing tool schemas without credentials or a model binding", () => {
    const tools = host.list();
    expect(tools.map((t) => t.name)).toContain("finance_chart_analysis");
    expect(tools.map((t) => t.name)).toContain("finance_market_collection_refresh");
    expect(JSON.stringify(tools)).not.toContain("FMP_API_KEY");
  });
  it("rejects invalid model output and unknown tools before execution", async () => {
    await expect(host.execute({ tool: "shell", arguments: {} })).rejects.toThrow("unsupported");
    await expect(
      host.execute({ tool: "finance_market_collection_refresh", arguments: { liveFetch: true } }),
    ).rejects.toThrow("invalid");
    await expect(
      host.execute({
        tool: "finance_market_collection_refresh",
        arguments: {
          instrument: "AAPL",
          assetClass: "us_equity",
          collection: "company_profile",
          limit: -2,
        },
      }),
    ).rejects.toThrow("invalid");
  });
  it("runs the same chart analysis for an arbitrary caller without any model runtime", async () => {
    const result = await host.execute({
      tool: "finance_chart_analysis",
      arguments: {
        instrument: "TEST",
        bars: [
          { date: "2026-01-01", open: 10, high: 12, low: 9, close: 11 },
          { date: "2026-01-02", open: 11, high: 13, low: 10, close: 12 },
        ],
        liveFetch: false,
        writeReceipt: false,
      },
    });
    expect(result.details).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
  });
});
