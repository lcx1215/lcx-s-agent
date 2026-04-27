import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { compactText, createSessionArtifactHandler, type SessionTurn } from "../artifact-memory.js";
import { renderFrontierResearchCardArtifact } from "../lobster-brain-registry.js";

const log = createSubsystemLogger("hooks/frontier-research");

type ResearchCardHints = {
  methodFamily: string;
  methodSummary: string;
  dataSetup: string;
  evaluationProtocol: string;
  keyResults: string;
  leakageRisk: string;
  overfittingRisk: string;
  replicationCost: "low" | "medium" | "high";
  adoptableIdea: string;
  doNotCopyBlindly: string;
  relevanceToLobster: string;
};

type FrontierFoundationTemplate =
  | "portfolio-sizing-discipline"
  | "risk-transmission"
  | "outcome-review"
  | "execution-hygiene";

export type FrontierSessionSummary = {
  title: string;
  materialType: "paper" | "whitepaper" | "technical_blog" | "working_notes";
  hints: ResearchCardHints;
  claimedContribution: string;
  dataSetup: string;
  evaluationProtocol: string;
  keyResults: string;
  verdict: "archive_for_knowledge" | "watch_for_followup" | "worth_reproducing" | "ignore";
};

const FRONTIER_KEYWORDS = [
  "paper",
  "whitepaper",
  "arxiv",
  "ssrn",
  "research note",
  "technical blog",
  "benchmark",
  "ablation",
  "reproduce",
  "replication",
  "leakage",
  "overfitting",
  "transformer",
  "factor model",
  "alpha model",
  "reinforcement learning",
  "multimodal",
  "论文",
  "白皮书",
  "研报方法",
  "方法研究",
  "复现",
  "泄漏",
  "过拟合",
  "因子模型",
  "时序模型",
];

export function looksLikeFrontierResearchSession(turns: SessionTurn[]): boolean {
  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  return FRONTIER_KEYWORDS.some((keyword) => joined.includes(keyword));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function findLabeledValue(params: {
  turns: SessionTurn[];
  labels: string[];
  preferredRoles?: Array<SessionTurn["role"]>;
}): string | undefined {
  const preferredRoles = params.preferredRoles ?? ["assistant", "user"];
  const patterns = params.labels.map(
    (label) =>
      new RegExp(
        `^(?:[-*]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*[:：-]\\s*(.+)$`,
        "i",
      ),
  );

  for (const role of preferredRoles) {
    const lines = params.turns
      .filter((turn) => turn.role === role)
      .flatMap((turn) => splitLines(turn.text))
      .toReversed();
    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern)?.[1]?.trim();
        if (match) {
          return match;
        }
      }
    }
  }
  return undefined;
}

function findSignalSentence(params: {
  turns: SessionTurn[];
  keywords: string[];
  preferredRoles?: Array<SessionTurn["role"]>;
}): string | undefined {
  const preferredRoles = params.preferredRoles ?? ["assistant", "user"];
  for (const role of preferredRoles) {
    const candidates = params.turns
      .filter((turn) => turn.role === role)
      .flatMap((turn) => splitSentences(turn.text))
      .toReversed();
    const match = candidates.find((sentence) => {
      const lowered = sentence.toLowerCase();
      return params.keywords.some((keyword) => lowered.includes(keyword));
    });
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function inferTitle(turns: SessionTurn[]): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["title", "paper title", "research title", "标题", "论文标题"],
  });
  if (labeled) {
    return compactText(labeled, 120);
  }

  const joined = turns.map((turn) => turn.text).join("\n");
  const quoted =
    joined.match(/["“]([^"”]{3,80})["”]/)?.[1]?.trim() ||
    joined.match(/[‘']([^'’]{3,80})[’']/)?.[1]?.trim();
  if (quoted) {
    return quoted;
  }

  const titledMatch = joined.match(
    /\b([A-Z][A-Za-z0-9-]*(?:[A-Z][A-Za-z0-9-]*|[a-z0-9-]*)(?:\s+[A-Z][A-Za-z0-9-]*){0,5})\s+(paper|whitepaper|model|method)\b/,
  );
  if (titledMatch?.[1]) {
    return titledMatch[1].trim();
  }

  const latestUser = turns.toReversed().find((turn) => turn.role === "user")?.text;
  return compactText(latestUser || turns[0]?.text || "Untitled frontier research card", 120);
}

export function inferClaimedContribution(turns: SessionTurn[], hints: ResearchCardHints): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["claimed_contribution", "claimed contribution", "contribution", "贡献", "核心贡献"],
  });
  if (labeled) {
    return compactText(labeled, 220);
  }
  const sentence = findSignalSentence({
    turns,
    keywords: [
      "claim",
      "contribution",
      "improve",
      "outperform",
      "novel",
      "贡献",
      "提升",
      "优于",
      "创新",
    ],
  });
  return compactText(sentence || hints.methodSummary, 220);
}

