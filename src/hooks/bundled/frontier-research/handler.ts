import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";

const log = createSubsystemLogger("hooks/frontier-research");

type SessionTurn = { role: "user" | "assistant"; text: string };

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

function looksLikeFrontierResearchSession(turns: SessionTurn[]): boolean {
  const joined = turns
    .map((turn) => turn.text.toLowerCase())
    .join("\n");
  return FRONTIER_KEYWORDS.some((keyword) => joined.includes(keyword));
}

async function getSessionTurns(sessionFilePath: string, messageCount = 20): Promise<SessionTurn[]> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const turns: SessionTurn[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || !entry.message) {
          continue;
        }
        const msg = entry.message;
        const role = msg.role;
        if ((role !== "user" && role !== "assistant") || !msg.content) {
          continue;
        }
        if (role === "user" && hasInterSessionUserProvenance(msg)) {
          continue;
        }
        const text = Array.isArray(msg.content)
          ? // oxlint-disable-next-line typescript/no-explicit-any
            msg.content.find((c: any) => c.type === "text")?.text
          : msg.content;
        if (!text || text.startsWith("/")) {
          continue;
        }
        turns.push({ role, text: String(text).trim() });
      } catch {
        // Ignore bad JSONL rows.
      }
    }

    return turns.slice(-messageCount);
  } catch {
    return [];
  }
}

function compactText(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
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

function inferTitle(turns: SessionTurn[]): string {
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

  const latestUser = [...turns].reverse().find((turn) => turn.role === "user")?.text;
  return compactText(latestUser || turns[0]?.text || "Untitled frontier research card", 120);
}

function inferClaimedContribution(turns: SessionTurn[], hints: ResearchCardHints): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["claimed_contribution", "claimed contribution", "contribution", "贡献", "核心贡献"],
  });
  if (labeled) {
    return compactText(labeled, 220);
  }
  const sentence = findSignalSentence({
    turns,
    keywords: ["claim", "contribution", "improve", "outperform", "novel", "贡献", "提升", "优于", "创新"],
  });
  return compactText(sentence || hints.methodSummary, 220);
}

function inferDataSetup(turns: SessionTurn[], hints: ResearchCardHints): string {
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

function inferEvaluationProtocol(turns: SessionTurn[], hints: ResearchCardHints): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["evaluation_protocol", "evaluation protocol", "evaluation", "评估协议", "评估", "验证方案"],
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

function inferKeyResults(turns: SessionTurn[], hints: ResearchCardHints): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["key_results", "key results", "results", "结果", "关键结果"],
  });
  if (labeled) {
    return compactText(labeled, 220);
  }
  const sentence = findSignalSentence({
    turns,
    keywords: ["result", "outperform", "improve", "gain", "best", "verdict", "结论", "结果", "提升", "优于"],
  });
  return compactText(sentence || hints.keyResults, 220);
}

function inferMaterialType(turns: SessionTurn[]): "paper" | "whitepaper" | "technical_blog" | "working_notes" {
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

  const joined = turns
    .map((turn) => turn.text.toLowerCase())
    .join("\n");
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

function inferMethodFamily(turns: SessionTurn[]): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["method_family", "method family", "family", "方法族", "方法类型"],
  });
  if (labeled) {
    return compactText(labeled.toLowerCase(), 80);
  }

  const joined = turns
    .map((turn) => turn.text.toLowerCase())
    .join("\n");
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
  if (joined.includes("multimodal") || joined.includes("text + market") || joined.includes("多模态")) {
    return "multimodal-finance";
  }
  if (joined.includes("llm") || joined.includes("language model") || joined.includes("大模型")) {
    return "llm-finance-method";
  }
  return "frontier-method";
}

