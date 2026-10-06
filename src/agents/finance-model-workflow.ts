import type { OpenClawConfig } from "../config/config.js";
import {
  LCX_FINANCE_MODEL_WORKFLOW_VERSION,
  LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS,
} from "../shared/lcx-ontology.js";
import {
  createConfiguredFinanceModelAdapter,
  createFinanceModelCallBudget,
} from "./configured-finance-model-adapter.js";
import type { FinanceBrainOrchestrationPlan } from "./finance-brain-orchestration.js";
import {
  describeFinanceProducerInputError,
  parseFinanceDomainProducerInputs,
} from "./finance-module-producer-input.js";
import { findUncitedFinanceInstruments } from "./finance-research-evidence.js";
import { qualityHarnessAllowedEvidenceIds } from "./local-text-model-adapter.js";
import {
  ModelAdapterError,
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
  const defaultTimeoutMs =
    slot === "reasoning" || slot === "review" || role === "formatting" ? 180_000 : 90_000;
  const configuredTimeoutMs = timeoutMs ?? defaultTimeoutMs;
  const excludeModelsUsedBy: readonly LogicalAgentId[] =
    role === "adversarial_challenge"
      ? ["research_draft"]
      : role === "final_precheck"
        ? ["research_draft", "formatting"]
        : [];
  return {
    // Preserve the review role's existing 180-second budget when a caller supplies
    // a shorter shared timeout for the faster workflow roles.
    timeoutMs:
      role === "adversarial_challenge" || role === "final_precheck"
        ? Math.max(configuredTimeoutMs, 180_000)
        : configuredTimeoutMs,
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
    revision: `${LCX_FINANCE_MODEL_WORKFLOW_VERSION}:bounded-recovery-v7`,
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

function checkProducerArtifact(
  role: LogicalAgentId,
  artifact: { supportingAnalysis?: Record<string, unknown> },
  request: QualityHarnessModelRequest,
) {
  if (role !== "research_draft") {
    return;
  }
  const constraints = request.sharedContext?.userConstraints as
    | {
        financeFrameworkProducerContract?: unknown;
        financeOrchestration?: FinanceBrainOrchestrationPlan;
      }
    | undefined;
  if (!constraints?.financeFrameworkProducerContract) {
    return;
  }
  if (!constraints.financeOrchestration) {
    throw new Error("producer plan missing");
  }
  parseFinanceDomainProducerInputs({
    value: artifact.supportingAnalysis?.financeFrameworkProducerInputs,
    plan: constraints.financeOrchestration,
    evidenceIds: new Set(request.evidence.map((item) => item.id)),
  });
}

function evidenceBatchReviewScopeProblem(
  request: QualityHarnessModelRequest,
  review: {
    notes: readonly string[];
    criticalFindings: readonly string[];
    evidenceGaps: readonly string[];
  },
): "out_of_scope" | "incomplete" | undefined {
  const scopedIds = new Set(request.evidence.map((entry) => entry.id));
  const mentionedIds = [
    ...review.notes,
    ...review.criticalFindings,
    ...review.evidenceGaps,
  ].flatMap((note) => [...note.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]));
  const notedIds = review.notes.flatMap((note) =>
    [...note.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]),
  );
  const counts = new Map<string, number>();
  for (const id of notedIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const allReviewText = [...review.notes, ...review.criticalFindings, ...review.evidenceGaps];
  const globalIds = request.evidenceCoverage?.selectedEvidenceIds ?? [];
  const mentionsOutsidePacket = globalIds.some((id) => {
    if (scopedIds.has(id)) {
      return false;
    }
    return allReviewText.some((text) => {
      let offset = 0;
      while (offset < text.length) {
        const index = text.indexOf(id, offset);
        if (index < 0) {
          return false;
        }
        const before = text[index - 1];
        const after = text[index + id.length];
        const beforeIsIdChar = before !== undefined && /[\p{L}\p{N}_.:-]/u.test(before);
        const afterIsIdChar = after !== undefined && /[\p{L}\p{N}_.:-]/u.test(after);
        if (!beforeIsIdChar && !afterIsIdChar) {
          return true;
        }
        offset = index + 1;
      }
      return false;
    });
  });
  if (mentionedIds.some((id) => !scopedIds.has(id)) || mentionsOutsidePacket) {
    return "out_of_scope";
  }
  return [...scopedIds].some((id) => counts.get(id) !== 1) ? "incomplete" : undefined;
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
    (request.stage !== contract.stage &&
      !(
        role === "evidence_integrity" &&
        request.stage === "extraction" &&
        request.evidenceBatchMode === "context_extraction"
      )) ||
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
      if (role === "evidence_integrity" && request.evidenceBatchMode === "final_artifact_audit") {
        if (evidenceBatchReviewScopeProblem(request, parsed.review)) {
          return false;
        }
      }
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
    checkProducerArtifact(role, parsed.artifact, request);
    const constraints = request.sharedContext?.userConstraints as
      | Record<string, unknown>
      | undefined;
    const preparationOnly =
      role === "research_draft" &&
      constraints?.financeProducerPreparationOnly === true &&
      Boolean(constraints.financeFrameworkProducerContract && constraints.financeOrchestration);
    const ids = new Set(qualityHarnessAllowedEvidenceIds(request));
    return (
      parsed.artifact.claims.every((claim) => claim.evidenceIds.every((id) => ids.has(id))) &&
      (preparationOnly ||
        findUncitedFinanceInstruments(request.evidence, parsed.artifact.claims).length === 0)
    );
  } catch {
    return false;
  }
}