export function inferDataSetup(turns: SessionTurn[], hints: ResearchCardHints): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["data_setup", "data setup", "dataset", "data", "数据设置", "数据", "样本设置"],
  });
  if (labeled) {
    return compactText(labeled, 220);
  }
  const sentence = findSignalSentence({
    turns,
    keywords: [
      "data",
      "dataset",
      "ohlcv",
      "intraday",
      "cross-sectional",
      "time series",
      "history",
      "regime",
      "benchmark",
      "数据",
      "样本",
      "日频",
      "分钟",
      "时序",
    ],
  });
  return compactText(sentence || hints.dataSetup, 220);
}

export function inferEvaluationProtocol(turns: SessionTurn[], hints: ResearchCardHints): string {
  const labeled = findLabeledValue({
    turns,
    labels: [
      "evaluation_protocol",
      "evaluation protocol",
      "evaluation",
      "评估协议",
      "评估",
      "验证方案",
    ],
  });
  if (labeled) {
    return compactText(labeled, 220);
  }
  const sentence = findSignalSentence({
    turns,
    keywords: [
      "benchmark",
      "ablation",
      "walk-forward",
      "validation",
      "split",
      "backtest",
      "stress test",
      "transaction cost",
      "benchmark",
      "对照",
      "消融",
      "验证",
      "切分",
      "回测",
      "成本",
    ],
  });
  return compactText(sentence || hints.evaluationProtocol, 220);
}

export function inferKeyResults(turns: SessionTurn[], hints: ResearchCardHints): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["key_results", "key results", "results", "结果", "关键结果"],
  });
  if (labeled) {
    return compactText(labeled, 220);
  }
  const sentence = findSignalSentence({
    turns,
    keywords: [
      "result",
      "outperform",
      "improve",
      "gain",
      "best",
      "verdict",
      "结论",
      "结果",
      "提升",
      "优于",
    ],
  });
  return compactText(sentence || hints.keyResults, 220);
}

export function inferMaterialType(
  turns: SessionTurn[],
): "paper" | "whitepaper" | "technical_blog" | "working_notes" {
  const labeled = findLabeledValue({
    turns,
    labels: ["material_type", "material type", "type", "材料类型", "类型"],
  })?.toLowerCase();
  if (labeled?.includes("whitepaper") || labeled?.includes("白皮书")) {
    return "whitepaper";
  }
  if (labeled?.includes("blog")) {
    return "technical_blog";
  }
  if (labeled?.includes("notes") || labeled?.includes("笔记")) {
    return "working_notes";
  }
  if (labeled?.includes("paper") || labeled?.includes("论文")) {
    return "paper";
  }

  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  if (joined.includes("whitepaper") || joined.includes("白皮书")) {
    return "whitepaper";
  }
  if (joined.includes("blog") || joined.includes("technical blog")) {
    return "technical_blog";
  }
  if (joined.includes("notes") || joined.includes("working notes") || joined.includes("笔记")) {
    return "working_notes";
  }
  return "paper";
}

