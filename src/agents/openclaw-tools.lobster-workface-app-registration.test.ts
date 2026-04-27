import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools lobster_workface_app registration", () => {
  it("includes lobster_workface_app", () => {
    const tools = createOpenClawTools();
    expect(tools.some((tool) => tool.name === "lobster_workface_app")).toBe(true);
  });
});
