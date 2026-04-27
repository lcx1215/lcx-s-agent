import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { resolveToolsConfig } from "./tools-config.js";

describe("feishu tools config", () => {
  it("enables chat and work-role tools by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.chat).toBe(true);
    expect(resolved.workRoles).toBe(true);
  });

  it("accepts tools.chat and tools.workRoles in config schema", () => {
    const parsed = FeishuConfigSchema.parse({
      enabled: true,
      tools: {
        chat: false,
        workRoles: false,
      },
    });

    expect(parsed.tools?.chat).toBe(false);
    expect(parsed.tools?.workRoles).toBe(false);
  });
});
