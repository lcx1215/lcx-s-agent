import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfigObject } from "./config.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

const { __testing } = await import("../agents/tools/web-search.js");
const { resolveSearchProvider, missingSearchKeyPayload } = __testing;

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "perplexity",
        providerConfig: {
          apiKey: "test-key",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "gemini",
        providerConfig: {
          apiKey: "test-key",
          model: "gemini-2.5-flash",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider with no extra config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "gemini",
      }),
    );

    expect(res.ok).toBe(true);
  });
});

describe("web search provider auto-detection", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("falls back to brave when no keys available", () => {
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects brave when only BRAVE_API_KEY is set", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects gemini when only GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects perplexity when only PERPLEXITY_API_KEY is set", () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects grok when only XAI_API_KEY is set", () => {
    process.env.XAI_API_KEY = "test-xai-key";
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects kimi when only MOONSHOT_API_KEY is set", () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("follows priority order — brave wins when multiple keys available", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.XAI_API_KEY = "test-xai-key";
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("gemini wins over perplexity and grok when brave unavailable", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("explicit provider always wins regardless of keys", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(
      resolveSearchProvider({ provider: "gemini" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("gemini");
  });

  it("falls back to brave for unsupported provider strings", () => {
    expect(
      resolveSearchProvider({ provider: "tavily" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("brave");
  });

  it("prefers brave over nested provider-specific keys during auto-detection", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(
      resolveSearchProvider({
        gemini: { apiKey: "test-gemini-key" },
        perplexity: { apiKey: "test-perplexity-key" },
      } as unknown as Parameters<typeof resolveSearchProvider>[0]),
    ).toBe("brave");
  });

  it("prefers gemini over kimi and perplexity nested keys when brave is unavailable", () => {
    expect(
      resolveSearchProvider({
        gemini: { apiKey: "test-gemini-key" },
        kimi: { apiKey: "test-kimi-key" },
        perplexity: { apiKey: "test-perplexity-key" },
      } as unknown as Parameters<typeof resolveSearchProvider>[0]),
    ).toBe("gemini");
  });
});

describe("web search provider error payloads", () => {
  it("returns actionable kimi missing-key guidance", () => {
    expect(missingSearchKeyPayload("kimi")).toEqual(
      expect.objectContaining({
        error: "missing_kimi_api_key",
        docs: "https://docs.openclaw.ai/tools/web",
      }),
    );
  });

  it("returns actionable gemini missing-key guidance", () => {
    expect(missingSearchKeyPayload("gemini")).toEqual(
      expect.objectContaining({
        error: "missing_gemini_api_key",
        docs: "https://docs.openclaw.ai/tools/web",
      }),
    );
  });
});
