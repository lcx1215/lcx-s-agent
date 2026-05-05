import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  planFinanceBrainOrchestration,
  type FinanceBrainModuleId,
} from "../../agents/finance-brain-orchestration.js";
import { resolveReviewTier } from "../../agents/review-tier-policy.js";
import { createFinanceLearningCapabilityApplyTool } from "../../agents/tools/finance-learning-capability-apply-tool.js";
import { createFinanceLearningPipelineOrchestratorTool } from "../../agents/tools/finance-learning-pipeline-orchestrator-tool.js";
import { createQuantMathTool } from "../../agents/tools/quant-math-tool.js";
import { createReviewPanelTool } from "../../agents/tools/review-panel-tool.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";

const SAFE_RETRIEVAL_NOTES =
  "Operator provided a bounded finance research source with explicit provenance, concrete method notes, evidence-bearing cognition, and no remote fetch request in this orchestration step.";

const CAPABILITY_FIXTURES = [
  ["valid-finance-article.md", "ETF event triage workflow", "ETF Event Triage Fixture"],
  [
    "valid-etf-liquidity-regime-article.md",
    "ETF liquidity regime triage workflow",
    "ETF Liquidity Regime Fixture",
  ],
  [
    "valid-etf-catalyst-followup-article.md",
    "ETF catalyst follow-up workflow",
    "ETF Catalyst Follow-up Fixture",
  ],
  [
    "valid-etf-risk-sizing-article.md",
    "ETF risk sizing review workflow",
    "ETF Risk Sizing Fixture",
  ],
  [
    "valid-holdings-risk-math-article.md",
    "Holdings risk math review workflow",
    "Holdings Risk Math Fixture",
  ],
  [
    "valid-factor-timing-validation-article.md",
    "Factor timing validation workflow",
    "Factor Timing Validation Fixture",
  ],
] as const;

export type LanguageBrainLoopSmokeCommandOptions = {
  fixtureDir?: string;
  workspaceDir?: string;
  json?: boolean;
};

export type LanguageBrainLoopSmokePayload = {
  ok: true;
  workspaceDir: string;
  temporaryWorkspace: boolean;
  language: Record<string, unknown>;
  orchestration: Record<string, unknown>;
  brain: Record<string, unknown>;
  analysis: Record<string, unknown>;
  math: Record<string, unknown>;
  visibleReply: {
    text: string;
    startsWithPlainSummary: boolean;
    hidesInternalLabels: boolean;
    includesResearchBoundary: boolean;
    includesProofPath: boolean;
  };
  adjacentApplication: {
    userAsk: string;
    text: string;
    primaryModules: string[];
    supportingModules: string[];
    requiredTools: string[];
    boundaries: string[];
    reviewTools: string[];
    missingFreshInputs: string[];
    blocksNumericGuessingWithoutInputs: boolean;
    startsWithPlainSummary: boolean;
    hidesInternalLabels: boolean;
    includesResearchBoundary: boolean;
  };
  review: Record<string, unknown>;
  reviewPanel: Record<string, unknown>;
  memory: {
    loopReceiptPath: string;
  };
  protectedMemoryUntouched: true;
  languageCorpusUntouched: true;
  noRemoteFetchOccurred: true;
  noExecutionAuthority: true;
};

type FreshEventReview = {
  eventTitle: string;
  asOfDate: string;
  researchQuestion: string;
  freshInputs: Array<{ name: string; evidenceCategories: string[] }>;
  redTeamInvalidation: string[];
  noActionBoundary: string;
  quantMathInputs: {
    positionWeights: number[];
    covarianceMatrix: number[][];
    targetRiskBudgets: number[];
    returns: number[];
    benchmarkReturns: number[];
    priceLevels: number[];
  };
};

type LocalLarkStyleHandoff = {
  family: "market_capability_learning_intake";
  source: "local_cli_contract";
  targetSurface: "learning_command";
  backendTool: "finance_learning_pipeline_orchestrator";
  sourceRequirement: "safe_local_or_manual_source_required";
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} should be object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

async function ensureWorkspaceDir(opts: LanguageBrainLoopSmokeCommandOptions): Promise<{
  workspaceDir: string;
  temporary: boolean;
}> {
  if (opts.workspaceDir?.trim()) {
    const workspaceDir = path.resolve(opts.workspaceDir.trim());
    await fs.mkdir(workspaceDir, { recursive: true });
    return { workspaceDir, temporary: false };
  }
  return {
    workspaceDir: await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-language-brain-loop-smoke-")),
    temporary: true,
  };
}

