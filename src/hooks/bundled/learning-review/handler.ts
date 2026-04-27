import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { compactText, createSessionArtifactHandler, type SessionTurn } from "../artifact-memory.js";
import { renderLearningReviewMemoryNote } from "../lobster-brain-registry.js";

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
  "backtest",
  "factor",
  "alpha",
  "portfolio",
  "time series",
  "volatility",
  "garch",
  "arch",
  "lstm",
  "arima",
  "coding",
  "code",
  "programming",
  "debug",
  "refactor",
  "python",
  "typescript",
  "javascript",
  "pytorch",
  "torch",
  "paper",
  "whitepaper",
  "arxiv",
  "research paper",
  "earnings",
  "10-k",
  "10-q",
  "annual report",
  "quarterly report",
  "fundamental",
  "macro",
  "market structure",
  "regime",
  "strategy audit",
  "overfit",
  "overfitting",
  "oos",
  "out of sample",
  "walk-forward",
  "github",
  "repo",
  "repository",
  "architecture",
  "system design",
  "agent",
  "agents",
  "workflow",
  "framework",
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
  "量化",
  "回测",
  "因子",
  "波动率",
  "时序",
  "代码",
  "编程",
  "调试",
  "脚本",
  "论文",
  "白皮书",
  "财报",
  "年报",
  "季报",
  "基本面",
  "宏观",
  "市场结构",
  "市场状态",
  "策略审计",
  "过拟合",
  "样本外",
  "架构",
  "系统设计",
  "智能体",
  "工作流",
  "仓库",
  "开源项目",
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

type LearningFoundationTemplate =
  | "portfolio-sizing-discipline"
  | "risk-transmission"
  | "outcome-review"
  | "execution-hygiene";

export function looksLikeLearningSession(turns: SessionTurn[]): boolean {
  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  return LEARNING_KEYWORDS.some((keyword) => joined.includes(keyword));
}

