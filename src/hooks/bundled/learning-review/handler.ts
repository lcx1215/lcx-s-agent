import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { compactText, createSessionArtifactHandler, type SessionTurn } from "../artifact-memory.js";

const log = createSubsystemLogger("hooks/learning-review");

const LEARNING_KEYWORDS = [
  "prove",
  "proof",
  "derive",
  "derivation",
  "equation",
  "algebra",
  "calculus",
  "derivative",
  "integral",
  "matrix",
  "linear algebra",
  "eigen",
  "probability",
  "statistics",
  "bayes",
  "expectation",
  "variance",
  "optimization",
  "math",
  "quant",
  "复盘",
  "查漏补缺",
  "推导",
  "证明",
  "概率",
  "统计",
  "导数",
  "积分",
  "矩阵",
  "线代",
  "数学",
];

export type LearningReviewHints = {
  principle: string;
  mistake: string;
  drill: string;
  transfer: string;
};

export type LearningSessionSummary = {
  topic: string;
  hints: LearningReviewHints;
};

export function looksLikeLearningSession(turns: SessionTurn[]): boolean {
  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  return LEARNING_KEYWORDS.some((keyword) => joined.includes(keyword));
}

export function inferTopic(turns: SessionTurn[]): string {
  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  if (joined.includes("probability") || joined.includes("bayes") || joined.includes("概率")) {
    return "probability-and-statistics";
  }
  if (
    joined.includes("matrix") ||
    joined.includes("eigen") ||
    joined.includes("linear algebra") ||
    joined.includes("矩阵") ||
    joined.includes("线代")
  ) {
    return "linear-algebra";
  }
  if (
    joined.includes("derivative") ||
    joined.includes("integral") ||
    joined.includes("calculus") ||
    joined.includes("导数") ||
    joined.includes("积分")
  ) {
    return "calculus";
  }
  if (joined.includes("prove") || joined.includes("proof") || joined.includes("证明")) {
    return "proof-technique";
  }
  if (joined.includes("optimization") || joined.includes("最优")) {
    return "optimization";
  }
  return "math-reasoning";
}

export function reviewHintsForTopic(topic: string): LearningReviewHints {
  switch (topic) {
    case "probability-and-statistics":
      return {
        principle: "先定义随机变量、事件和条件信息，再展开公式。",
        mistake: "容易把直觉当成概率关系，或者在没有定义事件的情况下直接代公式。",
        drill: "写出一个条件概率题的事件定义，再用 Bayes 定理完整展开一次。",
        transfer: "这个模式会迁移到假设检验、期望分解和风险归因。",
      };
    case "linear-algebra":
      return {
        principle: "先看对象的维度、线性映射关系和不变量，再做运算。",
        mistake: "容易跳过维度检查，导致乘法顺序、特征结构或基变换出错。",
        drill: "任取一个 2x2 矩阵，先写维度和映射，再判断可逆性与特征值。",
        transfer: "这个模式会迁移到回归、PCA、状态转移和最优化。",
      };
    case "calculus":
      return {
        principle: "先确认目标量、变量关系和适用法则，再推导。",
        mistake: "容易在链式法则、积分变量替换和边界条件上漏一步。",
        drill: "选一道复合函数求导题，逐步标明内外层函数与每一步导数。",
        transfer: "这个模式会迁移到增长率、敏感度分析和连续时间模型。",
      };
    case "proof-technique":
      return {
        principle: "先写清假设、欲证结论和证明策略，再推进每一步。",
        mistake: "容易把结论当前提用，或省略关键的桥接论证。",
        drill: "给一个简单命题，分别尝试直接证明和反证法并比较差异。",
        transfer: "这个模式会迁移到算法正确性、上界下界和逻辑推理。",
      };
    case "optimization":
      return {
        principle: "先明确目标函数、约束和可行域，再谈最优性。",
        mistake: "容易只盯一阶条件，忽略约束、边界或凸性。",
        drill: "写一个单变量优化题，分别检查一阶条件、二阶条件和边界。",
        transfer: "这个模式会迁移到投资组合、资源配置和机器学习训练。",
      };
    default:
      return {
        principle: "先定义对象和关系，再选方法，最后做 sanity check。",
        mistake: "容易跳步，把局部直觉当成完整推理链。",
        drill: "找一道同主题小题，完整写出 givens、method、steps、checks。",
        transfer: "这个模式会迁移到所有需要分步推导和验算的任务。",
      };
  }
}

export function summarizeLearningSession(turns: SessionTurn[]): LearningSessionSummary {
  const topic = inferTopic(turns);
  return {
    topic,
    hints: reviewHintsForTopic(topic),
  };
}

const saveLearningReview = createSessionArtifactHandler({
  logger: log,
  successMessage: "Learning review",
  failureMessage: "Failed to save learning review",
  messageCount: 18,
  slugPrefix: "review",
  shouldPersist: looksLikeLearningSession,
  fallbackSlug: (turns) => `review-${inferTopic(turns)}`,
  renderContent: ({ event, sessionId, turns, dateStr, timeStr }) => {
    const { topic, hints } = summarizeLearningSession(turns);
    const latestTurns = turns.toReversed();
    const latestUser = latestTurns.find((turn) => turn.role === "user")?.text ?? "";
    const latestAssistant = latestTurns.find((turn) => turn.role === "assistant")?.text ?? "";

    return [
      `# Learning Review: ${dateStr} ${timeStr} UTC`,
      "",
      `- **Session Key**: ${event.sessionKey}`,
      `- **Session ID**: ${sessionId ?? "unknown"}`,
      `- **Topic**: ${topic}`,
      "",
      "## Problem",
      `- ${compactText(latestUser || turns[0]?.text || "Study-heavy session")}`,
      "",
      "## Working Answer",
      `- ${compactText(latestAssistant || "No assistant answer captured.")}`,
      "",
      "## Review Note",
      `- mistake_pattern: ${hints.mistake}`,
      `- core_principle: ${hints.principle}`,
      `- micro_drill: ${hints.drill}`,
      `- transfer_hint: ${hints.transfer}`,
      "",
      "## Session Trace",
      ...turns.slice(-8).map((turn) => `- ${turn.role}: ${compactText(turn.text, 160)}`),
      "",
    ].join("\n");
  },
});

export default saveLearningReview;
