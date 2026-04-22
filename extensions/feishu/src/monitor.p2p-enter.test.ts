import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

function buildAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test",
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

describe("monitorSingleAccount p2p entered handler", () => {
  beforeEach(() => {
    handlers = {};
    createEventDispatcherMock.mockReset();
    monitorWebSocketMock.mockReset();
    monitorWebhookMock.mockReset();
    setFeishuRuntime(createPluginRuntimeMock({}));
  });

  it("registers and cleanly handles bot_p2p_chat_entered events", async () => {
    const log = vi.fn();
    const error = vi.fn();
    createEventDispatcherMock.mockReturnValue({
      register: vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
        handlers = registered;
      }),
    });

    await monitorSingleAccount({
      cfg: {} as ClawdbotConfig,
      account: buildAccount(),
      runtime: {
        log,
        error,
        exit: vi.fn(),
      } as RuntimeEnv,
      botOpenIdSource: { kind: "prefetched", botOpenId: "ou_bot" },
    });

    const onEntered = handlers["im.chat.access_event.bot_p2p_chat_entered_v1"];
    expect(onEntered).toBeTypeOf("function");

    await onEntered?.({
      chat_id: "oc_dm_entered",
      operator_id: { open_id: "ou_dm_user" },
    });

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "feishu[default]: user opened p2p chat oc_dm_entered (operator=ou_dm_user)",
    );
  });
});
