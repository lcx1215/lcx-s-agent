import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../../src/agents/agent-scope.js";
import { resolveMinimaxDefaultTextModelId } from "../../../src/agents/minimax-model-catalog.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { randomIdempotencyKey, callGateway } from "../../../src/gateway/call.js";
import {
  buildLearningCouncilArtifactJsonRelativePath,
  buildLearningCouncilArtifactMarkdownRelativePath,
  buildLearningCouncilAdoptionLedgerFilename,
  buildLearningCouncilMemoryNoteFilename,
  buildLobsterWorkfaceLearningCarryoverCue,
  extractIsoDateKey,
  renderLearningCouncilAdoptionLedger,
  renderLearningCouncilRuntimeArtifact,
  renderLearningCouncilMemoryNote,
} from "../../../src/hooks/bundled/lobster-brain-registry.js";
import type {
  LearningCouncilAdoptionCueType,
  LearningCouncilAdoptionLedgerArtifact,
  LearningCouncilAdoptionLedgerEntry,
  LearningCouncilRunPacket,
} from "../../../src/hooks/bundled/lobster-brain-registry.js";
import { writeFileWithinRoot } from "../../../src/infra/fs-safe.js";
import { recordOperationalAnomaly } from "../../../src/infra/operational-anomalies.js";

type LearningCouncilRole = "kimi" | "minimax" | "deepseek";
type LearningCouncilCapability = "synthesis" | "challenge" | "extraction";

type LearningCouncilRoleRun = {
  role: LearningCouncilRole;
  capability: LearningCouncilCapability;
  model: string;
  providerFamily: string;
  heading: string;
  success: boolean;
  text: string;
  error?: string;
};

type LearningCouncilArtifact = {
  version: 2;
  generatedAt: string;
  messageId: string;
  userMessage: string;
  status: "full" | "full_with_mutable_fact_warnings" | "degraded";
  mutableFactWarnings: string[];
  roles: LearningCouncilRoleRun[];
  rescues?: LearningCouncilRescueRun[];
  runPacket: LearningCouncilRunPacket;
  finalReply: string;
};

type LearningCouncilAnchorContext = {
  prompt: string;
  presentProtectedAnchors: string[];
  missingProtectedAnchors: string[];
  currentFocus?: string;
  topDecision?: string;
  recallOrder?: string;
  latestCarryoverSource?: string;
  localMemoryCards: Array<{
    subject: string;
    relativePath: string;
    activationRule?: string;
    firstStep?: string;
    stopRule?: string;
  }>;
};

type DistilledOperatingPack = {
  keepers: string[];
  discards: string[];
  lobsterImprovementLines: string[];
  rehearsalTriggers: string[];
  nextEvalCues: string[];
  currentBracketLines: string[];
  ruledOutLines: string[];
  highestInfoNextCheckLines: string[];
};

type LearningCouncilDirectives = {
  kimiHeavy: boolean;
  minimaxHeavy: boolean;
  bilingualComprehension: boolean;
  internalizationFocus: boolean;
  antiShallowSummary: boolean;
  durableLearningDiscipline: boolean;
  broadKnowledgeDistillation: boolean;
};

type LearningCouncilRescueRun = {
  targetRole: LearningCouncilRole;
  helperRole: LearningCouncilRole;
  success: boolean;
  text: string;
  error?: string;
};

type GatewayAgentPayload = {
  text?: string;
};

type GatewayAgentResponse = {
  summary?: string;
  status?: string;
  result?: {
    payloads?: GatewayAgentPayload[];
  };
};

const LEARNING_COUNCIL_HEADINGS: Record<LearningCouncilRole, string> = {
  kimi: "Kimi synthesis",
  minimax: "MiniMax challenge",
  deepseek: "DeepSeek extraction",
};

const LEARNING_COUNCIL_CAPABILITIES: Record<LearningCouncilRole, LearningCouncilCapability> = {
  kimi: "synthesis",
  minimax: "challenge",
  deepseek: "extraction",
};

const MUTABLE_FACT_KEYWORDS =
  /\b(star|stars|fork|forks|watcher|watchers|release|version|commit|activity|price|yield|rate|rates|10y|10-year|treasury|vix|dxy|qqq|spy|tlt|s&p|nasdaq|credit|spread|bps)\b|%/iu;

const MUTABLE_FACT_LABELS =
  /\b(provisional|low-fidelity|prior|stale|approx|approximate|illustrative|unverified|not freshly verified)\b/iu;

const SOURCE_COVERAGE_WEAKNESS_RE =
  /(搜索暂时不可用|网络搜索暂时不可用|web search unavailable|search unavailable|unable to browse|could not browse|network search unavailable|source coverage is narrow|coverage narrow|source coverage weak)/iu;
const LEARNING_COUNCIL_PROTECTED_ANCHORS = [
  "memory/current-research-line.md",
  "memory/unified-risk-view.md",
  "MEMORY.md",
] as const;
const LOBSTER_WORKFACE_FILENAME_RE = /^\d{4}-\d{2}-\d{2}-lobster-workface\.md$/u;

