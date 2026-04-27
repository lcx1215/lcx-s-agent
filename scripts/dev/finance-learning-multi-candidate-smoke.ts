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

const FIXTURES = [
  {
    fileName: "valid-finance-article.md",
    title: "ETF event triage workflow",
    sourceName: "ETF Event Triage Fixture",
  },
  {
    fileName: "valid-etf-liquidity-regime-article.md",
    title: "ETF liquidity regime triage workflow",
    sourceName: "ETF Liquidity Regime Fixture",
  },
  {
    fileName: "valid-etf-catalyst-followup-article.md",
    title: "ETF catalyst follow-up workflow",
    sourceName: "ETF Catalyst Follow-up Fixture",
  },
  {
    fileName: "valid-etf-risk-sizing-article.md",
    title: "ETF risk sizing review workflow",
    sourceName: "ETF Risk Sizing Fixture",
  },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function seedFixture(params: {
  workspaceDir: string;
  tool: ReturnType<typeof createFinanceLearningPipelineOrchestratorTool>;
  fixture: (typeof FIXTURES)[number];
}) {
  const localFilePath = `memory/demo/${params.fixture.fileName}`;
  const targetPath = path.join(params.workspaceDir, localFilePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(path.join(FIXTURE_DIR, params.fixture.fileName), targetPath);
  const result = await params.tool.execute(`multi-candidate-seed:${params.fixture.fileName}`, {
    sourceName: params.fixture.sourceName,
    sourceType: "manual_article_source",
    localFilePath,
    title: params.fixture.title,
    retrievalNotes: SAFE_RETRIEVAL_NOTES,
    allowedActionAuthority: "research_only",
    learningIntent:
      "ETF event triage with catalyst mapping, liquidity regime, and portfolio risk gates",
    maxRetrievedCapabilities: 6,
  });
  assert(result.details.ok === true, `${params.fixture.fileName} should seed successfully`);
  return result.details;
}

async function main() {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-finance-multi-candidate-smoke-"),
  );
  const pipelineTool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });
  const seeded = [];
  for (const fixture of FIXTURES) {
    seeded.push(await seedFixture({ workspaceDir, tool: pipelineTool, fixture }));
  }

  const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });
  const applyResult = await applyTool.execute("multi-candidate-apply", {
    queryText:
      "Use retained ETF event triage, liquidity regime, catalyst follow-up, and portfolio risk gates for a research-only ETF event review.",
    maxCandidates: 5,
  });
  assert(applyResult.details.ok === true, "multi-candidate apply should succeed");
  assert(
    typeof applyResult.details.candidateCount === "number" &&
      applyResult.details.candidateCount >= 3,
    "multi-candidate apply should retrieve at least three candidates",
  );
  assert(
    applyResult.details.synthesisMode === "multi_capability_synthesis",
    "multi-candidate apply should synthesize multiple capabilities",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        workspaceDir,
        seededCandidateRuns: seeded.length,
        retainedCandidateCounts: seeded.map((entry) => entry.retainedCandidateCount),
        applicationMode: applyResult.details.applicationMode,
        synthesisMode: applyResult.details.synthesisMode,
        candidateCount: applyResult.details.candidateCount,
        usageReceiptPath: applyResult.details.usageReceiptPath,
        usageReviewPath: applyResult.details.usageReviewPath,
        appliedCapabilityNames: Array.isArray(applyResult.details.appliedCapabilities)
          ? applyResult.details.appliedCapabilities.map((entry) =>
              entry && typeof entry === "object" && "capabilityName" in entry
                ? entry.capabilityName
                : null,
            )
          : [],
        noActionBoundary:
          applyResult.details.answerSkeleton &&
          typeof applyResult.details.answerSkeleton === "object" &&
          "noActionBoundary" in applyResult.details.answerSkeleton
            ? applyResult.details.answerSkeleton.noActionBoundary
            : null,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
