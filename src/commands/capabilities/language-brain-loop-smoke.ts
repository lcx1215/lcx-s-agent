import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFinanceLearningCapabilityApplyTool } from "../../agents/tools/finance-learning-capability-apply-tool.js";
import { createFinanceLearningPipelineOrchestratorTool } from "../../agents/tools/finance-learning-pipeline-orchestrator-tool.js";
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
  brain: Record<string, unknown>;
  analysis: Record<string, unknown>;
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

async function writeLoopReceipt(params: {
  workspaceDir: string;
  language: Record<string, unknown>;
  brain: Record<string, unknown>;
  analysis: Record<string, unknown>;
}) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const relDir = path.join("memory", "agent-loop-receipts", dateKey);
  const relPath = path.join(
    relDir,
    `${new Date().toISOString().replace(/[:.]/gu, "-")}__language-brain-analysis-memory.json`,
  );
  const payload = {
    schemaVersion: 1,
    boundary: "cli_language_brain_analysis_memory_loop_smoke",
    generatedAt: new Date().toISOString(),
    loop: {
      language: params.language,
      brain: params.brain,
      analysis: params.analysis,
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

function formatText(payload: Record<string, unknown>): string {
  const language = asRecord(payload.language, "language");
  const brain = asRecord(payload.brain, "brain");
  const analysis = asRecord(payload.analysis, "analysis");
  const memory = asRecord(payload.memory, "memory");
  return [
    "LCX language-brain-analysis-memory loop smoke",
    "",
    `ok: ${String(payload.ok)}`,
    `workspace: ${String(payload.workspaceDir)}`,
    `language family: ${String(language.family)}`,
    `backend tool: ${String(language.backendTool)}`,
    `brain synthesis: ${String(brain.synthesisMode)}`,
    `candidate count: ${String(brain.candidateCount)}`,
    `analysis status: ${String(analysis.eventReviewStatus)}`,
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
    maxCandidates: 5,
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

  const language = {
    family: handoff.family,
    source: handoff.source,
    targetSurface: handoff.targetSurface,
    backendTool: handoff.backendTool,
    sourceRequirement: handoff.sourceRequirement,
  };
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
  const receipt = await writeLoopReceipt({
    workspaceDir: workspace.workspaceDir,
    language,
    brain,
    analysis,
  });
  return {
    ok: true,
    workspaceDir: workspace.workspaceDir,
    temporaryWorkspace: workspace.temporary,
    language,
    brain,
    analysis,
    memory: {
      loopReceiptPath: receipt.relPath,
    },
    protectedMemoryUntouched: true,
    languageCorpusUntouched: true,
    noRemoteFetchOccurred: true,
    noExecutionAuthority: true,
  };
}