function summarizePromptLine(value: string, maxChars = 260): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 13).trimEnd()} [truncated]`;
}

function findAllowedLearningCouncilModel(
  cfg: ClawdbotConfig,
  candidates: readonly string[],
): string | undefined {
  const allowedModels = cfg.agents?.defaults?.models;
  if (!allowedModels) {
    return undefined;
  }
  return candidates.find((candidate) => Object.hasOwn(allowedModels, candidate));
}

function resolveLearningCouncilModel(role: LearningCouncilRole, cfg: ClawdbotConfig): string {
  const envKey = `OPENCLAW_LEARNING_COUNCIL_${role.toUpperCase()}_MODEL`;
  const override = process.env[envKey]?.trim();
  if (override) {
    return override;
  }
  switch (role) {
    case "kimi":
      return (
        findAllowedLearningCouncilModel(cfg, ["moonshot/kimi-k2.6", "moonshot/kimi-k2.5"]) ??
        "moonshot/kimi-k2.5"
      );
    case "minimax":
      return (
        findAllowedLearningCouncilModel(cfg, [
          `minimax-portal/${resolveMinimaxDefaultTextModelId()}`,
          `minimax/${resolveMinimaxDefaultTextModelId()}`,
        ]) ?? `minimax/${resolveMinimaxDefaultTextModelId()}`
      );
    case "deepseek":
      return (
        // The extraction lane is latency-sensitive inside the Lark reply loop.
        // Prefer Flash for bounded structured extraction; v4-pro remains an explicit override.
        findAllowedLearningCouncilModel(cfg, [
          "custom-api-deepseek-com/deepseek-v4-flash",
          "custom-api-deepseek-com/deepseek-v4-pro",
          "qianfan/deepseek-v3.2",
        ]) ?? "qianfan/deepseek-v3.2"
      );
  }
}

function resolveLearningCouncilProviderFamily(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  const slashIndex = normalized.indexOf("/");
  if (slashIndex > 0) {
    return normalized.slice(0, slashIndex);
  }
  if (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    return "openai";
  }
  if (normalized.includes("claude")) {
    return "anthropic";
  }
  if (normalized.includes("deepseek")) {
    return "deepseek";
  }
  if (normalized.includes("minimax")) {
    return "minimax";
  }
  if (normalized.includes("kimi") || normalized.includes("moonshot")) {
    return "moonshot";
  }
  if (normalized.includes("hermes") || normalized.includes("nous")) {
    return "nousresearch";
  }
  return "unknown";
}

function trimSectionText(text: string, maxChars = 6_000): string {
  const normalized = text.trim().replace(/\n{3,}/g, "\n\n");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

function resolveLearningCouncilDirectives(userMessage: string): LearningCouncilDirectives {
  const broadKnowledgeDistillation =
    /(hermes(?:-agent)?|nous(?:research)?|github cli|gh cli|\bgh\b|memory provider|memory providers|context file|context files|context reference|context references|skills hub|skill installer|skills system|plugin system|plugins|install(?:er|ation|ability)?|setup wizard|setup flow|doctor|migrate|migration|claw migrate|install\.sh|curl -fsSL|AGENTS\.md|CLAUDE\.md|SOUL\.md)/iu.test(
      userMessage,
    );
  const financeMainlineLearningTopic =
    /(金融策略|financial strategy|quant strategy|量化|quant|金融技术|fintech|金融领域|macro|宏观|rates|利率|risk appetite|风险偏好|regime|市场结构|market structure|etf|major asset|资产配置|fundamental|基本面|timing discipline|择时|risk[-\s]?control|风险控制|金融智能体|finance agent|agentic finance|开源策略|开源金融策略|开源金融技术|portfolio decision quality|仓位纪律|ds\b|data science|数据科学|统计学|统计|统计检验|显著性|显著性检验|回归|bootstrap|样本外|out[-\s]?of[-\s]?sample|交叉验证|cross[-\s]?validation|walk[-\s]?forward|稳健性|因子检验|因子测试)/iu.test(
      userMessage,
    );
  const exploratoryLearningTopic =
    broadKnowledgeDistillation ||
    /(llm|large language model|大语言模型|agent platform|agent platforms|智能体平台|agent框架|agent 框架|peer agents|同类agent|同类 agent|repo|github|开源项目|新技术|新的技术|文章|paper|论文|自我提升|启发|内化)/iu.test(
      userMessage,
    );
  const bilingualComprehension =
    /(中文|英文|汉语|英语|中英|双语|bilingual|multilingual|chinese|english|language understanding|language comprehension|术语映射|术语对照|翻译歧义|语义理解|自然语言理解|workflow词|workflow 词|触发词|表达理解)/iu.test(
      userMessage,
    );
  const internalizationFocus =
    /(内化|值得内化|值得你学|值得记住|值得反复记住|值得反复用|对你自我提升|自我提升的启发|哪些真的值得|真的值得学|真正值得学|对你有用的|what changes for lobster|what changes now|值得吸收|值得沉淀)/iu.test(
      userMessage,
    );
  const antiShallowSummary =
    /(别做表面总结|不要表面总结|别做表面综述|不要表面综述|别做泛泛总结|不要泛泛总结|不要泛泛而谈|别泛泛而谈|别做大而全总结|不要做大而全总结|不要只做综述|别只做综述|不要讲大词|别讲大词|只告诉我哪些真的值得|直接告诉我最值得|别做表面 survey)/iu.test(
      userMessage,
    );
  const durableLearningDiscipline =
    financeMainlineLearningTopic ||
    exploratoryLearningTopic ||
    internalizationFocus ||
    antiShallowSummary ||
    /(变聪明|自我提升|以后少犯错|以后会复用|复用规则|长期记忆|内化成|沉淀成|值得记住|值得反复记住|值得反复用|keep|discard|rehearsal|distill|distillation|蒸馏|复盘|复练|反复记住|反复用)/iu.test(
      userMessage,
    );
  return {
    kimiHeavy:
      financeMainlineLearningTopic ||
      bilingualComprehension ||
      /(kimi|让kimi|让 kimi|kimi来|kimi 先|长上下文|长文综合|深挖|多看原文|多综合|先综合|先做综合|重点综合)/iu.test(
        userMessage,
      ),
    minimaxHeavy:
      financeMainlineLearningTopic ||
      bilingualComprehension ||
      /(minimax|让minimax|让 minimax|重审|再审一遍|多审一轮|多挑刺|挑刺|找漏洞|找反例|反驳|唱反调|红队|challenge more|extra challenge|stress test)/iu.test(
        userMessage,
      ),
    bilingualComprehension,
    internalizationFocus,
    antiShallowSummary,
    durableLearningDiscipline,
    broadKnowledgeDistillation,
  };
}

function pickGatewayText(response: GatewayAgentResponse): string {
  const texts =
    response.result?.payloads
      ?.map((payload) => payload.text?.trim())
      .filter((value): value is string => Boolean(value)) ?? [];
  if (texts.length > 0) {
    return texts.join("\n\n").trim();
  }
  return response.summary?.trim() ?? "";
}

function normalizeBulletValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function resolveLearningCouncilWorkspaceDir(params: {
  cfg: ClawdbotConfig;
  workspaceDir?: string;
}): string | undefined {
  const explicit = params.workspaceDir?.trim();
  if (explicit) {
    return explicit;
  }
  const cfg = params.cfg as OpenClawConfig;
  const agentId = resolveDefaultAgentId(cfg);
  return resolveAgentWorkspaceDir(cfg, agentId);
}

function extractCurrentResearchLineField(content: string, key: string): string | undefined {
  return content.match(new RegExp(`^${key}:\\s*([^\\r\\n]+)$`, "mu"))?.[1]?.trim();
}

function extractCurrentResearchLineLessonFitRule(content: string): string | undefined {
  return content.match(/^- lesson_fit_rule:\s*([^\r\n]+)$/mu)?.[1]?.trim();
}

function extractLocalMemoryCardField(content: string, key: string): string | undefined {
  return content.match(new RegExp(`^- ${key}:\\s*([^\\r\\n]+)$`, "mu"))?.[1]?.trim();
}

function normalizeMemorySelectionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'“”‘’()[\]{}:;,.!?/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSelectionTokens(value: string): string[] {
  return normalizeMemorySelectionText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 || /[\u4e00-\u9fff]{2,}/u.test(token));
}

function scoreLocalMemoryCardRelevance(params: {
  userMessage: string;
  currentFocus?: string;
  topDecision?: string;
  recallOrder?: string;
  card: {
    subject: string;
    status: string;
    summary: string;
    activationRule?: string;
    firstStep?: string;
    stopRule?: string;
  };
}): number {
  const queryCorpus = [
    params.userMessage,
    params.currentFocus ?? "",
    params.topDecision ?? "",
    params.recallOrder ?? "",
  ].join(" ");
  const normalizedQuery = normalizeMemorySelectionText(queryCorpus);
  if (!normalizedQuery) {
    return 0;
  }

  let score = 0;
  if (params.card.status === "active") {
    score += 3;
  } else if (params.card.status === "provisional") {
    score += 1;
  } else if (params.card.status === "downranked" || params.card.status === "superseded") {
    score -= 3;
  }

  const cardFields = [
    { text: params.card.subject, exactWeight: 7, tokenWeight: 2 },
    { text: params.card.activationRule ?? "", exactWeight: 8, tokenWeight: 3 },
    { text: params.card.summary, exactWeight: 5, tokenWeight: 2 },
    { text: params.card.firstStep ?? "", exactWeight: 4, tokenWeight: 2 },
    { text: params.card.stopRule ?? "", exactWeight: 3, tokenWeight: 1 },
  ];

  for (const field of cardFields) {
    const normalizedField = normalizeMemorySelectionText(field.text);
    if (!normalizedField) {
      continue;
    }
    if (
      normalizedField.includes("unrelated") ||
      (normalizedQuery.includes("finance") && normalizedField.includes("non finance"))
    ) {
      score -= field.exactWeight + field.tokenWeight;
      continue;
    }
    if (normalizedQuery.includes(normalizedField)) {
      score += field.exactWeight;
    }
    for (const token of extractSelectionTokens(field.text)) {
      if (normalizedQuery.includes(token)) {
        score += field.tokenWeight;
      }
    }
  }

  return score;
}

async function resolveLearningCouncilAnchorContext(params: {
  cfg: ClawdbotConfig;
  workspaceDir?: string;
  userMessage: string;
}): Promise<LearningCouncilAnchorContext> {
  const workspaceDir = resolveLearningCouncilWorkspaceDir(params);
  if (!workspaceDir) {
    return {
      prompt: [
        "## Current Lobster anchor status",
        "- workspace dir unavailable; do not pretend this learning run is already tied to the current Lobster finance line.",
        "",
        "## Latest learning carryover cue",
        "- unavailable because the current workspace could not be resolved.",
      ].join("\n"),
      presentProtectedAnchors: [],
      missingProtectedAnchors: [],
      localMemoryCards: [],
    };
  }

  const presentAnchors: string[] = [];
  const missingAnchors: string[] = [];
  for (const relativePath of LEARNING_COUNCIL_PROTECTED_ANCHORS) {
    try {
      await fs.access(path.join(workspaceDir, relativePath));
      presentAnchors.push(relativePath);
    } catch {
      missingAnchors.push(relativePath);
    }
  }

  let currentFocus: string | undefined;
  let topDecision: string | undefined;
  let recallOrder: string | undefined;
  const localMemoryCards: LearningCouncilAnchorContext["localMemoryCards"] = [];
  let latestCarryoverSource: string | undefined;

  const lines = [
    "## Current Lobster anchor status",
    `- present protected anchors: ${presentAnchors.length > 0 ? presentAnchors.join(", ") : "none"}`,
    `- missing protected anchors: ${missingAnchors.length > 0 ? missingAnchors.join(", ") : "none"}`,
  ];

  if (presentAnchors.includes("memory/current-research-line.md")) {
    try {
      const currentResearchLine = await fs.readFile(
        path.join(workspaceDir, "memory", "current-research-line.md"),
        "utf-8",
      );
      currentFocus =
        extractCurrentResearchLineField(currentResearchLine, "current_focus") ?? undefined;
      topDecision =
        extractCurrentResearchLineField(currentResearchLine, "top_decision") ?? undefined;
      recallOrder =
        extractCurrentResearchLineField(currentResearchLine, "recall_order") ?? undefined;
      lines.push(
        `- current focus: ${summarizePromptLine(currentFocus ?? "unavailable")}`,
        `- top decision: ${summarizePromptLine(topDecision ?? "unavailable")}`,
        `- next step: ${summarizePromptLine(extractCurrentResearchLineField(currentResearchLine, "next_step") ?? "unavailable")}`,
        `- guardrail: ${summarizePromptLine(extractCurrentResearchLineField(currentResearchLine, "guardrail") ?? "unavailable")}`,
      );
      const lessonFitRule = extractCurrentResearchLineLessonFitRule(currentResearchLine);
      if (lessonFitRule) {
        lines.push(`- lesson-fit rule: ${summarizePromptLine(lessonFitRule)}`);
      }
      if (recallOrder) {
        lines.push(`- recall order: ${summarizePromptLine(recallOrder)}`);
      }
    } catch {
      lines.push(
        "- current research line could not be read cleanly; do not pretend this study is already anchored to the latest finance doctrine.",
      );
    }
  } else {
    lines.push(
      "- current research line is missing; keep the study provisional instead of pretending it already matches the current finance doctrine.",
    );
  }

  if (presentAnchors.includes("MEMORY.md")) {
    try {
      const memoryIndex = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      lines.push("", "## Workspace finance brain index");
      for (const bullet of extractMarkdownBulletLines(memoryIndex, "What Lobster Is", 3)) {
        lines.push(`- ${summarizePromptLine(bullet)}`);
      }
      for (const bullet of extractMarkdownBulletLines(memoryIndex, "What Must Be Preserved", 3)) {
        lines.push(`- preserve: ${summarizePromptLine(bullet)}`);
      }
      for (const bullet of extractMarkdownBulletLines(memoryIndex, "Active Workflow Families", 2)) {
        lines.push(`- workflow spine: ${summarizePromptLine(bullet)}`);
      }
      for (const bullet of extractMarkdownBulletLines(
        memoryIndex,
        "Current Upgrade Direction",
        2,
      )) {
        lines.push(`- upgrade direction: ${summarizePromptLine(bullet)}`);
      }
    } catch {
      lines.push(
        "",
        "## Workspace finance brain index",
        "- MEMORY.md could not be read cleanly; do not pretend the full finance mainline has already been loaded into this study run.",
      );
    }
  } else {
    lines.push(
      "",
      "## Workspace finance brain index",
      "- MEMORY.md is missing; do not narrow this run to one partial subdomain and pretend the full finance operating-system mainline is already loaded.",
    );
  }

  lines.push("", "## Local durable memory cards");
  try {
    const localMemoryDir = path.join(workspaceDir, "memory", "local-memory");
    const entries = await fs.readdir(localMemoryDir, { withFileTypes: true });
    const cards = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(localMemoryDir, entry.name), "utf-8");
          const subject = extractLocalMemoryCardField(content, "subject");
          if (!subject) {
            return undefined;
          }
          return {
            subject,
            relativePath: `memory/local-memory/${entry.name}`,
            status: extractLocalMemoryCardField(content, "status") ?? "unknown",
            updatedAt: extractLocalMemoryCardField(content, "updated_at") ?? "",
            summary: normalizeBulletValue(extractSectionBody(content, "Current Summary")),
            activationRule: normalizeBulletValue(extractSectionBody(content, "Use This Card When")),
            firstStep: normalizeBulletValue(extractSectionBody(content, "First Narrowing Step")),
            stopRule: normalizeBulletValue(extractSectionBody(content, "Stop Rule")),
          };
        }),
    );
    const selectedCards = cards
      .flatMap((card) => (card ? [card] : []))
      .map((card) => ({
        ...card,
        relevanceScore: scoreLocalMemoryCardRelevance({
          userMessage: params.userMessage,
          currentFocus,
          topDecision,
          recallOrder,
          card,
        }),
      }))
      .filter((card) => card.relevanceScore > 0)
      .toSorted(
        (a, b) =>
          b.relevanceScore - a.relevanceScore ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.subject.localeCompare(b.subject),
      )
      .slice(0, 2);
    if (selectedCards.length === 0) {
      lines.push(
        "- no active local durable memory card matched the current objective strongly enough.",
      );
    } else {
      for (const card of selectedCards) {
        localMemoryCards.push({
          subject: card.subject,
          relativePath: card.relativePath,
          activationRule: card.activationRule || undefined,
          firstStep: card.firstStep || undefined,
          stopRule: card.stopRule || undefined,
        });
        lines.push(
          `- ${summarizePromptLine(card.subject)} [${card.status}]: ${summarizePromptLine(card.summary || "summary unavailable")}`,
          ...(card.activationRule ? [`  when: ${summarizePromptLine(card.activationRule)}`] : []),
          ...(card.firstStep ? [`  first step: ${summarizePromptLine(card.firstStep)}`] : []),
          ...(card.stopRule ? [`  stop rule: ${summarizePromptLine(card.stopRule)}`] : []),
        );
      }
    }
  } catch {
    lines.push(
      "- local durable memory cards unavailable in the current workspace; do not pretend reusable medium-term memory was loaded.",
    );
  }

  lines.push("", "## Latest learning carryover cue");
  try {
    const memoryDir = path.join(workspaceDir, "memory");
    const latestWorkface = (await fs.readdir(memoryDir))
      .filter((name) => LOBSTER_WORKFACE_FILENAME_RE.test(name))
      .sort((left, right) => right.localeCompare(left))[0];
    if (!latestWorkface) {
      lines.push(
        "- no latest lobster-workface cue was found in this workspace; do not claim prior learning already changed reusable behavior.",
      );
      return {
        prompt: lines.join("\n"),
        presentProtectedAnchors: presentAnchors,
        missingProtectedAnchors: missingAnchors,
        currentFocus,
        topDecision,
        recallOrder,
        localMemoryCards,
      };
    }
    latestCarryoverSource = `memory/${latestWorkface}`;
    const workfaceContent = await fs.readFile(path.join(memoryDir, latestWorkface), "utf-8");
    const carryoverCue = buildLobsterWorkfaceLearningCarryoverCue(workfaceContent);
    if (!carryoverCue) {
      lines.push(
        `- source: ${latestCarryoverSource}`,
        "- the latest workface exists, but no retain / discard / replay / next eval cue was extracted yet; keep new learning provisional.",
      );
      return {
        prompt: lines.join("\n"),
        presentProtectedAnchors: presentAnchors,
        missingProtectedAnchors: missingAnchors,
        currentFocus,
        topDecision,
        recallOrder,
        latestCarryoverSource,
        localMemoryCards,
      };
    }
    lines.push(`- source: ${latestCarryoverSource}`, ...carryoverCue.split("\n"));
  } catch {
    lines.push(
      "- latest carryover cue unavailable in the current workspace; do not pretend prior learning already survived into reusable rules.",
    );
  }

  return {
    prompt: lines.join("\n"),
    presentProtectedAnchors: presentAnchors,
    missingProtectedAnchors: missingAnchors,
    currentFocus,
    topDecision,
    recallOrder,
    latestCarryoverSource,
    localMemoryCards,
  };
}

function extractSectionBody(text: string, heading: string): string {
  const lines = text.split("\n");
  const normalizedHeading = heading.trim().toLowerCase();
  const startIndex = lines.findIndex(
    (line) =>
      line
        .replace(/^#+\s*/, "")
        .trim()
        .toLowerCase() === normalizedHeading,
  );
  if (startIndex === -1) {
    return "";
  }

  const body: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s+/.test(line)) {
      break;
    }
    body.push(line);
  }
  return body.join("\n").trim();
}

function extractMarkdownBulletLines(text: string, heading: string, maxItems = 3): string[] {
  return extractSectionBody(text, heading)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => normalizeBulletValue(line.replace(/^[-*]\s+/, "")))
    .filter(Boolean)
    .slice(0, maxItems);
}

function extractBullets(
  text: string,
  heading: string,
  fallbackMax = 3,
  options?: { fallbackToWholeText?: boolean },
): string[] {
  const body = extractSectionBody(text, heading);
  const source = body || (options?.fallbackToWholeText === false ? "" : text);
  const bullets = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => normalizeBulletValue(line.replace(/^[-*]\s+/, "")));
  if (bullets.length > 0) {
    return bullets.slice(0, fallbackMax);
  }

  return source
    .split(/\n{2,}|(?<=[.!?。！？])\s+/)
    .map((line) => normalizeBulletValue(line))
    .filter(Boolean)
    .slice(0, fallbackMax);
}

function detectMutableFactWarnings(params: { role: LearningCouncilRole; text: string }): string[] {
  return params.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => MUTABLE_FACT_KEYWORDS.test(line))
    .filter((line) => /\d/.test(line))
    .filter((line) => !MUTABLE_FACT_LABELS.test(line))
    .slice(0, 4)
    .map((line) => `${params.role}: ${normalizeBulletValue(line)}`);
}

function buildKimiSystemPrompt(params?: {
  kimiHeavy?: boolean;
  internalizationFocus?: boolean;
  antiShallowSummary?: boolean;
  durableLearningDiscipline?: boolean;
  broadKnowledgeDistillation?: boolean;
}): string {
  return [
    "You are assigned to the Kimi-labeled synthesis lane in a learning council.",
    "Treat Kimi as a stable lane label, not as proof of the runtime provider identity.",
    "Your job is long-context synthesis, not trading advice.",
    "Study the user topic and return exactly these sections:",
    "## Synthesis",
    params?.kimiHeavy
      ? "- 5 to 7 concise bullets with the strongest working narrative, mechanism chain, and reusable frame."
      : "- 3 to 5 concise bullets with the strongest working narrative or framework.",
    "## Freshness and caveats",
    "- note any mutable facts, missing anchors, or low-fidelity limits.",
    "## Provisional anchors",
    "- only list facts or references you are actually confident belong in the working set for this turn.",
    ...(params?.durableLearningDiscipline
      ? [
          "## Distilled keepers",
          "- 2 to 4 concise rules, heuristics, or operating checks worth keeping after this run.",
          "## Current bracket",
          "- 2 to 4 plausible framings, answer-shapes, or hypothesis brackets that should remain alive after this pass. Do not collapse to one fake-precise answer too early.",
          "## Lobster improvement",
          "- 1 to 3 concrete prompt, memory, routing, workflow, or artifact moves that would make Lobster itself more useful after this run.",
          "## Replay triggers",
          "- 2 to 4 concrete contexts, mistakes, or cues that should cause Lobster to recall these keepers later.",
        ]
      : []),
    ...(params?.kimiHeavy
      ? [
          "When the user explicitly asks for Kimi emphasis, spend extra effort on mechanism clarity, source-grounded framing, and long-context synthesis quality.",
        ]
      : []),
    ...(params?.internalizationFocus
      ? [
          "Prioritize only what Lobster should internalize into reusable operating rules, research heuristics, or correction discipline right now.",
          "State what changes for Lobster now; skip broad ecosystem survey material that does not improve future judgment.",
          "Explicitly discard hype, surface novelty, or generic best-practice fluff that is not worth durable internalization.",
        ]
      : []),
    ...(params?.antiShallowSummary
      ? [
          "Do not give a broad survey-style summary. Compress toward the few rules, checks, or design moves that actually deserve durable memory.",
        ]
      : []),
    ...(params?.broadKnowledgeDistillation
      ? [
          "Broad knowledge distillation mode is active. If the topic is another agent, GitHub CLI, install/setup flow, context files, skills/plugins, or memory providers, compress toward four adoption questions: what Lobster should adopt now, what to skip, what compatibility risk to watch, and one next patch or install step it can verify locally.",
          "Prefer installability, local-memory, context-loading, workflow-reliability, repairability, or migration-seam improvements over broad ecosystem recap.",
        ]
      : []),
    "Finance mainline comes first. If the topic touches tools, agent patterns, or platform design, keep only what directly improves Lobster's low-frequency finance research, filtering, timing discipline, or risk control.",
    "Do not write model-one/model-two language.",
    "Do not give point targets or execution instructions.",
    "If mutable web facts such as GitHub stars, release versions, prices, or yields are not freshly verified in this run, omit the number or label it prior / provisional / low-fidelity.",
  ].join("\n");
}

function buildLanguageCoverageNote(): string[] {
  return [
    "This topic is about bilingual language understanding and workflow comprehension.",
    "Prioritize Chinese/English meaning preservation, finance and system terminology mapping, ambiguity classes, and natural-language trigger understanding over generic language-study fluff.",
    "Do not claim mastery of all Chinese or English. The job is to reduce misunderstanding on high-value Lobster usage now.",
  ];
}

function buildDeepSeekSystemPrompt(params?: {
  internalizationFocus?: boolean;
  antiShallowSummary?: boolean;
  durableLearningDiscipline?: boolean;
  broadKnowledgeDistillation?: boolean;
}): string {
  return [
    "You are assigned to the DeepSeek-labeled extraction lane in a learning council.",
    "Treat DeepSeek as a stable lane label, not as proof of the runtime provider identity.",
    "Your job is extraction and structured learning transfer, not final verdict theater.",
    "Return exactly these sections:",
    "## Candidate lessons",
    "- 3 to 5 compact lessons worth reusing.",
    "## Candidate follow-ups",
    "- 3 to 5 checks, sources, or next questions.",
    "## Weak evidence",
    "- list what still lacks verification or could be wrong.",
    ...(params?.durableLearningDiscipline
      ? [
          "## Distillation-ready rules",
          "- 2 to 4 short if-then rules, filters, or failure guards that could survive into future runs.",
          "## Lobster improvement",
          "- 1 to 3 bounded Lobster prompt, memory, routing, or workflow improvements suggested by this run.",
          "## Replay triggers",
          "- 2 to 4 situations, cues, or recurring mistakes that should trigger those rules later.",
        ]
      : []),
    "Prefer checklists and reusable rules over prose.",
    ...(params?.internalizationFocus
      ? [
          "Only promote lessons that are worth durable internalization into Lobster's future judgment, workflow, or correction logic.",
          "Discard items that are merely interesting, trendy, or broad summaries without operational consequence.",
        ]
      : []),
    ...(params?.antiShallowSummary
      ? [
          "Do not produce a broad ecosystem recap. Extract only the few rules, filters, or follow-ups that genuinely change future behavior.",
        ]
      : []),
    ...(params?.broadKnowledgeDistillation
      ? [
          "When the topic is tooling adoption, output concrete adopt/skip checks, install or migration follow-ups, and compatibility notes that Lobster can verify with its existing CLI, built-in tools, or bounded local patch surface.",
        ]
      : []),
    "Finance mainline comes first. If the material is about tools, agent patterns, or platform architecture, only keep lessons that concretely improve Lobster's finance research workflow, filtering, timing, or risk-control quality.",
    "Do not invent fresh numbers when mutable facts were not verified in this run.",
  ].join("\n");
}

function buildRescuePrompt(params: {
  failedRole: LearningCouncilRole;
  userMessage: string;
  helperRole: LearningCouncilRole;
  kimiText: string;
  minimaxText: string;
  deepseekText: string;
}): string {
  const sharedPreamble = [
    `The primary ${params.failedRole}-labeled lane failed in this learning-council run.`,
    `You are covering the ${params.helperRole}-labeled lane and must provide a compact rescue contribution so the council does not lose the whole thread.`,
    "Treat these lane labels as stable council structure, not as proof of the runtime provider identity.",
    "Use surviving evidence only. Do not invent fresh facts or trading instructions.",
    "",
    "## Original user request",
    params.userMessage.trim(),
    "",
    "## Surviving Kimi material",
    trimSectionText(params.kimiText || "unavailable", 2_500),
    "",
    "## Surviving MiniMax material",
    trimSectionText(params.minimaxText || "unavailable", 2_500),
    "",
    "## Surviving DeepSeek material",
    trimSectionText(params.deepseekText || "unavailable", 2_500),
    "",
  ];

  if (params.failedRole === "kimi") {
    return [
      ...sharedPreamble,
      "Return exactly these sections:",
      "## Synthesis",
      "- 2 to 4 compact bullets with the best surviving framework.",
      "## Freshness and caveats",
      "- note what is still low-fidelity or missing.",
      "## Provisional anchors",
      "- only list anchors that survived the remaining council evidence.",
    ].join("\n");
  }

  if (params.failedRole === "deepseek") {
    return [
      ...sharedPreamble,
      "Return exactly these sections:",
      "## Candidate lessons",
      "- 2 to 4 reusable lessons distilled from surviving evidence.",
      "## Candidate follow-ups",
      "- 2 to 4 concrete checks or next reads.",
      "## Weak evidence",
      "- what still should remain provisional.",
    ].join("\n");
  }

  return [
    ...sharedPreamble,
    "Return exactly these sections:",
    "## What holds up",
    "- strongest points that survive scrutiny.",
    "## Challenges",
    "- what still looks weak, overstated, or regime-dependent.",
    "## Evidence gaps",
    "- what blocks promotion into durable learning.",
  ].join("\n");
}

function buildMiniMaxSystemPrompt(params: {
  userMessage: string;
  kimiText: string;
  kimiModel: string;
  deepseekText: string;
  deepseekModel: string;
  minimaxHeavy?: boolean;
  priorAuditText?: string;
  bilingualComprehension?: boolean;
  internalizationFocus?: boolean;
  antiShallowSummary?: boolean;
  durableLearningDiscipline?: boolean;
  broadKnowledgeDistillation?: boolean;
}): string {
  return [
    "You are assigned to the MiniMax-labeled challenge lane in a learning council.",
    "Treat MiniMax as a stable lane label, not as proof of the runtime provider identity.",
    "Your job is challenge, contradiction search, and weakness detection.",
    "Audit the prior Kimi and DeepSeek outputs below against the original user request.",
    "",
    "## Original user request",
    params.userMessage.trim(),
    "",
    "## Synthesis lane to audit",
    `- configured role: kimi`,
    `- runtime provider: ${resolveLearningCouncilProviderFamily(params.kimiModel)}`,
    `- runtime model: ${params.kimiModel}`,
    trimSectionText(params.kimiText, 4_000),
    "",
    "## Extraction lane to audit",
    `- configured role: deepseek`,
    `- runtime provider: ${resolveLearningCouncilProviderFamily(params.deepseekModel)}`,
    `- runtime model: ${params.deepseekModel}`,
    trimSectionText(params.deepseekText, 4_000),
    "",
    ...(params.priorAuditText
      ? ["## Prior MiniMax audit", trimSectionText(params.priorAuditText, 3_000), ""]
      : []),
    "Return exactly these sections:",
    "## What holds up",
    "- which points appear strongest after challenge",
    "## Challenges",
    "- what is overstated, weak, conflicting, or too confident",
    "## Evidence gaps",
    "- what still needs verification before promotion into durable learning",
    ...(params.durableLearningDiscipline
      ? [
          "## What to discard",
          "- which candidate lessons should be downranked, discarded, or explicitly kept provisional",
          "## Lobster improvement",
          "- 1 to 3 concrete Lobster-level prompt, memory, routing, or workflow fixes that would prevent the same mistake or drift next time",
          "## Ruled out",
          "- which interpretations, answer-shapes, or moves should now be considered bad fits for this request",
          "## Highest-information next checks",
          "- one to three next checks that would shrink the uncertainty range fastest before over-precise claims",
          "## Replay failure checks",
          "- which future signals or mistakes should force Lobster to revisit or falsify the surviving rules",
        ]
      : []),
    ...(params.bilingualComprehension
      ? [
          "For bilingual comprehension topics, attack false equivalence, literal translation traps, finance-term mistranslation, and workflow-trigger ambiguity between Chinese and English.",
        ]
      : []),
    ...(params.internalizationFocus
      ? [
          "Attack anything that sounds interesting but is not actually worth durable internalization into Lobster's operating rules, research discipline, or failure corrections.",
          "Force the audit to ask: what should Lobster really keep, what should it explicitly discard, and what changes now if this learning is absorbed.",
        ]
      : []),
    ...(params.antiShallowSummary
      ? [
          "Penalize broad survey language, vague ecosystem recap, and generic inspirational summaries that do not survive into concrete reusable rules.",
        ]
      : []),
    ...(params.broadKnowledgeDistillation
      ? [
          "Attack recommendations that require wholesale migration, vendor lock-in, or broad architecture replacement when a bounded adoption seam, local install flow, or compatibility-preserving patch would do.",
          "Rule out ecosystem tourism: if a Hermes/GitHub/install idea does not clearly improve Lobster's installability, local memory, context loading, workflow reliability, self-repair, or finance throughput, it should not survive as a keeper.",
        ]
      : []),
    "Finance mainline comes first. If the studied material is mostly about tooling, agents, or platform design, challenge whether it really improves low-frequency finance research quality before letting it survive as a keeper.",
    ...(params.minimaxHeavy
      ? [
          "When the user explicitly asks for MiniMax emphasis, increase red-team pressure: surface more counter-cases, unstated assumptions, and regime-failure paths.",
        ]
      : []),
    "Do not rewrite into trading instructions.",
    "Do not accept mutable numeric claims without freshness and source discipline.",
  ].join("\n");
}

function resolveDistilledOperatingPack(params: {
  kimi: LearningCouncilRoleRun;
  minimax: LearningCouncilRoleRun;
  deepseek: LearningCouncilRoleRun;
  rescues: LearningCouncilRescueRun[];
  durableLearningDiscipline: boolean;
}): DistilledOperatingPack {
  if (!params.durableLearningDiscipline) {
    return {
      keepers: [],
      discards: [],
      lobsterImprovementLines: [],
      rehearsalTriggers: [],
      nextEvalCues: [],
      currentBracketLines: [],
      ruledOutLines: [],
      highestInfoNextCheckLines: [],
    };
  }

  const rescueFor = (role: LearningCouncilRole) =>
    params.rescues.find((rescue) => rescue.targetRole === role && rescue.success)?.text ?? "";
  const kimiSource = params.kimi.success ? params.kimi.text : rescueFor("kimi");
  const minimaxSource = params.minimax.success ? params.minimax.text : rescueFor("minimax");
  const deepseekSource = params.deepseek.success ? params.deepseek.text : rescueFor("deepseek");

  const keepers = dedupeBullets(
    [
      ...extractBullets(kimiSource, "Distilled keepers", 4),
      ...extractBullets(deepseekSource, "Distillation-ready rules", 4),
      ...extractBullets(deepseekSource, "Candidate lessons", 4),
      ...extractBullets(minimaxSource, "What holds up", 4),
    ],
    6,
  );
  const discards = dedupeBullets(
    [
      ...extractBullets(minimaxSource, "What to discard", 4),
      ...extractBullets(minimaxSource, "Challenges", 4),
      ...extractBullets(deepseekSource, "Weak evidence", 3),
    ],
    6,
  );
  const lobsterImprovementLines = dedupeBullets(
    [
      ...extractBullets(kimiSource, "Lobster improvement", 4, { fallbackToWholeText: false }),
      ...extractBullets(deepseekSource, "Lobster improvement", 4, {
        fallbackToWholeText: false,
      }),
      ...extractBullets(minimaxSource, "Lobster improvement", 4, {
        fallbackToWholeText: false,
      }),
    ],
    4,
  );
  const rehearsalTriggers = dedupeBullets(
    [
      ...extractBullets(kimiSource, "Replay triggers", 4),
      ...extractBullets(deepseekSource, "Replay triggers", 4),
    ],
    5,
  );
  const nextEvalCues = dedupeBullets(
    [
      ...extractBullets(minimaxSource, "Replay failure checks", 4),
      ...extractBullets(minimaxSource, "Evidence gaps", 4),
      ...extractBullets(deepseekSource, "Candidate follow-ups", 4),
    ],
    6,
  );
  const currentBracketLines = dedupeBullets(
    [
      ...extractBullets(kimiSource, "Current bracket", 4, { fallbackToWholeText: false }),
      ...extractBullets(kimiSource, "Synthesis", 4, { fallbackToWholeText: false }),
    ],
    4,
  );
  const ruledOutLines = dedupeBullets(
    [
      ...extractBullets(minimaxSource, "Ruled out", 4, { fallbackToWholeText: false }),
      ...extractBullets(minimaxSource, "Challenges", 4, { fallbackToWholeText: false }),
    ],
    4,
  );
  const highestInfoNextCheckLines = dedupeBullets(
    [
      ...extractBullets(minimaxSource, "Highest-information next checks", 4, {
        fallbackToWholeText: false,
      }),
      ...extractBullets(deepseekSource, "Candidate follow-ups", 4, {
        fallbackToWholeText: false,
      }),
    ],
    4,
  );

  return {
    keepers,
    discards,
    lobsterImprovementLines,
    rehearsalTriggers,
    nextEvalCues,
    currentBracketLines,
    ruledOutLines,
    highestInfoNextCheckLines,
  };
}

function renderDistilledOperatingPack(pack: DistilledOperatingPack): string {
  return [
    "## Distilled operating pack",
    "",
    "### Keep",
    ...(pack.keepers.length > 0
      ? pack.keepers.map((item) => `- ${item}`)
      : ["- no rule survived distillation strongly enough yet; keep this run provisional."]),
    "",
    "### Discard or downrank",
    ...(pack.discards.length > 0
      ? pack.discards.map((item) => `- ${item}`)
      : [
          "- no explicit discard list extracted; keep borderline lessons provisional until challenged again.",
        ]),
    "",
    "### Lobster improvement feedback",
    ...(pack.lobsterImprovementLines.length > 0
      ? pack.lobsterImprovementLines.map((item) => `- ${item}`)
      : [
          "- no bounded Lobster-level improvement survived this run strongly enough yet; keep system changes provisional.",
        ]),
    "",
    "### Current bracket",
    ...(pack.currentBracketLines.length > 0
      ? pack.currentBracketLines.map((item) => `- ${item}`)
      : [
          "- current bracket still broad; do not overstate precision until one tighter narrowing pass succeeds.",
        ]),
    "",
    "### Ruled out",
    ...(pack.ruledOutLines.length > 0
      ? pack.ruledOutLines.map((item) => `- ${item}`)
      : ["- no explicit bad-fit interpretation ruled out yet beyond normal uncertainty."]),
    "",
    "### Highest-information next checks",
    ...(pack.highestInfoNextCheckLines.length > 0
      ? pack.highestInfoNextCheckLines.map((item) => `- ${item}`)
      : [
          "- run one tighter, highest-information verification pass before pretending the answer is precise.",
        ]),
    "",
    "### Rehearsal triggers",
    ...(pack.rehearsalTriggers.length > 0
      ? pack.rehearsalTriggers.map((item) => `- ${item}`)
      : [
          "- if a similar failure mode, regime shift, or repeated operator complaint reappears, reopen this lesson before trusting it.",
        ]),
    "",
    "### Next eval cue",
    ...(pack.nextEvalCues.length > 0
      ? pack.nextEvalCues.map((item) => `- ${item}`)
      : [
          "- run one tighter verification pass before promoting this learning into durable doctrine.",
        ]),
  ].join("\n");
}

function buildLearningCouncilRunPacket(params: {
  userMessage: string;
  anchorContext: LearningCouncilAnchorContext;
  distilledPack: DistilledOperatingPack;
  artifactJsonPath: string;
  memoryNotePath: string;
  adoptionLedgerPath: string;
}): LearningCouncilRunPacket {
  const recoveryReadOrder = dedupeBullets(
    [
      ...params.anchorContext.presentProtectedAnchors,
      ...(params.anchorContext.latestCarryoverSource
        ? [params.anchorContext.latestCarryoverSource]
        : []),
      ...params.anchorContext.localMemoryCards.map((card) => card.relativePath),
      params.artifactJsonPath,
      params.memoryNotePath,
      params.adoptionLedgerPath,
    ],
    16,
  );
  return {
    objective: params.userMessage.trim(),
    protectedAnchorsPresent: params.anchorContext.presentProtectedAnchors,
    protectedAnchorsMissing: params.anchorContext.missingProtectedAnchors,
    currentFocus: params.anchorContext.currentFocus,
    topDecision: params.anchorContext.topDecision,
    recallOrder: params.anchorContext.recallOrder,
    latestCarryoverSource: params.anchorContext.latestCarryoverSource,
    localMemoryCardPaths: params.anchorContext.localMemoryCards.map((card) => card.relativePath),
    keepLines: params.distilledPack.keepers,
    discardLines: params.distilledPack.discards,
    lobsterImprovementLines: params.distilledPack.lobsterImprovementLines,
    currentBracketLines: params.distilledPack.currentBracketLines,
    ruledOutLines: params.distilledPack.ruledOutLines,
    highestInfoNextCheckLines: params.distilledPack.highestInfoNextCheckLines,
    replayTriggerLines: params.distilledPack.rehearsalTriggers,
    nextEvalCueLines: params.distilledPack.nextEvalCues,
    recoveryReadOrder,
  };
}

function buildAdoptionLedgerEntries(params: {
  messageId: string;
  artifactJsonPath: string;
  runPacket: LearningCouncilRunPacket;
}): LearningCouncilAdoptionLedgerEntry[] {
  const source = `learning-council:${params.messageId}`;
  const link = params.artifactJsonPath;
  const entries: LearningCouncilAdoptionLedgerEntry[] = [];
  const pushLines = (
    cueType: LearningCouncilAdoptionCueType,
    lines: string[],
    adoptedState: LearningCouncilAdoptionLedgerEntry["adoptedState"],
    notes: string,
  ) => {
    for (const line of lines) {
      entries.push({
        source,
        cueType,
        text: line,
        adoptedState,
        reusedLater: false,
        downrankedOrFailed: false,
        linkedArtifactOrReceipt: link,
        notes,
      });
    }
  };
  pushLines("keep", params.runPacket.keepLines, "adopted_now", "seeded from runPacket.keepLines");
  pushLines(
    "discard",
    params.runPacket.discardLines,
    "adopted_now",
    "seeded from runPacket.discardLines",
  );
  pushLines(
    "lobster_improvement",
    params.runPacket.lobsterImprovementLines,
    "candidate_for_reuse",
    "bounded self-improvement candidate from distilled council feedback",
  );
  pushLines(
    "replay_trigger",
    params.runPacket.replayTriggerLines,
    "candidate_for_reuse",
    "candidate replay trigger from distilled council feedback",
  );
  pushLines(
    "next_eval",
    params.runPacket.nextEvalCueLines,
    "candidate_for_reuse",
    "candidate next-eval cue from distilled council feedback",
  );
  pushLines(
    "current_bracket",
    params.runPacket.currentBracketLines,
    "candidate_for_reuse",
    "candidate decision bracket from distilled council feedback",
  );
  pushLines(
    "ruled_out",
    params.runPacket.ruledOutLines,
    "candidate_for_reuse",
    "candidate ruled-out guard from distilled council feedback",
  );
  pushLines(
    "highest_info_next_check",
    params.runPacket.highestInfoNextCheckLines,
    "candidate_for_reuse",
    "candidate highest-information next check from distilled council feedback",
  );
  return entries;
}

function buildLearningCouncilAdoptionLedgerArtifact(params: {
  messageId: string;
  generatedAt: string;
  userMessage: string;
  status: LearningCouncilArtifact["status"];
  artifactJsonPath: string;
  runPacket: LearningCouncilRunPacket;
}): LearningCouncilAdoptionLedgerArtifact {
  return {
    stem: sanitizePathSegment(params.messageId) || "learning-council",
    generatedAt: params.generatedAt,
    status: params.status,
    userMessage: params.userMessage,
    sourceArtifact: params.artifactJsonPath,
    entries: buildAdoptionLedgerEntries({
      messageId: params.messageId,
      artifactJsonPath: params.artifactJsonPath,
      runPacket: params.runPacket,
    }),
  };
}

async function runLearningCouncilRole(params: {
  cfg: ClawdbotConfig;
  role: LearningCouncilRole;
  userMessage: string;
  routeAgentId: string;
  baseSessionKey: string;
  timeoutSeconds: number;
  thinking: "off" | "medium" | "high";
  extraSystemPrompt: string;
}): Promise<LearningCouncilRoleRun> {
  const model = resolveLearningCouncilModel(params.role, params.cfg);
  const capability = LEARNING_COUNCIL_CAPABILITIES[params.role];
  const providerFamily = resolveLearningCouncilProviderFamily(model);
  const heading = LEARNING_COUNCIL_HEADINGS[params.role];
  try {
    const response = await callGateway<GatewayAgentResponse>({
      method: "agent",
      params: {
        message: params.userMessage,
        agentId: params.routeAgentId,
        sessionKey: `${params.baseSessionKey}:${params.role}`,
        model,
        thinking: params.thinking,
        timeout: params.timeoutSeconds,
        lane: "learning-council",
        extraSystemPrompt: params.extraSystemPrompt,
        idempotencyKey: randomIdempotencyKey(),
        label: `Learning Council: ${params.role}`,
      },
      expectFinal: true,
      timeoutMs: (params.timeoutSeconds + 45) * 1000,
    });
    const text = pickGatewayText(response);
    if (!text) {
      return {
        role: params.role,
        capability,
        model,
        providerFamily,
        heading,
        success: false,
        text: "",
        error: "empty response",
      };
    }
    return {
      role: params.role,
      capability,
      model,
      providerFamily,
      heading,
      success: true,
      text: trimSectionText(text),
    };
  } catch (error) {
    return {
      role: params.role,
      capability,
      model,
      providerFamily,
      heading,
      success: false,
      text: "",
      error: String(error),
    };
  }
}

function detectSourceCoverageWeakness(params: {
  role: LearningCouncilRole;
  text: string;
  error?: string;
}): string[] {
  const joined = [params.text, params.error].filter(Boolean).join("\n");
  if (!SOURCE_COVERAGE_WEAKNESS_RE.test(joined)) {
    return [];
  }
  return [`${params.role}: source coverage looked weak or search-limited in this turn`];
}

async function runLearningCouncilRescue(params: {
  cfg: ClawdbotConfig;
  failedRole: LearningCouncilRole;
  helperRole: LearningCouncilRole;
  userMessage: string;
  routeAgentId: string;
  baseSessionKey: string;
  kimiText: string;
  minimaxText: string;
  deepseekText: string;
}): Promise<LearningCouncilRescueRun> {
  const rescue = await runLearningCouncilRole({
    cfg: params.cfg,
    role: params.helperRole,
    userMessage: params.userMessage,
    routeAgentId: params.routeAgentId,
    baseSessionKey: `${params.baseSessionKey}:rescue:${params.failedRole}`,
    timeoutSeconds: params.helperRole === "deepseek" ? 240 : 300,
    thinking: params.helperRole === "kimi" ? "off" : "medium",
    extraSystemPrompt: buildRescuePrompt({
      failedRole: params.failedRole,
      userMessage: params.userMessage,
      helperRole: params.helperRole,
      kimiText: params.kimiText,
      minimaxText: params.minimaxText,
      deepseekText: params.deepseekText,
    }),
  });

  return {
    targetRole: params.failedRole,
    helperRole: params.helperRole,
    success: rescue.success,
    text: rescue.text,
    error: rescue.error,
  };
}

function renderRoleSection(
  result: LearningCouncilRoleRun,
  rescue?: LearningCouncilRescueRun,
): string {
  const laneReceipt = `Lane receipt: contract=${result.capability} (configured role: ${result.role}); runtime provider=${result.providerFamily}; runtime model=${result.model}`;
  if (result.success) {
    return `## ${result.heading}\n${laneReceipt}\n\n${result.text}`.trim();
  }
  if (rescue?.success) {
    return [
      `## ${result.heading}`,
      laneReceipt,
      `- primary_run_failed: ${result.error ?? "unknown error"}`,
      `- rescue_coverage: ${rescue.helperRole} supplied a fallback contribution for ${rescue.targetRole}.`,
      "",
      rescue.text,
    ]
      .join("\n")
      .trim();
  }
  return `## ${result.heading}\n${laneReceipt}\n- run_failed: ${result.error ?? "unknown error"}\n- status: low-fidelity for this role in this turn.`.trim();
}

