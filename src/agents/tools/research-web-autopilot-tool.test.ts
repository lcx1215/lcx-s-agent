import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { createResearchWebAutopilotTool } from "./research-web-autopilot-tool.js";

function stubTool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute,
  } as unknown as AnyAgentTool;
}

describe("research_web_autopilot tool", () => {
  it("searches, opens original URLs, marks primary references, and writes a receipt", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-web-autopilot-"));
    const searchTool = stubTool("web_search", async () =>
      jsonResult({
        provider: "test-search",
        results: [
          {
            title: "SEC filing",
            url: "https://www.sec.gov/Archives/edgar/data/example",
            description: "Primary filing lead",
          },
          {
            title: "Secondary article",
            url: "https://example.test/article",
            description: "Secondary lead",
          },
        ],
      }),
    );
    const fetchTool = stubTool("web_fetch", async (_callId, args) => {
      const url = (args as { url: string }).url;
      return jsonResult({
        url,
        finalUrl: url,
        status: 200,
        title: url.includes("sec.gov") ? "SEC filing" : "Secondary article",
        contentType: "text/markdown",
        extractor: "test",
        fetchedAt: "2026-09-07T14:00:00.000Z",
        text: `Opened evidence for ${url}`,
      });
    });
    const tool = createResearchWebAutopilotTool({
      workspaceDir,
      searchTool,
      fetchTool,
    });
    const result = await tool.execute("web-1", {
      query: "AAPL latest filing",
      openTop: 2,
      requirePrimary: true,
      writeReceipt: true,
    });
    const details = result.details as {
      status: string;
      search: { provider: string };
      openedDocuments: unknown[];
      crossCheck: { hasPrimary: boolean };
      receiptPath: string;
    };
    expect(details.status).toBe("ready");
    expect(details.search.provider).toBe("test-search");
    expect(details.openedDocuments).toHaveLength(2);
    expect(details.crossCheck.hasPrimary).toBe(true);
    await expect(fs.stat(path.join(workspaceDir, details.receiptPath))).resolves.toBeDefined();
  });

  it("keeps failed fetches visible and downgrades a partial evidence run", async () => {
    const fetchTool = stubTool("web_fetch", async (_callId, args) => {
      const url = (args as { url: string }).url;
      if (url.includes("broken")) {
        throw new Error("timeout");
      }
      return jsonResult({
        url,
        status: 200,
        text: "healthy evidence",
        fetchedAt: "2026-09-07T14:00:00Z",
      });
    });
    const tool = createResearchWebAutopilotTool({
      searchTool: stubTool("web_search", async () =>
        jsonResult({
          provider: "test-search",
          results: [
            { url: "https://example.test/broken", title: "broken" },
            { url: "https://example.test/healthy", title: "healthy" },
          ],
        }),
      ),
      fetchTool,
    });
    const result = await tool.execute("web-2", { query: "partial", openTop: 2 });
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "needs_review",
        openedDocuments: [expect.objectContaining({ url: "https://example.test/healthy" })],
        failures: [expect.objectContaining({ stage: "fetch", url: "https://example.test/broken" })],
      }),
    );
  });

  it("supports a no-network inspection path", async () => {
    const searchExecute = vi.fn();
    const tool = createResearchWebAutopilotTool({
      searchTool: stubTool("web_search", searchExecute),
      fetchTool: null,
    });
    const result = await tool.execute("web-3", { query: "inspect only", liveFetch: false });
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "inspection",
        plan: expect.objectContaining({ searchToolAvailable: true, fetchToolAvailable: false }),
      }),
    );
    expect(searchExecute).not.toHaveBeenCalled();
  });

  it("downgrades primary evidence after a cross-origin redirect", async () => {
    const tool = createResearchWebAutopilotTool({
      searchTool: stubTool("web_search", async () =>
        jsonResult({
          provider: "test-search",
          results: [{ url: "https://www.sec.gov/Archives/edgar/data/example", title: "filing" }],
        }),
      ),
      fetchTool: stubTool("web_fetch", async () =>
        jsonResult({
          status: 200,
          finalUrl: "https://example.test/redirected",
          text: "redirected evidence",
        }),
      ),
    });
    const result = await tool.execute("web-redirect", {
      query: "filing",
      openTop: 1,
      requirePrimary: true,
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "needs_review",
        openedDocuments: [expect.objectContaining({ isLikelyPrimary: false })],
      }),
    );
  });

  it("uses the guarded public search fallback when the configured provider has no key", async () => {
    const fetchedUrls: string[] = [];
    const fetchTool = stubTool("web_fetch", async (_callId, args) => {
      const url = (args as { url: string }).url;
      fetchedUrls.push(url);
      if (url.includes("html.duckduckgo.com/html")) {
        return jsonResult({
          url,
          status: 200,
          fetchedAt: "2026-09-07T14:00:00.000Z",
          text: "[SEC source](https://www.sec.gov/Archives/edgar/data/example)",
        });
      }
      return jsonResult({
        url,
        status: 200,
        fetchedAt: "2026-09-07T14:00:00.000Z",
        text: "opened public source",
      });
    });
    const tool = createResearchWebAutopilotTool({
      searchTool: stubTool("web_search", async () =>
        jsonResult({ error: "missing_brave_api_key", message: "configure a key" }),
      ),
      fetchTool,
    });
    const result = await tool.execute("web-4", {
      query: "AAPL filing",
      openTop: 1,
      requirePrimary: true,
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "needs_review",
        search: expect.objectContaining({
          publicFallback: expect.objectContaining({ used: true, candidateCount: 1 }),
        }),
        openedDocuments: [expect.objectContaining({ isLikelyPrimary: true })],
      }),
    );
    expect(fetchedUrls[0]).toContain("html.duckduckgo.com/html");
  });
});
