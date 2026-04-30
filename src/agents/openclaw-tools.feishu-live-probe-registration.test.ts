import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools feishu_live_probe registration", () => {
  it("includes feishu_live_probe", () => {
    const tools = createOpenClawTools();
    expect(tools.some((tool) => tool.name === "feishu_live_probe")).toBe(true);
  });

  it("exposes a usable schema for lazy feishu_live_probe", () => {
    const tools = createOpenClawTools();
    const tool = tools.find((candidate) => candidate.name === "feishu_live_probe");

    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        surface: expect.objectContaining({
          enum: expect.arrayContaining(["control_room", "learning_command"]),
        }),
        message: expect.objectContaining({ type: "string" }),
        mustContainAny: expect.objectContaining({ type: "array" }),
        mustNotContain: expect.objectContaining({ type: "array" }),
      }),
      required: ["message"],
    });
  });

  it("exposes a usable schema for lazy lark_language_corpus_review", () => {
    const tools = createOpenClawTools();
    const tool = tools.find((candidate) => candidate.name === "lark_language_corpus_review");

    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        dateKey: expect.objectContaining({ type: "string" }),
        maxFiles: expect.objectContaining({ type: "number" }),
        writeReview: expect.objectContaining({ type: "boolean" }),
      }),
    });
  });
});
