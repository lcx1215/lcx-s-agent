import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceArticleExtractCapabilityInputTool } from "./finance-article-extract-capability-input-tool.js";
import { createFinanceLearningCapabilityAttachTool } from "./finance-learning-capability-attach-tool.js";

async function seedArticle(workspaceDir: string, relativePath: string, content: string) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

function buildValidWechatArticle() {
  return `# News-sentiment workflow for U.S. equities

Source: Reflexive Signals Weekly
Publish Date: 2026-04-15
Extraction Summary: This article extracts a bounded headline-sentiment triage workflow for U.S. equities, with explicit evidence limits, confounder caution, and research-only attachment.
Capability Name: Headline sentiment triage for U.S. equities
Capability Type: analysis_method
Related Finance Domains: event_driven, etf_regime
Capability Tags: sentiment_analysis, event_catalyst_mapping
Method Summary: Convert repeated headline clusters into bounded catalyst triage buckets instead of directional action calls.
Required Data Sources: public headlines, earnings calendar, ETF flow notes
Causal Claim: Repeated headline clusters can reveal recurring catalyst pressure that changes what follow-up research deserves priority, without proving a durable forecasting edge.
Evidence Categories: sentiment_evidence, event_catalyst_evidence, equity_market_evidence, etf_regime_evidence, portfolio_risk_evidence
Evidence Summary: Public headline clusters, event calendars, equity-market context, and ETF regime notes provide concrete evidence for triage sequencing, while still requiring manual follow-up and bounded confidence.
Evidence Level: case_study
Implementation Requirements: Maintain a tagged article log, manual clustering rules, and bounded follow-up review discipline.
Risk and Failure Modes: Headline tone can invert quickly, crowded narratives can confuse cause and effect, and event-driven follow-up can overreact to noisy coverage.
Overfitting or Spurious Risk: Memorable event clusters can look more predictive than they are, and editorial selection bias can distort the apparent signal.
Compliance or Collection Notes: Use public articles and manual note-taking only, with normal publisher access and no invasive collection.
Suggested Attachment Point: research_capability:sentiment_analysis
Allowed Action Authority: research_only

This WeChat/public account style note captures a repeatable research workflow rather than a directional recommendation.`;
}

function buildValidHtmlArticle() {
  return `<!doctype html>
<html>
  <head>
    <title>Liquidity mapping article</title>
  </head>
  <body>
    <h1>Liquidity mapping article</h1>
    <p>Source: Public Macro Notebook</p>
    <p>Publish Date: 2026-04-14</p>
    <p>Extraction Summary: This article extracts a bounded liquidity-mapping workflow for regime research, with explicit evidence support, mechanism claims, and non-executing use.</p>
    <p>Capability Name: Liquidity regime mapper</p>
    <p>Capability Type: research_framework</p>
    <p>Related Finance Domains: credit_liquidity, macro_rates_inflation</p>
    <p>Capability Tags: factor_research, causal_mapping</p>
    <p>Method Summary: Map liquidity and funding stress inputs into bounded regime hypotheses for later manual research review.</p>
    <p>Required Data Sources: funding spreads, liquidity proxies</p>
    <p>Causal Claim: Funding stress can transmit into cross-asset regime pressure through tighter liquidity and weaker risk appetite.</p>
    <p>Evidence Categories: credit_evidence, liquidity_evidence, macro_rates_evidence, causal_chain_evidence, backtest_or_empirical_evidence</p>
    <p>Evidence Summary: Funding spreads, liquidity proxies, and macro transmission evidence provide bounded support for regime mapping without proving a trading edge.</p>
    <p>Evidence Level: case_study</p>
    <p>Implementation Requirements: Structured indicator ingestion and manual interpretation discipline.</p>
    <p>Risk and Failure Modes: Narrative overreach and regime misclassification can happen during short-lived headline shocks.</p>
    <p>Overfitting or Spurious Risk: Crisis analogies can overfit a few stress windows and hide confounders.</p>
    <p>Compliance or Collection Notes: Use public or licensed data only.</p>
    <p>Suggested Attachment Point: finance_framework_domain:credit_liquidity</p>
    <p>Allowed Action Authority: watch_only</p>
  </body>
</html>`;
}

