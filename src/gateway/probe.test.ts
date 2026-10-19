import { describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
}));
const tlsFingerprintState = vi.hoisted(() => ({ fingerprint: "sha256:local-fingerprint" }));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    gatewayClientState.options = opts;
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        const onHelloOk = this.opts.onHelloOk;
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  stop(): void {}

  async request(method: string): Promise<unknown> {
    if (method === "system-presence") {
      return [];
    }
    return {};
  }
}

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

vi.mock("../config/config.js", () => ({
  resolveGatewayPort: () => 18789,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => "100.64.0.10",
}));

vi.mock("./net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./net.js")>();
  return {
    ...actual,
    pickPrimaryLanIPv4: () => "192.168.1.20",
  };
});

vi.mock("../infra/tls/gateway.js", () => ({
  readGatewayTlsFingerprint: async () => tlsFingerprintState.fingerprint,
}));

const { probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  it("connects with operator.read scope", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(result.ok).toBe(true);
  });

  it("pins the configured certificate for the exact local TLS endpoint", async () => {
    await probeGateway({
      url: "wss://127.0.0.1:18789",
      config: { gateway: { tls: { enabled: true } } },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBe("sha256:local-fingerprint");
  });

  it.each([
    { bind: "lan" as const, url: "wss://192.168.1.20:18789" },
    { bind: "tailnet" as const, url: "wss://100.64.0.10:18789" },
  ])("pins the configured certificate for the local $bind address", async ({ bind, url }) => {
    await probeGateway({
      url,
      config: { gateway: { bind, tls: { enabled: true } } },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBe("sha256:local-fingerprint");
  });

  it("uses the configured remote pin only for its exact URL", async () => {
    await probeGateway({
      url: "wss://remote.example:9443/ws",
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://remote.example:9443/ws",
            tlsFingerprint: "sha256:remote-fingerprint",
          },
        },
      },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBe("sha256:remote-fingerprint");
  });

  it("does not reuse the local TLS pin for an unrelated explicit endpoint", async () => {
    await probeGateway({
      url: "wss://attacker.example:18789",
      config: { gateway: { tls: { enabled: true } } },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBeUndefined();
  });
});
