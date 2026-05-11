import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";

describe("maybeCreateDynamicAgent", () => {
  it("treats an existing lark binding as a valid existing dynamic binding", async () => {
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      config: { writeConfigFile },
    } as unknown as PluginRuntime;

    const cfg = {
      bindings: [
        {
          agentId: "feishu-ou_lark_user",
          match: { channel: "lark", peer: { kind: "direct", id: "ou_lark_user" } },
        },
      ],
      agents: {
        list: [{ id: "feishu-ou_lark_user", workspace: "/tmp/ws", agentDir: "/tmp/agent" }],
      },
    } as unknown as OpenClawConfig;

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      senderOpenId: "ou_lark_user",
      dynamicCfg: { enabled: true },
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(result.updatedCfg).toBe(cfg);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("treats an existing lark chain binding as an existing dynamic binding", async () => {
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      config: { writeConfigFile },
    } as unknown as PluginRuntime;

    const cfg = {
      bindings: [
        {
          agentId: "feishu-ou_lark_user",
          match: {
            channel: "lark:dm:ou_lark_user",
            peer: { kind: "direct", id: "ou_lark_user" },
          },
        },
      ],
      agents: {
        list: [{ id: "feishu-ou_lark_user", workspace: "/tmp/ws", agentDir: "/tmp/agent" }],
      },
    } as unknown as OpenClawConfig;

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      senderOpenId: "ou_lark_user",
      dynamicCfg: { enabled: true },
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(result.updatedCfg).toBe(cfg);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("adds missing feishu binding for an existing dynamic agent", async () => {
    const writeConfigFile = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      config: { writeConfigFile },
    } as unknown as PluginRuntime;

    const cfg = {
      bindings: [],
      agents: {
        list: [{ id: "feishu-ou_existing", workspace: "/tmp/ws", agentDir: "/tmp/agent" }],
      },
    } as unknown as OpenClawConfig;

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      senderOpenId: "ou_existing",
      dynamicCfg: { enabled: true },
      log: vi.fn(),
    });

    expect(result.created).toBe(true);
    const updatedBindings = result.updatedCfg.bindings;
    expect(updatedBindings?.length).toBe(1);
    expect(updatedBindings?.[0]).toMatchObject({
      agentId: "feishu-ou_existing",
      match: {
        channel: "feishu",
        peer: {
          kind: "direct",
          id: "ou_existing",
        },
      },
    });
    expect(writeConfigFile).toHaveBeenCalledTimes(1);
  });
});