export function inferMethodFamily(turns: SessionTurn[]): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["method_family", "method family", "family", "方法族", "方法类型"],
  });
  if (labeled) {
    return compactText(labeled.toLowerCase(), 80);
  }

  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  if (
    joined.includes("time series") ||
    joined.includes("timeseries") ||
    joined.includes("transformer") ||
    joined.includes("时序")
  ) {
    return "time-series-transformer";
  }
  if (joined.includes("factor") || joined.includes("cross-sectional") || joined.includes("因子")) {
    return "factor-model";
  }
  if (
    joined.includes("reinforcement learning") ||
    joined.includes("policy gradient") ||
    joined.includes("强化学习")
  ) {
    return "reinforcement-learning";
  }
  if (
    joined.includes("multimodal") ||
    joined.includes("text + market") ||
    joined.includes("多模态")
  ) {
    return "multimodal-finance";
  }
  if (joined.includes("llm") || joined.includes("language model") || joined.includes("大模型")) {
    return "llm-finance-method";
  }
  return "frontier-method";
}

export function researchHintsForFamily(methodFamily: string): ResearchCardHints {
  switch (methodFamily) {
    case "time-series-transformer":
      return {
        methodFamily,
        methodSummary:
          "Use sequence modeling over market time series, often with multi-scale or attention-based structure extraction.",
        dataSetup:
          "Needs enough historical market time series to support leakage-safe feature generation and multi-scale preprocessing.",
        evaluationProtocol:
          "Compare against simpler baselines with walk-forward or regime-aware splits and explicit transaction-cost assumptions.",
        keyResults:
          "The transferable part is usually the multi-scale framing plus the evaluation discipline, not the exact model stack.",
        leakageRisk:
          "Temporal windowing, scaling, or decomposition can accidentally leak future information into training features.",
        overfittingRisk:
          "High-capacity sequence models may fit one favorable regime and fail across market shifts.",
        replicationCost: "medium",
        adoptableIdea:
          "Keep the multi-scale denoising idea, but evaluate it under a trading-aligned objective instead of prediction metrics alone.",
        doNotCopyBlindly:
          "Do not treat benchmark wins as production evidence without leakage-safe splits and regime stress tests.",
        relevanceToLobster:
          "Useful as a frontier methods card and as a source of evaluation design rules, not as direct market evidence.",
      };
    case "factor-model":
      return {
        methodFamily,
        methodSummary:
          "Model cross-sectional signals, factor exposures, or ranking behavior across assets and time.",
        dataSetup:
          "Needs a clearly defined universe, rebalance schedule, and cross-sectional feature pipeline over historical market data.",
        evaluationProtocol:
          "Check universe construction, turnover, costs, and out-of-sample decay instead of only in-sample ranking metrics.",
        keyResults:
          "The main value is often in factor construction discipline and timing assumptions rather than raw leaderboard gains.",
        leakageRisk:
          "Feature construction and rebalance timing can hide survivorship, look-ahead, or benchmark contamination.",
        overfittingRisk:
          "Sparse or over-tuned factors can look stable in-sample but decay quickly out of sample.",
        replicationCost: "medium",
        adoptableIdea:
          "Separate factor intuition from implementation details, then test timing and rebalance assumptions explicitly.",
        doNotCopyBlindly:
          "Do not copy reported factors without checking universe definition, costs, and turnover assumptions.",
        relevanceToLobster:
          "Useful for research-card triage and factor-evaluation guardrails across other boards.",
      };
    case "reinforcement-learning":
      return {
        methodFamily,
        methodSummary:
          "Optimize trading or allocation policies with sequential decision-making and reward design.",
        dataSetup:
          "Needs a realistic simulator or environment plus historical data that matches the execution assumptions.",
        evaluationProtocol:
          "Audit reward design, simulator realism, frictions, and policy stability under multiple market regimes.",
        keyResults:
          "Reward and environment design matter more than algorithm novelty when judging whether the method can transfer.",
        leakageRisk:
          "Simulator design and reward shaping can encode future knowledge or unrealizable execution assumptions.",
        overfittingRisk:
          "Policies can overfit to one simulator or one reward proxy and collapse under real frictions.",
        replicationCost: "high",
        adoptableIdea:
          "Focus first on reward design and environment assumptions before caring about algorithm novelty.",
        doNotCopyBlindly:
          "Do not move an RL policy forward without realistic transaction costs, latency, and environment audits.",
        relevanceToLobster:
          "Useful as a methods caution board for objective design, not as direct execution logic.",
      };
    case "multimodal-finance":
      return {
        methodFamily,
        methodSummary:
          "Fuse market, text, or other modalities into one predictive or ranking pipeline.",
        dataSetup:
          "Needs timestamp-aligned text and market data with a clearly defined missing-data and latency policy.",
        evaluationProtocol:
          "Test alignment, ablations, and incremental value of each modality instead of assuming fusion helps automatically.",
        keyResults:
          "The durable value is usually in the alignment and ablation design, not in simply adding more modalities.",
        leakageRisk:
          "Timestamp alignment between text and market data can silently introduce future information.",
        overfittingRisk:
          "Weak modality fusion can add complexity without improving signal stability.",
        replicationCost: "high",
        adoptableIdea:
          "Treat alignment and missing-data policy as first-class research questions, not cleanup details.",
        doNotCopyBlindly:
          "Do not assume more modalities means better alpha without alignment audits and ablations.",
        relevanceToLobster:
          "Useful for method review and evidence-quality checks when combining sources.",
      };
    case "llm-finance-method":
      return {
        methodFamily,
        methodSummary:
          "Use language models for extraction, summarization, reasoning, or signal generation in finance workflows.",
        dataSetup:
          "Needs replay-safe text or filing inputs plus a controlled retrieval policy for any supporting context.",
        evaluationProtocol:
          "Separate extraction quality from market-signal claims and re-run with time-safe prompts and citations.",
        keyResults:
          "The sustainable value is usually workflow structure or extraction quality rather than standalone alpha claims.",
        leakageRisk:
          "Prompt design and retrieved context can leak post-event knowledge into supposedly pre-event tasks.",
        overfittingRisk:
          "Evaluation can overstate gains when label construction or prompting is repeatedly tuned to the same tasks.",
        replicationCost: "medium",
        adoptableIdea:
          "Keep the structured reasoning or extraction pattern, but separate method utility from market-signal claims.",
        doNotCopyBlindly:
          "Do not let LLM outputs enter trading decisions without evidence separation and replay-safe evaluation.",
        relevanceToLobster:
          "Directly useful for research-card generation and workflow design, but not self-validating as market evidence.",
      };
    default:
      return {
        methodFamily,
        methodSummary:
          "Study the method as an experiment design, then separate transferable ideas from paper-specific implementation details.",
        dataSetup:
          "Needs enough information to define the data scope, time window, and evidence assumptions before judging transferability.",
        evaluationProtocol:
          "Name the cheapest leakage-safe benchmark and the minimum evaluation needed before taking the method seriously.",
        keyResults:
          "The main output should be a reusable principle or a concrete reason not to proceed.",
        leakageRisk:
          "Evaluation setup may quietly include information or assumptions that would not be available live.",
        overfittingRisk:
          "Novel architectures can hide fragile gains behind complexity and selective benchmarks.",
        replicationCost: "medium",
        adoptableIdea:
          "Extract one portable evaluation or modeling principle instead of copying the entire stack.",
        doNotCopyBlindly:
          "Do not promote novelty into production before checking leakage, costs, and target alignment.",
        relevanceToLobster:
          "Useful as a frontier methods reference card that other research boards can consult.",
      };
  }
}

