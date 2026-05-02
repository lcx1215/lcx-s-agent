import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import {
  buildLearningCouncilArtifactJsonRelativePath,
  buildLobsterWorkfaceControlRoomSummary,
  buildLobsterWorkfaceFilename,
  buildKnowledgeValidationWeeklyArtifactFilename,
  buildOperatingWeeklyArtifactFilename,
  isFeishuFinanceDoctrineCalibrationFilename,
  parseFeishuFinanceDoctrineCalibrationArtifact,
  parseFeishuWorkReceiptArtifact,
  renderKnowledgeValidationWeeklyArtifact,
  renderLearningCouncilRuntimeArtifact,
  renderLobsterWorkfaceArtifact,
  renderPortfolioAnswerScorecardArtifact,
} from "../../../src/hooks/bundled/lobster-brain-registry.js";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import type { FeishuMessageEvent } from "./bot.js";
import {
  buildBroadcastSessionKey,
  buildFeishuAgentBody,
  buildFeishuPromptSurfaceNotice,
  ensureFeishuWorkReceiptArtifacts,
  resolveFeishuEffectiveStateSurface,
  buildSurfaceScopedSessionKey,
  handleFeishuMessage,
  resolveBroadcastAgents,
  toMessageResourceType,
} from "./bot.js";
import { LARK_EXTERNAL_SOURCE_LANGUAGE_BATCH } from "./lark-routing-corpus.js";
import { setFeishuRuntime } from "./runtime.js";
import { resolveFeishuControlRoomOrchestration, resolveFeishuSurfaceRouting } from "./surfaces.js";
import type { FeishuConfig } from "./types.js";

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockGetMessageFeishu,
  mockDownloadMessageResourceFeishu,
  mockCreateFeishuClient,
  mockRecordOperationalAnomaly,
  mockResolveAgentRoute,
  mockFindRunningFeishuLearningTimeboxSession,
  mockFindLatestFeishuLearningTimeboxSession,
  mockRunFeishuLearningCouncil,
  mockRunFeishuMarketIntelligencePacket,
  mockCreateGatewayLarkApiRouteProvider,
  mockPeekFeishuLearningTimeboxSession,
  mockStartFeishuLearningTimeboxSession,
} = vi.hoisted(() => ({
  createMockDispatcher: () => ({
    sendToolResult: vi.fn(() => false),
    sendBlockReply: vi.fn(() => false),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  }),
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" }),
  mockGetMessageFeishu: vi.fn().mockResolvedValue(null),
  mockDownloadMessageResourceFeishu: vi.fn().mockResolvedValue({
    buffer: Buffer.from("video"),
    contentType: "video/mp4",
    fileName: "clip.mp4",
  }),
  mockCreateFeishuClient: vi.fn(),
  mockRecordOperationalAnomaly: vi.fn(),
  mockResolveAgentRoute: vi.fn(() => ({
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  })),
  mockCreateGatewayLarkApiRouteProvider: vi.fn(
    () => async () =>
      ({
        family: "unknown" as const,
        confidence: 0,
        rationale: "test default skips live API routing",
      }) as unknown,
  ),
  mockRunFeishuLearningCouncil: vi.fn(),
  mockRunFeishuMarketIntelligencePacket: vi.fn(),
  mockFindRunningFeishuLearningTimeboxSession: vi.fn(() => undefined as unknown),
  mockFindLatestFeishuLearningTimeboxSession: vi.fn(async () => undefined as unknown),
  mockPeekFeishuLearningTimeboxSession: vi.fn(
    () => ({ status: "not_requested" as const }) as unknown,
  ),
  mockStartFeishuLearningTimeboxSession: vi.fn(
    async () => ({ status: "not_requested" as const }) as unknown,
  ),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: mockGetMessageFeishu,
}));

vi.mock("./media.js", () => ({
  downloadMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("../../../src/infra/operational-anomalies.js", () => ({
  recordOperationalAnomaly: mockRecordOperationalAnomaly,
}));

vi.mock("./learning-council.js", () => ({
  runFeishuLearningCouncil: mockRunFeishuLearningCouncil,
}));

vi.mock("./market-intelligence.js", () => ({
  runFeishuMarketIntelligencePacket: mockRunFeishuMarketIntelligencePacket,
}));

vi.mock("./lark-api-route-provider.js", () => ({
  createGatewayLarkApiRouteProvider: mockCreateGatewayLarkApiRouteProvider,
}));

vi.mock("./learning-timebox.js", () => ({
  findLatestFeishuLearningTimeboxSession: mockFindLatestFeishuLearningTimeboxSession,
  findRunningFeishuLearningTimeboxSession: mockFindRunningFeishuLearningTimeboxSession,
  peekFeishuLearningTimeboxSession: mockPeekFeishuLearningTimeboxSession,
  startFeishuLearningTimeboxSession: mockStartFeishuLearningTimeboxSession,
}));

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  } as RuntimeEnv;
}

async function dispatchMessage(params: { cfg: ClawdbotConfig; event: FeishuMessageEvent }) {
  await handleFeishuMessage({
    cfg: params.cfg,
    event: params.event,
    runtime: createRuntimeEnv(),
  });
}

function buildFeishuFinanceLearningSourceArticle() {
  return [
    "# ETF factor timing workflow",
    "",
    "Source: Lark Manual Source",
    "Publish Date: 2026-04-27",
    "Extraction Summary: This article describes a bounded ETF factor timing workflow with explicit evidence categories, mechanism claims, and failure-mode discipline for later manual review.",
    "Capability Name: ETF factor timing workflow",
    "Capability Type: analysis_method",
    "Related Finance Domains: etf_regime, portfolio_risk_gates",
    "Capability Tags: factor_research, tactical_timing, risk_gate_design",
    "Method Summary: Combine ETF regime context, factor breadth, and risk-control gates into a low-frequency timing checklist instead of a direct trading signal.",
    "Required Data Sources: ETF issuer data, factor breadth data, macro rate context",
    "Causal Claim: Factor breadth and macro regime context can improve which ETF timing questions deserve follow-up, without proving a standalone forecasting edge.",
    "Evidence Categories: equity_market_evidence, etf_regime_evidence, backtest_or_empirical_evidence, macro_rates_evidence, portfolio_risk_evidence, implementation_evidence",
    "Evidence Summary: ETF regime observations, factor breadth context, macro rate evidence, and portfolio risk gates support bounded timing research while requiring manual confirmation.",
    "Evidence Level: case_study",
    "Implementation Requirements: Maintain a low-frequency checklist, source notes, and explicit invalidation gates before any portfolio discussion.",
    "Risk and Failure Modes: Factor timing can overfit, macro context can reverse, noisy breadth signals can encourage premature action, and whipsaw or drawdown risk can make a timing rule harmful even when the research narrative sounds plausible.",
    "Overfitting or Spurious Risk: A small backtest sample can make timing rules look more stable than they are out of sample, and confounders such as rates, sector concentration, liquidity, and volatility regimes can explain the apparent factor edge.",
    "Compliance or Collection Notes: Use public or operator-provided local research material only.",
    "Suggested Attachment Point: research_capability:tactical_timing",
    "Allowed Action Authority: research_only",
    "",
    "This is a research-only method note for capability extraction and does not authorize trading.",
  ].join("\n");
}

async function createFeishuLearningStatusWorkspace(params?: {
  learnedLines?: string[];
  includeCurrentResearchLine?: boolean;
}): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-learning-status-"));
  await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });

  if (params?.learnedLines) {
    await fs.writeFile(
      path.join(tempDir, "memory", buildLobsterWorkfaceFilename("2026-04-08")),
      renderLobsterWorkfaceArtifact({
        targetDateKey: "2026-04-08",
        sessionKey: "agent:main:main",
        learningItems: 1,
        correctionNotes: 0,
        watchtowerSignals: 0,
        codexEscalations: 0,
        totalTokens: "888",
        estimatedCost: "$0.0200",
        dashboardSnapshotLines: ["- Learning Flow: █ 1 item"],
        validationRadarLines: ["- No weekly validation radar is available yet."],
        feishuLanePanelLines: ["- No active Feishu surface lanes are recorded yet."],
        sevenDayOperatingViewLines: ["- Learning Items (7d): 1"],
        yesterdayLearnedLines: params.learnedLines,
        yesterdayCorrectedLines: ["- No correction note was captured yesterday."],
        yesterdayWatchtowerLines: ["- No watchtower anomaly was recorded yesterday."],
        codexEscalationLines: ["- No Codex escalation packet was recorded yesterday."],
        portfolioAnswerScorecardLines: ["- No portfolio-answer scorecard is available yet."],
        tokenDashboardLeadLine: "- Yesterday total: 888 tokens / $0.0200",
        tokenDashboardModelLines: [
          "",
          "### By Model",
          "- No model usage rows were recorded yesterday.",
        ],
        tokenTrendLines: ["- 2026-04-08: █ 888"],
        readingGuideLines: ["- Use this artifact to supervise daily usefulness."],
      }),
      "utf-8",
    );
  }

  if (params?.includeCurrentResearchLine !== false) {
    await fs.writeFile(
      path.join(tempDir, "memory", "current-research-line.md"),
      "# Current Research Line\n",
      "utf-8",
    );
  }

  return tempDir;
}

