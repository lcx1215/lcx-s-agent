import { gzipSync } from "node:zlib";
import { Agent, EnvHttpProxyAgent, Response, fetch as undiciFetch } from "undici";
import { describe, expect, it, vi } from "vitest";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import { buildFinanceDataGatewaySnapshot } from "./finance-data-gateway.js";
import {
  collectLiveFinanceGatewayInput,
  decideFinanceProxy,
  resolveFinanceFetch,
  resolveFinanceGzipTextFetch,
  fetchYahooQuote,
  LiveMarketFetchError,
  parseYahooChart,
  quoteToObservation,
  type FetchImpl,
} from "./finance-live-market-source.js";

// regularMarketTime 1782936000 = 2026-07-01T20:00:00.000Z
const SAMPLE_JSON = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: "USD",
          symbol: "QQQ",
          regularMarketPrice: 725.17,
          regularMarketTime: 1782936000,
          exchangeTimezoneName: "America/New_York",
        },
      },
    ],
    error: null,
  },
});

function fakeFetch(body: string, init?: { ok?: boolean; status?: number }): FetchImpl {
  return async () => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => body,
  });
}

function sequenceFetch(responses: Array<{ ok: boolean; status: number; body: string }>): FetchImpl {
  let index = 0;
  return async () => {
    const response = responses[Math.min(index++, responses.length - 1)];
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body,
    };
  };
}

describe("parseYahooChart", () => {
  it("parses a real-shaped yahoo chart response into a quote with provenance", () => {
    const quote = parseYahooChart(SAMPLE_JSON, "qqq");
    expect(quote.symbol).toBe("QQQ");
    expect(quote.price).toBe(725.17);
    expect(quote.currency).toBe("USD");
    expect(quote.delayStatus).toBe("delayed");
    expect(quote.quoteTimestamp).toBe("2026-07-01T20:00:00.000Z");
    expect(quote.sourceUrlOrArtifact).toContain("finance.yahoo.com");
  });

  it("fails closed when yahoo reports an error", () => {
    const body = JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } });
    expect(() => parseYahooChart(body, "zzzz")).toThrowError(LiveMarketFetchError);
  });

  it("fails closed when regularMarketPrice is missing", () => {
    const body = JSON.stringify({
      chart: {
        result: [{ meta: { currency: "USD", regularMarketTime: 1782936000 } }],
        error: null,
      },
    });
    expect(() => parseYahooChart(body, "qqq")).toThrowError(LiveMarketFetchError);
  });

  it("fails closed on an empty body", () => {
    expect(() => parseYahooChart("   ", "qqq")).toThrowError(LiveMarketFetchError);
  });

  it("fails closed on non-JSON", () => {
    expect(() => parseYahooChart("<html>nope</html>", "qqq")).toThrowError(LiveMarketFetchError);
  });
});

describe("fetchYahooQuote", () => {
  it("returns a parsed quote from an injected fetch", async () => {
    const quote = await fetchYahooQuote("QQQ", { fetchImpl: fakeFetch(SAMPLE_JSON) });
    expect(quote.price).toBe(725.17);
  });

  it("fails closed on an http error", async () => {
    await expect(
      fetchYahooQuote("QQQ", { fetchImpl: fakeFetch("", { ok: false, status: 429 }) }),
    ).rejects.toBeInstanceOf(LiveMarketFetchError);
  });

  it("fails closed when the network throws", async () => {
    const throwingFetch: FetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(fetchYahooQuote("QQQ", { fetchImpl: throwingFetch })).rejects.toMatchObject({
      reason: "network_error",
    });
  });

  it("falls back from a blocked Yahoo host to the healthy public chart host", async () => {
    const quote = await fetchYahooQuote("QQQ", {
      fetchImpl: sequenceFetch([
        { ok: false, status: 403, body: "" },
        { ok: true, status: 200, body: SAMPLE_JSON },
      ]),
    });
    expect(quote.price).toBe(725.17);
    expect(quote.sourceUrlOrArtifact).toContain("query1.finance.yahoo.com");
  });
});

describe("quoteToObservation", () => {
  it("maps a quote to a gateway observation preserving full field metadata", () => {
    const quote = parseYahooChart(SAMPLE_JSON, "qqq");
    const observation = quoteToObservation(quote, {
      providerName: "yahoo-qqq",
      providerRole: "primary_market_data",
      observedAt: "2026-06-01T20:05:00.000Z",
    });
    expect(observation.sourceFamily).toBe("market_data_api");
    expect(observation.delayStatus).toBe("delayed");
    const field = observation.fields[0];
    expect(field.name).toBe("last_price");
    expect(field.value).toBe(725.17);
    expect(field.currency).toBe("USD");
    expect(field.sourceTimestamp).toBe("2026-07-01T20:00:00.000Z");
    expect(field.fieldDefinition).toContain("last/close price");
    expect(field.sourceUrlOrArtifact).toContain("finance.yahoo.com");
  });
});