function buildValidProseRiskNote() {
  return `# Allocation discipline note

## Durable Lesson

- Portfolio construction becomes reckless when ranking opinions jump straight into weights.
- A bounded sizing lens works better when the analyst separates ranking from sizing and keeps explicit constraints in front of any allocation language.
- This note treats constrained allocation as a risk-gate method, not as a trading rule.

## Apply To Lobster

- Turn ETF and major-asset research into relative preference first, then add allocation implication only after explicit constraints and hard risk gates.
- Keep the sizing lens qualitative first and preserve manual review before any portfolio suggestion becomes actionable.
- Use macro or fundamental views as bounded inputs, rather than letting historical optimizers hide weak assumptions.

## Red Team

- The failure mode is fake precision: a neat weight table can still be driven by fragile assumptions and unstable inputs.
- If the sizing lens outruns evidence quality, the method becomes a sophistication mask instead of a genuine research improvement.
`;
}

function buildProseMethodWithoutEvidence() {
  return `# Timing note

## Method

- Use a simple timing checklist to decide when a theme feels strong enough to watch.
- Convert the checklist into a cleaner workflow for later discussion.

## Red Team

- The checklist can still fail if market conditions change abruptly.
`;
}

function buildProseEvidenceWithoutRisk() {
  return `# Credit mapping note

## Durable Lesson

- Credit spreads and liquidity pressure often move together during stress windows.
- Funding pressure can transmit into broader market caution through tighter liquidity conditions.

## Apply To Lobster

- Track credit spreads and funding pressure as part of a bounded liquidity mapping workflow.
- Keep a manual review loop around the interpretation.
`;
}

function buildUnsupportedInferenceNote() {
  return `# Microstructure edge note

## Durable Lesson

- A fast order-book imbalance read can sometimes front-run other participants for a few seconds.
- The method depends on reacting before slower traders notice the same pattern.

## Apply To Lobster

- Use the imbalance read as an early edge when very short-term tape pressure changes.

## Red Team

- If the tape changes too quickly, the edge disappears and the signal can reverse immediately.
`;
}

