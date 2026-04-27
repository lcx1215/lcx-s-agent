import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinanceLearningCapabilityCandidatesPath,
  parseFinanceLearningCapabilityCandidateArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceLearningCapabilityApplyTool } from "./finance-learning-capability-apply-tool.js";
import { createFinanceLearningCapabilityAttachTool } from "./finance-learning-capability-attach-tool.js";
import { createFinanceLearningCapabilityInspectTool } from "./finance-learning-capability-inspect-tool.js";

async function seedArticle(workspaceDir: string, relativePath: string, content: string) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

function buildValidArgs() {
  return {
    articlePath: "memory/articles/wechat-liquidity-regime.md",
    title: "Liquidity and regime notes",
    sourceType: "wechat_public_account_article",
    collectionMethod: "public_wechat_capture",
    authorSourceName: "Example public account",
    publishDate: "2026-04-15",
    extractionSummary:
      "This learning note extracts a reusable macro-liquidity mapping method with explicit evidence limits, failure modes, and bounded attachment points.",
    rawNotes:
      "Detailed notes on liquidity regime interpretation, caveats, and bounded research attachment points.",
    capabilityCandidates: [
      {
        capabilityName: "Liquidity regime mapper",
        capabilityType: "research_framework",
        relatedFinanceDomains: ["credit_liquidity", "macro_rates_inflation"],
        capabilityTags: ["factor_research", "causal_mapping"],
        evidenceCategories: [
          "credit_evidence",
          "liquidity_evidence",
          "macro_rates_evidence",
          "inflation_evidence",
          "causal_chain_evidence",
          "backtest_or_empirical_evidence",
        ],
        evidenceSummary:
          "Credit spread, funding, inflation, and rates evidence support the bounded liquidity-regime mapping method.",
        methodSummary: "Map liquidity stress indicators into bounded regime hypotheses.",
        requiredDataSources: ["credit spreads", "funding stress proxies"],
        causalOrMechanisticClaim:
          "Liquidity stress can transmit through funding conditions into cross-asset regime pressure.",
        evidenceLevel: "case_study",
        implementationRequirements: "Structured indicator ingestion and manual interpretation.",
        riskAndFailureModes:
          "Narrative overreach and regime misclassification during transient headline shocks.",
        overfittingOrSpuriousRisk:
          "Short-window crisis analogies can look stronger than they are out of sample, and confounders can distort the apparent relationship.",
        complianceOrCollectionNotes: "Use public or licensed market data only.",
        suggestedAttachmentPoint: "finance_framework_domain:credit_liquidity",
        allowedActionAuthority: "research_only",
      },
      {
        capabilityName: "Headline sentiment triage",
        capabilityType: "analysis_method",
        relatedFinanceDomains: ["event_driven"],
        capabilityTags: ["sentiment_analysis", "event_catalyst_mapping"],
        evidenceCategories: [
          "sentiment_evidence",
          "event_catalyst_evidence",
          "portfolio_risk_evidence",
        ],
        evidenceSummary:
          "Headline sentiment and event-catalyst evidence support bounded event triage rather than trading decisions.",
        methodSummary: "Classify event headlines into bounded follow-up research buckets.",
        requiredDataSources: ["headline feed", "manual event notes"],
        causalOrMechanisticClaim:
          "Headline clustering can reveal repeated catalyst patterns worth later research review.",
        evidenceLevel: "hypothesis",
        implementationRequirements: "Manual article triage and event tagging.",
        riskAndFailureModes:
          "Headline tone can invert quickly and does not imply durable price impact.",
        overfittingOrSpuriousRisk:
          "Event narratives can overfit a small sample of memorable moves.",
        complianceOrCollectionNotes: "Stay on public articles and manual tagging only.",
        suggestedAttachmentPoint: "research_capability:sentiment_analysis",
        allowedActionAuthority: "watch_only",
      },
    ],
  };
}

