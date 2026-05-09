import { describe, expect, it } from "vitest";
import { selectLocalBrainContractHints } from "../scripts/dev/local-brain-taxonomy.js";

describe("local brain contract hint selection", () => {
  it("keeps base finance and safety contracts for ordinary asks", () => {
    const hints = selectLocalBrainContractHints("分析 QQQ、TLT、NVDA 的组合风险");

    expect(hints.join(" ")).toContain("source URL or local file");
    expect(hints.join(" ")).toContain("position_weights_and_return_series");
    expect(hints.join(" ")).toContain("Value-investing and fundamentals-first");
    expect(hints.length).toBeGreaterThanOrEqual(6);
  });

  it("adds short-language abstraction rules for simple visible user asks", () => {
    const hints = selectLocalBrainContractHints("Lark 回复看不懂，用户只说学习大宗商品");
    const text = hints.join(" ");

    expect(text).toContain("Plain-language hidden-complexity intake");
    expect(text).toContain("Plain short finance asks");
  });

  it("adds source-gated learning rules for paper and open-source tasks", () => {
    const hints = selectLocalBrainContractHints("学习 arxiv 论文和 GitHub 开源金融 agent 框架");
    const text = hints.join(" ");

    expect(text).toContain("External knowledge internalization");
    expect(text).toContain("Agent skill learning tasks");
    expect(text).toContain("External financial agent frameworks");
  });
});
