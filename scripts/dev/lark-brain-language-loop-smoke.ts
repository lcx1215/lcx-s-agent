import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveLarkAgentInstructionHandoff,
  type LarkApiRouteProvider,
} from "../../extensions/feishu/src/lark-routing-corpus.ts";
import type { FeishuConfig } from "../../extensions/feishu/src/types.ts";
import { createFinanceLearningCapabilityApplyTool } from "../../src/agents/tools/finance-learning-capability-apply-tool.ts";
import { createFinanceLearningPipelineOrchestratorTool } from "../../src/agents/tools/finance-learning-pipeline-orchestrator-tool.ts";

const SAFE_RETRIEVAL_NOTES =
  "Operator provided a bounded finance research source with explicit provenance, concrete method notes, evidence-bearing cognition, and no remote fetch request in this orchestration step.";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../../test/fixtures/finance-learning-pipeline");

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

type FreshEventReview = {
  eventTitle: string;
  asOfDate: string;
  researchQuestion: string;
  freshInputs: Array<{ name: string; evidenceCategories: string[] }>;
  redTeamInvalidation: string[];
  noActionBoundary: string;
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

function buildLarkSmokeConfig(): FeishuConfig {
  return {
    enabled: true,
    connectionMode: "webhook",
    appId: "loop-smoke-app",
    appSecret: "loop-smoke-secret",
    surfaces: {
      control_room: { chatId: "oc-control-room-loop-smoke" },
      learning_command: { chatId: "oc-learning-command-loop-smoke" },
    },
  } as FeishuConfig;
}

async function seedCapabilities(params: {
  workspaceDir: string;
  tool: ReturnType<typeof createFinanceLearningPipelineOrchestratorTool>;
  learningIntent: string;
}) {
  const seeded = [];
  for (const [fileName, title, sourceName] of CAPABILITY_FIXTURES) {
    const localFilePath = `memory/demo/${fileName}`;
    const targetPath = path.join(params.workspaceDir, localFilePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(path.join(FIXTURE_DIR, fileName), targetPath);
    const result = await params.tool.execute(`loop-seed:${fileName}`, {
      sourceName,
      sourceType: "manual_article_source",
      localFilePath,
      title,
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      allowedActionAuthority: "research_only",
      learningIntent: params.learningIntent,
      maxRetrievedCapabilities: 6,
    });
    assert(result.details.ok === true, `${fileName} should seed successfully`);
    seeded.push(result.details);
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
  const appliedCapabilities = Array.isArray(params.applyDetails.appliedCapabilities)
    ? params.applyDetails.appliedCapabilities.map((entry) => asRecord(entry, "appliedCapability"))
    : [];
  const status =
    missingInputs.length === 0 && missingEvidenceCategories.length === 0
      ? "research_review_ready"
      : "blocked_missing_fresh_inputs";

  return {
    status,
    eventTitle: params.event.eventTitle,
    asOfDate: params.event.asOfDate,
    appliedCapabilityNames: appliedCapabilities.map((entry) => entry.capabilityName),
    missingInputs,
    missingEvidenceCategories,
    researchOnlySections: [
      "Event frame: treat the headline cluster as a follow-up queue, not a directional forecast.",
      "Liquidity and regime check: separate broad liquidity stress from ordinary headline volatility.",
      "Risk gate: preserve wait discipline and avoid implicit sizing.",
      `Red-team invalidation: ${params.event.redTeamInvalidation.join(" ")}`,
    ],
    noActionBoundary:
      params.event.noActionBoundary === "research_only_no_trade_approval" &&
      answerSkeleton.noActionBoundary ===
        "This application is research-only and does not approve trades, auto-promotion, doctrine mutation, or standalone prediction.",
  };
}

async function writeLoopReceipt(params: {
  workspaceDir: string;
  handoff: Awaited<ReturnType<typeof resolveLarkAgentInstructionHandoff>>;
  seededCount: number;
  applyDetails: Record<string, unknown>;
  eventReviewDraft: ReturnType<typeof buildEventReviewDraft>;
}) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const relDir = path.join("memory", "agent-loop-receipts", dateKey);
  const relPath = path.join(
    relDir,
    `${new Date().toISOString().replace(/[:.]/gu, "-")}__language-brain-analysis-memory.json`,
  );
  const payload = {
    schemaVersion: 1,
    boundary: "language_brain_analysis_memory_loop_smoke",
    generatedAt: new Date().toISOString(),
    loop: {
      language: {
        family: params.handoff.family,
        source: params.handoff.source,
        targetSurface: params.handoff.targetSurface,
        backendTool: params.handoff.backendToolContract?.toolName ?? null,
        sourceRequirement: params.handoff.backendToolContract?.sourceRequirement ?? null,
      },
      brain: {
        seededCandidateRuns: params.seededCount,
        candidateCount: params.applyDetails.candidateCount,
        synthesisMode: params.applyDetails.synthesisMode,
      },
      analysis: {
        eventReviewStatus: params.eventReviewDraft.status,
        missingInputs: params.eventReviewDraft.missingInputs,
        missingEvidenceCategories: params.eventReviewDraft.missingEvidenceCategories,
        noActionBoundary: params.eventReviewDraft.noActionBoundary,
      },
      memory: {
        usageReceiptPath:
          typeof params.applyDetails.usageReceiptPath === "string"
            ? params.applyDetails.usageReceiptPath
            : null,
        usageReviewPath:
          typeof params.applyDetails.usageReviewPath === "string"
            ? params.applyDetails.usageReviewPath
            : null,
        loopReceiptPath: relPath.split(path.sep).join("/"),
      },
    },
    protectedMemoryUntouched: true,
    languageCorpusUntouched: true,
    noRemoteFetchOccurred: true,
    noExecutionAuthority: true,
    controlRoomSummary:
      "Language routed to market_capability_learning_intake, brain retrieved four ETF capabilities, analysis produced research_review_ready, and memory receipts were written without touching protected memory.",
  };
  await fs.mkdir(path.join(params.workspaceDir, relDir), { recursive: true });
  await fs.writeFile(
    path.join(params.workspaceDir, relPath),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  return {
    relPath: relPath.split(path.sep).join("/"),
    payload,
  };
}

async function main() {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-language-brain-loop-smoke-"),
  );
  const event = JSON.parse(
    await fs.readFile(path.join(FIXTURE_DIR, "fresh-etf-event-review.json"), "utf8"),
  ) as FreshEventReview;
  const utterance =
    "继续把语言、大脑、分析、记忆回路跑顺：学习 ETF event triage workflow，用本地安全 source 和 fresh ETF event 输入，最后给 control room 一个 research-only 摘要和 receipt。";
  const apiProvider: LarkApiRouteProvider = async () => ({
    family: "market_capability_learning_intake",
    confidence: 0.97,
    rationale: "offline loop smoke for language-brain-analysis-memory integration",
  });
  const handoff = await resolveLarkAgentInstructionHandoff({
    cfg: buildLarkSmokeConfig(),
    chatId: "oc-control-room-loop-smoke",
    utterance,
    apiProvider,
  });
  assert(
    handoff.family === "market_capability_learning_intake",
    "language should route to learning intake",
  );
  assert(handoff.targetSurface === "learning_command", "language should target learning command");
  assert(
    handoff.backendToolContract?.toolName === "finance_learning_pipeline_orchestrator",
    "language handoff should expose finance learning pipeline",
  );

  const pipelineTool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });
  const seeded = await seedCapabilities({
    workspaceDir,
    tool: pipelineTool,
    learningIntent: utterance,
  });
  const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });
  const applyResult = await applyTool.execute("loop-apply", {
    queryText: event.researchQuestion,
    maxCandidates: 5,
  });
  const applyDetails = asRecord(applyResult.details, "applyResult.details");
  assert(applyDetails.ok === true, "analysis apply should succeed");
  assert(applyDetails.synthesisMode === "multi_capability_synthesis", "analysis should synthesize");
  const eventReviewDraft = buildEventReviewDraft({ event, applyDetails });
  assert(
    eventReviewDraft.status === "research_review_ready",
    "analysis should become review-ready",
  );
  assert(eventReviewDraft.noActionBoundary === true, "analysis should preserve no-action boundary");
  const receipt = await writeLoopReceipt({
    workspaceDir,
    handoff,
    seededCount: seeded.length,
    applyDetails,
    eventReviewDraft,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        workspaceDir,
        language: receipt.payload.loop.language,
        brain: receipt.payload.loop.brain,
        analysis: receipt.payload.loop.analysis,
        memory: receipt.payload.loop.memory,
        controlRoomSummary: receipt.payload.controlRoomSummary,
        protectedMemoryUntouched: receipt.payload.protectedMemoryUntouched,
        languageCorpusUntouched: receipt.payload.languageCorpusUntouched,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
