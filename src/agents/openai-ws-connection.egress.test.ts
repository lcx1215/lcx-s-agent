import { describe, expect, it, vi } from "vitest";

type FakeOpts = { headers?: Record<string, string>; agent?: unknown };

const hoisted = vi.hoisted(() => ({
  sockets: [] as { url: string; opts: FakeOpts }[],
}));

vi.mock("ws", () => ({
  default: class FakeWebSocket {
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(
      public url: string,
      public opts: FakeOpts,
    ) {
      hoisted.sockets.push({ url, opts });
      setImmediate(() => {
        for (const h of this.handlers["open"] ?? []) {
          h();
        }
      });
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      (this.handlers[event] ??= []).push(handler);
    }
    once(event: string, handler: (...args: unknown[]) => void) {
      this.on(event, handler);
    }
    off() {
      /* no-op */
    }
    removeAllListeners() {
      /* no-op */
    }
    readyState = 3; // CLOSED: keeps manager.close() from trying to close again.
    send() {
      /* no-op */
    }
    close() {
      /* no-op */
    }
  },
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: class FakeHttpsProxyAgent {
    constructor(public proxyUrl: string) {}
  },
}));

const { OpenAIWebSocketManager } = await import("./openai-ws-connection.js");
const { HttpsProxyAgent } = await import("https-proxy-agent");

async function openOne(config: unknown): Promise<FakeOpts> {
  hoisted.sockets.length = 0;
  const manager = new OpenAIWebSocketManager({ config: config as never });
  await manager.connect("sk-test").catch(() => undefined);
  manager.close();
  return hoisted.sockets[0]?.opts ?? {};
}

describe("OpenAI WebSocket egress", () => {
  it("uses the declared model proxy when one is declared", async () => {
    const opts = await openOne({ models: { proxy: "http://egress.example:3128" } });

    expect(opts.agent).toBeInstanceOf(HttpsProxyAgent);
    expect((opts.agent as { proxyUrl: string }).proxyUrl).toBe("http://egress.example:3128");
  });

  it("connects directly when nothing is declared", async () => {
    const opts = await openOne({});

    // No `agent` key at all: `ws` then uses its own default, which never consults the environment.
    expect(opts).not.toHaveProperty("agent");
  });

  it("treats a blank declaration as undeclared", async () => {
    const opts = await openOne({ models: { proxy: "   " } });

    expect(opts).not.toHaveProperty("agent");
  });

  it("ignores ambient proxy variables entirely", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("https_proxy", "http://127.0.0.1:9");
    try {
      const opts = await openOne({});
      expect(opts).not.toHaveProperty("agent");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still sends the auth headers alongside the proxy agent", async () => {
    const opts = await openOne({ models: { proxy: "http://egress.example:3128" } });

    expect(opts.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "OpenAI-Beta": "responses-websocket=v1",
    });
  });
});
