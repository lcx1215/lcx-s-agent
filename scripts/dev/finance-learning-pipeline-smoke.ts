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
const SAFE_COMPLIANCE_NOTES =
  "Use only public feeds, local exports, normal browser-visible access, or manual operator capture with no bypasses.";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../../test/fixtures/finance-learning-pipeline");

type SmokeCase =
  | "manual-paste"
  | "local-file"
  | "lark-market-capability-intake"
  | "lark-market-capability-missing-source"
  | "capability-apply"
  | "capability-apply-unmatched"
  | "external-rss"
  | "generic"
  | "blocked"
  | "metadata-reference"
  | "all";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function ensureWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
  sourceFileName: string,
): Promise<string> {
  const targetPath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(path.join(FIXTURE_DIR, sourceFileName), targetPath);
  return relativePath;
}

async function readJsonFixture<T>(fileName: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, fileName), "utf8")) as T;
}

async function readTextFixture(fileName: string): Promise<string> {
  return fs.readFile(path.join(FIXTURE_DIR, fileName), "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function getRecord(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} should be object`);
  return value as Record<string, unknown>;
}

function getString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `${label} should be non-empty string`);
  return value;
}

function buildLarkSmokeConfig(): FeishuConfig {
  return {
    enabled: true,
    connectionMode: "webhook",
    appId: "cli-smoke-app",
    appSecret: "cli-smoke-secret",
    surfaces: {
      control_room: {
        chatId: "oc-control-room-smoke",
      },
      learning_command: {
        chatId: "oc-learning-command-smoke",
      },
    },
  } as FeishuConfig;
}

async function assertArtifactExists(workspaceDir: string, relativePath: string): Promise<void> {
  assert(
    !path.isAbsolute(relativePath) && !relativePath.startsWith(".."),
    `artifact path must be workspace-relative: ${relativePath}`,
  );
  await fs.access(path.join(workspaceDir, relativePath));
}

async function seedValidCapabilityFromLocalFile(params: {
  tool: ReturnType<typeof createFinanceLearningPipelineOrchestratorTool>;
  workspaceDir: string;
  toolCallId: string;
}) {
  const localFilePath = await ensureWorkspaceFile(
    params.workspaceDir,
    `memory/demo/${params.toolCallId}-valid-finance-article.md`,
    "valid-finance-article.md",
  );
  const result = await params.tool.execute(params.toolCallId, {
    sourceName: "Local Finance Fixture",
    sourceType: "manual_article_source",
    localFilePath,
    title: "ETF event triage workflow",
    retrievalNotes: SAFE_RETRIEVAL_NOTES,
    allowedActionAuthority: "research_only",
    learningIntent: "ETF event triage workflow with public headlines and ETF regime risk",
    maxRetrievedCapabilities: 5,
  });
  assert(result.details.ok === true, `${params.toolCallId} should seed a retained capability`);
  return result;
}

