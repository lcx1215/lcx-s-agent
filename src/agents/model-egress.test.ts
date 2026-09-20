import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  ensureModelEgressDispatcher,
  ensureStartupEgressDispatcher,
  resetModelEgressStateForTests,
  resolveModelsProxyUrl,
} from "./model-egress.js";

const setGlobalDispatcher = vi.hoisted(() => vi.fn());
const getGlobalDispatcherState = vi.hoisted(() => ({ value: undefined as unknown }));
const getGlobalDispatcher = vi.hoisted(() => vi.fn(() => getGlobalDispatcherState.value));
const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(this: { options: unknown }, options?: unknown) {
    this.options = options;
  }),
);
const ProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockProxyAgent(this: { proxyUrl: unknown }, proxyUrl: unknown) {
    this.proxyUrl = proxyUrl;
  }),
);

vi.mock("undici", () => ({
  Agent: AgentCtor,
  ProxyAgent: ProxyAgentCtor,
  getGlobalDispatcher,
  setGlobalDispatcher,
}));

const AMBIENT = { constructor: { name: "EnvHttpProxyAgent" } };
const DECLARED_PROXY = { constructor: { name: "ProxyAgent" } };
const BARE_AGENT = { constructor: { name: "Agent" } };

function configWithProxy(proxy?: string): OpenClawConfig {
  return { models: proxy === undefined ? {} : { proxy } } as OpenClawConfig;
}

afterEach(() => {
  resetModelEgressStateForTests();
  setGlobalDispatcher.mockReset();
  getGlobalDispatcher.mockClear();
  getGlobalDispatcherState.value = undefined;
  AgentCtor.mockClear();
  ProxyAgentCtor.mockClear();
  // Mirror undici: installing a dispatcher changes what getGlobalDispatcher reports.
  setGlobalDispatcher.mockImplementation((dispatcher: unknown) => {
    getGlobalDispatcherState.value = dispatcher;
  });
});

describe("resolveModelsProxyUrl", () => {
  it("returns undefined when models config is absent", () => {
    expect(resolveModelsProxyUrl(undefined)).toBeUndefined();
    expect(resolveModelsProxyUrl({} as OpenClawConfig)).toBeUndefined();
  });

  it("returns undefined when no proxy is declared", () => {
    expect(resolveModelsProxyUrl(configWithProxy())).toBeUndefined();
  });

  it("treats a blank value as not declared", () => {
    expect(resolveModelsProxyUrl(configWithProxy(""))).toBeUndefined();
    expect(resolveModelsProxyUrl(configWithProxy("   "))).toBeUndefined();
  });

  it("trims a declared proxy URL", () => {
    expect(resolveModelsProxyUrl(configWithProxy("  http://proxy.corp.example:3128 "))).toBe(
      "http://proxy.corp.example:3128",
    );
  });
});

