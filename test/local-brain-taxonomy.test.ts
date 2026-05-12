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

  it("adds all-module internalization rules when learning should not be factor-only", () => {
    const hints = selectLocalBrainContractHints("不止是因子模块，其他模块也要有这种学习内化链条");
    const text = hints.join(" ");

    expect(text).toContain("All module learning uses the same internalization chain");
    expect(text).toContain("retrieval receipt");
    expect(text).toContain("fresh adjacent task");
    expect(text).toContain("module_learning_pipeline_review status");
  });

  it("adds advanced trader QC module rules for valuation and artifact asks", () => {
    const hints = selectLocalBrainContractHints(
      "DCF comps 财务模型 估值 研报 QC 数据口径 catalyst",
    );
    const text = hints.join(" ");

    expect(text).toContain("financial_modeling_valuation_qc");
    expect(text).toContain("thesis_catalyst_lifecycle");
    expect(text).toContain("data_provenance_quality");
    expect(text).toContain("research_artifact_qc");
  });
});