async function seedCurrentResearchLine(params: {
  workspaceDir: string;
  content?: string;
}): Promise<void> {
  await fs.mkdir(path.join(params.workspaceDir, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(params.workspaceDir, "memory", "current-research-line.md"),
    params.content ??
      [
        "# Current Research Line",
        "",
        "current_focus: Re-risk QQQ only if rates and dollar stop squeezing growth.",
        "top_decision: Whether to stay patient on the current ETF transmission line instead of reopening the old open-source detour.",
        "current_session_summary: Continue the active ETF transmission study and ignore the older side thread unless the anchor breaks.",
        "next_step: Re-check the current rates, dollar, and duration path before changing the working stance.",
        "research_guardrail: research-only; no execution approval and no fake certainty.",
        "",
      ].join("\n"),
    "utf-8",
  );
}

beforeEach(() => {
  mockRecordOperationalAnomaly.mockReset();
  mockRunFeishuLearningCouncil.mockReset();
  mockRunFeishuMarketIntelligencePacket.mockReset();
  mockCreateGatewayLarkApiRouteProvider.mockReset();
  mockCreateGatewayLarkApiRouteProvider.mockReturnValue(async () => ({
    family: "unknown",
    confidence: 0,
    rationale: "test default skips live API routing",
  }));
  mockFindRunningFeishuLearningTimeboxSession.mockReset();
  mockFindRunningFeishuLearningTimeboxSession.mockReturnValue(undefined);
  mockFindLatestFeishuLearningTimeboxSession.mockReset();
  mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue(undefined);
  mockPeekFeishuLearningTimeboxSession.mockReset();
  mockPeekFeishuLearningTimeboxSession.mockReturnValue({ status: "not_requested" });
  mockStartFeishuLearningTimeboxSession.mockReset();
  mockStartFeishuLearningTimeboxSession.mockResolvedValue({ status: "not_requested" });
  mockSendMessageFeishu.mockReset();
  mockSendMessageFeishu.mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" });
  mockResolveAgentRoute.mockReset();
  mockResolveAgentRoute.mockReturnValue({
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  });
});

describe("ensureFeishuWorkReceiptArtifacts", () => {
  it("materializes honest empty-state receipt index and repair queue", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-receipts-empty-"));
    const receiptsDir = path.join(tempDir, "memory", "feishu-work-receipts");

    await ensureFeishuWorkReceiptArtifacts({ receiptsDir });

    const receiptIndex = await fs.readFile(path.join(receiptsDir, "index.md"), "utf-8");
    const repairQueue = await fs.readFile(path.join(receiptsDir, "repair-queue.md"), "utf-8");
    expect(receiptIndex).toContain("# Feishu Work Receipt Index");
    expect(receiptIndex).toContain("- **Tracked Receipts**: 0");
    expect(receiptIndex).toContain("No Feishu work receipts are recorded yet.");
    expect(repairQueue).toContain("# Feishu Work Repair Queue");
    expect(repairQueue).toContain("- **Active Repair Clusters**: 0");
    expect(repairQueue).toContain("No repair-minded work receipts are queued right now.");

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

describe("buildFeishuAgentBody", () => {
  it("builds message id, speaker, quoted content, mentions, and permission notice in order", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "hello world",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-42",
        mentionTargets: [{ openId: "ou-target", name: "Target User", key: "@_user_1" }],
      },
      quotedContent: "previous message",
      permissionErrorForAgent: {
        code: 99991672,
        message: "permission denied",
        grantUrl: "https://open.feishu.cn/app/cli_test",
      },
    });

    expect(body).toBe(
      '[message_id: msg-42]\nSender Name: [Replying to: "previous message"]\n\nhello world\n\n[System: Your reply will automatically @mention: Target User. Do not write @xxx yourself.]\n\n[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: https://open.feishu.cn/app/cli_test]',
    );
  });

  it("adds a macro intent notice for high-confidence macro prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "查一下最近美国非农、通胀预期和 QQQ / TLT 的关系",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-macro-42",
      },
    });

    expect(body).toContain("[System: Treat this as macro and major-asset research.");
    expect(body).toContain(
      "When freshness is weak, stale, cached, or provider-limited, do not present high-specificity market figures, exact levels, exact percentages, or exact point estimates as if they were freshly verified in this turn",
    );
    expect(body).toContain("查一下最近美国非农、通胀预期和 QQQ / TLT 的关系");
  });

  it("adds a frontier intent notice for leakage and overfitting prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "继续这个方法研究，但先检查这个 paper 有没有 leakage 和 overfitting 风险",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-frontier-42",
      },
    });

    expect(body).toContain("[System: Treat this as method or paper research.");
    expect(body).toContain("Focus on leakage, overfitting, replication risk, and method quality");
    expect(body).toContain("papers actually searched or read");
    expect(body).toContain("source coverage limits");
    expect(body).toContain("whether it changes daily Lobster usage now");
    expect(body).toContain("Do not rewrite it into a fundamental intake.");
    expect(body).toContain(
      "继续这个方法研究，但先检查这个 paper 有没有 leakage 和 overfitting 风险",
    );
  });

  it("adds a learning intent notice for open-source study prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "今天你去学学开源的新技术，顺手总结一下关键原理和坑",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-42",
      },
    });

    expect(body).toContain("[System: Treat this as learning or open-source study work.");
    expect(body).toContain("Start from the active Lobster brain, not from a blank slate");
    expect(body).toContain("raw learning objective as the learningIntent");
    expect(body).toContain("retrieved before new retention and again after attachment");
    expect(body).toContain("Keep language-interface routing samples separate");
    expect(body).toContain(
      "only source intake, extraction, attachment, and inspect-ready finance pipeline outputs can become capability cards",
    );
    expect(body).toContain(
      "Keep the distillation useful for both Lobster's general meta-capability",
    );
    expect(body).toContain("今天你去学学开源的新技术，顺手总结一下关键原理和坑");
  });

  it("adds a finance learning pipeline notice for concrete finance capability learning prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "学习一套很好的量化因子择时策略，最后要有 retrieval receipt 和 review",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-finance-learning-pipeline",
      },
    });

    expect(body).toContain("Treat this as a finance learning pipeline request");
    expect(body).toContain("Preserve the raw user wording as learningIntent");
    expect(body).toContain("finance_learning_pipeline_orchestrator");
    expect(body).toContain("retrievalReceiptPath and retrievalReviewPath");
    expect(body).toContain("Keep Lark routing corpus samples separate");
  });

  it("adds a learning intent notice for GitHub/open-source internalization prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "去github上学习开源的值得你学的，并把值得内化的内化",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-github-42",
      },
    });

    expect(body).toContain("[System: Treat this as learning or open-source study work.");
    expect(body).toContain("Start from the active Lobster brain, not from a blank slate");
    expect(body).toContain("去github上学习开源的值得你学的，并把值得内化的内化");
  });

  it("adds a learning intent notice for colloquial GitHub/open-source internalization prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "去github上学值得你学的，但别做开源综述，直接告诉我哪些会改你以后的做法",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-github-colloquial-42",
      },
    });

    expect(body).toContain("[System: Treat this as learning or open-source study work.");
    expect(body).toContain(
      "Keep the distillation useful for both Lobster's general meta-capability",
    );
    expect(body).toContain(
      "去github上学值得你学的，但别做开源综述，直接告诉我哪些会改你以后的做法",
    );
  });

  it("adds a learning intent notice for rough colloquial GitHub skill-stealing prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "github上那些能偷的招你去偷，最后只说真会改你手法的三条，别做分享会",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-github-colloquial-43",
      },
    });

    expect(body).toContain("[System: Treat this as learning or open-source study work.");
    expect(body).toContain("github上那些能偷的招你去偷，最后只说真会改你手法的三条，别做分享会");
  });

  it("adds a learning-internalization audit notice for rough '前几天读那堆东西，到底留下啥了' asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "前几天读那堆东西，到底留下啥了，还是过眼云烟",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-internalization-audit-44",
      },
    });

    expect(body).toContain("Treat this as a learning-internalization audit");
    expect(body).toContain("what appears to have been genuinely internalized");
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-internalization audit notice for rough '进规矩了没，还是嘴上热闹' asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你前阵子学的那些长期记忆玩意儿，进规矩了没，还是嘴上热闹",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-internalization-audit-45",
      },
    });

    expect(body).toContain("Treat this as a learning-internalization audit");
    expect(body).toContain("what still looks like shallow summary or surface enthusiasm");
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-internalization audit notice for rough '改掉你老毛病' asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "别端水，就说上次学的那些花活有没有一条真改掉你老毛病",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-internalization-audit-46",
      },
    });

    expect(body).toContain("Treat this as a learning-internalization audit");
    expect(body).toContain("what evidence proves the learning changed Lobster's reusable behavior");
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-internalization audit notice for rough '忘回去了' asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你是不是把前阵子学过的东西又忘回去了",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-internalization-audit-47",
      },
    });

    expect(body).toContain("Treat this as a learning-internalization audit");
    expect(body).toContain("what still looks like shallow summary or surface enthusiasm");
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning intent notice for LLM-finance-agent article learning prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "去读关于llm应用在金融智能体上的文章，对你自我提升的启发",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-llm-finance-42",
      },
    });

    expect(body).toContain("[System: Treat this as learning or open-source study work.");
    expect(body).toContain("去读关于llm应用在金融智能体上的文章，对你自我提升的启发");
  });

  it("adds a method-learning notice for DS/statistics ETF-timing prompts instead of a macro-only framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "我是学ds统计的中国散户，想把回归、样本外验证、bootstrap 和显著性检验用到 ETF 择时上，你别讲空话，去学一下最值得我反复记住的框架",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-ds-stat-learning-42",
      },
    });

    expect(body).toContain("[System: Treat this as method or paper research.");
    expect(body).not.toContain("[System: Treat this as macro and major-asset research.");
  });

  it("keeps DS/statistics ETF-timing method questions on the method-learning prompt instead of macro framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "我是学ds和统计的中国散户，你别给我讲市场大词，直接告诉我：如果我做ETF轮动，用样本外、walk-forward、bootstrap，什么结果才算没有自欺欺人？",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-ds-stat-question-42",
      },
    });

    expect(body).toContain("[System: Treat this as method or paper research.");
    expect(body).not.toContain("[System: Treat this as macro and major-asset research.");
  });

  it("keeps DS/statistics method questions on a learning-only control-room orchestration notice", () => {
    const cfg = {
      surfaces: {
        control_room: { chatId: "oc-control" },
        learning_command: { chatId: "oc-learning" },
        technical_daily: { chatId: "oc-tech" },
      },
    } as FeishuConfig;
    const content =
      "我是学ds和统计的中国散户，你别给我讲市场大词，直接告诉我：如果我做ETF轮动，用样本外、walk-forward、bootstrap，什么结果才算没有自欺欺人？";
    const surfaceRouting = resolveFeishuSurfaceRouting({
      cfg,
      chatId: "oc-control",
      content,
    });
    const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
      currentSurface: surfaceRouting.currentSurface,
      targetSurface: surfaceRouting.targetSurface,
      content,
    });
    const notice = buildFeishuPromptSurfaceNotice({
      surfaceRouting,
      controlRoomOrchestration,
    });

    expect(notice).toContain(
      "Internally fan this request out to the relevant specialist surfaces: learning_command.",
    );
    expect(notice).not.toContain("technical_daily");
  });

  it("adds a learning-internalization audit notice for 'did the learning really stick' prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "最近学的 openclaw 更新到底有没有内化成可复用规则，别给我做总结秀",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-internalization-audit-42",
      },
    });

    expect(body).toContain(
      "[System: Treat this as a learning-internalization audit, not as a broad system overview and not as a fresh learning request.",
    );
    expect(body).toContain(
      "Start by checking the recent learning outputs, protected summaries when present, the latest learning carryover cue (retain / discard / replay / next eval), reusable rules, and any correction notes tied to this topic.",
    );
    expect(body).toContain("what evidence proves the learning changed Lobster's reusable behavior");
    expect(body).not.toContain("[System: Treat this as learning or open-source study work.");
  });

  it("keeps learning-internalization audit questions on a knowledge-plus-ops control-room notice instead of a four-way overview", () => {
    const cfg = {
      surfaces: {
        control_room: { chatId: "oc-control" },
        technical_daily: { chatId: "oc-tech" },
        fundamental_research: { chatId: "oc-fund" },
        knowledge_maintenance: { chatId: "oc-knowledge" },
        ops_audit: { chatId: "oc-ops" },
      },
    } as FeishuConfig;
    const content = "最近学的 openclaw 更新到底有没有内化成可复用规则，别给我做总结秀";
    const surfaceRouting = resolveFeishuSurfaceRouting({
      cfg,
      chatId: "oc-control",
      content,
    });
    const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
      currentSurface: surfaceRouting.currentSurface,
      targetSurface: surfaceRouting.targetSurface,
      content,
    });
    const notice = buildFeishuPromptSurfaceNotice({
      surfaceRouting,
      controlRoomOrchestration,
    });

    expect(notice).toContain(
      "Internally fan this request out to the relevant specialist surfaces: knowledge_maintenance, ops_audit.",
    );
    expect(notice).toContain("This is a control-room learning-internalization audit");
    expect(notice).toContain("Internal durable-state evidence is primary here, not secondary");
    expect(notice).not.toContain("Treat internal workflow or progress state as secondary");
    expect(notice).not.toContain("Keep internal workflow status secondary");
    expect(notice).not.toContain("technical_daily");
    expect(notice).not.toContain("fundamental_research");
  });

  it("adds a learning-internalization audit notice for '沉淀成了哪些以后会复用的规则' prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你先别总结，直接告诉我最近学的 openclaw 更新到底沉淀成了哪些以后会复用的规则",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-internalization-audit-43",
      },
    });

    expect(body).toContain("Treat this as a learning-internalization audit");
    expect(body).toContain(
      "Start by checking the recent learning outputs, protected summaries when present, the latest learning carryover cue (retain / discard / replay / next eval), reusable rules, and any correction notes tied to this topic.",
    );
    expect(body).toContain("what evidence proves the learning changed Lobster's reusable behavior");
    expect(body).not.toContain("technical_daily");
  });

  it("adds a learning-workflow audit notice for background-learning failure asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "别给我一份总结，你就告诉我最近后台自动学习有没有卡住，卡在哪",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-workflow-audit-42",
      },
    });

    expect(body).toContain("Treat this as a learning-workflow audit");
    expect(body).toContain(
      "the latest learning carryover cue (retain / discard / replay / next eval), protected summaries when present, learning-session receipts or timebox state",
    );
    expect(body).toContain(
      "what reached protected summaries or other durable memory versus what only exists as a report",
    );
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("keeps learning-workflow audit questions on a dedicated control-room audit notice", () => {
    const cfg = {
      surfaces: {
        control_room: { chatId: "oc-control" },
        technical_daily: { chatId: "oc-tech" },
        fundamental_research: { chatId: "oc-fund" },
        knowledge_maintenance: { chatId: "oc-knowledge" },
        ops_audit: { chatId: "oc-ops" },
      },
    } as FeishuConfig;
    const content = "别给我一份总结，你就告诉我最近后台自动学习有没有卡住，卡在哪";
    const surfaceRouting = resolveFeishuSurfaceRouting({
      cfg,
      chatId: "oc-control",
      content,
    });
    const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
      currentSurface: surfaceRouting.currentSurface,
      targetSurface: surfaceRouting.targetSurface,
      content,
    });
    const notice = buildFeishuPromptSurfaceNotice({
      surfaceRouting,
      controlRoomOrchestration,
    });

    expect(notice).toContain(
      "Internally fan this request out to the relevant specialist surfaces: knowledge_maintenance, ops_audit.",
    );
    expect(notice).toContain("This is a control-room learning-workflow audit");
    expect(notice).toContain("Workflow and durable-state evidence are primary here, not secondary");
    expect(notice).not.toContain("Treat internal workflow or progress state as secondary");
    expect(notice).not.toContain("Keep internal workflow status secondary");
    expect(notice).not.toContain("technical_daily");
    expect(notice).not.toContain("fundamental_research");
  });

  it("adds a learning-internalization audit notice for rough '学进规矩的两条和明确扔掉的两条' asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你别跟我讲学了多少，就说最近学进规矩的两条和明确扔掉的两条",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-internalization-audit-44",
      },
    });

    expect(body).toContain("Treat this as a learning-internalization audit");
    expect(body).toContain(
      "the latest learning carryover cue (retain / discard / replay / next eval)",
    );
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-workflow audit notice for memory-vs-report asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "我昨天让你学的东西，现在到底写进记忆还是只是生成了报告",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-workflow-audit-43",
      },
    });

    expect(body).toContain("Treat this as a learning-workflow audit");
    expect(body).toContain(
      "what reached protected summaries or other durable memory versus what only exists as a report",
    );
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-workflow audit notice for rough '写进脑子还是躺在 report 里装样子' asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "我前天让你学那个，现在是写进脑子了还是还躺在 report 里装样子",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-workflow-audit-44",
      },
    });

    expect(body).toContain("Treat this as a learning-workflow audit");
    expect(body).toContain(
      "what reached protected summaries or other durable memory versus what only exists as a report",
    );
    expect(body).toContain("where the workflow is stuck or overstating success");
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-workflow audit notice for rough backend-crash asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你别给我整日报，我就问自动学习后台最近是不是死过机，后来是续上了还是装没事",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-workflow-audit-45",
      },
    });

    expect(body).toContain("Treat this as a learning-workflow audit");
    expect(body).toContain(
      "the latest learning carryover cue (retain / discard / replay / next eval)",
    );
    expect(body).toContain("learning-session receipts or timebox state");
    expect(body).toContain(
      "whether the latest learning workflow completed, failed, was interrupted, or only looked active",
    );
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-workflow audit notice for rough mid-run breakage asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "后台那条学习链是不是半路断过，然后又装作啥事没有",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-workflow-audit-46",
      },
    });

    expect(body).toContain("Treat this as a learning-workflow audit");
    expect(body).toContain(
      "whether the latest learning workflow completed, failed, was interrupted, or only looked active",
    );
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-workflow audit notice for rough silent-breakage asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "别装稳定，自动学习后台是不是自己断过又没报",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-workflow-audit-47",
      },
    });

    expect(body).toContain("Treat this as a learning-workflow audit");
    expect(body).toContain("where the workflow is stuck or overstating success");
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-workflow audit notice for rough '没落账，只是文件看着多' asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "那条后台学习是不是根本没落账，只是文件看着多",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-workflow-audit-48",
      },
    });

    expect(body).toContain("Treat this as a learning-workflow audit");
    expect(body).toContain(
      "what reached protected summaries or other durable memory versus what only exists as a report",
    );
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a learning-workflow audit notice for rough '只会留痕，不会真落账' asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "自动学习后台是不是只会留痕，不会真落账",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-learning-workflow-audit-49",
      },
    });

    expect(body).toContain("Treat this as a learning-workflow audit");
    expect(body).toContain(
      "what reached protected summaries or other durable memory versus what only exists as a report",
    );
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("adds a live search-health notice for web-search availability questions", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "现在网络搜索可以用吗",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-search-health-42",
      },
    });

    expect(body).toContain("[System: Treat this as a live search/provider health question.");
    expect(body).toContain(
      "Distinguish clearly between current availability and stale past failures.",
    );
    expect(body).toContain("If web search is working now, say so directly in plain language.");
  });

  it("keeps control-room aggregate red-team asks on control-room prompt framing instead of a specialist lane notice", () => {
    const cfg = {
      surfaces: {
        control_room: { chatId: "oc-control" },
        technical_daily: { chatId: "oc-tech" },
        fundamental_research: { chatId: "oc-fund" },
        knowledge_maintenance: { chatId: "oc-knowledge" },
        ops_audit: { chatId: "oc-ops" },
      },
    } as FeishuConfig;
    const surfaceRouting = resolveFeishuSurfaceRouting({
      cfg,
      chatId: "oc-control",
      content: "今天的控制室总结，如果错了最可能错在哪",
    });
    const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
      currentSurface: surfaceRouting.currentSurface,
      targetSurface: surfaceRouting.targetSurface,
      content: "今天的控制室总结，如果错了最可能错在哪",
    });

    const notice = buildFeishuPromptSurfaceNotice({
      surfaceRouting,
      controlRoomOrchestration,
    });

    expect(notice).toContain("Feishu operating surface target = control_room");
    expect(notice).toContain("Control-room orchestration mode is active");
    expect(notice).not.toContain("dedicated knowledge_maintenance working lane");
  });

  it("keeps control-room aggregate system-health asks on control-room prompt framing instead of ops-only notice", () => {
    const cfg = {
      surfaces: {
        control_room: { chatId: "oc-control" },
        technical_daily: { chatId: "oc-tech" },
        fundamental_research: { chatId: "oc-fund" },
        knowledge_maintenance: { chatId: "oc-knowledge" },
        ops_audit: { chatId: "oc-ops" },
      },
    } as FeishuConfig;
    const surfaceRouting = resolveFeishuSurfaceRouting({
      cfg,
      chatId: "oc-control",
      content: "把今天的系统健康、学习状态、研究状态一起讲给我",
    });
    const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
      currentSurface: surfaceRouting.currentSurface,
      targetSurface: surfaceRouting.targetSurface,
      content: "把今天的系统健康、学习状态、研究状态一起讲给我",
    });

    const notice = buildFeishuPromptSurfaceNotice({
      surfaceRouting,
      controlRoomOrchestration,
    });

    expect(notice).toContain("Feishu operating surface target = control_room");
    expect(notice).toContain("Control-room orchestration mode is active");
    expect(notice).not.toContain("dedicated ops_audit working lane");
  });

  it("preserves specialist-lane notice for true specialist-chat asks without control-room orchestration", () => {
    const cfg = {
      surfaces: {
        technical_daily: { chatId: "oc-tech" },
      },
    } as FeishuConfig;
    const surfaceRouting = resolveFeishuSurfaceRouting({
      cfg,
      chatId: "oc-tech",
      content: "QQQ 现在还能拿吗",
    });
    const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
      currentSurface: surfaceRouting.currentSurface,
      targetSurface: surfaceRouting.targetSurface,
      content: "QQQ 现在还能拿吗",
    });

    const notice = buildFeishuPromptSurfaceNotice({
      surfaceRouting,
      controlRoomOrchestration,
    });

    expect(notice).toContain("Feishu operating surface target = technical_daily");
    expect(notice).toContain("dedicated technical_daily working lane");
    expect(notice).not.toContain("Feishu operating surface target = control_room");
    expect(controlRoomOrchestration).toBeUndefined();
  });

  it("adds an explicit implementation notice for build-style requests", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "开始实现这个复盘系统，写出代码并保存文件",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-implement-42",
      },
    });

    expect(body).toContain("[System: Treat this as explicit implementation work.");
    expect(body).toContain("state the root cause or design gap");
    expect(body).toContain("Do not silently expand into adjacent refactors");
  });

  it("adds a continuation guard notice for terse next-step prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "下一步：Week 9-10 低频研究卫生",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-next-step-42",
      },
    });

    expect(body).toContain("[System: Treat this as a bounded continuation turn");
    expect(body).toContain("Reply with the next concrete step, current status");
    expect(body).toContain(
      "Do not silently escalate a terse continuation or approval into long code generation, file creation, workspace writes, or multi-step implementation work",
    );
    expect(body).toContain("下一步：Week 9-10 低频研究卫生");
  });

  it("adds a structured correction-loop notice for feedback-prefixed prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "反馈：你昨天那条风险判断证据不够，而且已经重复两次了。",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-feedback-42",
      },
    });

    expect(body).toContain("[System: Treat this as operator correction-loop input");
    expect(body).toContain(
      "Start with one short human sentence that plainly acknowledges what was wrong and what changes now.",
    );
    expect(body).toContain("Then convert it into a structured correction note");
    expect(body).toContain("prior claim or behavior");
    expect(body).toContain("replacement rule or corrected stance");
    expect(body).toContain("repair-ticket candidate");
  });

  it("adds the same correction-loop notice for high-confidence natural complaint corrections", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你刚才那段还是词不达意。我让你先说动作和范围，不是直接重写长文。",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-natural-feedback-42",
      },
    });

    expect(body).toContain("[System: Treat this as operator correction-loop input");
    expect(body).toContain("[System: Negated-scope correction detected.");
    expect(body).toContain("not requested / excluded");
    expect(body).toContain("actually requested after");
    expect(body).toContain("Start with one short human sentence that plainly acknowledges");
    expect(body).toContain("Then convert it into a structured correction note");
  });

  it("adds negated-scope guard while preserving the real target intent", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "我不是问现在买不买，我是问你上次那套逻辑现在是不是已经失效了",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-negated-scope-revalidation-42",
      },
    });

    expect(body).toContain("[System: Negated-scope correction detected.");
    expect(body).toContain("Do not execute or elaborate the action the operator negated");
    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("adds negated-scope guard for learning requests without losing learning framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "别做开源综述，只留下能改你做法的规则",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-negated-learning-scope-42",
      },
    });

    expect(body).toContain("[System: Negated-scope correction detected.");
    expect(body).toContain("not requested / excluded");
    expect(body).toContain("Treat this as learning or open-source study work");
  });

  it("adds temporal-scope guard for current search-health asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "今天的搜索能力用今天的证据说，别引用上次坏掉那次",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-temporal-search-42",
      },
    });

    expect(body).toContain("[System: Temporal-scope guard detected.");
    expect(body).toContain("pin the requested evidence window");
    expect(body).toContain("Do not answer a current/today question from stale prior evidence");
    expect(body).toContain("Treat this as a live search/provider health question");
  });

  it("adds temporal-scope guard for old-thesis revalidation without losing revalidation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "上次那个结论现在还成立吗，别把旧证据当当前状态",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-temporal-thesis-42",
      },
    });

    expect(body).toContain("[System: Temporal-scope guard detected.");
    expect(body).toContain("stale/prior explicitly");
    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
  });

  it("adds bounded-priority guard without losing implementation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "按优先级先做一个最小可验证 patch，别扩新分支，写代码并保存文件",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-bounded-priority-implementation-42",
      },
    });

    expect(body).toContain("[System: Bounded-priority scope detected.");
    expect(body).toContain("Pick exactly one highest-value semantic family or patch point");
    expect(body).toContain("State the next step before acting");
    expect(body).toContain("Treat this as explicit implementation work");
  });

  it("adds bounded-priority guard without losing continuation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "继续提升 Lark 对话理解，但一次只做一个语义家族",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-bounded-priority-learning-42",
      },
    });

    expect(body).toContain("[System: Bounded-priority scope detected.");
    expect(body).toContain("avoid opening parallel branches");
    expect(body).toContain("Treat this as a bounded continuation turn");
  });

  it("adds completion-proof guard for done-vs-started audits", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你到底做完了没有，proof 是什么",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-completion-proof-42",
      },
    });

    expect(body).toContain("[System: Completion-proof guard detected.");
    expect(body).toContain("Separate planned, started, attempted, completed, and verified");
    expect(body).toContain("if no proof exists, say no proof exists");
  });

  it("adds completion-proof guard without losing implementation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "写代码并保存文件，但别把 started 当 completed，proof 说清楚",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-completion-proof-implementation-42",
      },
    });

    expect(body).toContain("[System: Completion-proof guard detected.");
    expect(body).toContain("Do not treat a notice, plan, understanding, claim, or started run");
    expect(body).toContain("Treat this as explicit implementation work");
  });

  it("adds execution-authority guard for research-only trading boundaries", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "QQQ 要不要卖只能说研究判断，别把研究建议说成已经下单，research-only，我没授权你交易",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-execution-authority-42",
      },
    });

    expect(body).toContain("[System: Execution-authority guard detected.");
    expect(body).toContain("Separate research advice, code/workspace edits");
    expect(body).toContain("Research-only or unapproved actions must be labeled as not executed");
    expect(body).toContain("Treat this as a portfolio or position-management question");
  });

  it("adds execution-authority guard without losing implementation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "写代码保存文件，但不要假装已经部署到 production 或重启 live 服务",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-execution-authority-implementation-42",
      },
    });

    expect(body).toContain("[System: Execution-authority guard detected.");
    expect(body).toContain("production changes, sends, deletes, payments, deploys, or restarts");
    expect(body).toContain("Treat this as explicit implementation work");
  });

  it("adds execution-authority guard for operator-approved Lark probes without broad live authorization", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "你可以操控电脑做 Lark 真实对话测试，但这不等于授权 build/restart/deploy，接 live 仍需 proof",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-execution-authority-lark-probe-42",
      },
    });

    expect(body).toContain("[System: Execution-authority guard detected.");
    expect(body).toContain("Separate research advice, code/workspace edits, local UI operation");
    expect(body).toContain("Operator permission to control the computer");
    expect(body).toContain("does not automatically carry over to later turns");
    expect(body).toContain("or authorize build, restart, deploy");
    expect(body).toContain("[System: Capability-claim guard detected.");
  });

  it("adds execution-authority guard for per-action live permissions", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "本次授权只覆盖 Lark probe，不能继承到下一轮 deploy 或 restart；每次 live action 都要单独授权",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-execution-authority-per-action-42",
      },
    });

    expect(body).toContain("[System: Execution-authority guard detected.");
    expect(body).toContain("current-action scoped");
    expect(body).toContain("does not automatically carry over to later turns");
    expect(body).toContain("Treat risky live actions as per-action permission");
    expect(body).toContain("label it not authorized");
  });

  it("adds execution-authority and out-of-scope guards for explicit live stops", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "撤回授权，别接 live，也别再 probe，只保留 dev patch 和本地测试",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-execution-authority-live-stop-42",
      },
    });

    expect(body).toContain("[System: Execution-authority guard detected.");
    expect(body).toContain("A newer stop, pause, do-not-live, or do-not-probe instruction");
    expect(body).toContain("overrides older permission");
    expect(body).toContain("[System: Out-of-scope boundary detected.");
    expect(body).toContain("stop that lane and do not continue it from older context");
  });

  it("combines live permission, receipt, and dev-live boundary guards for control-room probes", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "你可以操控电脑做 Lark 真实对话测试，但这不等于授权 build/restart/deploy；接 live 前先定义验收短语，回执要列测试语句、同一个 chat/thread、可见回复、是否命中、dev/live 边界和下一步。",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-live-probe-combined-guard-42",
      },
    });

    expect(body).toContain("[System: Execution-authority guard detected.");
    expect(body).toContain("[System: Capability-claim guard detected.");
    expect(body).toContain("[System: Evidence-shape guard detected.");
    expect(body).toContain("[System: Result-shape guard detected.");
    expect(body).toContain("Operator permission to control the computer");
    expect(body).toContain("source patch, build, restart, live probe");
    expect(body).toContain("target chat/thread when known");
    expect(body).toContain("dev/live boundary");
  });

  it("adds source-coverage guard without losing external learning framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "去 Google 上学最近 agent 记忆怎么做，但别把看了几个来源说成完整覆盖，只留下会改你以后做法的三条",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-source-coverage-learning-42",
      },
    });

    expect(body).toContain("[System: Source-coverage guard detected.");
    expect(body).toContain(
      "Separate actual searched/read sources from intended or missing coverage",
    );
    expect(body).toContain(
      "Do not claim exhaustive, complete, all-source, or Google-wide learning",
    );
    expect(body).toContain("Treat this as learning or open-source study work");
    expect(body).toContain("sources actually searched or read");
    expect(body).toContain("retained rules that can change future work");
    expect(body).toContain("discarded noise or stale ideas");
    expect(body).toContain("replay trigger for when to reuse the lesson");
    expect(body).toContain("next eval for how to verify the lesson later");
    expect(body).toContain("next reusable behavior change");
  });

  it("adds source-coverage guard for unavailable-search learning boundaries", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "如果搜索不可用，就别说已经学完所有外部材料；去看 GitHub 和论文时标明 source coverage",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-source-coverage-unavailable-search-42",
      },
    });

    expect(body).toContain("[System: Source-coverage guard detected.");
    expect(body).toContain("unavailable search/tool limits");
    expect(body).toContain("partial-source inferences");
  });

  it.each(
    LARK_EXTERNAL_SOURCE_LANGUAGE_BATCH.map((entry) => {
      const isPaperResearch = /论文|paper|arxiv|前沿|frontier/u.test(entry.utterance);
      return {
        content: entry.utterance,
        expectedResearchNotice: isPaperResearch
          ? "[System: Treat this as method or paper research."
          : "[System: Treat this as learning or open-source study work.",
        expectedReceiptField: isPaperResearch
          ? "papers actually searched or read"
          : "sources actually searched or read",
      };
    }),
  )(
    "adds source-coverage guard for broad external source learning family: $content",
    ({ content, expectedResearchNotice, expectedReceiptField }) => {
      const body = buildFeishuAgentBody({
        ctx: {
          content,
          senderName: "Sender Name",
          senderOpenId: "ou-sender",
          messageId: "msg-source-coverage-external-learning-family-42",
        },
      });

      expect(body).toContain("[System: Source-coverage guard detected.");
      expect(body).toContain("source count/type when known");
      expect(body).toContain("partial-source inferences");
      expect(body).toContain(expectedResearchNotice);
      expect(body).toContain(expectedReceiptField);
      expect(body).toContain("source coverage limits");
      expect(body).toContain("next reusable behavior change");
      expect(body).toContain(content);
    },
  );

  it("adds durable-memory guard for recall persistence boundaries", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "记住这条规则，但别把聊天里理解说成已经进长期记忆，也别假装已经接入 recall order",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-durable-memory-42",
      },
    });

    expect(body).toContain("[System: Durable-memory guard detected.");
    expect(body).toContain("Separate ephemeral chat context, ordinary artifacts/notes");
    expect(body).toContain("Do not claim something is remembered long-term");
  });

  it("adds durable-memory guard without losing correction-loop framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "反馈：这条以后别再犯，但不要假装已经进 protected memory；没接入 recall order 就说只是 note",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-durable-memory-correction-42",
      },
    });

    expect(body).toContain("[System: Durable-memory guard detected.");
    expect(body).toContain(
      "If it is only understood in this turn or written as an unreferenced note",
    );
    expect(body).toContain("Treat this as operator correction-loop input");
  });

  it("adds classify-work guard for classify-then-act prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "先判断这句话属于哪类工作，再决定怎么干活；识别任务类型、证据状态和输出合同",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-classify-work-42",
      },
    });

    expect(body).toContain("[System: Classify-work guard detected.");
    expect(body).toContain("classify the requested work by task family");
    expect(body).toContain("target surface or role, evidence state, action boundary");
  });

  it("adds classify-work guard without losing bounded continuation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "继续提升 Lark 对话理解，但先按语义家族分类，再一次只做一个家族",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-classify-work-bounded-42",
      },
    });

    expect(body).toContain("[System: Classify-work guard detected.");
    expect(body).toContain("[System: Bounded-priority scope detected.");
    expect(body).toContain("Treat this as a bounded continuation turn");
  });

  it("adds capability-claim guard without losing search-health framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "现在 Lark 搜索能力能用吗，别把 dev-fixed 说成 live-fixed，用当前 proof 说",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-capability-claim-search-42",
      },
    });

    expect(body).toContain("[System: Capability-claim guard detected.");
    expect(body).toContain("Separate current real capability, design target");
    expect(body).toContain("Do not say a tool, provider, automation");
    expect(body).toContain("Treat this as a live search/provider health question");
  });

  it("adds capability-claim guard without losing classify-work framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "先分类这个 routing 能力现在是不是 live-fixed，没验过就标 unverified，再说下一步",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-capability-claim-classify-42",
      },
    });

    expect(body).toContain("[System: Capability-claim guard detected.");
    expect(body).toContain("[System: Classify-work guard detected.");
    expect(body).toContain("label it unverified, unavailable, or dev-only");
  });

  it("adds capability-claim guard for dev-to-live handoff prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "Lark 真实对话没问题的就接 live 跟上，没 build/restart/probe 就别说 live-fixed",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-capability-claim-live-handoff-42",
      },
    });

    expect(body).toContain("[System: Capability-claim guard detected.");
    expect(body).toContain("For dev-to-live handoff requests");
    expect(body).toContain("source patch, build, restart, live probe");
    expect(body).toContain("visible Lark/Feishu reply evidence");
  });

  it("adds capability-claim guard for live acceptance phrase prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "接 live 前先定义验收短语，没命中 acceptance phrase 就别说 live-fixed",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-capability-claim-live-acceptance-phrase-42",
      },
    });

    expect(body).toContain("[System: Capability-claim guard detected.");
    expect(body).toContain(
      "If an acceptance phrase or equivalent semantic acceptance condition is required",
    );
    expect(body).toContain("define it before judging the live probe");
    expect(body).toContain("whether the visible reply matched it");
  });

  it("adds clarification-boundary guard without losing implementation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "写代码前，如果对象和 proof 要求不清楚，先问一个窄澄清问题，别硬猜",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-clarification-boundary-implementation-42",
      },
    });

    expect(body).toContain("[System: Clarification-boundary guard detected.");
    expect(body).toContain("ask exactly one narrow clarification question before acting");
    expect(body).toContain("Do not guess a broad task");
    expect(body).toContain("Treat this as explicit implementation work");
  });

  it("adds clarification-boundary guard without losing bounded continuation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "继续，但目标和时间窗不明确时先问我一句，不要硬猜成大任务",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-clarification-boundary-continuation-42",
      },
    });

    expect(body).toContain("[System: Clarification-boundary guard detected.");
    expect(body).toContain("convert ambiguous continuation into implementation");
    expect(body).toContain("Treat this as a bounded continuation turn");
  });

  it("adds instruction-conflict guard without losing implementation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "写代码但不要改文件，这两个动作冲突时先说清楚，只执行兼容的最小下一步",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-instruction-conflict-implementation-42",
      },
    });

    expect(body).toContain("[System: Instruction-conflict guard detected.");
    expect(body).toContain("name the conflicting instructions");
    expect(body).toContain("write-but-do-not-edit");
    expect(body).toContain("Treat this as explicit implementation work");
  });

  it("adds instruction-conflict guard without losing capability framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "现在 web 搜索能力要查最新但不要联网，先指出冲突，再用 proof 区分 dev-fixed 和 live-fixed",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-instruction-conflict-capability-42",
      },
    });

    expect(body).toContain("[System: Instruction-conflict guard detected.");
    expect(body).toContain("[System: Capability-claim guard detected.");
    expect(body).toContain("latest-search-without-network");
    expect(body).toContain("Treat this as a live search/provider health question");
  });

  it("adds out-of-scope guard without losing bounded-priority framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "不要扩新分支，只做一个最小可验证 patch，并说清楚 out of scope",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-out-of-scope-bounded-42",
      },
    });

    expect(body).toContain("[System: Out-of-scope boundary detected.");
    expect(body).toContain("separate excluded work, allowed in-scope work");
    expect(body).toContain("[System: Bounded-priority scope detected.");
  });

  it("adds out-of-scope guard without losing implementation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "写代码并保存文件，但这次不做 live 验证，只做 dev prompt guard 和测试",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-out-of-scope-implementation-42",
      },
    });

    expect(body).toContain("[System: Out-of-scope boundary detected.");
    expect(body).toContain("Do not perform excluded work");
    expect(body).toContain("Treat this as explicit implementation work");
  });

  it("adds high-stakes risk guard without losing portfolio framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "QQQ 现在要不要卖，先标风险、权限边界和当前证据 freshness",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-high-stakes-risk-portfolio-42",
      },
    });

    expect(body).toContain("[System: High-stakes risk guard detected.");
    expect(body).toContain("classify the risk category, authority boundary");
    expect(body).toContain("do not execute or imply approval authority");
    expect(body).toContain("Treat this as a portfolio or position-management question");
  });

  it("adds high-stakes risk guard without losing implementation framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "写代码保存文件，但生产部署和重启是高风险动作，先说权限边界和 proof",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-high-stakes-risk-implementation-42",
      },
    });

    expect(body).toContain("[System: High-stakes risk guard detected.");
    expect(body).toContain("deployment, or production actions");
    expect(body).toContain("Treat this as explicit implementation work");
  });

  it("adds result-shape guard without losing high-stakes portfolio framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "QQQ 现在要不要卖，只给结论、风险、proof、下一步，不要长文",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-result-shape-portfolio-42",
      },
    });

    expect(body).toContain("[System: Result-shape guard detected.");
    expect(body).toContain("Preserve the requested output contract");
    expect(body).toContain("[System: High-stakes risk guard detected.");
    expect(body).toContain("Treat this as a portfolio or position-management question");
  });

  it("adds result-shape guard without losing bounded out-of-scope framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "不要扩新分支，只做一个最小 patch；先给摘要，再列 excluded / in-scope / proof",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-result-shape-bounded-42",
      },
    });

    expect(body).toContain("[System: Result-shape guard detected.");
    expect(body).toContain("ordering, brevity, table/checklist/bullets");
    expect(body).toContain("[System: Out-of-scope boundary detected.");
    expect(body).toContain("[System: Bounded-priority scope detected.");
  });

  it("adds evidence-shape guard without losing result-shape framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "只给结论和 proof，按 claim / source / status / gap 列出来，不要长文",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-evidence-shape-result-42",
      },
    });

    expect(body).toContain("[System: Evidence-shape guard detected.");
    expect(body).toContain("claim, source or receipt, verification status");
    expect(body).toContain("[System: Result-shape guard detected.");
  });

  it("adds evidence-shape guard without losing source-grounding audit framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你这句话哪来的，按 claim/source/status/gap 标 verified 或 unverified，没来源别编",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-evidence-shape-grounding-42",
      },
    });

    expect(body).toContain("[System: Evidence-shape guard detected.");
    expect(body).toContain("Do not invent citations");
    expect(body).toContain(
      "Separate verified facts, inferred claims, stale evidence, and unknowns",
    );
  });

  it("adds evidence-shape guard for live probe receipt prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "Lark 真实对话测试后给测试回执：测试语句、可见回复、通过/不通过、dev/live 边界、下一步，别只说测了",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-evidence-shape-live-probe-receipt-42",
      },
    });

    expect(body).toContain("[System: Evidence-shape guard detected.");
    expect(body).toContain("For live probe receipts");
    expect(body).toContain("tested phrase, target chat/thread when known");
    expect(body).toContain("visible reply or missing reply");
    expect(body).toContain("whether the reply matches the tested phrase, timestamp");
    expect(body).toContain("pass/fail judgment, dev/live boundary");
    expect(body).toContain("[System: Result-shape guard detected.");
  });

  it("adds evidence-shape guard for stale or wrong-thread live probe receipts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "Lark 测试回执要标同一个 chat / thread、对应回复和 message-time；别拿旧回复或错线程回复当 proof",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-evidence-shape-live-probe-thread-match-42",
      },
    });

    expect(body).toContain("[System: Evidence-shape guard detected.");
    expect(body).toContain("target chat/thread when known");
    expect(body).toContain("matches the tested phrase, timestamp");
    expect(body).toContain("[System: Failure-report guard detected.");
  });

  it("adds evidence-shape guard for acceptance phrase live receipts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "live 回执要列 acceptance phrase、是否命中、可见回复和 dev/live 边界",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-evidence-shape-live-acceptance-phrase-42",
      },
    });

    expect(body).toContain("[System: Evidence-shape guard detected.");
    expect(body).toContain("acceptance phrase or semantic acceptance condition");
    expect(body).toContain(
      "whether the reply matches the tested phrase, timestamp, and acceptance condition",
    );
    expect(body).toContain("[System: Capability-claim guard detected.");
  });

  it("adds evidence-shape guard for equivalent semantic acceptance receipts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "等价语义验收要列核心槽位、命中槽位、缺失槽位；缺了就不能 pass",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-evidence-shape-live-equivalent-semantic-42",
      },
    });

    expect(body).toContain("[System: Evidence-shape guard detected.");
    expect(body).toContain("core semantic slots required for equivalence");
    expect(body).toContain("matched slots, missing slots");
    expect(body).toContain("If required slots are missing, do not mark the probe as pass.");
  });

  it("adds failure-report guard without losing result and evidence shape framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "失败了没，只给 status / blocker / proof / next step，别装成功",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-failure-report-result-42",
      },
    });

    expect(body).toContain("[System: Failure-report guard detected.");
    expect(body).toContain("current status, blocker or failing seam");
    expect(body).toContain("[System: Result-shape guard detected.");
    expect(body).toContain("[System: Evidence-shape guard detected.");
  });

  it("adds failure-report guard without losing capability framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "现在 Lark 搜索能力是不是 degraded，别装成功，用 proof 说当前状态和 blocker",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-failure-report-capability-42",
      },
    });

    expect(body).toContain("[System: Failure-report guard detected.");
    expect(body).toContain("Do not use success wording for degraded or partial states");
    expect(body).toContain("[System: Capability-claim guard detected.");
    expect(body).toContain("Treat this as a live search/provider health question");
  });

  it("adds failure-report guard for live probes with no visible reply", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "Lark 探针发出后无回复，按 blocked / proof / next step 报，不要把 only sent 说成 pass",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-failure-report-live-probe-no-reply-42",
      },
    });

    expect(body).toContain("[System: Failure-report guard detected.");
    expect(body).toContain("missing a visible reply");
    expect(body).toContain("a sent message without a matching visible reply is not pass");
    expect(body).toContain("[System: Progress-status guard detected.");
    expect(body).toContain("Do not treat started, sent, queued");
  });

  it("adds failure-report guard for stale or wrong-thread visible replies", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "Lark 可见回复回执里如果是旧回复、错 chat、错线程或不对应测试语句，就按 blocked 报，不要说 pass",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-failure-report-live-probe-stale-reply-42",
      },
    });

    expect(body).toContain("[System: Failure-report guard detected.");
    expect(body).toContain("wrong chat, wrong thread, older timestamp");
    expect(body).toContain("non-matching tested phrase is also not pass");
    expect(body).toContain("[System: Evidence-shape guard detected.");
  });

  it("adds progress-status guard without losing completion-proof and result-shape framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "现在做到哪了，只给 done / in progress / blocked / remaining / proof / next step，别把 started 当 done",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-progress-status-result-42",
      },
    });

    expect(body).toContain("[System: Progress-status guard detected.");
    expect(body).toContain("done, in progress, blocked, not started");
    expect(body).toContain("[System: Completion-proof guard detected.");
    expect(body).toContain("[System: Result-shape guard detected.");
  });

  it("adds progress-status guard without losing failure-report framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "做到哪里了，如果 blocked 就按失败报告说 blocker、impact、proof 和 next step",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-progress-status-failure-42",
      },
    });

    expect(body).toContain("[System: Progress-status guard detected.");
    expect(body).toContain("Do not treat started, sent, queued");
    expect(body).toContain("[System: Failure-report guard detected.");
  });

  it("adds role-expansion guard for summary-first specialist detail", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "先给 control-room summary，再 expand technical 细节，不要让 specialist 抢主摘要",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-role-expansion-technical-42",
      },
    });

    expect(body).toContain("[System: Role-expansion guard detected.");
    expect(body).toContain("Keep the control-room summary first");
    expect(body).toContain("targeted detail expansions");
  });

  it("adds role-expansion guard without losing result-shape and out-of-scope framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "只给摘要和 proof；展开 ops failure detail，但不要带上 unrelated specialist lanes",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-role-expansion-scoped-42",
      },
    });

    expect(body).toContain("[System: Role-expansion guard detected.");
    expect(body).toContain("keep unrelated specialist lanes out of scope");
    expect(body).toContain("[System: Result-shape guard detected.");
    expect(body).toContain("Treat specialist roles or surfaces as targeted detail expansions");
  });

  it("adds batch-queue guard without losing bounded-priority framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "这些语义家族都做，但按优先级排队，一次只做一个，先执行 next item",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-batch-queue-bounded-42",
      },
    });

    expect(body).toContain("[System: Batch-queue guard detected.");
    expect(body).toContain("Treat multiple requested items as a queue");
    expect(body).toContain("the single current item");
    expect(body).toContain("[System: Bounded-priority scope detected.");
  });

  it("adds batch-queue guard without losing progress and result-shape framing", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "把任务队列列出来，只给 queued / done / remaining / next step，不要把 queued 说成 completed",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-batch-queue-status-42",
      },
    });

    expect(body).toContain("[System: Batch-queue guard detected.");
    expect(body).toContain("Do not mark queued work as completed");
    expect(body).toContain("[System: Progress-status guard detected.");
    expect(body).toContain("[System: Result-shape guard detected.");
  });

  it("keeps live scheduling-contract probes from being rejected as empty payload", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "先按语义家族分类这条请求：这些都做但不要并行，按优先级排队，一次只做一个；现在做到哪、还剩什么、proof 是什么，用 done / queued / next step 回答，别把 queued 说成 completed。",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-live-scheduling-contract-42",
      },
    });

    expect(body).toContain("[System: Classify-work guard detected.");
    expect(body).toContain("[System: Batch-queue guard detected.");
    expect(body).toContain("apply that contract to the current request");
    expect(body).toContain("[System: Progress-status guard detected.");
    expect(body).toContain("[System: Result-shape guard detected.");
    expect(body).toContain("[System: Completion-proof guard detected.");
  });

  it("adds a macro intent notice for plain-language index risk prompts", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "去看看几个指数最新的风险和潜在收益",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-index-risk-42",
      },
    });

    expect(body).toContain("[System: Treat this as macro and major-asset research.");
    expect(body).toContain(
      "When freshness is weak, stale, cached, or provider-limited, do not present high-specificity market figures, exact levels, exact percentages, or exact point estimates as if they were freshly verified in this turn",
    );
    expect(body).toContain("去看看几个指数最新的风险和潜在收益");
  });

  it("adds a position-management notice for buy or reduce questions", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "我现在该不该减仓 QQQ，还是继续持有？",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-position-42",
      },
    });

    expect(body).toContain(
      "[System: Treat this as a portfolio or position-management question, not as prediction theater and not as direct execution authority. Use a fixed reply structure with these sections in order when possible: 1. current stance, 2. key reasons, 3. main counter-case / risk, 4. action triggers, 5. confidence, 6. one-line summary. Use exact markdown headings when possible: ## Current Stance, ## Key Reasons, ## Main Counter-Case / Risk, ## Action Triggers, ## Confidence, ## One-Line Summary. In current stance, use one plain label only: hold, watch, reduce, do not add yet, or add only if conditions trigger. Apply sizing discipline explicitly: name any concentration risk, distinguish conviction from actual size, and default low confidence toward smaller size or wait. If macro or cross-asset context matters, explain the live driver and transmission path instead of hand-wavy market color. In action triggers, separate what would justify adding, what would justify reducing, and what means wait. Use execution hygiene too: if event risk, liquidity, or volatility makes the setup noisy, say wait explicitly. Also check for behavior-error drift: urgency theater, confirmation bias, narrative overreach, or emotional discomfort with waiting. If known events matter, map the real catalysts too: what would confirm, what would break, and what is mostly noise. Keep key reasons to the top 2-3 points. Keep confidence to low, medium, or high plus one short justification. Make the one-line summary exactly one sentence. Keep it concise, disciplined, and risk-controlled. No hype, no fake certainty, and no long rambling essay.]",
    );
    expect(body).toContain("Apply sizing discipline explicitly");
    expect(body).toContain("explain the live driver and transmission path");
    expect(body).toContain("Use execution hygiene too");
    expect(body).toContain("behavior-error drift");
    expect(body).toContain("map the real catalysts too");
    expect(body).toContain("我现在该不该减仓 QQQ，还是继续持有？");
  });

  it("treats holdings-thesis revalidation prompts as thesis revalidation instead of simple position management", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "去研究最近的美股，用你已经有的知识去分析之前的持仓分析还成立吗",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-holdings-revalidation-42",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("Start by retrieving the prior holding analysis");
    expect(body).toContain("memory/current-research-line.md when present");
    expect(body).toContain(
      "Use the right finance foundations instead of fresh market storytelling",
    );
    expect(body).toContain(
      "if the old thesis cannot be found, say that explicitly and lower confidence",
    );
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats 'old holdings thesis got punched by the market' prompts as revalidation instead of a fresh position call", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "如果之前那套持仓逻辑已经被市场打脸了，你就直接告诉我旧判断哪里失效，不要重新编一套",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-holdings-thesis-failed-42",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("Start by retrieving the prior holding analysis");
    expect(body).toContain("risk-transmission for the live driver path");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats 'old thesis still stands or not' prompts as revalidation instead of a generic overview", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "你不要给我复述旧观点，直接说以前那套 thesis 现在还站不站得住",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-42",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("Start by retrieving the prior holding analysis");
    expect(body).toContain("catalyst-map for confirm/break events");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("keeps mixed meta-learning plus urgent holdings asks on holdings-thesis revalidation", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content:
          "其他agent值得借的招先留着，以后再慢慢学；现在时间不多，先去学金融，然后帮我做持仓分析，看之前那套还站不站得住",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-holdings-priority-over-meta-learning-42",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("Start by retrieving the prior holding analysis");
    expect(body).toContain("behavior-error-correction for urgency or stubbornness");
    expect(body).not.toContain("Treat this as learning or open-source study work");
  });

  it("treats 'upstream logic now invalid?' prompts as revalidation instead of position management", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "我不是问现在买不买，我是问你上次那套逻辑现在是不是已经失效了",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-43",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("Start by retrieving the prior holding analysis");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats rough '原来拿它的理由还剩几成' prompts as revalidation instead of position management", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "别跟我说现在买卖，我问的是原来拿它的理由还剩几成",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-44",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("Start by retrieving the prior holding analysis");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats rough '那套说法已经烂掉了' prompts as revalidation instead of a fresh technical take", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "如果你上次对QQQ那套说法已经烂掉了，就标出来哪句烂了，别重写",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-45",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("what still holds");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats rough '上回那个看多的由头现在还有活口没' prompts as revalidation", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "上回那个看多的由头现在还有活口没",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-46",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("what has weakened or broken");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats rough '原先撑着继续拿的那几个点，现在死了几个' prompts as revalidation", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "别跟我聊仓位，原先撑着继续拿的那几个点，现在死了几个",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-47",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("what has weakened or broken");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats rough '继续拿着的根据，现在是不是就剩嘴硬了' prompts as revalidation", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "之前那套继续拿着的根据，现在是不是就剩嘴硬了",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-48",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("what has weakened or broken");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats rough '看多理由现在塌了没' prompts as revalidation", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "别给我行情秀，我问的是之前那份看多理由现在塌了没",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-49",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("what has weakened or broken");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("treats rough '扛着不卖那点底气还剩几口气' prompts as revalidation", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "原来扛着不卖那点底气还剩几口气",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-old-thesis-revalidation-50",
      },
    });

    expect(body).toContain("Treat this as a holdings-thesis revalidation question");
    expect(body).toContain("what has weakened or broken");
    expect(body).not.toContain("Treat this as a portfolio or position-management question");
  });

  it("adds a business-quality and catalyst-map notice for fundamental asks", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "读一下苹果最新财报，告诉我商业质量和接下来值得跟的催化剂",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-fundamental-42",
      },
    });

    expect(body).toContain(
      "Treat this as fundamental research or watchlist maintenance. Prefer current fundamental artifacts, follow-up trackers, and review memos.",
    );
    expect(body).toContain("Judge the company through business quality");
    expect(body).toContain(
      "industry structure, pricing power, capital allocation, management credibility",
    );
    expect(body).toContain("build a simple catalyst map");
  });

  it("adds an explicit Feishu surface role contract notice when routed to a named surface", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "去看看几个指数最新的风险和潜在收益",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-surface-42",
      },
      surfaceNotice:
        "[System: Feishu operating surface target = technical_daily.]\n[System: Surface role contract = technical analyst. Use this surface for ETF / major-asset / timing-discipline analysis, current anchors, structural narrative, and pricing-gap framing.]\n[System: Configured target chat for this surface = oc-tech-daily.]",
    });

    expect(body).toContain("[System: Feishu operating surface target = technical_daily.]");
    expect(body).toContain("[System: Surface role contract = technical analyst.");
    expect(body).toContain("[System: Configured target chat for this surface = oc-tech-daily.]");
  });

  it("adds control-room orchestration guidance for aggregate front-end summaries", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "今天该关注什么，给我一个总览",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-control-room-42",
      },
      surfaceNotice:
        "[System: Feishu operating surface target = control_room.]\n[System: Surface role contract = orchestrator. Use this surface for orchestration, resets, routing decisions, and explicit control-plane coordination.]\n[System: Configured target chat for this surface = oc-control-room.]\n[System: Control-room orchestration mode is active.]\n[System: Internally fan this request out to the relevant specialist surfaces: technical_daily, fundamental_research, ops_audit.]\n[System: Return one clear control-room summary first. Keep it simple for a non-technical user: what matters, what to watch, and what action or next step is most sensible.]\n[System: Specialist detail is optional. Do not tell the user to manually message other groups. If a deeper dive would help, mention the follow-up pattern: expand technical / expand fundamental / expand ops / expand knowledge.]",
    });

    expect(body).toContain("[System: Feishu operating surface target = control_room.]");
    expect(body).toContain("[System: Control-room orchestration mode is active.]");
    expect(body).toContain("Internally fan this request out to the relevant specialist surfaces");
    expect(body).toContain("Return one clear control-room summary first");
    expect(body).toContain("expand technical / expand fundamental / expand ops / expand knowledge");
  });
});