export function foundationTemplateForMethodFamily(
  methodFamily: string,
): FrontierFoundationTemplate {
  switch (methodFamily) {
    case "factor-model":
      return "portfolio-sizing-discipline";
    case "time-series-transformer":
    case "multimodal-finance":
      return "risk-transmission";
    case "reinforcement-learning":
    case "llm-finance-method":
      return "outcome-review";
    default:
      return "execution-hygiene";
  }
}

export function inferVerdict(
  turns: SessionTurn[],
): "archive_for_knowledge" | "watch_for_followup" | "worth_reproducing" | "ignore" {
  const labeled = findLabeledValue({
    turns,
    labels: ["verdict", "结论", "判定"],
  })?.toLowerCase();
  if (labeled?.includes("worth_reproducing")) {
    return "worth_reproducing";
  }
  if (labeled?.includes("watch_for_followup")) {
    return "watch_for_followup";
  }
  if (labeled?.includes("archive_for_knowledge")) {
    return "archive_for_knowledge";
  }
  if (labeled?.includes("ignore")) {
    return "ignore";
  }

  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  if (
    joined.includes("worth_reproducing") ||
    joined.includes("reproduce") ||
    joined.includes("replication") ||
    joined.includes("toy reproduction") ||
    joined.includes("复现")
  ) {
    return "worth_reproducing";
  }
  if (joined.includes("watch_for_followup")) {
    return "watch_for_followup";
  }
  if (joined.includes("archive_for_knowledge")) {
    return "archive_for_knowledge";
  }
  if (joined.includes("ignore") || joined.includes("not useful") || joined.includes("无意义")) {
    return "ignore";
  }
  if (joined.includes("archive") || joined.includes("for knowledge") || joined.includes("存档")) {
    return "archive_for_knowledge";
  }
  return "watch_for_followup";
}

