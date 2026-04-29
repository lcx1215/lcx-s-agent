import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinanceLearningCapabilityCandidatesPath,
  parseFinanceLearningCapabilityCandidateArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceLearningPipelineOrchestratorTool } from "./finance-learning-pipeline-orchestrator-tool.js";

async function seedFile(workspaceDir: string, relativePath: string, content: string) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

async function readWorkspaceFile(workspaceDir: string, relativePath: string) {
  return fs.readFile(path.join(workspaceDir, relativePath), "utf8");
}

const SAFE_RETRIEVAL_NOTES =
  "Operator provided a bounded finance research source with explicit provenance, concrete method notes, evidence-bearing cognition, and no remote fetch request in this orchestration step.";
const SAFE_COMPLIANCE_NOTES =
  "Use only public feeds, local exports, normal browser-visible access, or manual operator capture with no bypasses.";

type PipelineDetails = Record<string, unknown> & {
  inspectTargets: unknown[];
  normalizedArticleArtifactPaths: string[];
  normalizedReferenceArtifactPaths: string[];
  extractionResults: unknown[];
  retrievalFirstLearning: {
    postAttachCapabilityRetrieval: { candidates: unknown[] };
    retrievalReceiptPath: string;
    retrievalReviewPath: string;
    failedReason: string | null;
  };
  applicationValidation: {
    usageReceiptPath: string | null;
    usageReviewPath: string | null;
  };
  attachResults: unknown[];
  extractionGap: unknown;
};

function asPipelineDetails(details: unknown): PipelineDetails {
  return details as PipelineDetails;
}

function buildStructuredArticle(overrides?: {
  title?: string;
  source?: string;
  publishDate?: string;
  domains?: string;
  tags?: string;
  evidenceCategories?: string;
  evidenceSummary?: string;
  methodSummary?: string;
  causalClaim?: string;
  riskAndFailureModes?: string;
  suggestedAttachmentPoint?: string;
  allowedActionAuthority?: string;
  bodyTail?: string;
}) {
  return [
    `# ${overrides?.title ?? "ETF event triage workflow"}`,
    "",
    `Source: ${overrides?.source ?? "Finance Method Notebook"}`,
    `Publish Date: ${overrides?.publishDate ?? "2026-04-17"}`,
    "Extraction Summary: This article extracts a bounded finance research workflow with explicit evidence categories, mechanism claims, and failure-mode discipline for later manual review.",
    "Capability Name: ETF event triage workflow",
    "Capability Type: analysis_method",
    `Related Finance Domains: ${overrides?.domains ?? "event_driven, etf_regime"}`,
    `Capability Tags: ${overrides?.tags ?? "sentiment_analysis, event_catalyst_mapping"}`,
    `Method Summary: ${
      overrides?.methodSummary ??
      "Convert repeated event headlines and ETF context into bounded follow-up research buckets rather than directional action calls."
    }`,
    "Required Data Sources: public headlines, ETF issuer notes, earnings calendar",
    `Causal Claim: ${
      overrides?.causalClaim ??
      "Repeated event clusters can shift which ETF and event follow-up work deserves priority, without proving a durable forecasting edge."
    }`,
    `Evidence Categories: ${
      overrides?.evidenceCategories ??
      "sentiment_evidence, event_catalyst_evidence, equity_market_evidence, etf_regime_evidence, portfolio_risk_evidence"
    }`,
    `Evidence Summary: ${
      overrides?.evidenceSummary ??
      "Public headlines, event calendars, equity-market context, and ETF regime evidence support bounded event triage while still requiring manual follow-up."
    }`,
    "Evidence Level: case_study",
    "Implementation Requirements: Maintain a tagged article log, manual event clustering, and bounded review discipline.",
    `Risk and Failure Modes: ${
      overrides?.riskAndFailureModes ??
      "Headline tone can invert quickly, event narratives can crowd together, and ETF follow-up can overreact to noisy coverage."
    }`,
    "Overfitting or Spurious Risk: Memorable events can look more predictive than they are, and editorial selection bias can distort the apparent signal.",
    "Compliance or Collection Notes: Use public articles, local exports, or manual operator capture only.",
    `Suggested Attachment Point: ${
      overrides?.suggestedAttachmentPoint ?? "research_capability:sentiment_analysis"
    }`,
    `Allowed Action Authority: ${overrides?.allowedActionAuthority ?? "research_only"}`,
    "",
    overrides?.bodyTail ??
      "This note describes a reusable research method only and leaves later human evaluation explicit.",
  ].join("\n");
}

