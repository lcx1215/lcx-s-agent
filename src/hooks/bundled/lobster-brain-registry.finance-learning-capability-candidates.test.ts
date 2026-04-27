import { describe, expect, it } from "vitest";
import {
  buildFinanceFrameworkCoreContractPath,
  parseFinanceLearningCapabilityCandidateArtifact,
  renderFinanceLearningCapabilityCandidateArtifact,
} from "./lobster-brain-registry.js";

describe("finance learning capability candidate artifact", () => {
  it("round-trips a valid capability candidate artifact", () => {
    const rendered = renderFinanceLearningCapabilityCandidateArtifact({
      updatedAt: "2026-04-16T21:00:00.000Z",
      frameworkContractPath: buildFinanceFrameworkCoreContractPath(),
      candidates: [
        {
          candidateId: "candidate-1",
          sourceArticlePath: "memory/articles/article-1.md",
          title: "Sample article",
          sourceType: "wechat_public_account_article",
          collectionMethod: "public_wechat_capture",
          authorSourceName: "Sample author",
          publishDate: "2026-04-15",
          extractionSummary:
            "This learning note describes a repeatable volatility mapping method with explicit risk and evidence caveats.",
          rawNotes: "Detailed raw notes about the method and its intended bounded use.",
          capabilityName: "Volatility term-structure mapping",
          capabilityType: "analysis_method",
          relatedFinanceDomains: ["options_volatility", "causal_map"],
          capabilityTags: ["volatility_research", "causal_mapping"],
          evidenceCategories: ["options_volatility_evidence", "causal_chain_evidence"],
          evidenceSummary:
            "Options skew and term-structure evidence support a bounded causal volatility mapping capability.",
          methodSummary: "Map IV term structure changes to bounded research hypotheses.",
          requiredDataSources: ["option chain term structure", "index realized volatility"],
          causalOrMechanisticClaim:
            "IV term structure dislocations can indicate changing hedging demand and regime stress.",
          evidenceLevel: "case_study",
          implementationRequirements: "Structured option-chain snapshots and manual review.",
          riskAndFailureModes:
            "False positives in headline-driven gaps and thin-liquidity regimes.",
          overfittingOrSpuriousRisk:
            "Short lookback narratives can overfit single stress episodes.",
          complianceOrCollectionNotes: "Use public or licensed market data only.",
          suggestedAttachmentPoint: "finance_framework_domain:options_volatility",
          allowedActionAuthority: "research_only",
        },
      ],
    });

    expect(parseFinanceLearningCapabilityCandidateArtifact(rendered)).toEqual({
      updatedAt: "2026-04-16T21:00:00.000Z",
      frameworkContractPath: "memory/local-memory/finance-framework-core-contract.md",
      candidates: [
        expect.objectContaining({
          candidateId: "candidate-1",
          relatedFinanceDomains: ["options_volatility", "causal_map"],
          capabilityTags: ["volatility_research", "causal_mapping"],
          allowedActionAuthority: "research_only",
        }),
      ],
    });
  });

  it("fails closed on invalid authority", () => {
    const malformed = `# Finance Learning Capability Candidates

- **Updated At**: 2026-04-16T21:00:00.000Z
- **Framework Contract Path**: memory/local-memory/finance-framework-core-contract.md

## Capability Candidates
### Capability Candidate 1
- **Candidate Id**: candidate-1
- **Source Article Path**: memory/articles/article-1.md
- **Title**: Sample article
- **Source Type**: wechat_public_account_article
- **Collection Method**: public_wechat_capture
- **Author Source Name**: Sample author
- **Publish Date**: 2026-04-15
- **Extraction Summary**: Non-generic structured summary for the candidate.
- **Raw Notes**: Detailed raw notes.
- **Capability Name**: Candidate
- **Capability Type**: analysis_method
- **Evidence Summary**: Concrete bounded evidence.
- **Method Summary**: Method summary.
- **Causal Or Mechanistic Claim**: Causal claim.
- **Evidence Level**: hypothesis
- **Implementation Requirements**: Requirements.
- **Risk And Failure Modes**: Risks.
- **Overfitting Or Spurious Risk**: Overfitting.
- **Compliance Or Collection Notes**: Public sources only.
- **Suggested Attachment Point**: finance_framework_domain:options_volatility
- **Allowed Action Authority**: trade_now
#### Related Finance Domains
- options_volatility
#### Capability Tags
- volatility_research
#### Evidence Categories
- options_volatility_evidence
#### Required Data Sources
- option chain`;

    expect(parseFinanceLearningCapabilityCandidateArtifact(malformed)).toBeUndefined();
  });
});