export function inferTopic(turns: SessionTurn[]): string {
  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  if (
    joined.includes("paper") ||
    joined.includes("whitepaper") ||
    joined.includes("arxiv") ||
    joined.includes("research paper") ||
    joined.includes("论文") ||
    joined.includes("白皮书")
  ) {
    return "paper-and-method-reading";
  }
  if (
    joined.includes("earnings") ||
    joined.includes("10-k") ||
    joined.includes("10-q") ||
    joined.includes("annual report") ||
    joined.includes("quarterly report") ||
    joined.includes("fundamental") ||
    joined.includes("财报") ||
    joined.includes("年报") ||
    joined.includes("季报") ||
    joined.includes("基本面")
  ) {
    return "fundamental-reading-and-risk";
  }
  if (
    joined.includes("macro") ||
    joined.includes("market structure") ||
    joined.includes("regime") ||
    joined.includes("宏观") ||
    joined.includes("市场结构") ||
    joined.includes("市场状态")
  ) {
    return "macro-and-market-structure";
  }
  if (
    joined.includes("github") ||
    joined.includes("repo") ||
    joined.includes("repository") ||
    joined.includes("architecture") ||
    joined.includes("system design") ||
    joined.includes("agent") ||
    joined.includes("agents") ||
    joined.includes("workflow") ||
    joined.includes("framework") ||
    joined.includes("架构") ||
    joined.includes("系统设计") ||
    joined.includes("智能体") ||
    joined.includes("工作流") ||
    joined.includes("仓库") ||
    joined.includes("开源项目")
  ) {
    return "agent-architecture-and-workflows";
  }
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
  if (
    joined.includes("time series") ||
    joined.includes("volatility") ||
    joined.includes("garch") ||
    joined.includes("arch") ||
    joined.includes("lstm") ||
    joined.includes("arima") ||
    joined.includes("波动率") ||
    joined.includes("时序")
  ) {
    return "time-series-and-volatility";
  }
  if (
    joined.includes("strategy audit") ||
    joined.includes("overfit") ||
    joined.includes("overfitting") ||
    joined.includes("oos") ||
    joined.includes("out of sample") ||
    joined.includes("walk-forward") ||
    joined.includes("策略审计") ||
    joined.includes("过拟合") ||
    joined.includes("样本外")
  ) {
    return "strategy-audit-and-overfit";
  }
  if (
    joined.includes("quant") ||
    joined.includes("backtest") ||
    joined.includes("factor") ||
    joined.includes("alpha") ||
    joined.includes("portfolio") ||
    joined.includes("量化") ||
    joined.includes("回测") ||
    joined.includes("因子")
  ) {
    return "quant-modeling";
  }
  if (
    joined.includes("coding") ||
    joined.includes("code") ||
    joined.includes("programming") ||
    joined.includes("debug") ||
    joined.includes("refactor") ||
    joined.includes("python") ||
    joined.includes("typescript") ||
    joined.includes("javascript") ||
    joined.includes("pytorch") ||
    joined.includes("torch") ||
    joined.includes("代码") ||
    joined.includes("编程") ||
    joined.includes("调试") ||
    joined.includes("脚本")
  ) {
    return "coding-and-systems";
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
    case "paper-and-method-reading":
      return {
        principle: "先抓问题定义、方法假设、评估协议和可迁移方法，再看结果包装。",
        mistake: "容易先被结论和图表带走，忽略方法前提、数据边界和复现成本。",
        drill: "读一篇论文时，先写四行：问题、方法、评估、最值得迁移的一点。",
        transfer: "这个模式会迁移到论文阅读、GitHub 仓库学习和新方法 intake。",
      };
    case "fundamental-reading-and-risk":
      return {
        principle: "先抓业务驱动、风险暴露、管理层口径和可证伪点，再看叙事。",
        mistake: "容易把公司讲法当事实，或只记增长亮点而漏掉风险和弱点。",
        drill: "读一个财报或年报时，补出三条驱动、三条风险和一条证伪条件。",
        transfer: "这个模式会迁移到财报阅读、基本面筛选和风险提炼。",
      };
    case "macro-and-market-structure":
      return {
        principle: "先分清驱动变量、传导链和当前 regime，再下市场判断。",
        mistake: "容易把价格动作当因果，或把旧 regime 经验套到新环境。",
        drill: "对一个市场主题先写：当前 regime、主驱动、失效条件。",
        transfer: "这个模式会迁移到 ETF 观察、宏观判断和 timing discipline。",
      };
    case "strategy-audit-and-overfit":
      return {
        principle: "先查样本外、脆弱性、成本和容量，再决定要不要信这个策略。",
        mistake: "容易把平滑净值、高 Sharpe 和漂亮参数面当成 robust edge。",
        drill: "拿一个回测先补三项：OOS、参数脆弱性、成本/流动性 sanity check。",
        transfer: "这个模式会迁移到策略审计、因子筛选和风险闸门。",
      };
    case "agent-architecture-and-workflows":
      return {
        principle: "先画边界、状态流、失败面和人工接管点，再评价架构。",
        mistake: "容易只看组件列表和理想流程，忽略 shared state、回退路径和可验证性。",
        drill: "学一个系统或 GitHub 仓库时，先写输入、状态、失败、验收四栏。",
        transfer: "这个模式会迁移到 AI 智能体、系统架构、工作流和自我改造设计。",
      };
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
    case "time-series-and-volatility":
      return {
        principle: "先分清状态变量、观测量和滞后结构，再谈预测和波动传导。",
        mistake: "容易把拟合效果当预测能力，或忽略 regime shift、滞后项和样本外失效。",
        drill: "拿一个波动率或时序模型，写清输入、滞后、目标和一条样本外失效条件。",
        transfer: "这个模式会迁移到 regime 识别、波动率建模和低频交易节奏判断。",
      };
    case "quant-modeling":
      return {
        principle: "先界定信号、样本外检验和失效条件，再看回测表现。",
        mistake: "容易把高 Sharpe、平滑净值和调参结果当成可复用 edge。",
        drill: "选一个因子或回测，补一条 OOS 检验和一条参数脆弱性检查。",
        transfer: "这个模式会迁移到策略审计、候选池排序和风险过滤。",
      };
    case "coding-and-systems":
      return {
        principle: "先确认边界、状态流和失败语义，再写实现。",
        mistake: "容易只看 happy path，忽略 shared state、回退路径和可验证性。",
        drill: "对当前改动写出 failure mode、smallest safe patch 和 proof test。",
        transfer: "这个模式会迁移到代理编排、bookkeeping 和长期可维护性。",
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

export function foundationTemplateForTopic(topic: string): LearningFoundationTemplate {
  switch (topic) {
    case "paper-and-method-reading":
      return "outcome-review";
    case "fundamental-reading-and-risk":
      return "outcome-review";
    case "macro-and-market-structure":
      return "risk-transmission";
    case "strategy-audit-and-overfit":
      return "portfolio-sizing-discipline";
    case "agent-architecture-and-workflows":
      return "execution-hygiene";
    case "optimization":
      return "portfolio-sizing-discipline";
    case "quant-modeling":
      return "portfolio-sizing-discipline";
    case "calculus":
    case "linear-algebra":
    case "time-series-and-volatility":
      return "risk-transmission";
    case "probability-and-statistics":
    case "proof-technique":
      return "outcome-review";
    case "coding-and-systems":
      return "execution-hygiene";
    default:
      return "execution-hygiene";
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
    const foundationTemplate = foundationTemplateForTopic(topic);
    const latestTurns = turns.toReversed();
    const latestUser = latestTurns.find((turn) => turn.role === "user")?.text ?? "";
    const latestAssistant = latestTurns.find((turn) => turn.role === "assistant")?.text ?? "";
    return renderLearningReviewMemoryNote({
      dateStr,
      timeStr,
      sessionKey: event.sessionKey,
      sessionId: sessionId ?? "unknown",
      topic,
      problem: compactText(latestUser || turns[0]?.text || "Study-heavy session"),
      workingAnswer: compactText(latestAssistant || "No assistant answer captured."),
      mistakePattern: hints.mistake,
      corePrinciple: hints.principle,
      microDrill: hints.drill,
      transferHint: hints.transfer,
      foundationTemplate,
      whyItMatters: `compress this lesson into ${foundationTemplate} rather than leaving it as a loose study note.`,
      sessionTraceLines: turns
        .slice(-8)
        .map((turn) => `${turn.role}: ${compactText(turn.text, 160)}`),
    });
  },
});

export default saveLearningReview;
