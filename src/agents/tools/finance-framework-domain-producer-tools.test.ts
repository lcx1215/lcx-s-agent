import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinanceFrameworkCoreContractPath,
  parseFinanceFrameworkCoreContractArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceFrameworkCoreInspectTool } from "./finance-framework-core-inspect-tool.js";
import {
  createFinanceFrameworkDomainProducerTools,
  FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS,
} from "./finance-framework-domain-producer-tools.js";

const VALID_DOMAIN_EVIDENCE: Record<string, string[]> = {
  macro_rates_inflation: ["macro_rates_evidence", "inflation_evidence"],
  etf_regime: ["equity_market_evidence", "liquidity_evidence"],
  options_volatility: ["options_volatility_evidence"],
  company_fundamentals_value: ["fundamentals_evidence", "valuation_evidence"],
  commodities_oil_gold: ["commodity_evidence"],
  fx_dollar: ["fx_dollar_evidence", "macro_rates_evidence"],
  credit_liquidity: ["credit_evidence", "liquidity_evidence"],
  event_driven: ["event_catalyst_evidence", "portfolio_risk_evidence"],
  portfolio_risk_gates: ["portfolio_risk_evidence", "implementation_evidence"],
  causal_map: ["causal_chain_evidence"],
};

function buildValidSkeletonArgs(domain: string) {
  return {
    domain,
    sourceArtifacts: [`memory/feishu-work-receipts/${domain}-source.md`],
    learningOutputs: [`${domain} learning output`],
    evidenceCategories: VALID_DOMAIN_EVIDENCE[domain],
    evidenceSummary: `${domain} domain evidence uses concrete category-matched support instead of generic finance claims.`,
    baseCase: `${domain} base skeleton`,
    bullCase: `${domain} bull skeleton`,
    bearCase: `${domain} bear skeleton`,
    keyCausalChain: `${domain} upstream -> transmission -> downstream`,
    upstreamDrivers: [`${domain} driver`],
    downstreamAssetImpacts: [`${domain} impact`],
    confidenceOrConviction: "medium",
    whatChangesMyMind: `${domain} change trigger`,
    noActionReason: `${domain} remains bounded research only`,
    riskGateNotes: `${domain} risk gates stay manual`,
    allowedActionAuthority: "research_only",
  };
}

