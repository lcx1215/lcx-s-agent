import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools feishu_live_probe registration", () => {
  it("includes feishu_live_probe", () => {
    const tools = createOpenClawTools();
    expect(tools.some((tool) => tool.name === "feishu_live_probe")).toBe(true);
  });
});