function researchHintsForFamily(methodFamily: string): ResearchCardHints {
  switch (methodFamily) {
    case "time-series-transformer":
      return {
        methodFamily,
        methodSummary: "Use sequence modeling over market time series, often with multi-scale or attention-based structure extraction.",
        dataSetup: "Needs enough historical market time series to support leakage-safe feature generation and multi-scale preprocessing.",
        evaluationProtocol: "Compare against simpler baselines with walk-forward or regime-aware splits and explicit transaction-cost assumptions.",
        keyResults: "The transferable part is usually the multi-scale framing plus the evaluation discipline, not the exact model stack.",
        leakageRisk: "Temporal windowing, scaling, or decomposition can accidentally leak future information into training features.",
        overfittingRisk: "High-capacity sequence models may fit one favorable regime and fail across market shifts.",
        replicationCost: "medium",
        adoptableIdea: "Keep the multi-scale denoising idea, but evaluate it under a trading-aligned objective instead of prediction metrics alone.",
        doNotCopyBlindly: "Do not treat benchmark wins as production evidence without leakage-safe splits and regime stress tests.",
        relevanceToLobster: "Useful as a frontier methods card and as a source of evaluation design rules, not as direct market evidence.",
      };
    case "factor-model":
      return {
        methodFamily,
        methodSummary: "Model cross-sectional signals, factor exposures, or ranking behavior across assets and time.",
        dataSetup: "Needs a clearly defined universe, rebalance schedule, and cross-sectional feature pipeline over historical market data.",
        evaluationProtocol: "Check universe construction, turnover, costs, and out-of-sample decay instead of only in-sample ranking metrics.",
        keyResults: "The main value is often in factor construction discipline and timing assumptions rather than raw leaderboard gains.",
        leakageRisk: "Feature construction and rebalance timing can hide survivorship, look-ahead, or benchmark contamination.",
        overfittingRisk: "Sparse or over-tuned factors can look stable in-sample but decay quickly out of sample.",
        replicationCost: "medium",
        adoptableIdea: "Separate factor intuition from implementation details, then test timing and rebalance assumptions explicitly.",
        doNotCopyBlindly: "Do not copy reported factors without checking universe definition, costs, and turnover assumptions.",
        relevanceToLobster: "Useful for research-card triage and factor-evaluation guardrails across other boards.",
      };
    case "reinforcement-learning":
      return {
        methodFamily,
        methodSummary: "Optimize trading or allocation policies with sequential decision-making and reward design.",
        dataSetup: "Needs a realistic simulator or environment plus historical data that matches the execution assumptions.",
        evaluationProtocol: "Audit reward design, simulator realism, frictions, and policy stability under multiple market regimes.",
        keyResults: "Reward and environment design matter more than algorithm novelty when judging whether the method can transfer.",
        leakageRisk: "Simulator design and reward shaping can encode future knowledge or unrealizable execution assumptions.",
        overfittingRisk: "Policies can overfit to one simulator or one reward proxy and collapse under real frictions.",
        replicationCost: "high",
        adoptableIdea: "Focus first on reward design and environment assumptions before caring about algorithm novelty.",
        doNotCopyBlindly: "Do not move an RL policy forward without realistic transaction costs, latency, and environment audits.",
        relevanceToLobster: "Useful as a methods caution board for objective design, not as direct execution logic.",
      };
    case "multimodal-finance":
      return {
        methodFamily,
        methodSummary: "Fuse market, text, or other modalities into one predictive or ranking pipeline.",
        dataSetup: "Needs timestamp-aligned text and market data with a clearly defined missing-data and latency policy.",
        evaluationProtocol: "Test alignment, ablations, and incremental value of each modality instead of assuming fusion helps automatically.",
        keyResults: "The durable value is usually in the alignment and ablation design, not in simply adding more modalities.",
        leakageRisk: "Timestamp alignment between text and market data can silently introduce future information.",
        overfittingRisk: "Weak modality fusion can add complexity without improving signal stability.",
        replicationCost: "high",
        adoptableIdea: "Treat alignment and missing-data policy as first-class research questions, not cleanup details.",
        doNotCopyBlindly: "Do not assume more modalities means better alpha without alignment audits and ablations.",
        relevanceToLobster: "Useful for method review and evidence-quality checks when combining sources.",
      };
    case "llm-finance-method":
      return {
        methodFamily,
        methodSummary: "Use language models for extraction, summarization, reasoning, or signal generation in finance workflows.",
        dataSetup: "Needs replay-safe text or filing inputs plus a controlled retrieval policy for any supporting context.",
        evaluationProtocol: "Separate extraction quality from market-signal claims and re-run with time-safe prompts and citations.",
        keyResults: "The sustainable value is usually workflow structure or extraction quality rather than standalone alpha claims.",
        leakageRisk: "Prompt design and retrieved context can leak post-event knowledge into supposedly pre-event tasks.",
        overfittingRisk: "Evaluation can overstate gains when label construction or prompting is repeatedly tuned to the same tasks.",
        replicationCost: "medium",
        adoptableIdea: "Keep the structured reasoning or extraction pattern, but separate method utility from market-signal claims.",
        doNotCopyBlindly: "Do not let LLM outputs enter trading decisions without evidence separation and replay-safe evaluation.",
        relevanceToLobster: "Directly useful for research-card generation and workflow design, but not self-validating as market evidence.",
      };
    default:
      return {
        methodFamily,
        methodSummary: "Study the method as an experiment design, then separate transferable ideas from paper-specific implementation details.",
        dataSetup: "Needs enough information to define the data scope, time window, and evidence assumptions before judging transferability.",
        evaluationProtocol: "Name the cheapest leakage-safe benchmark and the minimum evaluation needed before taking the method seriously.",
        keyResults: "The main output should be a reusable principle or a concrete reason not to proceed.",
        leakageRisk: "Evaluation setup may quietly include information or assumptions that would not be available live.",
        overfittingRisk: "Novel architectures can hide fragile gains behind complexity and selective benchmarks.",
        replicationCost: "medium",
        adoptableIdea: "Extract one portable evaluation or modeling principle instead of copying the entire stack.",
        doNotCopyBlindly: "Do not promote novelty into production before checking leakage, costs, and target alignment.",
        relevanceToLobster: "Useful as a frontier methods reference card that other research boards can consult.",
      };
  }
}