describe("classified publish routing", () => {
  it("publishes classified specialist slices to explicit Feishu surfaces and keeps a summary in control room", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
今天先看风险框架，不追高。

## Technical Slice
publish: yes
confidence: high
QQQ / SPY / TLT 先看谁对长端利率更敏感。

## Fundamental Slice
publish: no
confidence: low
科技财报还缺新鲜交叉验证，先保留草稿。
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-lane-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            technical_daily: { chatId: "oc-tech" },
            fundamental_research: { chatId: "oc-fund" },
            knowledge_maintenance: { chatId: "oc-knowledge" },
            ops_audit: { chatId: "oc-ops" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-control-classified",
        chat_id: "oc-control-room",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "今天该关注什么，给我一个总览" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "今天先看风险框架，不追高。\n\nDistribution: published technical slice; held as draft fundamental slice.",
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-tech",
        text: "Technical Slice\nQQQ / SPY / TLT 先看谁对长端利率更敏感。",
      }),
    );
    expect(mockSendMessageFeishu).not.toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-fund",
      }),
    );
  });

  it("records partial-delivery anomaly when classified secondary publish fails", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockSendMessageFeishu.mockRejectedValueOnce(new Error("secondary publish down"));

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
主回复仍然应该落在 control room。

## Technical Slice
publish: yes
confidence: high
这条要发布到技术面 lane：先看长端利率、美元、信用利差和 QQQ 相对 SPY 的风险偏好确认，再判断是否只是短线反弹。
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-classified-fail-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            technical_daily: { chatId: "oc-tech" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-classified-publish-fail",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "总览后发布技术面" }),
        },
      },
    });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "主回复仍然应该落在 control room。\n\nDistribution: published technical slice.",
    });
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.classified_publish",
        problem: "failed to publish feishu secondary surface message",
        evidence: expect.arrayContaining([
          "target=chat:oc-tech",
          "label=Technical Slice",
          "error=Error: secondary publish down",
        ]),
      }),
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("skips control-room ledger writes when no final reply text was captured", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }));
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-control-room-no-final-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            technical_daily: { chatId: "oc-tech" },
            fundamental_research: { chatId: "oc-fund" },
            knowledge_maintenance: { chatId: "oc-knowledge" },
            ops_audit: { chatId: "oc-ops" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-no-final",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "今天该关注什么，给我一个总览" }),
        },
      },
    });

    await expect(
      fs.readFile(
        path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-control-room.md"),
        "utf-8",
      ),
    ).rejects.toThrow();
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.surface_memory",
        problem: "skipped feishu surface line persist because no final reply text was captured",
        evidence: expect.arrayContaining([
          "failure_stage=final_reply_capture",
          "final_reply_captured=false",
          "dispatch_queued_final=false",
          "dispatch_final_count=0",
        ]),
      }),
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("captures real Lark turns into a pending language-routing corpus artifact", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: "去学习世界顶级大学前沿金融论文",
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-language-capture-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            technical_daily: { chatId: "oc-tech" },
            fundamental_research: { chatId: "oc-fund" },
            knowledge_maintenance: { chatId: "oc-knowledge" },
            ops_audit: { chatId: "oc-ops" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-language-capture",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "把这个真实回复沉淀成待审语言样本" }),
        },
      },
    });

    const candidateRoot = path.join(tempDir, "memory", "lark-language-routing-candidates");
    const [dateDir] = await fs.readdir(candidateRoot);
    const artifactText = await fs.readFile(
      path.join(candidateRoot, dateDir, "msg-language-capture.json"),
      "utf-8",
    );
    const artifact = JSON.parse(artifactText) as {
      boundary: string;
      noFinanceLearningArtifact: boolean;
      candidates: Array<{ source: string; boundary: string }>;
      evaluation: {
        counts: { total: number; accepted: number };
        acceptedCases: Array<{ family: string; expectedSurface: string }>;
      };
    };

    expect(artifact).toMatchObject({
      boundary: "language_routing_only",
      noFinanceLearningArtifact: true,
      candidates: expect.arrayContaining([
        expect.objectContaining({
          source: "api_reply",
          boundary: "language_routing_only",
        }),
        expect.objectContaining({
          source: "lark_user_utterance",
          boundary: "language_routing_only",
        }),
        expect.objectContaining({
          source: "lark_visible_reply",
          boundary: "language_routing_only",
        }),
      ]),
      evaluation: expect.objectContaining({
        counts: expect.objectContaining({ total: 3, accepted: 1 }),
        acceptedCases: [
          expect.objectContaining({
            family: "external_source_coverage_honesty",
            expectedSurface: "learning_command",
          }),
        ],
      }),
    });
    expect(artifactText).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );

    const handoffRoot = path.join(tempDir, "memory", "lark-language-handoff-receipts");
    const [handoffDateDir] = await fs.readdir(handoffRoot);
    const handoffText = await fs.readFile(
      path.join(handoffRoot, handoffDateDir, "msg-language-capture.json"),
      "utf-8",
    );
    const handoff = JSON.parse(handoffText) as {
      boundary: string;
      noFinanceLearningArtifact: boolean;
      noExecutionApproval: boolean;
      noLiveProbeProof: boolean;
      userMessage: string;
      handoff: {
        family: string;
        source: string;
        expectedProof: string[];
        missingBeforeExecution: string[];
      };
    };
    expect(handoff).toMatchObject({
      boundary: "language_handoff_only",
      noFinanceLearningArtifact: true,
      noExecutionApproval: true,
      noLiveProbeProof: true,
      userMessage: "把这个真实回复沉淀成待审语言样本",
      handoff: expect.objectContaining({
        expectedProof: expect.any(Array),
        missingBeforeExecution: expect.any(Array),
      }),
    });
    expect(handoffText).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );

    await expect(
      fs.access(path.join(tempDir, "memory", "local-memory", "msg-language-capture.json")),
    ).rejects.toThrow();

    const reviewText = await fs.readFile(
      path.join(tempDir, "memory", "lark-language-routing-reviews", `${dateDir}.json`),
      "utf-8",
    );
    const review = JSON.parse(reviewText) as {
      boundary: string;
      counts: { sourceArtifacts: number; acceptedCases: number; promotedCases: number };
      corpusPatch: string;
    };
    expect(review).toMatchObject({
      boundary: "language_routing_only",
      counts: expect.objectContaining({
        sourceArtifacts: 1,
        acceptedCases: 1,
      }),
    });
    expect(review.corpusPatch).toContain("language-routing");
    expect(reviewText).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes Lark handoff receipts into the routed non-default agent workspace", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(async () => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    }));
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    mockResolveAgentRoute.mockReturnValue({
      agentId: "research-minimax",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:research-minimax:feishu:dm:ou-user",
      mainSessionKey: "agent:research-minimax:main",
      matchedBy: "configured",
    });

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const mainWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-main-"));
    const routedWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-routed-"));
    const cfg: ClawdbotConfig = {
      agents: {
        defaults: { workspace: mainWorkspace },
        list: [
          { id: "main", default: true, workspace: mainWorkspace },
          { id: "research-minimax", workspace: routedWorkspace },
        ],
      },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-routed-language-handoff",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "去学习一套本地安全的 ETF 因子择时材料" }),
        },
      },
    });

    const routedReceiptPath = path.join(
      routedWorkspace,
      "memory",
      "lark-language-handoff-receipts",
    );
    const [dateDir] = await fs.readdir(routedReceiptPath);
    const receiptText = await fs.readFile(
      path.join(routedReceiptPath, dateDir, "msg-routed-language-handoff.json"),
      "utf-8",
    );
    expect(JSON.parse(receiptText)).toMatchObject({
      boundary: "language_handoff_only",
      agentId: "research-minimax",
      sessionKey: "agent:research-minimax:feishu:dm:ou-user:surface:learning_command",
      userMessage: "去学习一套本地安全的 ETF 因子择时材料",
    });
    await expect(
      fs.access(
        path.join(
          mainWorkspace,
          "memory",
          "lark-language-handoff-receipts",
          dateDir,
          "msg-routed-language-handoff.json",
        ),
      ),
    ).rejects.toThrow();

    await fs.rm(mainWorkspace, { recursive: true, force: true });
    await fs.rm(routedWorkspace, { recursive: true, force: true });
  });

  it("writes a repair-minded work receipt for natural complaint corrections", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: "先承认刚才答偏了；现在先给动作和范围，再给修正版。",
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-work-repair-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-repair" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-repair-receipt",
          chat_id: "oc-control-room-repair",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "你刚才那段还是词不达意。我让你先说动作和范围，不是直接重写长文。",
          }),
        },
      },
    });

    const receiptFiles = await fs.readdir(path.join(tempDir, "memory", "feishu-work-receipts"));
    expect(
      receiptFiles.some((name) => name.includes("control_room-msg-control-repair-receipt")),
    ).toBe(true);
    const repairReceipt = await fs.readFile(
      path.join(
        tempDir,
        "memory",
        "feishu-work-receipts",
        receiptFiles.find((name) => name.includes("control_room-msg-control-repair-receipt"))!,
      ),
      "utf-8",
    );
    expect(repairReceipt).toContain("- **Requested Action**: repair_previous_answer");
    expect(repairReceipt).toContain("- **Scope**: answer_repair");
    expect(repairReceipt).toContain("- **Output Shape**: correction_note");
    expect(repairReceipt).toContain("- **Repair Disposition**: correction_loop");
    const repairQueue = await fs.readFile(
      path.join(tempDir, "memory", "feishu-work-receipts", "repair-queue.md"),
      "utf-8",
    );
    expect(repairQueue).toContain("# Feishu Work Repair Queue");
    expect(repairQueue).toContain("language precision drift");
    expect(repairQueue).toContain("repair_previous_answer / answer_repair / correction_note");
    expect(repairQueue).toContain(
      "Narrow on requested action, scope, timeframe, and output shape before rewriting the substance.",
    );
    const receiptIndex = await fs.readFile(
      path.join(tempDir, "memory", "feishu-work-receipts", "index.md"),
      "utf-8",
    );
    expect(receiptIndex).toContain("repair_previous_answer");
    expect(receiptIndex).toContain("answer_repair");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the surface ledger when structured work receipt persistence fails", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: "主回复已经发出，surface ledger 应该保留，work receipt 失败要单独报。",
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-work-receipt-fail-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "memory", "feishu-work-receipts"), "not a directory");
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-receipt-fail" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-work-receipt-fail",
          chat_id: "oc-control-room-receipt-fail",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "记录这次但 work receipt 路径坏了也别假成功" }),
        },
      },
    });

    const controlLedger = await fs.readFile(
      path.join(
        tempDir,
        "memory",
        "feishu-surface-lines",
        "control_room-oc-control-room-receipt-fail.md",
      ),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("work receipt 失败要单独报");
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.work_receipts",
        problem: "failed to persist feishu work receipt artifacts",
        evidence: expect.arrayContaining([
          "failure_stage=work_receipt",
          "surface=control_room",
          "chat_id=oc-control-room-receipt-fail",
          "message_id=msg-work-receipt-fail",
        ]),
      }),
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes retained finance-doctrine proof into a holdings-thesis revalidation work receipt", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: [
            "Base case: 旧 thesis 还剩核心需求逻辑，但仓位前提要比以前更保守。",
            "Bear case: 如果行业传导继续恶化，原先的盈利韧性假设会明显失真。",
            "What changes my mind: 新一轮订单、资本开支和价格传导如果同步转弱，我会下调剩余 thesis。",
            "Why no action may be better: 现在证据还不够支持加仓，先不强行动作比假装高确定性更稳。",
            "Next-step judgment: 先跟踪下一组验证数据，再决定是继续持有还是降权。",
          ].join("\n"),
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-doctrine-proof-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-doctrine" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-doctrine-proof",
          chat_id: "oc-control-room-doctrine",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "你不要给我复述旧观点，直接说以前那套 thesis 现在还站不站得住",
          }),
        },
      },
    });

    const receiptFiles = await fs.readdir(path.join(tempDir, "memory", "feishu-work-receipts"));
    const receiptFile = receiptFiles.find((name) =>
      name.includes("control_room-msg-control-doctrine-proof"),
    );
    expect(receiptFile).toBeDefined();
    const receipt = await fs.readFile(
      path.join(tempDir, "memory", "feishu-work-receipts", receiptFile!),
      "utf-8",
    );
    expect(receipt).toContain("## Finance Doctrine Proof");
    expect(receipt).toContain("- Consumer: holdings_thesis_revalidation");
    expect(receipt).toContain(
      "- Doctrine Fields Used: base_case, bear_case, what_changes_my_mind, why_no_action_may_be_better",
    );
    const parsedReceipt = parseFeishuWorkReceiptArtifact(receipt);
    expect(parsedReceipt?.financeDoctrineProof).toEqual({
      consumer: "holdings_thesis_revalidation",
      doctrineFieldsUsed: [
        "base_case",
        "bear_case",
        "what_changes_my_mind",
        "why_no_action_may_be_better",
      ],
      outputEvidenceLines: [
        "Base case: 旧 thesis 还剩核心需求逻辑，但仓位前提要比以前更保守。",
        "Bear case: 如果行业传导继续恶化，原先的盈利韧性假设会明显失真。",
        "What changes my mind: 新一轮订单、资本开支和价格传导如果同步转弱，我会下调剩余 thesis。",
        "Why no action may be better: 现在证据还不够支持加仓，先不强行动作比假装高确定性更稳。",
      ],
      proves:
        "the captured control-room finance reply explicitly exposed the doctrine-labeled fields in the final output",
      doesNotProve:
        "the scenario framing is correct, calibrated, or economically superior; it only proves those fields appeared in the retained reply text",
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes a linked finance doctrine calibration artifact from a later holdings revalidation reply", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const replies = [
      [
        "Base case: 旧 thesis 还剩核心需求逻辑，但仓位前提要比以前更保守。",
        "Bear case: 如果行业传导继续恶化，原先的盈利韧性假设会明显失真。",
        "What changes my mind: 新一轮订单、资本开支和价格传导如果同步转弱，我会下调剩余 thesis。",
        "Why no action may be better: 现在证据还不够支持加仓，先不强行动作比假装高确定性更稳。",
      ].join("\n"),
      [
        "Base case: 现在剩下的是慢修复，不是强反转。",
        "Bear case: 如果验证数据继续转弱，旧 thesis 就只剩残值。",
        "What changes my mind: 下一轮订单和利润率如果一起转弱，我会进一步下调判断。",
        "Why no action may be better: 还没有足够证据支持加仓，继续等比乱动更好。",
        "Observed outcome: 到目前为止更像弱修复而不是强兑现，结果离原来的 base case 更近但明显更保守。",
        "Closest scenario: base_case",
        "Change-my-mind triggered: no",
        "Conviction looked: too_high",
      ].join("\n"),
    ];
    let replyIndex = 0;
    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({ text: replies[replyIndex] });
        replyIndex += 1;
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-doctrine-cal-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-calibration" },
          },
        },
      },
    } as ClawdbotConfig;

    const ask = "你不要给我复述旧观点，直接说以前那套 thesis 现在还站不站得住";

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-doctrine-calibration-1",
          chat_id: "oc-control-room-calibration",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: ask }),
        },
      },
    });

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-doctrine-calibration-2",
          chat_id: "oc-control-room-calibration",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: ask }),
        },
      },
    });

    const receiptDir = path.join(tempDir, "memory", "feishu-work-receipts");
    const receiptFiles = await fs.readdir(receiptDir);
    const calibrationFile = receiptFiles.find((name) =>
      isFeishuFinanceDoctrineCalibrationFilename(name),
    );
    expect(calibrationFile).toBeDefined();
    const calibrationContent = await fs.readFile(path.join(receiptDir, calibrationFile!), "utf-8");
    const parsedCalibration = parseFeishuFinanceDoctrineCalibrationArtifact(calibrationContent);
    expect(parsedCalibration).toEqual({
      reviewDate: expect.any(String),
      consumer: "holdings_thesis_revalidation",
      linkedReceipt: expect.stringContaining("memory/feishu-work-receipts/"),
      observedOutcome:
        "到目前为止更像弱修复而不是强兑现，结果离原来的 base case 更近但明显更保守。",
      scenarioClosestToOutcome: "base_case",
      baseCaseDirectionallyCloser: "yes",
      changeMyMindTriggered: "no",
      convictionLooksTooHighOrLow: "too_high",
      notes: expect.stringContaining("derived from later holdings_thesis_revalidation reply"),
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("promotes broad adoption distillation into the next priority self-repair queue", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    mockRunFeishuLearningCouncil.mockImplementation(
      async (params: { workspaceDir: string; messageId: string; userMessage: string }) => {
        const artifactPath = path.join(
          params.workspaceDir,
          buildLearningCouncilArtifactJsonRelativePath(params.messageId),
        );
        await fs.mkdir(path.dirname(artifactPath), { recursive: true });
        await fs.writeFile(
          artifactPath,
          renderLearningCouncilRuntimeArtifact({
            version: 2,
            generatedAt: "2026-04-12T09:30:00.000Z",
            messageId: params.messageId,
            userMessage: params.userMessage,
            status: "completed",
            mutableFactWarnings: [],
            roles: [],
            runPacket: {
              objective: "study adoption-worthy Hermes and GitHub CLI ideas for Lobster",
              protectedAnchorsPresent: ["memory/current-research-line.md", "MEMORY.md"],
              protectedAnchorsMissing: [],
              currentFocus: "finance_mainline_with_bounded_agent_adoption",
              topDecision: "keep adoption work bounded to Lobster self-repair seams",
              recallOrder:
                "memory/current-research-line.md -> MEMORY.md -> latest carryover cue -> matching local memory cards",
              latestCarryoverSource: "memory/2026-04-12-lobster-workface.md",
              localMemoryCardPaths: [
                "memory/local-memory/workflow-protected-summary-first-recall-order.md",
              ],
              keepLines: ["bounded adoption study beats agent-ecosystem recap"],
              discardLines: ["do not migrate the whole Lobster brain into another agent shell"],
              lobsterImprovementLines: [
                "promote Hermes context-file adoption checks into the repair queue before broad tool study",
                "add one local install-and-doctor workflow card before repeating GitHub CLI setup learning",
              ],
              currentBracketLines: ["bounded adoption study, not a migration rewrite"],
              ruledOutLines: ["full Hermes migration is out of scope"],
              highestInfoNextCheckLines: [
                "verify one install/setup lesson becomes a repair queue item",
              ],
              replayTriggerLines: ["when another agent/framework install topic comes up"],
              nextEvalCueLines: ["next queue should name one self-repair target"],
              recoveryReadOrder: [
                "memory/current-research-line.md",
                "MEMORY.md",
                "memory/feishu-work-receipts/repair-queue.md",
              ],
            },
            finalReply:
              "## Lobster improvement feedback\n- promote Hermes context-file adoption checks into the repair queue before broad tool study",
          }),
          "utf-8",
        );
        return "Learning council run: adoption distillation completed.";
      },
    );

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-adoption-repair-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning-adoption" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-adoption-repair",
          chat_id: "oc-learning-adoption",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "去 github 上看 Hermes-agent 的安装、context files 和 memory providers，学那些真值得你接进自己的。",
          }),
        },
      },
    });

    const repairQueue = await fs.readFile(
      path.join(tempDir, "memory", "feishu-work-receipts", "repair-queue.md"),
      "utf-8",
    );
    expect(repairQueue).toContain("## Next Priority Self-Repair");
    expect(repairQueue).toContain("adoption distillation");
    expect(repairQueue).toContain("Lobster improvement cue");
    expect(repairQueue).toContain(
      "promote Hermes context-file adoption checks into the repair queue before broad tool study",
    );
    expect(repairQueue).toContain("start_or_continue_learning / learning_command / plain_answer");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("appends the latest workface summary to daily briefs and publishes the full panel to watchtower", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-workface-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", buildLobsterWorkfaceFilename("2026-03-26")),
      renderLobsterWorkfaceArtifact({
        targetDateKey: "2026-03-26",
        sessionKey: "agent:main:main",
        learningItems: 3,
        correctionNotes: 1,
        watchtowerSignals: 2,
        codexEscalations: 0,
        activeSurfaceLanes: 2,
        portfolioScorecard: "3.6 / 5.0",
        totalTokens: "12,345",
        estimatedCost: "$1.2345",
        dashboardSnapshotLines: ["- Learning Flow: ███ 3 items"],
        validationRadarLines: [
          "- Strongest Domain: bounded repair planning: factual 4.0/5, reasoning 4.0/5 (1 note)",
          "- Weakest Domain: position management: factual 3.0/5, reasoning 2.0/5 (1 note)",
          "- Hallucination Watch: position management: 1 risky validation note",
        ],
        feishuLanePanelLines: [
          "- Active Lanes: 2",
          "- learning_command / oc-main: 2 turns · session agent:main:feishu:dm:oc-main:surface:learning_command · updated 2026-03-26T14:00:00.000Z",
          "- fundamental_research / oc-main: 1 turn · session agent:main:feishu:dm:oc-main:surface:fundamental_research · updated 2026-03-26T13:45:00.000Z",
        ],
        sevenDayOperatingViewLines: ["- Learning Items (7d): 3"],
        yesterdayLearnedLines: [
          "- review / risk-transmission: trace the live driver first.",
          "",
          "### Learning Council Runs",
          "- full: 去github上学习开源的值得你学的，并把值得内化的内化",
          "- keep: keep a small set of reusable rules instead of broad ecosystem summaries.",
          "- discard: discard generic 'best practices' that do not survive into one concrete rule.",
          "- improve lobster: tighten the first-pass task bracket before broad agent-orchestration synthesis.",
          "- replay: replay the durable rule when another agent-orchestration writeup starts drifting into list-only architecture commentary.",
          "- next eval: next time check whether the draft names one concrete failure mode before keeping the lesson.",
        ],
        yesterdayCorrectedLines: ["- No correction note was captured yesterday."],
        yesterdayWatchtowerLines: ["- No watchtower anomaly was recorded yesterday."],
        codexEscalationLines: ["- No Codex escalation packet was recorded yesterday."],
        portfolioAnswerScorecardLines: ["- latest: 2026-W13-portfolio-answer-scorecard.md"],
        tokenDashboardLeadLine: "- Yesterday total: 12,345 tokens / $1.2345",
        tokenDashboardModelLines: [
          "",
          "### By Model",
          "- No model usage rows were recorded yesterday.",
        ],
        tokenTrendLines: ["- 2026-03-26: ███ 12,345"],
        readingGuideLines: ["- Use this artifact to supervise daily usefulness."],
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(
        tempDir,
        "memory",
        buildOperatingWeeklyArtifactFilename("2026-W13", "portfolio-answer-scorecard"),
      ),
      renderPortfolioAnswerScorecardArtifact({
        weekKey: "2026-W13",
        rangeLabel: "2026-03-23 to 2026-03-29",
        sessionKey: "agent:main:main",
        signalsReviewed: 3,
        averageScore: "3.6 / 5.0",
        dimensionScoreLines: [
          "- Wait Discipline: 3/5 (1 recent signal) - focus: say wait earlier.",
        ],
        mainFailureModeLines: [
          "- Wait Discipline: 1 recent signal pushed this below a clean answer standard.",
        ],
        nextUpgradeFocusLines: [
          "- do-now: improve wait discipline before trying to sound smarter elsewhere.",
          "- use this scorecard to judge whether Lobster is answering like a portfolio assistant or hiding behind market commentary.",
        ],
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(tempDir, "memory", buildKnowledgeValidationWeeklyArtifactFilename("2026-W13")),
      renderKnowledgeValidationWeeklyArtifact({
        weekKey: "2026-W13",
        rangeLabel: "2026-03-23 to 2026-03-29",
        sessionKey: "agent:main:main",
        validationNotes: 2,
        benchmarkNotes: 1,
        dailyRealTaskNotes: 1,
        benchmarkCoverageLines: ["- financebench_style_qa: 1 note"],
        dailyRealTaskCoverageLines: ["- position_management: 1 note"],
        capabilityCoverageLines: ["- finance: 2 notes"],
        strongestDomainLines: [
          "- bounded repair planning: factual 4.0/5, reasoning 4.0/5 (1 note)",
        ],
        weakestDomainLines: ["- position management: factual 3.0/5, reasoning 2.0/5 (1 note)"],
        hallucinationProneLines: ["- position management: 1 risky validation note"],
        correctionCandidateLines: ["- tighten source-grounded quote discipline"],
        repairTicketCandidateLines: ["- patch position-answer confidence discipline only"],
        nextValidationFocusLines: [
          "- Keep benchmark validation running so reasoning quality does not outrun factual quality.",
        ],
      }),
      "utf-8",
    );

    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-brief-1",
      deadlineAt: "2026-03-26T18:00:00.000Z",
      receiptsPath: "memory/feishu-learning-timeboxes/timebox-running-brief-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
今天主看风险预算、财报跟进和系统健康。

## Technical Slice
publish: yes
confidence: high
先看利率与风险偏好的共振。
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-workface" },
            technical_daily: { chatId: "oc-tech-workface" },
            watchtower: { chatId: "oc-watchtower-workface" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-control-daily-brief",
        chat_id: "oc-control-room-workface",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "给我今天的健康卓越日报" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("今天主看风险预算、财报跟进和系统健康。"),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Distribution: suppressed low-signal technical slice."),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Workface (2026-03-26): learned 3, corrected 1, watchtower 2, retained keep a small set of reusable rules instead of broad ecosystem summaries., discarded discard generic 'best practices' that do not survive into one concrete rule., replay replay the durable rule when another agent-orchestration writeup starts drifting into list-only architecture commentary., next eval next time check whether the draft names one concrete failure mode before keeping the lesson., scorecard 3.6 / 5.0, weakest position management: factual 3.0/5, reasoning 2.0/5 (1 note), hallucination watch position management: 1 risky validation note, lane panel 2 active lanes, meter learning_command / oc-main: 2 turns; fundamental_research / oc-main: 1 turn, tokens 12,345, estimated cost $1.2345.",
        ),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Improvement pulse: learned 3; corrected 1; keep keep a small set of reusable rules instead of broad ecosystem summaries; discard discard generic 'best practices' that do not survive into one concrete rule; improve lobster tighten the first-pass task bracket before broad agent-orchestration synthesis; replay replay the durable rule when another agent-orchestration writeup starts drifting into list-only architecture commentary; next eval next time check whether the draft names one concrete failure mode before keeping the lesson.",
        ),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Portfolio scorecard (2026-W13): average 3.6 / 5.0, focus wait discipline before trying to sound smarter elsewhere.",
        ),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Validation radar: strongest bounded repair planning: factual 4.0/5, reasoning 4.0/5 (1 note); weakest position management: factual 3.0/5, reasoning 2.0/5 (1 note); hallucination watch position management: 1 risky validation note.",
        ),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Learning loop: active session timebox-running-brief-1, chat oc-control-room-workface, deadline 2026-03-26T18:00:00.000Z.",
        ),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "最近落账: 2026-03-26-lobster-workface.md 已记录 retain / discard / replay / next eval。",
        ),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Protected anchors: present none; missing memory/current-research-line.md, memory/unified-risk-view.md, MEMORY.md.",
        ),
      }),
    );
    expect(mockSendMessageFeishu).not.toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-tech-workface",
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-watchtower-workface",
        text: expect.stringContaining("Lobster Workface: 2026-03-26"),
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-watchtower-workface",
        text: expect.stringContaining("Portfolio Answer Scorecard: 2026-W13"),
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-watchtower-workface",
        text: expect.stringContaining("Knowledge Validation Weekly: 2026-W13"),
      }),
    );

    const controlLedger = await fs.readFile(
      path.join(
        tempDir,
        "memory",
        "feishu-surface-lines",
        "control_room-oc-control-room-workface.md",
      ),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("Numeric market claims require an explicit data timestamp.");
    expect(controlLedger).toContain("Learning loop:");
    expect(controlLedger).toContain("timebox-running-brief-1");
    const receiptFiles = await fs.readdir(path.join(tempDir, "memory", "feishu-work-receipts"));
    expect(receiptFiles.some((name) => name.includes("control_room-msg-control-daily-brief"))).toBe(
      true,
    );
    const dailyBriefReceipt = await fs.readFile(
      path.join(
        tempDir,
        "memory",
        "feishu-work-receipts",
        receiptFiles.find((name) => name.includes("control_room-msg-control-daily-brief"))!,
      ),
      "utf-8",
    );
    expect(dailyBriefReceipt).toContain("- **Requested Action**: summarize_system_state");
    expect(dailyBriefReceipt).toContain("- **Scope**: control_room_daily_brief");
    expect(dailyBriefReceipt).toContain("- **Output Shape**: daily_brief");
    const receiptIndex = await fs.readFile(
      path.join(tempDir, "memory", "feishu-work-receipts", "index.md"),
      "utf-8",
    );
    expect(receiptIndex).toContain("# Feishu Work Receipt Index");
    expect(receiptIndex).toContain("summarize_system_state");
    expect(receiptIndex).toContain("control_room_daily_brief");
    const repairQueue = await fs.readFile(
      path.join(tempDir, "memory", "feishu-work-receipts", "repair-queue.md"),
      "utf-8",
    );
    expect(repairQueue).toContain("# Feishu Work Repair Queue");
    expect(repairQueue).toContain("No repair-minded work receipts are queued right now.");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records partial-delivery anomaly when daily workface watchtower publish fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workface-publish-fail-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", buildLobsterWorkfaceFilename("2026-03-27")),
      renderLobsterWorkfaceArtifact({
        targetDateKey: "2026-03-27",
        sessionKey: "agent:main:main",
        learningItems: 1,
        correctionNotes: 0,
        watchtowerSignals: 0,
        codexEscalations: 0,
        totalTokens: "1,111",
        estimatedCost: "$0.1111",
        dashboardSnapshotLines: ["- Learning Flow: █ 1 item"],
        validationRadarLines: ["- No weekly validation radar is available yet."],
        feishuLanePanelLines: ["- No active Feishu surface lanes are recorded yet."],
        sevenDayOperatingViewLines: ["- Learning Items (7d): 1"],
        yesterdayLearnedLines: [
          "- keep: preserve partial-delivery receipts for secondary publishes.",
          "- discard: discard fake all-green publish summaries.",
          "- replay: replay this when watchtower publish fails behind a primary reply.",
          "- next eval: next run should show a partial-delivery anomaly.",
        ],
        yesterdayCorrectedLines: ["- No correction note was captured yesterday."],
        yesterdayWatchtowerLines: ["- No watchtower anomaly was recorded yesterday."],
        codexEscalationLines: ["- No Codex escalation packet was recorded yesterday."],
        portfolioAnswerScorecardLines: ["- No portfolio-answer scorecard is available yet."],
        tokenDashboardLeadLine: "- Yesterday total: 1,111 tokens / $0.1111",
        tokenDashboardModelLines: [
          "",
          "### By Model",
          "- No model usage rows were recorded yesterday.",
        ],
        tokenTrendLines: ["- 2026-03-27: █ 1,111"],
        readingGuideLines: ["- Use this artifact to supervise daily usefulness."],
      }),
      "utf-8",
    );

    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockSendMessageFeishu.mockRejectedValueOnce(new Error("watchtower down"));

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({ text: "## Control Summary\n今天先看 publish 降级路径。" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-workface-fail" },
            watchtower: { chatId: "oc-watchtower-workface-fail" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-daily-brief-publish-fail",
          chat_id: "oc-control-room-workface-fail",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "给我今天的健康卓越日报" }),
        },
      },
    });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("今天先看 publish 降级路径。"),
      }),
    );
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.daily_workface_publish",
        problem: "failed to publish feishu secondary surface message",
        evidence: expect.arrayContaining([
          "target=chat:oc-watchtower-workface-fail",
          `label=${buildLobsterWorkfaceFilename("2026-03-27")}`,
          "error=Error: watchtower down",
        ]),
      }),
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not overstate an improvement pulse when the latest workface has no concrete new delta", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-workface-flat-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", buildLobsterWorkfaceFilename("2026-03-27")),
      renderLobsterWorkfaceArtifact({
        targetDateKey: "2026-03-27",
        sessionKey: "agent:main:main",
        learningItems: 0,
        correctionNotes: 0,
        watchtowerSignals: 0,
        codexEscalations: 0,
        activeSurfaceLanes: 0,
        totalTokens: "1,234",
        estimatedCost: "$0.1234",
        dashboardSnapshotLines: ["- Learning Flow: no concrete new items yesterday."],
        validationRadarLines: ["- No validation radar note was captured yesterday."],
        feishuLanePanelLines: ["- No active Feishu surface lanes are recorded yet."],
        sevenDayOperatingViewLines: ["- Learning Items (7d): 0"],
        yesterdayLearnedLines: [
          "- No concrete keep/discard/replay/eval cue was captured yesterday.",
        ],
        yesterdayCorrectedLines: ["- No correction note was captured yesterday."],
        yesterdayWatchtowerLines: ["- No watchtower anomaly was recorded yesterday."],
        codexEscalationLines: ["- No Codex escalation packet was recorded yesterday."],
        portfolioAnswerScorecardLines: ["- No portfolio scorecard was recorded yesterday."],
        tokenDashboardLeadLine: "- Yesterday total: 1,234 tokens / $0.1234",
        tokenDashboardModelLines: ["- No model usage rows were recorded yesterday."],
        tokenTrendLines: ["- 2026-03-27: ▏ 1,234"],
        readingGuideLines: ["- Use this artifact to supervise daily usefulness."],
      }),
      "utf-8",
    );

    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue(undefined);
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue(undefined);

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
今天先看还有哪些地方没有形成新学习闭环。
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-flat-workface" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-control-flat-brief",
        chat_id: "oc-control-room-flat-workface",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "给我今天的健康卓越日报" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("今天先看还有哪些地方没有形成新学习闭环。"),
      }),
    );
    expect(baseDispatcher.sendFinalReply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Improvement pulse:"),
      }),
    );

    const controlLedger = await fs.readFile(
      path.join(
        tempDir,
        "memory",
        "feishu-surface-lines",
        "control_room-oc-control-room-flat-workface.md",
      ),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).not.toContain("Improvement pulse:");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the learning-loop summary visible in daily briefs even when no workface artifacts exist", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-workface-empty-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });

    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue(undefined);
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue(undefined);

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
今天先看有没有明显故障和该补的空白。
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-empty" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-daily-brief-empty",
          chat_id: "oc-control-room-empty",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "给我今天的健康卓越日报" }),
        },
      },
    });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("今天先看有没有明显故障和该补的空白。"),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Learning loop: no active timebox in oc-control-room-empty."),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("最近落账: 还没找到最新 lobster-workface 学习包。"),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Protected anchors: present none; missing memory/current-research-line.md, memory/unified-risk-view.md, MEMORY.md.",
        ),
      }),
    );

    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-control-room-empty.md"),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("Learning loop: no active timebox in oc-control-room-empty.");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reports daily artifact unavailability honestly when the control-room memory workspace cannot be read", async () => {
    const tempDir = path.join(os.tmpdir(), `openclaw-feishu-workface-unavailable-${Date.now()}`);

    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue(undefined);
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue(undefined);

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
今天先看哪些链条当前不可读。
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-unavailable" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-daily-brief-unavailable",
          chat_id: "oc-control-room-unavailable",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "给我今天的健康卓越日报" }),
        },
      },
    });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Daily artifacts: latest workface / portfolio scorecard / validation radar state unavailable.",
        ),
      }),
    );

    const controlLedger = await fs.readFile(
      path.join(
        tempDir,
        "memory",
        "feishu-surface-lines",
        "control_room-oc-control-room-unavailable.md",
      ),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("Numeric market claims require an explicit data timestamp.");
    expect(controlLedger).toContain("- unavailable.");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps learning-loop evidence in control-room ledgers even when the control summary is very long", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-workface-long-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });

    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-long-brief-1",
      deadlineAt: "2026-03-26T18:00:00.000Z",
      status: "running",
      iterationsCompleted: 1,
      iterationsFailed: 0,
    });
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue(undefined);
    const longSummaryLine =
      "今天控制室先看风险预算、暴露聚集、研究积压和修补队列，不要被表面热闹带偏，也不要把没有落账的东西说成已经进规矩。".repeat(
        5,
      );

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
${longSummaryLine}
${longSummaryLine}
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-long" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-daily-brief-long",
          chat_id: "oc-control-room-long",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "给我今天的健康卓越日报" }),
        },
      },
    });

    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-control-room-long.md"),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("Learning loop: active session timebox-running-long-brief-1");
    expect(controlLedger).toContain("最近落账: 还没找到最新 lobster-workface 学习包。");
    expect(controlLedger).toContain("Protected anchors: present none; missing");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("omits placeholder lane-panel filler from workface control-room summaries", () => {
    const content = renderLobsterWorkfaceArtifact({
      targetDateKey: "2026-03-26",
      sessionKey: "agent:main:main",
      learningItems: 1,
      correctionNotes: 0,
      watchtowerSignals: 0,
      codexEscalations: 0,
      totalTokens: "999",
      estimatedCost: "$0.0100",
      dashboardSnapshotLines: ["- Learning Flow: █ 1 item"],
      validationRadarLines: ["- No weekly validation radar is available yet."],
      feishuLanePanelLines: ["- No active Feishu surface lanes are recorded yet."],
      sevenDayOperatingViewLines: ["- Learning Items (7d): 1"],
      yesterdayLearnedLines: [
        "- review / risk: 先等确认。",
        "- replay: replay the durable rule when another agent-orchestration writeup starts drifting into list-only architecture commentary.",
        "- next eval: next time check whether the draft names one concrete failure mode before keeping the lesson.",
      ],
      yesterdayCorrectedLines: ["- No correction note was captured yesterday."],
      yesterdayWatchtowerLines: ["- No watchtower anomaly was recorded yesterday."],
      codexEscalationLines: ["- No Codex escalation packet was recorded yesterday."],
      portfolioAnswerScorecardLines: ["- No portfolio-answer scorecard is available yet."],
      tokenDashboardLeadLine: "- Yesterday total: 999 tokens / $0.0100",
      tokenDashboardModelLines: [
        "",
        "### By Model",
        "- No model usage rows were recorded yesterday.",
      ],
      tokenTrendLines: ["- 2026-03-26: █ 999"],
      readingGuideLines: ["- Use this artifact to supervise daily usefulness."],
    });

    const summary = buildLobsterWorkfaceControlRoomSummary({
      filename: buildLobsterWorkfaceFilename("2026-03-26"),
      content,
    });

    expect(summary).not.toContain("lane panel");
    expect(summary).toContain(
      "replay replay the durable rule when another agent-orchestration writeup starts drifting into list-only architecture commentary.",
    );
    expect(summary).toContain(
      "next eval next time check whether the draft names one concrete failure mode before keeping the lesson.",
    );
    expect(summary).toContain("tokens 999, estimated cost $0.0100.");
  });

  it("republishes watchtower artifacts when the same filename gets new content", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-workface-refresh-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    const workfacePath = path.join(tempDir, "memory", buildLobsterWorkfaceFilename("2026-03-26"));
    const writeWorkface = async (tokens: string) =>
      fs.writeFile(
        workfacePath,
        renderLobsterWorkfaceArtifact({
          targetDateKey: "2026-03-26",
          sessionKey: "agent:main:main",
          learningItems: 3,
          correctionNotes: 1,
          watchtowerSignals: 2,
          codexEscalations: 0,
          activeSurfaceLanes: 2,
          portfolioScorecard: "3.6 / 5.0",
          totalTokens: tokens,
          estimatedCost: "$1.2345",
          dashboardSnapshotLines: ["- Learning Flow: ███ 3 items"],
          validationRadarLines: [
            "- Strongest Domain: bounded repair planning: factual 4.0/5, reasoning 4.0/5 (1 note)",
            "- Weakest Domain: position management: factual 3.0/5, reasoning 2.0/5 (1 note)",
            "- Hallucination Watch: position management: 1 risky validation note",
          ],
          feishuLanePanelLines: ["- Active Lanes: 2"],
          sevenDayOperatingViewLines: ["- Learning Items (7d): 3"],
          yesterdayLearnedLines: ["- review / risk-transmission: trace the live driver first."],
          yesterdayCorrectedLines: ["- No correction note was captured yesterday."],
          yesterdayWatchtowerLines: ["- No watchtower anomaly was recorded yesterday."],
          codexEscalationLines: ["- No Codex escalation packet was recorded yesterday."],
          portfolioAnswerScorecardLines: ["- latest: 2026-W13-portfolio-answer-scorecard.md"],
          tokenDashboardLeadLine: `- Yesterday total: ${tokens} tokens / $1.2345`,
          tokenDashboardModelLines: [
            "",
            "### By Model",
            "- No model usage rows were recorded yesterday.",
          ],
          tokenTrendLines: [`- 2026-03-26: ███ ${tokens}`],
          readingGuideLines: ["- Use this artifact to supervise daily usefulness."],
        }),
        "utf-8",
      );

    await writeWorkface("12,345");

    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({ text: "今天看系统健康。" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-workface-refresh" },
            watchtower: { chatId: "oc-watchtower-workface-refresh" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-control-workface-refresh-1",
        chat_id: "oc-control-room-workface-refresh",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "给我今天的健康卓越日报" }),
      },
    };

    await dispatchMessage({ cfg, event });
    await writeWorkface("22,222");
    await dispatchMessage({
      cfg,
      event: {
        ...event,
        message: { ...event.message, message_id: "msg-control-workface-refresh-2" },
      },
    });

    const watchtowerPublishes = mockSendMessageFeishu.mock.calls.filter(
      ([payload]) => payload?.to === "chat:oc-watchtower-workface-refresh",
    );
    expect(watchtowerPublishes).toHaveLength(2);
    expect(watchtowerPublishes[0]?.[0]?.text).toContain("12,345");
    expect(watchtowerPublishes[1]?.[0]?.text).toContain("22,222");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("suppresses duplicate or low-signal specialist slices during classified publish", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const replyText = `
## Control Summary
今天先别追，先看结构。

## Technical Slice
publish: yes
confidence: high
Monitor only.
`;

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({ text: replyText });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-lane-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-duplicate" },
            technical_daily: { chatId: "oc-tech-duplicate" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-control-classified-duplicate",
        chat_id: "oc-control-room-duplicate",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "今天该关注什么，给我一个总览" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "今天先别追，先看结构。\n\nDistribution: suppressed low-signal technical slice.",
    });
    expect(mockSendMessageFeishu).not.toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-tech-duplicate",
      }),
    );
  });

  it("suppresses duplicate specialist slices across repeated control-room runs", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const replyText = `
## Control Summary
今天先看利率和风险偏好。

## Technical Slice
publish: yes
confidence: high
QQQ 对长端利率更敏感，先看 10Y 与风险偏好是否继续共振走弱。
`;

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({ text: replyText });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-lane-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room-dedupe" },
            technical_daily: { chatId: "oc-tech-dedupe" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-control-classified-dedupe",
        chat_id: "oc-control-room-dedupe",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "今天该关注什么，给我一个总览" }),
      },
    };

    await dispatchMessage({ cfg, event });
    await dispatchMessage({
      cfg,
      event: {
        ...event,
        message: { ...event.message, message_id: "msg-control-classified-dedupe-2" },
      },
    });

    const techPublishes = mockSendMessageFeishu.mock.calls.filter(
      ([payload]) => payload?.to === "chat:oc-tech-dedupe",
    );
    expect(techPublishes).toHaveLength(1);
    expect(baseDispatcher.sendFinalReply).toHaveBeenLastCalledWith({
      text: "今天先看利率和风险偏好。\n\nDistribution: suppressed duplicate technical slice.",
    });
  });
});

