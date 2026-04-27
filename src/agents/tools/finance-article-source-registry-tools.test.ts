import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceArticleSourceCollectionPreflightTool } from "./finance-article-source-collection-preflight-tool.js";
import { createFinanceArticleSourceRegistryInspectTool } from "./finance-article-source-registry-inspect-tool.js";
import { createFinanceArticleSourceRegistryRecordTool } from "./finance-article-source-registry-record-tool.js";

function buildBaseArgs() {
  return {
    complianceNotes: "Use only safe, explicitly permitted collection paths.",
    rateLimitNotes: "Stay low-frequency and operator-driven.",
    freshnessExpectation: "daily",
    reliabilityNotes: "Useful as research input only and must remain bounded.",
    extractionTarget: "finance_article_extract_capability_input",
    allowedActionAuthority: "research_only",
  } as const;
}

describe("finance article source registry tools", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("accepts a valid manual WeChat/public-account source as manual_only and returns the extraction target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-source-registry-");
    const recordTool = createFinanceArticleSourceRegistryRecordTool({ workspaceDir });
    const preflightTool = createFinanceArticleSourceCollectionPreflightTool({ workspaceDir });

    const recordResult = await recordTool.execute("record-wechat", {
      sourceName: "Example public account",
      sourceType: "wechat_public_account_source",
      sourceUrlOrIdentifier: "wechat://example-public-account",
      allowedCollectionMethods: ["manual_paste", "browser_assisted_manual_collection"],
      requiresManualInput: true,
      ...buildBaseArgs(),
    });
    expect(recordResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        preflightStatus: "manual_only",
        extractionToolTarget: "finance_article_extract_capability_input",
      }),
    );

    const preflightResult = await preflightTool.execute("preflight-wechat", {
      sourceName: "Example public account",
    });
    expect(preflightResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        preflightStatus: "manual_only",
        extractionToolTarget: "finance_article_extract_capability_input",
      }),
    );
  });

  it("accepts a local file source and returns the article extraction target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-source-registry-");
    const recordTool = createFinanceArticleSourceRegistryRecordTool({ workspaceDir });
    const preflightTool = createFinanceArticleSourceCollectionPreflightTool({ workspaceDir });

    await recordTool.execute("record-local-file", {
      sourceName: "Operator article drop",
      sourceType: "manual_article_source",
      sourceUrlOrIdentifier: "memory/articles/",
      allowedCollectionMethods: ["local_file"],
      requiresManualInput: false,
      ...buildBaseArgs(),
    });

    const preflightResult = await preflightTool.execute("preflight-local-file", {
      sourceName: "Operator article drop",
    });
    expect(preflightResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        preflightStatus: "allowed",
        extractionToolTarget: "finance_article_extract_capability_input",
      }),
    );
  });

  it("accepts RSS/public feed sources only when marked public", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-source-registry-");
    const recordTool = createFinanceArticleSourceRegistryRecordTool({ workspaceDir });
    const preflightTool = createFinanceArticleSourceCollectionPreflightTool({ workspaceDir });

    await recordTool.execute("record-public-feed", {
      sourceName: "Public market feed",
      sourceType: "rss_public_feed_source",
      sourceUrlOrIdentifier: "https://example.com/feed.xml",
      allowedCollectionMethods: ["rss_or_public_feed_if_available"],
      requiresManualInput: false,
      isPubliclyAccessible: true,
      ...buildBaseArgs(),
    });
    const allowedResult = await preflightTool.execute("preflight-public-feed", {
      sourceName: "Public market feed",
    });
    expect(allowedResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        preflightStatus: "allowed",
        extractionToolTarget: null,
      }),
    );

    await recordTool.execute("record-private-feed", {
      sourceName: "Private-ish feed",
      sourceType: "rss_public_feed_source",
      sourceUrlOrIdentifier: "https://example.com/private-feed.xml",
      allowedCollectionMethods: ["rss_or_public_feed_if_available"],
      requiresManualInput: false,
      isPubliclyAccessible: false,
      ...buildBaseArgs(),
    });
    const blockedResult = await preflightTool.execute("preflight-private-feed", {
      sourceName: "Private-ish feed",
    });
    expect(blockedResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        preflightStatus: "blocked",
      }),
    );
  });

  it("rejects credential bypass, paywall bypass, anti-bot bypass, hidden API scraping, and unauthorized bulk scraping", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-source-registry-");
    const recordTool = createFinanceArticleSourceRegistryRecordTool({ workspaceDir });

    for (const complianceNotes of [
      "Attempt credential bypass if collection is difficult.",
      "Use paywall bypass if the article is blocked.",
      "Plan anti-bot bypass for collection.",
      "Rely on hidden API scraping for the feed.",
      "Use unauthorized bulk scraping for archives.",
    ]) {
      await expect(
        recordTool.execute("record-illegal-source", {
          ...buildBaseArgs(),
          sourceName: "Illegal source",
          sourceType: "public_web_source",
          sourceUrlOrIdentifier: "https://example.com",
          allowedCollectionMethods: ["manual_paste"],
          requiresManualInput: true,
          complianceNotes,
        }),
      ).rejects.toThrow("finance article source registration must reject credential bypass");
    }
  });

  it("returns manual_only for WeChat/public-account sources unless a safe public feed exists", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-source-registry-");
    const preflightTool = createFinanceArticleSourceCollectionPreflightTool({ workspaceDir });

    const manualOnlyResult = await preflightTool.execute("inline-wechat-manual", {
      sourceName: "Inline WeChat source",
      sourceType: "wechat_public_account_source",
      sourceUrlOrIdentifier: "wechat://inline-source",
      allowedCollectionMethods: ["manual_paste"],
      requiresManualInput: true,
      ...buildBaseArgs(),
    });
    expect(manualOnlyResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        preflightStatus: "manual_only",
        extractionToolTarget: "finance_article_extract_capability_input",
      }),
    );

    const publicFeedResult = await preflightTool.execute("inline-wechat-feed", {
      sourceName: "Inline WeChat with feed",
      sourceType: "wechat_public_account_source",
      sourceUrlOrIdentifier: "https://example.com/public-feed.xml",
      allowedCollectionMethods: ["rss_or_public_feed_if_available"],
      requiresManualInput: false,
      isPubliclyAccessible: true,
      ...buildBaseArgs(),
    });
    expect(publicFeedResult.details).toEqual(
      expect.objectContaining({
        ok: true,
        preflightStatus: "allowed",
        extractionToolTarget: null,
      }),
    );
  });

  it("rejects execution, trading, auto-promotion, and doctrine mutation signals", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-source-registry-");
    const recordTool = createFinanceArticleSourceRegistryRecordTool({ workspaceDir });

    await expect(
      recordTool.execute("execution-request", {
        sourceName: "Execution source",
        sourceType: "manual_article_source",
        sourceUrlOrIdentifier: "memory/articles/",
        allowedCollectionMethods: ["local_file"],
        requiresManualInput: false,
        executionRequested: true,
        ...buildBaseArgs(),
      }),
    ).rejects.toThrow("executionRequested must stay false");

    await expect(
      recordTool.execute("auto-promotion-request", {
        sourceName: "Auto promotion source",
        sourceType: "manual_article_source",
        sourceUrlOrIdentifier: "memory/articles/",
        allowedCollectionMethods: ["local_file"],
        requiresManualInput: false,
        autoPromotionRequested: true,
        ...buildBaseArgs(),
      }),
    ).rejects.toThrow("autoPromotionRequested must stay false");

    await expect(
      recordTool.execute("doctrine-mutation-request", {
        sourceName: "Doctrine mutation source",
        sourceType: "manual_article_source",
        sourceUrlOrIdentifier: "memory/articles/",
        allowedCollectionMethods: ["local_file"],
        requiresManualInput: false,
        doctrineMutationRequested: true,
        ...buildBaseArgs(),
      }),
    ).rejects.toThrow("doctrineMutationRequested must stay false");

    await expect(
      recordTool.execute("trading-text", {
        sourceName: "Trading text source",
        sourceType: "manual_article_source",
        sourceUrlOrIdentifier: "memory/articles/",
        allowedCollectionMethods: ["local_file"],
        requiresManualInput: false,
        complianceNotes: "Use safe local files only. Do not auto-trade.",
        rateLimitNotes: "Stay low-frequency and operator-driven.",
        freshnessExpectation: "daily",
        reliabilityNotes: "Useful as research input only and must remain bounded.",
        extractionTarget: "finance_article_extract_capability_input",
        allowedActionAuthority: "research_only",
      }),
    ).rejects.toThrow("finance article source registration must stay non-executing");
  });

  it("inspects sources by type, collection method, and blocked/manual-only status", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-article-source-registry-");
    const recordTool = createFinanceArticleSourceRegistryRecordTool({ workspaceDir });
    const inspectTool = createFinanceArticleSourceRegistryInspectTool({ workspaceDir });

    await recordTool.execute("record-wechat", {
      sourceName: "Example public account",
      sourceType: "wechat_public_account_source",
      sourceUrlOrIdentifier: "wechat://example-public-account",
      allowedCollectionMethods: ["manual_paste"],
      requiresManualInput: true,
      ...buildBaseArgs(),
    });
    await recordTool.execute("record-local-file", {
      sourceName: "Operator article drop",
      sourceType: "manual_article_source",
      sourceUrlOrIdentifier: "memory/articles/",
      allowedCollectionMethods: ["local_file"],
      requiresManualInput: false,
      ...buildBaseArgs(),
    });
    await recordTool.execute("record-private-feed", {
      sourceName: "Private-ish feed",
      sourceType: "rss_public_feed_source",
      sourceUrlOrIdentifier: "https://example.com/private-feed.xml",
      allowedCollectionMethods: ["rss_or_public_feed_if_available"],
      requiresManualInput: false,
      isPubliclyAccessible: false,
      ...buildBaseArgs(),
    });

    const byType = await inspectTool.execute("inspect-type", {
      sourceType: "wechat_public_account_source",
    });
    expect(byType.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceCount: 1,
        sources: [expect.objectContaining({ sourceName: "Example public account" })],
      }),
    );

    const byMethod = await inspectTool.execute("inspect-method", {
      collectionMethod: "local_file",
    });
    expect(byMethod.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceCount: 1,
        sources: [expect.objectContaining({ sourceName: "Operator article drop" })],
      }),
    );

    const manualOnly = await inspectTool.execute("inspect-manual-only", {
      preflightStatus: "manual_only",
    });
    expect(manualOnly.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceCount: 1,
        sources: [expect.objectContaining({ sourceName: "Example public account" })],
      }),
    );

    const blocked = await inspectTool.execute("inspect-blocked", {
      preflightStatus: "blocked",
    });
    expect(blocked.details).toEqual(
      expect.objectContaining({
        ok: true,
        sourceCount: 1,
        sources: [expect.objectContaining({ sourceName: "Private-ish feed" })],
      }),
    );
  });
});