describe("finance framework domain producer tools", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("writes valid framework skeleton entries for every supported domain and exposes inspect targets", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const producerTools = createFinanceFrameworkDomainProducerTools({ workspaceDir });
    const inspectTool = createFinanceFrameworkCoreInspectTool({ workspaceDir });

    for (const spec of FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS) {
      const tool = producerTools.find((candidate) => candidate.name === spec.toolName);
      expect(tool).toBeDefined();
      const result = await tool!.execute(spec.toolName, buildValidSkeletonArgs(spec.domain));
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          updated: true,
          domain: spec.domain,
          producerDomain: spec.domain,
          inspectTool: "finance_framework_core_inspect",
          inspectDomain: spec.domain,
          allowedActionAuthority: "research_only",
        }),
      );

      const inspectResult = await inspectTool.execute(`inspect-${spec.domain}`, {
        domain: spec.domain,
      });
      expect(inspectResult.details).toEqual(
        expect.objectContaining({
          ok: true,
          entry: expect.objectContaining({
            domain: spec.domain,
            keyCausalChain: `${spec.domain} upstream -> transmission -> downstream`,
            allowedActionAuthority: "research_only",
          }),
        }),
      );
    }

    const parsed = parseFinanceFrameworkCoreContractArtifact(
      await fs.readFile(path.join(workspaceDir, buildFinanceFrameworkCoreContractPath()), "utf8"),
    );
    expect(parsed?.entries.map((entry) => entry.domain)).toEqual(
      FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS.map((spec) => spec.domain).toSorted(),
    );
  });

  it("fails closed on invalid domain", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const tool = createFinanceFrameworkDomainProducerTools({ workspaceDir }).find(
      (candidate) => candidate.name === "finance_framework_macro_rates_inflation_producer",
    );

    await expect(
      tool!.execute("invalid-domain", {
        ...buildValidSkeletonArgs("macro_rates_inflation"),
        domain: "invalid_domain",
      }),
    ).rejects.toThrow("domain must match macro_rates_inflation");
  });

  it("fails closed on invalid allowed action authority", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const tool = createFinanceFrameworkDomainProducerTools({ workspaceDir }).find(
      (candidate) => candidate.name === "finance_framework_etf_regime_producer",
    );

    await expect(
      tool!.execute("invalid-authority", {
        ...buildValidSkeletonArgs("etf_regime"),
        allowedActionAuthority: "trade_now",
      }),
    ).rejects.toThrow("allowedActionAuthority must be one of");
  });

  it("fails closed on missing source artifacts", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const tool = createFinanceFrameworkDomainProducerTools({ workspaceDir }).find(
      (candidate) => candidate.name === "finance_framework_options_volatility_producer",
    );

    await expect(
      tool!.execute("missing-source-artifacts", {
        ...buildValidSkeletonArgs("options_volatility"),
        sourceArtifacts: [],
      }),
    ).rejects.toThrow("sourceArtifacts required");
  });

  it("fails closed on missing causal chain", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const tool = createFinanceFrameworkDomainProducerTools({ workspaceDir }).find(
      (candidate) => candidate.name === "finance_framework_company_fundamentals_value_producer",
    );

    await expect(
      tool!.execute("missing-causal-chain", {
        ...buildValidSkeletonArgs("company_fundamentals_value"),
        keyCausalChain: "   ",
      }),
    ).rejects.toThrow("keyCausalChain must be non-empty");
  });

  it("fails closed on empty learning outputs when explicitly provided", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const tool = createFinanceFrameworkDomainProducerTools({ workspaceDir }).find(
      (candidate) => candidate.name === "finance_framework_macro_rates_inflation_producer",
    );

    await expect(
      tool!.execute("empty-learning-outputs", {
        ...buildValidSkeletonArgs("macro_rates_inflation"),
        learningOutputs: [],
      }),
    ).rejects.toThrow("learningOutputs must contain at least one non-empty string when provided");
  });

  it("fails closed on execution requests", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const tool = createFinanceFrameworkDomainProducerTools({ workspaceDir }).find(
      (candidate) => candidate.name === "finance_framework_commodities_oil_gold_producer",
    );

    await expect(
      tool!.execute("execution-requested", {
        ...buildValidSkeletonArgs("commodities_oil_gold"),
        executionRequested: true,
      }),
    ).rejects.toThrow("executionRequested must stay false");
  });

  it("fails closed on doctrine mutation requests", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const tool = createFinanceFrameworkDomainProducerTools({ workspaceDir }).find(
      (candidate) => candidate.name === "finance_framework_fx_dollar_producer",
    );

    await expect(
      tool!.execute("doctrine-mutation-requested", {
        ...buildValidSkeletonArgs("fx_dollar"),
        doctrineMutationRequested: true,
      }),
    ).rejects.toThrow("doctrineMutationRequested must stay false");
  });

  it("fails closed on auto-promotion requests", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const tool = createFinanceFrameworkDomainProducerTools({ workspaceDir }).find(
      (candidate) => candidate.name === "finance_framework_credit_liquidity_producer",
    );

    await expect(
      tool!.execute("auto-promotion-requested", {
        ...buildValidSkeletonArgs("credit_liquidity"),
        autoPromotionRequested: true,
      }),
    ).rejects.toThrow("autoPromotionRequested must stay false");
  });

  it("rejects generic evidence for every finance domain", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const producerTools = createFinanceFrameworkDomainProducerTools({ workspaceDir });

    for (const spec of FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS) {
      const tool = producerTools.find((candidate) => candidate.name === spec.toolName);
      await expect(
        tool!.execute(`generic-evidence-${spec.domain}`, {
          ...buildValidSkeletonArgs(spec.domain),
          evidenceSummary: "generic evidence",
        }),
      ).rejects.toThrow("evidenceSummary must contain concrete domain-specific evidence");
    }
  });

  it("rejects missing domain-specific evidence gates", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-framework-domain-producers-");
    const producerTools = createFinanceFrameworkDomainProducerTools({ workspaceDir });

    const etfTool = producerTools.find(
      (candidate) => candidate.name === "finance_framework_etf_regime_producer",
    );
    await expect(
      etfTool!.execute("missing-etf-evidence", {
        ...buildValidSkeletonArgs("etf_regime"),
        evidenceCategories: ["equity_market_evidence"],
      }),
    ).rejects.toThrow(
      "etf_regime requires equity_market_evidence plus etf_regime_evidence, macro_rates_evidence, or liquidity_evidence",
    );

    const optionsTool = producerTools.find(
      (candidate) => candidate.name === "finance_framework_options_volatility_producer",
    );
    await expect(
      optionsTool!.execute("missing-options-evidence", {
        ...buildValidSkeletonArgs("options_volatility"),
        evidenceCategories: ["equity_market_evidence"],
      }),
    ).rejects.toThrow("options_volatility requires options_volatility_evidence");

    const fundamentalsTool = producerTools.find(
      (candidate) => candidate.name === "finance_framework_company_fundamentals_value_producer",
    );
    await expect(
      fundamentalsTool!.execute("missing-fundamentals-evidence", {
        ...buildValidSkeletonArgs("company_fundamentals_value"),
        evidenceCategories: ["fundamentals_evidence"],
      }),
    ).rejects.toThrow(
      "company_fundamentals_value requires fundamentals_evidence and valuation_evidence",
    );

    const creditTool = producerTools.find(
      (candidate) => candidate.name === "finance_framework_credit_liquidity_producer",
    );
    await expect(
      creditTool!.execute("missing-credit-evidence", {
        ...buildValidSkeletonArgs("credit_liquidity"),
        evidenceCategories: ["credit_evidence"],
      }),
    ).rejects.toThrow("credit_liquidity requires credit_evidence and liquidity_evidence");

    const causalMapTool = producerTools.find(
      (candidate) => candidate.name === "finance_framework_causal_map_producer",
    );
    await expect(
      causalMapTool!.execute("unsupported-causal-links", {
        ...buildValidSkeletonArgs("causal_map"),
        keyCausalChain: "prices move around",
      }),
    ).rejects.toThrow(
      "causal_map requires supported upstream, mechanism, and downstream causal links",
    );
  });
});
