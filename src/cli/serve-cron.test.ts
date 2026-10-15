import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setLocalGatewayProvider: vi.fn(() => vi.fn()),
  createLocalCronService: vi.fn(),
  createLocalCronGatewayCaller: vi.fn(() => vi.fn()),
  cronStart: vi.fn(),
  cronStop: vi.fn(),
}));

vi.mock("../agents/tools/gateway.js", () => ({
  setLocalGatewayProvider: mocks.setLocalGatewayProvider,
}));
vi.mock("../cron/local-service.js", () => ({
  createLocalCronService: mocks.createLocalCronService,
}));
vi.mock("../gateway/local-cron-bridge.js", () => ({
  createLocalCronGatewayCaller: mocks.createLocalCronGatewayCaller,
  LOCAL_CRON_METHODS: new Set(["cron.add"]),
}));

import { hasHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import { installServeLocalCron } from "./serve-cron.js";

describe("installServeLocalCron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cronStart.mockResolvedValue(undefined);
    mocks.createLocalCronService.mockReturnValue({
      cron: { start: mocks.cronStart, stop: mocks.cronStop },
      storePath: "/tmp/serve-cron-test.json",
      cronEnabled: true,
    });
  });

  it("installs a heartbeat consumer beside the daemon-free cron service", async () => {
    const cfg = { agents: { defaults: { heartbeat: { every: "1h" } } } } as never;
    const handle = installServeLocalCron({ deps: {} as never, cfg });

    expect(mocks.createLocalCronService).toHaveBeenCalledWith({ deps: {}, cfg });
    expect(handle.heartbeatRunner).toEqual(
      expect.objectContaining({ stop: expect.any(Function), updateConfig: expect.any(Function) }),
    );
    expect(mocks.cronStart).toHaveBeenCalledTimes(1);

    await handle.dispose();
    expect(mocks.cronStop).toHaveBeenCalledTimes(1);
  });

  it("stops the consumer and cron if provider assembly fails", () => {
    const cfg = { agents: { defaults: { heartbeat: { every: "1h" } } } } as never;
    mocks.setLocalGatewayProvider.mockImplementationOnce(() => {
      throw new Error("provider setup failed");
    });

    expect(() => installServeLocalCron({ deps: {} as never, cfg })).toThrow(
      "provider setup failed",
    );
    expect(mocks.cronStop).toHaveBeenCalledTimes(1);
    expect(hasHeartbeatWakeHandler()).toBe(false);
  });
});
