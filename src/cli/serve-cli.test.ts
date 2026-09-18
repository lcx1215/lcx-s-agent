import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultDeps } from "./deps.js";
import {
  DEFAULT_SERVE_PORT,
  DEFAULT_SERVE_SESSION_KEY,
  MAX_SERVE_BODY_BYTES,
  assertServeConfigSafe,
  createServeServer,
  readServePayloadTexts,
  resolveServeBind,
  resolveServeConfig,
  resolveServePort,
  type ServeAgentRunner,
  type ServeConfig,
} from "./serve-cli.js";

type StartedServer = {
  url: string;
  runAgent: ReturnType<typeof vi.fn>;
};

const pendingClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(pendingClosers.splice(0).map((close) => close()));
});

async function startServer(
  options: { config?: Partial<ServeConfig>; runAgent?: ServeAgentRunner } = {},
): Promise<StartedServer> {
  const runAgent = vi.fn(
    options.runAgent ?? (async () => ({ payloads: [{ text: "agent reply" }], meta: { ok: true } })),
  );
  const server = createServeServer({
    config: {
      port: 0,
      bind: "loopback",
      sessionKey: DEFAULT_SERVE_SESSION_KEY,
      ...options.config,
    },
    deps: {} as ReturnType<typeof createDefaultDeps>,
    runAgent: runAgent as unknown as ServeAgentRunner,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  pendingClosers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${address.port}`, runAgent };
}

function postAgent(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("serve config resolution", () => {
  it("defaults to loopback, the default port, and the default session key", () => {
    const config = resolveServeConfig({}, {});
    expect(config.bind).toBe("loopback");
    expect(config.port).toBe(DEFAULT_SERVE_PORT);
    expect(config.sessionKey).toBe(DEFAULT_SERVE_SESSION_KEY);
    expect(config.token).toBeUndefined();
    expect(config.agentId).toBeUndefined();
  });

  it("reads the LCX_SERVE_* environment fallbacks", () => {
    const config = resolveServeConfig(
      {},
      {
        LCX_SERVE_PORT: "9001",
        LCX_SERVE_BIND: "lan",
        LCX_SERVE_TOKEN: "env-token",
        LCX_SERVE_AGENT: "main",
        LCX_SERVE_SESSION: "agent:main:env",
      },
    );
    expect(config).toMatchObject({
      port: 9001,
      bind: "lan",
      token: "env-token",
      agentId: "main",
      sessionKey: "agent:main:env",
    });
  });

  it("accepts bind aliases and rejects unknown values", () => {
    expect(resolveServeBind(undefined)).toBe("loopback");
    expect(resolveServeBind("local")).toBe("loopback");
    expect(resolveServeBind("127.0.0.1")).toBe("loopback");
    expect(resolveServeBind("0.0.0.0")).toBe("lan");
    expect(() => resolveServeBind("public")).toThrow(/loopback/);
  });

  it("rejects out-of-range ports", () => {
    expect(resolveServePort("9001")).toBe(9001);
    expect(() => resolveServePort("0")).toThrow(/1\.\.65535/);
    expect(() => resolveServePort("70000")).toThrow(/1\.\.65535/);
    expect(() => resolveServePort("abc")).toThrow(/1\.\.65535/);
  });

  it("fails closed when binding a non-loopback address without a token", () => {
    expect(() =>
      assertServeConfigSafe({ port: 8788, bind: "lan", sessionKey: DEFAULT_SERVE_SESSION_KEY }),
    ).toThrow(/LCX_SERVE_TOKEN/);
    expect(() =>
      assertServeConfigSafe({
        port: 8788,
        bind: "lan",
        token: "secret",
        sessionKey: DEFAULT_SERVE_SESSION_KEY,
      }),
    ).not.toThrow();
    expect(() =>
      assertServeConfigSafe({
        port: 8788,
        bind: "loopback",
        sessionKey: DEFAULT_SERVE_SESSION_KEY,
      }),
    ).not.toThrow();
  });
});

describe("GET /healthz", () => {
  it("reports service health without touching the agent", async () => {
    const { url, runAgent } = await startServer();
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "lcx-agent-serve",
      status: "ok",
      bind: "loopback",
      tokenRequired: false,
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects non-GET methods", async () => {
    const { url } = await startServer();
    expect((await fetch(`${url}/healthz`, { method: "POST" })).status).toBe(405);
  });
});

describe("serve routing", () => {
  it("returns 404 for unknown paths", async () => {
    const { url } = await startServer();
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it("rejects GET on /agent", async () => {
    const { url } = await startServer();
    expect((await fetch(`${url}/agent`)).status).toBe(405);
  });
});

describe("POST /agent", () => {
  it("maps the request onto the in-process agent command", async () => {
    const { url, runAgent } = await startServer();
    const response = await postAgent(url, {
      message: "ping",
      model: "moonshot/kimi-k2.6",
      thinking: "medium",
      lane: "serve-lane",
      extraSystemPrompt: "be terse",
      timeoutSeconds: 900,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; payloads: Array<{ text: string }> };
    expect(body.ok).toBe(true);
    expect(body.payloads).toEqual([{ text: "agent reply" }]);

    expect(runAgent).toHaveBeenCalledTimes(1);
    const [opts] = runAgent.mock.calls[0] as [Record<string, unknown>];
    expect(opts).toMatchObject({
      message: "ping",
      model: "moonshot/kimi-k2.6",
      thinking: "medium",
      lane: "serve-lane",
      extraSystemPrompt: "be terse",
      timeout: "900",
      sessionKey: DEFAULT_SERVE_SESSION_KEY,
      deliver: false,
      senderIsOwner: true,
    });
    expect(typeof opts.runId).toBe("string");
  });

  it("honors per-request agent and session overrides", async () => {
    const { url, runAgent } = await startServer({ config: { agentId: "default-agent" } });
    await postAgent(url, { message: "hi", agentId: "other-agent", sessionKey: "agent:other:run" });
    const [opts] = runAgent.mock.calls[0] as [Record<string, unknown>];
    expect(opts.agentId).toBe("other-agent");
    expect(opts.sessionKey).toBe("agent:other:run");
  });

  it("requires a message", async () => {
    const { url, runAgent } = await startServer();
    const response = await postAgent(url, { sessionKey: "x" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "message is required",
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { url, runAgent } = await startServer();
    const response = await postAgent(url, "{not json");
    expect(response.status).toBe(400);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies", async () => {
    const { url, runAgent } = await startServer();
    const response = await postAgent(url, { message: "x".repeat(MAX_SERVE_BODY_BYTES + 16) });
    expect(response.status).toBe(413);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("surfaces agent failures as 500", async () => {
    const { url } = await startServer({
      runAgent: async () => {
        throw new Error("provider exploded");
      },
    });
    const response = await postAgent(url, { message: "ping" });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: "provider exploded",
    });
  });

  it("returns empty payloads when the agent produced no text", async () => {
    const { url } = await startServer({ runAgent: async () => ({ payloads: [], meta: {} }) });
    const response = await postAgent(url, { message: "ping" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, payloads: [] });
  });
});

describe("POST /agent authentication", () => {
  it("rejects missing, malformed, and wrong bearer tokens", async () => {
    const { url, runAgent } = await startServer({ config: { token: "s3cret" } });
    expect((await postAgent(url, { message: "x" })).status).toBe(401);
    expect((await postAgent(url, { message: "x" }, { authorization: "s3cret" })).status).toBe(401);
    expect((await postAgent(url, { message: "x" }, { authorization: "Bearer wrong" })).status).toBe(
      401,
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("accepts the configured bearer token", async () => {
    const { url, runAgent } = await startServer({ config: { token: "s3cret" } });
    const response = await postAgent(url, { message: "x" }, { authorization: "Bearer s3cret" });
    expect(response.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("still serves /healthz unauthenticated", async () => {
    const { url } = await startServer({ config: { token: "s3cret" } });
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ tokenRequired: true });
  });
});

describe("readServePayloadTexts", () => {
  it("extracts non-empty text blocks and ignores malformed entries", () => {
    expect(
      readServePayloadTexts({
        payloads: [{ text: "a" }, { text: "   " }, { text: 7 }, {}, null, "raw"],
      }),
    ).toEqual(["a"]);
  });

  it("tolerates unexpected result shapes", () => {
    expect(readServePayloadTexts(null)).toEqual([]);
    expect(readServePayloadTexts({ payloads: "nope" })).toEqual([]);
    expect(readServePayloadTexts({ meta: {} })).toEqual([]);
  });
});