function summarizeLearningCouncilVisibleTopic(userMessage: string): string {
  const normalized = userMessage
    .replace(/<at\s+[^>]*>.*?<\/at>/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return "这个学习主题";
  }
  const stripped = normalized
    .replace(/^(?:今天|现在|接下来)\s*/u, "")
    .replace(/^(?:用|让)?(?:三|3|多)?个?模型(?:一起|同时)?\s*/u, "")
    .replace(/^(?:一起|同时)?\s*(?:学习一下|学一下|学学|学习|研究|补|看|读)\s*/u, "")
    .replace(/(?:的知识|知识|框架|资料|论文)$/u, "")
    .trim();
  if (stripped && stripped !== normalized) {
    return stripped.length > 36 ? `${stripped.slice(0, 36)}...` : stripped;
  }
  const topicPatterns = [
    /(?:今天|现在|接下来)?\s*(?:学习|研究|补|看|读)\s*([^，。；;,.!?！？]{1,36})/iu,
    /([^，。；;,.!?！？]{1,36})\s*(?:的知识|知识|框架|资料|论文)/iu,
  ];
  for (const pattern of topicPatterns) {
    const match = normalized.match(pattern);
    const topic = match?.[1]?.trim();
    if (topic) {
      return topic;
    }
  }
  return normalized.length > 36 ? `${normalized.slice(0, 36)}...` : normalized;
}

