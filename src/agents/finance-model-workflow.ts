import type { OpenClawConfig } from "../config/config.js";
import {
  LCX_FINANCE_MODEL_WORKFLOW_VERSION,
  LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS,
} from "../shared/lcx-ontology.js";
import {
  createConfiguredFinanceModelAdapter,
  createFinanceModelCallBudget,
} from "./configured-finance-model-adapter.js";
import { findUncitedFinanceInstruments } from "./finance-research-evidence.js";
import {
  type LogicalAgentModelAdapter,
  type LogicalAgentModelRouting,
  type LogicalAgentRoleModelPolicy,
} from "./logical-agent-model-router.js";
import type { LogicalAgentId } from "./logical-agent-pool.js";
import { parseStageOutput, type QualityHarnessModelRequest } from "./quality-harness-contract.js";

export type FinanceWorkflowSlotModels = Readonly<{
  fast: string;
  reasoning: string;
  review: string;
}>;

export type FinanceWorkflowReasoningPolicy = "provider_default" | "bounded_workflow";

function financeRoleExecutionContract(
  role: LogicalAgentId,
  timeoutMs?: number,
): Pick<LogicalAgentRoleModelPolicy, "timeoutMs" | "excludeModelsUsedBy" | "sameModelAsRole"> {
  const slot = LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS[role].slot;
  const excludeModelsUsedBy: readonly LogicalAgentId[] =
    role === "adversarial_challenge"
      ? ["research_draft"]
      : role === "final_precheck"
        ? ["research_draft", "formatting"]
        : [];
  return {
    timeoutMs:
      timeoutMs ??
      (slot === "reasoning" || slot === "review" || role === "formatting" ? 180_000 : 90_000),
    ...(excludeModelsUsedBy.length ? { excludeModelsUsedBy } : {}),
    ...(role === "formatting" ? { sameModelAsRole: "research_draft" as const } : {}),
  };
}

/** Configuration order supplies candidates, not a claim of measured model quality. */
export function inspectFinanceModelWorkflow(
  cfg: OpenClawConfig,
  options: {
    reasoningPolicy?: FinanceWorkflowReasoningPolicy;
    timeoutMs?: number;
    slotModels?: FinanceWorkflowSlotModels;
  } = {},
) {
  const selection = cfg.agents?.defaults?.model;
  const primary =
    options.slotModels?.fast ?? (typeof selection === "string" ? selection : selection?.primary);
  if (!primary) {
    throw new Error("finance workflow requires a configured primary model");
  }
  const models = [
    ...new Set(
      options.slotModels
        ? Object.values(options.slotModels)
        : [primary, ...(typeof selection === "object" ? (selection.fallbacks ?? []) : [])],
    ),
  ];
  const reasoning =
    options.slotModels?.reasoning ?? models.find((model) => model !== primary) ?? primary;
  const review =
    options.slotModels?.review ??
    models.find((model) => model.split("/")[0] !== reasoning.split("/")[0]) ??
    models.find((model) => model !== reasoning) ??
    reasoning;
  const slots = { deterministic: "deterministic-intake", fast: primary, reasoning, review };
  return {
    revision: LCX_FINANCE_MODEL_WORKFLOW_VERSION,
    reasoningPolicy: options.reasoningPolicy ?? "bounded_workflow",
    selectionBasis: "configured_order_candidates_not_quality_qualification",
    models,
    distinctDraftAndReviewModels: reasoning !== review,
    roles: Object.fromEntries(
      Object.entries(LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS).map(([role, contract]) => [
        role,
        {
          ...contract,
          model: slots[contract.slot],
          ...financeRoleExecutionContract(role as LogicalAgentId, options.timeoutMs),
        },
      ]),
    ),
    slots,
  };
}