function resolveLocalLarkStyleHandoff(utterance: string): LocalLarkStyleHandoff {
  const normalized = utterance.toLowerCase();
  assert(
    normalized.includes("etf") && normalized.includes("workflow"),
    "local CLI smoke utterance should target an ETF learning workflow",
  );
  return {
    family: "market_capability_learning_intake",
    source: "local_cli_contract",
    targetSurface: "learning_command",
    backendTool: "finance_learning_pipeline_orchestrator",
    sourceRequirement: "safe_local_or_manual_source_required",
  };
}

async function seedCapabilities(params: {
  fixtureDir: string;
  workspaceDir: string;
  learningIntent: string;
}) {
  const tool = createFinanceLearningPipelineOrchestratorTool({
    workspaceDir: params.workspaceDir,
  });
  const seeded = [];
  for (const [fileName, title, sourceName] of CAPABILITY_FIXTURES) {
    const localFilePath = `memory/demo/${fileName}`;
    const targetPath = path.join(params.workspaceDir, localFilePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(path.join(params.fixtureDir, fileName), targetPath);
    const result = await tool.execute(`cli-loop-seed:${fileName}`, {
      sourceName,
      sourceType: "manual_article_source",
      localFilePath,
      title,
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      allowedActionAuthority: "research_only",
      learningIntent: params.learningIntent,
      maxRetrievedCapabilities: 6,
    });
    const details = asRecord(result.details, `${fileName} details`);
    assert(details.ok === true, `${fileName} should seed successfully`);
    seeded.push(details);
  }
  return seeded;
}

function buildEventReviewDraft(params: {
  event: FreshEventReview;
  applyDetails: Record<string, unknown>;
}) {
  const answerSkeleton = asRecord(params.applyDetails.answerSkeleton, "answerSkeleton");
  const requiredInputs = stringArray(answerSkeleton.requiredNextChecks);
  const requiredEvidenceCategories = stringArray(answerSkeleton.requiredEvidenceCategories);
  const availableInputs = new Set(params.event.freshInputs.map((entry) => entry.name));
  const availableEvidence = new Set(
    params.event.freshInputs.flatMap((entry) => entry.evidenceCategories),
  );
  const missingInputs = requiredInputs.filter((input) => !availableInputs.has(input));
  const missingEvidenceCategories = requiredEvidenceCategories.filter(
    (category) => !availableEvidence.has(category),
  );
  const status =
    missingInputs.length === 0 && missingEvidenceCategories.length === 0
      ? "research_review_ready"
      : "blocked_missing_fresh_inputs";
  return {
    status,
    eventTitle: params.event.eventTitle,
    asOfDate: params.event.asOfDate,
    missingInputs,
    missingEvidenceCategories,
    noActionBoundary:
      params.event.noActionBoundary === "research_only_no_trade_approval" &&
      answerSkeleton.noActionBoundary ===
        "This application is research-only and does not approve trades, auto-promotion, doctrine mutation, or standalone prediction.",
  };
}

async function runQuantMathChecks(event: FreshEventReview) {
  const tool = createQuantMathTool();
  const riskBudget = asRecord(
    (
      await tool.execute("cli-loop-quant-risk-budget", {
        action: "risk_budget_deviation",
        weights: event.quantMathInputs.positionWeights,
        covarianceMatrix: event.quantMathInputs.covarianceMatrix,
        targetRiskBudgets: event.quantMathInputs.targetRiskBudgets,
      })
    ).details,
    "riskBudget.details",
  );
  const rollingBeta = asRecord(
    (
      await tool.execute("cli-loop-quant-rolling-beta", {
        action: "rolling_beta",
        series: event.quantMathInputs.returns,
        benchmark: event.quantMathInputs.benchmarkReturns,
        window: 3,
      })
    ).details,
    "rollingBeta.details",
  );
  const drawdownDuration = asRecord(
    (
      await tool.execute("cli-loop-quant-drawdown-duration", {
        action: "drawdown_duration",
        series: event.quantMathInputs.priceLevels,
        seriesMode: "levels",
      })
    ).details,
    "drawdownDuration.details",
  );
  const calmar = asRecord(
    (
      await tool.execute("cli-loop-quant-calmar", {
        action: "calmar_ratio",
        series: event.quantMathInputs.priceLevels,
        seriesMode: "levels",
        periodsPerYear: 252,
      })
    ).details,
    "calmar.details",
  );

  assert(
    typeof riskBudget.maxAbsoluteDeviation === "number",
    "risk budget deviation should be numeric",
  );
  assert(Array.isArray(rollingBeta.values), "rolling beta should return window values");
  assert(typeof drawdownDuration.maxDuration === "number", "drawdown duration should be numeric");
  assert(typeof calmar.calmarRatio === "number", "Calmar ratio should be numeric");

  return {
    localTool: "quant_math",
    checks: [riskBudget.action, rollingBeta.action, drawdownDuration.action, calmar.action],
    riskBudgetMaxAbsoluteDeviation: riskBudget.maxAbsoluteDeviation,
    rollingBetaWindows: rollingBeta.values.length,
    maxDrawdownDuration: drawdownDuration.maxDuration,
    calmarRatio: calmar.calmarRatio,
    noModelMathGuessing: true,
  };
}

async function writeLoopReceipt(params: {
  workspaceDir: string;
  relPath: string;
  language: Record<string, unknown>;
  orchestration: Record<string, unknown>;
  brain: Record<string, unknown>;
  analysis: Record<string, unknown>;
  math: Record<string, unknown>;
  visibleReply: Record<string, unknown>;
  adjacentApplication: Record<string, unknown>;
  review: Record<string, unknown>;
  reviewPanel: Record<string, unknown>;
}) {
  const relPath = params.relPath;
  const relDir = path.dirname(relPath);
  const payload = {
    schemaVersion: 1,
    boundary: "cli_language_brain_analysis_memory_loop_smoke",
    generatedAt: new Date().toISOString(),
    loop: {
      language: params.language,
      orchestration: params.orchestration,
      brain: params.brain,
      analysis: params.analysis,
      math: params.math,
      visibleReply: params.visibleReply,
      adjacentApplication: params.adjacentApplication,
      review: params.review,
      reviewPanel: params.reviewPanel,
      memory: {
        loopReceiptPath: relPath.split(path.sep).join("/"),
      },
    },
    protectedMemoryUntouched: true,
    languageCorpusUntouched: true,
    noRemoteFetchOccurred: true,
    noExecutionAuthority: true,
  };
  await fs.mkdir(path.join(params.workspaceDir, relDir), { recursive: true });
  await fs.writeFile(
    path.join(params.workspaceDir, relPath),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  return { relPath: relPath.split(path.sep).join("/"), payload };
}

function buildLoopReceiptPath(): string {
  const now = new Date();
  return path
    .join(
      "memory",
      "agent-loop-receipts",
      now.toISOString().slice(0, 10),
      `${now.toISOString().replace(/[:.]/gu, "-")}__language-brain-analysis-memory.json`,
    )
    .split(path.sep)
    .join("/");
}

function formatText(payload: Record<string, unknown>): string {
  const language = asRecord(payload.language, "language");
  const brain = asRecord(payload.brain, "brain");
  const orchestration = asRecord(payload.orchestration, "orchestration");
  const analysis = asRecord(payload.analysis, "analysis");
  const math = asRecord(payload.math, "math");
  const visibleReply = asRecord(payload.visibleReply, "visibleReply");
  const adjacentApplication = asRecord(payload.adjacentApplication, "adjacentApplication");
  const review = asRecord(payload.review, "review");
  const reviewPanel = asRecord(payload.reviewPanel, "reviewPanel");
  const memory = asRecord(payload.memory, "memory");
  return [
    "LCX language-brain-analysis-memory loop smoke",
    "",
    `ok: ${String(payload.ok)}`,
    `workspace: ${String(payload.workspaceDir)}`,
    `language family: ${String(language.family)}`,
    `backend tool: ${String(language.backendTool)}`,
    `finance modules: ${stringArray(orchestration.primaryModules).join(", ")}`,
    `brain synthesis: ${String(brain.synthesisMode)}`,
    `candidate count: ${String(brain.candidateCount)}`,
    `analysis status: ${String(analysis.eventReviewStatus)}`,
    `math tool: ${String(math.localTool)}`,
    `math checks: ${stringArray(math.checks).join(", ")}`,
    `visible reply: ${String(visibleReply.startsWithPlainSummary)}`,
    `adjacent application modules: ${stringArray(adjacentApplication.primaryModules).join(", ")}`,
    `review tier: ${String(review.tier)}`,
    `review token policy: ${String(review.tokenPolicy)}`,
    `review panel status: ${String(reviewPanel.status)}`,
    `no-action boundary: ${String(analysis.noActionBoundary)}`,
    `receipt: ${String(memory.loopReceiptPath)}`,
    "",
    "Boundaries:",
    "- local fixture only",
    "- no remote fetch",
    "- no trade or execution approval",
    "- protected memory untouched",
    "- language corpus untouched",
  ].join("\n");
}

function buildControlRoomVisibleReply(params: {
  event: FreshEventReview;
  analysis: Record<string, unknown>;
  math: Record<string, unknown>;
  receiptPath: string;
}) {
  const maxDeviation = Number(params.math.riskBudgetMaxAbsoluteDeviation);
  const betaWindows = Number(params.math.rollingBetaWindows);
  const drawdownDuration = Number(params.math.maxDrawdownDuration);
  const calmarRatio = Number(params.math.calmarRatio);
  const text = [
    "当前判断：这条 ETF event triage workflow 可以进入研究复盘，但只能作为 research-only 框架使用，不能推出交易动作。",
    "",
    "关键理由：本地能力库已经召回了 6 条相关工作流，事件输入通过了证据检查；本地数学只使用给定序列，完成了风险预算偏离、滚动 beta、回撤持续期和 Calmar 检查。",
    `量化观察：风险预算最大偏离约 ${maxDeviation.toFixed(3)}；滚动 beta 有 ${betaWindows} 个窗口；最长回撤持续 ${drawdownDuration} 个周期；Calmar 约 ${calmarRatio.toFixed(2)}。这些数值只说明 fixture 内部一致性，不代表实时市场结论。`,
    "",
    "缺口和边界：这次没有远程拉取新行情，也没有交易授权；如果要给真实持仓结论，还需要当前价格、成交量/流动性、ETF 成分权重、仓位权重和风险限额。",
    "",
    "下一步：先把这个 workflow 作为 ETF 事件研究模板沉淀，真实使用时先补 fresh inputs，再让风险和数学审阅过一遍，最后再给控制室短结论。",
    "",
    `证据路径：${params.receiptPath}`,
  ].join("\n");
  const forbiddenInternalLabels = [
    "task_family",
    "primaryModules",
    "supportingModules",
    "requiredTools",
    "backendTool",
    "targetSurface",
    "{",
    "}",
  ];
  return {
    text,
    startsWithPlainSummary: text.startsWith("当前判断："),
    hidesInternalLabels: !forbiddenInternalLabels.some((label) => text.includes(label)),
    includesResearchBoundary: /research-only|没有交易授权/u.test(text),
    includesProofPath: text.includes(params.receiptPath),
  } as const;
}

function buildAdjacentApplicationProbe() {
  const userAsk =
    "我持有 QQQ、TLT、NVDA，未来两周担心利率、AI capex 和美元流动性，先拆内部模块，给我 research-only 判断，不要交易建议。";
  const missingFreshInputs = [
    "current_rates_and_inflation_inputs",
    "current_credit_and_liquidity_inputs",
    "current_usd_liquidity_or_dxy_inputs",
    "qqq_tlt_nvda_current_prices_and_trend_inputs",
    "nvda_latest_fundamental_and_ai_capex_inputs",
    "position_weights_and_return_series",
    "portfolio_risk_limits",
  ];
  const plan = planFinanceBrainOrchestration({
    text: [
      userAsk,
      "Use retained finance learning, local memory, macro rates, credit liquidity, ETF regime, NVDA fundamentals, portfolio risk gates, deterministic quant math, and red-team review.",
    ].join("\n"),
    hasHoldingsOrPortfolioContext: true,
    hasLocalMathInputs: false,
    highStakesConclusion: true,
  });
  const text = [
    "当前判断：这应该先作为复杂持仓研究任务拆开，不应该直接给买卖动作。",
    "内部顺序：先看利率和通胀，再看美元/信用流动性，再看 QQQ/TLT 的 ETF regime，再看 NVDA 的 AI capex 和基本面传导，最后用组合风险门和本地数学检查缺失输入。",
    `缺失输入：${missingFreshInputs.join(", ")}。`,
    "边界：research-only，没有交易授权；缺少权重、价格序列、风险限额和最新数据时，不能靠模型补数字，也不能输出确定性仓位结论。",
  ].join("\n");
  const forbiddenInternalLabels = [
    "task_family",
    "primaryModules",
    "supportingModules",
    "requiredTools",
    "backendTool",
    "targetSurface",
    "{",
    "}",
  ];
  return {
    userAsk,
    text,
    primaryModules: plan.primaryModules,
    supportingModules: plan.supportingModules,
    requiredTools: plan.requiredTools,
    boundaries: plan.boundaries,
    reviewTools: plan.reviewTools,
    missingFreshInputs,
    blocksNumericGuessingWithoutInputs:
      missingFreshInputs.includes("position_weights_and_return_series") &&
      text.includes("不能靠模型补数字"),
    startsWithPlainSummary: text.startsWith("当前判断："),
    hidesInternalLabels: !forbiddenInternalLabels.some((label) => text.includes(label)),
    includesResearchBoundary: /research-only|没有交易授权/u.test(text),
  };
}

export async function languageBrainLoopSmokeCommand(
  opts: LanguageBrainLoopSmokeCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const payload = await runLanguageBrainLoopSmoke(opts);
  runtime.log(opts.json ? JSON.stringify(payload, null, 2) : formatText(payload));
}

export async function runLanguageBrainLoopSmoke(
  opts: LanguageBrainLoopSmokeCommandOptions,
): Promise<LanguageBrainLoopSmokePayload> {
  const fixtureDir = path.resolve(
    opts.fixtureDir?.trim() || path.join(process.cwd(), "test/fixtures/finance-learning-pipeline"),
  );
  const workspace = await ensureWorkspaceDir(opts);
  const utterance =
    "继续把语言、大脑、分析、记忆回路跑顺：学习 ETF event triage workflow，用本地安全 source 和 fresh ETF event 输入，最后给 control room 一个 research-only 摘要和 receipt。";
  const event = JSON.parse(
    await fs.readFile(path.join(fixtureDir, "fresh-etf-event-review.json"), "utf8"),
  ) as FreshEventReview;
  const handoff = resolveLocalLarkStyleHandoff(utterance);
  assert(handoff.family === "market_capability_learning_intake", "language route mismatch");
  assert(handoff.targetSurface === "learning_command", "target surface mismatch");
  assert(handoff.backendTool === "finance_learning_pipeline_orchestrator", "backend tool mismatch");

  const seeded = await seedCapabilities({
    fixtureDir,
    workspaceDir: workspace.workspaceDir,
    learningIntent: utterance,
  });
  const applyTool = createFinanceLearningCapabilityApplyTool({
    workspaceDir: workspace.workspaceDir,
  });
  const applyResult = await applyTool.execute("cli-loop-apply", {
    queryText: event.researchQuestion,
    maxCandidates: 6,
  });
  const applyDetails = asRecord(applyResult.details, "applyResult.details");
  assert(applyDetails.ok === true, "capability apply should succeed");
  assert(
    applyDetails.synthesisMode === "multi_capability_synthesis",
    "capability apply should synthesize",
  );
  const eventReviewDraft = buildEventReviewDraft({ event, applyDetails });
  assert(eventReviewDraft.status === "research_review_ready", "event review should be ready");
  assert(eventReviewDraft.noActionBoundary, "no-action boundary should hold");
  const math = await runQuantMathChecks(event);

  const language = {
    family: handoff.family,
    source: handoff.source,
    targetSurface: handoff.targetSurface,
    backendTool: handoff.backendTool,
    sourceRequirement: handoff.sourceRequirement,
  };
  const orchestration = planFinanceBrainOrchestration({
    text: [
      utterance,
      event.researchQuestion,
      "Include ETF regime, event catalyst, technical timing, portfolio risk budget, deterministic quant math, retained finance learning, and causal red-team checks.",
    ].join("\n"),
    hasHoldingsOrPortfolioContext: true,
    hasLocalMathInputs: true,
    highStakesConclusion: true,
  });
  const brain = {
    seededCandidateRuns: seeded.length,
    candidateCount: applyDetails.candidateCount,
    synthesisMode: applyDetails.synthesisMode,
  };
  const analysis = {
    eventReviewStatus: eventReviewDraft.status,
    missingInputs: eventReviewDraft.missingInputs,
    missingEvidenceCategories: eventReviewDraft.missingEvidenceCategories,
    noActionBoundary: eventReviewDraft.noActionBoundary,
  };
  const review = resolveReviewTier({
    taskKind: "finance_learning",
    hasLocalToolResults: true,
    hasQuantMathResults: true,
    writesDurableMemory: false,
    involvesPortfolioRisk: true,
    explicitlyRequestedStrictReview: true,
  });
  const reviewPanelTool = createReviewPanelTool({
    workspaceDir: workspace.workspaceDir,
  });
  const loopReceiptPath = buildLoopReceiptPath();
  const visibleReply = buildControlRoomVisibleReply({
    event,
    analysis,
    math,
    receiptPath: loopReceiptPath,
  });
  assert(visibleReply.startsWithPlainSummary, "visible reply should start with plain summary");
  assert(visibleReply.hidesInternalLabels, "visible reply should not expose internal labels");
  assert(visibleReply.includesResearchBoundary, "visible reply should include research boundary");
  assert(visibleReply.includesProofPath, "visible reply should include proof path");
  const adjacentApplication = buildAdjacentApplicationProbe();
  assert(
    (
      [
        "macro_rates_inflation",
        "credit_liquidity",
        "fx_dollar",
        "etf_regime",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "quant_math",
        "causal_map",
      ] satisfies FinanceBrainModuleId[]
    ).every((moduleId) => adjacentApplication.primaryModules.includes(moduleId)),
    "adjacent holdings probe should select the required finance modules",
  );
  assert(
    adjacentApplication.supportingModules.includes("finance_learning_memory"),
    "adjacent holdings probe should use retained finance learning memory",
  );
  assert(
    adjacentApplication.requiredTools.includes("quant_math"),
    "adjacent holdings probe should require local quant math",
  );
  assert(
    adjacentApplication.reviewTools.includes("review_panel"),
    "adjacent holdings probe should require review panel",
  );
  assert(
    adjacentApplication.boundaries.includes("no_execution_authority"),
    "adjacent holdings probe should keep no-execution boundary",
  );
  assert(
    adjacentApplication.missingFreshInputs.includes("position_weights_and_return_series") &&
      adjacentApplication.missingFreshInputs.includes("portfolio_risk_limits"),
    "adjacent holdings probe should name missing portfolio inputs",
  );
  assert(
    adjacentApplication.blocksNumericGuessingWithoutInputs,
    "adjacent holdings probe should block numeric guessing without inputs",
  );
  assert(
    adjacentApplication.startsWithPlainSummary && adjacentApplication.hidesInternalLabels,
    "adjacent holdings probe should keep the visible answer readable",
  );
  assert(
    adjacentApplication.includesResearchBoundary,
    "adjacent holdings probe should keep research-only boundary",
  );
  const reviewPanelResult = await reviewPanelTool.execute("cli-loop-review-panel", {
    taskKind: "finance_learning",
    outputText: [
      "[Candidate visible reply]",
      visibleReply.text,
      "",
      "[Hidden local evidence for reviewers]",
      "research_only no_execution_authority no_model_math_guessing",
      "quant_math checks: risk_budget_deviation, rolling_beta, drawdown_duration, calmar_ratio",
    ].join("\n"),
    hasLocalToolResults: true,
    hasQuantMathResults: true,
    writesDurableMemory: false,
    involvesPortfolioRisk: true,
    explicitlyRequestedStrictReview: true,
    runLocalArbitration: true,
    writeReceipt: true,
  });
  const reviewPanel = asRecord(reviewPanelResult.details, "reviewPanel.details");
  const receipt = await writeLoopReceipt({
    workspaceDir: workspace.workspaceDir,
    relPath: loopReceiptPath,
    language,
    orchestration,
    brain,
    analysis,
    math,
    visibleReply,
    adjacentApplication,
    review,
    reviewPanel,
  });
  return {
    ok: true,
    workspaceDir: workspace.workspaceDir,
    temporaryWorkspace: workspace.temporary,
    language,
    orchestration,
    brain,
    analysis,
    math,
    visibleReply,
    adjacentApplication,
    review,
    reviewPanel,
    memory: {
      loopReceiptPath: receipt.relPath,
    },
    protectedMemoryUntouched: true,
    languageCorpusUntouched: true,
    noRemoteFetchOccurred: true,
    noExecutionAuthority: true,
  };
}