describe("learning council routing", () => {
  it("answers active learning-session status directly from control room", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-control-1",
      deadlineAt: "2026-04-08T22:40:00.000Z",
      receiptsPath: "memory/feishu-learning-timeboxes/timebox-running-control-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await createFeishuLearningStatusWorkspace();
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-control",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "现在还在学吗，学到哪了" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("## Learning status"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("timebox-running-control-1"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("学习 chat: oc-learning"),
    });
  });

  it("answers the latest non-running learning-session status from control room", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue({
      sessionId: "timebox-completed-control-1",
      status: "completed",
      deadlineAt: "2026-04-08T22:40:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:10:00.000Z",
      iterationsCompleted: 2,
      iterationsFailed: 0,
      receiptsPath: "memory/feishu-learning-timeboxes/timebox-completed-control-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await createFeishuLearningStatusWorkspace();
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-control-completed",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "现在还在学吗，学到哪了" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("最近状态: completed"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("已完成轮次: 2"),
    });
  });

  it("answers mixed Chinese-English learning-session liveness asks from control room", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-control-mixed-1",
      status: "running",
      deadlineAt: "2026-04-08T23:00:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:20:00.000Z",
      iterationsCompleted: 1,
      iterationsFailed: 0,
      receiptsPath:
        "memory/feishu-learning-timeboxes/timebox-running-control-mixed-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await createFeishuLearningStatusWorkspace();
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-control-mixed",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "学习 session 现在还活着吗" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("## Learning status"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("timebox-running-control-mixed-1"),
    });
  });

  it("answers colloquial '还在跑吗' learning-session asks from control room", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-control-colloquial-1",
      status: "running",
      deadlineAt: "2026-04-08T23:10:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:30:00.000Z",
      iterationsCompleted: 2,
      iterationsFailed: 0,
      receiptsPath:
        "memory/feishu-learning-timeboxes/timebox-running-control-colloquial-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await createFeishuLearningStatusWorkspace();
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-control-colloquial",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "我刚才让你学的那条还在跑吗" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("## Learning status"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("timebox-running-control-colloquial-1"),
    });
  });

  it("includes carryover and protected-anchor evidence in control-room learning status replies", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-control-evidence-1",
      status: "running",
      deadlineAt: "2026-04-08T23:20:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:40:00.000Z",
      iterationsCompleted: 2,
      iterationsFailed: 0,
      receiptsPath:
        "memory/feishu-learning-timeboxes/timebox-running-control-evidence-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-status-evidence-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", buildLobsterWorkfaceFilename("2026-04-08")),
      renderLobsterWorkfaceArtifact({
        targetDateKey: "2026-04-08",
        sessionKey: "agent:main:main",
        learningItems: 1,
        correctionNotes: 0,
        watchtowerSignals: 0,
        codexEscalations: 0,
        totalTokens: "888",
        estimatedCost: "$0.0200",
        dashboardSnapshotLines: ["- Learning Flow: █ 1 item"],
        validationRadarLines: ["- No weekly validation radar is available yet."],
        feishuLanePanelLines: ["- No active Feishu surface lanes are recorded yet."],
        sevenDayOperatingViewLines: ["- Learning Items (7d): 1"],
        yesterdayLearnedLines: [
          "- keep: keep one concrete rule instead of vague learning prose.",
          "- discard: discard learning outputs that never change the next batch.",
          "- replay: replay the concrete fix when the same workflow failure returns.",
          "- next eval: next batch verify the carryover cue still shows up in status.",
        ],
        yesterdayCorrectedLines: ["- No correction note was captured yesterday."],
        yesterdayWatchtowerLines: ["- No watchtower anomaly was recorded yesterday."],
        codexEscalationLines: ["- No Codex escalation packet was recorded yesterday."],
        portfolioAnswerScorecardLines: ["- No portfolio-answer scorecard is available yet."],
        tokenDashboardLeadLine: "- Yesterday total: 888 tokens / $0.0200",
        tokenDashboardModelLines: [
          "",
          "### By Model",
          "- No model usage rows were recorded yesterday.",
        ],
        tokenTrendLines: ["- 2026-04-08: █ 888"],
        readingGuideLines: ["- Use this artifact to supervise daily usefulness."],
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(tempDir, "memory", "current-research-line.md"),
      "# Current Research Line\n",
      "utf-8",
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-control-evidence",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "学习 session 现在还活着吗" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining(
        "最近落账: 2026-04-08-lobster-workface.md 已记录 retain / discard / replay / next eval。",
      ),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining(
        "Protected anchors: present memory/current-research-line.md; missing memory/unified-risk-view.md, MEMORY.md.",
      ),
    });

    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-control-room.md"),
      "utf-8",
    );
    expect(controlLedger).toContain("# Feishu Surface Line: control_room / oc-control-room");
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("最近落账:");
    expect(controlLedger).toContain("Protected anchors:");
  });

  it("records an operational anomaly when control-room learning-status ledger persistence fails", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-control-persist-failure-1",
      status: "running",
      deadlineAt: "2026-04-08T23:20:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:40:00.000Z",
      iterationsCompleted: 2,
      iterationsFailed: 0,
      receiptsPath:
        "memory/feishu-learning-timeboxes/timebox-running-control-persist-failure-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-status-persist-"));
    const workspaceFile = path.join(tempDir, "workspace-file");
    await fs.writeFile(workspaceFile, "not a directory", "utf-8");
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: workspaceFile } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-control-persist-failure",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "学习 session 现在还活着吗" }),
        },
      },
    });

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("## Learning status"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("最近落账: 当前无法读取 latest lobster-workface 学习包状态。"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("Protected anchors: state unavailable."),
    });
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.surface_memory",
        problem: "failed to persist feishu surface line",
        evidence: expect.arrayContaining([
          "failure_stage=surface_line",
          "surface=control_room",
          "effective_surface=control_room",
          "chat_id=oc-control-room",
          "message_id=msg-learning-status-control-persist-failure",
        ]),
      }),
    );
  });

  it("does not write a direct-reply ledger when the final reply was not accepted", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => false),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-direct-send-false-1",
      status: "running",
      deadlineAt: "2026-04-08T23:30:00.000Z",
      receiptsPath:
        "memory/feishu-learning-timeboxes/timebox-running-direct-send-false-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await createFeishuLearningStatusWorkspace();
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-direct-send-false",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "学习 session 现在还活着吗" }),
        },
      },
    });

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("## Learning status"),
    });
    await expect(
      fs.readFile(
        path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-control-room.md"),
        "utf-8",
      ),
    ).rejects.toThrow();
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.surface_memory",
        problem: "skipped feishu surface line persist because no final reply text was captured",
        evidence: expect.arrayContaining([
          "failure_stage=final_reply_capture",
          "final_reply_captured=false",
          "dispatch_queued_final=false",
          "dispatch_final_count=0",
        ]),
      }),
    );
  });

  it("keeps partial learning carryover cues honest in control-room learning status replies", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-control-partial-carryover-1",
      status: "running",
      deadlineAt: "2026-04-08T23:20:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:40:00.000Z",
      iterationsCompleted: 1,
      iterationsFailed: 0,
      receiptsPath:
        "memory/feishu-learning-timeboxes/timebox-running-control-partial-carryover-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-learning-status-partial-carryover-"),
    );
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", buildLobsterWorkfaceFilename("2026-04-08")),
      renderLobsterWorkfaceArtifact({
        targetDateKey: "2026-04-08",
        sessionKey: "agent:main:main",
        learningItems: 1,
        correctionNotes: 0,
        watchtowerSignals: 0,
        codexEscalations: 0,
        totalTokens: "444",
        estimatedCost: "$0.0100",
        dashboardSnapshotLines: ["- Learning Flow: █ 1 item"],
        validationRadarLines: ["- No weekly validation radar is available yet."],
        feishuLanePanelLines: ["- No active Feishu surface lanes are recorded yet."],
        sevenDayOperatingViewLines: ["- Learning Items (7d): 1"],
        yesterdayLearnedLines: [
          "- keep: keep one concrete rule instead of vague learning prose.",
          "- discard: discard learning outputs that never change the next batch.",
        ],
        yesterdayCorrectedLines: ["- No correction note was captured yesterday."],
        yesterdayWatchtowerLines: ["- No watchtower anomaly was recorded yesterday."],
        codexEscalationLines: ["- No Codex escalation packet was recorded yesterday."],
        portfolioAnswerScorecardLines: ["- No portfolio-answer scorecard is available yet."],
        tokenDashboardLeadLine: "- Yesterday total: 444 tokens / $0.0100",
        tokenDashboardModelLines: [
          "",
          "### By Model",
          "- No model usage rows were recorded yesterday.",
        ],
        tokenTrendLines: ["- 2026-04-08: █ 444"],
        readingGuideLines: ["- Use this artifact to supervise daily usefulness."],
      }),
      "utf-8",
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-control-partial-carryover",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "学习 session 现在还活着吗" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining(
        "最近落账: 2026-04-08-lobster-workface.md 存在，但 learning carryover cue 还不完整；目前只看到 retain / discard。",
      ),
    });
    expect(baseDispatcher.sendFinalReply).not.toHaveBeenCalledWith({
      text: expect.stringContaining(
        "最近落账: 2026-04-08-lobster-workface.md 已记录 retain / discard。",
      ),
    });
  });

  it("answers latest learning-session status even when the current route agent has no workspace", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue({
      sessionId: "timebox-interrupted-control-2",
      status: "interrupted",
      deadlineAt: "2026-04-08T22:40:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:15:00.000Z",
      iterationsCompleted: 1,
      iterationsFailed: 1,
      receiptsPath: "memory/feishu-learning-timeboxes/timebox-interrupted-control-2.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {},
        list: [{ id: "research", workspace: "/tmp/openclaw-learning-timebox-research" }],
      },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-status-control-interrupted",
          chat_id: "oc-control-room",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "现在还在学吗，学到哪了" }),
        },
      },
    });

    expect(mockFindLatestFeishuLearningTimeboxSession).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      chatId: "oc-learning",
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("最近状态: interrupted"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("失败轮次: 1"),
    });
  });

  it("keeps learning-status evidence honest when workspace memory cannot be read", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-control-unavailable-1",
      status: "running",
      deadlineAt: "2026-04-08T23:20:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:40:00.000Z",
      iterationsCompleted: 2,
      iterationsFailed: 0,
      receiptsPath:
        "memory/feishu-learning-timeboxes/timebox-running-control-unavailable-1.receipts.jsonl",
    });

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await createFeishuLearningStatusWorkspace();
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementationOnce(async () => {
      throw new Error("memory unavailable");
    });
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control-room" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    try {
      await dispatchMessage({
        cfg,
        event: {
          sender: { sender_id: { open_id: "ou-user" } },
          message: {
            message_id: "msg-learning-status-control-unavailable",
            chat_id: "oc-control-room",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "学习 session 现在还活着吗" }),
          },
        },
      });
    } finally {
      readdirSpy.mockRestore();
    }

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("最近落账: 当前无法读取 latest lobster-workface 学习包状态。"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("Protected anchors: state unavailable."),
    });
  });

  it("runs the real learning council flow for learning_command instead of normal single-pass dispatch", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockRunFeishuLearningCouncil.mockResolvedValue(
      "Learning council run: full three-model execution completed.\n\n## Kimi synthesis\n- one point",
    );

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-lane-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-learning-live",
        chat_id: "oc-learning",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "用三个模型一起学这个主题" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockRunFeishuLearningCouncil).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: "用三个模型一起学这个主题",
        routeAgentId: "main",
        sessionKey: "agent:main:feishu:dm:ou-attacker:surface:learning_command",
        workspaceDir: tempDir,
      }),
    );
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "Learning council run: full three-model execution completed.\n\n## Kimi synthesis\n- one point",
    });
  });

  it("runs the finance learning pipeline directly for concrete market capability learning with a local source", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockCreateGatewayLarkApiRouteProvider.mockReturnValue(async () => ({
      family: "market_capability_learning_intake",
      confidence: 0.92,
      rationale: "market capability learning intake",
    }));

    const mockDispatchReplyFromConfig = vi.fn();
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher: vi.fn(
              async ({
                dispatcher,
                run,
                onSettled,
              }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
                try {
                  return await run();
                } finally {
                  dispatcher.markComplete();
                  try {
                    await dispatcher.waitForIdle();
                  } finally {
                    await onSettled?.();
                  }
                }
              },
            ) as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-finance-pipeline-"));
    await fs.mkdir(path.join(tempDir, "memory", "articles"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", "articles", "factor-timing.md"),
      buildFeishuFinanceLearningSourceArticle(),
      "utf-8",
    );
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-finance-pipeline-live",
        chat_id: "oc-learning",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "学习一套很好的量化因子择时策略，source memory/articles/factor-timing.md，最后要有 retrieval receipt 和 review",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("金融能力学习流水线已完成 dev 验收"),
    });
    const replyText = ((
      baseDispatcher.sendFinalReply.mock.calls as unknown as Array<[{ text: string }]>
    )[0]?.[0]).text;
    expect(replyText).toContain("learningInternalizationStatus: application_ready");
    expect(replyText).toContain("failedReason: none");
    expect(replyText).toContain("receipt: memory/finance-learning-retrieval-receipts/");
    expect(replyText).toContain("review: memory/finance-learning-retrieval-reviews/");
    expect(replyText).toContain("weak learning receipts: 0");
    expect(replyText).toContain("application validation: application_ready");
    expect(replyText).toContain("answer scaffold: scaffold_only_until_fresh_inputs_are_checked");
    expect(replyText).toContain("synthesis mode: single_capability_application");
    expect(replyText).toContain("usage receipt: memory/finance-learning-apply-usage-receipts/");
    expect(replyText).toContain("usage review: memory/finance-learning-apply-usage-reviews/");
    expect(replyText).toContain(
      "automation: this message refreshed retrieval review and apply usage review",
    );
    expect(replyText).toContain("apply mode: reuse_guidance_bounded_research_answer");
    expect(replyText).toContain("applied candidates: 1");
    expect(replyText).toContain("usable answer contract: usable_after_fresh_inputs_are_checked");
    expect(replyText).toContain(
      "apply boundary: This application is research-only and does not approve trades",
    );
    await expect(
      fs.readdir(path.join(tempDir, "memory", "finance-learning-retrieval-receipts")),
    ).resolves.toHaveLength(1);
    const reviewFiles = await fs.readdir(
      path.join(tempDir, "memory", "finance-learning-retrieval-reviews"),
    );
    expect(reviewFiles).toHaveLength(1);
    const reviewText = await fs.readFile(
      path.join(tempDir, "memory", "finance-learning-retrieval-reviews", reviewFiles[0]),
      "utf-8",
    );
    expect(reviewText).toContain('"boundary": "finance_learning_retrieval_review"');
    expect(reviewText).toContain('"applicationValidationUsageReceiptPath"');
    expect(reviewText).toContain('"applicationValidationUsageReviewPath"');
    expect(reviewText).toContain("memory/finance-learning-apply-usage-receipts/");
    expect(reviewText).toContain("memory/finance-learning-apply-usage-reviews/");

    const applyUsageReviewFiles = await fs.readdir(
      path.join(tempDir, "memory", "finance-learning-apply-usage-reviews"),
    );
    expect(applyUsageReviewFiles).toHaveLength(1);
    const applyUsageReviewText = await fs.readFile(
      path.join(
        tempDir,
        "memory",
        "finance-learning-apply-usage-reviews",
        applyUsageReviewFiles[0],
      ),
      "utf-8",
    );
    expect(applyUsageReviewText).toContain(
      '"boundary": "finance_learning_capability_apply_usage_review"',
    );
    expect(applyUsageReviewText).toContain('"usageReceipts": 1');
    expect(applyUsageReviewText).toContain('"successfulApplications": 1');

    const languageCandidateDirs = await fs.readdir(
      path.join(tempDir, "memory", "lark-language-routing-candidates"),
    );
    expect(languageCandidateDirs).toHaveLength(1);
    await expect(
      fs.access(
        path.join(
          tempDir,
          "memory",
          "lark-language-routing-candidates",
          languageCandidateDirs[0],
          "msg-finance-pipeline-live.json",
        ),
      ),
    ).resolves.toBeUndefined();
    const languageReviewText = await fs.readFile(
      path.join(
        tempDir,
        "memory",
        "lark-language-routing-reviews",
        `${languageCandidateDirs[0]}.json`,
      ),
      "utf-8",
    );
    expect(languageReviewText).toContain('"boundary": "language_routing_only"');

    const surfaceLineText = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "learning_command-oc-learning.md"),
      "utf-8",
    );
    expect(surfaceLineText).toContain("msg-finance-pipeline-live");
    expect(surfaceLineText).toContain("金融能力学习流水线已完成 dev 验收");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not run the finance learning pipeline when concrete market capability learning lacks a safe source", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockCreateGatewayLarkApiRouteProvider.mockReturnValue(async () => ({
      family: "market_capability_learning_intake",
      confidence: 0.9,
      rationale: "market capability learning intake",
    }));

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: vi.fn(),
            withReplyDispatcher: vi.fn(
              async ({
                dispatcher,
                run,
                onSettled,
              }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
                try {
                  return await run();
                } finally {
                  dispatcher.markComplete();
                  try {
                    await dispatcher.waitForIdle();
                  } finally {
                    await onSettled?.();
                  }
                }
              },
            ) as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-finance-no-source-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-finance-pipeline-missing-source",
          chat_id: "oc-learning",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "学习一套很好的量化因子择时策略，最后要有 retrieval receipt 和 review",
          }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("还缺安全 source"),
    });
    const replyText = ((
      baseDispatcher.sendFinalReply.mock.calls as unknown as Array<[{ text: string }]>
    )[0]?.[0]).text;
    expect(replyText).toContain("learningInternalizationStatus: not_started");
    expect(replyText).toContain("failedReason: safe_local_or_manual_source_required");
    expect(replyText).toContain("未产生: retrievalReceiptPath / retrievalReviewPath");
    await expect(
      fs.stat(path.join(tempDir, "memory", "finance-learning-retrieval-receipts")),
    ).rejects.toThrow();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses the finance learning missing-source gate when API handoff targets learning from control room", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockCreateGatewayLarkApiRouteProvider.mockReturnValue(async () => ({
      family: "market_capability_learning_intake",
      confidence: 0.78,
      rationale: "operator clarified the agent should learn for itself",
    }));

    const mockDispatchReplyFromConfig = vi.fn();
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher: vi.fn(
              async ({
                dispatcher,
                run,
                onSettled,
              }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
                try {
                  return await run();
                } finally {
                  dispatcher.markComplete();
                  try {
                    await dispatcher.waitForIdle();
                  } finally {
                    await onSettled?.();
                  }
                }
              },
            ) as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-control-room-learning-no-source-"),
    );
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-control" },
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-room-learning-missing-source",
          chat_id: "oc-control",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "不是教我学 是你自己学",
          }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("还缺安全 source"),
    });
    const replyText = ((
      baseDispatcher.sendFinalReply.mock.calls as unknown as Array<[{ text: string }]>
    )[0]?.[0]).text;
    expect(replyText).toContain("learningInternalizationStatus: not_started");
    expect(replyText).toContain("failedReason: safe_local_or_manual_source_required");
    expect(replyText).toContain("未产生: retrievalReceiptPath / retrievalReviewPath");
    await expect(
      fs.stat(path.join(tempDir, "memory", "finance-learning-retrieval-receipts")),
    ).rejects.toThrow();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("fails closed in the finance learning pipeline without receipts when market capability source cannot be extracted", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockCreateGatewayLarkApiRouteProvider.mockReturnValue(async () => ({
      family: "market_capability_learning_intake",
      confidence: 0.91,
      rationale: "market capability learning intake",
    }));

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: vi.fn(),
            withReplyDispatcher: vi.fn(
              async ({
                dispatcher,
                run,
                onSettled,
              }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
                try {
                  return await run();
                } finally {
                  dispatcher.markComplete();
                  try {
                    await dispatcher.waitForIdle();
                  } finally {
                    await onSettled?.();
                  }
                }
              },
            ) as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-finance-gap-"));
    await fs.mkdir(path.join(tempDir, "memory", "articles"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", "articles", "weak-factor-note.md"),
      [
        "# Weak timing note",
        "",
        "This note mentions ETF timing and factor ideas, but it does not include the structured method, evidence categories, risk and failure modes, causal claim, or action authority fields needed for retention.",
      ].join("\n"),
      "utf-8",
    );
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-finance-pipeline-extraction-gap",
          chat_id: "oc-learning",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "学习一套 ETF 因子择时策略，source memory/articles/weak-factor-note.md，最后要有 retrieval receipt 和 review",
          }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    const replyText = ((
      baseDispatcher.sendFinalReply.mock.calls as unknown as Array<[{ text: string }]>
    )[0]?.[0]).text;
    expect(replyText).toContain("金融能力学习流水线没有完成");
    expect(replyText).toContain("learningInternalizationStatus: not_started");
    expect(replyText).toContain("failedReason: finance_article_extraction_gap");
    expect(replyText).toContain("failed step: extract");
    expect(replyText).toContain("reason: finance_article_extraction_gap");
    expect(replyText).toContain("extraction gap:");
    expect(replyText).toContain("receipt: not_created");
    expect(replyText).toContain("review: not_created");
    expect(replyText).not.toContain("金融能力学习流水线已完成 dev 验收");
    await expect(
      fs.stat(path.join(tempDir, "memory", "finance-learning-retrieval-receipts")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(tempDir, "memory", "finance-learning-apply-usage-reviews")),
    ).rejects.toThrow();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("routes bounded same-day market-intelligence packet asks through the market packet runner instead of the learning council/timebox path", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockRunFeishuMarketIntelligencePacket.mockResolvedValue(
      "## Market Intelligence Packet\n- task: same-day ETF / index / macro intelligence packet",
    );

    const mockDispatchReplyFromConfig = vi.fn();
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-market-intelligence-"));
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-market-packet",
        chat_id: "oc-learning",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "今天做一个 ETF / macro intelligence packet，给我 SPY QQQ rates dollar 的情报包",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockRunFeishuMarketIntelligencePacket).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage:
          "今天做一个 ETF / macro intelligence packet，给我 SPY QQQ rates dollar 的情报包",
        routeAgentId: "main",
        sessionKey: "agent:main:feishu:dm:ou-attacker:surface:learning_command",
        workspaceDir: tempDir,
      }),
    );
    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockStartFeishuLearningTimeboxSession).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "## Market Intelligence Packet\n- task: same-day ETF / index / macro intelligence packet",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("appends a started timebox status when bounded background learning begins", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockRunFeishuLearningCouncil.mockResolvedValue(
      "Learning council run: full three-model execution completed.",
    );
    mockStartFeishuLearningTimeboxSession.mockResolvedValue({
      status: "started",
      sessionId: "timebox-1",
      deadlineAt: "2026-04-08T22:30:00.000Z",
      durationLabel: "1小时",
      intervalMinutes: 10,
      receiptsPath: "memory/feishu-learning-timeboxes/timebox-1.receipts.jsonl",
      processBound: true,
    });

    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: vi.fn(),
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await createFeishuLearningStatusWorkspace();
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-timebox",
          chat_id: "oc-learning",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "你去学习一个小时，学前沿论文里值得学习的策略和概念" }),
        },
      },
    });

    expect(mockStartFeishuLearningTimeboxSession).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "oc-learning",
        messageId: "msg-learning-timebox",
        userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("## Timebox status"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("已启动进程内限时学习 1小时"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("最近落账: 还没找到最新 lobster-workface 学习包。"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("Protected anchors:"),
    });

    const learningLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "learning_command-oc-learning.md"),
      "utf-8",
    );
    expect(learningLedger).toContain("Reply summary:");
    expect(learningLedger).toContain("最近落账:");
    expect(learningLedger).toContain("Protected anchors:");
  });

  it("skips duplicate immediate learning when a timebox session is already running in the same chat", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockPeekFeishuLearningTimeboxSession.mockReturnValue({
      status: "already_running",
      sessionId: "timebox-running-1",
      deadlineAt: "2026-04-08T22:30:00.000Z",
      durationLabel: "1小时",
      receiptsPath: "memory/feishu-learning-timeboxes/timebox-running-1.receipts.jsonl",
    });

    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: vi.fn(),
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const tempDir = await createFeishuLearningStatusWorkspace({
      learnedLines: [
        "- keep: keep one concrete rule instead of vague learning prose.",
        "- discard: discard learning outputs that never change the next batch.",
        "- replay: replay the concrete fix when the same workflow failure returns.",
        "- next eval: next batch verify the carryover cue still shows up in status.",
      ],
    });
    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-timebox-duplicate",
          chat_id: "oc-learning",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "你去学习一个小时，学前沿论文里值得学习的策略和概念" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockStartFeishuLearningTimeboxSession).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("当前已有一个限时学习 session 在运行：timebox-running-1"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("这次不会再重复执行新的即时学习或后台 session"),
    });

    const learningLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "learning_command-oc-learning.md"),
      "utf-8",
    );
    expect(learningLedger).toContain("Reply summary:");
    expect(learningLedger).toContain("timebox-running-1");
    expect(learningLedger).toContain(
      "Session Key: agent:main:feishu:dm:ou-attacker:surface:learning_command",
    );
  });

  it("blocks a normal learning command when the same chat already has a running timebox session", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-2",
      deadlineAt: "2026-04-08T22:40:00.000Z",
      receiptsPath: "memory/feishu-learning-timeboxes/timebox-running-2.receipts.jsonl",
    });

    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: vi.fn(),
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: "/tmp/openclaw-learning-timebox" } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-active-block",
          chat_id: "oc-learning",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "去学一下最近开源里有什么值得学" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockPeekFeishuLearningTimeboxSession).not.toHaveBeenCalled();
    expect(mockStartFeishuLearningTimeboxSession).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("当前已有一个限时学习 session 在运行：timebox-running-2"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("这次不会再插入新的即时学习"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("最近落账:"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("Protected anchors:"),
    });
  });

  it("skips immediate learning when a persisted running timebox is still visible during the recovery window", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue({
      sessionId: "timebox-persisted-running-1",
      status: "running",
      deadlineAt: "2026-04-08T22:55:00.000Z",
      lastHeartbeatAt: "2026-04-08T22:15:00.000Z",
      iterationsCompleted: 1,
      iterationsFailed: 0,
      receiptsPath: "memory/feishu-learning-timeboxes/timebox-persisted-running-1.receipts.jsonl",
    });
    mockPeekFeishuLearningTimeboxSession.mockReturnValue({ status: "eligible" });

    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: vi.fn(),
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: "/tmp/openclaw-learning-timebox" } },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-persisted-recovery-block",
          chat_id: "oc-learning",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "别偷懒，你现在就去学习一个小时，学前沿论文里最值得记住、以后能反复用的策略和概念",
          }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockStartFeishuLearningTimeboxSession).not.toHaveBeenCalled();
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining(
        "当前已有一个限时学习 session 在运行：timebox-persisted-running-1",
      ),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("恢复窗口里把同一 chat 的学习轨迹再跑脏一轮"),
    });
  });

  it("scopes sessions by specialist surface when different intents share the same control-room chat", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const mockDispatchReplyFromConfig = vi.fn(async ({ ctx }: { ctx: { SessionKey: string } }) => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: ctx.SessionKey.includes("fundamental_research") ? 1 : 0 },
    }));
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    mockRunFeishuLearningCouncil.mockResolvedValue("learning ok");
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext:
              finalizeInboundContext as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
            dispatchReplyFromConfig:
              mockDispatchReplyFromConfig as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-main" },
            learning_command: { chatId: "oc-learning" },
            fundamental_research: { chatId: "oc-fund" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-overlap",
          chat_id: "oc-main",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "去学一下最近开源里有什么值得学" }),
        },
      },
    });

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-fund-overlap",
          chat_id: "oc-main",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "读一下科技财报" }),
        },
      },
    });

    expect(mockRunFeishuLearningCouncil).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:feishu:dm:ou-attacker:surface:learning_command",
      }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SessionKey: "agent:main:feishu:dm:ou-attacker:surface:fundamental_research",
        }),
      }),
    );
    const sessionKeys = finalizeInboundContext.mock.calls.map(
      (call: unknown[]) => (call[0] as { SessionKey: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:main:feishu:dm:ou-attacker:surface:learning_command");
    expect(sessionKeys).toContain("agent:main:feishu:dm:ou-attacker:surface:fundamental_research");
  });

  it("persists separate bounded memory ledgers for different specialist lines in the same chat", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-lines-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });

    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
        ctx,
      }: {
        dispatcher: { sendFinalReply: (payload: { text?: string }) => boolean };
        ctx: { SessionKey: string };
      }) => {
        dispatcher.sendFinalReply({
          text: ctx.SessionKey.includes("fundamental_research")
            ? "先看苹果和微软财报的商业质量。"
            : "先看最近值得学的开源量化工具和方法坑点。",
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    mockRunFeishuLearningCouncil.mockResolvedValue(
      "先说人话：最近值得学的是更稳的仓位纪律和回测卫生。\n\n## Kimi synthesis\n- one point",
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig:
              mockDispatchReplyFromConfig as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          workspace: tempDir,
        },
      },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-main" },
            learning_command: { chatId: "oc-learning" },
            fundamental_research: { chatId: "oc-fund" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-learning-ledger",
          chat_id: "oc-main",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "去学一下最近开源里有什么值得学" }),
        },
      },
    });

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-fund-ledger",
          chat_id: "oc-main",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "读一下科技财报" }),
        },
      },
    });

    const learningLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "learning_command-oc-main.md"),
      "utf-8",
    );
    const fundamentalLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "fundamental_research-oc-main.md"),
      "utf-8",
    );
    const lanePanel = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "index.md"),
      "utf-8",
    );
    const laneHealth = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "health.md"),
      "utf-8",
    );

    expect(learningLedger).toContain("# Feishu Surface Line: learning_command / oc-main");
    expect(learningLedger).toContain("- User: 去学一下最近开源里有什么值得学");
    expect(learningLedger).toContain("- **Lane Key**: learning_command:oc-main");
    expect(learningLedger).toContain("surface:learning_command");
    expect(learningLedger).toContain("最近值得学的是更稳的仓位纪律和回测卫生");

    expect(fundamentalLedger).toContain("# Feishu Surface Line: fundamental_research / oc-main");
    expect(fundamentalLedger).toContain("- User: 读一下科技财报");
    expect(fundamentalLedger).toContain("- **Lane Key**: fundamental_research:oc-main");
    expect(fundamentalLedger).toContain("surface:fundamental_research");
    expect(fundamentalLedger).toContain("苹果和微软财报的商业质量");
    expect(lanePanel).toContain("# Feishu Surface Lane Panel");
    expect(lanePanel).toContain("- **Active Lanes**: 2");
    expect(lanePanel).toContain("learning_command / oc-main: 1 turn");
    expect(lanePanel).toContain("fundamental_research / oc-main: 1 turn");
    expect(laneHealth).toContain("# Feishu Surface Lane Health");
    expect(laneHealth).toContain("- **Status**: stable");
    expect(laneHealth).toContain("- **Active Lanes**: 2");
    expect(laneHealth).toContain("- **Crowded Chats**: none");
    expect(mockRecordOperationalAnomaly).not.toHaveBeenCalledWith(
      expect.objectContaining({
        category: "lane_overload",
      }),
    );
  });

  it("keeps broad control-room aggregate asks on the base session and control-room ledger", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-control-room-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });

    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: { sendFinalReply: (payload: { text?: string }) => boolean };
      }) => {
        dispatcher.sendFinalReply({
          text: "先给你一个控制室总览：调度正常，学习在跑，最该警惕的是代理证据还不够硬。",
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext:
              finalizeInboundContext as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
            dispatchReplyFromConfig:
              mockDispatchReplyFromConfig as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          workspace: tempDir,
        },
      },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-main" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-control-room-global-summary",
          chat_id: "oc-main",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "把今天的系统健康、学习状态、研究状态一起讲给我" }),
        },
      },
    });

    const sessionKeys = finalizeInboundContext.mock.calls.map(
      (call: unknown[]) => (call[0] as { SessionKey: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:main:feishu:dm:ou-attacker");
    expect(sessionKeys).not.toContain("agent:main:feishu:dm:ou-attacker:surface:ops_audit");

    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-main.md"),
      "utf-8",
    );

    expect(controlLedger).toContain("# Feishu Surface Line: control_room / oc-main");
    expect(controlLedger).toContain("- User: 把今天的系统健康、学习状态、研究状态一起讲给我");
    expect(controlLedger).toContain("- **Lane Key**: control_room:oc-main");
    expect(controlLedger).toContain("agent:main:feishu:dm:ou-attacker");
    expect(controlLedger).toContain("先给你一个控制室总览");
    await expect(
      fs.readFile(
        path.join(tempDir, "memory", "feishu-surface-lines", "ops_audit-oc-main.md"),
        "utf-8",
      ),
    ).rejects.toThrow();

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records a lane-overload anomaly when one chat accumulates too many specialist lanes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-lane-overload-"));
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
        ctx,
      }: {
        dispatcher: { sendFinalReply: (payload: { text?: string }) => boolean };
        ctx: { SessionKey: string };
      }) => {
        dispatcher.sendFinalReply({
          text: ctx.SessionKey.includes("fundamental_research")
            ? "先看科技龙头的商业质量与资本配置。"
            : "先看长端利率、QQQ 与风险偏好的传导。",
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    mockRunFeishuLearningCouncil.mockResolvedValue(
      "先说人话：最近值得学的是更稳的仓位纪律和回测卫生。\n\n## Kimi synthesis\n- one point",
    );
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig:
              mockDispatchReplyFromConfig as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          workspace: tempDir,
        },
      },
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            control_room: { chatId: "oc-main" },
            learning_command: { chatId: "oc-learning" },
            fundamental_research: { chatId: "oc-fund" },
            technical_daily: { chatId: "oc-tech" },
          },
        },
      },
    } as ClawdbotConfig;

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-overload-learning",
          chat_id: "oc-main",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "去学一下最近开源里有什么值得学" }),
        },
      },
    });

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-overload-fund",
          chat_id: "oc-main",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "读一下科技财报" }),
        },
      },
    });

    await dispatchMessage({
      cfg,
      event: {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: "msg-overload-tech",
          chat_id: "oc-main",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "去看看几个指数最新的风险和潜在收益" }),
        },
      },
    });

    const laneHealth = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "health.md"),
      "utf-8",
    );

    expect(laneHealth).toContain("- **Status**: crowded");
    expect(laneHealth).toContain("- **Active Lanes**: 3");
    expect(laneHealth).toContain("- **Crowded Chats**: oc-main");
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "lane_overload",
        source: "feishu.surface_memory",
        problem: "one or more chats are carrying too many specialist lanes",
      }),
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps technical_daily on the normal single-pass dispatch path", async () => {
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const mockDispatchReplyFromConfig = vi.fn(async () => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    }));
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            technical_daily: { chatId: "oc-tech" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-tech-normal",
        chat_id: "oc-tech",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "去看看几个指数最新的风险和潜在收益" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});