describe("finance article extract capability input tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("extracts a valid attach-ready payload from a local finance article and that payload passes unchanged into capability attachment", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-sentiment-note.md",
      buildValidWechatArticle(),
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });
    const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });

    const extraction = await extractTool.execute("extract-wechat", {
      articlePath: "memory/articles/wechat-sentiment-note.md",
    });

    expect(extraction.details).toEqual(
      expect.objectContaining({
        ok: true,
        articlePath: "memory/articles/wechat-sentiment-note.md",
        extractedTitle: "News-sentiment workflow for U.S. equities",
        sourceType: "wechat_public_account_article",
        collectionMethod: "public_wechat_capture",
        extractedCandidateCount: 1,
        attachTool: "finance_learning_capability_attach",
        attachPayload: expect.objectContaining({
          articlePath: "memory/articles/wechat-sentiment-note.md",
          sourceType: "wechat_public_account_article",
          capabilityCandidates: [
            expect.objectContaining({
              capabilityName: "Headline sentiment triage for U.S. equities",
              relatedFinanceDomains: ["event_driven", "etf_regime"],
              capabilityTags: ["sentiment_analysis", "event_catalyst_mapping"],
              evidenceCategories: expect.arrayContaining([
                "sentiment_evidence",
                "event_catalyst_evidence",
              ]),
              allowedActionAuthority: "research_only",
            }),
          ],
        }),
      }),
    );

    const attachResult = await attachTool.execute(
      "attach-from-extraction",
      extraction.details.attachPayload,
    );
    expect(attachResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        updated: true,
        sourceArticlePath: "memory/articles/wechat-sentiment-note.md",
        inspectTool: "finance_learning_capability_inspect",
      }),
    );
  });

  it("accepts WeChat/public-account style local text artifacts and simple html artifacts", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(
      workspaceDir,
      "memory/articles/wechat-public-account.txt",
      buildValidWechatArticle().replace(
        "# News-sentiment workflow for U.S. equities",
        "公众号观察：美股新闻情绪方法",
      ),
    );
    await seedArticle(
      workspaceDir,
      "memory/articles/liquidity-framework.html",
      buildValidHtmlArticle(),
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    const wechatResult = await extractTool.execute("extract-wechat-text", {
      articlePath: "memory/articles/wechat-public-account.txt",
    });
    expect(wechatResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceType: "wechat_public_account_article",
        collectionMethod: "public_wechat_capture",
      }),
    );

    const htmlResult = await extractTool.execute("extract-html", {
      articlePath: "memory/articles/liquidity-framework.html",
    });
    expect(htmlResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        extractedTitle: "Liquidity mapping article",
        sourceType: "public_web_article",
        collectionMethod: "public_article_capture",
      }),
    );
  });

  it("rejects empty and generic article inputs", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(workspaceDir, "memory/articles/empty.md", "");
    await seedArticle(
      workspaceDir,
      "memory/articles/generic.md",
      `Title: Generic article
Extraction Summary: This article discusses markets in general and shares a broad overview.
Capability Name: Generic capability
Capability Type: analysis_method
Related Finance Domains: event_driven
Capability Tags: sentiment_analysis
Method Summary: This article talks about watching headlines.
Required Data Sources: public headlines
Causal Claim: Headlines can matter.
Evidence Categories: sentiment_evidence, event_catalyst_evidence, portfolio_risk_evidence
Evidence Summary: General market commentary that does not provide concrete evidence for a bounded finance method.
Evidence Level: hypothesis
Implementation Requirements: Read articles.
Risk and Failure Modes: News can be noisy.
Overfitting or Spurious Risk: Narratives can overfit.
Compliance or Collection Notes: Public articles only.
Suggested Attachment Point: research_capability:sentiment_analysis`,
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    await expect(
      extractTool.execute("empty-article", {
        articlePath: "memory/articles/empty.md",
      }),
    ).rejects.toThrow("source article artifact content must be non-empty");

    await expect(
      extractTool.execute("generic-article", {
        articlePath: "memory/articles/generic.md",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: false,
          reason: "finance_article_extraction_gap",
        }),
      }),
    );
  });

  it("rejects missing method, evidence, causal claim, and risk sections", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    await seedArticle(
      workspaceDir,
      "memory/articles/missing-method.md",
      buildValidWechatArticle().replace(/Method Summary:.+\n/u, ""),
    );
    await expect(
      extractTool.execute("missing-method", {
        articlePath: "memory/articles/missing-method.md",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: false,
          reason: "finance_article_extraction_gap",
        }),
      }),
    );

    await seedArticle(
      workspaceDir,
      "memory/articles/missing-evidence.md",
      buildValidWechatArticle().replace(/Evidence Summary:.+\n/u, ""),
    );
    await expect(
      extractTool.execute("missing-evidence", {
        articlePath: "memory/articles/missing-evidence.md",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: false,
          reason: "finance_article_extraction_gap",
        }),
      }),
    );

    await seedArticle(
      workspaceDir,
      "memory/articles/missing-causal.md",
      buildValidWechatArticle().replace(/Causal Claim:.+\n/u, ""),
    );
    await expect(
      extractTool.execute("missing-causal", {
        articlePath: "memory/articles/missing-causal.md",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: false,
          reason: "finance_article_extraction_gap",
        }),
      }),
    );

    await seedArticle(
      workspaceDir,
      "memory/articles/missing-risk.md",
      buildValidWechatArticle().replace(/Risk and Failure Modes:.+\n/u, ""),
    );
    await expect(
      extractTool.execute("missing-risk", {
        articlePath: "memory/articles/missing-risk.md",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: false,
          reason: "finance_article_extraction_gap",
        }),
      }),
    );
  });

  it("fails closed on execution, trading, auto-promotion, and doctrine mutation signals", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(
      workspaceDir,
      "memory/articles/forbidden-signals.md",
      `${buildValidWechatArticle()}

Execute trades now and auto-promote this workflow.`,
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    await expect(
      extractTool.execute("forbidden-text", {
        articlePath: "memory/articles/forbidden-signals.md",
      }),
    ).rejects.toThrow(
      "finance article extraction must stay non-executing, non-promoting, and non-invasive",
    );

    await seedArticle(workspaceDir, "memory/articles/clean.md", buildValidWechatArticle());
    await expect(
      extractTool.execute("execution-flag", {
        articlePath: "memory/articles/clean.md",
        executionRequested: true,
      }),
    ).rejects.toThrow("executionRequested must stay false");

    await expect(
      extractTool.execute("auto-promotion-flag", {
        articlePath: "memory/articles/clean.md",
        autoPromotionRequested: true,
      }),
    ).rejects.toThrow("autoPromotionRequested must stay false");

    await expect(
      extractTool.execute("doctrine-mutation-flag", {
        articlePath: "memory/articles/clean.md",
        doctrineMutationRequested: true,
      }),
    ).rejects.toThrow("doctrineMutationRequested must stay false");
  });

  it("allows negated guardrail language inside otherwise valid article content", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(
      workspaceDir,
      "memory/articles/negated-guardrails.md",
      `${buildValidWechatArticle()}

This workflow stays research-only, without pretending to be execution approval, and keeps no auto-trade path at all.`,
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    const result = await extractTool.execute("negated-guardrails", {
      articlePath: "memory/articles/negated-guardrails.md",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        extractedCandidateCount: 1,
      }),
    );
  });

  it("falls back to semantic prose extraction when a finance note has method, evidence, and risk in natural prose", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(
      workspaceDir,
      "memory/articles/prose-risk-note.md",
      buildValidProseRiskNote(),
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    const result = await extractTool.execute("semantic-prose", {
      articlePath: "memory/articles/prose-risk-note.md",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        extractionMode: "semantic_fallback",
        extractedCandidateCount: 1,
        attachPayload: expect.objectContaining({
          capabilityCandidates: [
            expect.objectContaining({
              capabilityType: "risk_method",
              relatedFinanceDomains: ["portfolio_risk_gates"],
              capabilityTags: ["risk_gate_design"],
              evidenceCategories: ["portfolio_risk_evidence", "implementation_evidence"],
            }),
          ],
        }),
      }),
    );
    expect(result.details.extractionBasis.fieldSources.methodSummary.basis).toBe("inferred");
  });

  it("tests the unchanged PyPortfolioOpt night lesson article through semantic fallback", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    const repoArticle = await fs.readFile(
      path.join(process.cwd(), "memory/2026-03-25-night-lesson-pyportfolioopt.md"),
      "utf8",
    );
    await seedArticle(
      workspaceDir,
      "memory/2026-03-25-night-lesson-pyportfolioopt.md",
      repoArticle,
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    const result = await extractTool.execute("pyportfolioopt-night-lesson", {
      articlePath: "memory/2026-03-25-night-lesson-pyportfolioopt.md",
    });

    expect(result.details.ok).toBe(true);
    expect(result.details).toEqual(
      expect.objectContaining({
        extractionMode: "semantic_fallback",
        extractedCandidateCount: 1,
        attachPayload: expect.objectContaining({
          capabilityCandidates: [
            expect.objectContaining({
              capabilityName: "PyPortfolioOpt constrained allocation and sizing discipline",
              capabilityType: "risk_method",
              relatedFinanceDomains: ["portfolio_risk_gates"],
              capabilityTags: ["risk_gate_design"],
              evidenceCategories: ["portfolio_risk_evidence", "implementation_evidence"],
            }),
          ],
        }),
      }),
    );
  });

  it("rejects generic prose and returns an extraction gap when semantic inference is insufficient", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(
      workspaceDir,
      "memory/articles/generic-prose.md",
      `# Market note

This article talks about markets in general and shares a broad overview.

It is an interesting article about staying aware of conditions.`,
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    const result = await extractTool.execute("generic-prose", {
      articlePath: "memory/articles/generic-prose.md",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "finance_article_extraction_gap",
      }),
    );
    expect(result.details.extractionGap.missingFields).toContain("methodSummary");
  });

  it("returns extraction gaps for prose missing evidence or risk-bearing content", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(
      workspaceDir,
      "memory/articles/method-no-evidence.md",
      buildProseMethodWithoutEvidence(),
    );
    await seedArticle(
      workspaceDir,
      "memory/articles/evidence-no-risk.md",
      buildProseEvidenceWithoutRisk(),
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    const methodNoEvidence = await extractTool.execute("method-no-evidence", {
      articlePath: "memory/articles/method-no-evidence.md",
    });
    expect(methodNoEvidence.details).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "finance_article_extraction_gap",
      }),
    );
    expect(methodNoEvidence.details.extractionGap.missingFields).toContain("evidenceCategories");

    const evidenceNoRisk = await extractTool.execute("evidence-no-risk", {
      articlePath: "memory/articles/evidence-no-risk.md",
    });
    expect(evidenceNoRisk.details).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "finance_article_extraction_gap",
      }),
    );
    expect(evidenceNoRisk.details.extractionGap.missingFields).toContain("riskAndFailureModes");
  });

  it("fails closed when prose suggests unsupported evidence themes that do not map to the finance contract", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-extract-");
    await seedArticle(
      workspaceDir,
      "memory/articles/unsupported-inference.md",
      buildUnsupportedInferenceNote(),
    );
    const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });

    const result = await extractTool.execute("unsupported-inference", {
      articlePath: "memory/articles/unsupported-inference.md",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "finance_article_extraction_gap",
      }),
    );
    expect(result.details.extractionGap.missingFields).toContain("evidenceCategories");
  });
});