export function summarizeFrontierResearchSession(turns: SessionTurn[]): FrontierSessionSummary {
  const materialType = inferMaterialType(turns);
  const hints = researchHintsForFamily(inferMethodFamily(turns));
  return {
    title: inferTitle(turns),
    materialType,
    hints,
    claimedContribution: inferClaimedContribution(turns, hints),
    dataSetup: inferDataSetup(turns, hints),
    evaluationProtocol: inferEvaluationProtocol(turns, hints),
    keyResults: inferKeyResults(turns, hints),
    verdict: inferVerdict(turns),
  };
}

const saveFrontierResearchCard = createSessionArtifactHandler({
  logger: log,
  successMessage: "Frontier research card",
  failureMessage: "Failed to save frontier research card",
  messageCount: 20,
  slugPrefix: "frontier-research",
  shouldPersist: looksLikeFrontierResearchSession,
  fallbackSlug: (turns) => `frontier-research-${inferMethodFamily(turns)}`,
  renderContent: ({ event, sessionId, turns, dateStr, timeStr }) => {
    const summary = summarizeFrontierResearchSession(turns);
    const foundationTemplate = foundationTemplateForMethodFamily(summary.hints.methodFamily);
    const latestTurns = turns.toReversed();
    const latestUser = latestTurns.find((turn) => turn.role === "user")?.text ?? "";
    const latestAssistant = latestTurns.find((turn) => turn.role === "assistant")?.text ?? "";
    return renderFrontierResearchCardArtifact(
      {
        sessionKey: event.sessionKey,
        sessionId: sessionId ?? "unknown",
        title: summary.title,
        materialType: summary.materialType,
        methodFamily: summary.hints.methodFamily,
        problemStatement: compactText(latestUser || turns[0]?.text || "Method-heavy research session"),
        methodSummary: compactText(latestAssistant || summary.hints.methodSummary),
        claimedContribution: summary.claimedContribution,
        dataSetup: summary.dataSetup,
        evaluationProtocol: summary.evaluationProtocol,
        keyResults: summary.keyResults,
        possibleLeakagePoints: summary.hints.leakageRisk,
        overfittingRisks: summary.hints.overfittingRisk,
        replicationCost: summary.hints.replicationCost,
        relevanceToLobster: summary.hints.relevanceToLobster,
        adoptableIdeas: summary.hints.adoptableIdea,
        doNotCopyBlindly: summary.hints.doNotCopyBlindly,
        foundationTemplate,
        verdict: summary.verdict,
        sessionTraceLines: turns.slice(-8).map(
          (turn) => `${turn.role}: ${compactText(turn.text, 160)}`,
        ),
      },
      { dateStr, timeStr },
    );
  },
});

export default saveFrontierResearchCard;
