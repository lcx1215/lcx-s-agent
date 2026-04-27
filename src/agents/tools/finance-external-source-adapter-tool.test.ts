import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceExternalSourceAdapterTool } from "./finance-external-source-adapter-tool.js";

async function seedFile(workspaceDir: string, relativePath: string, content: string) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

async function readArtifact(workspaceDir: string, artifactPath: string) {
  return fs.readFile(path.join(workspaceDir, artifactPath), "utf8");
}

const SAFE_RETRIEVAL_NOTES =
  "Operator imported a safe external finance research export with explicit provenance, bounded collection posture, and no remote fetch request in this adapter step.";
const SAFE_COMPLIANCE_NOTES =
  "Use only public feeds, local exports, or normal operator-mediated collection with no bypasses.";

describe("finance external source adapter tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("normalizes a valid RSS feed export item into a local article artifact and returns the extraction target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    await seedFile(
      workspaceDir,
      "memory/imports/feed.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Public Market Feed</title>
    <item>
      <title>Liquidity transmission note</title>
      <link>https://example.com/liquidity-note</link>
      <description><![CDATA[This export item describes a bounded liquidity transmission method that links funding stress, rates pressure, and credit spread behavior into follow-up research priorities while naming failure modes and evidence constraints.]]></description>
      <pubDate>2026-04-17</pubDate>
      <author>Public Macro Desk</author>
    </item>
  </channel>
</rss>`,
    );
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    const result = await tool.execute("rss-feed", {
      adapterName: "public-feed-adapter",
      adapterType: "rss_atom_json_feed",
      inputPath: "memory/imports/feed.xml",
      feedUrl: "https://example.com/feed.xml",
      sourceFamily: "public_feed",
      sourceName: "Public Market Feed",
      collectionMethod: "rss_or_public_feed_if_available",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
      isPubliclyAccessible: true,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        importedCount: 1,
        extractionToolTarget: "finance_article_extract_capability_input",
        noRemoteUnauthorizedFetchOccurred: true,
      }),
    );
    expect(result.details.normalizedArticleArtifactPaths).toHaveLength(1);

    const artifact = await readArtifact(
      workspaceDir,
      result.details.normalizedArticleArtifactPaths[0],
    );
    expect(artifact).toContain("**Adapter Name**: public-feed-adapter");
    expect(artifact).toContain("**Adapter Type**: rss_atom_json_feed");
    expect(artifact).toContain("**Article Url**: https://example.com/liquidity-note");
    expect(artifact).toContain("Liquidity transmission note");
  });

  it("normalizes a valid markdown export into a local article artifact", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    await seedFile(
      workspaceDir,
      "memory/imports/research-note.md",
      `# Regime rotation method

Source: Research Blog Desk
Publish Date: 2026-04-16

This markdown export explains a bounded ETF regime method that compares equity breadth, macro pressure, and flow persistence before any manual follow-up. It names evidence inputs, mechanism claims, and risk/failure conditions instead of implying automatic execution.`,
    );
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    const result = await tool.execute("markdown-export", {
      adapterName: "markdown-exporter",
      adapterType: "markdown_article_export",
      inputPath: "memory/imports/research-note.md",
      sourceFamily: "research_blog",
      sourceName: "Research Blog Desk",
      collectionMethod: "external_tool_export",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
    });

    expect(result.details.normalizedArticleArtifactPaths).toHaveLength(1);
    const artifact = await readArtifact(
      workspaceDir,
      result.details.normalizedArticleArtifactPaths[0],
    );
    expect(artifact).toContain("**Adapter Collection Method**: external_tool_export");
    expect(artifact).toContain("**Title**: Regime rotation method");
  });

  it("creates source references from a valid OPML export without fetching content", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    await seedFile(
      workspaceDir,
      "memory/imports/subscriptions.opml",
      `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Macro Feed" title="Macro Feed" type="rss" xmlUrl="https://example.com/macro.xml" htmlUrl="https://example.com/macro" />
    <outline text="ETF Feed" title="ETF Feed" type="rss" xmlUrl="https://example.com/etf.xml" htmlUrl="https://example.com/etf" />
  </body>
</opml>`,
    );
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    const result = await tool.execute("opml-export", {
      adapterName: "opml-exporter",
      adapterType: "opml_export",
      inputPath: "memory/imports/subscriptions.opml",
      sourceFamily: "public_feed",
      sourceName: "Subscription Export",
      collectionMethod: "external_tool_export",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
      isPubliclyAccessible: true,
    });

    expect(result.details.normalizedReferenceArtifactPaths).toHaveLength(2);
    expect(result.details.noRemoteUnauthorizedFetchOccurred).toBe(true);
    const artifact = await readArtifact(
      workspaceDir,
      result.details.normalizedReferenceArtifactPaths[0],
    );
    expect(artifact).toContain("Metadata-only reference. No remote content was fetched.");
  });

  it("accepts we-mp-rss or wewe-rss-style output as an external_tool_export folder", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    await seedFile(
      workspaceDir,
      "memory/imports/wewe-rss/account-a.md",
      `# Public account macro note

This export captures a bounded macro note from a public-account style source using safe external-tool export only. The note describes mechanism claims, evidence limits, and follow-up research steps without turning into a trading rule or execution request.`,
    );
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    const result = await tool.execute("wewe-rss-export", {
      adapterName: "wewe-rss",
      adapterType: "external_tool_export_folder",
      inputPath: "memory/imports/wewe-rss",
      sourceFamily: "wechat_public_account",
      sourceName: "WeChat Export Folder",
      collectionMethod: "external_tool_export",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
    });

    expect(result.details.normalizedArticleArtifactPaths).toHaveLength(1);
    const artifact = await readArtifact(
      workspaceDir,
      result.details.normalizedArticleArtifactPaths[0],
    );
    expect(artifact).toContain("**Adapter Name**: wewe-rss");
    expect(artifact).toContain("**Source Family**: wechat_public_account");
  });

  it("records a Google/web search result export as metadata without scraping", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    await seedFile(
      workspaceDir,
      "memory/imports/search-results.json",
      JSON.stringify([
        {
          title: "Treasury liquidity filing reference",
          url: "https://www.sec.gov/Archives/example-liquidity-filing",
          snippet:
            "Public filing reference surfaced through search results for later manual source capture.",
        },
      ]),
    );
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    const result = await tool.execute("search-export", {
      adapterName: "google-export",
      adapterType: "web_search_export",
      inputPath: "memory/imports/search-results.json",
      sourceFamily: "public_web_reference",
      sourceName: "Search Export",
      collectionMethod: "external_tool_export",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
    });

    expect(result.details.normalizedReferenceArtifactPaths).toHaveLength(1);
    const artifact = await readArtifact(
      workspaceDir,
      result.details.normalizedReferenceArtifactPaths[0],
    );
    expect(artifact).toContain("Treasury liquidity filing reference");
    expect(artifact).toContain("Search snippet:");
  });

  it("accepts SEC and company IR official references as safe references", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    const secResult = await tool.execute("sec-reference", {
      adapterName: "official-ref",
      adapterType: "official_reference_export",
      referenceUrl: "https://www.sec.gov/ixviewer/ix.html?doc=/Archives/example-10k.htm",
      sourceFamily: "official_filing",
      sourceName: "SEC Filing Reference",
      collectionMethod: "browser_assisted_manual_collection",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
    });
    expect(secResult.details.normalizedReferenceArtifactPaths).toHaveLength(1);

    const irResult = await tool.execute("company-ir-reference", {
      adapterName: "official-ref",
      adapterType: "official_reference_export",
      referenceUrl: "https://investors.example.com/earnings/default.aspx",
      sourceFamily: "company_ir",
      sourceName: "Company IR Reference",
      collectionMethod: "browser_assisted_manual_collection",
      retrievalNotes: SAFE_RETRIEVAL_NOTES,
      complianceNotes: SAFE_COMPLIANCE_NOTES,
    });
    expect(irResult.details.normalizedReferenceArtifactPaths).toHaveLength(1);
  });

  it("rejects empty exports and unsupported adapter types", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    await seedFile(workspaceDir, "memory/imports/empty.xml", "<rss><channel></channel></rss>");
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    await expect(
      tool.execute("empty-export", {
        adapterName: "feed-adapter",
        adapterType: "rss_atom_json_feed",
        inputPath: "memory/imports/empty.xml",
        sourceFamily: "public_feed",
        sourceName: "Empty Feed",
        collectionMethod: "rss_or_public_feed_if_available",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
        complianceNotes: SAFE_COMPLIANCE_NOTES,
      }),
    ).rejects.toThrow("empty export");

    await expect(
      tool.execute("unsupported-adapter", {
        adapterName: "bad-adapter",
        adapterType: "bad_adapter",
        referenceUrl: "https://example.com",
        sourceFamily: "public_web_reference",
        sourceName: "Bad Adapter",
        collectionMethod: "browser_assisted_manual_collection",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
        complianceNotes: SAFE_COMPLIANCE_NOTES,
      }),
    ).rejects.toThrow("adapterType must be one of");
  });

  it("rejects reverse engineering, hidden API scraping, credential/paywall/anti-bot bypass, and captcha/proxy evasion", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    for (const phrase of [
      "Use reverse engineering on the source if export fails.",
      "Rely on hidden API scraping for the adapter.",
      "Attempt credential bypass when needed.",
      "Use paywall bypass for blocked articles.",
      "Plan anti-bot bypass if the site resists.",
      "Fallback to captcha solving for access.",
      "Use proxy-pool evasion to keep importing.",
    ]) {
      await expect(
        tool.execute("blocked-phrase", {
          adapterName: "unsafe-adapter",
          adapterType: "official_reference_export",
          referenceUrl: "https://example.com",
          sourceFamily: "public_web_reference",
          sourceName: "Unsafe Source",
          collectionMethod: "browser_assisted_manual_collection",
          retrievalNotes: phrase,
          complianceNotes: SAFE_COMPLIANCE_NOTES,
        }),
      ).rejects.toThrow("external finance source adapters must reject");
    }
  });

  it("rejects execution, trading, auto-promotion, and doctrine mutation signals", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-external-adapter-");
    const tool = createFinanceExternalSourceAdapterTool({ workspaceDir });

    await expect(
      tool.execute("execution-request", {
        adapterName: "safe-adapter",
        adapterType: "official_reference_export",
        referenceUrl: "https://example.com",
        sourceFamily: "public_web_reference",
        sourceName: "Execution Source",
        collectionMethod: "browser_assisted_manual_collection",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
        complianceNotes: SAFE_COMPLIANCE_NOTES,
        executionRequested: true,
      }),
    ).rejects.toThrow("executionRequested must stay false");

    await expect(
      tool.execute("auto-promotion-request", {
        adapterName: "safe-adapter",
        adapterType: "official_reference_export",
        referenceUrl: "https://example.com",
        sourceFamily: "public_web_reference",
        sourceName: "Auto Promotion Source",
        collectionMethod: "browser_assisted_manual_collection",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
        complianceNotes: SAFE_COMPLIANCE_NOTES,
        autoPromotionRequested: true,
      }),
    ).rejects.toThrow("autoPromotionRequested must stay false");

    await expect(
      tool.execute("doctrine-mutation-request", {
        adapterName: "safe-adapter",
        adapterType: "official_reference_export",
        referenceUrl: "https://example.com",
        sourceFamily: "public_web_reference",
        sourceName: "Doctrine Mutation Source",
        collectionMethod: "browser_assisted_manual_collection",
        retrievalNotes: SAFE_RETRIEVAL_NOTES,
        complianceNotes: SAFE_COMPLIANCE_NOTES,
        doctrineMutationRequested: true,
      }),
    ).rejects.toThrow("doctrineMutationRequested must stay false");

    await expect(
      tool.execute("trading-text", {
        adapterName: "safe-adapter",
        adapterType: "official_reference_export",
        referenceUrl: "https://example.com",
        sourceFamily: "public_web_reference",
        sourceName: "Trading Text Source",
        collectionMethod: "browser_assisted_manual_collection",
        retrievalNotes: "Use this source to buy now after the import completes.",
        complianceNotes: SAFE_COMPLIANCE_NOTES,
      }),
    ).rejects.toThrow("finance article source registration must stay non-executing");
  });
});
