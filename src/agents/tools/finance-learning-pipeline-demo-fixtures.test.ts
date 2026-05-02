import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceLearningPipelineOrchestratorTool } from "./finance-learning-pipeline-orchestrator-tool.js";

const FIXTURE_DIR = path.resolve(process.cwd(), "test/fixtures/finance-learning-pipeline");
const SAFE_RETRIEVAL_NOTES =
  "Operator provided a bounded finance research source with explicit provenance, concrete method notes, evidence-bearing cognition, and no remote fetch request in this orchestration step.";
const SAFE_COMPLIANCE_NOTES =
  "Use only public feeds, local exports, normal browser-visible access, or manual operator capture with no bypasses.";

async function seedFixture(
  workspaceDir: string,
  fixtureName: string,
  relativePath: string,
): Promise<string> {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.copyFile(path.join(FIXTURE_DIR, fixtureName), absolutePath);
  return relativePath;
}

async function readJsonFixture<T>(fixtureName: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, fixtureName), "utf8")) as T;
}

async function readTextFixture(fixtureName: string): Promise<string> {
  return fs.readFile(path.join(FIXTURE_DIR, fixtureName), "utf8");
}

describe("finance learning pipeline runbook fixtures", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("runbook valid article fixture completes the full pipeline", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-runbook-");
    const localFilePath = await seedFixture(
      workspaceDir,
      "valid-finance-article.md",
      "memory/demo/valid-finance-article.md",
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("fixture-valid-article", {
      sourceName: "Local Finance Fixture",
      sourceType: "manual_article_source",
      localFilePath,
      title: "ETF event triage workflow",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        retainedCandidateCount: 1,
        inspectTool: "finance_learning_capability_inspect",
        noRemoteFetchOccurred: true,
      }),
    );
  });

  it("runbook RSS export fixture completes the full pipeline", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-runbook-");
    const inputPath = await seedFixture(
      workspaceDir,
      "valid-rss-export.xml",
      "memory/demo/valid-rss-export.xml",
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("fixture-rss", {
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

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        retainedCandidateCount: 1,
        inspectTool: "finance_learning_capability_inspect",
      }),
    );
  });

  it("generic article fixture is rejected", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-runbook-");
    const localFilePath = await seedFixture(
      workspaceDir,
      "invalid-generic-article.md",
      "memory/demo/invalid-generic-article.md",
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("fixture-generic", {
      sourceName: "Generic Finance Fixture",
      sourceType: "manual_article_source",
      localFilePath,
      title: "Generic market note",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: false,
        failedStep: "extract",
      }),
    );
  });

  it("bypass fixture is rejected", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-runbook-");
    const request = await readJsonFixture<Record<string, unknown>>("blocked-bypass-request.json");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("fixture-blocked", request);

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: false,
        failedStep: "intake",
      }),
    );
  });

  it("metadata-only reference records metadata but does not fetch and does not attach", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-runbook-");
    const request = await readJsonFixture<Record<string, unknown>>(
      "metadata-only-web-reference.json",
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("fixture-metadata", request);

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        extractionSkipped: true,
        extractionSkippedReason: "metadata_only_reference_source",
        noRemoteFetchOccurred: true,
        inspectTool: null,
      }),
    );
  });

  it("manual pasted fixture returns inspect target and stays bounded", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-runbook-");
    const pastedText = await readTextFixture("valid-finance-article.md");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("fixture-manual-paste", {
      sourceName: "Manual Finance Note",
      sourceType: "manual_article_source",
      pastedText,
      title: "ETF event triage workflow",
      publishDate: "2026-04-17",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      allowedActionAuthority: "research_only",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        inspectTool: "finance_learning_capability_inspect",
      }),
    );

    const forbidden = await tool.execute("fixture-manual-paste-execution", {
      sourceName: "Manual Finance Note",
      sourceType: "manual_article_source",
      pastedText,
      title: "ETF event triage workflow",
      publishDate: "2026-04-17",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      executionRequested: true,
    });

    expect(forbidden.details).toEqual(
      expect.objectContaining({
        ok: false,
        failedStep: "intake",
      }),
    );
  });

  it("holdings risk math fixture becomes application-ready for portfolio review", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-runbook-");
    const localFilePath = await seedFixture(
      workspaceDir,
      "valid-holdings-risk-math-article.md",
      "memory/demo/valid-holdings-risk-math-article.md",
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("fixture-holdings-risk-math", {
      sourceName: "Holdings Risk Math Fixture",
      sourceType: "manual_article_source",
      localFilePath,
      title: "Holdings risk math review workflow",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      allowedActionAuthority: "research_only",
      learningIntent: "学习未来持仓分析需要的数学：波动、回撤、相关性、集中度、风险贡献和尾部风险",
      maxRetrievedCapabilities: 5,
      applicationValidationQuery:
        "用持仓数学检查当前组合是否因为相关性、波动、集中度和风险贡献而需要 research-only 风险复核",
      maxAppliedCapabilities: 3,
    });

    const details = result.details as Record<string, unknown>;
    const retrievalFirstLearning = details.retrievalFirstLearning as Record<string, unknown>;
    const applicationValidation = details.applicationValidation as Record<string, unknown>;
    const appliedCapabilities = applicationValidation.appliedCapabilities as Array<
      Record<string, unknown>
    >;

    expect(details).toEqual(
      expect.objectContaining({
        ok: true,
        retainedCandidateCount: 1,
        inspectTool: "finance_learning_capability_inspect",
      }),
    );
    expect(retrievalFirstLearning).toEqual(
      expect.objectContaining({
        learningInternalizationStatus: "application_ready",
        failedReason: null,
      }),
    );
    expect(String(retrievalFirstLearning.retrievalReceiptPath)).toMatch(
      /^memory\/finance-learning-retrieval-receipts\//u,
    );
    expect(String(retrievalFirstLearning.retrievalReviewPath)).toMatch(
      /^memory\/finance-learning-retrieval-reviews\//u,
    );
    expect(applicationValidation).toEqual(
      expect.objectContaining({
        ok: true,
        applicationValidationStatus: "application_ready",
        failedReason: null,
      }),
    );
    expect(String(applicationValidation.usageReceiptPath)).toMatch(
      /^memory\/finance-learning-apply-usage-receipts\//u,
    );
    expect(String(applicationValidation.usageReviewPath)).toMatch(
      /^memory\/finance-learning-apply-usage-reviews\//u,
    );
    expect(appliedCapabilities.map((capability) => capability.capabilityName)).toContain(
      "Holdings risk math review workflow",
    );
  });

  it("factor timing validation fixture becomes application-ready for signal review", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-runbook-");
    const localFilePath = await seedFixture(
      workspaceDir,
      "valid-factor-timing-validation-article.md",
      "memory/demo/valid-factor-timing-validation-article.md",
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("fixture-factor-timing-validation", {
      sourceName: "Factor Timing Validation Fixture",
      sourceType: "manual_article_source",
      localFilePath,
      title: "Factor timing validation workflow",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      allowedActionAuthority: "research_only",
      learningIntent:
        "学习 ETF 因子择时验证：walk-forward、样本外、交易成本、换手、confounder、whipsaw 和 drawdown",
      maxRetrievedCapabilities: 5,
      applicationValidationQuery:
        "用因子择时验证流程检查一个 ETF timing signal 是否因为样本外、confounder、whipsaw、drawdown、成本和换手问题而只能 research-only",
      maxAppliedCapabilities: 3,
    });

    const details = result.details as Record<string, unknown>;
    const retrievalFirstLearning = details.retrievalFirstLearning as Record<string, unknown>;
    const applicationValidation = details.applicationValidation as Record<string, unknown>;
    const appliedCapabilities = applicationValidation.appliedCapabilities as Array<
      Record<string, unknown>
    >;

    expect(details).toEqual(
      expect.objectContaining({
        ok: true,
        retainedCandidateCount: 1,
        inspectTool: "finance_learning_capability_inspect",
      }),
    );
    expect(retrievalFirstLearning).toEqual(
      expect.objectContaining({
        learningInternalizationStatus: "application_ready",
        failedReason: null,
      }),
    );
    expect(applicationValidation).toEqual(
      expect.objectContaining({
        ok: true,
        applicationValidationStatus: "application_ready",
        failedReason: null,
      }),
    );
    expect(appliedCapabilities.map((capability) => capability.capabilityName)).toContain(
      "Factor timing validation workflow",
    );
  });
});
