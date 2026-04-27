import {
  FINANCE_EVIDENCE_CATEGORIES,
  type FinanceEvidenceCategory,
  type FinanceFrameworkCoreDomain,
  type FinanceLearningCapabilityTag,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { ToolInputError } from "./common.js";

const EVIDENCE_CATEGORY_SET = new Set<string>(FINANCE_EVIDENCE_CATEGORIES);

const GENERIC_EVIDENCE_PATTERNS = [
  /^general evidence\b/iu,
  /^generic evidence\b/iu,
  /^market evidence\b/iu,
  /^macro evidence\b/iu,
  /^broad evidence\b/iu,
  /^mixed evidence\b/iu,
  /^various signals\b/iu,
  /^some charts?\b/iu,
  /^article references\b/iu,
] as const;

function includesAny(haystack: Set<string>, needles: readonly string[]) {
  return needles.some((needle) => haystack.has(needle));
}

function ensureCategoriesSupported(categories: string[], label: string): FinanceEvidenceCategory[] {
  if (categories.length === 0) {
    throw new ToolInputError(`${label} must contain at least one evidence category`);
  }
  for (const category of categories) {
    if (!EVIDENCE_CATEGORY_SET.has(category)) {
      throw new ToolInputError(
        `${label} must use supported finance evidence categories: ${FINANCE_EVIDENCE_CATEGORIES.join(", ")}`,
      );
    }
  }
  return categories as FinanceEvidenceCategory[];
}

export function ensureNonGenericEvidenceSummary(summary: string, label: string) {
  const normalized = summary.trim();
  if (
    normalized.length < 40 ||
    GENERIC_EVIDENCE_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    throw new ToolInputError(`${label} must contain concrete domain-specific evidence, not filler`);
  }
}

export function validateFinanceDomainEvidenceGate(params: {
  domain: FinanceFrameworkCoreDomain;
  evidenceCategories: string[];
  evidenceSummary: string;
  keyCausalChain?: string;
  upstreamDrivers?: string[];
  downstreamAssetImpacts?: string[];
  causalSupportText?: string;
}) {
  const evidenceCategories = ensureCategoriesSupported(
    params.evidenceCategories,
    "evidenceCategories",
  );
  ensureNonGenericEvidenceSummary(params.evidenceSummary, "evidenceSummary");
  const categorySet = new Set<string>(evidenceCategories);

  switch (params.domain) {
    case "macro_rates_inflation":
      if (!categorySet.has("macro_rates_evidence") || !categorySet.has("inflation_evidence")) {
        throw new ToolInputError(
          "macro_rates_inflation requires macro_rates_evidence and inflation_evidence",
        );
      }
      break;
    case "etf_regime":
      if (
        !categorySet.has("equity_market_evidence") ||
        !includesAny(categorySet, [
          "etf_regime_evidence",
          "macro_rates_evidence",
          "liquidity_evidence",
        ])
      ) {
        throw new ToolInputError(
          "etf_regime requires equity_market_evidence plus etf_regime_evidence, macro_rates_evidence, or liquidity_evidence",
        );
      }
      break;
    case "options_volatility":
      if (!categorySet.has("options_volatility_evidence")) {
        throw new ToolInputError("options_volatility requires options_volatility_evidence");
      }
      break;
    case "company_fundamentals_value":
      if (!categorySet.has("fundamentals_evidence") || !categorySet.has("valuation_evidence")) {
        throw new ToolInputError(
          "company_fundamentals_value requires fundamentals_evidence and valuation_evidence",
        );
      }
      break;
    case "commodities_oil_gold":
      if (
        !categorySet.has("commodity_evidence") &&
        !(categorySet.has("macro_rates_evidence") && categorySet.has("inflation_evidence"))
      ) {
        throw new ToolInputError(
          "commodities_oil_gold requires commodity_evidence or combined macro_rates_evidence and inflation_evidence",
        );
      }
      break;
    case "fx_dollar":
      if (
        !categorySet.has("fx_dollar_evidence") ||
        !includesAny(categorySet, ["macro_rates_evidence", "liquidity_evidence"])
      ) {
        throw new ToolInputError(
          "fx_dollar requires fx_dollar_evidence plus macro_rates_evidence or liquidity_evidence",
        );
      }
      break;
    case "credit_liquidity":
      if (!categorySet.has("credit_evidence") || !categorySet.has("liquidity_evidence")) {
        throw new ToolInputError(
          "credit_liquidity requires credit_evidence and liquidity_evidence",
        );
      }
      break;
    case "event_driven":
      if (
        !categorySet.has("event_catalyst_evidence") ||
        !categorySet.has("portfolio_risk_evidence")
      ) {
        throw new ToolInputError(
          "event_driven requires event_catalyst_evidence and portfolio_risk_evidence",
        );
      }
      break;
    case "portfolio_risk_gates":
      if (
        !categorySet.has("portfolio_risk_evidence") ||
        !categorySet.has("implementation_evidence")
      ) {
        throw new ToolInputError(
          "portfolio_risk_gates requires portfolio_risk_evidence and implementation_evidence",
        );
      }
      break;
    case "causal_map":
      if (!categorySet.has("causal_chain_evidence")) {
        throw new ToolInputError("causal_map requires causal_chain_evidence");
      }
      {
        const causalText = [params.keyCausalChain, params.causalSupportText]
          .filter(Boolean)
          .join("\n");
        const hasMechanisticLink =
          causalText.includes("->") ||
          /mechanis|transmi|because|causal|upstream|downstream/iu.test(causalText);
        const hasStructuredSupport =
          (params.upstreamDrivers?.length ?? 0) > 0 &&
          (params.downstreamAssetImpacts?.length ?? 0) > 0;
        if (!hasMechanisticLink || (!hasStructuredSupport && !params.causalSupportText?.trim())) {
          throw new ToolInputError(
            "causal_map requires supported upstream, mechanism, and downstream causal links",
          );
        }
      }
      break;
  }

  return evidenceCategories;
}

export function validateFinanceCapabilityTagEvidenceGate(params: {
  capabilityTags: FinanceLearningCapabilityTag[];
  evidenceCategories: string[];
  sourceArtifactCount: number;
  riskAndFailureModes: string;
  overfittingOrSpuriousRisk: string;
}) {
  const evidenceCategories = ensureCategoriesSupported(
    params.evidenceCategories,
    "capabilityCandidates evidenceCategories",
  );
  const categorySet = new Set<string>(evidenceCategories);
  const riskText =
    `${params.riskAndFailureModes}\n${params.overfittingOrSpuriousRisk}`.toLowerCase();

  for (const tag of params.capabilityTags) {
    switch (tag) {
      case "sentiment_analysis":
        if (!categorySet.has("sentiment_evidence") || params.sourceArtifactCount === 0) {
          throw new ToolInputError(
            "sentiment_analysis requires sentiment_evidence and source artifacts",
          );
        }
        break;
      case "factor_research":
        if (!categorySet.has("backtest_or_empirical_evidence") || !riskText.includes("confound")) {
          throw new ToolInputError(
            "factor_research requires backtest_or_empirical_evidence and confounder notes",
          );
        }
        break;
      case "tactical_timing":
        if (
          !categorySet.has("backtest_or_empirical_evidence") ||
          (!riskText.includes("whipsaw") && !riskText.includes("drawdown"))
        ) {
          throw new ToolInputError(
            "tactical_timing requires backtest_or_empirical_evidence and whipsaw or drawdown risk",
          );
        }
        break;
      case "leverage_research":
        if (
          !categorySet.has("portfolio_risk_evidence") ||
          (!riskText.includes("leverage") && !riskText.includes("drawdown"))
        ) {
          throw new ToolInputError(
            "leverage_research requires portfolio_risk_evidence and leverage or drawdown risk notes",
          );
        }
        break;
      case "alternative_data_ingestion":
        if (
          !categorySet.has("alternative_data_evidence") ||
          !categorySet.has("compliance_evidence")
        ) {
          throw new ToolInputError(
            "alternative_data_ingestion requires alternative_data_evidence and compliance_evidence",
          );
        }
        break;
      case "fundamentals_research":
        if (!categorySet.has("fundamentals_evidence") || !categorySet.has("valuation_evidence")) {
          throw new ToolInputError(
            "fundamentals_research requires fundamentals_evidence and valuation_evidence",
          );
        }
        break;
      case "volatility_research":
        if (!categorySet.has("options_volatility_evidence")) {
          throw new ToolInputError("volatility_research requires options_volatility_evidence");
        }
        break;
      case "causal_mapping":
        if (!categorySet.has("causal_chain_evidence")) {
          throw new ToolInputError("causal_mapping requires causal_chain_evidence");
        }
        break;
      case "event_catalyst_mapping":
        if (!categorySet.has("event_catalyst_evidence")) {
          throw new ToolInputError("event_catalyst_mapping requires event_catalyst_evidence");
        }
        break;
      case "risk_gate_design":
        if (
          !categorySet.has("portfolio_risk_evidence") ||
          !categorySet.has("implementation_evidence")
        ) {
          throw new ToolInputError(
            "risk_gate_design requires portfolio_risk_evidence and implementation_evidence",
          );
        }
        break;
    }
  }

  return evidenceCategories;
}