function renderLearningCouncilReadableLead(params: {
  userMessage: string;
  status: LearningCouncilArtifact["status"];
  roles: readonly LearningCouncilRoleRun[];
  rescues: readonly LearningCouncilRescueRun[];
  mutableFactWarnings: readonly string[];
  sourceCoverageWarnings: readonly string[];
}): string {
  const topic = summarizeLearningCouncilVisibleTopic(params.userMessage);
  const succeeded = params.roles.filter((role) => role.success).map((role) => role.role);
  const failed = params.roles.filter((role) => !role.success).map((role) => role.role);
  const rescued = params.rescues
    .filter((rescue) => rescue.success)
    .map((rescue) => `${rescue.targetRole}<=${rescue.helperRole}`);
  const statusLine =
    params.status === "degraded"
      ? `本轮没有三模型全绿：${succeeded.join("、") || "暂无模型"} 已产出，${failed.join("、") || "无"} 失败或超时。`
      : params.status === "full_with_mutable_fact_warnings"
        ? "三模型审阅已完成，但里面有可变事实或新鲜度提醒，不能直接当成最终事实。"
        : "三模型审阅已完成，可以进入压缩、复核和后续内化检查。";
  const reliability =
    params.status === "degraded"
      ? "结论只能当作临时学习材料：能用成功通道的高信号部分，但不能说已经完整内化。"
      : "结论仍然要经过证据门和后续 receipt，才能升级成稳定规则或长期记忆。";
  const warnings = [
    ...(rescued.length > 0 ? [`兜底覆盖: ${rescued.join("; ")}`] : []),
    ...(params.mutableFactWarnings.length > 0 ? ["存在可变事实新鲜度风险"] : []),
    ...(params.sourceCoverageWarnings.length > 0 ? ["来源覆盖可能偏窄"] : []),
  ];
  return [
    "## 先说结论",
    `- 学习主题: ${topic}`,
    `- 当前状态: ${statusLine}`,
    `- 怎么使用: ${reliability}`,
    ...(warnings.length > 0 ? [`- 剩余风险: ${warnings.join("；")}`] : []),
  ]
    .join("\n")
    .trim();
}