function contractRepairFeedback(
  role: LogicalAgentId,
  output: unknown,
  request: QualityHarnessModelRequest,
): string {
  try {
    const parsed = parseStageOutput(LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS[role].stage, output);
    if (parsed.kind === "review") {
      if (role === "evidence_integrity" && request.evidenceBatchMode === "final_artifact_audit") {
        const scopeProblem = evidenceBatchReviewScopeProblem(request, parsed.review);
        if (scopeProblem === "out_of_scope") {
          return "Previous attempt rejected: final artifact audit notes referenced IDs outside this packet. Return exactly one note for every supplied evidence ID and no other bracketed IDs.";
        }
        if (scopeProblem === "incomplete") {
          return "Previous attempt rejected: final artifact audit must return exactly one note for each supplied evidence ID. Do not add IDs from another packet.";
        }
      }
      if (role === "final_precheck" && request.findingPacket?.findings.length) {
        const packet = request.findingPacket;
        const closure = parsed.review.findingClosure;
        if (!closure) {
          return "Previous attempt rejected: review.findingClosure is missing. Copy both hashes from finding_packet and supply one resolution for EVERY findingId. Mark unresolved when unsure; do not omit the closure on revise/fail.";
        }
        if (
          closure.artifactSha256 !== packet.artifactSha256 ||
          closure.evidenceSha256 !== packet.evidenceSha256
        ) {
          return "Previous attempt rejected: findingClosure hashes do not match finding_packet. Copy artifactSha256 and evidenceSha256 exactly; never compute or invent hashes.";
        }
        const expected = new Set(packet.findings.map((finding) => finding.id));
        const actual = closure.resolutions.map((entry) => entry.findingId);
        if (
          actual.length !== expected.size ||
          new Set(actual).size !== expected.size ||
          actual.some((id) => !expected.has(id))
        ) {
          return "Previous attempt rejected: findingClosure must cover every finding_packet findingId exactly once, without missing, duplicate or invented IDs. Retain unresolved findings explicitly.";
        }
      }
      if (parsed.review.notes.length === 0) {
        return "Previous attempt rejected: review.notes must contain a substantive review note.";
      }
      if (
        parsed.review.verdict === "pass" &&
        (parsed.review.criticalFindings.length || parsed.review.evidenceGaps.length)
      ) {
        return "Previous attempt rejected: verdict=pass contradicts nonempty criticalFindings or evidenceGaps. Retain real findings and use revise or fail.";
      }
    }
    if (parsed.kind === "artifact") {
      try {
        checkProducerArtifact(role, parsed.artifact, request);
      } catch (error) {
        return `Previous attempt rejected: ${describeFinanceProducerInputError(error)}. Follow producer_input_contract.jsonSchema types and required fields; retain missing evidence.`;
      }
      const ids = new Set(qualityHarnessAllowedEvidenceIds(request));
      if (parsed.artifact.claims.some((claim) => claim.evidenceIds.some((id) => !ids.has(id)))) {
        return "Previous attempt rejected: a claim cited a nonexistent evidence ID. Use only allowed_evidence_ids; retain uncertainty rather than invent support.";
      }
      if (findUncitedFinanceInstruments(request.evidence, parsed.artifact.claims).length) {
        const indexes = parsed.artifact.claims
          .flatMap((claim, index) =>
            findUncitedFinanceInstruments(request.evidence, [claim]).length ? [index] : [],
          )
          .slice(0, 8);
        return `Previous attempt rejected: claims at zero-based indexes ${JSON.stringify(indexes)} lack instrument-bound citations. Follow instrument_citation_scope; narrow the claim or use uncertain with uncertainty when support is absent. Never add unrelated citations to pass.`;
      }
    }
    return "Previous attempt rejected by the role contract. Provide required fields, nonempty review notes, consistent verdict/findings, and complete findingClosure when supplied. Do not change evidence or hide unresolved findings.";
  } catch (error) {
    // Parser errors may interpolate model-authored IDs. Emit fixed reasons instead
    // of promoting those strings into the next model's repair instructions.
    const message = error instanceof Error ? error.message : "";
    const reason = message.includes("must explain uncertainty")
      ? "uncertain claims require a nonempty uncertainty explanation"
      : message.includes("must cite evidence")
        ? "supported claims require supplied evidence IDs"
        : message.includes("duplicate artifact claim id")
          ? "claim IDs must be unique"
          : message.includes("epistemicClass")
            ? "epistemicClass must use the declared enum"
            : message.includes("evidenceRelations")
              ? "evidenceRelations must classify each cited ID exactly once"
              : "stage structure, required fields or field types are invalid";
    return `Previous attempt rejected by JSON schema: ${reason}. Follow the field contract; preserve missing evidence.`;
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
  // Carry a bounded validator hint to the existing fallback, not a new retry loop.
  // Keys keep roles, tasks and runs isolated; the original evidence packet is unchanged.
  const rejected = new Map<string, string>();
  const adapterTimeoutMs = Math.max(options.timeoutMs ?? 180_000, 180_000);
  const cloud = manifest.models.map((modelRef) => {
    const adapter = factory(cfg, {
      modelRef,
      callBudget,
      maxCalls: options.maxCalls ?? 48,
      maxTokens: options.maxTokens,
      timeoutMs: adapterTimeoutMs,
      ...(manifest.reasoningPolicy === "bounded_workflow"
        ? {
            reasoningEffortByRole: {
              financial_extraction: "low",
              evidence_integrity: "low",
              news_classification: "low",
              research_draft: "low",
              formatting: "low",
              final_precheck: "low",
            } as const,
          }
        : {}),
    });
    // A workflow instance is one bounded research run, shared by preparation and
    // review. Do not repeatedly spend that run's calls on a rate-limited credential.
    let unavailable:
      | "provider_rate_limit"
      | "provider_auth"
      | "provider_payment_required"
      | undefined;
    return {
      ...adapter,
      unavailableReason: () => unavailable ?? adapter.unavailableReason?.(),
      invoke: async (call, signal) => {
        const key = JSON.stringify([call.correlationId, call.taskId, call.role]);
        const prior = rejected.get(key);
        const original = call.payload as QualityHarnessModelRequest;
        const payload = prior
          ? { ...original, repairFeedback: [prior, ...(original.repairFeedback ?? []).slice(0, 7)] }
          : original;
        let output: unknown;
        try {
          output = await adapter.invoke({ ...call, payload }, signal);
        } catch (error) {
          if (
            error instanceof ModelAdapterError &&
            (error.code === "provider_rate_limit" ||
              error.code === "provider_auth" ||
              error.code === "provider_payment_required")
          ) {
            unavailable = error.code;
          }
          if (
            call.role === "formatting" &&
            error instanceof ModelAdapterError &&
            (error.code === "output_truncated" || error.code === "output_invalid")
          ) {
            rejected.set(
              key,
              error.code === "output_invalid"
                ? "Previous formatting response could not be parsed as valid JSON. Return a complete valid JSON object matching the existing schema; preserve all evidence IDs, claims, uncertainty, and required fields. Add no text outside JSON."
                : "Previous formatting response was truncated. Return a smaller complete JSON object matching the existing schema; preserve all evidence IDs, claims, uncertainty, and required fields. Add no text outside JSON.",
            );
          }
          if (
            call.role === "evidence_integrity" &&
            original.evidenceBatchMode === "final_artifact_audit" &&
            error instanceof ModelAdapterError &&
            error.code === "output_truncated"
          ) {
            rejected.set(
              key,
              "Previous batch audit was truncated. Return concise JSON with exactly one note for every evidence ID in this packet and no IDs from another batch. Preserve genuine critical findings and evidence gaps; never pass by omission.",
            );
          }
          if (
            call.role === "adversarial_challenge" &&
            error instanceof ModelAdapterError &&
            error.code === "output_truncated"
          ) {
            rejected.set(
              key,
              "Previous adversarial review response was truncated. Re-review the supplied artifact and evidence, then return concise complete JSON. Preserve every actionable critical finding, evidence gap, and unresolved uncertainty; do not omit issues or change a revise/reject judgment merely to shorten the response.",
            );
          }
          if (
            call.role === "final_precheck" &&
            error instanceof ModelAdapterError &&
            error.code === "output_truncated"
          ) {
            rejected.set(
              key,
              "Previous final review was truncated. Re-review the supplied artifact and evidence, then return concise complete JSON without reproducing them. Preserve every actionable critical finding, evidence gap, and required version-bound findingClosure resolution. Never pass by omission or change the judgment merely to shorten the response.",
            );
          }
          throw error;
        }
        if (validateFinanceWorkflowOutput(call.role, output, payload)) {
          rejected.delete(key);
        } else {
          rejected.set(key, contractRepairFeedback(call.role, output, payload));
        }
        return output;
      },
    } satisfies LogicalAgentModelAdapter;
  });
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
          // 500 Unicode code points fit the 1,000 UTF-16-unit requirement limit.
          ...(request.task.match(/[\s\S]{1,500}/gu) ?? []).filter((part) => part.trim()),
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
        ...(["research_draft", "formatting", "final_precheck", "evidence_integrity"].includes(role)
          ? { retryOutputContractOnce: true }
          : {}),
        ...(["evidence_integrity", "adversarial_challenge", "final_precheck"].includes(role)
          ? { retryTruncatedOutputOnce: true }
          : {}),
        ...(role === "formatting" ? { retryAffinityTruncationOnce: true } : {}),
        outputContract: {
          revision: `${manifest.revision}:${role}`,
          validate: (output, input) => validateFinanceWorkflowOutput(role, output, input),
          describeFailure: (output, input) =>
            contractRepairFeedback(role, output, input as QualityHarnessModelRequest),
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