export function validateFinanceWorkflowOutput(
  role: LogicalAgentId,
  output: unknown,
  input: unknown,
): boolean {
  const contract = LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS[role];
  const request = input as QualityHarnessModelRequest | undefined;
  if (
    !request ||
    request.agentId !== role ||
    request.stage !== contract.stage ||
    !Array.isArray(request.evidence)
  ) {
    return false;
  }
  try {
    const parsed = parseStageOutput(contract.stage, output);
    if (parsed.kind !== contract.output) {
      return false;
    }
    if (parsed.kind === "plan") {
      return parsed.requirements.length > 0;
    }
    if (parsed.kind === "review") {
      if (role === "final_precheck" && request.findingPacket?.findings.length) {
        const packet = request.findingPacket;
        const closure = parsed.review.findingClosure;
        const ids = new Set(packet.findings.map((finding) => finding.id));
        if (
          !closure ||
          closure.artifactSha256 !== packet.artifactSha256 ||
          closure.evidenceSha256 !== packet.evidenceSha256 ||
          closure.resolutions.length !== ids.size ||
          new Set(closure.resolutions.map((entry) => entry.findingId)).size !== ids.size ||
          closure.resolutions.some((entry) => !ids.has(entry.findingId))
        ) {
          return false;
        }
      }
      return (
        parsed.review.notes.length > 0 &&
        (parsed.review.verdict !== "pass" ||
          (parsed.review.criticalFindings.length === 0 && parsed.review.evidenceGaps.length === 0))
      );
    }
    const ids = new Set(request.evidence.map((item) => item.id));
    return (
      parsed.artifact.claims.every((claim) => claim.evidenceIds.every((id) => ids.has(id))) &&
      findUncitedFinanceInstruments(request.evidence, parsed.artifact.claims).length === 0
    );
  } catch {
    return false;
  }
}

export function createFinanceModelWorkflow(
  cfg: OpenClawConfig,
  options: {
    maxCalls?: number;
    maxTokens?: number;
    timeoutMs?: number;
    reasoningPolicy?: FinanceWorkflowReasoningPolicy;
    slotModels?: FinanceWorkflowSlotModels;
    adapterFactory?: typeof createConfiguredFinanceModelAdapter;
  } = {},
) {
  const manifest = inspectFinanceModelWorkflow(cfg, options);
  const callBudget = createFinanceModelCallBudget(options.maxCalls ?? 48);
  const factory = options.adapterFactory ?? createConfiguredFinanceModelAdapter;
  const cloud = manifest.models.map((modelRef) =>
    factory(cfg, {
      modelRef,
      callBudget,
      maxCalls: options.maxCalls ?? 48,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs ?? 180_000,
      ...(manifest.reasoningPolicy === "bounded_workflow"
        ? {
            reasoningEffortByRole: {
              financial_extraction: "low",
              news_classification: "low",
              research_draft: "low",
              formatting: "low",
              final_precheck: "low",
            } as const,
          }
        : {}),
    }),
  );
  const byRef = new Map(manifest.models.map((ref, index) => [ref, cloud[index]]));
  const intake: LogicalAgentModelAdapter = {
    id: "finance-deterministic-intake",
    provider: "lcx",
    modelId: "deterministic-intake-v1",
    mode: "deterministic",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    roleScope: ["data_cleaning"],
    invoke: async ({ payload }) => {
      const request = payload as QualityHarnessModelRequest;
      return {
        kind: "plan",
        requirements: [
          request.task,
          "Audit supplied evidence and restrict conclusions to supported scope; no source sufficiency claim is made by intake.",
        ],
        missingEvidence: request.evidence.length
          ? [
              "Evidence sufficiency pending role review; limitations may restrict the answer rather than require new data.",
            ]
          : ["No supplied evidence"],
      };
    },
  };
  const roles = Object.fromEntries(
    Object.entries(LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS).map(([name, contract]) => {
      const role = name as LogicalAgentId;
      const primary =
        contract.slot === "deterministic" ? intake : byRef.get(manifest.slots[contract.slot])!;
      const fallback =
        contract.slot === "deterministic"
          ? []
          : cloud
              .filter((adapter) => adapter.id !== primary.id)
              .slice(0, contract.slot === "review" ? 2 : 1);
      const policy: LogicalAgentRoleModelPolicy = {
        primary: primary.id,
        fallback: fallback.map((adapter) => adapter.id),
        ...financeRoleExecutionContract(role, options.timeoutMs),
        requiredCapabilities: ["quality_harness"],
        maxInputBytes: 256_000,
        workload: contract.slot,
        outputContract: {
          revision: `${manifest.revision}:${role}`,
          validate: (output, input) => validateFinanceWorkflowOutput(role, output, input),
        },
      };
      return [role, policy];
    }),
  ) as Record<LogicalAgentId, LogicalAgentRoleModelPolicy>;
  const routing: LogicalAgentModelRouting = {
    revision: manifest.revision,
    adapters: [intake, ...cloud],
    defaultPolicy: roles.final_precheck,
    roles,
  };
  return {
    manifest: {
      ...manifest,
      credentialResolution: "read_only_at_invocation",
      reviewSeparation: "one_actual_author_and_separate_review_models",
    },
    routing,
    callBudget,
  };
}
