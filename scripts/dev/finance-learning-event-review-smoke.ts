import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  freshInputs: Array<{
    name: string;
    summary: string;
    evidenceCategories: string[];
  }>;
  redTeamInvalidation: string[];
  noActionBoundary: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "value should be object");
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

async function seedCapabilities(params: {
  workspaceDir: string;
  tool: ReturnType<typeof createFinanceLearningPipelineOrchestratorTool>;
}) {
  const seeded = [];
  for (const [fileName, title, sourceName] of CAPABILITY_FIXTURES) {
    const localFilePath = `memory/demo/${fileName}`;
    const targetPath = path.join(params.workspaceDir, localFilePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(path.join(FIXTURE_DIR, fileName), targetPath);
    const result = await params.tool.execute(`event-review-seed:${fileName}`, {
      sourceName,
      sourceType: "manual_article_source",
      localFilePath,
      title,
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      allowedActionAuthority: "research_only",
      learningIntent:
        "ETF event triage with catalyst mapping, liquidity regime, and portfolio risk gates",
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
  const answerSkeleton = asRecord(params.applyDetails.answerSkeleton);
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
    ? params.applyDetails.appliedCapabilities.map((entry) => asRecord(entry))
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
    freshInputsChecked: params.event.freshInputs.map((entry) => ({
      name: entry.name,
      evidenceCategories: entry.evidenceCategories,
    })),
    missingInputs,
    missingEvidenceCategories,
    researchOnlySections: [
      {
        heading: "Event frame",
        content:
          "Treat the headline cluster as a follow-up queue, not a directional forecast or trade approval.",
      },
      {
        heading: "Liquidity and regime check",
        content:
          "Credit and funding inputs are present, so the review can separate broad liquidity stress from ordinary headline volatility.",
      },
      {
        heading: "Risk gate",
        content:
          "Drawdown and volatility inputs are present, so the output must preserve wait discipline and avoid implicit sizing.",
      },
      {
        heading: "Red-team invalidation",
        content: params.event.redTeamInvalidation.join(" "),
      },
    ],
    noActionBoundary:
      params.event.noActionBoundary === "research_only_no_trade_approval" &&
      answerSkeleton.noActionBoundary ===
        "This application is research-only and does not approve trades, auto-promotion, doctrine mutation, or standalone prediction.",
  };
}

async function main() {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-finance-event-review-smoke-"),
  );
  const event = JSON.parse(
    await fs.readFile(path.join(FIXTURE_DIR, "fresh-etf-event-review.json"), "utf8"),
  ) as FreshEventReview;
  const pipelineTool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });
  const seeded = await seedCapabilities({ workspaceDir, tool: pipelineTool });
  const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });
  const applyResult = await applyTool.execute("event-review-apply", {
    queryText: event.researchQuestion,
    maxCandidates: 5,
  });
  assert(applyResult.details.ok === true, "event review apply should succeed");
  assert(
    applyResult.details.synthesisMode === "multi_capability_synthesis",
    "event review should synthesize multiple capabilities",
  );
  const eventReviewDraft = buildEventReviewDraft({
    event,
    applyDetails: asRecord(applyResult.details),
  });
  assert(
    eventReviewDraft.status === "research_review_ready",
    "fresh ETF event review should pass required input and evidence coverage",
  );
  assert(
    eventReviewDraft.noActionBoundary === true,
    "event review should preserve no-action boundary",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        workspaceDir,
        seededCandidateRuns: seeded.length,
        candidateCount: applyResult.details.candidateCount,
        synthesisMode: applyResult.details.synthesisMode,
        applicationMode: applyResult.details.applicationMode,
        eventReviewDraft,
        usageReceiptPath: applyResult.details.usageReceiptPath,
        usageReviewPath: applyResult.details.usageReviewPath,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
