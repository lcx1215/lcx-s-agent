import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { jsonResult } from "./common.js";
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

function tool(cacheTtlMinutes = 0) {
  const result = createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes,
            firecrawl: { enabled: true, apiKey: "offline-fixture" },
          },
        },
      },
    },
  });
  if (!result) {
    throw new Error("fixture unavailable");
  }
  return result;
}
function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
function markdown() {
  return new Response("healthy body", { headers: { "content-type": "text/markdown" } });
}
function extracted() {
  return new Response(JSON.stringify({ success: true, data: { markdown: "extracted body" } }), {
    headers: { "content-type": "application/json" },
  });
}

describe("canonical web_fetch caller cancellation", () => {
  it("propagates a research caller deadline through the real web fetch tool", async () => {
    const controller = new AbortController();
    const reason = new Error("research source deadline");
    const fetch = vi.fn(async () => {
      controller.abort(reason);
      return markdown();
    });
    globalThis.fetch = withFetchPreconnect(fetch);
    const research = createResearchWebAutopilotTool({
      searchTool: {
        name: "fixture",
        label: "fixture",
        description: "fixture",
        parameters: {},
        execute: async () =>
          jsonResult({ results: [{ url: "https://example.test/research-deadline" }] }),
      },
      fetchTool: tool(),
    });
    await expect(
      research.execute("research", { query: "filing", openTop: 1 }, controller.signal),
    ).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains normal fallback recovery for an uncancelled transport failure", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).includes("api.firecrawl.dev")) {
        return extracted();
      }
      throw new Error("fixture transport unavailable");
    });
    globalThis.fetch = withFetchPreconnect(fetch);
    const result = await tool().execute(
      "fallback",
      { url: "https://example.test/normal-recovery" },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      extractor: "firecrawl",
      text: expect.stringContaining("extracted body"),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an already cancelled caller before fetching", async () => {
    const controller = new AbortController();
    const reason = new Error("expired before fetch");
    controller.abort(reason);
    const fetch = vi.fn(async () => markdown());
    globalThis.fetch = withFetchPreconnect(fetch);
    await expect(
      tool().execute("pre", { url: "https://example.test/pre" }, controller.signal),
    ).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards cancellation to an active direct fetch without starting fallback", async () => {
    const controller = new AbortController();
    const reason = new Error("direct expired");
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      controller.abort(reason);
      if (init?.signal?.aborted) {
        throw init.signal.reason;
      }
      return markdown();
    });
    globalThis.fetch = withFetchPreconnect(fetch);
    await expect(
      tool().execute("direct", { url: "https://example.test/direct" }, controller.signal),
    ).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("does not turn a caller cancellation thrown by transport into a paid fallback", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel transport");
    const fetch = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });
    globalThis.fetch = withFetchPreconnect(fetch);
    await expect(
      tool().execute("failure", { url: "https://example.test/failure" }, controller.signal),
    ).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["http_failure", "html_extraction"])(
    "cancels the active extractor request after %s and preserves the caller reason",
    async (route) => {
      const controller = new AbortController();
      const reason = new Error("extractor expired");
      let extractorSignal: AbortSignal | null | undefined;
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes("api.firecrawl.dev")) {
          extractorSignal = init?.signal;
          controller.abort(reason);
          if (init?.signal?.aborted) {
            throw init.signal.reason;
          }
          return extracted();
        }
        return route === "http_failure"
          ? new Response("unavailable", { status: 503 })
          : new Response("<html></html>", { headers: { "content-type": "text/html" } });
      });
      globalThis.fetch = withFetchPreconnect(fetch);
      await expect(
        tool().execute("extractor", { url: "https://example.test/extractor" }, controller.signal),
      ).rejects.toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(extractorSignal?.aborted).toBe(true);
    },
  );

  it("does not start fallback after cancellation during HTML extraction", async () => {
    const controller = new AbortController();
    const reason = new Error("readability expired");
    vi.mocked(extractReadableContent).mockImplementation(async () => {
      controller.abort(reason);
      return null;
    });
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      requestUrl(input).includes("api.firecrawl.dev")
        ? extracted()
        : new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    );
    globalThis.fetch = withFetchPreconnect(fetch);
    await expect(
      tool().execute("html", { url: "https://example.test/html" }, controller.signal),
    ).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not publish or cache a body returned after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("body expired");
    const url = "https://example.test/cancelled-body-cache";
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(stream) {
              controller.abort(reason);
              stream.enqueue(new TextEncoder().encode("partial body"));
              stream.close();
            },
          }),
          { headers: { "content-type": "text/markdown" } },
        ),
    );
    globalThis.fetch = withFetchPreconnect(fetch);
    const original = tool(5);
    await expect(original.execute("body", { url }, controller.signal)).rejects.toBe(reason);
    const recovery = vi.fn(async () => markdown());
    globalThis.fetch = withFetchPreconnect(recovery);
    const result = await original.execute("recovery", { url });
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ text: expect.stringContaining("healthy body") });
  });

  it("does not serve a cached success to a cancelled caller", async () => {
    const original = tool(5);
    const url = "https://example.test/already-cached";
    const fetch = vi.fn(async () => markdown());
    globalThis.fetch = withFetchPreconnect(fetch);
    await original.execute("warm", { url });
    const controller = new AbortController();
    const reason = new Error("cached caller expired");
    controller.abort(reason);
    await expect(original.execute("cached", { url }, controller.signal)).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
