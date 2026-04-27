import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools local_memory_record registration", () => {
  it("includes local_memory_record", () => {
    const tools = createOpenClawTools();
    expect(tools.some((tool) => tool.name === "local_memory_record")).toBe(true);
  });
});
