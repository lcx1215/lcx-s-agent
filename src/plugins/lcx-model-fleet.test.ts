import { describe, expect, it } from "vitest";
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
