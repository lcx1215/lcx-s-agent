import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFetch } from "../infra/fetch.js";
import { resetTelegramFetchStateForTests, resolveTelegramFetch } from "./fetch.js";

const setDefaultAutoSelectFamily = vi.hoisted(() => vi.fn());
const setDefaultResultOrder = vi.hoisted(() => vi.fn());
const setGlobalDispatcher = vi.hoisted(() => vi.fn());
const getGlobalDispatcherState = vi.hoisted(() => ({ value: undefined as unknown }));
const getGlobalDispatcher = vi.hoisted(() => vi.fn(() => getGlobalDispatcherState.value));
const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
);

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    ...actual,
    setDefaultAutoSelectFamily,
  };
});

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    setDefaultResultOrder,
  };
});

vi.mock("undici", () => ({
  Agent: AgentCtor,
  getGlobalDispatcher,
  setGlobalDispatcher,
}));

const originalFetch = globalThis.fetch;

function expectAgentConstructorCall(params: { nth: number; autoSelectFamily: boolean }) {
  expect(AgentCtor).toHaveBeenNthCalledWith(params.nth, {
    connect: {
      autoSelectFamily: params.autoSelectFamily,
      autoSelectFamilyAttemptTimeout: 300,
    },
  });
}

function resolveTelegramFetchOrThrow() {
  const resolved = resolveTelegramFetch();
  if (!resolved) {
    throw new Error("expected resolved fetch");
  }
  return resolved;
}

afterEach(() => {
  resetTelegramFetchStateForTests();
  setDefaultAutoSelectFamily.mockReset();
  setDefaultResultOrder.mockReset();
  setGlobalDispatcher.mockReset();
  getGlobalDispatcher.mockClear();
  getGlobalDispatcherState.value = undefined;
  AgentCtor.mockClear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
});

describe("resolveTelegramFetch", () => {
  it("returns wrapped global fetch when available", async () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolved = resolveTelegramFetch();

    expect(resolved).toBeTypeOf("function");
    expect(resolved).not.toBe(fetchMock);
  });

  it("wraps proxy fetches and normalizes foreign signals once", async () => {
    let seenSignal: AbortSignal | undefined;
    const proxyFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return {} as Response;
    });

    const resolved = resolveTelegramFetch(proxyFetch as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");

    let abortHandler: (() => void) | null = null;
    const addEventListener = vi.fn((event: string, handler: () => void) => {
      if (event === "abort") {
        abortHandler = handler;
      }
    });
    const removeEventListener = vi.fn((event: string, handler: () => void) => {
      if (event === "abort" && abortHandler === handler) {
        abortHandler = null;
      }
    });
    const fakeSignal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    if (!resolved) {
      throw new Error("expected resolved proxy fetch");
    }
    await resolved("https://example.com", { signal: fakeSignal });

    expect(proxyFetch).toHaveBeenCalledOnce();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("does not double-wrap an already wrapped proxy fetch", async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const alreadyWrapped = resolveFetch(proxyFetch);

    const resolved = resolveTelegramFetch(alreadyWrapped);

    expect(resolved).toBe(alreadyWrapped);
  });

  it("honors env enable override", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch();
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("uses config override when provided", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("env disable override wins over config", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "0");
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(false);
  });

  it("applies dns result order from config", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "verbatim" } });
    expect(setDefaultResultOrder).toHaveBeenCalledWith("verbatim");
  });

  it("retries dns setter on next call when previous attempt threw", async () => {
    setDefaultResultOrder.mockImplementationOnce(() => {
      throw new Error("dns setter failed once");
    });
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;

    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "ipv4first" } });
    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "ipv4first" } });

    expect(setDefaultResultOrder).toHaveBeenCalledTimes(2);
  });

  it("replaces global undici dispatcher with an env-independent Agent", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expectAgentConstructorCall({ nth: 1, autoSelectFamily: true });
  });

  it("keeps an existing proxy-like global dispatcher", async () => {
    getGlobalDispatcherState.value = {
      constructor: { name: "ProxyAgent" },
    };
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;

    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
  });

  it("replaces an ambient EnvHttpProxyAgent instead of preserving it", async () => {
    // `@mariozechner/pi-ai` installs `new EnvHttpProxyAgent()` as the process-wide dispatcher just
    // by being imported, which makes it look like an operator-configured proxy. It is not: its
    // route comes from ambient HTTP_PROXY/HTTPS_PROXY, so preserving it would let the host
    // environment choose the egress route.
    getGlobalDispatcherState.value = {
      constructor: { name: "EnvHttpProxyAgent" },
    };
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;

    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expectAgentConstructorCall({ nth: 1, autoSelectFamily: true });
  });

  it("ignores ambient proxy env and keeps the explicitly configured dispatcher", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    getGlobalDispatcherState.value = {
      constructor: { name: "ProxyAgent" },
    };
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;

    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
  });

  it("does not adopt ambient proxy env when no dispatcher is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;

    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expectAgentConstructorCall({ nth: 1, autoSelectFamily: true });
    const agentOptions = AgentCtor.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(agentOptions).not.toHaveProperty("httpProxy");
    expect(agentOptions).not.toHaveProperty("httpsProxy");
  });

  it("sets global dispatcher only once across repeated equal decisions", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("updates global dispatcher when autoSelectFamily decision changes", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: false } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expectAgentConstructorCall({ nth: 1, autoSelectFamily: true });
    expectAgentConstructorCall({ nth: 2, autoSelectFamily: false });
  });

  it("retries once with ipv4 fallback when fetch fails with network timeout/unreachable", async () => {
    const timeoutErr = Object.assign(new Error("connect ETIMEDOUT 149.154.166.110:443"), {
      code: "ETIMEDOUT",
    });
    const unreachableErr = Object.assign(
      new Error("connect ENETUNREACH 2001:67c:4e8:f004::9:443"),
      {
        code: "ENETUNREACH",
      },
    );
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("aggregate"), {
        errors: [timeoutErr, unreachableErr],
      }),
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolved = resolveTelegramFetchOrThrow();

    await resolved("https://api.telegram.org/file/botx/photos/file_1.jpg");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expectAgentConstructorCall({ nth: 1, autoSelectFamily: true });
    expectAgentConstructorCall({ nth: 2, autoSelectFamily: false });
  });

  it("retries with ipv4 fallback once per request, not once per process", async () => {
    const timeoutErr = Object.assign(new Error("connect ETIMEDOUT 149.154.166.110:443"), {
      code: "ETIMEDOUT",
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: timeoutErr,
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolved = resolveTelegramFetchOrThrow();

    await resolved("https://api.telegram.org/file/botx/photos/file_1.jpg");
    await resolved("https://api.telegram.org/file/botx/photos/file_2.jpg");

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry when fetch fails without fallback network error codes", async () => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
    const fetchMock = vi.fn().mockRejectedValue(fetchError);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolved = resolveTelegramFetchOrThrow();

    await expect(resolved("https://api.telegram.org/file/botx/photos/file_3.jpg")).rejects.toThrow(
      "fetch failed",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