describe("collectLiveFinanceGatewayInput", () => {
  it("produces a gateway-valid input that the pure validator accepts (live-shaped, not fixture)", async () => {
    const input = await collectLiveFinanceGatewayInput({
      instrument: "QQQ",
      assetClass: "etf",
      useCase: "live_gateway_portfolio_macro_risk_research",
      requireOfficialReference: false,
      // The sample is dated 2026-07-01, so `now` has to sit just after it: the gateway withholds
      // observations dated after the requested `asOf` (fail-closed historical runs), and an
      // asOf a month earlier than the sample would make this "live-shaped" input look future.
      now: () => new Date("2026-07-01T20:05:00.000Z"),
      fetchImpl: fakeFetch(SAMPLE_JSON),
    });
    expect(input.instrument).toBe("QQQ");
    expect(input.observations).toHaveLength(1);
    expect(input.observations[0].providerRole).toBe("primary_market_data");

    // The gateway's validation contract must still hold on live-shaped data.
    const snapshot = buildFinanceDataGatewaySnapshot(input);
    // Only a primary source is present, so the gateway must honestly mark the
    // snapshot blocked on the missing cross-check provider — not silently pass.
    expect(snapshot.qualityStatus).toBe("blocked");
    expect(snapshot.missingEvidence).toContain("cross_check_market_data_provider");
    const priceField = snapshot.normalizedFields.find((f) => f.name === "last_price");
    expect(priceField?.value).toBe(725.17);
    expect(priceField?.sourceTimestamp).toBe("2026-07-01T20:00:00.000Z");
  });

  it("propagates a fail-closed error when the source is unavailable", async () => {
    await expect(
      collectLiveFinanceGatewayInput({
        instrument: "QQQ",
        assetClass: "etf",
        useCase: "live_gateway_portfolio_macro_risk_research",
        fetchImpl: fakeFetch("", { ok: false, status: 500 }),
      }),
    ).rejects.toBeInstanceOf(LiveMarketFetchError);
  });
});

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: vi.fn(),
    EnvHttpProxyAgent: vi.fn(function (options) {
      return new actual.EnvHttpProxyAgent(options);
    }),
    Agent: vi.fn(function (options) {
      return new actual.Agent(options);
    }),
  };
});

vi.mock("./finance-credential-env.js", () => ({ resolveFinanceCredentialEnv: vi.fn(() => ({})) }));

describe("default proxy-aware transport", () => {
  it("uses the saved finance proxy without requiring shell proxy variables", async () => {
    vi.mocked(resolveFinanceCredentialEnv).mockReturnValueOnce({
      LCX_FINANCE_HTTP_PROXY: "http://proxy.test:8080",
    });
    vi.mocked(undiciFetch).mockResolvedValueOnce(new Response("{}"));
    await resolveFinanceFetch()("https://example.test");
    expect(EnvHttpProxyAgent).toHaveBeenLastCalledWith({
      httpProxy: "http://proxy.test:8080",
      httpsProxy: "http://proxy.test:8080",
      connectTimeout: 30_000,
      requestTls: { timeout: 30_000 },
    });
  });
  it("passes the deadline signal to undici without making a network call", async () => {
    vi.mocked(undiciFetch).mockImplementationOnce(async () => new Promise(() => {}));
    await expect(
      resolveFinanceFetch(undefined, { timeoutMs: 10 })("https://example.test"),
    ).rejects.toMatchObject({ kind: "timeout" });
    const init = vi.mocked(undiciFetch).mock.calls.at(-1)?.[1];
    expect(init?.signal?.aborted).toBe(true);
    expect(init?.dispatcher).toBeDefined();
  });

  it("builds a direct agent for an explicitly empty proxy, so ambient HTTP_PROXY is ignored", async () => {
    // The defect this guards: `""` used to read as "nothing declared", so an EnvHttpProxyAgent was
    // built with no httpProxy and silently fell back to the shell's HTTP_PROXY/HTTPS_PROXY. On a
    // proxied or sandboxed host that made "go direct" impossible to express, and every source
    // failed with no HTTP status — indistinguishable from a network outage.
    vi.mocked(resolveFinanceCredentialEnv).mockReturnValueOnce({ LCX_FINANCE_HTTP_PROXY: "" });
    vi.mocked(undiciFetch).mockResolvedValueOnce(new Response("{}"));

    await resolveFinanceFetch()("https://example.test");

    expect(Agent).toHaveBeenLastCalledWith({ connectTimeout: 30_000 });
  });

  it("still defers to the ambient proxy when no finance proxy is declared", async () => {
    // The other half: an undeclared proxy must keep the old behaviour, because a machine that
    // genuinely needs a proxy relies on EnvHttpProxyAgent reading it.
    vi.mocked(resolveFinanceCredentialEnv).mockReturnValueOnce({});
    vi.mocked(undiciFetch).mockResolvedValueOnce(new Response("{}"));

    await resolveFinanceFetch()("https://example.test");

    expect(EnvHttpProxyAgent).toHaveBeenLastCalledWith({
      connectTimeout: 30_000,
      requestTls: { timeout: 30_000 },
    });
  });
});

describe("decideFinanceProxy", () => {
  it("keeps the three declared states apart", () => {
    // Collapsing any two of these is the original bug.
    expect(decideFinanceProxy(undefined)).toEqual({ kind: "ambient" });
    expect(decideFinanceProxy("")).toEqual({ kind: "direct" });
    expect(decideFinanceProxy("   ")).toEqual({ kind: "direct" });
    expect(decideFinanceProxy("http://proxy.test:8080")).toEqual({
      kind: "explicit",
      proxy: "http://proxy.test:8080",
    });
  });
});

it("decodes public gzip text under the governed deadline", async () => {
  vi.mocked(undiciFetch).mockResolvedValueOnce(
    new Response(new Uint8Array(gzipSync("public news metadata"))),
  );
  const response = await resolveFinanceGzipTextFetch()("https://example.test/data.json.gz");
  expect(await response.text()).toBe("public news metadata");
});

it("rejects a compressed response that expands past the output budget", async () => {
  vi.mocked(undiciFetch).mockResolvedValueOnce(
    new Response(new Uint8Array(gzipSync(Buffer.alloc(17 * 1024 * 1024, 65)))),
  );
  await expect(
    resolveFinanceGzipTextFetch()("https://example.test/data.json.gz"),
  ).rejects.toMatchObject({ kind: "network_error" });
});