describe("ensureModelEgressDispatcher", () => {
  it("replaces an ambient env proxy with a direct agent when nothing is declared", () => {
    getGlobalDispatcherState.value = AMBIENT;

    ensureModelEgressDispatcher(configWithProxy());

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const installed = setGlobalDispatcher.mock.calls[0]?.[0] as { constructor: { name: string } };
    expect(installed).toBeInstanceOf(AgentCtor);
    expect(installed.constructor.name).not.toBe("EnvHttpProxyAgent");
  });

  it("installs the declared proxy instead of a direct agent", () => {
    getGlobalDispatcherState.value = AMBIENT;

    ensureModelEgressDispatcher(configWithProxy("http://proxy.corp.example:3128"));

    expect(ProxyAgentCtor).toHaveBeenCalledWith("http://proxy.corp.example:3128");
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher.mock.calls[0]?.[0]).toBeInstanceOf(ProxyAgentCtor);
  });

  it("preserves a proxy dispatcher that was declared elsewhere", () => {
    getGlobalDispatcherState.value = DECLARED_PROXY;

    ensureModelEgressDispatcher(configWithProxy());

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("preserves a tuned direct agent instead of overwriting it", () => {
    // telegram installs a bare Agent carrying its autoSelectFamily workaround; replacing it here
    // would silently undo that fix.
    getGlobalDispatcherState.value = BARE_AGENT;

    ensureModelEgressDispatcher(configWithProxy());

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("does not reinstall on repeated calls with the same declaration", () => {
    getGlobalDispatcherState.value = AMBIENT;

    ensureModelEgressDispatcher(configWithProxy("http://proxy.corp.example:3128"));
    ensureModelEgressDispatcher(configWithProxy("http://proxy.corp.example:3128"));

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("reinstalls when the declared proxy changes", () => {
    getGlobalDispatcherState.value = AMBIENT;

    ensureModelEgressDispatcher(configWithProxy("http://proxy.corp.example:3128"));
    ensureModelEgressDispatcher(configWithProxy("http://proxy.other.example:8080"));

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(2);
    expect(ProxyAgentCtor).toHaveBeenLastCalledWith("http://proxy.other.example:8080");
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
  });

  it("recovers when an ambient dispatcher reappears after a direct install", () => {
    getGlobalDispatcherState.value = AMBIENT;
    ensureModelEgressDispatcher(configWithProxy());
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    // Something (re)installed the ambient agent after us.
    getGlobalDispatcherState.value = AMBIENT;
    ensureModelEgressDispatcher(configWithProxy());

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
  });

  it("drops the installed route when a declaration is later cleared", () => {
    getGlobalDispatcherState.value = AMBIENT;
    ensureModelEgressDispatcher(configWithProxy("http://proxy.corp.example:3128"));
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    // Clearing the field has to take effect, otherwise the process keeps a route the config no
    // longer declares.
    ensureModelEgressDispatcher(configWithProxy(""));

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(setGlobalDispatcher.mock.calls[1]?.[0]).toBeInstanceOf(AgentCtor);
  });

  it("does not drop a proxy dispatcher it did not install", () => {
    getGlobalDispatcherState.value = DECLARED_PROXY;

    ensureModelEgressDispatcher(configWithProxy(""));

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("ignores ambient proxy variables entirely when a proxy is declared", () => {
    vi.stubEnv("HTTPS_PROXY", "http://dead.proxy.example:9");
    vi.stubEnv("https_proxy", "http://dead.proxy.example:9");
    getGlobalDispatcherState.value = AMBIENT;

    ensureModelEgressDispatcher(configWithProxy("http://proxy.corp.example:3128"));

    const installed = setGlobalDispatcher.mock.calls[0]?.[0] as { proxyUrl: string };
    expect(installed.proxyUrl).toBe("http://proxy.corp.example:3128");
    vi.unstubAllEnvs();
  });
});

describe("ensureStartupEgressDispatcher", () => {
  it("replaces an ambient dispatcher before any model turn exists", () => {
    getGlobalDispatcherState.value = AMBIENT;

    ensureStartupEgressDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher.mock.calls[0]?.[0]).toBeInstanceOf(AgentCtor);
  });

  it("leaves a dispatcher somebody else installed on purpose", () => {
    // telegram installs an agent carrying its IPv6 workaround; overwriting it at startup would
    // silently undo that fix.
    getGlobalDispatcherState.value = DECLARED_PROXY;

    ensureStartupEgressDispatcher();

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("does not touch the environment, so spawned tools keep the host proxy", () => {
    // The whole point of splitting this from the model turn: package managers and installers must
    // still inherit HTTP_PROXY. Aligning the environment is the model turn's job, not startup's.
    vi.stubEnv("HTTP_PROXY", "http://host.example:3128");
    vi.stubEnv("NO_PROXY", "internal.example");
    getGlobalDispatcherState.value = AMBIENT;

    ensureStartupEgressDispatcher();

    expect(process.env.HTTP_PROXY).toBe("http://host.example:3128");
    expect(process.env.NO_PROXY).toBe("internal.example");
    vi.unstubAllEnvs();
  });
});