describe("watchtower anomaly reporting", () => {
  it("records a structured anomaly when final dispatch fails", async () => {
    const mockDispatchReplyFromConfig = vi.fn(async () => {
      throw new Error("dispatch exploded");
    });
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          resolveSenderNames: false,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "msg-dispatch-failure",
        chat_id: "oc-control-room",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "今天该关注什么，给我一个总览" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.dispatch",
        problem: "failed to dispatch message",
      }),
    );
  });
});

describe("handleFeishuMessage command authorization", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: unknown) => ctx);
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } });
  const mockWithReplyDispatcher = vi.fn(
    async ({
      dispatcher,
      run,
      onSettled,
    }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
      try {
        return await run();
      } finally {
        dispatcher.markComplete();
        try {
          await dispatcher.waitForIdle();
        } finally {
          await onSettled?.();
        }
      }
    },
  );
  const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
  const mockShouldComputeCommandAuthorized = vi.fn(() => true);
  const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
  const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const mockBuildPairingReply = vi.fn(() => "Pairing response");
  const mockEnqueueSystemEvent = vi.fn();
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    id: "inbound-clip.mp4",
    path: "/tmp/inbound-clip.mp4",
    size: Buffer.byteLength("video"),
    contentType: "video/mp4",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldComputeCommandAuthorized.mockReset().mockReturnValue(true);
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:dm:ou-attacker",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    mockEnqueueSystemEvent.mockReset();
    setFeishuRuntime(
      createPluginRuntimeMock({
        system: {
          enqueueSystemEvent: mockEnqueueSystemEvent,
        },
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext:
              mockFinalizeInboundContext as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
            resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
          },
          media: {
            saveMediaBuffer:
              mockSaveMediaBuffer as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
          },
          pairing: {
            readAllowFromStore: mockReadAllowFromStore,
            upsertPairingRequest: mockUpsertPairingRequest,
            buildPairingReply: mockBuildPairingReply,
          },
        },
        media: {
          detectMime: vi.fn(async () => "application/octet-stream"),
        },
      }),
    );
  });

  it("does not enqueue inbound preview text as system events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-no-system-preview",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hi there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("uses authorizer resolution instead of hardcoded CommandAuthorized=true", async () => {
    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["ou-admin"],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-auth-bypass-regression",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        CommandAuthorized: false,
        SenderId: "ou-attacker",
        Surface: "feishu",
      }),
    );
  });

  it("reads pairing allow store for non-command DMs when dmPolicy is pairing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue(["ou-attacker"]);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-read-store-non-command",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockReadAllowFromStore).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
    });
    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("clarifies explicit current-line continuation when no reusable anchor exists", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-natural-reset-alias",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "继续这个研究线" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith("继续这个研究线", cfg);
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("memory/current-research-line.md 还不存在"),
    });
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("anchors explicit current-line continuation on current-research-line instead of stale quoted context", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-current-line-"));
    await seedCurrentResearchLine({ workspaceDir: tempDir });
    mockGetMessageFeishu.mockResolvedValueOnce({
      content: "quoted stale side thread about old open-source learning",
    });

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-current-line-anchor",
        parent_id: "msg-quoted-side-thread",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "继续当前研究线" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "继续当前研究线",
        CommandBody: "继续当前研究线",
        BodyForAgent: expect.stringContaining(
          "Resolve it against memory/current-research-line.md first, not against loose recent chat, quoted content, or stale side threads.",
        ),
      }),
    );
    const finalizeArg = mockFinalizeInboundContext.mock.calls[0]?.[0] as {
      BodyForAgent?: string;
    };
    expect(finalizeArg.BodyForAgent).toContain(
      "Current focus = Re-risk QQQ only if rates and dollar stop squeezing growth.",
    );
    expect(finalizeArg.BodyForAgent).toContain(
      "Top decision = Whether to stay patient on the current ETF transmission line instead of reopening the old open-source detour.",
    );
    expect(finalizeArg.BodyForAgent).toContain(
      "Next step = Re-check the current rates, dollar, and duration path before changing the working stance.",
    );
    expect(finalizeArg.BodyForAgent).toContain(
      '[Replying to: "quoted stale side thread about old open-source learning"]',
    );
  });

  it("anchors colloquial no-switch continuation on current-research-line", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-feishu-current-line-noswitch-"),
    );
    await seedCurrentResearchLine({ workspaceDir: tempDir });

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-current-line-noswitch",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "别换线，沿着上一轮继续下一步" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "别换线，沿着上一轮继续下一步",
        BodyForAgent: expect.stringContaining(
          "Treat this as explicit continuation of the current research line",
        ),
      }),
    );
    const finalizeArg = mockFinalizeInboundContext.mock.calls[0]?.[0] as {
      BodyForAgent?: string;
    };
    expect(finalizeArg.BodyForAgent).toContain(
      "Top decision = Whether to stay patient on the current ETF transmission line instead of reopening the old open-source detour.",
    );
  });

  it("returns an honest clarification for weak continuation asks instead of guessing a target", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-feishu-current-line-clarify-"),
    );
    await seedCurrentResearchLine({ workspaceDir: tempDir });
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-current-line-clarify",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "继续" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("我先不假装已经知道你要继续哪条研究线。"),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining(
        "- 当前研究线: Re-risk QQQ only if rates and dollar stop squeezing growth.",
      ),
    });
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("请直接说“继续当前研究线”或“当前研究线下一步是什么”"),
    });
    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-dm.md"),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("我先不假装已经知道你要继续哪条研究线。");
    expect(controlLedger).toContain("Session Key: agent:main:feishu:dm:ou-attacker");
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
  });

  it("fails closed when explicit current-line continuation is requested but the anchor is malformed", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-feishu-current-line-malformed-"),
    );
    await seedCurrentResearchLine({
      workspaceDir: tempDir,
      content: "# Current Research Line\n",
    });
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const cfg: ClawdbotConfig = {
      agents: { defaults: { workspace: tempDir } },
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-current-line-malformed",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "继续当前研究线" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("memory/current-research-line.md 存在但解析失败"),
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
  });

  it("keeps fundamental research prompts as natural language before dispatch", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const message = "把这些内容整理进当前基本面研究，并补一个 AAPL 和微软的 follow-up 清单";
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-fundamental-natural-language",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: message }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: message,
        CommandBody: message,
      }),
    );
  });

  it("records role drift but keeps a bound specialist chat on its own lane", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          surfaces: {
            fundamental_research: { chatId: "oc-fundamental" },
            technical_daily: { chatId: "oc-tech" },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-specialist-role-drift",
        chat_id: "oc-fundamental",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "去看看几个指数最新的风险和潜在收益" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: "agent:main:feishu:dm:ou-attacker:surface:fundamental_research",
        BodyForAgent: expect.stringContaining(
          "This specialist lane is pinned to fundamental_research",
        ),
      }),
    );
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "role_drift",
        source: "feishu.surface_routing",
        problem: "suppressed cross-surface drift from fundamental_research toward technical_daily",
      }),
    );
  });

  it("keeps frontier research prompts as natural language before dispatch", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const message = "继续这个方法研究，但先检查这个 paper 有没有 leakage 和 overfitting 风险";
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-frontier-natural-language",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: message }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: message,
        CommandBody: message,
      }),
    );
  });

  it("keeps macro research prompts as natural language before dispatch", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const message = "查一下最近美国非农、通胀预期和 QQQ / TLT 的关系";
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-macro-natural-language",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: message }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: message,
        CommandBody: message,
      }),
    );
  });

  it("keeps macro research prompts as natural language in group topic sessions", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const message = "查一下最近美国非农、通胀预期和 QQQ / TLT 的关系";
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-topic-user",
        },
      },
      message: {
        message_id: "msg-topic-macro-natural-language",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        message_type: "text",
        content: JSON.stringify({ text: message }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: message,
        CommandBody: message,
      }),
    );
  });

  it("keeps fundamental research prompts as natural language in group topic sessions", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const message = "把这些内容整理进当前基本面研究，并补一个 AAPL 和微软的 follow-up 清单";
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-topic-user",
        },
      },
      message: {
        message_id: "msg-topic-fundamental-natural-language",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        message_type: "text",
        content: JSON.stringify({ text: message }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: message,
        CommandBody: message,
      }),
    );
  });

  it("keeps frontier research prompts as natural language in group topic sessions", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const message = "继续这个方法研究，但先检查这个 paper 有没有 leakage 和 overfitting 风险";
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-topic-user",
        },
      },
      message: {
        message_id: "msg-topic-frontier-natural-language",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        message_type: "text",
        content: JSON.stringify({ text: message }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: message,
        CommandBody: message,
      }),
    );
  });

  it("clarifies explicit current-line continuation in group topic sessions when no reusable anchor exists", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-topic-user",
        },
      },
      message: {
        message_id: "msg-topic-natural-reset-alias",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        message_type: "text",
        content: JSON.stringify({ text: "继续这个研究线" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining("memory/current-research-line.md 还不存在"),
    });
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
  });

  it("skips sender-name lookup when resolveSenderNames is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["*"],
          resolveSenderNames: false,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-skip-sender-lookup",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuClient).not.toHaveBeenCalled();
  });

  it("propagates parent/root message ids into inbound context for reply reconstruction", async () => {
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_parent_001",
      chatId: "oc-group",
      content: "quoted content",
      contentType: "text",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-replier",
        },
      },
      message: {
        message_id: "om_reply_001",
        root_id: "om_root_001",
        parent_id: "om_parent_001",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "reply text" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToId: "om_parent_001",
        RootMessageId: "om_root_001",
        ReplyToBody: "quoted content",
      }),
    );
  });

  it("replies pairing challenge to DM chat_id instead of user:sender id", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          user_id: "u_mobile_only",
        },
      },
      message: {
        message_id: "msg-pairing-chat-reply",
        chat_id: "oc_dm_chat_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({ cfg, event });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_dm_chat_1",
      }),
    );
  });
  it("creates pairing request and drops unauthorized DMs in pairing mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-unapproved",
        },
      },
      message: {
        message_id: "msg-pairing-flow",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    const runtime = createRuntimeEnv();
    await handleFeishuMessage({ cfg, event, runtime });

    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
      id: "ou-unapproved",
      meta: { name: undefined },
    });
    expect(mockBuildPairingReply).toHaveBeenCalledWith({
      channel: "feishu",
      idLine: "Your Feishu user id: ou-unapproved",
      code: "ABCDEFGH",
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        accountId: "default",
      }),
    );
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "non-ledger early return reason=dm_pairing_gate chat=oc-dm message=msg-pairing-flow boundary=not_a_truth_surface_reply",
      ),
    );
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-group-command-auth",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: false, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: false,
        SenderId: "ou-attacker",
      }),
    );
  });

  it("falls back to top-level allowFrom for group command authorization", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          allowFrom: ["ou-admin"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-admin",
        },
      },
      message: {
        message_id: "msg-group-command-fallback",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: true }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: true,
        SenderId: "ou-admin",
      }),
    );
  });

  it("allows group sender when global groupSenderAllowFrom includes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-allowed",
        },
      },
      message: {
        message_id: "msg-global-group-sender-allow",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        SenderId: "ou-allowed",
      }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("blocks group sender when global groupSenderAllowFrom excludes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-blocked",
        },
      },
      message: {
        message_id: "msg-global-group-sender-block",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("prefers per-group allowFrom over global groupSenderAllowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-global"],
          groups: {
            "oc-group": {
              allowFrom: ["ou-group-only"],
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-global",
        },
      },
      message: {
        message_id: "msg-per-group-precedence",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops message when groupConfig.enabled is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-disabled-group": {
              enabled: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-disabled-group",
        chat_id: "oc-disabled-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("uses video file_key (not thumbnail image_key) for inbound video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-video-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "video",
        content: JSON.stringify({
          file_key: "file_video_payload",
          image_key: "img_thumb_payload",
          file_name: "clip.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-video-inbound",
        fileKey: "file_video_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("uses media message_type file_key (not thumbnail image_key) for inbound mobile video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-media-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_media_payload",
          image_key: "img_media_thumb",
          file_name: "mobile.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-media-inbound",
        fileKey: "file_media_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("downloads embedded media tags from post messages as files", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-post-media",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          title: "Rich text",
          content: [
            [
              {
                tag: "media",
                file_key: "file_post_media_payload",
                file_name: "embedded.mov",
              },
            ],
          ],
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-post-media",
        fileKey: "file_post_media_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
    );
  });

  it("includes message_id in BodyForAgent on its own line", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-msgid",
        },
      },
      message: {
        message_id: "msg-message-id-line",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "[message_id: msg-message-id-line]\nou-msgid: hello",
      }),
    );
  });

  it("expands merge_forward content from API sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const mockGetMerged = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: "container",
            msg_type: "merge_forward",
            body: { content: JSON.stringify({ text: "Merged and Forwarded Message" }) },
          },
          {
            message_id: "sub-2",
            upper_message_id: "container",
            msg_type: "file",
            body: { content: JSON.stringify({ file_name: "report.pdf" }) },
            create_time: "2000",
          },
          {
            message_id: "sub-1",
            upper_message_id: "container",
            msg_type: "text",
            body: { content: JSON.stringify({ text: "alpha" }) },
            create_time: "1000",
          },
        ],
      },
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: mockGetMerged,
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-merge",
        },
      },
      message: {
        message_id: "msg-merge-forward",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockGetMerged).toHaveBeenCalledWith({
      path: { message_id: "msg-merge-forward" },
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "[Merged and Forwarded Messages]\n- alpha\n- [File: report.pdf]",
        ),
      }),
    );
  });

  it("falls back when merge_forward API returns no sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-merge-empty",
        },
      },
      message: {
        message_id: "msg-merge-empty",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("[Merged and Forwarded Message - could not fetch]"),
      }),
    );
  });

  it("dispatches once and appends permission notice to the main agent body", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied https://open.feishu.cn/app/cli_test",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-perm",
        },
      },
      message: {
        message_id: "msg-perm-1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "Permission grant URL: https://open.feishu.cn/app/cli_test",
        ),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm: hello group"),
      }),
    );
  });

  it("ignores stale non-existent contact scope permission errors", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied: contact:contact.base:readonly https://open.feishu.cn/app/cli_scope_bug",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_scope_bug",
          appSecret: "sec_scope_bug",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-perm-scope",
        },
      },
      message: {
        message_id: "msg-perm-scope-1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.not.stringContaining("Permission grant URL"),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm-scope: hello group"),
      }),
    );
  });

  it("routes group sessions by sender when groupSessionScope=group_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-scope-user" } },
      message: {
        message_id: "msg-scope-group-sender",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "group sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:sender:ou-scope-user" },
        parentPeer: null,
      }),
    );
  });

  it("routes topic sessions and parentPeer when groupSessionScope=group_topic_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-sender",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("keeps root_id as topic key when root_id and thread_id both exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-thread-id",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses thread_id as topic key when root_id is missing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-thread-only",
        chat_id: "oc-group",
        chat_type: "group",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:omt_topic_1:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to group_topic routing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          topicSessionMode: "enabled",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-legacy" } },
      message: {
        message_id: "msg-legacy-topic-mode",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_legacy",
        message_type: "text",
        content: JSON.stringify({ text: "legacy topic mode" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_legacy" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to root_id when both root_id and thread_id exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          topicSessionMode: "enabled",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-legacy-thread-id" } },
      message: {
        message_id: "msg-legacy-topic-thread-id",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_legacy",
        thread_id: "omt_topic_legacy",
        message_type: "text",
        content: JSON.stringify({ text: "legacy topic mode" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_legacy" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses message_id as topic root when group_topic + replyInThread and no root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-new-topic-root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "create topic" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-new-topic-root" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("ignores blank root_id and still uses message_id as the first topic root", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-empty-root",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "   ",
        thread_id: "   ",
        message_type: "text",
        content: JSON.stringify({ text: "create topic from blank root" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-empty-root" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "msg-empty-root",
        rootId: undefined,
      }),
    );
  });

  it("keeps topic session key stable after first turn creates a thread", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const firstTurn: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-topic-first",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "create topic" }),
      },
    };
    const secondTurn: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-topic-second",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "msg-topic-first",
        thread_id: "omt_topic_created",
        message_type: "text",
        content: JSON.stringify({ text: "follow up in same topic" }),
      },
    };

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-topic-first" },
      }),
    );
    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-topic-first" },
      }),
    );
  });

  it("replies to the topic root when handling a message inside an existing topic", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_child_message",
        root_id: "om_root_topic",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "reply inside topic" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_root_topic",
        rootId: "om_root_topic",
      }),
    );
  });

  it("forces thread replies when inbound message contains thread_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group",
              replyInThread: "disabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-thread-reply" } },
      message: {
        message_id: "msg-thread-reply",
        chat_id: "oc-group",
        chat_type: "group",
        thread_id: "omt_topic_thread_reply",
        message_type: "text",
        content: JSON.stringify({ text: "thread content" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyInThread: true,
        threadReply: true,
      }),
    );
  });

  it("does not dispatch twice for the same image message_id (concurrent dedupe)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-image-dedup",
        },
      },
      message: {
        message_id: "msg-image-dedup",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({
          image_key: "img_dedup_payload",
        }),
      },
    };

    await Promise.all([dispatchMessage({ cfg, event }), dispatchMessage({ cfg, event })]);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});