describe("finance learning capability tools", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("records retained capability candidates and supports inspect filters", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-liquidity-regime.md",
      "Article body with concrete discussion of liquidity transmission and event triage methods.",
    );
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });
    const inspectTool = createFinanceLearningCapabilityInspectTool({ workspaceDir });
    const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });

    const result = await attachTool.execute("finance-learning-attach", buildValidArgs());
    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        updated: true,
        artifactPath: "memory/local-memory/finance-learning-capability-candidates.md",
        sourceArticlePath: "memory/articles/wechat-liquidity-regime.md",
        inspectTool: "finance_learning_capability_inspect",
      }),
    );

    const parsed = parseFinanceLearningCapabilityCandidateArtifact(
      await fs.readFile(
        path.join(workspaceDir, buildFinanceLearningCapabilityCandidatesPath()),
        "utf8",
      ),
    );
    expect(parsed?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relatedFinanceDomains: ["credit_liquidity", "macro_rates_inflation"],
          capabilityTags: ["factor_research", "causal_mapping"],
          evidenceCategories: expect.arrayContaining(["credit_evidence", "liquidity_evidence"]),
        }),
      ]),
    );

    const inspectByDomain = await inspectTool.execute("inspect-domain", {
      domain: "credit_liquidity",
    });
    expect(inspectByDomain.details).toEqual(
      expect.objectContaining({
        ok: true,
        candidateCount: 1,
        candidates: [expect.objectContaining({ capabilityName: "Liquidity regime mapper" })],
      }),
    );

    const inspectByType = await inspectTool.execute("inspect-type", {
      capabilityType: "analysis_method",
    });
    expect(inspectByType.details).toEqual(
      expect.objectContaining({
        ok: true,
        candidateCount: 1,
        candidates: [expect.objectContaining({ capabilityName: "Headline sentiment triage" })],
      }),
    );

    const inspectBySource = await inspectTool.execute("inspect-source", {
      sourceArticlePath: "memory/articles/wechat-liquidity-regime.md",
    });
    expect(inspectBySource.details).toEqual(
      expect.objectContaining({
        ok: true,
        candidateCount: 2,
      }),
    );

    const inspectByQuery = await inspectTool.execute("inspect-query", {
      queryText: "因子择时 liquidity regime funding stress out of sample risk",
      maxCandidates: 1,
    });
    expect(inspectByQuery.details).toEqual(
      expect.objectContaining({
        ok: true,
        retrievalMode: "query_ranked",
        applicationMode: "retrieval_first_reuse_review",
        candidateCount: 1,
        filters: expect.objectContaining({
          queryText: "因子择时 liquidity regime funding stress out of sample risk",
          maxCandidates: 1,
        }),
        candidates: [
          expect.objectContaining({
            capabilityName: "Liquidity regime mapper",
            retrievalScore: expect.any(Number),
            reuseGuidance: expect.objectContaining({
              applicationBoundary: "research_only",
              attachmentPoint: "finance_framework_domain:credit_liquidity",
              requiredInputs: ["credit spreads", "funding stress proxies"],
              riskChecks: [
                "Narrative overreach and regime misclassification during transient headline shocks.",
                "Short-window crisis analogies can look stronger than they are out of sample, and confounders can distort the apparent relationship.",
              ],
              doNotUseFor:
                "Do not use this capability as trading execution approval, doctrine mutation, or a standalone prediction without fresh evidence and risk review.",
            }),
          }),
        ],
      }),
    );

    const unrelatedEnglishQuery = await inspectTool.execute("inspect-unrelated-english-query", {
      queryText: "open source github repository benchmark compliance dataset governance",
      maxCandidates: 5,
    });
    expect(unrelatedEnglishQuery.details).toEqual(
      expect.objectContaining({
        ok: true,
        retrievalMode: "query_ranked",
        candidateCount: 0,
        candidates: [],
      }),
    );

    const longMixedQuery = await inspectTool.execute("inspect-long-mixed-query", {
      queryText:
        "我要让系统学习一个很长的任务，里面同时提到 ETF liquidity regime funding stress portfolio risk out of sample 和其他上下文，不要因为 query 太长就漏掉相关能力",
      maxCandidates: 5,
    });
    expect(longMixedQuery.details).toEqual(
      expect.objectContaining({
        ok: true,
        retrievalMode: "query_ranked",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            capabilityName: "Liquidity regime mapper",
          }),
        ]),
      }),
    );

    const chineseOnlyRiskQuery = await inspectTool.execute("inspect-chinese-risk-query", {
      queryText: "把学到的流动性和资金面方法用于 ETF 风控，重点看回撤、样本外和仓位约束",
      maxCandidates: 2,
    });
    expect(chineseOnlyRiskQuery.details).toEqual(
      expect.objectContaining({
        ok: true,
        retrievalMode: "query_ranked",
        candidates: [
          expect.objectContaining({
            capabilityName: "Liquidity regime mapper",
            matchedSignals: expect.arrayContaining(["credit_liquidity", "liquidity_evidence"]),
          }),
        ],
      }),
    );

    const genericChineseQuery = await inspectTool.execute("inspect-generic-chinese-query", {
      queryText: "帮我学习一篇文章，然后以后回答问题更聪明一点",
      maxCandidates: 5,
    });
    expect(genericChineseQuery.details).toEqual(
      expect.objectContaining({
        ok: true,
        retrievalMode: "query_ranked",
        candidateCount: 0,
        candidates: [],
      }),
    );

    const appliedAnswer = await applyTool.execute("apply-liquidity-regime", {
      queryText:
        "怎么把 liquidity regime funding stress 学到的东西用于 ETF 风控研究，注意 out of sample 和 drawdown 风险",
      maxCandidates: 1,
    });
    expect(appliedAnswer.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "finance_learning_capability_apply_read_only",
        applicationMode: "reuse_guidance_bounded_research_answer",
        synthesisMode: "single_capability_application",
        candidateCount: 1,
        usageReceiptPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-receipts\/\d{4}-\d{2}-\d{2}\/.+\.json$/u,
        ),
        usageReviewPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-reviews\/\d{4}-\d{2}-\d{2}\.json$/u,
        ),
        answerSkeleton: expect.objectContaining({
          requiredSections: [
            "Retrieved capability used",
            "Fresh inputs checked",
            "Causal link tested",
            "Risk and overfitting checks",
            "Red-team invalidation",
            "Research-only conclusion",
          ],
          requiredNextChecks: expect.arrayContaining(["credit spreads", "funding stress proxies"]),
          requiredEvidenceCategories: expect.arrayContaining([
            "credit_evidence",
            "liquidity_evidence",
          ]),
          causalChecks: expect.arrayContaining([
            "Liquidity stress can transmit through funding conditions into cross-asset regime pressure.",
          ]),
          implementationChecks: expect.arrayContaining([
            "Structured indicator ingestion and manual interpretation.",
          ]),
          riskChecks: expect.arrayContaining([
            "Narrative overreach and regime misclassification during transient headline shocks.",
          ]),
          answerScaffold: expect.objectContaining({
            status: "scaffold_only_until_fresh_inputs_are_checked",
            capabilitySynthesis: expect.objectContaining({
              mode: "single_capability_application",
              primaryCapability: "Liquidity regime mapper",
              supportingCapabilities: [],
            }),
            oneLineUse: expect.stringContaining("refresh inputs"),
            sections: expect.arrayContaining([
              expect.objectContaining({
                heading: "Capability synthesis plan",
                writeThis: expect.stringContaining("single research frame"),
              }),
              expect.objectContaining({
                heading: "Fresh inputs checked",
                writeThis: expect.stringContaining("credit spreads"),
                mustInclude: expect.arrayContaining(["credit spreads", "funding stress proxies"]),
              }),
              expect.objectContaining({
                heading: "Research-only conclusion",
                writeThis: expect.stringContaining("not ready to apply"),
                mustInclude: expect.arrayContaining(["no trade approval", "no auto-promotion"]),
              }),
            ]),
            refusalTriggers: expect.arrayContaining([
              "required inputs are missing or stale",
              expect.stringContaining("Do not use this capability as trading execution approval"),
            ]),
            outputDiscipline: expect.objectContaining({
              forbidden: expect.stringContaining("trade execution approval"),
            }),
          }),
          applyOrRefuseRule:
            "If any required input, evidence family, causal check, or risk check is missing for the current question, say the retained capability is not ready to apply instead of filling the gap with generic commentary.",
          noActionBoundary:
            "This application is research-only and does not approve trades, auto-promotion, doctrine mutation, or standalone prediction.",
        }),
        appliedCapabilities: [
          expect.objectContaining({
            capabilityName: "Liquidity regime mapper",
            applicationBoundary: "research_only",
            requiredInputs: ["credit spreads", "funding stress proxies"],
            requiredEvidenceCategories: expect.arrayContaining([
              "credit_evidence",
              "liquidity_evidence",
            ]),
            applicationChecklist: expect.arrayContaining([
              "Refresh inputs: credit spreads, funding stress proxies",
              "Check evidence families: credit_evidence, liquidity_evidence, macro_rates_evidence, inflation_evidence, causal_chain_evidence, backtest_or_empirical_evidence",
              "Implementation constraint: Structured indicator ingestion and manual interpretation.",
            ]),
            doNotUseFor:
              "Do not use this capability as trading execution approval, doctrine mutation, or a standalone prediction without fresh evidence and risk review.",
          }),
        ],
      }),
    );
    const applyReceipt = JSON.parse(
      await fs.readFile(path.join(workspaceDir, appliedAnswer.details.usageReceiptPath), "utf8"),
    ) as {
      boundary: string;
      ok: boolean;
      synthesisMode: string;
      candidateCount: number;
      appliedCapabilities: Array<{ capabilityName: string }>;
      noExecutionAuthority: boolean;
      noDoctrineMutation: boolean;
    };
    expect(applyReceipt).toMatchObject({
      boundary: "finance_learning_capability_apply_usage_receipt",
      ok: true,
      synthesisMode: "single_capability_application",
      candidateCount: 1,
      appliedCapabilities: [expect.objectContaining({ capabilityName: "Liquidity regime mapper" })],
      noExecutionAuthority: true,
      noDoctrineMutation: true,
    });
    const firstUsageReview = JSON.parse(
      await fs.readFile(path.join(workspaceDir, appliedAnswer.details.usageReviewPath), "utf8"),
    ) as {
      boundary: string;
      counts: { usageReceipts: number; successfulApplications: number };
      topCapabilities: Array<{ capabilityName: string; count: number }>;
    };
    expect(firstUsageReview).toMatchObject({
      boundary: "finance_learning_capability_apply_usage_review",
      counts: {
        usageReceipts: 1,
        successfulApplications: 1,
      },
      topCapabilities: [{ capabilityName: "Liquidity regime mapper", count: 1 }],
    });

    const synthesizedAnswer = await applyTool.execute("apply-multi-capability", {
      queryText:
        "把 liquidity regime funding stress 和 headline event catalyst triage 一起用于 ETF 风控研究，检查 portfolio risk、drawdown 和样本外失效",
      maxCandidates: 2,
    });
    expect(synthesizedAnswer.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "finance_learning_capability_apply_read_only",
        applicationMode: "reuse_guidance_bounded_research_answer",
        synthesisMode: "multi_capability_synthesis",
        candidateCount: 2,
        usageReceiptPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-receipts\/\d{4}-\d{2}-\d{2}\/.+\.json$/u,
        ),
        usageReviewPath: appliedAnswer.details.usageReviewPath,
        answerSkeleton: expect.objectContaining({
          capabilitySynthesis: expect.objectContaining({
            mode: "multi_capability_synthesis",
            primaryCapability: expect.any(String),
            supportingCapabilities: expect.arrayContaining(["Liquidity regime mapper"]),
            combinedRequiredInputs: expect.arrayContaining([
              "credit spreads",
              "funding stress proxies",
              "headline feed",
              "manual event notes",
            ]),
            combinedEvidenceCategories: expect.arrayContaining([
              "liquidity_evidence",
              "event_catalyst_evidence",
              "portfolio_risk_evidence",
            ]),
            synthesisOrder: expect.arrayContaining([
              "Use the primary capability to define the research frame.",
              "Merge overlapping checks, but keep stricter risk and implementation constraints.",
            ]),
            conflictChecks: expect.arrayContaining([
              "Does the combined frame create unsupported timing, sizing, or execution language?",
            ]),
          }),
          answerScaffold: expect.objectContaining({
            capabilitySynthesis: expect.objectContaining({
              mode: "multi_capability_synthesis",
            }),
            sections: expect.arrayContaining([
              expect.objectContaining({
                heading: "Capability synthesis plan",
                writeThis: expect.stringContaining("Headline sentiment triage"),
                mustInclude: expect.arrayContaining([
                  "primary capability",
                  "supporting capability",
                  "conflict checks",
                ]),
              }),
            ]),
          }),
        }),
        appliedCapabilities: expect.arrayContaining([
          expect.objectContaining({ capabilityName: "Liquidity regime mapper" }),
          expect.objectContaining({ capabilityName: "Headline sentiment triage" }),
        ]),
      }),
    );
    const synthesizedReceipt = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, synthesizedAnswer.details.usageReceiptPath),
        "utf8",
      ),
    ) as {
      synthesisMode: string;
      capabilitySynthesis: { mode: string };
      appliedCapabilities: Array<{ capabilityName: string }>;
    };
    expect(synthesizedReceipt).toMatchObject({
      synthesisMode: "multi_capability_synthesis",
      capabilitySynthesis: { mode: "multi_capability_synthesis" },
      appliedCapabilities: expect.arrayContaining([
        expect.objectContaining({ capabilityName: "Liquidity regime mapper" }),
        expect.objectContaining({ capabilityName: "Headline sentiment triage" }),
      ]),
    });
    const synthesizedUsageReview = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, synthesizedAnswer.details.usageReviewPath),
        "utf8",
      ),
    ) as {
      counts: {
        usageReceipts: number;
        successfulApplications: number;
        multiCapabilitySyntheses: number;
      };
      topCapabilities: Array<{ capabilityName: string; count: number }>;
    };
    expect(synthesizedUsageReview).toEqual(
      expect.objectContaining({
        counts: expect.objectContaining({
          usageReceipts: 2,
          successfulApplications: 2,
          multiCapabilitySyntheses: 1,
        }),
        topCapabilities: expect.arrayContaining([
          { capabilityName: "Liquidity regime mapper", count: 2 },
          { capabilityName: "Headline sentiment triage", count: 1 },
        ]),
      }),
    );
  });

  it("fails closed when no retained capability can answer the research question", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-liquidity-regime.md",
      "Article body with concrete discussion of liquidity transmission and event triage methods.",
    );
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });
    const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });

    await attachTool.execute("finance-learning-attach", buildValidArgs());
    const appliedAnswer = await applyTool.execute("apply-unrelated", {
      queryText: "open source github repository benchmark compliance dataset governance",
      maxCandidates: 3,
    });
    expect(appliedAnswer.details).toEqual(
      expect.objectContaining({
        ok: false,
        boundary: "finance_learning_capability_apply_read_only",
        usageReceiptPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-receipts\/\d{4}-\d{2}-\d{2}\/.+\.json$/u,
        ),
        usageReviewPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-reviews\/\d{4}-\d{2}-\d{2}\.json$/u,
        ),
        reason: "no_retrievable_finance_capability",
        action:
          "Do not improvise a learned answer. First run finance_learning_pipeline_orchestrator on a safe source or refine the query against existing capability tags.",
      }),
    );
    const refusalReceipt = JSON.parse(
      await fs.readFile(path.join(workspaceDir, appliedAnswer.details.usageReceiptPath), "utf8"),
    ) as {
      boundary: string;
      ok: boolean;
      reason: string;
      candidateCount: number;
    };
    expect(refusalReceipt).toMatchObject({
      boundary: "finance_learning_capability_apply_usage_receipt",
      ok: false,
      reason: "no_retrievable_finance_capability",
      candidateCount: 0,
    });
    const refusalUsageReview = JSON.parse(
      await fs.readFile(path.join(workspaceDir, appliedAnswer.details.usageReviewPath), "utf8"),
    ) as {
      counts: { usageReceipts: number; refusedApplications: number };
      refusedQueries: Array<{ reason: string }>;
    };
    expect(refusalUsageReview).toEqual(
      expect.objectContaining({
        counts: expect.objectContaining({
          usageReceipts: 1,
          refusedApplications: 1,
        }),
        refusedQueries: [expect.objectContaining({ reason: "no_retrievable_finance_capability" })],
      }),
    );
  });

  it("writes a refusal receipt when a retrieved capability is missing reuse guidance", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    const applyTool = createFinanceLearningCapabilityApplyTool({
      workspaceDir,
      inspectTool: {
        label: "Stub Inspect",
        name: "finance_learning_capability_inspect",
        description: "Stub inspect tool",
        parameters: {},
        execute: async () => ({
          content: [],
          details: {
            ok: true,
            retrievalMode: "query_ranked",
            candidateCount: 1,
            candidates: [
              {
                capabilityName: "Incomplete ETF timing capability",
                sourceArticlePath: "memory/articles/incomplete-etf-timing.md",
                retrievalScore: 0.9,
                matchedSignals: ["etf_regime"],
                reuseGuidance: {
                  applicationBoundary: "research_only",
                  attachmentPoint: "finance_framework_domain:etf_regime",
                  useFor: "Use for ETF timing research only.",
                  requiredInputs: [],
                  requiredEvidenceCategories: ["etf_regime_evidence"],
                  causalCheck: "ETF regime evidence can shape timing research.",
                  riskChecks: ["Overfitting risk."],
                  implementationCheck: "Refresh inputs before use.",
                  doNotUseFor: "Do not use as execution approval.",
                },
              },
            ],
          },
        }),
      },
    });

    const appliedAnswer = await applyTool.execute("apply-missing-reuse-guidance", {
      queryText: "Use the retained ETF timing capability for research",
      maxCandidates: 1,
    });

    expect(appliedAnswer.details).toEqual(
      expect.objectContaining({
        ok: false,
        boundary: "finance_learning_capability_apply_read_only",
        reason: "missing_reuse_guidance",
        candidateCount: 1,
        usageReceiptPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-receipts\/\d{4}-\d{2}-\d{2}\/.+\.json$/u,
        ),
        usageReviewPath: expect.stringMatching(
          /^memory\/finance-learning-apply-usage-reviews\/\d{4}-\d{2}-\d{2}\.json$/u,
        ),
        missingReuseGuidanceCapabilities: [
          {
            capabilityName: "Incomplete ETF timing capability",
            sourceArticlePath: "memory/articles/incomplete-etf-timing.md",
          },
        ],
        action:
          "Repair retained finance capability reuse guidance before applying this learning to a research answer.",
      }),
    );
    const refusalReceipt = JSON.parse(
      await fs.readFile(path.join(workspaceDir, appliedAnswer.details.usageReceiptPath), "utf8"),
    ) as {
      boundary: string;
      ok: boolean;
      reason: string;
      candidateCount: number;
      appliedCapabilities: Array<{ capabilityName: string }>;
    };
    expect(refusalReceipt).toMatchObject({
      boundary: "finance_learning_capability_apply_usage_receipt",
      ok: false,
      reason: "missing_reuse_guidance",
      candidateCount: 1,
      appliedCapabilities: [
        expect.objectContaining({ capabilityName: "Incomplete ETF timing capability" }),
      ],
    });
    const refusalUsageReview = JSON.parse(
      await fs.readFile(path.join(workspaceDir, appliedAnswer.details.usageReviewPath), "utf8"),
    ) as {
      counts: { usageReceipts: number; refusedApplications: number };
      refusedQueries: Array<{ reason: string }>;
    };
    expect(refusalUsageReview).toEqual(
      expect.objectContaining({
        counts: expect.objectContaining({
          usageReceipts: 1,
          refusedApplications: 1,
        }),
        refusedQueries: [expect.objectContaining({ reason: "missing_reuse_guidance" })],
      }),
    );
  });

  it("can disable apply usage receipts for dry validation", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-liquidity-regime.md",
      "Article body with concrete discussion of liquidity transmission and event triage methods.",
    );
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });
    const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });

    await attachTool.execute("finance-learning-attach", buildValidArgs());
    const appliedAnswer = await applyTool.execute("apply-dry", {
      queryText:
        "怎么把 liquidity regime funding stress 学到的东西用于 ETF 风控研究，注意 out of sample 和 drawdown 风险",
      maxCandidates: 1,
      writeUsageReceipt: false,
    });
    expect(appliedAnswer.details).toEqual(
      expect.objectContaining({
        ok: true,
        usageReceiptPath: null,
        usageReviewPath: null,
        synthesisMode: "single_capability_application",
      }),
    );
    await expect(
      fs.stat(path.join(workspaceDir, "memory", "finance-learning-apply-usage-receipts")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(workspaceDir, "memory", "finance-learning-apply-usage-reviews")),
    ).rejects.toThrow();
  });

  it("rejects empty or generic article learning inputs", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    await seedArticle(workspaceDir, "memory/articles/empty.md", "");
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });
    await expect(
      attachTool.execute("empty-article", {
        ...buildValidArgs(),
        articlePath: "memory/articles/empty.md",
      }),
    ).rejects.toThrow("source article artifact content must be non-empty");

    await seedArticle(workspaceDir, "memory/articles/generic.md", "Some real content.");
    await expect(
      attachTool.execute("generic-summary", {
        ...buildValidArgs(),
        articlePath: "memory/articles/generic.md",
        extractionSummary: "This article discusses markets in general.",
      }),
    ).rejects.toThrow("extractionSummary must contain non-generic");
  });

  it("rejects missing source artifact and missing required candidate fields", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });

    await expect(attachTool.execute("missing-source", buildValidArgs())).rejects.toThrow(
      "source article artifact is missing",
    );

    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-liquidity-regime.md",
      "Valid article body content.",
    );
    await expect(
      attachTool.execute("missing-method-summary", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            methodSummary: "   ",
          },
        ],
      }),
    ).rejects.toThrow("methodSummary must be non-empty");

    await expect(
      attachTool.execute("missing-causal-claim", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            causalOrMechanisticClaim: "   ",
          },
        ],
      }),
    ).rejects.toThrow("causalOrMechanisticClaim must be non-empty");

    await expect(
      attachTool.execute("missing-risk", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            riskAndFailureModes: "   ",
          },
        ],
      }),
    ).rejects.toThrow("riskAndFailureModes must be non-empty");
  });

  it("rejects underspecified capability cards before they become retained learning", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-liquidity-regime.md",
      "Valid article body content with enough concrete finance context for attach-level validation.",
    );
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });

    await expect(
      attachTool.execute("generic-method", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            methodSummary: "Use a simple checklist.",
          },
        ],
      }),
    ).rejects.toThrow("methodSummary must be specific enough for later reuse");

    await expect(
      attachTool.execute("generic-data-source", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            requiredDataSources: ["market data"],
          },
        ],
      }),
    ).rejects.toThrow("requiredDataSources must include at least two concrete data sources");

    await expect(
      attachTool.execute("generic-risk", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            riskAndFailureModes: "Can fail.",
          },
        ],
      }),
    ).rejects.toThrow("riskAndFailureModes must be specific enough for later reuse");
  });

  it("rejects illegal collection and forbidden authority signals", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-liquidity-regime.md",
      "Valid article body content.",
    );
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });

    await expect(
      attachTool.execute("illegal-collection", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            complianceOrCollectionNotes: "Use paywall bypass if needed.",
          },
        ],
      }),
    ).rejects.toThrow("illegal collection methods are not allowed");

    await expect(
      attachTool.execute("execution-requested", {
        ...buildValidArgs(),
        executionRequested: true,
      }),
    ).rejects.toThrow("executionRequested must stay false");

    await expect(
      attachTool.execute("auto-promotion-requested", {
        ...buildValidArgs(),
        autoPromotionRequested: true,
      }),
    ).rejects.toThrow("autoPromotionRequested must stay false");

    await expect(
      attachTool.execute("doctrine-mutation-requested", {
        ...buildValidArgs(),
        doctrineMutationRequested: true,
      }),
    ).rejects.toThrow("doctrineMutationRequested must stay false");
  });

  it("allows negated guardrail language in retained learning notes", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-liquidity-regime.md",
      "Valid article body content.",
    );
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });

    const result = await attachTool.execute("negated-guardrails", {
      ...buildValidArgs(),
      rawNotes: `${buildValidArgs().rawNotes}

This note stays research-only, without pretending to be execution approval, and does not auto-promote anything.`,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        updated: true,
      }),
    );
  });

  it("rejects capability-tag evidence gaps", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-learning-capabilities-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-liquidity-regime.md",
      "Valid article body content.",
    );
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });

    await expect(
      attachTool.execute("missing-sentiment-evidence", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[1],
            evidenceCategories: ["event_catalyst_evidence", "portfolio_risk_evidence"],
          },
        ],
      }),
    ).rejects.toThrow("sentiment_analysis requires sentiment_evidence");

    await expect(
      attachTool.execute("missing-compliance-evidence", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            relatedFinanceDomains: ["event_driven"],
            capabilityTags: ["alternative_data_ingestion"],
            evidenceCategories: [
              "alternative_data_evidence",
              "event_catalyst_evidence",
              "portfolio_risk_evidence",
            ],
            evidenceSummary:
              "Alternative event data evidence exists, but compliance coverage is intentionally missing here.",
            methodSummary: "Use alternative event data to enrich bounded event triage.",
            causalOrMechanisticClaim:
              "Alternative event signals can reveal repeated catalyst patterns before manual review.",
            suggestedAttachmentPoint: "research_capability:alternative_data_ingestion",
          },
        ],
      }),
    ).rejects.toThrow(
      "alternative_data_ingestion requires alternative_data_evidence and compliance_evidence",
    );

    await expect(
      attachTool.execute("missing-whipsaw-drawdown-risk", {
        ...buildValidArgs(),
        capabilityCandidates: [
          {
            ...buildValidArgs().capabilityCandidates[0],
            relatedFinanceDomains: ["etf_regime"],
            capabilityTags: ["tactical_timing"],
            evidenceCategories: [
              "equity_market_evidence",
              "etf_regime_evidence",
              "backtest_or_empirical_evidence",
            ],
            evidenceSummary:
              "ETF regime evidence and empirical timing evidence support bounded timing research.",
            methodSummary: "Use bounded timing signals to study ETF regime changes.",
            causalOrMechanisticClaim:
              "Regime shifts can change ETF breadth and trend persistence enough to matter for timing research.",
            riskAndFailureModes: "Signals can fail abruptly in regime transitions.",
            overfittingOrSpuriousRisk:
              "Historical timing windows can look cleaner than they are in live conditions.",
            suggestedAttachmentPoint: "research_capability:tactical_timing",
          },
        ],
      }),
    ).rejects.toThrow(
      "tactical_timing requires backtest_or_empirical_evidence and whipsaw or drawdown risk",
    );
  });
});
