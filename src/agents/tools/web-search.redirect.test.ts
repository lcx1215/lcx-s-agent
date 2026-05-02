import { beforeEach, describe, expect, it, vi } from "vitest";

const { withStrictWebToolsEndpointMock } = vi.hoisted(() => ({
  withStrictWebToolsEndpointMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  withStrictWebToolsEndpoint: withStrictWebToolsEndpointMock,
}));

import { __testing } from "./web-search.js";

describe("web_search redirect resolution hardening", () => {
  const { resolveRedirectUrl } = __testing;

  beforeEach(() => {
    withStrictWebToolsEndpointMock.mockReset();
  });

  it("resolves redirects via SSRF-guarded HEAD requests", async () => {
    withStrictWebToolsEndpointMock.mockImplementation(async (_params, run) =>
      run({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://example.com/final",
      }),
    );

    const resolved = await resolveRedirectUrl("https://example.com/start");
    expect(resolved).toBe("https://example.com/final");
    expect(withStrictWebToolsEndpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/start",
        timeoutMs: 5000,
        init: { method: "HEAD" },
      }),
      expect.any(Function),
    );
  });

  it("falls back to the original URL when guarded resolution fails", async () => {
    withStrictWebToolsEndpointMock.mockRejectedValue(new Error("blocked"));
    await expect(resolveRedirectUrl("https://example.com/start")).resolves.toBe(
      "https://example.com/start",
    );
  });
});
