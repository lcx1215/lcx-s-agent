import { z } from "zod";
import {
  FINANCE_EVIDENCE_CATEGORIES,
  FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS,
} from "../hooks/bundled/lobster-brain-registry.js";
import type {
  FinanceBrainModuleId,
  FinanceBrainOrchestrationPlan,
} from "./finance-brain-orchestration.js";
import { FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS } from "./tools/finance-framework-domain-producer-tools.js";

const producerDomains = new Set<FinanceBrainModuleId>(
  FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS.map((spec) => spec.domain),
);
const evidenceCategories = new Set<string>(FINANCE_EVIDENCE_CATEGORIES);
const confidenceLevels = new Set<string>(FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS);
const Text = z.string().trim().min(1);
const TextList = z.array(Text).min(1);

const ProducerInput = z
  .object({
    domain: Text,
    sourceArtifacts: TextList,
    learningOutputs: TextList.optional(),
    evidenceCategories: TextList,
    evidenceSummary: Text,
    baseCase: Text,
    bullCase: Text,
    bearCase: Text,
    keyCausalChain: Text,
    upstreamDrivers: TextList,
    downstreamAssetImpacts: TextList,
    confidenceOrConviction: Text,
    whatChangesMyMind: Text,
    noActionReason: Text,
    riskGateNotes: Text,
    allowedActionAuthority: z.literal("research_only"),
    executionRequested: z.literal(false).optional(),
    autoPromotionRequested: z.literal(false).optional(),
    doctrineMutationRequested: z.literal(false).optional(),
  })
  .strict();

export type FinanceDomainProducerInputs = Readonly<
  Partial<Record<FinanceBrainModuleId, Readonly<Record<string, unknown>>>>
>;

export function selectedFinanceProducerModuleIds(
  plan: FinanceBrainOrchestrationPlan,
): readonly FinanceBrainModuleId[] {
  return Object.freeze(
    plan.composition.nodes
      .map((node) => node.moduleId)
      .filter((moduleId) => producerDomains.has(moduleId)),
  );
}

export function financeProducerInputContract(
  plan: FinanceBrainOrchestrationPlan,
  evidenceIds: readonly string[],
) {
  return Object.freeze({
    outputPath: "artifact.supportingAnalysis.financeFrameworkProducerInputs",
    selectedModuleIds: selectedFinanceProducerModuleIds(plan),
    sourceArtifactIds: Object.freeze([...evidenceIds]),
    requiredFields: Object.freeze([
      "domain",
      "sourceArtifacts",
      "evidenceCategories",
      "evidenceSummary",
      "baseCase",
      "bullCase",
      "bearCase",
      "keyCausalChain",
      "upstreamDrivers",
      "downstreamAssetImpacts",
      "confidenceOrConviction",
      "whatChangesMyMind",
      "noActionReason",
      "riskGateNotes",
      "allowedActionAuthority",
    ]),
    allowedEvidenceCategories: Object.freeze([...FINANCE_EVIDENCE_CATEGORIES]),
    allowedConfidenceLevels: Object.freeze([...FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS]),
    allowedActionAuthority: "research_only" as const,
  });
}

export function parseFinanceDomainProducerInputs(params: {
  value: unknown;
  plan: FinanceBrainOrchestrationPlan;
  evidenceIds: ReadonlySet<string>;
}): FinanceDomainProducerInputs {
  const selected = selectedFinanceProducerModuleIds(params.plan);
  if (selected.length === 0) {
    return Object.freeze({});
  }
  if (!params.value || typeof params.value !== "object" || Array.isArray(params.value)) {
    throw new Error("financeFrameworkProducerInputs must be an object");
  }
  const raw = params.value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (moduleId) => !selected.includes(moduleId as FinanceBrainModuleId),
  );
  if (unknown.length > 0) {
    throw new Error(
      `financeFrameworkProducerInputs contains unselected modules: ${unknown.join(",")}`,
    );
  }
  const parsed: Partial<Record<FinanceBrainModuleId, Readonly<Record<string, unknown>>>> = {};
  for (const moduleId of selected) {
    const input = ProducerInput.parse(raw[moduleId]);
    if (input.domain !== moduleId) {
      throw new Error(`producer input domain must match ${moduleId}`);
    }
    const uncited = input.sourceArtifacts.filter((id) => !params.evidenceIds.has(id));
    if (uncited.length > 0) {
      throw new Error(`producer input ${moduleId} cites unknown evidence: ${uncited.join(",")}`);
    }
    const invalidCategories = input.evidenceCategories.filter(
      (category) => !evidenceCategories.has(category),
    );
    if (invalidCategories.length > 0) {
      throw new Error(
        `producer input ${moduleId} has invalid evidence categories: ${invalidCategories.join(",")}`,
      );
    }
    if (!confidenceLevels.has(input.confidenceOrConviction)) {
      throw new Error(`producer input ${moduleId} has invalid confidenceOrConviction`);
    }
    parsed[moduleId] = Object.freeze({ ...input });
  }
  return Object.freeze(parsed);
}
