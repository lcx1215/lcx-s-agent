import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { requestHeartbeatNow, resetHeartbeatWakeStateForTests } from "../infra/heartbeat-wake.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { enqueueCommandInLane, getQueueSize, resetAllLanes } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createDefaultDeps } from "./deps.js";

const mocks = vi.hoisted(() => ({ reply: vi.fn(), send: vi.fn() }));
vi.mock("../auto-reply/reply.js", () => ({ getReplyFromConfig: mocks.reply }));
vi.mock("../infra/outbound/deliver.js", () => ({ deliverOutboundPayloads: mocks.send }));
// Cron production is covered separately; keep the actual serve-owned wake consumer here.
vi.mock("../cron/local-service.js", () => ({
  createLocalCronService: ({ cfg }: { cfg: OpenClawConfig }) => ({
    cron: { start: async () => {}, stop: () => {} },
    storePath: cfg.cron?.store,
    cronEnabled: false,
  }),
}));
vi.mock("../gateway/local-cron-bridge.js", () => ({
  LOCAL_CRON_METHODS: new Set(["cron.add"]),
  createLocalCronGatewayCaller: () => async () => {
    throw new Error("unexpected cron RPC");
  },
}));
import { installServeLocalCron, type ServeCronHandle } from "./serve-cron.js";

let root: string;
let cfg: OpenClawConfig;
let handle: ServeCronHandle | undefined;
let releaseBusy: (() => void) | undefined;
let busyTask: Promise<void> | undefined;
let unsubscribe: (() => void) | undefined;
let previousRegistry: ReturnType<typeof getActivePluginRegistry>;
const completed = vi.fn();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "serve-heartbeat-consumer-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  await fs.writeFile(path.join(root, "HEARTBEAT.md"), "- Check fixture status\n");
  await fs.writeFile(path.join(root, "sessions.json"), "{}");
  cfg = {
    agents: { defaults: { workspace: root, heartbeat: { every: "30m", target: "none" } } },
    session: { store: path.join(root, "sessions.json") },
    cron: { enabled: false, store: path.join(root, "cron.json") },
  };
  mocks.reply.mockReset().mockResolvedValue({ text: "HEARTBEAT_OK" });
  mocks.send.mockReset().mockRejectedValue(new Error("external send forbidden"));
  completed.mockReset();
  previousRegistry = getActivePluginRegistry();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) => ({ ok: true, to: to ?? "fixture-recipient" }),
            sendText: async () => {
              throw new Error("channel transport must not be called");
            },
          },
        }),
      },
    ]),
  );
  unsubscribe = onHeartbeatEvent(completed);
  resetHeartbeatWakeStateForTests();
  resetAllLanes();
  vi.useFakeTimers();
});
afterEach(async () => {
  await handle?.dispose();
  handle = undefined;
  releaseBusy?.();
  await busyTask;
  releaseBusy = undefined;
  busyTask = undefined;
  unsubscribe?.();
  resetHeartbeatWakeStateForTests();
  resetAllLanes();
  setActivePluginRegistry(previousRegistry ?? createTestRegistry());
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function install() {
  handle = installServeLocalCron({ cfg, deps: createDefaultDeps() });
}
async function expectConsumedOnce() {
  await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
  expect(completed.mock.calls[0]?.[0]).toMatchObject({ status: "ok-token" });
  expect(mocks.reply).toHaveBeenCalledTimes(1);
  expect(mocks.reply.mock.calls[0]?.[2]).toBe(cfg);
  expect(mocks.reply.mock.calls[0]?.[1]).toMatchObject({ disableMessageTool: true });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.reply).toHaveBeenCalledTimes(1);
  expect(mocks.send).not.toHaveBeenCalled();
}

describe("serve heartbeat consumer", () => {
  it("does not turn configured heartbeat intervals into autonomous serve turns", async () => {
    install();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();

    handle?.heartbeatRunner.updateConfig({
      ...cfg,
      agents: { defaults: { ...cfg.agents?.defaults, heartbeat: { every: "1m" } } },
    });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it.each(["telegram", "last"] as const)(
    "keeps a cron wake alert internal despite the configured %s target",
    async (target) => {
      cfg.agents!.defaults!.heartbeat = { every: "30m", target, to: "12345" };
      await fs.writeFile(
        path.join(root, "sessions.json"),
        JSON.stringify({
          [resolveMainSessionKey(cfg)]: {
            sessionId: "fixture-session",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "12345",
          },
        }),
      );
      mocks.reply.mockResolvedValue({ text: "A fixture reminder needs attention." });
      mocks.send.mockResolvedValue([]);
      install();
      requestHeartbeatNow({ reason: "cron:internal-alert", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
      expect(mocks.reply).toHaveBeenCalledTimes(1);
      expect(mocks.reply.mock.calls[0]?.[0]).toMatchObject({ OriginatingChannel: undefined });
      expect(mocks.reply.mock.calls[0]?.[1]).toMatchObject({ disableMessageTool: true });
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("does not send heartbeat acknowledgements to an inherited channel target", async () => {
    cfg.agents!.defaults!.heartbeat = { every: "30m", target: "telegram", to: "12345" };
    cfg.channels = { telegram: { heartbeat: { showOk: true } } };
    mocks.send.mockResolvedValue([]);
    install();
    requestHeartbeatNow({ reason: "cron:internal-ack", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.reply.mock.calls[0]?.[1]).toMatchObject({ disableMessageTool: true });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("consumes a wake deferred before registration exactly once and stops on dispose", async () => {
    requestHeartbeatNow({ reason: "cron:fixture", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.reply).not.toHaveBeenCalled();
    install();
    await vi.advanceTimersByTimeAsync(250);
    await expectConsumedOnce();
    await handle?.dispose();
    requestHeartbeatNow({ reason: "cron:after-dispose", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("retries a real busy main lane and consumes the wake once after it clears", async () => {
    busyTask = enqueueCommandInLane(
      CommandLane.Main,
      () =>
        new Promise<void>((resolve) => {
          releaseBusy = resolve;
        }),
    );
    expect(getQueueSize(CommandLane.Main)).toBe(1);
    install();
    requestHeartbeatNow({ reason: "cron:busy-fixture", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mocks.reply).not.toHaveBeenCalled();
    releaseBusy?.();
    await busyTask;
    expect(getQueueSize(CommandLane.Main)).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectConsumedOnce();
  });
});
