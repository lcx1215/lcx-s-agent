import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { createResearchWebAutopilotTool } from "./research-web-autopilot-tool.js";
import { extractReadableContent } from "./web-fetch-utils.js";
import { installWebFetchSsrfHarness } from "./web-fetch.test-harness.js";
import { createWebFetchTool } from "./web-tools.js";

vi.mock("./web-fetch-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./web-fetch-utils.js")>("./web-fetch-utils.js");
  return { ...actual, extractReadableContent: vi.fn().mockResolvedValue(null) };
});

installWebFetchSsrfHarness();
beforeEach(() => vi.mocked(extractReadableContent).mockResolvedValue(null));

async function run(metadata: Record<string, unknown>, requirePrimary = true) {
  const requested = "https://www.sec.gov/Archives/fixture-source";
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.firecrawl.dev")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { markdown: "Replacement body from the extractor.", metadata },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("<html><body></body></html>", {
      headers: { "content-type": "text/html" },
    });
  });
  globalThis.fetch = withFetchPreconnect(fetch);
  const fetchTool = createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            firecrawl: { enabled: true, apiKey: "offline-fixture" },
          },
        },
      },
    },
  });
  if (!fetchTool) {
    throw new Error("fixture fetch tool unavailable");
  }
  const searchTool: AnyAgentTool = {
    name: "fixture_search",
    label: "fixture",
    description: "fixture",
    parameters: {},
    execute: async () => jsonResult({ results: [{ url: requested, title: "Official lead" }] }),
  };
  const tool = createResearchWebAutopilotTool({ searchTool, fetchTool });
  const result = await tool.execute("provenance", { query: "filing", requirePrimary, openTop: 1 });
  expect(fetch).toHaveBeenCalledTimes(2);
  return result;
}

describe("canonical extraction fallback into research source admission", () => {
  it("uses the replacement body's source instead of the original official lead", async () => {
    const result = await run({ sourceURL: "https://example.test/replacement", statusCode: 200 });
    expect(result.details).toMatchObject({
      status: "needs_review",
      openedDocuments: [{ finalUrl: "https://example.test/replacement", isLikelyPrimary: false }],
      missingEvidence: ["primary_or_official_reference"],
    });
  });

  it("retains a healthy secondary replacement when primary evidence was not required", async () => {
    const result = await run(
      { sourceURL: "https://example.test/replacement", statusCode: 200 },
      false,
    );
    expect(result.details).toMatchObject({
      status: "ready",
      openedDocuments: [{ finalUrl: "https://example.test/replacement", isLikelyPrimary: false }],
    });
  });

  it("rejects a failed replacement page even when the original HTTP page succeeded", async () => {
    const result = await run({ sourceURL: "https://www.sec.gov/not-found", statusCode: 404 });
    expect(result.details).toMatchObject({
      status: "blocked",
      openedDocuments: [],
      failures: [{ stage: "fetch" }],
    });
  });

  it.each([undefined, "javascript:unobserved"])(
    "retains text without certifying an unobserved replacement source %s",
    async (sourceURL) => {
      const result = await run({ sourceURL, statusCode: 200 });
      expect(result.details).toMatchObject({
        status: "needs_review",
        openedDocuments: [
          {
            isLikelyPrimary: false,
            finalUrlSource: "requested_url_fallback",
            sourceProvenanceGaps: ["opened_document_final_url_unobserved"],
            text: expect.stringContaining("Replacement body"),
          },
        ],
        missingEvidence: expect.arrayContaining([
          "opened_document_final_url_unobserved",
          "primary_or_official_reference",
        ]),
      });
    },
  );

  it("retains valid official replacement provenance and its actual extraction format", async () => {
    const result = await run({
      sourceURL: "https://www.sec.gov/Archives/replacement",
      statusCode: 200,
    });
    expect(result.details).toMatchObject({
      status: "ready",
      openedDocuments: [
        {
          finalUrl: "https://www.sec.gov/Archives/replacement",
          isLikelyPrimary: true,
          contentType: "text/markdown",
          extractor: "firecrawl",
        },
      ],
    });
  });
});
