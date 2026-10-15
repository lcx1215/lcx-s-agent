import { z } from "zod";
import {
  FINANCE_EVIDENCE_CATEGORIES,
  FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS,
} from "../hooks/bundled/lobster-brain-registry.js";
import type { FinanceFrameworkCoreDomain } from "../hooks/bundled/lobster-brain-registry.js";
import type {
  FinanceBrainModuleId,
  FinanceBrainOrchestrationPlan,
} from "./finance-brain-orchestration.js";
import {
  FINANCE_DOMAIN_EVIDENCE_CATEGORY_REQUIREMENTS,
  validateFinanceDomainEvidenceGate,
} from "./tools/finance-evidence-gates.js";
import { FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS } from "./tools/finance-framework-domain-producer-tools.js";
import {
  FinanceLearningTaskValidator,
  FinanceLearningPriorTaskValidator,
} from "./tools/finance-learning-task-evaluation.js";

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

const LearningApplicationInput = z
  .object({
    sourceArtifacts: TextList,
    sourceArticlePath: Text,
    financialTask: FinanceLearningTaskValidator.optional(),
    priorTaskReceiptSource: FinanceLearningPriorTaskValidator.optional(),
  })
  .strict();
const hasLearningModule = (plan: FinanceBrainOrchestrationPlan) =>
  plan.composition.nodes.some((node) => node.moduleId === "finance_learning_memory");

/** Fixed schema diagnostics only: never echo provider output, IDs, or unknown keys. */
export function describeFinanceProducerInputError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const fields = new Set(Object.keys(ProducerInput.shape));
    const defects = error.issues.slice(0, 8).map((issue) => {
      const field = issue.path.find((part) => typeof part === "string" && fields.has(part));
      return issue.code === "unrecognized_keys"
        ? "unexpected_fields"
        : `${typeof field === "string" ? field : "module_object"}:${issue.code}`;
    });
    return `producer schema invalid (${[...new Set(defects)].join(", ")})`;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("cites unknown evidence")) {
    return "sourceArtifacts must use only listed sourceArtifactIds";
  }
  if (message.includes("invalid evidence categories")) {
    return "evidenceCategories must use allowedEvidenceCategories";
  }
  if (message.includes("invalid confidenceOrConviction")) {
    return "confidenceOrConviction must use allowedConfidenceLevels";
  }
  if (message.includes("domain must match")) {
    return "domain must match its selected module key";
  }
  if (message.includes("selected domain evidence gate")) {
    return "evidenceCategories, evidenceSummary, and causal links must satisfy evidenceGateByModule; do not invent or relabel evidence";
  }
  return "financeFrameworkProducerInputs must contain exactly ALL selectedModuleIds as object keys";
}

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
  const selectedModuleIds = selectedFinanceProducerModuleIds(plan);
  const categoryRequirements = Object.fromEntries(
    selectedModuleIds.map((moduleId) => {
      const requirements =
        FINANCE_DOMAIN_EVIDENCE_CATEGORY_REQUIREMENTS[moduleId as FinanceFrameworkCoreDomain];
      return [
        moduleId,
        {
          requiredAllCategories: requirements.requiredAllCategories,
          requiredAnyCategoryGroups: requirements.requiredAnyCategoryGroups,
          evidenceSummary: "at least 40 characters of concrete domain-specific evidence",
          ...(moduleId === "causal_map"
            ? {
                causalLinks:
                  "include a mechanism marker or arrow, plus supported upstream drivers and downstream asset impacts",
              }
            : {}),
        },
      ];
    }),
  );
  const evidenceCategoriesSchema = (moduleId: FinanceBrainModuleId) => {
    const requirements =
      FINANCE_DOMAIN_EVIDENCE_CATEGORY_REQUIREMENTS[moduleId as FinanceFrameworkCoreDomain];
    const containsCategory = (category: string) => ({
      contains: { const: category },
      minContains: 1,
    });
    return {
      type: "array",
      items: { type: "string", enum: [...FINANCE_EVIDENCE_CATEGORIES] },
      allOf: [
        ...requirements.requiredAllCategories.map(containsCategory),
        ...(requirements.requiredAnyCategoryGroups.length === 0
          ? []
          : [
              {
                anyOf: requirements.requiredAnyCategoryGroups.map((group) => ({
                  allOf: group.map(containsCategory),
                })),
              },
            ]),
      ],
    };
  };
  const properties: Record<string, Record<string, unknown> & { allOf?: readonly unknown[] }> = {
    ...Object.fromEntries(
      selectedModuleIds.map((moduleId) => [
        moduleId,
        {
          allOf: [
            { $ref: "#/$defs/producerInput" },
            {
              properties: {
                domain: { const: moduleId },
                evidenceCategories: evidenceCategoriesSchema(moduleId),
              },
            },
          ],
        },
      ]),
    ),
    ...(hasLearningModule(plan)
      ? {
          finance_learning_memory: {
            ...z.toJSONSchema(LearningApplicationInput),
            anyOf: [{ required: ["financialTask"] }, { required: ["priorTaskReceiptSource"] }],
            description:
              "Optional source-bound task or pinned previous task result only when supplied evidence identifies it. Do not invent paths, task IDs or hashes; omit this field to retain ordinary guidance. Original apply independently validates and evaluates it; no execution or promotion authority.",
          },
        }
      : {}),
  };
  return Object.freeze({
    outputPath: "artifact.supportingAnalysis.financeFrameworkProducerInputs",
    container: "object keyed by every selectedModuleId, never a flat producer object or an array",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: selectedModuleIds,
      properties,
      $defs: { producerInput: z.toJSONSchema(ProducerInput) },
    },
    selectedModuleIds,
    evidenceGateByModule: categoryRequirements,
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
  if (selected.length === 0 && params.value === undefined) {
    return Object.freeze({});
  }
  if (!params.value || typeof params.value !== "object" || Array.isArray(params.value)) {
    throw new Error("financeFrameworkProducerInputs must be an object");
  }
  const raw = params.value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (moduleId) =>
      !selected.includes(moduleId as FinanceBrainModuleId) &&
      !(moduleId === "finance_learning_memory" && hasLearningModule(params.plan)),
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
    try {
      validateFinanceDomainEvidenceGate({
        domain: moduleId as FinanceFrameworkCoreDomain,
        evidenceCategories: input.evidenceCategories,
        evidenceSummary: input.evidenceSummary,
        keyCausalChain: input.keyCausalChain,
        upstreamDrivers: input.upstreamDrivers,
        downstreamAssetImpacts: input.downstreamAssetImpacts,
      });
    } catch {
      throw new Error("finance producer input failed selected domain evidence gate");
    }
    parsed[moduleId] = Object.freeze({ ...input });
  }
  if (raw.finance_learning_memory !== undefined) {
    const learning = LearningApplicationInput.parse(raw.finance_learning_memory);
    if (learning.financialTask === undefined && learning.priorTaskReceiptSource === undefined) {
      throw new Error("learning input requires an explicit task or original task receipt");
    }
    if (learning.sourceArtifacts.some((id) => !params.evidenceIds.has(id))) {
      throw new Error("learning producer input cites unknown evidence");
    }
    parsed.finance_learning_memory = Object.freeze(learning);
  }
  return Object.freeze(parsed);
}