function dedupeBullets(items: string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const normalized = normalizeBulletValue(item).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalizeBulletValue(item));
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

function mergeMiniMaxRuns(
  primary: LearningCouncilRoleRun,
  secondary: LearningCouncilRoleRun | undefined,
): LearningCouncilRoleRun {
  if (!secondary || !secondary.success) {
    if (secondary && !secondary.success) {
      return {
        ...primary,
        text: [
          primary.text,
          "",
          "## Extra red-team pass",
          `- extra MiniMax pass failed: ${secondary.error ?? "unknown error"}`,
          "- keep this council result provisional if stronger challenge coverage was required.",
        ]
          .join("\n")
          .trim(),
      };
    }
    return primary;
  }

  const holds = dedupeBullets(
    [
      ...extractBullets(primary.text, "What holds up", 6),
      ...extractBullets(secondary.text, "What holds up", 6),
    ],
    6,
  );
  const challenges = dedupeBullets(
    [
      ...extractBullets(primary.text, "Challenges", 8),
      ...extractBullets(secondary.text, "Challenges", 8),
    ],
    8,
  );
  const evidenceGaps = dedupeBullets(
    [
      ...extractBullets(primary.text, "Evidence gaps", 6),
      ...extractBullets(secondary.text, "Evidence gaps", 6),
    ],
    6,
  );
  const discardList = dedupeBullets(
    [
      ...extractBullets(primary.text, "What to discard", 6, { fallbackToWholeText: false }),
      ...extractBullets(secondary.text, "What to discard", 6, { fallbackToWholeText: false }),
    ],
    6,
  );
  const lobsterImprovement = dedupeBullets(
    [
      ...extractBullets(primary.text, "Lobster improvement", 4, {
        fallbackToWholeText: false,
      }),
      ...extractBullets(secondary.text, "Lobster improvement", 4, {
        fallbackToWholeText: false,
      }),
    ],
    4,
  );
  const ruledOut = dedupeBullets(
    [
      ...extractBullets(primary.text, "Ruled out", 6, { fallbackToWholeText: false }),
      ...extractBullets(secondary.text, "Ruled out", 6, { fallbackToWholeText: false }),
    ],
    6,
  );
  const highestInfoNextChecks = dedupeBullets(
    [
      ...extractBullets(primary.text, "Highest-information next checks", 6, {
        fallbackToWholeText: false,
      }),
      ...extractBullets(secondary.text, "Highest-information next checks", 6, {
        fallbackToWholeText: false,
      }),
    ],
    6,
  );
  const replayFailureChecks = dedupeBullets(
    [
      ...extractBullets(primary.text, "Replay failure checks", 6, {
        fallbackToWholeText: false,
      }),
      ...extractBullets(secondary.text, "Replay failure checks", 6, {
        fallbackToWholeText: false,
      }),
    ],
    6,
  );

  return {
    ...primary,
    text: [
      "## What holds up",
      ...(holds.length > 0
        ? holds.map((item) => `- ${item}`)
        : ["- no clear hold-up points extracted"]),
      "",
      "## Challenges",
      ...(challenges.length > 0
        ? challenges.map((item) => `- ${item}`)
        : ["- no meaningful red-team challenge extracted"]),
      "",
      "## Evidence gaps",
      ...(evidenceGaps.length > 0
        ? evidenceGaps.map((item) => `- ${item}`)
        : ["- no explicit evidence gaps extracted"]),
      ...(discardList.length > 0
        ? ["", "## What to discard", ...discardList.map((item) => `- ${item}`)]
        : []),
      ...(lobsterImprovement.length > 0
        ? ["", "## Lobster improvement", ...lobsterImprovement.map((item) => `- ${item}`)]
        : []),
      ...(ruledOut.length > 0 ? ["", "## Ruled out", ...ruledOut.map((item) => `- ${item}`)] : []),
      ...(highestInfoNextChecks.length > 0
        ? [
            "",
            "## Highest-information next checks",
            ...highestInfoNextChecks.map((item) => `- ${item}`),
          ]
        : []),
      ...(replayFailureChecks.length > 0
        ? ["", "## Replay failure checks", ...replayFailureChecks.map((item) => `- ${item}`)]
        : []),
      "",
      "## Extra red-team pass",
      "- MiniMax-heavy mode ran an additional audit pass to increase counter-case coverage.",
    ].join("\n"),
  };
}

