import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinanceFrameworkCoreContractPath,
  renderFinanceFrameworkCoreContractArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceFrameworkCoreInspectTool } from "./finance-framework-core-inspect-tool.js";

describe("finance_framework_core_inspect tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedFrameworkContract() {
    await fs.mkdir(path.join(workspaceDir!, "memory", "local-memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir!, buildFinanceFrameworkCoreContractPath()),
      renderFinanceFrameworkCoreContractArtifact({
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
            baseCase:
              "Rates stay restrictive and keep broad duration-sensitive risk assets capped.",
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
          {
            domain: "credit_liquidity",
            sourceArtifacts: ["memory/feishu-work-receipts/2026-04-16-credit-stress.md"],
            evidenceCategories: ["credit_evidence", "liquidity_evidence"],
            evidenceSummary:
              "Credit spread and liquidity evidence support the bounded credit-liquidity monitoring view.",
            baseCase: "Credit stress is contained and not yet confirming systemic risk-off.",
            bullCase: "Spreads tighten and breadth improves, reducing stress spillover risk.",
            bearCase: "Spreads widen fast and funding pressure starts transmitting cross-asset.",
            keyCausalChain:
              "Credit spread widening -> tighter financial conditions -> weaker small-cap and cyclicals",
            upstreamDrivers: ["credit spreads", "funding conditions"],
            downstreamAssetImpacts: ["HY stress", "small-cap weakness"],
            confidenceOrConviction: "low",
            whatChangesMyMind:
              "Sustained tightening in spreads and better funding conditions would weaken the stress case.",
            noActionReason:
              "Cross-asset confirmation is still incomplete, so the entry remains watch-oriented.",
            riskGateNotes:
              "Keep any escalation bounded until liquidity stress is independently confirmed.",
            allowedActionAuthority: "watch_only",
          },
        ],
      }),
      "utf8",
    );
  }

  it("shows current framework visibility for one exact domain", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-core-inspect-");
    await seedFrameworkContract();
    const tool = createFinanceFrameworkCoreInspectTool({ workspaceDir });

    const result = await tool.execute("finance-framework-core-inspect", {
      domain: "macro_rates_inflation",
    });

    expect(result.details).toEqual({
      ok: true,
      contractPath: "memory/local-memory/finance-framework-core-contract.md",
      updatedAt: "2026-04-16T21:00:00.000Z",
      domainCount: 2,
      entry: expect.objectContaining({
        domain: "macro_rates_inflation",
        allowedActionAuthority: "research_only",
      }),
    });
  });

  it("fails closed when the contract is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-core-inspect-");
    await fs.mkdir(path.join(workspaceDir, "memory", "local-memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, buildFinanceFrameworkCoreContractPath()),
      "# Finance Framework Core Contract\n\n- **Updated At**: 2026-04-16T21:00:00.000Z\n\n## Domain Entries\n### Domain Entry 1\n- **Domain**: invalid_domain\n",
      "utf8",
    );

    const tool = createFinanceFrameworkCoreInspectTool({ workspaceDir });
    const result = await tool.execute("finance-framework-core-inspect-malformed", {});

    expect(result.details).toEqual({
      ok: false,
      reason: "finance_framework_core_contract_malformed",
      contractPath: "memory/local-memory/finance-framework-core-contract.md",
      action:
        "Repair or archive the malformed finance framework core contract before retrying finance_framework_core_inspect.",
    });
  });
});
