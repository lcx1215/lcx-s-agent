import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";

describe("minimaxUnderstandImage apiKey normalization", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("retains cancellation while reading the cloud response body", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel response body");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return {
        ok: true,
        headers: new Headers(),
        json: async () => {
          controller.abort(reason);
          throw reason;
        },
      };
    });
    global.fetch = withFetchPreconnect(fetchSpy);
    const { minimaxUnderstandImage } = await import("./minimax-vlm.js");
    await expect(
      minimaxUnderstandImage({
        apiKey: "fixture",
        prompt: "fixture",
        imageDataUrl: "data:image/png;base64,AAAA",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("strips embedded CR/LF before sending Authorization header", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(auth).toBe("Bearer minimax-test-key");

      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: "ok" },
          content: "ok",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    const { minimaxUnderstandImage } = await import("./minimax-vlm.js");
    const text = await minimaxUnderstandImage({
      apiKey: "minimax-test-\r\nkey",
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      apiHost: "https://api.minimax.io",
    });

    expect(text).toBe("ok");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
