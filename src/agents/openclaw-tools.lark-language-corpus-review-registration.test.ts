import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools lark_language_corpus_review registration", () => {
  it("includes lark_language_corpus_review", () => {
    const tools = createOpenClawTools();
    expect(tools.some((tool) => tool.name === "lark_language_corpus_review")).toBe(true);
  });
});