function buildRssExport(articleBody: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Public Finance Feed</title>
    <item>
      <title>ETF event triage workflow</title>
      <link>https://example.com/etf-event-triage</link>
      <description><![CDATA[${articleBody}]]></description>
      <pubDate>2026-04-17</pubDate>
      <author>Finance Method Notebook</author>
    </item>
  </channel>
</rss>`;
}

function buildInsufficientProseArticle() {
  return `# Timing note

## Method

- Use a simple checklist to decide when a theme feels stronger than usual.
- Turn the checklist into a cleaner workflow for later discussion.
`;
}

async function readCandidateArtifact(workspaceDir: string) {
  return parseFinanceLearningCapabilityCandidateArtifact(
    await readWorkspaceFile(workspaceDir, buildFinanceLearningCapabilityCandidatesPath()),
  );
}

describe("finance learning pipeline orchestrator tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("completes the full pipeline for a valid external markdown export and preserves adapter provenance", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    await seedFile(workspaceDir, "memory/imports/etf-event-triage.md", buildStructuredArticle());
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("external-markdown", {
      adapterName: "markdown-exporter",
      adapterType: "markdown_article_export",
      inputPath: "memory/imports/etf-event-triage.md",
      sourceFamily: "research_blog",
      sourceName: "Finance Method Notebook",
      collectionMethod: "external_tool_export",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: true,
        intakeRoute: "external_source_adapter",
        intakeTool: "finance_external_source_adapter",
        inspectTool: "finance_learning_capability_inspect",
        retainedCandidateCount: 1,
        noRemoteFetchOccurred: true,
        provenancePreserved: true,
      }),
    );
    expect(asPipelineDetails(result.details).inspectTargets).toHaveLength(1);
    expect(asPipelineDetails(result.details).normalizedArticleArtifactPaths).toHaveLength(1);

    const normalizedArtifact = await readWorkspaceFile(
      workspaceDir,
      asPipelineDetails(result.details).normalizedArticleArtifactPaths[0],
    );
    expect(normalizedArtifact).toContain("**Adapter Name**: markdown-exporter");
    expect(normalizedArtifact).toContain("**Adapter Type**: markdown_article_export");
    expect(normalizedArtifact).toContain("**Adapter Collection Method**: external_tool_export");

    const parsedCandidates = await readCandidateArtifact(workspaceDir);
    expect(parsedCandidates?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceArticlePath: asPipelineDetails(result.details).normalizedArticleArtifactPaths[0],
          capabilityName: "ETF event triage workflow",
          relatedFinanceDomains: ["event_driven", "etf_regime"],
        }),
      ]),
    );
  });

  it("completes the full pipeline for a valid RSS export item", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    await seedFile(
      workspaceDir,
      "memory/imports/public-feed.xml",
      buildRssExport(buildStructuredArticle()),
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("rss-pipeline", {
      adapterName: "public-feed-adapter",
      adapterType: "rss_atom_json_feed",
      inputPath: "memory/imports/public-feed.xml",
      feedUrl: "https://example.com/feed.xml",
      sourceFamily: "public_feed",
      sourceName: "Public Finance Feed",
      collectionMethod: "rss_or_public_feed_if_available",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
      isPubliclyAccessible: true,
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: true,
        intakeRoute: "external_source_adapter",
        retainedCandidateCount: 1,
        noRemoteFetchOccurred: true,
      }),
    );
    expect(asPipelineDetails(result.details).extractionResults).toEqual([
      expect.objectContaining({
        extractedCandidateCount: 1,
      }),
    ]);
  });

  it("completes the full pipeline for valid manual pasted article input", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("manual-pasted", {
      sourceName: "Manual Finance Note",
      sourceType: "manual_article_source",
      pastedText: buildStructuredArticle(),
      title: "ETF event triage workflow",
      publishDate: "2026-04-17",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      allowedActionAuthority: "research_only",
      learningIntent:
        "学习一套 ETF 事件驱动和因子择时研究流程，能处理 catalyst mapping、regime risk 和 out of sample 失效风险",
      maxRetrievedCapabilities: 3,
      applicationValidationQuery:
        "把刚学到的 ETF event triage workflow 应用到一个新的 ETF catalyst mapping 和 regime risk 研究问题",
      maxAppliedCapabilities: 2,
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: true,
        intakeRoute: "research_source_workbench",
        intakeTool: "finance_research_source_workbench",
        retainedCandidateCount: 1,
        inspectTool: "finance_learning_capability_inspect",
        retrievalFirstLearning: expect.objectContaining({
          ok: true,
          learningIntent:
            "学习一套 ETF 事件驱动和因子择时研究流程，能处理 catalyst mapping、regime risk 和 out of sample 失效风险",
          maxRetrievedCapabilities: 3,
          retrievalReceiptPath: expect.stringMatching(
            /^memory\/finance-learning-retrieval-receipts\/\d{4}-\d{2}-\d{2}\/.+\.json$/u,
          ),
          retrievalReviewPath: expect.stringMatching(
            /^memory\/finance-learning-retrieval-reviews\/\d{4}-\d{2}-\d{2}\.json$/u,
          ),
          retrievalReviewCounts: expect.objectContaining({
            validReceipts: 1,
            retrievableAfterLearning: 1,
            applicationReadyAfterLearning: 1,
            newlyRetrievable: 1,
            weakLearningReceipts: 0,
          }),
          postAttachCandidateCount: 1,
          applicationReadyCandidateCount: 1,
          learningInternalizationStatus: "application_ready",
          failedReason: null,
          weakLearningIntents: [],
          classificationContract:
            "Use stable finance domains plus capability tags and query-ranked capability cards before creating narrower categories.",
          preflightCapabilityRetrieval: expect.objectContaining({
            ok: false,
            reason: "finance_learning_capability_candidates_missing",
          }),
          postAttachCapabilityRetrieval: expect.objectContaining({
            ok: true,
            retrievalMode: "query_ranked",
            candidateCount: 1,
          }),
        }),
        applicationValidation: expect.objectContaining({
          ok: true,
          applicationValidationQuery:
            "把刚学到的 ETF event triage workflow 应用到一个新的 ETF catalyst mapping 和 regime risk 研究问题",
          maxAppliedCapabilities: 2,
          applicationValidationStatus: "application_ready",
          candidateCount: 1,
          failedReason: null,
          applicationMode: "reuse_guidance_bounded_research_answer",
          synthesisMode: "single_capability_application",
          usageReceiptPath: expect.stringMatching(
            /^memory\/finance-learning-apply-usage-receipts\/\d{4}-\d{2}-\d{2}\/.+\.json$/u,
          ),
          usageReviewPath: expect.stringMatching(
            /^memory\/finance-learning-apply-usage-reviews\/\d{4}-\d{2}-\d{2}\.json$/u,
          ),
          answerSkeleton: expect.objectContaining({
            applyOrRefuseRule: expect.stringContaining("say the retained capability is not ready"),
            answerScaffold: expect.objectContaining({
              status: "scaffold_only_until_fresh_inputs_are_checked",
              sections: expect.arrayContaining([
                expect.objectContaining({
                  heading: "Evidence families checked",
                }),
              ]),
              outputDiscipline: expect.objectContaining({
                forbidden: expect.stringContaining("trade execution approval"),
              }),
            }),
            noActionBoundary: expect.stringContaining("research-only"),
          }),
          appliedCapabilities: [
            expect.objectContaining({
              capabilityName: "ETF event triage workflow",
              applicationChecklist: expect.arrayContaining([
                expect.stringContaining("Refresh inputs"),
              ]),
            }),
          ],
        }),
      }),
    );
    expect(
      asPipelineDetails(result.details).retrievalFirstLearning.postAttachCapabilityRetrieval
        .candidates,
    ).toEqual([
      expect.objectContaining({
        capabilityName: "ETF event triage workflow",
        retrievalScore: expect.any(Number),
      }),
    ]);
    const receipt = JSON.parse(
      await readWorkspaceFile(
        workspaceDir,
        asPipelineDetails(result.details).retrievalFirstLearning.retrievalReceiptPath,
      ),
    ) as {
      boundary: string;
      learningIntent: string;
      preflightCandidateCount: number;
      postAttachCandidateCount: number;
      newlyRetrievableCandidateDelta: number;
      retrievalFirstLearningApplied: boolean;
      noExecutionAuthority: boolean;
      noDoctrineMutation: boolean;
      applicationValidation: {
        requested: boolean;
        status: string;
        candidateCount: number;
        failedReason: string | null;
        usageReceiptPath: string | null;
        usageReviewPath: string | null;
      };
    };
    expect(receipt).toMatchObject({
      boundary: "finance_learning_retrieval_receipt",
      learningIntent:
        "学习一套 ETF 事件驱动和因子择时研究流程，能处理 catalyst mapping、regime risk 和 out of sample 失效风险",
      preflightCandidateCount: 0,
      postAttachCandidateCount: 1,
      newlyRetrievableCandidateDelta: 1,
      retrievalFirstLearningApplied: true,
      noExecutionAuthority: true,
      noDoctrineMutation: true,
      applicationValidation: {
        requested: true,
        status: "application_ready",
        candidateCount: 1,
        failedReason: null,
        usageReceiptPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-receipts\/\d{4}-\d{2}-\d{2}\/.+\.json$/u,
        ),
        usageReviewPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-reviews\/\d{4}-\d{2}-\d{2}\.json$/u,
        ),
      },
    });
    const review = JSON.parse(
      await readWorkspaceFile(
        workspaceDir,
        asPipelineDetails(result.details).retrievalFirstLearning.retrievalReviewPath,
      ),
    ) as {
      boundary: string;
      separationContract: {
        languageCorpusUntouched: boolean;
        protectedMemoryUntouched: boolean;
      };
      counts: {
        validReceipts: number;
        applicationReadyAfterLearning: number;
        applicationValidatedAfterLearning: number;
        applicationValidationRequested: number;
        weakLearningReceipts: number;
      };
      rows: Array<{
        applicationValidationUsageReceiptPath: string | null;
        applicationValidationUsageReviewPath: string | null;
      }>;
    };
    expect(review).toMatchObject({
      boundary: "finance_learning_retrieval_review",
      counts: {
        validReceipts: 1,
        applicationReadyAfterLearning: 1,
        applicationValidatedAfterLearning: 1,
        applicationValidationRequested: 1,
        weakLearningReceipts: 0,
      },
      separationContract: {
        languageCorpusUntouched: true,
        protectedMemoryUntouched: true,
      },
    });
    expect(review.rows).toEqual([
      expect.objectContaining({
        applicationValidationUsageReceiptPath: asPipelineDetails(result.details)
          .applicationValidation.usageReceiptPath,
        applicationValidationUsageReviewPath: asPipelineDetails(result.details)
          .applicationValidation.usageReviewPath,
      }),
    ]);
    expect(asPipelineDetails(result.details).attachResults).toEqual([
      expect.objectContaining({
        inspectTool: "finance_learning_capability_inspect",
      }),
    ]);
  });

  it("surfaces retrieval-first failedReason when a learned source is retained but not retrievable for the learning intent", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("retrieval-first-mismatch", {
      sourceName: "ETF event note",
      sourceType: "manual_article_source",
      pastedText: buildStructuredArticle(),
      title: "ETF event triage workflow",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      allowedActionAuthority: "research_only",
      learningIntent: "学习期权隐含波动率曲面套利和 vega 对冲框架",
      maxRetrievedCapabilities: 3,
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: true,
        retainedCandidateCount: 1,
        retrievalFirstLearning: expect.objectContaining({
          learningInternalizationStatus: "not_retrievable",
          failedReason: "not_retrievable_after_learning",
          postAttachCandidateCount: 0,
          applicationReadyCandidateCount: 0,
          weakLearningIntents: [
            expect.objectContaining({
              reason: "not_retrievable_after_learning",
              failedReason: "not_retrievable_after_learning",
            }),
          ],
        }),
      }),
    );
  });

  it("completes the full pipeline for a valid local file", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    await seedFile(
      workspaceDir,
      "memory/articles/local-credit-note.md",
      buildStructuredArticle({
        title: "Credit liquidity mapping workflow",
        domains: "credit_liquidity",
        tags: "causal_mapping",
        evidenceCategories:
          "credit_evidence, liquidity_evidence, causal_chain_evidence, portfolio_risk_evidence",
        evidenceSummary:
          "Credit spreads, funding pressure, and causal transmission evidence support bounded liquidity mapping and later manual review.",
        suggestedAttachmentPoint: "finance_framework_domain:credit_liquidity",
      }),
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("local-file", {
      sourceName: "Local Credit Note",
      sourceType: "manual_article_source",
      localFilePath: "memory/articles/local-credit-note.md",
      title: "Credit liquidity mapping workflow",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: true,
        intakeRoute: "research_source_workbench",
        retainedCandidateCount: 1,
      }),
    );
  });

  it("records Google/web references as metadata only without fetching remote content", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("metadata-only-reference", {
      sourceName: "Google search reference",
      sourceType: "public_web_source",
      userProvidedUrl:
        "https://www.google.com/search?q=site%3Asec.gov+liquidity+funding+stress+10-k",
      title: "Google reference for SEC liquidity work",
      retrievalNotes:
        "Operator recorded a web discovery reference only as metadata for later manual source capture, with no remote fetch in this step.",
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: true,
        extractionSkipped: true,
        extractionSkippedReason: "metadata_only_reference_source",
        noRemoteFetchOccurred: true,
        inspectTool: null,
      }),
    );
    expect(asPipelineDetails(result.details).normalizedArticleArtifactPaths).toEqual([]);
    expect(asPipelineDetails(result.details).normalizedReferenceArtifactPaths).toHaveLength(1);
  });

  it("fails closed before extraction for blocked or bypass collection requests", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("blocked-intake", {
      sourceName: "Blocked source",
      sourceType: "public_web_source",
      userProvidedUrl: "https://example.com/paywalled",
      retrievalNotes:
        "Use paywall bypass and hidden API scraping if needed to capture the article for research.",
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: false,
        failedStep: "intake",
        intakeRoute: "research_source_workbench",
      }),
    );
  });

  it("prevents attachment when extraction fails", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("extract-failure", {
      sourceName: "Incomplete note",
      sourceType: "manual_article_source",
      pastedText:
        "This finance article has real prose and concrete context, but it does not include the structured extraction fields the article extractor requires.",
      title: "Incomplete note",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: false,
        failedStep: "extract",
        reason: "finance_article_extraction_gap",
      }),
    );
    expect(asPipelineDetails(result.details).extractionGap).toEqual(
      expect.objectContaining({
        missingFields: expect.arrayContaining(["methodSummary", "evidenceCategories"]),
      }),
    );
  });

  it("prevents retained candidates when the evidence gate fails", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("evidence-gate-failure", {
      sourceName: "Mismatched evidence note",
      sourceType: "manual_article_source",
      pastedText: buildStructuredArticle({
        domains: "credit_liquidity",
        tags: "sentiment_analysis",
        evidenceCategories: "sentiment_evidence, event_catalyst_evidence, portfolio_risk_evidence",
        evidenceSummary:
          "This intentionally mismatches the selected credit/liquidity domain by only providing sentiment and event evidence.",
        suggestedAttachmentPoint: "finance_framework_domain:credit_liquidity",
      }),
      title: "Mismatched evidence note",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: false,
        failedStep: "attach",
        reason: "finance_learning_pipeline_attachment_failed",
      }),
    );

    const candidateArtifactPath = path.join(
      workspaceDir,
      buildFinanceLearningCapabilityCandidatesPath(),
    );
    await expect(fs.access(candidateArtifactPath)).rejects.toThrow();
  });

  it("fails closed on execution, trading, auto-promotion, and doctrine mutation signals", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    for (const flag of [
      "executionRequested",
      "autoPromotionRequested",
      "doctrineMutationRequested",
    ] as const) {
      const result = await tool.execute(`blocked-${flag}`, {
        sourceName: "Forbidden authority source",
        sourceType: "manual_article_source",
        pastedText: buildStructuredArticle(),
        title: "Forbidden authority source",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
        [flag]: true,
      });

      expect(asPipelineDetails(result.details)).toEqual(
        expect.objectContaining({
          ok: false,
          failedStep: "intake",
          intakeRoute: "research_source_workbench",
        }),
      );
    }
  });

  it("preserves an extraction gap when prose intake succeeds but semantic extraction is still insufficient", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-pipeline-");
    await seedFile(
      workspaceDir,
      "memory/articles/insufficient-prose.md",
      buildInsufficientProseArticle(),
    );
    const tool = createFinanceLearningPipelineOrchestratorTool({ workspaceDir });

    const result = await tool.execute("insufficient-prose", {
      sourceName: "Insufficient prose note",
      sourceType: "manual_article_source",
      localFilePath: "memory/articles/insufficient-prose.md",
      title: "Timing note",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
    });

    expect(asPipelineDetails(result.details)).toEqual(
      expect.objectContaining({
        ok: false,
        failedStep: "extract",
        reason: "finance_article_extraction_gap",
        extractionGap: expect.objectContaining({
          missingFields: expect.arrayContaining(["evidenceCategories", "riskAndFailureModes"]),
        }),
      }),
    );
  });
});
