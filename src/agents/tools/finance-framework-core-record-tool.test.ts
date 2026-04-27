import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinanceFrameworkCoreContractPath,
  parseFinanceFrameworkCoreContractArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceFrameworkCoreRecordTool } from "./finance-framework-core-record-tool.js";

describe("finance_framework_core_record tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("records one bounded cross-domain finance framework entry", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-core-record-");
    const tool = createFinanceFrameworkCoreRecordTool({ workspaceDir });

    const result = await tool.execute("finance-framework-core-record", {
      domain: "macro_rates_inflation",
      sourceArtifacts: [
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
      ],
      evidenceCategories: ["macro_rates_evidence", "inflation_evidence"],
      evidenceSummary:
        "Macro rates evidence from inflation prints and policy-path tracking supports the bounded framework entry.",
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
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      domain: "macro_rates_inflation",
      contractPath: "memory/local-memory/finance-framework-core-contract.md",
      allowedActionAuthority: "research_only",
      confidenceOrConviction: "medium",
      action:
        "This records bounded finance framework cognition only. It does not create trading execution authority, does not promote doctrine, and does not mutate doctrine cards automatically.",
    });

    const parsed = parseFinanceFrameworkCoreContractArtifact(
      await fs.readFile(path.join(workspaceDir, buildFinanceFrameworkCoreContractPath()), "utf8"),
    );
    expect(parsed?.entries).toEqual([
      expect.objectContaining({
        domain: "macro_rates_inflation",
        allowedActionAuthority: "research_only",
        evidenceCategories: ["macro_rates_evidence", "inflation_evidence"],
      }),
    ]);
    expect(parsed?.entries.some((entry) => entry.allowedActionAuthority === "trade_now")).toBe(
      false,
    );
  });

  it("fails closed when the existing contract is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-core-record-");
    await fs.mkdir(path.join(workspaceDir, "memory", "local-memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, buildFinanceFrameworkCoreContractPath()),
      "# Finance Framework Core Contract\n\n- **Updated At**: 2026-04-16T21:00:00.000Z\n\n## Domain Entries\n### Domain Entry 1\n- **Domain**: invalid_domain\n",
      "utf8",
    );

    const tool = createFinanceFrameworkCoreRecordTool({ workspaceDir });
    const result = await tool.execute("finance-framework-core-record-malformed", {
      domain: "etf_regime",
      sourceArtifacts: ["memory/feishu-work-receipts/example.md"],
      evidenceCategories: ["equity_market_evidence", "etf_regime_evidence"],
      evidenceSummary: "ETF regime evidence from breadth and liquidity context.",
      baseCase: "base",
      bullCase: "bull",
      bearCase: "bear",
      keyCausalChain: "causal",
      upstreamDrivers: ["driver"],
      downstreamAssetImpacts: ["impact"],
      confidenceOrConviction: "low",
      whatChangesMyMind: "change",
      noActionReason: "no action",
      riskGateNotes: "risk",
      allowedActionAuthority: "watch_only",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "finance_framework_core_contract_malformed",
      contractPath: "memory/local-memory/finance-framework-core-contract.md",
      action:
        "Repair or archive the malformed finance framework core contract before retrying finance_framework_core_record.",
    });
  });
});