function inferVerdict(turns: SessionTurn[]): "archive_for_knowledge" | "watch_for_followup" | "worth_reproducing" | "ignore" {
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

  const joined = turns
    .map((turn) => turn.text.toLowerCase())
    .join("\n");
  if (
    joined.includes("reproduce") ||
    joined.includes("replication") ||
    joined.includes("toy reproduction") ||
    joined.includes("复现")
  ) {
    return "worth_reproducing";
  }
  if (joined.includes("ignore") || joined.includes("not useful") || joined.includes("无意义")) {
    return "ignore";
  }
  if (joined.includes("archive") || joined.includes("for knowledge") || joined.includes("存档")) {
    return "archive_for_knowledge";
  }
  return "watch_for_followup";
}

async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);
    const trimmedSessionId = params.sessionId?.trim();

    if (params.currentSessionFile) {
      const base = path.basename(params.currentSessionFile).split(".reset.")[0];
      if (base && fileSet.has(base)) {
        return path.join(params.sessionsDir, base);
      }
    }

    if (trimmedSessionId) {
      const canonical = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonical)) {
        return path.join(params.sessionsDir, canonical);
      }
      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }
    }
  } catch {
    // Ignore lookup errors.
  }
  return undefined;
}

async function resolveSessionFile(params: {
  workspaceDir: string;
  sessionId?: string;
  sessionFile?: string;
}): Promise<string | undefined> {
  const sessionsDirs = new Set<string>();
  if (params.sessionFile) {
    sessionsDirs.add(path.dirname(params.sessionFile));
  }
  sessionsDirs.add(path.join(params.workspaceDir, "sessions"));

  for (const sessionsDir of sessionsDirs) {
    const recovered = await findPreviousSessionFile({
      sessionsDir,
      currentSessionFile: params.sessionFile,
      sessionId: params.sessionId,
    });
    if (recovered) {
      return recovered;
    }
  }
  return params.sessionFile;
}

