import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setLocalGatewayProvider: vi.fn(() => vi.fn()),
  createLocalCronService: vi.fn(),
  createLocalCronGatewayCaller: vi.fn(() => vi.fn()),
  startHeartbeatRunner: vi.fn(),
  cronStart: vi.fn(),
  cronStop: vi.fn(),
  heartbeatStop: vi.fn(),
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
vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: mocks.startHeartbeatRunner,
}));

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
    mocks.startHeartbeatRunner.mockReturnValue({ stop: mocks.heartbeatStop });
  });

  it("installs a heartbeat consumer beside the daemon-free cron service", async () => {
    const handle = installServeLocalCron({ deps: {} as never });

    expect(mocks.startHeartbeatRunner).toHaveBeenCalledWith({ cfg: undefined });
    expect(handle.heartbeatRunner).toEqual({ stop: mocks.heartbeatStop });
    expect(mocks.cronStart).toHaveBeenCalledTimes(1);

    await handle.dispose();
    expect(mocks.heartbeatStop).toHaveBeenCalledTimes(1);
    expect(mocks.cronStop).toHaveBeenCalledTimes(1);
  });
});
