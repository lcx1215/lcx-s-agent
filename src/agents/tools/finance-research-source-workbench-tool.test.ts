import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceArticleSourceRegistryRecordTool } from "./finance-article-source-registry-record-tool.js";
import { createFinanceResearchSourceWorkbenchTool } from "./finance-research-source-workbench-tool.js";

async function seedFile(workspaceDir: string, relativePath: string, content: string) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

async function readArtifact(workspaceDir: string, artifactPath: string) {
  return fs.readFile(path.join(workspaceDir, artifactPath), "utf8");
}

function validPastedArticle() {
  return `Macro regime framework note

This article describes a bounded macro regime workflow that maps rates, inflation, and liquidity signals into research prioritization rather than trade execution. It explains the method, cites concrete evidence inputs, states a causal transmission path, and lists failure modes such as stale macro analogies and headline-driven overreach.`;
}

describe("finance research source workbench tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("creates a local research artifact from valid manual pasted finance article content and returns the extraction target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-research-workbench-");
    const tool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

    const result = await tool.execute("manual-paste", {
      sourceName: "Macro Notebook",
      sourceType: "manual_article_source",
      pastedText: validPastedArticle(),
      title: "Macro regime framework note",
      publishDate: "2026-04-16",
      retrievalNotes:
        "Operator pasted a full article note with explicit method, evidence inputs, causal transmission logic, and failure-mode discussion.",
      allowedActionAuthority: "research_only",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "manual_paste",
        retrievalMethod: "manual_paste",
        collectionPosture: "manual_only",
        extractionToolTarget: "finance_article_extract_capability_input",
        extractionReadyNow: true,
        requiresManualCaptureBeforeExtraction: false,
        metadataPreservedForAudit: true,
        noRemoteFetchOccurred: true,
      }),
    );

    const artifact = await readArtifact(workspaceDir, result.details.artifactPath);
    expect(artifact).toContain("**Source Family**: manual_paste");
    expect(artifact).toContain("**Retrieval Method**: manual_paste");
    expect(artifact).toContain("**Title**: Macro regime framework note");
    expect(artifact).toContain("This article describes a bounded macro regime workflow");
  });

  it("accepts a valid local file path through preflight and preserves audit metadata", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-research-workbench-");
    await seedFile(
      workspaceDir,
      "memory/articles/credit-liquidity.md",
      `Credit liquidity workflow

This article lays out a bounded research method using funding spreads, liquidity proxies, and timeline-aware stress notes to frame credit/liquidity follow-up. It includes explicit mechanism claims, evidence inputs, and risk/failure discussion about transient squeezes and stale crisis analogies.`,
    );
    const tool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

    const result = await tool.execute("local-file", {
      sourceName: "Credit liquidity notebook",
      sourceType: "manual_article_source",
      localFilePath: "memory/articles/credit-liquidity.md",
      title: "Credit liquidity workflow",
      retrievalNotes:
        "Operator saved a local markdown article artifact with concrete evidence-bearing finance research content and bounded collection posture.",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "local_artifact",
        retrievalMethod: "local_file",
        collectionPosture: "allowed",
        extractionToolTarget: "finance_article_extract_capability_input",
        extractionReadyNow: true,
        requiresManualCaptureBeforeExtraction: false,
        noRemoteFetchOccurred: true,
      }),
    );

    const artifact = await readArtifact(workspaceDir, result.details.artifactPath);
    expect(artifact).toContain("**Source Url Or Identifier**: memory/articles/credit-liquidity.md");
    expect(artifact).toContain("**Collection Posture**: allowed");
    expect(artifact).toContain("**Content Kind**: normalized_local_content");
  });

  it("records a Google search result reference as metadata only without scraping remote content", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-research-workbench-");
    const tool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

    const result = await tool.execute("google-reference", {
      sourceName: "Google search reference",
      sourceType: "public_web_source",
      userProvidedUrl:
        "https://www.google.com/search?q=site%3Asec.gov+liquidity+funding+stress+10-k",
      title: "Google search result reference for SEC liquidity research",
      retrievalNotes:
        "Operator recorded a Google search result reference only as discovery metadata for later manual source capture. No page content was collected or scraped.",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "public_web_reference",
        retrievalMethod: "user_provided_url",
        collectionPosture: "manual_only",
        extractionToolTarget: null,
        extractionReadyNow: false,
        requiresManualCaptureBeforeExtraction: true,
        extractionToolTargetAfterManualCapture: "finance_article_extract_capability_input",
        noRemoteFetchOccurred: true,
      }),
    );

    const artifact = await readArtifact(workspaceDir, result.details.artifactPath);
    expect(artifact).toContain("**Source Family**: public_web_reference");
    expect(artifact).toContain("**Extraction Target**: ");
    expect(artifact).toContain("Metadata-only reference. No remote content was fetched.");
  });

  it("keeps manually captured public webpages under public_web_reference instead of plain manual_paste", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-research-workbench-");
    const tool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

    const result = await tool.execute("manual-public-webpage", {
      sourceName: "ETF.com liquidity webpage discovered via Google",
      sourceType: "public_web_source",
      userProvidedUrl: "https://www.etf.com/sections/news/how-measure-and-understand-etf-liquidity",
      pastedText: validPastedArticle(),
      title: "ETF liquidity webpage excerpt",
      retrievalNotes:
        "Operator used Google/web search to find a public ETF webpage, then manually pasted a bounded excerpt. No remote content was fetched by the workbench.",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "public_web_reference",
        retrievalMethod: "manual_paste",
        collectionPosture: "manual_only",
        extractionReadyNow: true,
        extractionToolTarget: "finance_article_extract_capability_input",
      }),
    );
  });

  it("records official SEC, company IR, and macro sources with safe posture and preserves source family metadata", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-research-workbench-");
    const tool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

    const secResult = await tool.execute("sec-reference", {
      sourceName: "SEC EDGAR filing reference",
      sourceType: "public_web_source",
      userProvidedUrl: "https://www.sec.gov/ixviewer/ix.html?doc=/Archives/example-10k.htm",
      title: "EDGAR filing reference",
      retrievalNotes:
        "Operator recorded an official SEC filing reference for later manual capture and extraction. No remote content was fetched here.",
    });
    expect(secResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "official_filing",
        collectionPosture: "manual_only",
      }),
    );

    const officialReferenceResult = await tool.execute("official-reference", {
      sourceName: "SEC investor guide reference",
      sourceType: "official_reference_source",
      userProvidedUrl:
        "https://www.sec.gov/about/reports-publications/investor-publications/introduction-mutual-funds",
      title: "SEC mutual funds and ETFs guide",
      retrievalNotes:
        "Operator recorded an official SEC investor education reference for later manual capture and extraction. No remote content was fetched here.",
    });
    expect(officialReferenceResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "official_reference",
        collectionPosture: "manual_only",
      }),
    );

    const academicPreprintResult = await tool.execute("academic-preprint-reference", {
      sourceName: "FinGPT arXiv preprint",
      sourceType: "academic_preprint_source",
      userProvidedUrl: "https://arxiv.org/abs/2306.06031",
      title: "FinGPT: Open-Source Financial Large Language Models",
      retrievalNotes:
        "Operator recorded an arXiv academic preprint reference for later manual capture and extraction. No remote content was fetched here.",
    });
    expect(academicPreprintResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "academic_preprint",
        collectionPosture: "manual_only",
        extractionReadyNow: false,
        extractionToolTarget: null,
        requiresManualCaptureBeforeExtraction: true,
      }),
    );

    const githubRepoResult = await tool.execute("github-repository-reference", {
      sourceName: "FinGPT GitHub repository",
      sourceType: "github_repository_source",
      userProvidedUrl: "https://github.com/AI4Finance-Foundation/FinGPT",
      title: "FinGPT repository README",
      retrievalNotes:
        "Operator recorded a GitHub repository reference for later manual README capture and extraction. No remote content was fetched here.",
    });
    expect(githubRepoResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "github_repository",
        collectionPosture: "manual_only",
        extractionReadyNow: false,
        extractionToolTarget: null,
        requiresManualCaptureBeforeExtraction: true,
      }),
    );

    const macroResult = await tool.execute("macro-reference", {
      sourceName: "FRED macro release reference",
      sourceType: "public_web_source",
      userProvidedUrl: "https://fred.stlouisfed.org/series/CPIAUCSL",
      title: "FRED CPI series reference",
      retrievalNotes:
        "Operator recorded an official macro data reference from FRED for later manual review and local capture only.",
    });
    expect(macroResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "official_macro_data",
        collectionPosture: "manual_only",
      }),
    );

    const irResult = await tool.execute("ir-reference", {
      sourceName: "Company investor relations",
      sourceType: "public_web_source",
      userProvidedUrl: "https://investors.example.com/earnings/default.aspx",
      title: "Investor relations earnings release reference",
      retrievalNotes:
        "Operator recorded a company IR reference for manual follow-up and local artifact creation without remote fetching in the workbench.",
    });
    expect(irResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "company_ir",
        collectionPosture: "manual_only",
      }),
    );
  });

  it("keeps WeChat/public-account sources manual_only unless a safe public feed is explicitly registered", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-research-workbench-");
    const registryTool = createFinanceArticleSourceRegistryRecordTool({ workspaceDir });
    const tool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

    const defaultWechat = await tool.execute("wechat-default", {
      sourceName: "Example public account",
      sourceType: "wechat_public_account_source",
      userProvidedUrl: "https://mp.weixin.qq.com/s/example",
      title: "WeChat article reference",
      retrievalNotes:
        "Operator recorded a WeChat/public-account article reference for manual capture only. No remote content was fetched.",
    });
    expect(defaultWechat.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "wechat_public_account",
        collectionPosture: "manual_only",
      }),
    );

    await registryTool.execute("record-wechat-feed", {
      sourceName: "Safe public feed mirror",
      sourceType: "wechat_public_account_source",
      sourceUrlOrIdentifier: "https://example.com/public-feed.xml",
      allowedCollectionMethods: ["rss_or_public_feed_if_available"],
      requiresManualInput: false,
      isPubliclyAccessible: true,
      complianceNotes: "Use only safe, explicitly public feed access.",
      rateLimitNotes: "Operator-paced only.",
      freshnessExpectation: "daily",
      reliabilityNotes: "Research input only until locally reviewed.",
      extractionTarget: "finance_article_extract_capability_input",
      allowedActionAuthority: "research_only",
    });

    const safeWechat = await tool.execute("wechat-safe-feed", {
      sourceName: "Safe public feed mirror",
      title: "Safe public feed mirror",
      userProvidedUrl: "https://example.com/public-feed.xml",
      retrievalNotes:
        "Operator recorded a safe public feed reference already approved in the source registry for later manual/local extraction steps.",
    });
    expect(safeWechat.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "wechat_public_account",
        collectionPosture: "allowed",
      }),
    );
  });

  it("accepts RSS/public feed sources only when public", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-research-workbench-");
    const tool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

    const allowedResult = await tool.execute("public-feed", {
      sourceName: "Public ETF feed",
      sourceType: "rss_public_feed_source",
      userProvidedUrl: "https://example.com/etf-feed.xml",
      title: "ETF public feed reference",
      retrievalNotes:
        "Operator recorded a public RSS feed reference for manual/local downstream extraction only.",
      isPubliclyAccessible: true,
    });
    expect(allowedResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceFamily: "public_feed",
        collectionPosture: "allowed",
      }),
    );

    const blockedResult = await tool.execute("private-feed", {
      sourceName: "Private ETF feed",
      sourceType: "rss_public_feed_source",
      userProvidedUrl: "https://example.com/private-feed.xml",
      title: "Private feed reference",
      retrievalNotes:
        "Operator recorded a non-public feed reference that should not proceed without public-access confirmation.",
      isPubliclyAccessible: false,
    });
    expect(blockedResult.details).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "finance_research_source_blocked_by_preflight",
        preflightStatus: "blocked",
      }),
    );
  });

  it("rejects empty pasted text, generic filler, blocked bypass language, and forbidden authority signals", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-research-workbench-");
    const tool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

    await expect(
      tool.execute("empty-paste", {
        sourceName: "Empty paste",
        pastedText: "   ",
        retrievalNotes:
          "Operator pasted article content manually and claims it includes method, evidence, mechanism, and risk discussion.",
      }),
    ).rejects.toThrow("pastedText must be non-empty");

    await expect(
      tool.execute("generic-paste", {
        sourceName: "Generic paste",
        pastedText: "This article mainly talks about markets in general.",
        retrievalNotes:
          "Operator pasted article content manually and claims it includes method, evidence, mechanism, and risk discussion.",
      }),
    ).rejects.toThrow("pastedText must contain non-generic finance research content");

    await expect(
      tool.execute("bypass-language", {
        sourceName: "Blocked source",
        userProvidedUrl: "https://example.com/paywalled",
        retrievalNotes:
          "Use paywall bypass and hidden API scraping if needed to capture the article for research.",
      }),
    ).rejects.toThrow("finance article source registration must reject credential bypass");

    await expect(
      tool.execute("execution-request", {
        sourceName: "Execution source",
        pastedText: validPastedArticle(),
        retrievalNotes:
          "Operator pasted a detailed article note with method, evidence, causal mechanism, and risk framing.",
        executionRequested: true,
      }),
    ).rejects.toThrow("executionRequested must stay false");

    await expect(
      tool.execute("auto-promotion-request", {
        sourceName: "Auto promotion source",
        pastedText: validPastedArticle(),
        retrievalNotes:
          "Operator pasted a detailed article note with method, evidence, causal mechanism, and risk framing.",
        autoPromotionRequested: true,
      }),
    ).rejects.toThrow("autoPromotionRequested must stay false");

    await expect(
      tool.execute("doctrine-mutation-request", {
        sourceName: "Doctrine mutation source",
        pastedText: validPastedArticle(),
        retrievalNotes:
          "Operator pasted a detailed article note with method, evidence, causal mechanism, and risk framing.",
        doctrineMutationRequested: true,
      }),
    ).rejects.toThrow("doctrineMutationRequested must stay false");
  });
});
