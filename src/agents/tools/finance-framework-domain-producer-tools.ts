import { Type } from "@sinclair/typebox";
import {
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS,
  FINANCE_FRAMEWORK_CORE_DOMAINS,
  FINANCE_EVIDENCE_CATEGORIES,
  type FinanceFrameworkCoreDomain,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam, ToolInputError } from "./common.js";
import {
  ensureNonGenericEvidenceSummary,
  validateFinanceDomainEvidenceGate,
} from "./finance-evidence-gates.js";
import {
  type FinanceFrameworkCoreEntryInput,
  writeFinanceFrameworkCoreEntry,
} from "./finance-framework-core-record-tool.js";

type FinanceFrameworkDomainProducerSpec = {
  domain: FinanceFrameworkCoreDomain;
  toolName: string;
  label: string;
  description: string;
};

const FRAMEWORK_CONFIDENCE_LEVELS =
  FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS as readonly string[];
const FRAMEWORK_ACTION_AUTHORITIES =
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES as readonly string[];

export const FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS = [
  {
    domain: "macro_rates_inflation",
    toolName: "finance_framework_macro_rates_inflation_producer",
    label: "Finance Framework Macro Producer",
    description:
      "Create a bounded macro/rates/inflation framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "etf_regime",
    toolName: "finance_framework_etf_regime_producer",
    label: "Finance Framework ETF Producer",
    description:
      "Create a bounded ETF/regime framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "options_volatility",
    toolName: "finance_framework_options_volatility_producer",
    label: "Finance Framework Options Producer",
    description:
      "Create a bounded options/volatility framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "company_fundamentals_value",
    toolName: "finance_framework_company_fundamentals_value_producer",
    label: "Finance Framework Fundamentals Producer",
    description:
      "Create a bounded company fundamentals/value framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "commodities_oil_gold",
    toolName: "finance_framework_commodities_oil_gold_producer",
    label: "Finance Framework Commodities Producer",
    description:
      "Create a bounded commodities/oil/gold framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "fx_dollar",
    toolName: "finance_framework_fx_dollar_producer",
    label: "Finance Framework FX Producer",
    description:
      "Create a bounded FX/dollar framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "credit_liquidity",
    toolName: "finance_framework_credit_liquidity_producer",
    label: "Finance Framework Credit Producer",
    description:
      "Create a bounded credit/liquidity framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "event_driven",
    toolName: "finance_framework_event_driven_producer",
    label: "Finance Framework Event Producer",
    description:
      "Create a bounded event-driven framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "portfolio_risk_gates",
    toolName: "finance_framework_portfolio_risk_gates_producer",
    label: "Finance Framework Risk Producer",
    description:
      "Create a bounded portfolio/risk-gates framework skeleton entry from source artifacts and learning outputs only.",
  },
  {
    domain: "causal_map",
    toolName: "finance_framework_causal_map_producer",
    label: "Finance Framework Causal Map Producer",
    description:
      "Create a bounded causal-map framework skeleton entry from source artifacts and learning outputs only.",
  },
] as const satisfies readonly FinanceFrameworkDomainProducerSpec[];

export const FINANCE_FRAMEWORK_DOMAIN_PRODUCER_TOOL_NAMES =
  FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS.map((spec) => spec.toolName);

const FinanceFrameworkDomainProducerSchema = Type.Object({
  domain: Type.String(),
  sourceArtifacts: Type.Array(Type.String()),
  learningOutputs: Type.Optional(Type.Array(Type.String())),
  evidenceCategories: Type.Array(stringEnum(FINANCE_EVIDENCE_CATEGORIES)),
  evidenceSummary: Type.String(),
  baseCase: Type.String(),
  bullCase: Type.String(),
  bearCase: Type.String(),
  keyCausalChain: Type.String(),
  upstreamDrivers: Type.Array(Type.String()),
  downstreamAssetImpacts: Type.Array(Type.String()),
  confidenceOrConviction: Type.String(),
  whatChangesMyMind: Type.String(),
  noActionReason: Type.String(),
  riskGateNotes: Type.String(),
  allowedActionAuthority: Type.String(),
  executionRequested: Type.Optional(Type.Boolean()),
  autoPromotionRequested: Type.Optional(Type.Boolean()),
  doctrineMutationRequested: Type.Optional(Type.Boolean()),
});

function normalizeRequiredText(params: Record<string, unknown>, key: string, label = key): string {
  const normalized = readStringParam(params, key, { required: true, label, allowEmpty: true })
    .trim()
    .replace(/\r\n/gu, "\n");
  if (!normalized) {
    throw new ToolInputError(`${label} must be non-empty`);
  }
  return normalized;
}

function normalizeRequiredStringList(
  params: Record<string, unknown>,
  key: string,
  label = key,
): string[] {
  const value = readStringArrayParam(params, key, { required: true, label }) ?? [];
  const normalized = value.map((item) => item.trim().replace(/\r\n/gu, "\n")).filter(Boolean);
  if (normalized.length === 0) {
    throw new ToolInputError(`${label} must contain at least one non-empty string`);
  }
  return normalized;
}

function normalizeOptionalStringList(params: Record<string, unknown>, key: string): string[] {
  if (Object.hasOwn(params, key) && Array.isArray(params[key]) && params[key].length === 0) {
    throw new ToolInputError(`${key} must contain at least one non-empty string when provided`);
  }
  const value = readStringArrayParam(params, key) ?? [];
  return value.map((item) => item.trim().replace(/\r\n/gu, "\n")).filter(Boolean);
}

function readFlag(params: Record<string, unknown>, key: string): boolean {
  return typeof params[key] === "boolean" ? params[key] : false;
}

