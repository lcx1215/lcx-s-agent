import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools finance article source registry registration", () => {
  it("includes finance article source registry tools", () => {
    const tools = createOpenClawTools({ workspaceDir: "/tmp/openclaw" });
    expect(tools.some((tool) => tool.name === "finance_article_source_registry_record")).toBe(true);
    expect(tools.some((tool) => tool.name === "finance_article_source_collection_preflight")).toBe(
      true,
    );
    expect(tools.some((tool) => tool.name === "finance_article_source_registry_inspect")).toBe(
      true,
    );
  });
});