function renderConsensus(params: {
  kimi: LearningCouncilRoleRun;
  minimax: LearningCouncilRoleRun;
  deepseek: LearningCouncilRoleRun;
  rescues: LearningCouncilRescueRun[];
  mutableFactWarnings: string[];
  sourceCoverageWarnings: string[];
}): string {
  const minimaxConsensusSource = params.minimax.success
    ? params.minimax.text
    : (params.rescues.find((rescue) => rescue.targetRole === "minimax" && rescue.success)?.text ??
      "");
  const agreements = extractBullets(minimaxConsensusSource, "What holds up", 4);
  const disagreements = extractBullets(minimaxConsensusSource, "Challenges", 4);
  const evidenceGaps = extractBullets(minimaxConsensusSource, "Evidence gaps", 4);
  const roleFailures = [params.kimi, params.minimax, params.deepseek]
    .filter((result) => !result.success)
    .map((result) => `${result.role}=${result.error ?? "failed"}`);
  const rescueCoverage = params.rescues
    .filter((rescue) => rescue.success)
    .map((rescue) => `${rescue.targetRole}<=${rescue.helperRole}`);

  const lines = ["## Council consensus"];
  lines.push("");
  lines.push("### Agreements");
  if (agreements.length > 0) {
    lines.push(...agreements.map((item) => `- ${item}`));
  } else {
    lines.push("- no robust agreement extracted; treat the whole council output as provisional.");
  }
  lines.push("");
  lines.push("### Disagreements");
  if (disagreements.length > 0) {
    lines.push(...disagreements.map((item) => `- ${item}`));
  } else {
    lines.push("- no explicit disagreement extracted beyond normal uncertainty.");
  }
  lines.push("");
  lines.push("### Evidence gaps");
  if (evidenceGaps.length > 0) {
    lines.push(...evidenceGaps.map((item) => `- ${item}`));
  } else {
    lines.push(
      "- no explicit evidence-gap list was extracted; keep this low-fidelity if facts are mutable.",
    );
  }
  if (
    roleFailures.length > 0 ||
    params.mutableFactWarnings.length > 0 ||
    params.sourceCoverageWarnings.length > 0
  ) {
    lines.push("");
    lines.push("### Reliability note");
    if (roleFailures.length > 0) {
      lines.push(`- partial council only: ${roleFailures.join("; ")}`);
    }
    if (rescueCoverage.length > 0) {
      lines.push(`- fallback rescue coverage: ${rescueCoverage.join("; ")}`);
    }
    if (params.mutableFactWarnings.length > 0) {
      lines.push("- mutable facts may still be under-verified in this turn:");
      lines.push(...params.mutableFactWarnings.map((item) => `  - ${item}`));
      lines.push(
        "- treat numeric anchors as provisional until a primary-source or same-turn verification pass confirms them.",
      );
    }
    if (params.sourceCoverageWarnings.length > 0) {
      lines.push("- source coverage looked narrow or search-limited in this turn:");
      lines.push(...params.sourceCoverageWarnings.map((item) => `  - ${item}`));
      lines.push(
        "- treat missing international or cross-domain coverage as a real limit, not a hidden assumption.",
      );
    }
    lines.push(
      "- do not promote candidate lessons from this turn into durable doctrine without another reviewed pass.",
    );
  }
  lines.push("");
  lines.push("### Boundary");
  lines.push(
    "- learning outputs are for audited study and follow-up only; they are not direct trading instructions or automatic doctrine updates.",
  );
  return lines.join("\n");
}