function ensureNoEscalationSignals(params: Record<string, unknown>) {
  if (readFlag(params, "executionRequested")) {
    throw new ToolInputError(
      "executionRequested must stay false for finance framework domain producer skeletons",
    );
  }
  if (readFlag(params, "autoPromotionRequested")) {
    throw new ToolInputError(
      "autoPromotionRequested must stay false for finance framework domain producer skeletons",
    );
  }
  if (readFlag(params, "doctrineMutationRequested")) {
    throw new ToolInputError(
      "doctrineMutationRequested must stay false for finance framework domain producer skeletons",
    );
  }
}

function normalizeDomainProducerEntry(
  params: Record<string, unknown>,
  expectedDomain: FinanceFrameworkCoreDomain,
): FinanceFrameworkCoreEntryInput {
  const requestedDomain = normalizeRequiredText(params, "domain", "domain");
  if (!FINANCE_FRAMEWORK_CORE_DOMAINS.includes(expectedDomain)) {
    throw new ToolInputError(`unsupported finance framework domain: ${expectedDomain}`);
  }
  if (requestedDomain !== expectedDomain) {
    throw new ToolInputError(`domain must match ${expectedDomain}`);
  }

  ensureNoEscalationSignals(params);

  const sourceArtifacts = normalizeRequiredStringList(params, "sourceArtifacts", "sourceArtifacts");
  const learningOutputs = normalizeOptionalStringList(params, "learningOutputs");
  const evidenceCategories = normalizeRequiredStringList(
    params,
    "evidenceCategories",
    "evidenceCategories",
  );
  const evidenceSummary = normalizeRequiredText(params, "evidenceSummary", "evidenceSummary");
  ensureNonGenericEvidenceSummary(evidenceSummary, "evidenceSummary");
  const keyCausalChain = normalizeRequiredText(params, "keyCausalChain", "keyCausalChain");
  const confidenceOrConviction = normalizeRequiredText(
    params,
    "confidenceOrConviction",
    "confidenceOrConviction",
  );
  if (!FRAMEWORK_CONFIDENCE_LEVELS.includes(confidenceOrConviction)) {
    throw new ToolInputError(
      `confidenceOrConviction must be one of: ${FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS.join(", ")}`,
    );
  }
  const allowedActionAuthority = normalizeRequiredText(
    params,
    "allowedActionAuthority",
    "allowedActionAuthority",
  );
  if (!FRAMEWORK_ACTION_AUTHORITIES.includes(allowedActionAuthority)) {
    throw new ToolInputError(
      `allowedActionAuthority must be one of: ${FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES.join(", ")}`,
    );
  }
  validateFinanceDomainEvidenceGate({
    domain: expectedDomain,
    evidenceCategories,
    evidenceSummary,
    keyCausalChain,
    upstreamDrivers: normalizeRequiredStringList(params, "upstreamDrivers", "upstreamDrivers"),
    downstreamAssetImpacts: normalizeRequiredStringList(
      params,
      "downstreamAssetImpacts",
      "downstreamAssetImpacts",
    ),
  });

  const combinedSources = [...sourceArtifacts];
  for (const output of learningOutputs) {
    combinedSources.push(`learning-output: ${output}`);
  }
  const upstreamDrivers = normalizeRequiredStringList(params, "upstreamDrivers", "upstreamDrivers");
  const downstreamAssetImpacts = normalizeRequiredStringList(
    params,
    "downstreamAssetImpacts",
    "downstreamAssetImpacts",
  );

  return {
    domain: expectedDomain,
    sourceArtifacts: [...new Set(combinedSources)],
    evidenceCategories: evidenceCategories as FinanceFrameworkCoreEntryInput["evidenceCategories"],
    evidenceSummary,
    baseCase: normalizeRequiredText(params, "baseCase", "baseCase"),
    bullCase: normalizeRequiredText(params, "bullCase", "bullCase"),
    bearCase: normalizeRequiredText(params, "bearCase", "bearCase"),
    keyCausalChain,
    upstreamDrivers,
    downstreamAssetImpacts,
    confidenceOrConviction:
      confidenceOrConviction as FinanceFrameworkCoreEntryInput["confidenceOrConviction"],
    whatChangesMyMind: normalizeRequiredText(params, "whatChangesMyMind", "whatChangesMyMind"),
    noActionReason: normalizeRequiredText(params, "noActionReason", "noActionReason"),
    riskGateNotes: normalizeRequiredText(params, "riskGateNotes", "riskGateNotes"),
    allowedActionAuthority:
      allowedActionAuthority as FinanceFrameworkCoreEntryInput["allowedActionAuthority"],
  };
}

function createFinanceFrameworkDomainProducerTool(
  spec: FinanceFrameworkDomainProducerSpec,
  workspaceDir: string,
): AnyAgentTool {
  return {
    label: spec.label,
    name: spec.toolName,
    description: `${spec.description} This writes through the shared finance framework core contract only and never grants execution authority, auto-promotes anything, or mutates doctrine cards.`,
    parameters: FinanceFrameworkDomainProducerSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const entry = normalizeDomainProducerEntry(params, spec.domain);
      const result = await writeFinanceFrameworkCoreEntry({
        workspaceDir,
        entry,
      });
      return jsonResult({
        ...result,
        producerDomain: spec.domain,
        inspectTool: "finance_framework_core_inspect",
        inspectDomain: spec.domain,
      });
    },
  };
}

export function createFinanceFrameworkDomainProducerTools(options?: {
  workspaceDir?: string;
}): AnyAgentTool[] {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS.map((spec) =>
    createFinanceFrameworkDomainProducerTool(spec, workspaceDir),
  );
}