async function generateResearchSlug(params: {
  turns: SessionTurn[];
  cfg?: OpenClawConfig;
}): Promise<string> {
  const isTestEnv =
    process.env.OPENCLAW_TEST_FAST === "1" ||
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    process.env.NODE_ENV === "test";

  if (!isTestEnv && params.cfg) {
    const sessionContent = params.turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
    const slug = await generateSlugViaLLM({ sessionContent, cfg: params.cfg });
    if (slug) {
      return `frontier-research-${slug}`;
    }
  }

  return `frontier-research-${inferMethodFamily(params.turns)}`;
}

const saveFrontierResearchCard: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(resolveStateDir(process.env, os.homedir), "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const sessionId = sessionEntry.sessionId as string | undefined;
    const sessionFile = await resolveSessionFile({
      workspaceDir,
      sessionId,
      sessionFile: sessionEntry.sessionFile as string | undefined,
    });
    if (!sessionFile) {
      return;
    }

    const turns = await getSessionTurns(sessionFile);
    if (!looksLikeFrontierResearchSession(turns)) {
      return;
    }

    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toISOString().split("T")[1].split(".")[0];
    const materialType = inferMaterialType(turns);
    const hints = researchHintsForFamily(inferMethodFamily(turns));
    const verdict = inferVerdict(turns);
    const latestUser = [...turns].reverse().find((turn) => turn.role === "user")?.text ?? "";
    const latestAssistant =
      [...turns].reverse().find((turn) => turn.role === "assistant")?.text ?? "";
    const title = inferTitle(turns);
    const slug = await generateResearchSlug({ turns, cfg });
    const filename = `${dateStr}-${slug}.md`;
    const claimedContribution = inferClaimedContribution(turns, hints);
    const dataSetup = inferDataSetup(turns, hints);
    const evaluationProtocol = inferEvaluationProtocol(turns, hints);
    const keyResults = inferKeyResults(turns, hints);

    const entry = [
      `# Frontier Research Card: ${dateStr} ${timeStr} UTC`,
      "",
      `- **Session Key**: ${event.sessionKey}`,
      `- **Session ID**: ${sessionId ?? "unknown"}`,
      "",
      "## Research Card",
      `- title: ${title}`,
      `- material_type: ${materialType}`,
      `- method_family: ${hints.methodFamily}`,
      `- problem_statement: ${compactText(latestUser || turns[0]?.text || "Method-heavy research session")}`,
      `- method_summary: ${compactText(latestAssistant || hints.methodSummary)}`,
      `- claimed_contribution: ${claimedContribution}`,
      `- data_setup: ${dataSetup}`,
      `- evaluation_protocol: ${evaluationProtocol}`,
      `- key_results: ${keyResults}`,
      `- possible_leakage_points: ${hints.leakageRisk}`,
      `- overfitting_risks: ${hints.overfittingRisk}`,
      `- replication_cost: ${hints.replicationCost}`,
      `- relevance_to_lobster: ${hints.relevanceToLobster}`,
      `- adoptable_ideas: ${hints.adoptableIdea}`,
      `- do_not_copy_blindly: ${hints.doNotCopyBlindly}`,
      `- verdict: ${verdict}`,
      "",
      "## Session Trace",
      ...turns.slice(-8).map((turn) => `- ${turn.role}: ${compactText(turn.text, 160)}`),
      "",
    ].join("\n");

    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: filename,
      data: entry,
      encoding: "utf-8",
    });

    log.info(`Frontier research card saved to ${path.join(memoryDir, filename).replace(os.homedir(), "~")}`);
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save frontier research card", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save frontier research card", { error: String(err) });
    }
  }
};

export default saveFrontierResearchCard;