describe("toMessageResourceType", () => {
  it("maps image to image", () => {
    expect(toMessageResourceType("image")).toBe("image");
  });

  it("maps audio to file", () => {
    expect(toMessageResourceType("audio")).toBe("file");
  });

  it("maps video/file/sticker to file", () => {
    expect(toMessageResourceType("video")).toBe("file");
    expect(toMessageResourceType("file")).toBe("file");
    expect(toMessageResourceType("sticker")).toBe("file");
  });
});

describe("resolveBroadcastAgents", () => {
  it("returns agent list when broadcast config has the peerId", () => {
    const cfg = { broadcast: { oc_group123: ["susan", "main"] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toEqual(["susan", "main"]);
  });

  it("returns null when no broadcast config", () => {
    const cfg = {} as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });

  it("returns null when peerId not in broadcast", () => {
    const cfg = { broadcast: { oc_other: ["susan"] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });

  it("returns null when agent list is empty", () => {
    const cfg = { broadcast: { oc_group123: [] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });
});

describe("buildBroadcastSessionKey", () => {
  it("replaces agent ID prefix in session key", () => {
    expect(buildBroadcastSessionKey("agent:main:feishu:group:oc_group123", "main", "susan")).toBe(
      "agent:susan:feishu:group:oc_group123",
    );
  });

  it("handles compound peer IDs", () => {
    expect(
      buildBroadcastSessionKey(
        "agent:main:feishu:group:oc_group123:sender:ou_user1",
        "main",
        "susan",
      ),
    ).toBe("agent:susan:feishu:group:oc_group123:sender:ou_user1");
  });

  it("returns base key unchanged when prefix does not match", () => {
    expect(buildBroadcastSessionKey("custom:key:format", "main", "susan")).toBe(
      "custom:key:format",
    );
  });
});

describe("buildSurfaceScopedSessionKey", () => {
  it("keeps control-room traffic on the base session key", () => {
    expect(buildSurfaceScopedSessionKey("agent:main:feishu:group:oc_main", "control_room")).toBe(
      "agent:main:feishu:group:oc_main",
    );
  });

  it("adds a specialist surface suffix once", () => {
    expect(
      buildSurfaceScopedSessionKey("agent:main:feishu:group:oc_main", "learning_command"),
    ).toBe("agent:main:feishu:group:oc_main:surface:learning_command");
    expect(
      buildSurfaceScopedSessionKey(
        "agent:main:feishu:group:oc_main:surface:learning_command",
        "learning_command",
      ),
    ).toBe("agent:main:feishu:group:oc_main:surface:learning_command");
  });
});

describe("resolveFeishuEffectiveStateSurface", () => {
  it("pins broad control-room aggregate asks to the control-room state surface", () => {
    const surfaceRouting = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          control_room: { chatId: "oc-control" },
        },
      } as unknown as FeishuConfig,
      chatId: "oc-control",
      content: "把今天的系统健康、学习状态、研究状态一起讲给我",
    });
    const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
      currentSurface: surfaceRouting.currentSurface,
      targetSurface: surfaceRouting.targetSurface,
      content: "把今天的系统健康、学习状态、研究状态一起讲给我",
    });

    expect(surfaceRouting.targetSurface).toBe("ops_audit");
    expect(
      resolveFeishuEffectiveStateSurface({
        surfaceRouting,
        controlRoomOrchestration,
      }),
    ).toBe("control_room");
  });

  it("keeps explicit single-specialist asks on their specialist state surface", () => {
    const surfaceRouting = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          control_room: { chatId: "oc-control" },
        },
      } as unknown as FeishuConfig,
      chatId: "oc-control",
      content: "去看看几个指数最新的风险和潜在收益",
    });
    const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
      currentSurface: surfaceRouting.currentSurface,
      targetSurface: surfaceRouting.targetSurface,
      content: "去看看几个指数最新的风险和潜在收益",
    });

    expect(surfaceRouting.targetSurface).toBe("technical_daily");
    expect(
      resolveFeishuEffectiveStateSurface({
        surfaceRouting,
        controlRoomOrchestration,
      }),
    ).toBe("technical_daily");
  });
});

