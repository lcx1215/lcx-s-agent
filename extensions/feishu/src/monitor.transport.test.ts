import { describe, expect, it, vi } from "vitest";
import { monitorWebSocket } from "./monitor.transport.js";

const startMock = vi.hoisted(() => vi.fn());
const recordOperationalAnomalyMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuWSClient: vi.fn(() => ({
    start: startMock,
  })),
}));

vi.mock("../../../src/infra/operational-anomalies.js", () => ({
  recordOperationalAnomaly: recordOperationalAnomalyMock,
}));

describe("Feishu transport anomaly reporting", () => {
  it("records a structured anomaly when websocket startup fails", async () => {
    startMock.mockImplementationOnce(() => {
      throw new Error("ws start exploded");
    });

    await expect(
      monitorWebSocket({
        cfg: {
          agents: { defaults: { workspace: "/tmp/openclaw-feishu-transport" } },
        },
        account: {
          accountId: "alpha",
          selectionSource: "explicit",
          enabled: true,
          configured: true,
          domain: "lark",
          config: {
            appId: "cli_alpha",
            appSecret: "secret_alpha",
            connectionMode: "websocket",
          } as never,
          appId: "cli_alpha",
          appSecret: "secret_alpha",
        },
        accountId: "alpha",
        eventDispatcher: {} as never,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      }),
    ).rejects.toThrow(/ws start exploded/i);

    expect(recordOperationalAnomalyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "provider_degradation",
        source: "feishu.monitor.transport",
        problem: "websocket transport startup failed",
      }),
    );
  });
});