function renderFollowUpChecklist(
  result: LearningCouncilRoleRun,
  rescue?: LearningCouncilRescueRun,
): string {
  const source = result.success ? result.text : rescue?.success ? rescue.text : "";
  const followUps = extractBullets(source, "Candidate follow-ups", 5);
  const weakEvidence = extractBullets(source, "Weak evidence", 3);
  const lines = ["## Follow-up checklist"];
  if (followUps.length > 0) {
    lines.push(...followUps.map((item) => `- ${item}`));
  } else {
    lines.push("- confirm the freshest primary sources before promoting any mutable facts.");
    lines.push("- compress only the highest-signal lesson into memory; keep the rest provisional.");
  }
  if (weakEvidence.length > 0) {
    lines.push("");
    lines.push("### Weak evidence to keep provisional");
    lines.push(...weakEvidence.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

async function writeLearningCouncilArtifact(params: {
  cfg: ClawdbotConfig;
  workspaceDir?: string;
  messageId: string;
  artifact: LearningCouncilArtifact;
}): Promise<void> {
  const workspaceDir = resolveLearningCouncilWorkspaceDir(params);
  if (!workspaceDir) {
    throw new Error("workspace dir unavailable for learning-council artifact persistence");
  }

  const stem = sanitizePathSegment(params.messageId) || "learning-council";
  await writeFileWithinRoot({
    rootDir: workspaceDir,
    relativePath: buildLearningCouncilArtifactJsonRelativePath(stem),
    data: renderLearningCouncilRuntimeArtifact(params.artifact),
    encoding: "utf-8",
    mkdir: true,
  });
  await writeFileWithinRoot({
    rootDir: workspaceDir,
    relativePath: buildLearningCouncilArtifactMarkdownRelativePath(stem),
    data: params.artifact.finalReply,
    encoding: "utf-8",
    mkdir: true,
  });
  await writeFileWithinRoot({
    rootDir: workspaceDir,
    relativePath: `memory/${buildLearningCouncilMemoryNoteFilename({
      dateStr: extractIsoDateKey(params.artifact.generatedAt) || "1970-01-01",
      noteSlug: stem,
    })}`,
    data: renderLearningCouncilMemoryNote({
      stem,
      generatedAt: params.artifact.generatedAt,
      status: params.artifact.status,
      userMessage: params.artifact.userMessage,
      mutableFactWarnings: params.artifact.mutableFactWarnings.length,
      failedRolesSummary:
        params.artifact.roles
          .filter((role) => !role.success)
          .map((role) => `${role.role}: ${role.error ?? "failed"}`)
          .join("; ") || "none",
      finalReplySnapshot: params.artifact.finalReply,
      keeperLines: params.artifact.runPacket.keepLines,
      discardLines: params.artifact.runPacket.discardLines,
      rehearsalTriggerLines: params.artifact.runPacket.replayTriggerLines,
      nextEvalCueLines: params.artifact.runPacket.nextEvalCueLines,
      runPacket: params.artifact.runPacket,
    }),
    encoding: "utf-8",
    mkdir: true,
  });
  await writeFileWithinRoot({
    rootDir: workspaceDir,
    relativePath: `memory/${buildLearningCouncilAdoptionLedgerFilename({
      dateStr: extractIsoDateKey(params.artifact.generatedAt) || "1970-01-01",
      noteSlug: stem,
    })}`,
    data: renderLearningCouncilAdoptionLedger(
      buildLearningCouncilAdoptionLedgerArtifact({
        messageId: params.messageId,
        generatedAt: params.artifact.generatedAt,
        userMessage: params.artifact.userMessage,
        status: params.artifact.status,
        artifactJsonPath: buildLearningCouncilArtifactJsonRelativePath(stem),
        runPacket: params.artifact.runPacket,
      }),
    ),
    encoding: "utf-8",
    mkdir: true,
  });
}

export async function runFeishuLearningCouncil(params: {
  cfg: ClawdbotConfig;
  userMessage: string;
  routeAgentId: string;
  sessionKey: string;
  messageId: string;
  workspaceDir?: string;
}): Promise<string> {
  const runtimeConfig = params.cfg;
  const baseSessionKey = `${params.sessionKey}:learning-council:${params.messageId}`;
  const directives = resolveLearningCouncilDirectives(params.userMessage);
  const learningAnchorContext = await resolveLearningCouncilAnchorContext({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    userMessage: params.userMessage,
  });
  const languageCoveragePreamble = directives.bilingualComprehension
    ? `${buildLanguageCoverageNote().join("\n")}\n`
    : "";

  const [kimi, deepseek] = await Promise.all([
    runLearningCouncilRole({
      cfg: runtimeConfig,
      role: "kimi",
      userMessage: params.userMessage,
      routeAgentId: params.routeAgentId,
      baseSessionKey,
      timeoutSeconds: 420,
      // kimi-k2.5 on Moonshot CN can consume the entire completion budget in
      // reasoning_content when thinking is enabled, leaving assistant content empty.
      // Keep Kimi's council lane in direct-answer mode so the synthesis section
      // stays user-visible while DeepSeek and MiniMax still do heavier auditing.
      thinking: "off",
      extraSystemPrompt: [
        languageCoveragePreamble.trim(),
        learningAnchorContext.prompt,
        buildKimiSystemPrompt({
          kimiHeavy: directives.kimiHeavy,
          internalizationFocus: directives.internalizationFocus,
          antiShallowSummary: directives.antiShallowSummary,
          durableLearningDiscipline: directives.durableLearningDiscipline,
          broadKnowledgeDistillation: directives.broadKnowledgeDistillation,
        }),
      ]
        .filter(Boolean)
        .join("\n\n"),
    }),
    runLearningCouncilRole({
      cfg: runtimeConfig,
      role: "deepseek",
      userMessage: params.userMessage,
      routeAgentId: params.routeAgentId,
      baseSessionKey,
      timeoutSeconds: 300,
      thinking: "medium",
      extraSystemPrompt: [
        languageCoveragePreamble.trim(),
        learningAnchorContext.prompt,
        buildDeepSeekSystemPrompt({
          internalizationFocus: directives.internalizationFocus,
          antiShallowSummary: directives.antiShallowSummary,
          durableLearningDiscipline: directives.durableLearningDiscipline,
          broadKnowledgeDistillation: directives.broadKnowledgeDistillation,
        }),
        directives.bilingualComprehension
          ? "Add compact bilingual terminology pairs, ambiguity traps, and workflow-trigger mapping when useful."
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    }),
  ]);

  const minimaxPrimary = await runLearningCouncilRole({
    cfg: runtimeConfig,
    role: "minimax",
    userMessage: params.userMessage,
    routeAgentId: params.routeAgentId,
    baseSessionKey,
    timeoutSeconds: 360,
    thinking: "high",
    extraSystemPrompt: [
      learningAnchorContext.prompt,
      buildMiniMaxSystemPrompt({
        userMessage: params.userMessage,
        kimiText: kimi.text || kimi.error || "kimi run unavailable",
        kimiModel: kimi.model,
        deepseekText: deepseek.text || deepseek.error || "deepseek run unavailable",
        deepseekModel: deepseek.model,
        minimaxHeavy: directives.minimaxHeavy,
        bilingualComprehension: directives.bilingualComprehension,
        internalizationFocus: directives.internalizationFocus,
        antiShallowSummary: directives.antiShallowSummary,
        durableLearningDiscipline: directives.durableLearningDiscipline,
        broadKnowledgeDistillation: directives.broadKnowledgeDistillation,
      }),
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const minimaxExtra = directives.minimaxHeavy
    ? await runLearningCouncilRole({
        cfg: runtimeConfig,
        role: "minimax",
        userMessage: params.userMessage,
        routeAgentId: params.routeAgentId,
        baseSessionKey: `${baseSessionKey}:redteam`,
        timeoutSeconds: 360,
        thinking: "high",
        extraSystemPrompt: [
          learningAnchorContext.prompt,
          buildMiniMaxSystemPrompt({
            userMessage: params.userMessage,
            kimiText: kimi.text || kimi.error || "kimi run unavailable",
            kimiModel: kimi.model,
            deepseekText: deepseek.text || deepseek.error || "deepseek run unavailable",
            deepseekModel: deepseek.model,
            minimaxHeavy: true,
            priorAuditText:
              minimaxPrimary.text || minimaxPrimary.error || "prior minimax audit unavailable",
            bilingualComprehension: directives.bilingualComprehension,
            internalizationFocus: directives.internalizationFocus,
            antiShallowSummary: directives.antiShallowSummary,
            durableLearningDiscipline: directives.durableLearningDiscipline,
            broadKnowledgeDistillation: directives.broadKnowledgeDistillation,
          }),
        ]
          .filter(Boolean)
          .join("\n\n"),
      })
    : undefined;
  const minimax = mergeMiniMaxRuns(minimaxPrimary, minimaxExtra);
  const rescues: LearningCouncilRescueRun[] = [];

  const rescueTargets: Array<{
    failed: LearningCouncilRole;
    helper: LearningCouncilRole | undefined;
  }> = [
    {
      failed: "kimi",
      helper: deepseek.success ? "deepseek" : minimax.success ? "minimax" : undefined,
    },
    {
      failed: "deepseek",
      helper: kimi.success ? "kimi" : minimax.success ? "minimax" : undefined,
    },
    {
      failed: "minimax",
      helper: deepseek.success ? "deepseek" : kimi.success ? "kimi" : undefined,
    },
  ];

  for (const target of rescueTargets) {
    const failedRole =
      target.failed === "kimi" ? kimi : target.failed === "deepseek" ? deepseek : minimax;
    if (failedRole.success || !target.helper) {
      continue;
    }
    rescues.push(
      await runLearningCouncilRescue({
        cfg: runtimeConfig,
        failedRole: target.failed,
        helperRole: target.helper,
        userMessage: params.userMessage,
        routeAgentId: params.routeAgentId,
        baseSessionKey,
        kimiText: kimi.text || kimi.error || "unavailable",
        minimaxText: minimax.text || minimax.error || "unavailable",
        deepseekText: deepseek.text || deepseek.error || "unavailable",
      }),
    );
  }

  const failures = [kimi, minimax, deepseek].filter((result) => !result.success);
  const mutableFactWarnings = [kimi, minimax, deepseek]
    .filter((result) => result.success)
    .flatMap((result) => detectMutableFactWarnings({ role: result.role, text: result.text }));
  const sourceCoverageWarnings = [kimi, minimax, deepseek].flatMap((result) =>
    detectSourceCoverageWeakness({
      role: result.role,
      text: result.text,
      error: result.error,
    }),
  );
  if (failures.length > 0) {
    await recordOperationalAnomaly({
      cfg: params.cfg as OpenClawConfig,
      category: "learning_quality_drift",
      severity: failures.length >= 2 ? "high" : "medium",
      source: "feishu.learning_command",
      foundationTemplate: "outcome-review",
      problem: "learning council role execution degraded",
      evidence: failures.map(
        (result) => `role=${result.role} model=${result.model} error=${result.error ?? "unknown"}`,
      ),
      impact: "the learning council returned a partial or degraded multi-model study result",
      suggestedScope:
        "smallest-safe-patch only; inspect learning_command orchestration, model availability, or gateway agent execution",
    });
  }

  if (mutableFactWarnings.length > 0) {
    await recordOperationalAnomaly({
      cfg: params.cfg as OpenClawConfig,
      category: "hallucination_risk",
      severity: "medium",
      source: "feishu.learning_command",
      foundationTemplate: "outcome-review",
      problem: "learning council produced mutable numeric facts without explicit freshness labels",
      evidence: mutableFactWarnings,
      impact: "the council may sound more certain than the verification state actually supports",
      suggestedScope:
        "smallest-safe-patch only; tighten mutable-facts verification or label discipline for learning_command",
    });
  }

  if (sourceCoverageWarnings.length > 0) {
    await recordOperationalAnomaly({
      cfg: params.cfg as OpenClawConfig,
      category: "provider_degradation",
      severity: "medium",
      source: "feishu.learning_command",
      foundationTemplate: "outcome-review",
      problem: "learning council source coverage looked narrow or search-limited",
      evidence: sourceCoverageWarnings,
      impact: "the council may have learned from a thinner source set than the operator expects",
      suggestedScope:
        "smallest-safe-patch only; inspect search coverage, provider health, or source-diversity discipline for learning_command",
    });
  }

  const status: LearningCouncilArtifact["status"] =
    failures.length > 0
      ? "degraded"
      : mutableFactWarnings.length > 0
        ? "full_with_mutable_fact_warnings"
        : "full";

  const distilledOperatingPack = resolveDistilledOperatingPack({
    kimi,
    minimax,
    deepseek,
    rescues,
    durableLearningDiscipline: directives.durableLearningDiscipline,
  });
  const stem = sanitizePathSegment(params.messageId) || "learning-council";
  const generatedAt = new Date().toISOString();
  const runPacket = buildLearningCouncilRunPacket({
    userMessage: params.userMessage,
    anchorContext: learningAnchorContext,
    distilledPack: distilledOperatingPack,
    artifactJsonPath: buildLearningCouncilArtifactJsonRelativePath(stem),
    memoryNotePath: `memory/${buildLearningCouncilMemoryNoteFilename({
      dateStr: extractIsoDateKey(generatedAt) || "1970-01-01",
      noteSlug: stem,
    })}`,
    adoptionLedgerPath: `memory/${buildLearningCouncilAdoptionLedgerFilename({
      dateStr: extractIsoDateKey(generatedAt) || "1970-01-01",
      noteSlug: stem,
    })}`,
  });

  const finalReply = [
    `Learning council run: ${
      status === "degraded"
        ? "partial / degraded execution"
        : status === "full_with_mutable_fact_warnings"
          ? "full three-model execution completed with low-fidelity fact warnings"
          : "full three-model execution completed"
    }.`,
    "",
    renderLearningCouncilReadableLead({
      userMessage: params.userMessage,
      status,
      roles: [kimi, minimax, deepseek],
      rescues,
      mutableFactWarnings,
      sourceCoverageWarnings,
    }),
    "",
    renderRoleSection(kimi),
    "",
    renderRoleSection(
      minimax,
      rescues.find((rescue) => rescue.targetRole === "minimax"),
    ),
    "",
    renderRoleSection(
      deepseek,
      rescues.find((rescue) => rescue.targetRole === "deepseek"),
    ),
    "",
    renderConsensus({
      kimi,
      minimax,
      deepseek,
      rescues,
      mutableFactWarnings,
      sourceCoverageWarnings,
    }),
    ...(directives.durableLearningDiscipline
      ? ["", renderDistilledOperatingPack(distilledOperatingPack)]
      : []),
    "",
    renderFollowUpChecklist(
      deepseek,
      rescues.find((rescue) => rescue.targetRole === "deepseek"),
    ),
  ]
    .join("\n")
    .trim();

  const artifact: LearningCouncilArtifact = {
    version: 2,
    generatedAt,
    messageId: params.messageId,
    userMessage: params.userMessage,
    status,
    mutableFactWarnings,
    roles: [kimi, minimax, deepseek],
    rescues,
    runPacket,
    finalReply,
  };

  try {
    await writeLearningCouncilArtifact({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      messageId: params.messageId,
      artifact,
    });
  } catch (error) {
    await recordOperationalAnomaly({
      cfg: params.cfg as OpenClawConfig,
      category: "write_edit_failure",
      severity: "medium",
      source: "feishu.learning_command",
      foundationTemplate: "outcome-review",
      problem: "failed to persist learning council artifact",
      evidence: [`message_id=${params.messageId}`, `status=${status}`, `error=${String(error)}`],
      impact:
        "the learning council completed, but its audit artifact was not persisted for later review",
      suggestedScope:
        "smallest-safe-patch only; inspect learning-council artifact persistence without changing other surface routing",
    });
  }

  return finalReply;
}