async function runCase(
  tool: ReturnType<typeof createFinanceLearningPipelineOrchestratorTool>,
  workspaceDir: string,
  caseName: Exclude<SmokeCase, "all">,
) {
  switch (caseName) {
    case "manual-paste": {
      const pastedText = await readTextFixture("valid-finance-article.md");
      const result = await tool.execute("smoke-manual-paste", {
        sourceName: "Manual Finance Note",
        sourceType: "manual_article_source",
        pastedText,
        title: "ETF event triage workflow",
        publishDate: "2026-04-17",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
        allowedActionAuthority: "research_only",
      });
      assert(result.details.ok === true, "manual-paste should complete the full pipeline");
      assert(
        result.details.inspectTool === "finance_learning_capability_inspect",
        "manual-paste should return inspect target",
      );
      return {
        case: caseName,
        ok: true,
        retainedCandidateCount: result.details.retainedCandidateCount,
        normalizedArticleArtifactPaths: result.details.normalizedArticleArtifactPaths,
        inspectTargets: result.details.inspectTargets,
      };
    }
    case "local-file": {
      const localFilePath = await ensureWorkspaceFile(
        workspaceDir,
        "memory/demo/valid-finance-article.md",
        "valid-finance-article.md",
      );
      const result = await tool.execute("smoke-local-file", {
        sourceName: "Local Finance Fixture",
        sourceType: "manual_article_source",
        localFilePath,
        title: "ETF event triage workflow",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
      });
      assert(result.details.ok === true, "local-file should complete the full pipeline");
      assert(result.details.noRemoteFetchOccurred === true, "local-file should not fetch remotely");
      return {
        case: caseName,
        ok: true,
        retainedCandidateCount: result.details.retainedCandidateCount,
        normalizedArticleArtifactPaths: result.details.normalizedArticleArtifactPaths,
        inspectTargets: result.details.inspectTargets,
      };
    }
    case "lark-market-capability-intake": {
      const localFilePath = await ensureWorkspaceFile(
        workspaceDir,
        "memory/demo/lark-valid-finance-article.md",
        "valid-finance-article.md",
      );
      const utterance =
        "在 Lark 里验证一套完整学习流程：学习一套很好的量化因子择时策略，使用本地 source memory/demo/lark-valid-finance-article.md，走 source intake、extract、attach 和 review";
      const apiProvider: LarkApiRouteProvider = async () => ({
        family: "market_capability_learning_intake",
        confidence: 0.96,
        rationale: "offline smoke candidate for finance-learning source intake",
      });
      const handoff = await resolveLarkAgentInstructionHandoff({
        cfg: buildLarkSmokeConfig(),
        chatId: "oc-control-room-smoke",
        utterance,
        apiProvider,
      });
      assert(
        handoff.family === "market_capability_learning_intake",
        "Lark handoff should classify market capability learning intake",
      );
      assert(
        handoff.targetSurface === "learning_command",
        "Lark handoff should target learning_command surface",
      );
      assert(
        handoff.backendToolContract?.toolName === "finance_learning_pipeline_orchestrator",
        "Lark handoff should expose finance learning backend contract",
      );
      assert(
        handoff.backendToolContract.sourceRequirement === "safe_local_or_manual_source_required",
        "Lark handoff should require safe local or manual source",
      );
      const result = await tool.execute("smoke-lark-market-capability-intake", {
        sourceName: "Lark Finance Learning Smoke Fixture",
        sourceType: "manual_article_source",
        localFilePath,
        title: "Lark finance capability learning request",
        retrievalNotes:
          "Lark offline smoke verified bounded research-only source intake, extraction, attachment, retrieval receipt, and retrieval review.",
        allowedActionAuthority: "research_only",
        learningIntent: handoff.backendToolContract.learningIntent,
        maxRetrievedCapabilities: 5,
      });
      assert(result.details.ok === true, "lark-market-capability-intake should complete pipeline");
      const retrieval = getRecord(result.details.retrievalFirstLearning, "retrievalFirstLearning");
      const retrievalReceiptPath = getString(
        retrieval.retrievalReceiptPath,
        "retrievalReceiptPath",
      );
      const retrievalReviewPath = getString(retrieval.retrievalReviewPath, "retrievalReviewPath");
      await assertArtifactExists(workspaceDir, retrievalReceiptPath);
      await assertArtifactExists(workspaceDir, retrievalReviewPath);
      return {
        case: caseName,
        ok: true,
        handoffFamily: handoff.family,
        handoffSource: handoff.source,
        targetSurface: handoff.targetSurface,
        backendTool: handoff.backendToolContract.toolName,
        sourceRequirement: handoff.backendToolContract.sourceRequirement,
        retainedCandidateCount: result.details.retainedCandidateCount,
        normalizedArticleArtifactPaths: result.details.normalizedArticleArtifactPaths,
        retrievalReceiptPath,
        retrievalReviewPath,
      };
    }
    case "lark-market-capability-missing-source": {
      const utterance = "在 Lark 里验证一套完整学习流程：学习一套很好的量化因子择时策略";
      const apiProvider: LarkApiRouteProvider = async () => ({
        family: "market_capability_learning_intake",
        confidence: 0.95,
        rationale: "offline smoke candidate without a safe source",
      });
      const handoff = await resolveLarkAgentInstructionHandoff({
        cfg: buildLarkSmokeConfig(),
        chatId: "oc-control-room-smoke",
        utterance,
        apiProvider,
      });
      assert(
        handoff.family === "market_capability_learning_intake",
        "missing-source Lark handoff should still classify the learning intent",
      );
      assert(
        handoff.targetSurface === "learning_command",
        "missing-source Lark handoff should target learning_command surface",
      );
      assert(
        handoff.backendToolContract?.toolName === "finance_learning_pipeline_orchestrator",
        "missing-source Lark handoff should expose backend contract",
      );
      assert(
        handoff.backendToolContract.sourceRequirement === "safe_local_or_manual_source_required",
        "missing-source Lark handoff should require safe source before learning",
      );
      return {
        case: caseName,
        ok: true,
        pipelineExecuted: false,
        handoffFamily: handoff.family,
        handoffSource: handoff.source,
        targetSurface: handoff.targetSurface,
        backendTool: handoff.backendToolContract.toolName,
        sourceRequirement: handoff.backendToolContract.sourceRequirement,
        blockedReason: "safe_local_or_manual_source_required",
      };
    }
    case "capability-apply": {
      const seedResult = await seedValidCapabilityFromLocalFile({
        tool,
        workspaceDir,
        toolCallId: "smoke-capability-apply-seed",
      });
      const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });
      const applyResult = await applyTool.execute("smoke-capability-apply", {
        queryText:
          "How should the retained ETF event triage workflow be used for research with public headlines, ETF issuer notes, and portfolio risk checks?",
        maxCandidates: 1,
      });
      assert(applyResult.details.ok === true, "capability-apply should apply a retained card");
      const answerSkeleton = getRecord(applyResult.details.answerSkeleton, "answerSkeleton");
      const appliedCapabilities = Array.isArray(applyResult.details.appliedCapabilities)
        ? applyResult.details.appliedCapabilities
        : [];
      assert(appliedCapabilities.length > 0, "capability-apply should return applied capability");
      assert(
        answerSkeleton.noActionBoundary ===
          "This application is research-only and does not approve trades, auto-promotion, doctrine mutation, or standalone prediction.",
        "capability-apply should preserve the no-action boundary",
      );
      return {
        case: caseName,
        ok: true,
        seedRetainedCandidateCount: seedResult.details.retainedCandidateCount,
        applicationMode: applyResult.details.applicationMode,
        candidateCount: applyResult.details.candidateCount,
        noActionBoundary: answerSkeleton.noActionBoundary,
        appliedCapabilityNames: appliedCapabilities.map((entry) =>
          typeof entry === "object" && entry && "capabilityName" in entry
            ? (entry.capabilityName as unknown)
            : null,
        ),
      };
    }
    case "capability-apply-unmatched": {
      await seedValidCapabilityFromLocalFile({
        tool,
        workspaceDir,
        toolCallId: "smoke-capability-apply-unmatched-seed",
      });
      const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });
      const applyResult = await applyTool.execute("smoke-capability-apply-unmatched", {
        queryText: "open source github repository benchmark compliance dataset governance",
        maxCandidates: 3,
      });
      assert(applyResult.details.ok === false, "unmatched apply should fail closed");
      assert(
        applyResult.details.reason === "no_retrievable_finance_capability",
        "unmatched apply should not improvise a learned answer",
      );
      return {
        case: caseName,
        ok: false,
        expectedFailure: true,
        reason: applyResult.details.reason,
        action: applyResult.details.action,
      };
    }
    case "external-rss": {
      const inputPath = await ensureWorkspaceFile(
        workspaceDir,
        "memory/demo/valid-rss-export.xml",
        "valid-rss-export.xml",
      );
      const result = await tool.execute("smoke-external-rss", {
        adapterName: "public-feed-adapter",
        adapterType: "rss_atom_json_feed",
        inputPath,
        feedUrl: "https://example.com/feed.xml",
        sourceFamily: "public_feed",
        sourceName: "Public Finance Feed",
        collectionMethod: "rss_or_public_feed_if_available",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
        complianceNotes: SAFE_COMPLIANCE_NOTES,
        isPubliclyAccessible: true,
      });
      assert(result.details.ok === true, "external-rss should complete the full pipeline");
      assert(
        result.details.inspectTool === "finance_learning_capability_inspect",
        "external-rss should return inspect target",
      );
      return {
        case: caseName,
        ok: true,
        retainedCandidateCount: result.details.retainedCandidateCount,
        normalizedArticleArtifactPaths: result.details.normalizedArticleArtifactPaths,
        inspectTargets: result.details.inspectTargets,
      };
    }
    case "generic": {
      const localFilePath = await ensureWorkspaceFile(
        workspaceDir,
        "memory/demo/invalid-generic-article.md",
        "invalid-generic-article.md",
      );
      const result = await tool.execute("smoke-generic", {
        sourceName: "Generic Finance Fixture",
        sourceType: "manual_article_source",
        localFilePath,
        title: "Generic market note",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
      });
      assert(result.details.ok === false, "generic should fail closed");
      return {
        case: caseName,
        ok: false,
        failedStep: result.details.failedStep,
        reason: result.details.reason,
      };
    }
    case "blocked": {
      const blockedRequest = await readJsonFixture<Record<string, unknown>>(
        "blocked-bypass-request.json",
      );
      const result = await tool.execute("smoke-blocked", blockedRequest);
      assert(result.details.ok === false, "blocked should fail closed");
      assert(result.details.failedStep === "intake", "blocked should fail before extraction");
      return {
        case: caseName,
        ok: false,
        failedStep: result.details.failedStep,
        reason: result.details.reason,
      };
    }
    case "metadata-reference": {
      const metadataRequest = await readJsonFixture<Record<string, unknown>>(
        "metadata-only-web-reference.json",
      );
      const result = await tool.execute("smoke-metadata-reference", metadataRequest);
      assert(result.details.ok === true, "metadata-reference should succeed as metadata only");
      assert(
        result.details.extractionSkipped === true,
        "metadata-reference should skip extraction",
      );
      assert(result.details.noRemoteFetchOccurred === true, "metadata-reference should not fetch");
      return {
        case: caseName,
        ok: true,
        extractionSkipped: result.details.extractionSkipped,
        extractionSkippedReason: result.details.extractionSkippedReason,
        normalizedReferenceArtifactPaths: result.details.normalizedReferenceArtifactPaths,
        inspectTool: result.details.inspectTool,
      };
    }
  }
}

async function main() {
  const selectedCase = (getArg("--case") ?? "all") as SmokeCase;
  const workspaceArg = getArg("--workspace");
  const workspaceDir =
    workspaceArg?.trim() ||
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-finance-learning-pipeline-smoke-")));
  const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

  const cases: Array<Exclude<SmokeCase, "all">> =
    selectedCase === "all"
      ? [
          "manual-paste",
          "local-file",
          "lark-market-capability-intake",
          "lark-market-capability-missing-source",
          "capability-apply",
          "capability-apply-unmatched",
          "external-rss",
          "generic",
          "blocked",
          "metadata-reference",
        ]
      : [selectedCase];

  const results = [];
  for (const caseName of cases) {
    results.push(await runCase(tool, workspaceDir, caseName));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        workspaceDir,
        fixtureDir: path.relative(process.cwd(), FIXTURE_DIR),
        cases: results,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
