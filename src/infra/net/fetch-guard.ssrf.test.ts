import { EnvHttpProxyAgent, ProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "./fetch-guard.js";

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function okResponse(body = "ok"): Response {
  return new Response(body, { status: 200 });
}

describe("fetchWithSsrFGuard hardening", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

  const createPublicLookup = (): LookupFn =>
    vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

  const getSecondRequestHeaders = (fetchImpl: ReturnType<typeof vi.fn>): Headers => {
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    return new Headers(secondInit.headers);
  };

  async function runProxyModeDispatcherTest(params: {
    mode: (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];
    expectEnvProxy: boolean;
  }): Promise<void> {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      if (params.expectEnvProxy) {
        expect(requestInit.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
      } else {
        expect(requestInit.dispatcher).toBeDefined();
        expect(requestInit.dispatcher).not.toBeInstanceOf(EnvHttpProxyAgent);
      }
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      mode: params.mode,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks private and legacy loopback literals before fetch", async () => {
    const blockedUrls = [
      "http://127.0.0.1:8080/internal",
      "http://[ff02::1]/internal",
      "http://0177.0.0.1:8080/internal",
      "http://0x7f000001/internal",
    ];
    for (const url of blockedUrls) {
      const fetchImpl = vi.fn();
      await expect(
        fetchWithSsrFGuard({
          url,
          fetchImpl,
        }),
      ).rejects.toThrow(/private|internal|blocked/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("blocks special-use IPv4 literal URLs before fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "http://198.18.0.1:8080/internal",
        fetchImpl,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows RFC2544 benchmark range IPv4 literal URLs when explicitly opted in", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await fetchWithSsrFGuard({
      url: "http://198.18.0.153/file",
      fetchImpl,
      policy: { allowRfc2544BenchmarkRange: true },
    });
    expect(result.response.status).toBe(200);
  });

  it("blocks redirect chains that hop to private hosts", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectResponse("http://127.0.0.1:6379/"));

    await expect(
      fetchWithSsrFGuard({
        url: "https://public.example/start",
        fetchImpl,
        lookupFn,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("enforces hostname allowlist policies", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "https://evil.example.org/file.txt",
        fetchImpl,
        policy: { hostnameAllowlist: ["cdn.example.com", "*.assets.example.com"] },
      }),
    ).rejects.toThrow(/allowlist/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows wildcard allowlisted hosts", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const result = await fetchWithSsrFGuard({
      url: "https://img.assets.example.com/pic.png",
      fetchImpl,
      lookupFn,
      policy: { hostnameAllowlist: ["*.assets.example.com"] },
    });

    expect(result.response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it("strips sensitive headers when redirect crosses origins", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://cdn.example.com/asset"))
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/start",
      fetchImpl,
      lookupFn,
      init: {
        headers: {
          Authorization: "Bearer secret",
          "Proxy-Authorization": "Basic c2VjcmV0",
          Cookie: "session=abc",
          Cookie2: "legacy=1",
          "X-Trace": "1",
        },
      },
    });

    const headers = getSecondRequestHeaders(fetchImpl);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("cookie2")).toBeNull();
    expect(headers.get("x-trace")).toBe("1");
    await result.release();
  });

  it("keeps headers when redirect stays on same origin", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("/next"))
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/start",
      fetchImpl,
      lookupFn,
      init: {
        headers: {
          Authorization: "Bearer secret",
        },
      },
    });

    const headers = getSecondRequestHeaders(fetchImpl);
    expect(headers.get("authorization")).toBe("Bearer secret");
    await result.release();
  });

  it("ignores env proxy by default to preserve DNS-pinned destination binding", async () => {
    await runProxyModeDispatcherTest({
      mode: GUARDED_FETCH_MODE.STRICT,
      expectEnvProxy: false,
    });
  });

  it("uses env proxy only when dangerous proxy bypass is explicitly enabled", async () => {
    await runProxyModeDispatcherTest({
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      expectEnvProxy: true,
    });
  });

  it("routes through a declared proxyUrl and ignores ambient proxy env", async () => {
    // Both cases are stubbed on purpose: undici reads the lowercase name first, so a test that
    // only stubs HTTP_PROXY can pass while the ambient route is still in effect.
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("http_proxy", "http://127.0.0.1:7890");
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(requestInit.dispatcher).toBeInstanceOf(ProxyAgent);
      expect(requestInit.dispatcher).not.toBeInstanceOf(EnvHttpProxyAgent);
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      proxyUrl: "http://proxy.corp.example:3128",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it("lets a declared proxyUrl win over the env-proxy mode", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(requestInit.dispatcher).toBeInstanceOf(ProxyAgent);
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      proxyUrl: "http://proxy.corp.example:3128",
    });

    await result.release();
  });
});

describe("fetchWithSsrFGuard declared proxy route and local DNS", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

  const DECLARED_PROXY = "http://proxy.corp.example:3128";

  /** A resolver that cannot answer: the local network knows nothing about this host. */
  const createRefusingLookup = (): LookupFn =>
    vi.fn(async () => {
      const err = new Error("getaddrinfo ENOTFOUND internal-only.example");
      (err as NodeJS.ErrnoException).code = "ENOTFOUND";
      throw err;
    }) as unknown as LookupFn;

  const createPublicLookup = (): LookupFn =>
    vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

  const okFetch = () => vi.fn(async () => new Response("ok", { status: 200 }));

  it("reaches a host the local resolver cannot answer when a proxy is declared", async () => {
    // The whole point: the proxy resolves the name, so demanding a local answer only rejected
    // internal-only hosts while adding no protection.
    const lookupFn = createRefusingLookup();
    const fetchImpl = okFetch();

    const result = await fetchWithSsrFGuard({
      url: "https://internal-only.example/resource",
      fetchImpl,
      lookupFn,
      proxyUrl: DECLARED_PROXY,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      lookupFn,
      "the proxy resolves the name — no local lookup should happen",
    ).not.toHaveBeenCalled();
    await result.release();
  });

  it("still blocks literal private IPs on the declared proxy route", async () => {
    // Skipping DNS must not disarm the checks that need no DNS answer.
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/internal",
      "http://10.0.0.5/internal",
    ]) {
      const fetchImpl = okFetch();
      await expect(
        fetchWithSsrFGuard({
          url,
          fetchImpl,
          lookupFn: createPublicLookup(),
          proxyUrl: DECLARED_PROXY,
        }),
        `${url} must stay blocked`,
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("still enforces the hostname allowlist on the declared proxy route", async () => {
    const fetchImpl = okFetch();
    await expect(
      fetchWithSsrFGuard({
        url: "https://not-allowed.example/resource",
        fetchImpl,
        lookupFn: createPublicLookup(),
        proxyUrl: DECLARED_PROXY,
        policy: { hostnameAllowlist: ["allowed.example"] },
      }),
    ).rejects.toThrow(/allowlist/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps requiring a local answer when no proxy is declared", async () => {
    // No regression on the default route: without a declared proxy, an unresolvable host is still
    // an error rather than a silent pass.
    const fetchImpl = okFetch();
    await expect(
      fetchWithSsrFGuard({
        url: "https://internal-only.example/resource",
        fetchImpl,
        lookupFn: createRefusingLookup(),
      }),
    ).rejects.toThrow(/ENOTFOUND/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