describe("broadcast dispatch", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: unknown) => ctx);
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } });
  const mockWithReplyDispatcher = vi.fn(
    async ({
      dispatcher,
      run,
      onSettled,
    }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
      try {
        return await run();
      } finally {
        dispatcher.markComplete();
        try {
          await dispatcher.waitForIdle();
        } finally {
          await onSettled?.();
        }
      }
    },
  );
  const mockShouldComputeCommandAuthorized = vi.fn(() => false);
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/inbound-clip.mp4",
    contentType: "video/mp4",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-broadcast-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    setFeishuRuntime({
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      channel: {
        routing: {
          resolveAgentRoute: mockResolveAgentRoute,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
          formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
          finalizeInboundContext: mockFinalizeInboundContext,
          dispatchReplyFromConfig: mockDispatchReplyFromConfig,
          withReplyDispatcher: mockWithReplyDispatcher,
        },
        commands: {
          shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        },
        media: {
          saveMediaBuffer: mockSaveMediaBuffer,
        },
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
          upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
          buildPairingReply: vi.fn(() => "Pairing response"),
        },
      },
      media: {
        detectMime: vi.fn(async () => "application/octet-stream"),
      },
    } as unknown as PluginRuntime);
  });

  it("dispatches to all broadcast agents when bot is mentioned", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-mentioned",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello @bot" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    // Both agents should get dispatched
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    // Verify session keys for both agents
    const sessionKeys = mockFinalizeInboundContext.mock.calls.map(
      (call: unknown[]) => (call[0] as { SessionKey: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");

    // Active agent (mentioned) gets the real Feishu reply dispatcher
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("persists the final broadcast control-room summary into the surface ledger", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-broadcast-ledger-"));
    mockDispatchReplyFromConfig.mockImplementation(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
今天先看风险框架，不追高。

## Technical Slice
publish: yes
confidence: high
QQQ / SPY / TLT 先看谁对长端利率更敏感。
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { defaults: { workspace: tempDir }, list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
          surfaces: {
            control_room: { chatId: "oc-broadcast-group" },
            technical_daily: { chatId: "oc-tech-broadcast" },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-surface-ledger",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "今天该关注什么，给我一个总览 @bot" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-broadcast-group.md"),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("今天先看风险框架，不追高。");
    expect(controlLedger).toContain("Distribution: published technical slice.");
    expect(controlLedger).not.toContain("publish: yes");
    expect(controlLedger).not.toContain("confidence: high");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the learning-loop summary in broadcast daily-brief ledgers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-broadcast-brief-"));
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-broadcast-brief-1",
      status: "running",
      deadlineAt: "2026-04-10T13:00:00.000Z",
      lastHeartbeatAt: "2026-04-10T12:40:00.000Z",
      iterationsCompleted: 1,
      iterationsFailed: 0,
      receiptsPath:
        "memory/feishu-learning-timeboxes/timebox-running-broadcast-brief-1.receipts.jsonl",
    });
    mockDispatchReplyFromConfig.mockImplementation(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: `
## Control Summary
今天先看哪些链条有空白。
`,
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { defaults: { workspace: tempDir }, list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
          surfaces: {
            control_room: { chatId: "oc-broadcast-group" },
            learning_command: { chatId: "oc-learning-broadcast" },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-daily-brief-ledger",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "给我今天的健康卓越日报 @bot" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-broadcast-group.md"),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain(
      "Learning loop: active session timebox-running-broadcast-brief-1",
    );
    expect(controlLedger).toContain("最近落账: 还没找到最新 lobster-workface 学习包。");
    expect(controlLedger).toContain("Protected anchors: present none; missing");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("answers broadcast control-room learning status asks from local status truth instead of normal broadcast dispatch", async () => {
    const tempDir = await createFeishuLearningStatusWorkspace();
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-broadcast-status-1",
      deadlineAt: "2026-04-09T15:00:00.000Z",
      status: "running",
      iterationsCompleted: 1,
      iterationsFailed: 0,
    });
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue(undefined);
    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: "this should not run for local learning status intercept",
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { defaults: { workspace: tempDir }, list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
          surfaces: {
            control_room: { chatId: "oc-broadcast-group" },
            learning_command: { chatId: "oc-learning-broadcast" },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-learning-status",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "学习 session 现在还活着吗 @bot" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("## Learning status"),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("timebox-running-broadcast-status-1"),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("学习 chat: oc-learning-broadcast"),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("最近落账: 还没找到最新 lobster-workface 学习包。"),
      }),
    );
    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Protected anchors: present memory/current-research-line.md"),
      }),
    );
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-broadcast-group.md"),
      "utf-8",
    );
    expect(controlLedger).toContain("Reply summary:");
    expect(controlLedger).toContain("timebox-running-broadcast-status-1");
    expect(controlLedger).toContain("学习 chat: oc-learning-broadcast");
    expect(controlLedger).toContain("最近落账: 还没找到最新 lobster-workface 学习包。");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("dedupes broadcast control-room learning-status intercepts across accounts", async () => {
    const tempDir = await createFeishuLearningStatusWorkspace();
    const baseDispatcher = {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete: vi.fn(),
    };
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: baseDispatcher,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
    mockFindRunningFeishuLearningTimeboxSession.mockReturnValue({
      sessionId: "timebox-running-broadcast-dedup-1",
      deadlineAt: "2026-04-09T16:00:00.000Z",
      status: "running",
      iterationsCompleted: 1,
      iterationsFailed: 0,
    });
    mockFindLatestFeishuLearningTimeboxSession.mockResolvedValue(undefined);
    const mockDispatchReplyFromConfig = vi.fn(
      async ({
        dispatcher,
      }: {
        dispatcher: {
          sendFinalReply: (payload: { text?: string }) => boolean;
        };
      }) => {
        dispatcher.sendFinalReply({
          text: "this should not run for broadcast learning status intercept dedupe",
        });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    const mockWithReplyDispatcher = vi.fn(
      async ({
        dispatcher,
        run,
        onSettled,
      }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
        try {
          return await run();
        } finally {
          dispatcher.markComplete();
          try {
            await dispatcher.waitForIdle();
          } finally {
            await onSettled?.();
          }
        }
      },
    );

    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
      }),
    );

    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { defaults: { workspace: tempDir }, list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
          surfaces: {
            control_room: { chatId: "oc-broadcast-group" },
            learning_command: { chatId: "oc-learning-broadcast" },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-learning-status-dedup",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "学习 session 现在还活着吗 @bot" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      accountId: "account-A",
    });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      accountId: "account-B",
    });

    expect(baseDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    const controlLedger = await fs.readFile(
      path.join(tempDir, "memory", "feishu-surface-lines", "control_room-oc-broadcast-group.md"),
      "utf-8",
    );
    expect(controlLedger.match(/^### /gm)?.length ?? 0).toBe(1);
    expect(controlLedger).toContain("timebox-running-broadcast-dedup-1");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("skips broadcast dispatch when bot is NOT mentioned (requireMention=true)", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-not-mentioned",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello everyone" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    // No dispatch: requireMention=true and bot not mentioned → returns early.
    // The mentioned bot's handler (on another account or same account with
    // matching botOpenId) will handle broadcast dispatch for all agents.
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
  });

  it("preserves single-agent dispatch when no broadcast config", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-no-broadcast",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    // Single dispatch (no broadcast)
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: "agent:main:feishu:group:oc-broadcast-group",
      }),
    );
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-multi-account-dedup",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    // First account handles broadcast normally
    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-A",
    });
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    mockDispatchReplyFromConfig.mockClear();
    mockFinalizeInboundContext.mockClear();

    // Second account: same message ID, different account.
    // Per-account dedup passes (different namespace), but cross-account
    // broadcast dedup blocks dispatch.
    const secondRuntime = createRuntimeEnv();
    await handleFeishuMessage({
      cfg,
      event,
      runtime: secondRuntime,
      accountId: "account-B",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(secondRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "non-ledger early return reason=broadcast_dispatch_already_claimed chat=oc-broadcast-group message=msg-multi-account-dedup boundary=not_a_truth_surface_reply",
      ),
    );
  });

  it("skips unknown agents not in agents.list", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-unknown-agent",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    const runtime = createRuntimeEnv();
    await handleFeishuMessage({
      cfg,
      event,
      runtime,
    });

    // Only susan should get dispatched (unknown-agent skipped)
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const sessionKey = (mockFinalizeInboundContext.mock.calls[0]?.[0] as { SessionKey: string })
      .SessionKey;
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "non-ledger early return reason=broadcast_unknown_agent chat=oc-broadcast-group message=msg-broadcast-unknown-agent boundary=not_a_truth_surface_reply",
      ),
    );
  });

  it("records an anomaly when broadcast has no active visible reply agent", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-no-active-visible",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.broadcast",
        problem: "broadcast dispatch has no active visible reply agent",
        evidence: expect.arrayContaining([
          "active_agent=main",
          "broadcast_agents=susan",
          "known_agents=main,susan",
          "chat_id=oc-broadcast-group",
          "message_id=msg-broadcast-no-active-visible",
        ]),
      }),
    );
  });
});
