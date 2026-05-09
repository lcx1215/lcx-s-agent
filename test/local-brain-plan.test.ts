import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("local-brain-plan adapter selection", () => {
  it("uses the guard resolver instead of a static legacy adapter", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/local-brain-plan.ts"),
      "utf8",
    );

    expect(source).toContain("--resolve-current-adapter");
    expect(source).toContain("--bootstrap-if-missing");
    expect(source).toContain("trainingSeedAdapter");
    expect(source).toContain("adapterSelectionStatus");
    expect(source).not.toContain("thought-flow-v1-qwen3-0.6b-taxonomy-v3");
  });

  it("uses balanced JSON extraction for noisy local brain output", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/local-brain-plan.ts"),
      "utf8",
    );

    expect(source).toContain("let searchFrom = 0");
    expect(source).toContain('if (parsed && typeof parsed === "object" && !Array.isArray(parsed))');
    expect(source).not.toContain("JSON.parse(raw.slice(start, end + 1))");
  });

  it("tells the local model not to emit think blocks during planning", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/local-brain-plan.ts"),
      "utf8",
    );

    expect(source).toContain("/no_think");
    expect(source).toContain("QWEN_NO_THINK_CHAT_TEMPLATE_CONFIG = '{\"enable_thinking\":false}'");
    expect(source).toContain("--chat-template-config");
    expect(source).toContain("Do not emit chain-of-thought, markdown, or <think> blocks");
    expect(source).toContain("Keep the JSON compact and complete");
    expect(source).toContain("LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS");
    expect(source).toContain("always close the final brace");
    expect(source).toContain("Use this exact compact shape");
    expect(source).toContain('risk_boundaries":["research_only"]');
    expect(source).toContain("must use exact allowed module ids only");
    expect(source).toContain("do not invent prefixes like finance_framework_*");
    expect(source).toContain('LOCAL_BRAIN_PLAN_MAX_TOKENS = "700"');
  });
});
