import { describe, expect, it } from "vitest";
import {
  parseFinanceArticleSourceRegistryArtifact,
  renderFinanceArticleSourceRegistryArtifact,
} from "./lobster-brain-registry.js";

describe("finance article source registry artifact", () => {
  it("round-trips a valid finance article source registry artifact", () => {
    const rendered = renderFinanceArticleSourceRegistryArtifact({
      updatedAt: "2026-04-16T23:00:00.000Z",
      sources: [
        {
          sourceName: "Example public account",
          sourceType: "wechat_public_account_source",
          sourceUrlOrIdentifier: "wechat://example-public-account",
          allowedCollectionMethods: ["manual_paste", "browser_assisted_manual_collection"],
          requiresManualInput: true,
          complianceNotes: "Use manual paste or browser-assisted manual collection only.",
          rateLimitNotes: "Collect sparingly and manually.",
          freshnessExpectation: "daily",
          reliabilityNotes: "Useful for narrative framing but still needs evidence review.",
          extractionTarget: "finance_article_extract_capability_input",
          allowedActionAuthority: "research_only",
          isPubliclyAccessible: false,
        },
      ],
    });

    expect(parseFinanceArticleSourceRegistryArtifact(rendered)).toEqual({
      updatedAt: "2026-04-16T23:00:00.000Z",
      sources: [
        expect.objectContaining({
          sourceName: "Example public account",
          sourceType: "wechat_public_account_source",
          allowedCollectionMethods: ["manual_paste", "browser_assisted_manual_collection"],
          allowedActionAuthority: "research_only",
        }),
      ],
    });
  });

  it("fails closed on invalid authority", () => {
    const malformed = `# Finance Article Source Registry

- **Updated At**: 2026-04-16T23:00:00.000Z

## Sources
### Source 1
- **Source Name**: Example source
- **Source Type**: public_web_source
- **Source Url Or Identifier**: https://example.com/feed
- **Requires Manual Input**: no
- **Compliance Notes**: Public source only.
- **Rate Limit Notes**: Low frequency access only.
- **Freshness Expectation**: daily
- **Reliability Notes**: Useful with manual review.
- **Extraction Target**: finance_article_extract_capability_input
- **Allowed Action Authority**: trade_now
- **Is Publicly Accessible**: yes
#### Allowed Collection Methods
- local_file`;

    expect(parseFinanceArticleSourceRegistryArtifact(malformed)).toBeUndefined();
  });
});
