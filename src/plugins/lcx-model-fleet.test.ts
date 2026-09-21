import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vision from "../agents/local-vision-vlm.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
afterEach(() => vi.restoreAllMocks());
import fleet from "./lcx-model-fleet.js";
import type { OpenClawPluginApi } from "./types.js";

describe("LCX model fleet plugin", () => {
  it("leaves shared research tools to the core registry", () => {
    const registrations: unknown[] = [];
    const api = {
      config: {},
      pluginConfig: {
        slotModels: {
          fast: "provider/fast",
          reasoning: "provider/fast",
          review: "review/model",
        },
      },
      registerTool: (tool: unknown) => registrations.push(tool),
      on: () => undefined,
      registerService: () => undefined,
    } as unknown as OpenClawPluginApi;

    fleet.register?.(api);
    expect(registrations.map((registration) => (registration as { name?: string }).name)).toEqual([
      "lcx_model_roster",
      "local_vision",
    ]);
  });
});

it("bounds vision attempts and returns control to the agent on failure", async () => {
  vi.spyOn(fs, "readFile").mockResolvedValue("a".repeat(40));
  vi.spyOn(fs, "realpath").mockResolvedValue("/synthetic/snapshot");
  const invoke = vi.spyOn(vision, "runLocalVisionVlm").mockRejectedValue(new Error("timeout"));
  const tools: AnyAgentTool[] = [];
  fleet.register({
    config: {},
    pluginConfig: {
      slotModels: { fast: "test/fast", reasoning: "test/fast", review: "test/review" },
    },
    registerTool: (tool: AnyAgentTool) => tools.push(tool),
    on: () => undefined,
    registerService: () => undefined,
  } as unknown as OpenClawPluginApi);
  const tool = tools.find((entry) => entry.name === "local_vision")!;
  const args = { imageBase64: "YQ==", mimeType: "image/png", prompt: "Describe supplied image" };
  expect((await tool.execute("one", args)).details).toMatchObject({
    status: "fallback_to_agent",
    reason: "local_vision_unavailable",
    finalAuthority: false,
  });
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({ timeoutMs: 30_000, maxTokens: 256 }),
  );
  expect((await tool.execute("two", args)).details).toMatchObject({
    reason: "local_vision_unavailable",
  });
  expect(invoke).toHaveBeenCalledTimes(2);
  await expect(tool.execute("override", { ...args, modelId: "arbitrary" })).rejects.toThrow(
    "only imageBase64",
  );
});
