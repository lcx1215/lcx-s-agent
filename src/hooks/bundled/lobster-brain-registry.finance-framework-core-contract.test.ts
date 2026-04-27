import { describe, expect, it } from "vitest";
import {
  parseFinanceFrameworkCoreContractArtifact,
  renderFinanceFrameworkCoreContractArtifact,
} from "./lobster-brain-registry.js";

describe("finance framework core contract artifact", () => {
  it("round-trips the bounded finance framework core contract", () => {
    const rendered = renderFinanceFrameworkCoreContractArtifact({
      updatedAt: "2026-04-16T21:00:00.000Z",
      entries: [
        {
          domain: "macro_rates_inflation",
          sourceArtifacts: [
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
          ],
          evidenceCategories: ["macro_rates_evidence", "inflation_evidence"],
          evidenceSummary:
            "Macro rates evidence from inflation prints and policy-path tracking supports the bounded domain view.",
          baseCase: "Rates stay restrictive and keep broad duration-sensitive risk assets capped.",
          bullCase: "Disinflation resumes cleanly and gives growth assets valuation relief.",
          bearCase: "Inflation re-accelerates and pushes the rate path higher for longer.",
          keyCausalChain:
            "Inflation pressure -> higher rates path -> higher discount rates -> weaker long-duration asset appetite",
          upstreamDrivers: ["core inflation", "Fed path", "labor market resilience"],
          downstreamAssetImpacts: ["QQQ pressure", "TLT pressure", "USD support"],
          confidenceOrConviction: "medium",
          whatChangesMyMind:
            "Clear disinflation plus softer labor data would weaken the higher-for-longer regime case.",
          noActionReason:
            "The framework entry is for bounded research orientation, not for immediate execution.",
          riskGateNotes:
            "Do not escalate beyond research_only until cross-asset confirmation and risk gates align.",
          allowedActionAuthority: "research_only",
        },
      ],
    });

    expect(parseFinanceFrameworkCoreContractArtifact(rendered)).toEqual({
      updatedAt: "2026-04-16T21:00:00.000Z",
      entries: [
        {
          domain: "macro_rates_inflation",
          sourceArtifacts: [
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
          ],
          evidenceCategories: ["macro_rates_evidence", "inflation_evidence"],
          evidenceSummary:
            "Macro rates evidence from inflation prints and policy-path tracking supports the bounded domain view.",
          baseCase: "Rates stay restrictive and keep broad duration-sensitive risk assets capped.",
          bullCase: "Disinflation resumes cleanly and gives growth assets valuation relief.",
          bearCase: "Inflation re-accelerates and pushes the rate path higher for longer.",
          keyCausalChain:
            "Inflation pressure -> higher rates path -> higher discount rates -> weaker long-duration asset appetite",
          upstreamDrivers: ["core inflation", "Fed path", "labor market resilience"],
          downstreamAssetImpacts: ["QQQ pressure", "TLT pressure", "USD support"],
          confidenceOrConviction: "medium",
          whatChangesMyMind:
            "Clear disinflation plus softer labor data would weaken the higher-for-longer regime case.",
          noActionReason:
            "The framework entry is for bounded research orientation, not for immediate execution.",
          riskGateNotes:
            "Do not escalate beyond research_only until cross-asset confirmation and risk gates align.",
          allowedActionAuthority: "research_only",
        },
      ],
    });
  });

  it("fails closed on invalid domain values", () => {
    const invalidArtifact = `# Finance Framework Core Contract

- **Updated At**: 2026-04-16T21:00:00.000Z

## Domain Entries
### Domain Entry 1
- **Domain**: unsupported_domain
- **Base Case**: base
- **Bull Case**: bull
- **Bear Case**: bear
- **Key Causal Chain**: causal
- **Evidence Summary**: Concrete domain evidence.
- **Confidence Or Conviction**: medium
- **What Changes My Mind**: change
- **No Action Reason**: no action
- **Risk Gate Notes**: risk
- **Allowed Action Authority**: research_only
#### Source Artifacts
- memory/feishu-work-receipts/example.md
#### Evidence Categories
- macro_rates_evidence
- inflation_evidence
#### Upstream Drivers
- driver
#### Downstream Asset Impacts
- impact
`;

    expect(parseFinanceFrameworkCoreContractArtifact(invalidArtifact)).toBeUndefined();
  });

  it("fails closed on invalid allowed action authority values", () => {
    const invalidArtifact = `# Finance Framework Core Contract

- **Updated At**: 2026-04-16T21:00:00.000Z

## Domain Entries
### Domain Entry 1
- **Domain**: macro_rates_inflation
- **Base Case**: base
- **Bull Case**: bull
- **Bear Case**: bear
- **Key Causal Chain**: causal
- **Evidence Summary**: Concrete domain evidence.
- **Confidence Or Conviction**: medium
- **What Changes My Mind**: change
- **No Action Reason**: no action
- **Risk Gate Notes**: risk
- **Allowed Action Authority**: trade_now
#### Source Artifacts
- memory/feishu-work-receipts/example.md
#### Evidence Categories
- macro_rates_evidence
- inflation_evidence
#### Upstream Drivers
- driver
#### Downstream Asset Impacts
- impact
`;

    expect(parseFinanceFrameworkCoreContractArtifact(invalidArtifact)).toBeUndefined();
  });
});
