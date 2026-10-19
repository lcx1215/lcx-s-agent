import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  runQualityHarness,
  type QualityHarnessOptions,
  type QualityHarnessReceipt,
} from "../../src/agents/quality-harness.ts";
import { readFileWithinRoot } from "../../src/infra/fs-safe.ts";
import { LCX_USER_HOME } from "./lcx-local-paths.ts";

const CODEX_SKILLS_ROOT = path.join(LCX_USER_HOME, ".codex", "skills");
const skillEntrypoint = (name: string): string => path.join(CODEX_SKILLS_ROOT, name, "SKILL.md");

const localReference = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const localScope = z.object({ accountId: z.string().min(1), runId: z.string().min(1) });
const localIntakeManifest = z.object({
  schemaVersion: z.literal("lcx_external_local_intake_v1"),
  candidateId: z.string().min(1),
  source: localReference.extend({ version: z.string().min(1) }),
  license: localReference,
  scope: localScope.optional(),
});
type LocalIntakeStage = {
  nodeId: "external_agent_source" | "source_registry" | "license_scope_review";
  scope: z.infer<typeof localScope>;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: "read" | "registered" | "blocked" | "failed" | "timed_out";
  reason?: string;
  filter?: "license_scope_required" | "untrusted_source_isolation";
};
export type ExternalAgentLocalIntakeReceipt = {
  schemaVersion: "lcx_external_local_intake_v1";
  checkedAt: string;
  scope: z.infer<typeof localScope>;
  upstreamScope: "not_observed";
  manifest: z.infer<typeof localReference>;
  status: "blocked" | "failed";
  stages: LocalIntakeStage[];
  downstreamStarted: false;
  runtimeAuthority: "not_granted";
  gaps: string[];
  cleanup: "not_started" | "local_listener_released_read_cleanup_unconfirmed";
};

/** Explicit read-only intake at the original owner. No installation, model, or source-trust authority. */
export async function readExternalAgentLocalIntake(options: {
  workspaceDir: string;
  manifest: z.infer<typeof localReference>;
  scope: z.infer<typeof localScope>;
  signal?: AbortSignal;
  timeoutMs?: number;
  readFile?: typeof readFileWithinRoot;
}): Promise<ExternalAgentLocalIntakeReceipt> {
  const result: ExternalAgentLocalIntakeReceipt = {
    schemaVersion: "lcx_external_local_intake_v1",
    checkedAt: new Date().toISOString(),
    scope: options.scope,
    upstreamScope: "not_observed",
    manifest: options.manifest,
    status: "failed",
    stages: [],
    downstreamStarted: false,
    runtimeAuthority: "not_granted",
    gaps: [],
    cleanup: "not_started",
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("external_local_intake_cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) {
    cancel();
  }
  const timeoutMs = Math.min(120_000, Math.max(1, options.timeoutMs ?? 120_000));
  const deadlineAt = performance.now() + timeoutMs;
  const timer = setTimeout(
    () => controller.abort(new Error("external_local_intake_deadline")),
    timeoutMs,
  );
  const active = () => {
    if (performance.now() >= deadlineAt && !controller.signal.aborted) {
      controller.abort(new Error("external_local_intake_deadline"));
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
  };
  const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  const read = async (ref: z.infer<typeof localReference>, role: string, maxBytes = 512 * 1024) => {
    active();
    let listener: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        listener = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", listener, { once: true });
      });
      result.cleanup = "local_listener_released_read_cleanup_unconfirmed";
      const { buffer } = await Promise.race([
        (options.readFile ?? readFileWithinRoot)({
          rootDir: options.workspaceDir,
          relativePath: ref.path,
          maxBytes,
          rejectHardlinks: true,
        }),
        aborted,
      ]);
      active();
      if (hash(buffer) !== ref.sha256) {
        throw new Error(`hash_mismatch:${role}:${ref.path}`);
      }
      if (!buffer.toString("utf8").trim()) {
        throw new Error(`empty_body:${role}:${ref.path}`);
      }
      return buffer.toString("utf8");
    } catch (error) {
      throw new Error(
        `external_local_intake_read_failed:${role}:${ref.path}:${error instanceof Error ? error.message : "unknown"}`,
        { cause: error },
      );
    } finally {
      if (listener) {
        controller.signal.removeEventListener("abort", listener);
      }
    }
  };
  let current: LocalIntakeStage = {
    nodeId: "external_agent_source",
    scope: options.scope,
    status: "failed",
  };
  result.stages.push(current);
  try {
    active();
    const scope = localScope.parse(options.scope);
    const manifestRef = localReference.parse(options.manifest);
    const manifest = localIntakeManifest.parse(
      JSON.parse(await read(manifestRef, "manifest", 64 * 1024)),
    );
    if (
      manifest.scope &&
      (manifest.scope.accountId !== scope.accountId || manifest.scope.runId !== scope.runId)
    ) {
      throw new Error("external_local_intake_host_scope_mismatch");
    }
    const candidate = CANDIDATES.find((item) => item.id === manifest.candidateId);
    if (!candidate) {
      throw new Error("external_local_intake_candidate_not_registered");
    }
    const sourceText = await read(manifest.source, "source");
    active();
    const sourceOutput = {
      candidateId: candidate.id,
      source: manifest.source,
      license: manifest.license,
      text: sourceText,
      sourceVersion: manifest.source.version,
      sourceVersionVerification: "caller_declared_only",
      sourceTrust: "not_proven",
      manifestSha256: manifestRef.sha256,
    };
    current.status = "read";
    current.output = sourceOutput;

    // Consumer re-reads actual bytes, rather than accepting a source registration assertion.
    current = {
      nodeId: "source_registry",
      scope,
      status: "failed",
      input: structuredClone(sourceOutput),
    };
    result.stages.push(current);
    const registeredText = await read(manifest.source, "registry_source");
    if (registeredText !== sourceText) {
      throw new Error("external_local_intake_source_changed_at_registry");
    }
    active();
    const registryOutput = {
      candidateId: candidate.id,
      source: manifest.source,
      license: manifest.license,
      text: registeredText,
      readingScope: "full_selected_local_body",
      sourceTrust: "not_proven",
      upstreamScope: "not_observed",
      runtimeAuthority: "not_granted",
    };
    current.status = "registered";
    current.output = registryOutput;

    current = {
      nodeId: "license_scope_review",
      scope,
      status: "failed",
      input: structuredClone(registryOutput),
    };
    result.stages.push(current);
    const licenseText = await read(manifest.license, "license", 128 * 1024);
    await read(manifest.source, "license_source_readback");
    await read(manifestRef, "manifest_readback", 64 * 1024);
    active();
    current.output = {
      license: manifest.license,
      licenseText,
      permission: "not_verified",
      reason:
        "License body is read, but no original permission/security/signoff evidence authorizes installation or distillation.",
    };
    current.status = "blocked";
    current.reason = "license_permission_not_verified";
    current.filter = "license_scope_required";
    result.status = "blocked";
    result.gaps = [
      "license_permission_not_verified",
      "source_trust_not_proven",
      "upstream_scope_not_observed",
    ];
    // Original permission checkpoint stops this attempt here; no downstream candidate, train or model call.
  } catch (error) {
    current.status =
      controller.signal.aborted && String(controller.signal.reason).includes("deadline")
        ? "timed_out"
        : "failed";
    current.reason = error instanceof Error ? error.message : "external_local_intake_failed";
    current.filter =
      current.nodeId === "license_scope_review"
        ? "license_scope_required"
        : "untrusted_source_isolation";
    result.status = "failed";
    result.gaps = [current.reason];
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
  return result;
}

// Consume one explicit binary-contract quote; unknown costs are never filled with zero.
function reviewPredictionMarketCosts(packet: Record<string, unknown>) {
  const schema = z
    .object({
      unit: z.literal("USD_per_contract_payoff_1"),
      observedAt: z.string().datetime({ offset: true }),
      maxAgeMs: z.number().finite().positive(),
      bid: z.number().finite().min(0).max(1),
      ask: z.number().finite().min(0).max(1),
      availableQuantity: z.number().finite().nonnegative(),
      requestedQuantity: z.number().finite().positive(),
      feePerContract: z.number().finite().nonnegative(),
      slippagePerContract: z.number().finite().nonnegative(),
    })
    .strict();
  const parsed = schema.safeParse(packet.marketMicrostructure);
  if (!parsed.success) {
    return {
      status: "blocked" as const,
      gaps: parsed.error.issues.map(
        (issue) => `prediction_cost_input_invalid:/marketMicrostructure/${issue.path.join("/")}`,
      ),
      measurements: null,
      nextAction: "supply_exact_quote_units_costs_and_capacity",
    };
  }
  const quote = parsed.data;
  const ageMs = Date.now() - Date.parse(quote.observedAt);
  const gaps: string[] = [];
  if (ageMs < 0 || ageMs > quote.maxAgeMs) {
    gaps.push("prediction_quote_outside_declared_age");
  }
  if (quote.bid > quote.ask) {
    gaps.push("prediction_crossed_quote");
  }
  if (quote.availableQuantity < quote.requestedQuantity) {
    gaps.push("prediction_insufficient_declared_capacity");
  }
  const cashPerContract = quote.ask + quote.feePerContract + quote.slippagePerContract;
  const declaredOrderCash = cashPerContract * quote.requestedQuantity;
  if (!Number.isFinite(cashPerContract) || !Number.isFinite(declaredOrderCash)) {
    return {
      status: "blocked" as const,
      gaps: [...gaps, "prediction_cost_arithmetic_overflow"],
      measurements: null,
      nextAction: "supply_finite_cost_and_quantity_values",
    };
  }
  if (cashPerContract >= 1) {
    gaps.push("prediction_costs_erase_maximum_binary_payoff");
  }
  return {
    status: gaps.length ? ("blocked" as const) : ("needs_review" as const),
    gaps,
    measurements: {
      unit: quote.unit,
      observedAt: quote.observedAt,
      ageMs,
      spread: quote.ask - quote.bid,
      cashPerContract,
      declaredOrderCash,
      breakEvenWinProbability: cashPerContract,
      maximumPayoffMargin: 1 - cashPerContract,
      availableQuantity: quote.availableQuantity,
      requestedQuantity: quote.requestedQuantity,
    },
    nextAction: gaps.length
      ? "revise_cost_or_capacity_assumptions_before_experiment"
      : "obtain_independent_resolution_and_sample_out_evidence",
  };
}

type PredictionStage = {
  nodeId:
    | "prediction_market_source"
    | "source_registry"
    | "actual_reading_scope"
    | "resolution_criteria_review"
    | "market_microstructure_review"
    | "control_room_summary";
  scope: z.infer<typeof localScope>;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: "read" | "registered" | "blocked" | "needs_review" | "failed" | "timed_out";
  reason?: string;
  filter?: "source_evidence_gate" | "ambiguous_resolution_blocks_conclusion";
};
export type PredictionMarketIntakeReceipt = {
  schemaVersion: "lcx_prediction_market_intake_v1";
  scope: z.infer<typeof localScope>;
  source: z.infer<typeof localReference> & { version: string };
  status: "blocked" | "needs_review" | "failed";
  stages: PredictionStage[];
  sourceSummaryAllowed: boolean;
  marketCostReview?: ReturnType<typeof reviewPredictionMarketCosts>;
  directionalConclusionAllowed: false;
  runtimeAuthority: "not_granted";
  downstreamStarted: false;
  gaps: string[];
  cleanup:
    | "not_started"
    | "local_listener_released_read_cleanup_unconfirmed"
    | "local_listener_released_model_cleanup_unconfirmed";
};

/** Explicit original-owner source intake. Reading and field presence never approve resolution semantics. */
export async function readPredictionMarketResearchIntake(options: {
  workspaceDir: string;
  source: z.infer<typeof localReference> & { version: string };
  scope: z.infer<typeof localScope>;
  signal?: AbortSignal;
  timeoutMs?: number;
  readFile?: typeof readFileWithinRoot;
  qualityOptions?: Omit<QualityHarnessOptions, "request" | "allowProviderCalls" | "signal">;
}): Promise<PredictionMarketIntakeReceipt> {
  const hostScope = { ...options.scope };
  const sourceReference = { ...options.source };
  const result: PredictionMarketIntakeReceipt = {
    schemaVersion: "lcx_prediction_market_intake_v1",
    scope: hostScope,
    source: sourceReference,
    status: "failed",
    stages: [],
    sourceSummaryAllowed: false,
    directionalConclusionAllowed: false,
    runtimeAuthority: "not_granted",
    downstreamStarted: false,
    gaps: [],
    cleanup: "not_started",
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("prediction_intake_cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) {
    cancel();
  }
  const budget = Math.min(120_000, options.timeoutMs ?? 120_000);
  const deadline = performance.now() + (Number.isFinite(budget) && budget > 0 ? budget : 1);
  const timer = setTimeout(
    () => controller.abort(new Error("prediction_intake_deadline")),
    Math.max(1, deadline - performance.now()),
  );
  const active = () => {
    if (performance.now() >= deadline && !controller.signal.aborted) {
      controller.abort(new Error("prediction_intake_deadline"));
    }
    controller.signal.throwIfAborted();
  };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    active();
    let listener: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        listener = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", listener, { once: true });
      });
      const value = await Promise.race([operation(), cancelled]);
      active();
      return value;
    } finally {
      if (listener) {
        controller.signal.removeEventListener("abort", listener);
      }
    }
  };
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const read = async () => {
    if (result.cleanup !== "local_listener_released_model_cleanup_unconfirmed") {
      result.cleanup = "local_listener_released_read_cleanup_unconfirmed";
    }
    const { buffer } = await bounded(() =>
      (options.readFile ?? readFileWithinRoot)({
        rootDir: options.workspaceDir,
        relativePath: sourceReference.path,
        maxBytes: 512 * 1024,
        rejectHardlinks: true,
      }),
    );
    if (hash(buffer) !== sourceReference.sha256) {
      throw new Error("prediction_source_hash_conflict");
    }
    const text = buffer.toString("utf8");
    if (!text.trim()) {
      throw new Error("prediction_source_body_missing");
    }
    return text;
  };
  let current: PredictionStage = {
    nodeId: "prediction_market_source",
    scope: hostScope,
    status: "failed",
  };
  result.stages.push(current);
  try {
    active();
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error("prediction_intake_invalid_timeout");
    }
    const scope = localScope.parse(hostScope);
    const source = localReference.extend({ version: z.string().min(1) }).parse(sourceReference);
    const text = await read();
    const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    // A source may carry an attempted identity, but cannot override independent host scope.
    if (parsed.scope !== undefined) {
      const claimed = localScope.parse(parsed.scope);
      if (claimed.accountId !== scope.accountId || claimed.runId !== scope.runId) {
        throw new Error("prediction_source_host_scope_conflict");
      }
    }
    if (
      (parsed.accountId !== undefined && parsed.accountId !== scope.accountId) ||
      (parsed.runId !== undefined && parsed.runId !== scope.runId)
    ) {
      throw new Error("prediction_source_host_scope_conflict");
    }
    current.status = "read";
    current.output = {
      source,
      text,
      sourceTrust: "not_proven",
      sourceVersionVerification: "caller_declared_only",
      upstreamScope: "not_observed",
    };
    current = {
      nodeId: "source_registry",
      scope,
      status: "failed",
      input: structuredClone(current.output),
    };
    result.stages.push(current);
    const registered = await read();
    if (registered !== text) {
      throw new Error("prediction_source_changed_at_registry");
    }
    current.status = "registered";
    current.output = {
      source,
      text: registered,
      sourceTrust: "not_proven",
      upstreamScope: "not_observed",
    };
    current = {
      nodeId: "actual_reading_scope",
      scope,
      status: "read",
      input: structuredClone(current.output),
    };
    result.stages.push(current);
    current.output = {
      source,
      text: registered,
      readingScope: "full_selected_local_body",
      bytesRead: Buffer.byteLength(registered),
      packet: parsed,
      sourceTrust: "not_proven",
    };
    current = {
      nodeId: "resolution_criteria_review",
      scope,
      status: "blocked",
      input: structuredClone(current.output),
      filter: "ambiguous_resolution_blocks_conclusion",
    };
    result.stages.push(current);
    const required = [
      "marketId",
      "question",
      "sourceUrl",
      "observedAt",
      "resolutionCriteria",
      "resolutionSource",
      "closeDate",
      "timezone",
    ];
    const gaps = required
      .filter((field) => typeof parsed[field] !== "string" || !parsed[field].trim())
      .map((field) => `prediction_resolution_missing:/${field}`);
    for (const field of ["observedAt", "closeDate"]) {
      if (
        typeof parsed[field] === "string" &&
        parsed[field].trim() &&
        !Number.isFinite(Date.parse(parsed[field]))
      ) {
        gaps.push(`prediction_resolution_invalid_date:/${field}`);
      }
    }
    const inputFingerprint = hash(JSON.stringify({ scope, source, text: registered }));
    if (parsed.marketMicrostructure !== undefined) {
      active();
      result.marketCostReview = reviewPredictionMarketCosts(parsed);
      result.stages.push({
        nodeId: "market_microstructure_review",
        scope,
        status: result.marketCostReview.status,
        input: { source, field: "/marketMicrostructure", inputFingerprint },
        output: {
          ...result.marketCostReview,
          sourceTrust: "not_proven",
          executionAuthority: "none",
        },
      });
    }

    const output: Record<string, unknown> = {
      inputFingerprint,
      missingFields: gaps,
      semantics: "not_verified",
      sourceTrust: "not_proven",
      sourceSummaryMeaning:
        "May deliver a source description with these gaps; not quality approval or a directional conclusion.",
      nextEvidence: gaps.length
        ? gaps.map((gap) => gap.split(":").at(-1))
        : ["independent_resolution_interpretation_and_counterevidence"],
      suggestedNextTool: "read",
      sourcePath: source.path,
    };
    current.output = output;
    result.sourceSummaryAllowed = true;
    if (gaps.length) {
      current.reason = "prediction_resolution_required_evidence_missing";
      result.status = "blocked";
      result.gaps = [...gaps, "prediction_source_trust_not_proven"];
    } else {
      current.status = "needs_review";
      current.reason = "prediction_resolution_semantics_not_verified";
      result.status = "needs_review";
      result.gaps = [
        "prediction_resolution_semantics_not_verified",
        "prediction_source_trust_not_proven",
      ];
      if (options.qualityOptions?.modelInvoker || options.qualityOptions?.modelRouting) {
        const request = {
          task: `${result.marketCostReview ? "Review only the supplied prediction-market resolution criteria, ambiguity, contradicting evidence and supplied deterministic cost review. If costs or capacity block the experiment, retain that block and explain the needed correction." : "Review only the supplied prediction-market resolution criteria, ambiguity and contradicting evidence."} Never assert an outcome, forecast, profitability or execution authority. Input fingerprint=${inputFingerprint}; source SHA256=${source.sha256}; host attempt=${JSON.stringify(scope)}.`,
          evidence: [
            { id: `prediction-source:${source.sha256}`, text: registered, source: source.path },
          ],
          sharedContext: {
            scope,
            source,
            inputFingerprint,
            readingScope: "full_selected_local_body",
            sourceTrust: "not_proven",
            ...(result.marketCostReview ? { marketCostReview: result.marketCostReview } : {}),
          },
        };
        if (Buffer.byteLength(JSON.stringify(request)) > 12 * 1024) {
          result.gaps.push("prediction_resolution_quality_input_budget_exceeded");
          output.qualityGap = "prediction_resolution_quality_input_budget_exceeded";
        } else {
          result.cleanup = "local_listener_released_model_cleanup_unconfirmed";
          const quality: QualityHarnessReceipt = await bounded(() =>
            runQualityHarness({
              ...options.qualityOptions,
              request,
              allowProviderCalls: false,
              signal: controller.signal,
              maxAttempts: 1,
              taskTimeoutMs: Math.min(
                options.qualityOptions?.taskTimeoutMs ?? 30_000,
                Math.max(1, deadline - performance.now()),
              ),
            }),
          );
          await read();
          active();
          if (quality.task.sha256 !== hash(request.task)) {
            throw new Error("prediction_resolution_quality_input_conflict");
          }
          output.quality = quality;
          output.findings = quality.attempts.flatMap((attempt) => [
            ...(attempt.findings ?? []),
            ...attempt.feedback,
          ]);
          output.qualityTaskSha256 = hash(request.task);
          if (quality.status !== "verified") {
            current.status = "blocked";
            current.reason = `prediction_resolution_quality:${quality.status}`;
            result.status = "blocked";
            result.gaps.push(current.reason);
          }
          // Even a locally injected review is an observed attempt, never automatic domain approval.
        }
      } else {
        output.qualityGap = "prediction_resolution_review_not_requested";
      }
    }
    if (result.marketCostReview) {
      const costGaps = result.marketCostReview.gaps;
      result.gaps.push(...costGaps);
      if (costGaps.length) {
        result.status = "blocked";
      }
      result.stages.push({
        nodeId: "control_room_summary",
        scope,
        status: result.status,
        input: {
          source,
          inputFingerprint,
          costReview: result.marketCostReview,
          resolutionReview: output,
        },
        output: {
          marketId: parsed.marketId,
          source,
          marketCostReview: result.marketCostReview,
          unresolved: [...result.gaps],
          nextAction: result.marketCostReview.nextAction,
          sourceSummaryAllowed: result.sourceSummaryAllowed,
          directionalConclusionAllowed: false,
          runtimeAuthority: "not_granted",
        },
      });
    }
    active();
  } catch (error) {
    current.status =
      controller.signal.aborted && String(controller.signal.reason).includes("deadline")
        ? "timed_out"
        : "failed";
    current.reason = error instanceof Error ? error.message : "prediction_intake_failed";
    current.filter =
      current.nodeId === "resolution_criteria_review"
        ? "ambiguous_resolution_blocks_conclusion"
        : "source_evidence_gate";
    result.status = "failed";
    result.sourceSummaryAllowed = false;
    result.gaps = [current.reason];
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
  return result;
}

type CandidateId =
  | "skillopt_v2_autoskill_coach"
  | "agent_lightning_trace_credit"
  | "longmemeval_agentrunbook_memory_regression"
  | "local_first_memory_provenance"
  | "lightweight_memory_comparison"
  | "agent_trace_observability"
  | "secure_tool_skill_permission_layer"
  | "clawbench_real_task_regression"
  | "computer_use_cli_bridge"
  | "github_cli_agentic_workflow_control"
  | "multi_agent_framework_orchestration_guardrails"
  | "individual_ai_hedge_fund"
  | "trading_agents_finance_multi_agent"
  | "finrobot_financial_research"
  | "openbb_finance_data_platform"
  | "agent_reach_source_adapter"
  | "echoapi_api_test_harness"
  | "finnews_hunter_realtime_intelligence"
  | "openfr_finance_research"
  | "amplio_crash_resume_harness"
  | "cameron_personal_finance_approval"
  | "cents_thesis_research"
  | "openalice_full_lifecycle_trading"
  | "prediction_market_research_intake"
  | "prediction_market_strategy_audit";

type AdoptionMode =
  | "skill_lifecycle_probe"
  | "trace_export_probe"
  | "memory_regression_probe"
  | "memory_provenance_probe"
  | "memory_comparison_probe"
  | "agent_trace_probe"
  | "secure_tool_permission_probe"
  | "real_task_benchmark_probe"
  | "computer_use_cli_probe"
  | "github_cli_agentic_workflow_probe"
  | "multi_agent_orchestration_probe"
  | "finance_agent_architecture_probe"
  | "prediction_market_research_probe"
  | "strategy_audit_probe";

type ExternalUpgradeCandidate = {
  id: CandidateId;
  label: string;
  sourceUrls: string[];
  sourceKind: "paper" | "github" | "paper_and_github" | "docs_product_and_paper";
  claimedCapability: string;
  adoptionMode: AdoptionMode;
  existingOwner: string;
  ownerEntrypoint: string;
  ownerUseTrigger: string;
  autocueTerms: string[];
  distilledPattern: string;
  firstLocalProbe: string;
  requiredReceipts: string[];
  requiredFilters: string[];
  riskBoundaries: string[];
  liveBoundary: string;
};

type SourceReceiptKey = "freshness" | "version" | "license_scope" | "actual_reading_scope";

type SourceEvidenceContract = {
  registration: "static";
  status: "static_registration_only";
  receipts: Record<
    SourceReceiptKey,
    {
      status: "missing" | "verified";
      receiptId: string;
    }
  >;
};

type CandidateVerdict = ExternalUpgradeCandidate & {
  status: "static_owner_mapping_registered";
  runtimeAuthority: "not_granted";
  missing: string[];
  blockedDirectAdoption: boolean;
  sourceEvidence: SourceEvidenceContract;
};

type BlacktechMechanismId =
  | "skillopt_v2_lifecycle"
  | "real_runtime_battery"
  | "unified_trajectory_schema"
  | "local_first_memory_provenance"
  | "agent_trace_observability"
  | "secure_tool_skill_permission_layer"
  | "github_cli_agentic_control_plane"
  | "finance_research_truth_and_guardrails";

type BlacktechMechanism = {
  id: BlacktechMechanismId;
  priority: number;
  label: string;
  sourceCandidates: CandidateId[];
  ownerEntrypoint: string;
  automaticTrigger: string;
  ownerGate: string;
  autopilotSurface: string;
  doctrineTerms: string[];
  currentStatus: "owner_wired_local_only" | "partially_wired_local_only";
  nextSafeLocalProbe: string;
  nextAutomationAction: string;
  blockedUntilIdle?: string;
  requiredProofChain: string[];
  forbiddenAuthorities: string[];
  liveBoundary: string;
};

type BlacktechVerdict = BlacktechMechanism & {
  runtimeAuthority: "not_granted";
  liveReady: false;
  modelWeightAbsorbed: false;
  missing: string[];
};

type RadarCheck = {
  id: string;
  ok: boolean;
  summary: string;
  evidence?: unknown;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");

const CANDIDATES: ExternalUpgradeCandidate[] = [
  {
    id: "skillopt_v2_autoskill_coach",
    label: "AutoSkill / Skills-Coach",
    sourceUrls: ["https://arxiv.org/abs/2603.01145", "https://huggingface.co/papers/2604.27488"],
    sourceKind: "paper",
    claimedCapability:
      "derive reusable skills from interaction traces, generate variants, optimize skills, compare execution, and evaluate traceably",
    adoptionMode: "skill_lifecycle_probe",
    existingOwner: "SkillOpt-lite, failure curriculum, and local-brain promotion truth",
    ownerEntrypoint: "scripts/operator/lcx-skillopt-lite.ts",
    ownerUseTrigger:
      "When a future task asks for SkillOpt v2, AutoSkill, Skills-Coach, self-evolving skills, or SOP expansion, route through lcx-skillopt-lite and keep preflight, eval, train-slice, promotion, and external-channel proof separate.",
    autocueTerms: [
      "SkillOpt v2",
      "AutoSkill",
      "Skills-Coach",
      "self-evolving skills",
      "SOP expansion",
    ],
    distilledPattern:
      "turn real mistakes into skill packets with variant tasks, static gates, targeted eval, regression eval, train-slice evidence, clean promotion truth, and live preflight cue",
    firstLocalProbe:
      "extend one existing SkillOpt packet with generated adjacent validation cases and compare original versus optimized SOP before any training claim",
    requiredReceipts: [
      "lcx-skillopt-lite",
      "local-brain-distill-eval",
      "local-brain-training-plan",
      "local-brain-promotion-audit",
      "skillopt-autocue",
    ],
    requiredFilters: [
      "targeted_eval_required",
      "regression_eval_required",
      "train_slice_evidence_required",
      "promotion_ready_required",
      "real_external_proof_required",
    ],
    riskBoundaries: [
      "local_skillopt_lite_only",
      "skillopt_preflight_not_weight_absorption",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
      "no_direct_training_start",
    ],
    liveBoundary:
      "SkillOpt SOPs may cue the live/local reply planner only after source sync; model-weight absorption and user-visible-observed still require separate owner proof",
  },
  {
    id: "agent_lightning_trace_credit",
    label: "Agent Lightning",
    sourceUrls: [
      "https://arxiv.org/abs/2508.03680",
      "https://github.com/microsoft/agent-lightning",
    ],
    sourceKind: "paper_and_github",
    claimedCapability:
      "decouple agent execution traces from later learning, then use reward or failure attribution to improve agent workflows",
    adoptionMode: "trace_export_probe",
    existingOwner: "training failure feedback and problem-cluster radar",
    ownerEntrypoint: "scripts/operator/lcx-problem-cluster-radar.ts",
    ownerUseTrigger:
      "When a future task asks to learn from Agent Lightning, first run lcx-external-agent-upgrade-radar, then let problem-cluster radar own trace/credit-assignment probes.",
    autocueTerms: ["Agent Lightning", "trace credit", "credit assignment", "agent RL"],
    distilledPattern:
      "export LCX receipts and failure clusters as trace rows for offline credit assignment; never replace Qwen promotion truth",
    firstLocalProbe:
      "emit a read-only trace fixture from one failed commercial-answer or training cluster and score whether the blamed node matches the owner entrypoint",
    requiredReceipts: [
      "lcx-problem-cluster-radar",
      "local-brain-training-plan",
      "skill_pattern_distillation",
    ],
    requiredFilters: [
      "single_owner_required",
      "training_overlap_guard",
      "promotion_ready_required",
    ],
    riskBoundaries: [
      "no_runtime_rl_server",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "no_direct_training_start",
    ],
    liveBoundary:
      "external channel can surface the local radar result after migration, but no external-channel model behavior is changed by this radar alone",
  },
  {
    id: "longmemeval_agentrunbook_memory_regression",
    label: "LongMemEval-V2 / AgentRunbook",
    sourceUrls: ["https://arxiv.org/abs/2605.12493"],
    sourceKind: "paper",
    claimedCapability:
      "evaluate whether long-term agent memory preserves environment state, workflows, gotchas, and premise changes",
    adoptionMode: "memory_regression_probe",
    existingOwner: "context recovery and memory sedimentation gates",
    ownerEntrypoint: "scripts/operator/lcx-context-recovery-exam.ts",
    ownerUseTrigger:
      "When a future task asks for LongMemEval, AgentRunbook, stale snapshot, or long-memory regression, route through context recovery before changing memory.",
    autocueTerms: ["LongMemEval", "AgentRunbook", "long memory eval", "stale snapshot"],
    distilledPattern:
      "turn LCX handoff, operator latest, module-learning, and external-channel-boundary facts into regression questions for future compressed windows",
    firstLocalProbe:
      "generate a small local memory-regression fixture asking what changed, what is stale, and which owner command proves it",
    requiredReceipts: [
      "lcx-context-recovery-exam",
      "lcx-learning-sedimentation-audit",
      "lcx-system-memory-sedimentation-gate",
    ],
    requiredFilters: [
      "fresh_operator_state_required",
      "memory_write_freshness_gate",
      "stored_only_is_not_learning",
    ],
    riskBoundaries: [
      "no_new_memory_layer",
      "protected_memory_guard",
      "system_memory_not_module_learning",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "external channel can use the same prompt doctrine after migration, but memory regression proof remains local-only until a real External prompt uses it",
  },
  {
    id: "local_first_memory_provenance",
    label: "MemX / ground-truth-preserving memory",
    sourceUrls: ["https://arxiv.org/abs/2603.16171", "https://arxiv.org/abs/2604.04853"],
    sourceKind: "paper",
    claimedCapability:
      "local-first, explainable, provenance-aware memory retrieval with conservative miss handling and conflict preservation",
    adoptionMode: "memory_provenance_probe",
    existingOwner: "source registry, memory sedimentation, and context recovery",
    ownerEntrypoint: "scripts/operator/lcx-learning-sedimentation-audit.ts",
    ownerUseTrigger:
      "When a future task asks for MemX, memory provenance, explainable retrieval, stale-rule downranking, or ground-truth-preserving memory, route through source registry and memory sedimentation owners before changing storage.",
    autocueTerms: [
      "MemX",
      "memory provenance",
      "explainable retrieval",
      "ground-truth memory",
      "stale rule downrank",
    ],
    distilledPattern:
      "attach source, timestamp, conflict state, applicability scope, and keep/downrank/discard decision to memory recall instead of trusting extracted summaries",
    firstLocalProbe:
      "take one stale finance rule and produce a provenance packet with source, scope, conflict, downrank decision, and adjacent eval requirement",
    requiredReceipts: [
      "source_registry",
      "lcx-learning-sedimentation-audit",
      "lcx-system-memory-sedimentation-gate",
      "lcx-context-recovery-exam",
    ],
    requiredFilters: [
      "source_timestamp_required",
      "conflict_preservation_required",
      "stale_memory_downrank_required",
      "stored_only_is_not_learning",
      "protected_memory_guard",
    ],
    riskBoundaries: [
      "no_new_memory_daemon_by_default",
      "no_protected_memory_write",
      "no_storage_only_learning_claim",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "Live may use provenance wording only after sync; this radar does not mutate protected memory or claim learned memory",
  },
  {
    id: "lightweight_memory_comparison",
    label: "LightMem / LycheeMemory",
    sourceUrls: ["https://arxiv.org/abs/2604.07798", "https://github.com/LycheeMem/LycheeMem"],
    sourceKind: "paper_and_github",
    claimedCapability:
      "compact, cheaper long-term memory extraction and retrieval for agent histories",
    adoptionMode: "memory_comparison_probe",
    existingOwner: "module learning absorption and system memory sedimentation",
    ownerEntrypoint: "scripts/operator/lcx-learning-sedimentation-audit.ts",
    ownerUseTrigger:
      "When a future task asks for LightMem, LycheeMemory, compact memory, or cheaper memory, audit current sedimentation before adding storage.",
    autocueTerms: ["LightMem", "LycheeMemory", "compact memory", "memory comparison"],
    distilledPattern:
      "compare compact-memory ideas against LCX source/retrieval/apply/eval receipts without replacing protected summaries",
    firstLocalProbe:
      "score one stale-memory/downrank scenario with current LCX receipts versus a compact-memory candidate summary",
    requiredReceipts: [
      "lcx-module-learning-absorption-gate",
      "module-learning-pipeline-review",
      "lcx-system-memory-sedimentation-gate",
    ],
    requiredFilters: [
      "retrieval_apply_eval_review_required",
      "per_receipt_absorption_evidence_required",
      "protected_memory_guard",
    ],
    riskBoundaries: [
      "no_external_memory_daemon_by_default",
      "no_protected_memory_write",
      "no_storage_only_learning_claim",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "external-channel prompt can mention the boundary after sync; no external memory daemon is enabled or trusted by this change",
  },
  {
    id: "agent_trace_observability",
    label: "OpenTelemetry GenAI / AgentSight",
    sourceUrls: [
      "https://opentelemetry.io/docs/specs/semconv/gen-ai/",
      "https://arxiv.org/abs/2508.02736",
    ],
    sourceKind: "paper_and_github",
    claimedCapability:
      "connect agent decisions, model calls, tool calls, PIDs, file side effects, errors, and security-relevant behavior into traceable spans",
    adoptionMode: "agent_trace_probe",
    existingOwner: "governance autopilot, universe index, and problem-cluster radar",
    ownerEntrypoint: "scripts/operator/lcx-governance-autopilot.ts",
    ownerUseTrigger:
      "When a future task asks for OpenTelemetry, AgentSight, trace spans, side-effect attribution, or agent observability, add lightweight LCX trace receipts first and avoid eBPF or network interception by default.",
    autocueTerms: [
      "OpenTelemetry",
      "AgentSight",
      "agent trace",
      "side-effect attribution",
      "observability",
    ],
    distilledPattern:
      "normalize owner command, model call, tool call, process, file write, artifact, and boundary events into a local trace receipt for later failure attribution",
    firstLocalProbe:
      "emit one local owner-run trace row from governance autopilot linking owner id, command, exit code, parsed status, boundary, and artifact path",
    requiredReceipts: [
      "lcx-governance-autopilot",
      "lcx-universe-index",
      "lcx-problem-cluster-radar",
      "agent_trace_receipt",
    ],
    requiredFilters: [
      "local_trace_only",
      "no_tls_interception_by_default",
      "side_effect_boundary_required",
      "single_owner_required",
    ],
    riskBoundaries: [
      "no_ebpf_or_tls_interception_without_explicit_approval",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "External-channel trace summaries require explicit migration and redaction; local trace receipts alone are not user-visible proof",
  },
  {
    id: "secure_tool_skill_permission_layer",
    label: "OWASP Agentic Top 10 / SMCP",
    sourceUrls: [
      "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/",
      "https://arxiv.org/abs/2602.01129",
    ],
    sourceKind: "paper_and_github",
    claimedCapability:
      "agent security controls for tool poisoning, prompt injection, privilege escalation, authentication, policy enforcement, and audit logging",
    adoptionMode: "secure_tool_permission_probe",
    existingOwner: "skill harvester, CLI-Anything harvester, and security threat model",
    ownerEntrypoint: skillEntrypoint("security-threat-model"),
    ownerUseTrigger:
      "When a future task asks to add tools, MCP servers, CLI wrappers, desktop control, external skills, or agent permissions, run security ownership/threat-model checks before granting authority.",
    autocueTerms: [
      "OWASP Agentic",
      "SMCP",
      "secure MCP",
      "tool poisoning",
      "agent permission",
      "prompt injection",
    ],
    distilledPattern:
      "treat every new tool or skill as untrusted until it has identity, allowlist, least privilege, audit log, uninstall path, and owner boundary",
    firstLocalProbe:
      "score one proposed CLI wrapper or MCP server against tool allowlist, write scope, credential scope, prompt-injection risk, audit log, and uninstall path",
    requiredReceipts: [
      "security-threat-model",
      "security-ownership-map",
      "skill-harvester",
      "cli-anything-harvester",
      "agent_permission_audit",
    ],
    requiredFilters: [
      "tool_allowlist_required",
      "least_privilege_required",
      "credential_scope_required",
      "audit_log_required",
      "uninstall_path_required",
    ],
    riskBoundaries: [
      "no_untrusted_tool_authority",
      "no_global_install",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "Live can only use a new tool after security receipts, source sync, and explicit external-channel migration; this radar grants no authority",
  },
  {
    id: "clawbench_real_task_regression",
    label: "ClawBench / WildClawBench",
    sourceUrls: ["https://github.com/claw-bench/claw-bench", "https://arxiv.org/abs/2605.10912"],
    sourceKind: "paper_and_github",
    claimedCapability:
      "benchmark long-horizon and tool-heavy agent work beyond question-answer style evals",
    adoptionMode: "real_task_benchmark_probe",
    existingOwner: "commercial acceptance harness and L5 regression battery",
    ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    ownerUseTrigger:
      "When a future task asks for ClawBench, WildClawBench, or real-task agent benchmarks, convert it into commercial canaries instead of leaderboard code.",
    autocueTerms: ["ClawBench", "WildClawBench", "real task benchmark", "agent benchmark"],
    distilledPattern:
      "convert real task categories into LCX canaries with natural owner prompts, internal route traces, optional acceptance anchors, visible reply checks, and bounded failure reports",
    firstLocalProbe:
      "add one read-only real-work canary that checks whether an answer, owner command, and visible-boundary proof line up",
    requiredReceipts: [
      "lcx-commercial-acceptance-harness",
      "l5-regression-batterer",
      "external-message-flow",
    ],
    requiredFilters: [
      "commercial_error_budget_required",
      "product_canary_suite_required",
      "real_external_inbound_required",
    ],
    riskBoundaries: [
      "no_leaderboard_submission",
      "no_untrusted_task_execution",
      "local_ready_not_live_user_seen",
      "protected_memory_guard",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "commercial canary is user-visible only after migration plus fresh External inbound and matching reply evidence",
  },
  {
    id: "computer_use_cli_bridge",
    label: "Agent S / HKUDS CLI-Anything",
    sourceUrls: ["https://arxiv.org/abs/2410.08164", "https://github.com/HKUDS/CLI-Anything"],
    sourceKind: "paper_and_github",
    claimedCapability:
      "make computer or GUI workflows controllable through either visual computer-use agents or generated CLI wrappers",
    adoptionMode: "computer_use_cli_probe",
    existingOwner: "skill harvester and CLI-Anything harvester",
    ownerEntrypoint: skillEntrypoint("cli-anything-harvester"),
    ownerUseTrigger:
      "When a future task asks for Agent S, CLI-Anything, CLI-Hub, or desktop software CLI wrappers, use cli-anything-harvester before any wrapper is trusted.",
    autocueTerms: ["Agent S", "CLI-Anything", "CLI-Hub", "desktop control"],
    distilledPattern:
      "prefer stable local CLI or official automation first; only distill a wrapper after JSON contract, proof command, and uninstall path exist",
    firstLocalProbe:
      "classify one local command or app with cli-anything-harvester before any wrapper is allowed into LCX runtime",
    requiredReceipts: ["skill-harvester", "cli-anything-harvester", "skill_pattern_distillation"],
    requiredFilters: [
      "license_scope_required",
      "untrusted_source_isolation",
      "human_signoff_checkpoint",
    ],
    riskBoundaries: [
      "no_gui_write_without_probe",
      "no_global_install",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "external-channel agent may autocue the harvester skill after sync; no desktop-control authority is granted without a concrete tested wrapper",
  },
  {
    id: "github_cli_agentic_workflow_control",
    label: "GitHub CLI / GitHub Agentic Workflows",
    sourceUrls: [
      "https://cli.github.com/manual/gh_extension",
      "https://github.github.io/gh-aw/reference/gh-aw-as-mcp-server/",
      "https://github.com/github/github-mcp-server",
      "https://github.com/features/copilot/cli",
    ],
    sourceKind: "docs_product_and_paper",
    claimedCapability:
      "turn GitHub issues, pull requests, MCP tools, Copilot CLI, and gh extensions into an agent-facing control plane",
    adoptionMode: "github_cli_agentic_workflow_probe",
    existingOwner:
      "GitHub CLI wrapper planning, CLI-Anything harvester, and secure tool permission layer",
    ownerEntrypoint: skillEntrypoint("cli-anything-harvester"),
    ownerUseTrigger:
      "When a future task asks where GitHub CLI lives, asks to use gh, Copilot CLI, gh-aw, GitHub MCP, gh extensions, PR agents, issue agents, or GitHub agent workflow automation, first classify the command as read-only discovery, local-only wrapper, remote write, or agent delegation before any execution.",
    autocueTerms: [
      "GitHub CLI",
      "gh cli",
      "gh extension",
      "gh-aw",
      "GitHub Agentic Workflows",
      "GitHub MCP",
      "Copilot CLI",
      "PR agent",
      "issue agent",
    ],
    distilledPattern:
      "use gh as a transparent operator console: read-only repo/issue/PR discovery first, then JSON wrapper contract, permission scope review, dry-run receipt, and explicit owner approval before remote writes or agent delegation",
    firstLocalProbe:
      "run a read-only gh capability inventory that reports gh version, auth scope status, installed extensions, repo identity, and which commands would be remote-write blocked",
    requiredReceipts: [
      "cli-anything-harvester",
      "security-threat-model",
      "github_cli_capability_inventory",
      "agent_permission_audit",
      "owner_control_map",
    ],
    requiredFilters: [
      "read_only_discovery_first",
      "remote_write_requires_owner_approval",
      "credential_scope_required",
      "repo_scope_required",
      "dry_run_receipt_required",
      "human_review_before_agent_delegation",
    ],
    riskBoundaries: [
      "no_gh_remote_write_by_default",
      "no_issue_or_pr_mutation_without_owner_command",
      "no_copilot_agent_assignment_without_owner_command",
      "no_mcp_server_install_without_security_receipt",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "GitHub CLI may become an operator-side control panel after wrapper tests and permission receipts, but it never becomes live External, provider, protected-memory, or trading authority by default",
  },
  {
    id: "multi_agent_framework_orchestration_guardrails",
    label: "LangGraph / OpenAI Agents / CrewAI / Microsoft Agent Framework / OpenHands",
    sourceUrls: [
      "https://docs.langchain.com/oss/python/langchain/multi-agent",
      "https://openai.github.io/openai-agents-python/handoffs/",
      "https://docs.crewai.com/introduction",
      "https://learn.microsoft.com/agent-framework/overview/agent-framework-overview",
      "https://github.com/OpenHands/OpenHands",
    ],
    sourceKind: "docs_product_and_paper",
    claimedCapability:
      "multi-agent routing, supervisor, handoff, and role-orchestration patterns for complex workflows",
    adoptionMode: "multi_agent_orchestration_probe",
    existingOwner: "flow graph, commercial answer pipeline, and problem-cluster radar",
    ownerEntrypoint: "scripts/operator/lcx-flow-graph.ts",
    ownerUseTrigger:
      "When a future task asks for LangGraph, OpenAI Agents handoffs, CrewAI crews, Microsoft Agent Framework, supervisor routing, or multi-agent orchestration, map the pattern through flow graph and existing owners before adding agents.",
    autocueTerms: [
      "LangGraph",
      "OpenAI Agents handoffs",
      "CrewAI",
      "Microsoft Agent Framework",
      "OpenHands",
      "multi-agent",
      "supervisor routing",
    ],
    distilledPattern:
      "use specialist roles and handoffs only as workflow structure while keeping volatile truth in one owner per state family",
    firstLocalProbe:
      "classify one LCX workflow into supervisor, handoff, worker, owner-truth, and terminal-decision nodes without changing runtime",
    requiredReceipts: [
      "lcx-flow-graph",
      "lcx-commercial-answer-pipeline",
      "lcx-problem-cluster-radar",
      "skill_pattern_distillation",
    ],
    requiredFilters: [
      "single_owner_required",
      "terminal_decision_required",
      "bounded_answer_review",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    riskBoundaries: [
      "no_parallel_agent_framework",
      "no_hidden_tool_authority",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "external channel can benefit from clearer role routing only after local owner checks and migration; this radar grants no external-channel agent framework authority",
  },
  {
    id: "individual_ai_hedge_fund",
    label: "virattt/ai-hedge-fund",
    sourceUrls: [
      "https://github.com/virattt/ai-hedge-fund",
      "https://github.com/virattt/ai-hedge-fund/blob/main/VISION.md",
    ],
    sourceKind: "github",
    claimedCapability:
      "individual-developer AI hedge-fund product with pluggable analyst alpha models, mandate files, backtesting, persistent fund cycles, and explicit paper/educational boundaries",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner:
      "finance answer pipeline, deterministic data gateway, and local-model evaluation",
    ownerEntrypoint: "scripts/operator/lcx-commercial-answer-pipeline.ts",
    ownerUseTrigger:
      "When a future task asks for ai-hedge-fund, alpha models, fund mandates, analyst teams, backtesting, or persistent hedge-fund cycles, route the pattern through the finance pipeline and local eval owners before changing any trading authority.",
    autocueTerms: [
      "ai-hedge-fund",
      "alpha model",
      "fund mandate",
      "hedge-fund team",
      "finance backtest",
    ],
    distilledPattern:
      "separate fund mandate, pluggable research/alpha models, deterministic market-data client, backtest cycle, paper record, and any later execution boundary",
    firstLocalProbe:
      "build one research-only mandate fixture that runs the finance data gateway, records a no-lookahead backtest receipt, and ends at review without producing an order",
    requiredReceipts: [
      "finance-data-gateway",
      "source_registry",
      "local-brain-distill-eval",
      "backtest_receipt",
      "review_panel",
    ],
    requiredFilters: [
      "research_only_boundary",
      "no_lookahead",
      "deterministic_data_owner",
      "no_trade_advice",
      "separate_model_quality_from_pnl",
    ],
    riskBoundaries: [
      "no_broker_or_order_execution",
      "no_trade_advice",
      "research_only",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "only research artifacts and backtest receipts may enter the local review path; no broker, wallet, order, or live fund authority is granted",
  },
  {
    id: "trading_agents_finance_multi_agent",
    label: "TauricResearch/TradingAgents",
    sourceUrls: [
      "https://github.com/TauricResearch/TradingAgents",
      "https://arxiv.org/abs/2412.20138",
    ],
    sourceKind: "paper_and_github",
    claimedCapability:
      "high-adoption financial multi-agent research system with fundamental, technical, sentiment, bull/bear research, trader, risk, portfolio-manager, checkpoint-resume, and decision-log patterns",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner: "LogicalAgentPool, finance data gateway, and research-only answer pipeline",
    ownerEntrypoint: "src/agents/logical-agent-pool.ts",
    ownerUseTrigger:
      "When a future task asks for TradingAgents, bull/bear debate, trader/risk/portfolio-manager roles, or finance multi-agent graphs, map the role contract into LogicalAgentPool and finance evidence gates without importing broker execution.",
    autocueTerms: [
      "TradingAgents",
      "bull bear debate",
      "financial multi-agent",
      "portfolio manager agent",
      "trading decision log",
    ],
    distilledPattern:
      "compose specialist financial analysis, explicit bullish/bearish challenge, risk review, portfolio synthesis, and durable decision evidence while keeping numbers and execution outside the LLM",
    firstLocalProbe:
      "run a local finance DAG with financial extraction, evidence integrity, adversarial challenge, risk check, and final precheck against a fixture with missing data and no order output",
    requiredReceipts: [
      "logical-agent-pool",
      "logical-agent-checkpoint",
      "finance-data-gateway",
      "review_panel",
      "control_room_summary",
    ],
    requiredFilters: [
      "single_shared_local_model",
      "checkpoint_resume_required",
      "source_timestamp_required",
      "adversarial_review_required",
      "no_trade_advice",
    ],
    riskBoundaries: [
      "no_broker_or_order_execution",
      "no_wallet_connection",
      "no_trade_advice",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "the finance roles may produce bounded research and risk artifacts only; portfolio-manager language never becomes a live order or position authority",
  },
  {
    id: "finrobot_financial_research",
    label: "AI4Finance/FinRobot",
    sourceUrls: [
      "https://github.com/AI4Finance-Foundation/FinRobot",
      "https://arxiv.org/abs/2405.14767",
    ],
    sourceKind: "paper_and_github",
    claimedCapability:
      "financial research product with role-based pipeline and debate agents, deterministic valuation operators, provider failover, numeric provenance, and traceable multi-chapter reports",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner: "finance data gateway, quantitative validation, and report/review pipeline",
    ownerEntrypoint: "src/agents/finance-data-gateway.ts",
    ownerUseTrigger:
      "When a future task asks for FinRobot, DCF/DDM/LBO/comps, deterministic valuation, provider failover, or investment-committee reports, route computation to finance owners and keep the local model as narration/review support only.",
    autocueTerms: ["FinRobot", "DCF", "DDM", "LBO", "comps valuation", "numeric provenance"],
    distilledPattern:
      "strictly separate code-calculated financial numbers from LLM reasoning and report prose, with provider provenance, failover, debate, and a traceable artifact",
    firstLocalProbe:
      "replay one deterministic valuation fixture through finance data normalization, calculation, provenance, bull/bear review, and report completeness checks without current-data invention",
    requiredReceipts: [
      "finance-data-gateway",
      "data_provenance_quality",
      "quant_math",
      "review_panel",
      "research_artifact_qc",
    ],
    requiredFilters: [
      "numbers_code_calculated",
      "field_definition_required",
      "provider_conflict_preserved",
      "report_provenance_required",
      "no_trade_advice",
    ],
    riskBoundaries: [
      "no_llm_generated_financial_numbers",
      "no_broker_or_order_execution",
      "no_trade_advice",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "only source-bound calculations and reviewed research reports may proceed; no robo-advisor or live-trading authority is imported",
  },
  {
    id: "openbb_finance_data_platform",
    label: "OpenBB finance data and AI-agent platform",
    sourceUrls: [
      "https://github.com/OpenBB-finance/OpenBB",
      "https://github.com/OpenBB-finance/openbb-ai",
      "https://github.com/OpenBB-finance/agents-for-openbb",
    ],
    sourceKind: "github",
    claimedCapability:
      "high-adoption financial data platform exposing normalized vendor integrations to quants, analysts, APIs, MCP servers, and AI-agent surfaces",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner: "finance data gateway, source registry, and adapter health/doctor contracts",
    ownerEntrypoint: "src/agents/finance-data-gateway.ts",
    ownerUseTrigger:
      "When a future task asks for OpenBB, finance provider adapters, analyst widgets, MCP finance data, or vendor normalization, route through the finance data gateway and source registry rather than adding a parallel data truth layer.",
    autocueTerms: [
      "OpenBB",
      "OpenBB AI",
      "finance data platform",
      "vendor adapter",
      "financial MCP",
    ],
    distilledPattern:
      "connect financial data sources once, normalize field definitions and timestamps, expose the same evidence to research and agents, and report adapter health/fallback explicitly",
    firstLocalProbe:
      "add one read-only finance adapter fixture with preferred/fallback source metadata, field-definition validation, timestamp receipt, and a doctor result",
    requiredReceipts: [
      "finance-data-gateway",
      "source_registry",
      "data_provenance_quality",
      "adapter_health_receipt",
    ],
    requiredFilters: [
      "single_finance_truth_gateway",
      "field_definition_required",
      "source_timestamp_required",
      "provider_conflict_preserved",
      "credential_scope_required",
    ],
    riskBoundaries: [
      "agpl_code_not_copied",
      "no_unreviewed_provider_install",
      "no_credential_write",
      "no_broker_or_order_execution",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "provider adapters remain read-only research inputs until separately audited, authenticated, and bound; this candidate cannot create a second finance truth source",
  },
  {
    id: "agent_reach_source_adapter",
    label: "Panniantong/Agent-Reach",
    sourceUrls: ["https://github.com/Panniantong/Agent-Reach"],
    sourceKind: "github",
    claimedCapability:
      "individual-built capability layer with preferred and fallback backends, a doctor command, and explicit cookie/credential boundaries",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner: "finance realtime source registry and source health receipts",
    ownerEntrypoint: "src/agents/finance-realtime-source-registry.ts",
    ownerUseTrigger:
      "When a future task asks for Agent-Reach, preferred/fallback web capabilities, source doctor, or backend health, route it through the finance realtime source registry and skill-harvester before adding any connector or credential path.",
    autocueTerms: ["Agent-Reach", "preferred fallback adapter", "source doctor", "backend health"],
    distilledPattern:
      "represent a capability as an ordered adapter set with observable health, fallback reasons, and a separate credential boundary",
    firstLocalProbe:
      "run the local finance source registry with a failing preferred fixture and a succeeding fallback fixture, then preserve both attempts in one gateway receipt",
    requiredReceipts: [
      "finance-realtime-source-registry",
      "finance-data-gateway",
      "adapter_health_receipt",
    ],
    requiredFilters: [
      "no_cookie_import",
      "no_credential_write",
      "preferred_fallback_order_explicit",
      "single_finance_truth_gateway",
    ],
    riskBoundaries: [
      "no_unreviewed_installer",
      "no_cookie_or_token_import",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "the adapter contract may run an explicitly authorized public source; it cannot import cookies, credentials, external senders, or a second source of truth",
  },
  {
    id: "echoapi_api_test_harness",
    label: "EchoAPI API request/response harness",
    sourceUrls: [
      "https://www.echoapi.com/wiki/docs/start",
      "https://www.echoapi.com/wiki/docs/http_debug/script",
      "https://github.com/EchoAPI-Team/echoapi-for-vscode-support/blob/main/LICENSE",
    ],
    sourceKind: "docs_product_and_paper",
    claimedCapability:
      "API client and test surface for HTTP, SSE, and TCP requests with environments, scripts, cookies, and response assertions",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner:
      "finance external source adapter, realtime source registry, and adapter contract tests",
    ownerEntrypoint: "src/agents/echoapi-cli-runner.ts",
    ownerUseTrigger:
      "When a task supplies an EchoAPI CI case URL for a public read-only API, ensure the exact CLI is present under the canonical state-root runtime, run one real case through the LCX CLI runner, and route the status/report receipt into the existing source owners; use the collection/export surface for reviewed adapter contracts.",
    autocueTerms: ["EchoAPI", "API collection import", "SSE API test", "response assertion"],
    distilledPattern:
      "separate real public-case execution and response testing from the financial data authority; retain URL host/path, status, timing/report hash, schema evidence, and explicit no-webhook/no-secret-env policy",
    firstLocalProbe:
      "ensure echoapi-cli@3.0.0 in the canonical state root, run one public read-only case with one iteration, JSON/CLI report, no webhook, minimal environment, and then map its actual status into a reviewed local source receipt",
    requiredReceipts: [
      "finance-external-source-adapter",
      "finance-realtime-source-registry",
      "source_license_scope_receipt",
      "response_schema_receipt",
    ],
    requiredFilters: [
      "real_public_case_allowed",
      "fixture_first",
      "no_cookie_import",
      "no_environment_secret_import",
      "no_post_request_external_write",
      "single_finance_truth_gateway",
    ],
    riskBoundaries: [
      "api_client_not_finance_truth_source",
      "no_cookie_or_token_import",
      "no_client_certificate_import",
      "no_unreviewed_script_execution",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "EchoAPI may execute one explicitly supplied public case; its environments, cookies, scripts, webhooks, client certificates, and remote writes never become LCX runtime authority",
  },
  {
    id: "finnews_hunter_realtime_intelligence",
    label: "DemonDamon/FinnewsHunter",
    sourceUrls: ["https://github.com/DemonDamon/FinnewsHunter"],
    sourceKind: "github",
    claimedCapability:
      "personal multi-agent financial intelligence project combining news collection, sentiment fusion, factor mining, market data, and a realtime search surface",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner:
      "finance article source registry, realtime source registry, and news-classification logical worker",
    ownerEntrypoint: "src/agents/finance-realtime-source-registry.ts",
    ownerUseTrigger:
      "When a future task asks for FinnewsHunter, realtime finance news, sentiment fusion, or alpha-factor mining, ingest only timestamped source packets and classification fixtures through existing finance owners; never import its collection or execution surface directly.",
    autocueTerms: [
      "FinnewsHunter",
      "realtime finance news",
      "sentiment fusion",
      "financial news agent",
    ],
    distilledPattern:
      "collect source packets before analysis, keep publication and retrieval timestamps, deduplicate event evidence, and route sentiment through adversarial review",
    firstLocalProbe:
      "replay a local news packet fixture with duplicate headlines, conflicting timestamps, and missing issuer confirmation through the article registry and review panel",
    requiredReceipts: [
      "finance-article-source-registry",
      "finance-realtime-source-registry",
      "data_provenance_quality",
      "review_panel",
    ],
    requiredFilters: [
      "source_timestamp_required",
      "duplicate_event_review_required",
      "sentiment_is_not_forecast",
      "no_trade_advice",
    ],
    riskBoundaries: [
      "source_code_license_receipt_required",
      "no_unreviewed_scraper_install",
      "no_broker_or_order_execution",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "news collection may feed research-only evidence after source and license review; sentiment, factor names, and realtime labels never become trading authority",
  },
  {
    id: "openfr_finance_research",
    label: "oujingzhou/openfr",
    sourceUrls: ["https://github.com/oujingzhou/openfr"],
    sourceKind: "github",
    claimedCapability:
      "lightweight financial research agent using market-data adapters, multi-model analysis, caching, retry/fallback, and market-hours awareness",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner:
      "finance realtime source registry, finance data gateway, and logical-agent research DAG",
    ownerEntrypoint: "src/agents/finance-realtime-source-registry.ts",
    ownerUseTrigger:
      "When a future task asks for OpenFR, AKShare, quote caching, retry/fallback, or market-hours handling, map the pattern into the source registry and gateway; audit provider and dependency scope before any adapter is added.",
    autocueTerms: ["OpenFR", "AKShare finance agent", "quote cache", "market-hours guard"],
    distilledPattern:
      "cache by source freshness, retry bounded failures, understand market-hours limitations, and keep provider fallback visible in the research receipt",
    firstLocalProbe:
      "add a deterministic adapter fixture with cache-age, retry, market-hours, and stale-data labels, then verify the canonical gateway never treats cache presence as freshness proof",
    requiredReceipts: [
      "finance-realtime-source-registry",
      "finance-data-gateway",
      "adapter_health_receipt",
      "data_provenance_quality",
    ],
    requiredFilters: [
      "cache_age_required",
      "market_hours_boundary_required",
      "retry_limit_required",
      "provider_conflict_preserved",
    ],
    riskBoundaries: [
      "dependency_license_review_required",
      "no_unreviewed_provider_install",
      "no_broker_or_order_execution",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "cache and retry patterns are local adapter behavior only; no AKShare, broker, wallet, or live trade surface is imported by the radar",
  },
  {
    id: "amplio_crash_resume_harness",
    label: "google-deepmind/amplio",
    sourceUrls: ["https://github.com/google-deepmind/amplio"],
    sourceKind: "github",
    claimedCapability:
      "lightweight agent harness emphasizing crash-resume, agent/user/environment coordination, and run-start source snapshots",
    adoptionMode: "multi_agent_orchestration_probe",
    existingOwner: "LogicalAgentPool, canonical state-root checkpoint store, and context recovery",
    ownerEntrypoint: "src/agents/logical-agent-pool-checkpoint-store.ts",
    ownerUseTrigger:
      "When a future task asks for Amplio, crash-resume, run-start source snapshots, or environment coordination, compare the pattern with the canonical checkpoint store and context recovery before changing persistence.",
    autocueTerms: [
      "Amplio",
      "crash resume",
      "run-start snapshot",
      "agent environment coordination",
    ],
    distilledPattern:
      "capture the run's source snapshot and safe resume boundary once, then let all workers inherit the same evidence without creating another state root",
    firstLocalProbe:
      "restart one logical-agent run from the canonical state-root checkpoint and prove the resumed plan fingerprint and source boundary remain unchanged",
    requiredReceipts: ["logical-agent-checkpoint", "context-recovery-exam", "plan_fingerprint"],
    requiredFilters: [
      "canonical_state_root_only",
      "atomic_checkpoint_write",
      "resume_plan_fingerprint_required",
      "no_second_truth_store",
    ],
    riskBoundaries: [
      "no_new_state_root",
      "no_parallel_persistence_authority",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "crash-resume patterns strengthen local orchestration only; they do not prove model learning, external binding, or user-visible completion",
  },
  {
    id: "cameron_personal_finance_approval",
    label: "agentailor/cameron",
    sourceUrls: ["https://github.com/agentailor/cameron"],
    sourceKind: "github",
    claimedCapability:
      "individual-built personal-finance agent with local data ownership, seed-data evaluation, capability learning, and an approval gate before every write",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner: "finance write boundary, protected-memory gate, and operator approval contracts",
    ownerEntrypoint: "scripts/operator/lcx-commercial-answer-pipeline.ts",
    ownerUseTrigger:
      "When a future task asks for Cameron, personal-finance writes, capability approval, or local finance data ownership, map it to LCX approval and evidence gates before any connector or write path changes.",
    autocueTerms: ["Cameron finance agent", "personal finance approval", "finance capability gate"],
    distilledPattern:
      "require explicit human approval for every financial capability and keep personal data on owner-controlled infrastructure while testing against seed data",
    firstLocalProbe:
      "replay a seed-only finance write proposal and prove the proposal is blocked until an explicit owner approval receipt exists",
    requiredReceipts: [
      "finance-data-gateway",
      "human_signoff_checkpoint",
      "protected_memory_guard",
      "source_registry",
    ],
    requiredFilters: [
      "seed_data_only_probe",
      "explicit_approval_required",
      "no_secret_in_artifact",
      "no_trade_advice",
    ],
    riskBoundaries: [
      "no_bank_connector_write",
      "no_money_movement",
      "no_protected_memory_write_without_approval",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "approval patterns may strengthen local finance write gates; no personal-bank connector or money-movement capability is enabled",
  },
  {
    id: "cents_thesis_research",
    label: "wolfbane/cents",
    sourceUrls: ["https://github.com/wolfbane/cents"],
    sourceKind: "github",
    claimedCapability:
      "individual research CLI for thesis-driven multi-agent evidence gathering across fundamentals, technicals, macro, sentiment, moat, and insider signals with a paper-only loop",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner: "finance research artifact, source registry, and acceptance harness",
    ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    ownerUseTrigger:
      "When a future task asks for Cents, thesis tracking, conviction calibration, or paper-only investment research, route it through the acceptance harness and require source and calibration receipts.",
    autocueTerms: [
      "Cents investment research",
      "thesis tracking",
      "conviction calibration",
      "paper-only finance",
    ],
    distilledPattern:
      "turn a thesis into explicit premises, collect specialist evidence, track conviction changes, and evaluate forward outcomes without presenting model conviction as calibrated truth",
    firstLocalProbe:
      "run one thesis fixture through evidence collection, premise conflict, conviction-change receipt, and calibration-ready holdout without any trade action",
    requiredReceipts: [
      "source_registry",
      "data_provenance_quality",
      "review_panel",
      "commercial_acceptance_harness",
    ],
    requiredFilters: [
      "paper_only",
      "premise_conflict_preserved",
      "calibration_holdout_required",
      "no_trade_advice",
    ],
    riskBoundaries: [
      "no_broker_or_order_execution",
      "no_position_sizing_authority",
      "no_trade_advice",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "thesis artifacts can enter local review only; conviction scores remain uncalibrated research signals and cannot become user-visible trade instructions",
  },
  {
    id: "openalice_full_lifecycle_trading",
    label: "TraderAlice/OpenAlice",
    sourceUrls: ["https://github.com/TraderAlice/OpenAlice"],
    sourceKind: "github",
    claimedCapability:
      "one-person cross-asset trading product spanning research, unified accounts, staged orders, guard pipelines, monitoring, and exit lifecycle",
    adoptionMode: "finance_agent_architecture_probe",
    existingOwner:
      "finance research boundary, execution prohibition, and reversible artifact review",
    ownerEntrypoint: "scripts/operator/lcx-commercial-answer-pipeline.ts",
    ownerUseTrigger:
      "When a future task asks for OpenAlice, trading-as-Git, unified trading accounts, staged orders, or full lifecycle trading, study the artifact and guard patterns only; route all LCX work through research-only finance owners.",
    autocueTerms: [
      "OpenAlice",
      "trading-as-Git",
      "unified trading account",
      "staged order",
      "full lifecycle trading",
    ],
    distilledPattern:
      "make financial actions reviewable as versioned artifacts with account snapshots, pre-execution guard checks, and explicit human stop points",
    firstLocalProbe:
      "model a paper-only staged research artifact with immutable diff, risk guard results, account snapshot fixture, and a hard stop before any broker adapter",
    requiredReceipts: [
      "source_registry",
      "review_panel",
      "human_signoff_checkpoint",
      "finance-data-gateway",
      "control_room_summary",
    ],
    requiredFilters: [
      "architecture_only_due_to_license",
      "paper_only",
      "human_stop_before_execution",
      "reversible_artifact_required",
      "no_trade_advice",
    ],
    riskBoundaries: [
      "agpl_code_not_copied",
      "no_broker_or_order_execution",
      "no_wallet_connection",
      "no_private_key_access",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "OpenAlice is an architecture reference only; its AGPL and execution surface remain outside LCX, and LCX keeps the hard no-trading boundary",
  },
  {
    id: "prediction_market_research_intake",
    label: "Polymarket research intake tools",
    sourceUrls: [
      "https://docs.polymarket.com/api-reference",
      "https://docs.polymarket.com/developers/CLOB/clients/%3Aslug%2A",
      "https://polyclaw.cloud/",
      "https://www.forezai.com/",
      "https://polymark.et/product/polyseer",
    ],
    sourceKind: "docs_product_and_paper",
    claimedCapability:
      "prediction-market topic, resolution criteria, close date, liquidity, orderbook, and evidence intake for research",
    adoptionMode: "prediction_market_research_probe",
    existingOwner: "finance data gateway, source registry, and data provenance review",
    ownerEntrypoint: "src/agents/finance-data-gateway.ts",
    ownerUseTrigger:
      "When a future task mentions Polymarket, PolyClaw, Polybot, Polyseer, prediction markets, CLOB, orderbooks, or market probabilities, route it through research-only finance data provenance before any conclusion.",
    autocueTerms: [
      "Polymarket",
      "PolyClaw",
      "Polybot",
      "Polyseer",
      "prediction market",
      "CLOB",
      "orderbook",
    ],
    distilledPattern:
      "treat prediction markets as weak but useful research sources requiring a real market metadata packet, resolution criteria, timestamp, liquidity, source evidence, ambiguous-resolution review, thin-liquidity downranking, and counterevidence",
    firstLocalProbe:
      "create a paper-only prediction-market research packet with market metadata, source timestamps, resolution ambiguity review, thin-liquidity downrank decision, liquidity caveats, and no execution authority",
    requiredReceipts: [
      "source_registry",
      "finance-data-gateway",
      "data_provenance_quality",
      "review_panel",
      "control_room_summary",
    ],
    requiredFilters: [
      "research_only_boundary",
      "no_trade_advice",
      "fresh_timestamp_required",
      "field_definition_required",
      "market_microstructure_warning_required",
      "thin_liquidity_downrank_required",
      "ambiguous_resolution_blocks_conclusion",
      "no_wallet_or_order_execution",
    ],
    riskBoundaries: [
      "research_only",
      "no_wallet_connection",
      "no_order_placement",
      "no_copy_trading",
      "no_latency_arbitrage",
      "market_probability_not_forecast",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "external channel may summarize research packets after migration, but no wallet, order, private-key, or trading action is enabled",
  },
  {
    id: "prediction_market_strategy_audit",
    label: "PolyBench / PolySwarm prediction-market strategy audit",
    sourceUrls: ["https://arxiv.org/abs/2604.14199", "https://arxiv.org/abs/2604.03888"],
    sourceKind: "paper",
    claimedCapability:
      "prediction-market benchmark, multi-agent debate, strategy simulation, and calibration patterns",
    adoptionMode: "strategy_audit_probe",
    existingOwner: "commercial acceptance harness, eval harness design, and review panel",
    ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    ownerUseTrigger:
      "When a future task asks for Polymarket strategy, PolyBench, PolySwarm, prediction-market bots, or market-making ideas, keep it paper-only and route to strategy audit, overfit checks, and review.",
    autocueTerms: [
      "PolyBench",
      "PolySwarm",
      "Polymarket strategy",
      "prediction-market bot",
      "market-making",
      "paper trading",
    ],
    distilledPattern:
      "audit strategies with calibration, slippage, liquidity, resolution-risk, sample-out, and failure logs before treating any result as useful research",
    firstLocalProbe:
      "score one paper-only strategy artifact and write a failure log when fees, slippage, sample-out, thin-liquidity, or no-execution compliance is missing",
    requiredReceipts: [
      "source_registry",
      "data_provenance_quality",
      "strategy_experiment_audit",
      "eval_harness_design",
      "review_panel",
    ],
    requiredFilters: [
      "research_only_boundary",
      "no_trade_advice",
      "paper_only_backtest_required",
      "sample_out_validation_required",
      "market_microstructure_warning_required",
      "thin_liquidity_downrank_required",
      "ambiguous_resolution_blocks_conclusion",
      "fees_slippage_and_sample_out_required",
      "no_wallet_or_order_execution",
    ],
    riskBoundaries: [
      "research_only",
      "no_wallet_connection",
      "no_order_placement",
      "no_copy_trading",
      "no_latency_arbitrage",
      "market_probability_not_forecast",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "strategy audit can only become a visible research summary after review; it must never execute, size, copy, or route orders",
  },
];

const BLACKTECH_MECHANISMS: BlacktechMechanism[] = [
  {
    id: "skillopt_v2_lifecycle",
    priority: 1,
    label: "SkillOpt v2 lifecycle",
    sourceCandidates: ["skillopt_v2_autoskill_coach"],
    ownerEntrypoint: "scripts/operator/lcx-skillopt-lite.ts",
    automaticTrigger:
      "When user feedback, failed cases, repeated wrong answers, or SkillOpt/AutoSkill/Skills-Coach wording appears, governance autopilot reads SkillOpt-lite before any eval or training action.",
    ownerGate:
      "active eval/MLX must be idle before targeted eval, train-slice rebuild, adapter promotion, or external-channel binding; preflight cue stays local-only while busy",
    autopilotSurface:
      "lcx-governance-autopilot owners.skillOptLite plus owners.externalAgentUpgrade.nextBlacktechProbes",
    doctrineTerms: [
      "real mistakes become skills",
      "variant tasks",
      "compare original versus optimized SOP",
      "targeted eval",
      "train-slice",
      "external-channel preflight cue",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "extend one accepted SkillOpt packet with generated adjacent validation cases, comparative execution, and a traceable eval receipt",
    nextAutomationAction:
      "autopilot should surface the exact SkillOpt nextIdleCommand, then run at most that one command only after active eval/MLX is idle and owner gates are clean",
    blockedUntilIdle:
      "targeted eval, train-slice, adapter promotion, and external-channel binding must wait until eval/MLX is idle",
    requiredProofChain: [
      "accepted_skillopt_candidate",
      "generated_variant_tasks",
      "original_vs_optimized_sop_comparison",
      "targeted_eval_clean",
      "regression_eval_clean",
      "train_slice_contains_skillopt_evidence",
      "new_adapter_hardened_eval_clean",
      "promotionReady_true_without_failed_or_parseRecovered",
      "live_preflight_cue_source_synced",
      "fresh_real_external_inbound_and_outbound_seen",
    ],
    forbiddenAuthorities: [
      "model_weight_absorption_claim_without_training",
      "live_visible_fixed_claim_without_external_proof",
      "provider_config_change",
      "protected_memory_write",
      "direct_trading_authority",
    ],
    liveBoundary:
      "Immediate SkillOpt preflight can improve planning, but learned capability and external-channel usage require separate promotion and live-proof owners.",
  },
  {
    id: "real_runtime_battery",
    priority: 2,
    label: "Native-runtime long-task battery",
    sourceCandidates: ["clawbench_real_task_regression"],
    ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    automaticTrigger:
      "When a task claims product-grade, user-visible, long-horizon, runtime, or commercial acceptance readiness, autopilot includes the commercial acceptance harness.",
    ownerGate:
      "canary tasks may inspect local runtime state, but cannot create user-visible-observed, install untrusted tasks, or mutate provider/external-channel/protected surfaces",
    autopilotSurface:
      "lcx-governance-autopilot owners.commercialAcceptance and context handoff commercial gates",
    doctrineTerms: [
      "real CLI/browser/runtime tasks",
      "environment-state grading",
      "long-horizon canaries",
      "visible reply proof",
    ],
    currentStatus: "owner_wired_local_only",
    nextSafeLocalProbe:
      "add one LCX real-runtime canary that grades owner command output, artifact state, visible boundary wording, and no forbidden side effects",
    nextAutomationAction:
      "autopilot should keep runtime canary gaps visible through commercial acceptance and problem radar until a bounded canary fixture and side-effect audit exist",
    requiredProofChain: [
      "task_fixture",
      "deterministic_state_check",
      "semantic_visible_answer_check",
      "side_effect_audit",
      "commercial_acceptance_gate",
      "context_recovery_handoff",
    ],
    forbiddenAuthorities: [
      "leaderboard_driven_runtime_install",
      "untrusted_task_execution",
      "live_user_seen_claim_from_local_canary",
      "provider_config_change",
      "protected_memory_write",
    ],
    liveBoundary:
      "Real-runtime canaries are local proof until a migrated external-channel path sees fresh real inbound and outbound evidence.",
  },
  {
    id: "unified_trajectory_schema",
    priority: 3,
    label: "Unified trajectory schema",
    sourceCandidates: ["agent_lightning_trace_credit", "agent_trace_observability"],
    ownerEntrypoint: "scripts/operator/lcx-governance-autopilot.ts",
    automaticTrigger:
      "Every governance autopilot run already has owner id, command, exit status, parsed compact output, digest material, and artifact paths; future trace export must reuse this surface.",
    ownerGate:
      "trajectory export is offline evidence only and must not start RL, SFT, eval, training, provider calls, or external channel sender changes",
    autopilotSurface:
      "lcx-governance-autopilot receipt, evolution promotion digest, and context recovery handoff",
    doctrineTerms: [
      "owner command trace",
      "credit assignment",
      "tool call and PID linkage",
      "training transition export",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "emit one local trajectory receipt that links owner id, command, exit, parsed boundary, changed artifact, and blamed failure cluster",
    nextAutomationAction:
      "autopilot should expose missing trace_schema and failure_cluster_link as local-only next probes instead of inventing a parallel telemetry daemon",
    requiredProofChain: [
      "owner_run_trace",
      "artifact_side_effect_scope",
      "failure_cluster_link",
      "credit_assignment_label",
      "rejected_or_trainable_transition_decision",
      "no_runtime_training_started",
    ],
    forbiddenAuthorities: [
      "runtime_rl_server",
      "direct_training_start",
      "provider_config_change",
      "external_channel_sender_change",
      "protected_memory_write",
    ],
    liveBoundary:
      "Trajectory export is offline local evidence; external-channel behavior changes only after normal eval, promotion, and external-channel gates.",
  },
  {
    id: "local_first_memory_provenance",
    priority: 4,
    label: "Local-first memory provenance",
    sourceCandidates: [
      "local_first_memory_provenance",
      "longmemeval_agentrunbook_memory_regression",
      "lightweight_memory_comparison",
    ],
    ownerEntrypoint: "scripts/operator/lcx-learning-sedimentation-audit.ts",
    automaticTrigger:
      "When source registry, memory conflict, stale rule, retrieval, downrank, or MemX wording appears, route through sedimentation audit and module-learning review before durable claims.",
    ownerGate:
      "stored source, retrieved memory, or receipt is not model absorption; protected memory remains blocked unless the existing protected-memory owner explicitly permits it",
    autopilotSurface:
      "lcx-governance-autopilot owners.learningSedimentationAudit, moduleLearningAbsorptionGate, contextRecovery",
    doctrineTerms: [
      "source timestamp",
      "conflict preservation",
      "stale memory downrank",
      "keep/downrank/discard",
      "context recovery regression",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "produce a provenance packet for one stale finance-memory rule with source, scope, conflict, downrank decision, and adjacent eval case",
    nextAutomationAction:
      "autopilot should report missing source_registry_record, actual_reading_scope, retrieval/apply validation, and keep/downrank/discard proof before any absorption claim",
    requiredProofChain: [
      "source_registry_record",
      "actual_reading_scope",
      "retrieval_receipt",
      "apply_validation",
      "conflict_or_staleness_decision",
      "module_learning_pipeline_review",
      "eval_or_training_absorption_evidence",
    ],
    forbiddenAuthorities: [
      "new_memory_daemon_by_default",
      "protected_memory_write",
      "stored_only_learning_claim",
      "provider_config_change",
      "external_channel_sender_change",
    ],
    liveBoundary:
      "Live may read migrated provenance cues, but protected memory and model absorption stay behind existing proof gates.",
  },
  {
    id: "agent_trace_observability",
    priority: 5,
    label: "Agent trace and side-effect observability",
    sourceCandidates: ["agent_trace_observability"],
    ownerEntrypoint: "scripts/operator/lcx-governance-autopilot.ts",
    automaticTrigger:
      "When a workflow writes state, claims ownership, runs owner commands, or reports blocked/unblocked status, autopilot should preserve command, PID, artifact, and boundary evidence.",
    ownerGate:
      "only redacted local trace receipts are allowed by default; no eBPF, TLS interception, network export, provider config, protected memory, or external channel sender authority",
    autopilotSurface:
      "lcx-governance-autopilot material digest and future redacted local trace receipt",
    doctrineTerms: [
      "agent span",
      "tool span",
      "PID",
      "file side effect",
      "boundary",
      "failure attribution",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "write a redacted local trace receipt for one governance autopilot run without eBPF, TLS interception, or extra provider calls",
    nextAutomationAction:
      "autopilot should keep trace observability as a local receipt gap until redaction, artifact scope, and boundary flags pass",
    requiredProofChain: [
      "trace_schema",
      "owner_command_span",
      "artifact_write_span",
      "pid_snapshot",
      "boundary_flags",
      "redaction_check",
    ],
    forbiddenAuthorities: [
      "ebpf_or_tls_interception_without_explicit_approval",
      "network_trace_export_by_default",
      "provider_config_change",
      "protected_memory_write",
      "external_channel_sender_change",
    ],
    liveBoundary:
      "Dev traces may explain operator behavior; live trace summaries require explicit redaction and migration proof.",
  },
  {
    id: "secure_tool_skill_permission_layer",
    priority: 6,
    label: "Secure tool and skill permission layer",
    sourceCandidates: ["secure_tool_skill_permission_layer", "computer_use_cli_bridge"],
    ownerEntrypoint: skillEntrypoint("security-threat-model"),
    automaticTrigger:
      "When a task proposes a CLI wrapper, MCP server, external skill, browser/desktop bridge, credentialed tool, or install, route through skill-harvester plus security threat-model gates first.",
    ownerGate:
      "untrusted tools need allowlist, write-scope, credential-scope, prompt-injection, audit-log, and uninstall proof before any runtime or live authority",
    autopilotSurface:
      "external agent upgrade radar, skill-harvester boundary, and future security review receipt",
    doctrineTerms: [
      "tool allowlist",
      "least privilege",
      "credential scope",
      "audit log",
      "uninstall path",
      "prompt injection defense",
    ],
    currentStatus: "owner_wired_local_only",
    nextSafeLocalProbe:
      "score one proposed CLI wrapper, MCP server, or external skill through allowlist, write scope, credential scope, audit log, and uninstall path",
    nextAutomationAction:
      "autopilot should block direct adoption and surface the security review owner until the tool permission receipt exists",
    requiredProofChain: [
      "source_license_scope",
      "tool_allowlist_entry",
      "credential_scope_review",
      "write_scope_review",
      "prompt_injection_test",
      "audit_log_receipt",
      "uninstall_path",
    ],
    forbiddenAuthorities: [
      "untrusted_tool_authority",
      "global_install",
      "provider_config_change",
      "protected_memory_write",
      "external_channel_sender_change",
      "wallet_or_order_execution",
    ],
    liveBoundary:
      "No new tool or skill becomes live authority without security receipts, owner mapping, source sync, and explicit migration.",
  },
  {
    id: "github_cli_agentic_control_plane",
    priority: 7,
    label: "GitHub CLI agentic control plane",
    sourceCandidates: ["github_cli_agentic_workflow_control"],
    ownerEntrypoint: skillEntrypoint("cli-anything-harvester"),
    automaticTrigger:
      "When GitHub CLI, gh extension, GitHub MCP, gh-aw, Copilot CLI, issue agent, PR agent, or remote repo automation wording appears, external upgrade radar routes it to CLI-Anything plus security review before any write-capable command.",
    ownerGate:
      "read-only gh inventory is allowed; remote issue/PR writes, Copilot agent assignment, MCP server install, extension install, token scope expansion, and workflow dispatch require explicit owner command and receipt",
    autopilotSurface:
      "lcx-governance-autopilot owners.externalAgentUpgrade.nextBlacktechProbes plus future github_cli_capability_inventory receipt",
    doctrineTerms: [
      "gh as operator console",
      "read-only discovery first",
      "remote write owner approval",
      "credential scope",
      "extension install review",
      "agent delegation gate",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "add a read-only GitHub CLI capability inventory that reports gh version, auth scope status, installed extensions, current repo remote, and blocked remote-write commands",
    nextAutomationAction:
      "autopilot should surface GitHub CLI as an available but gated operator console, then refuse issue/PR mutation or Copilot delegation unless an owner command explicitly unlocks that lane",
    requiredProofChain: [
      "gh_version_detected",
      "auth_scope_inventory",
      "repo_scope_inventory",
      "installed_extension_inventory",
      "remote_write_blocklist",
      "dry_run_receipt",
      "owner_approval_for_remote_write",
    ],
    forbiddenAuthorities: [
      "gh_issue_or_pr_write_without_owner_command",
      "copilot_agent_assignment_without_owner_command",
      "mcp_server_install_without_security_receipt",
      "token_scope_expansion",
      "provider_config_change",
      "protected_memory_write",
      "external_channel_sender_change",
    ],
    liveBoundary:
      "GitHub CLI control-plane proof is local/operator-only; it cannot prove user-visible-observed or grant remote repository write authority by itself.",
  },
  {
    id: "finance_research_truth_and_guardrails",
    priority: 8,
    label: "Finance research truth and guardrails",
    sourceCandidates: [
      "individual_ai_hedge_fund",
      "trading_agents_finance_multi_agent",
      "finrobot_financial_research",
      "openbb_finance_data_platform",
      "agent_reach_source_adapter",
      "finnews_hunter_realtime_intelligence",
      "openfr_finance_research",
      "cameron_personal_finance_approval",
      "cents_thesis_research",
      "openalice_full_lifecycle_trading",
    ],
    ownerEntrypoint: "src/agents/finance-data-gateway.ts",
    automaticTrigger:
      "When a finance-agent, alpha model, valuation, backtest, portfolio, thesis, broker, or personal-finance write pattern appears, autopilot routes it through the finance data gateway, LogicalAgentPool, and review gates before any answer or adapter change.",
    ownerGate:
      "numbers need deterministic computation and source/timestamp/field provenance; local-model narration needs raw contract evidence; execution, money movement, wallet, and direct trade authority remain forbidden",
    autopilotSurface:
      "finance data gateway, LogicalAgentPool checkpoint receipt, local-brain-distill-eval, commercial answer pipeline, and review panel",
    doctrineTerms: [
      "numbers are code-calculated",
      "source timestamp and field definition",
      "bull/bear and adversarial review",
      "thesis and falsifier",
      "checkpoint restart proof",
      "research only",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "run one fixture-based finance DAG with deterministic numbers, source receipts, adversarial challenge, real local-model evidence, durable checkpoint restart, and a final no-trade precheck",
    nextAutomationAction:
      "autopilot should surface the finance fixture and exactly one idle-safe local-model/evidence step, while blocking providers, brokers, wallets, protected-memory writes, and external sends",
    blockedUntilIdle:
      "real local-model eval, adapter work, training, and any external binding must wait for the current local-brain guard/eval/MLX state to be idle",
    requiredProofChain: [
      "finance_source_registry_receipt",
      "field_definition_and_timestamp_receipt",
      "deterministic_finance_calculation_receipt",
      "logical_agent_checkpoint_restart_receipt",
      "real_local_model_execution_receipt",
      "raw_contract_or_explicit_hardening_receipt",
      "adversarial_review_receipt",
      "no_trade_authority_receipt",
    ],
    forbiddenAuthorities: [
      "llm_generated_financial_numbers",
      "model_conviction_as_calibrated_forecast",
      "broker_or_order_execution",
      "wallet_or_private_key_access",
      "money_movement",
      "provider_config_change",
      "protected_memory_write",
      "external_channel_sender_change",
    ],
    liveBoundary:
      "finance-agent patterns can improve local research and risk artifacts; they never by themselves create advice, execution, account, wallet, or user-visible authority",
  },
];

function missingFor(candidate: ExternalUpgradeCandidate): string[] {
  const missing: string[] = [];
  if (candidate.sourceUrls.length === 0) {
    missing.push("source_url");
  }
  if (!candidate.ownerEntrypoint) {
    missing.push("existing_owner_entrypoint");
  }
  if (!candidate.ownerUseTrigger) {
    missing.push("owner_use_trigger");
  }
  if (candidate.autocueTerms.length === 0) {
    missing.push("autocue_terms");
  }
  if (!candidate.distilledPattern) {
    missing.push("distilled_pattern");
  }
  if (!candidate.firstLocalProbe) {
    missing.push("first_local_probe");
  }
  if (candidate.requiredReceipts.length === 0) {
    missing.push("required_receipts");
  }
  if (candidate.requiredFilters.length === 0) {
    missing.push("required_filters");
  }
  if (candidate.riskBoundaries.length === 0) {
    missing.push("risk_boundaries");
  }
  return missing;
}

function staticSourceEvidence(): SourceEvidenceContract {
  return {
    registration: "static",
    status: "static_registration_only",
    receipts: {
      freshness: { status: "missing", receiptId: "source_freshness_receipt" },
      version: { status: "missing", receiptId: "source_version_receipt" },
      license_scope: { status: "missing", receiptId: "source_license_scope_receipt" },
      actual_reading_scope: {
        status: "missing",
        receiptId: "actual_reading_scope_receipt",
      },
    },
  };
}

function candidateVerdicts(): CandidateVerdict[] {
  return CANDIDATES.map((candidate) => ({
    ...candidate,
    status: "static_owner_mapping_registered",
    runtimeAuthority: "not_granted",
    missing: missingFor(candidate),
    blockedDirectAdoption: true,
    sourceEvidence: staticSourceEvidence(),
  }));
}

function blacktechMissingFor(mechanism: BlacktechMechanism): string[] {
  const missing: string[] = [];
  if (mechanism.sourceCandidates.length === 0) {
    missing.push("source_candidates");
  }
  if (!mechanism.ownerEntrypoint) {
    missing.push("owner_entrypoint");
  }
  if (!mechanism.automaticTrigger) {
    missing.push("automatic_trigger");
  }
  if (!mechanism.ownerGate) {
    missing.push("owner_gate");
  }
  if (!mechanism.autopilotSurface) {
    missing.push("autopilot_surface");
  }
  if (mechanism.doctrineTerms.length === 0) {
    missing.push("doctrine_terms");
  }
  if (!mechanism.nextSafeLocalProbe) {
    missing.push("next_safe_local_probe");
  }
  if (!mechanism.nextAutomationAction) {
    missing.push("next_automation_action");
  }
  if (mechanism.requiredProofChain.length === 0) {
    missing.push("required_proof_chain");
  }
  if (mechanism.forbiddenAuthorities.length === 0) {
    missing.push("forbidden_authorities");
  }
  if (!mechanism.liveBoundary) {
    missing.push("live_boundary");
  }
  return missing;
}

function blacktechVerdicts(): BlacktechVerdict[] {
  return BLACKTECH_MECHANISMS.map((mechanism) => ({
    ...mechanism,
    runtimeAuthority: "not_granted",
    liveReady: false,
    modelWeightAbsorbed: false,
    missing: blacktechMissingFor(mechanism),
  }));
}

function buildChecks(verdicts: readonly CandidateVerdict[]): RadarCheck[] {
  const ids = new Set(verdicts.map((candidate) => candidate.id));
  const expectedIds: CandidateId[] = [
    "skillopt_v2_autoskill_coach",
    "agent_lightning_trace_credit",
    "longmemeval_agentrunbook_memory_regression",
    "local_first_memory_provenance",
    "lightweight_memory_comparison",
    "agent_trace_observability",
    "secure_tool_skill_permission_layer",
    "clawbench_real_task_regression",
    "computer_use_cli_bridge",
    "github_cli_agentic_workflow_control",
    "multi_agent_framework_orchestration_guardrails",
    "individual_ai_hedge_fund",
    "trading_agents_finance_multi_agent",
    "finrobot_financial_research",
    "openbb_finance_data_platform",
    "agent_reach_source_adapter",
    "echoapi_api_test_harness",
    "finnews_hunter_realtime_intelligence",
    "openfr_finance_research",
    "amplio_crash_resume_harness",
    "cameron_personal_finance_approval",
    "cents_thesis_research",
    "openalice_full_lifecycle_trading",
    "prediction_market_research_intake",
    "prediction_market_strategy_audit",
  ];
  const missingExpected = expectedIds.filter((id) => !ids.has(id));
  const missingFields = verdicts.flatMap((candidate) =>
    candidate.missing.map((field) => `${candidate.id}:${field}`),
  );
  const unsafeRuntimeAuthority = verdicts.filter(
    (candidate) => candidate.runtimeAuthority !== "not_granted" || !candidate.blockedDirectAdoption,
  );
  const missingBoundaries = verdicts.filter(
    (candidate) =>
      !candidate.riskBoundaries.some((boundary) =>
        boundary.includes("no_provider_config_change"),
      ) &&
      !candidate.riskBoundaries.some((boundary) => boundary.includes("protected_memory_guard")),
  );
  const missingOwner = verdicts.filter((candidate) => !candidate.ownerEntrypoint);
  const missingUseTriggers = verdicts.filter(
    (candidate) => !candidate.ownerUseTrigger || candidate.autocueTerms.length === 0,
  );
  const sourceEvidenceGaps = verdicts.flatMap((candidate) =>
    Object.entries(candidate.sourceEvidence.receipts)
      .filter(([, receipt]) => receipt.status !== "verified")
      .map(([kind, receipt]) => `${candidate.id}:${kind}:${receipt.receiptId}`),
  );
  const sourceEvidenceStateErrors = verdicts
    .filter(
      (candidate) =>
        candidate.sourceEvidence.registration !== "static" ||
        candidate.sourceEvidence.status !== "static_registration_only",
    )
    .map((candidate) => candidate.id);
  return [
    {
      id: "expected_external_candidates_registered",
      ok: verdicts.length === expectedIds.length && missingExpected.length === 0,
      summary: "all expected external upgrade candidates are registered",
      evidence: { count: verdicts.length, missingExpected },
    },
    {
      id: "all_candidates_map_to_existing_owners",
      ok: missingOwner.length === 0,
      summary: "each external idea lands in an existing LCX owner instead of a parallel system",
      evidence: verdicts.map((candidate) => ({
        id: candidate.id,
        ownerEntrypoint: candidate.ownerEntrypoint,
      })),
    },
    {
      id: "source_to_distillation_contract_complete",
      ok: missingFields.length === 0,
      summary: "source, reading, distillation, receipt, filter, and probe fields are present",
      evidence: { missingFields },
    },
    {
      id: "automatic_use_triggers_present",
      ok: missingUseTriggers.length === 0,
      summary:
        "each external project has explicit autocue terms and an owner-use trigger for future agents",
      evidence: verdicts.map((candidate) => ({
        id: candidate.id,
        autocueTerms: candidate.autocueTerms,
        ownerUseTrigger: candidate.ownerUseTrigger,
      })),
    },
    {
      id: "source_registration_and_receipt_state_explicit",
      ok: sourceEvidenceStateErrors.length === 0,
      summary:
        "source URLs are static registrations; freshness, version, license scope, and actual reading scope remain separate receipt gates",
      evidence: {
        sourceEvidenceStateErrors,
        sourceReceiptKinds: ["freshness", "version", "license_scope", "actual_reading_scope"],
      },
    },
    {
      id: "source_receipts_not_claimed_verified",
      ok: sourceEvidenceGaps.length === verdicts.length * 4,
      summary:
        "the radar does not claim source freshness, version, license scope, or reading scope without receipts",
      evidence: {
        missingReceiptCount: sourceEvidenceGaps.length,
        expectedMissingReceiptCount: verdicts.length * 4,
        missingReceipts: sourceEvidenceGaps,
      },
    },
    {
      id: "direct_runtime_adoption_blocked",
      ok: unsafeRuntimeAuthority.length === 0,
      summary: "no external project receives runtime authority or direct install status",
      evidence: unsafeRuntimeAuthority.map((candidate) => candidate.id),
    },
    {
      id: "boundary_guards_present",
      ok: missingBoundaries.length === 0,
      summary:
        "provider, live, protected-memory, install, and execution boundaries remain explicit",
      evidence: verdicts.map((candidate) => ({
        id: candidate.id,
        riskBoundaries: candidate.riskBoundaries,
      })),
    },
  ];
}

function buildBlacktechChecks(
  mechanisms: readonly BlacktechVerdict[],
  candidateVerdicts: readonly CandidateVerdict[],
): RadarCheck[] {
  const mechanismIds = new Set(mechanisms.map((mechanism) => mechanism.id));
  const candidateIds = new Set(candidateVerdicts.map((candidate) => candidate.id));
  const expectedIds: BlacktechMechanismId[] = [
    "skillopt_v2_lifecycle",
    "real_runtime_battery",
    "unified_trajectory_schema",
    "local_first_memory_provenance",
    "agent_trace_observability",
    "secure_tool_skill_permission_layer",
    "github_cli_agentic_control_plane",
    "finance_research_truth_and_guardrails",
  ];
  const missingExpected = expectedIds.filter((id) => !mechanismIds.has(id));
  const missingFields = mechanisms.flatMap((mechanism) =>
    mechanism.missing.map((field) => `${mechanism.id}:${field}`),
  );
  const missingSourceCandidates = mechanisms.flatMap((mechanism) =>
    mechanism.sourceCandidates
      .filter((candidateId) => !candidateIds.has(candidateId))
      .map((candidateId) => `${mechanism.id}:${candidateId}`),
  );
  const unsafeAuthority = mechanisms.filter(
    (mechanism) =>
      mechanism.runtimeAuthority !== "not_granted" ||
      mechanism.liveReady ||
      mechanism.modelWeightAbsorbed,
  );
  const missingAutomationContract = mechanisms.filter(
    (mechanism) =>
      !mechanism.automaticTrigger ||
      !mechanism.ownerGate ||
      !mechanism.autopilotSurface ||
      !mechanism.nextAutomationAction,
  );
  return [
    {
      id: "expected_blacktech_mechanisms_registered",
      ok: mechanisms.length === expectedIds.length && missingExpected.length === 0,
      summary: "the prioritized blacktech mechanisms are registered",
      evidence: { count: mechanisms.length, missingExpected },
    },
    {
      id: "blacktech_sources_map_to_candidates",
      ok: missingSourceCandidates.length === 0,
      summary: "every blacktech mechanism maps back to registered source candidates",
      evidence: { missingSourceCandidates },
    },
    {
      id: "blacktech_owner_and_proof_contract_complete",
      ok: missingFields.length === 0,
      summary:
        "each blacktech mechanism has owner, doctrine, probe, proof, boundary, and forbidden authority fields",
      evidence: { missingFields },
    },
    {
      id: "blacktech_runtime_authority_blocked",
      ok: unsafeAuthority.length === 0,
      summary:
        "blacktech mechanisms are architecture intake only, not runtime/live/model-weight authority",
      evidence: unsafeAuthority.map((mechanism) => mechanism.id),
    },
    {
      id: "blacktech_autopilot_contract_complete",
      ok: missingAutomationContract.length === 0,
      summary:
        "each blacktech mechanism has automatic trigger, owner gate, autopilot surface, and next automation action",
      evidence: missingAutomationContract.map((mechanism) => mechanism.id),
    },
  ];
}

export function buildExternalAgentUpgradeRadar() {
  const candidates = candidateVerdicts();
  const blacktechMechanisms = blacktechVerdicts();
  const checks = [
    ...buildChecks(candidates),
    ...buildBlacktechChecks(blacktechMechanisms, candidates),
  ];
  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    boundary: "local_external_agent_upgrade_radar_only",
    proofLevel: "static_registration_only",
    executionStatus: "planning_contract_only",
    sourceContentRead: false,
    distillationExecuted: false,
    acceptanceEvalExecuted: false,
    predictionMarketPacketProduced: false,
    repoRoot,
    summary: {
      total: checks.length,
      failed: failed.length,
      registeredCandidateCount: candidates.length,
      // Compatibility count: this is registered owner mapping, not observed workflow execution.
      architectureIntegratedCountBasis: "static_owner_mapping_only",
      architectureIntegratedCount: candidates.filter(
        (candidate) => candidate.status === "static_owner_mapping_registered",
      ).length,
      sourceRegistrationOnlyCount: candidates.filter(
        (candidate) => candidate.sourceEvidence.status === "static_registration_only",
      ).length,
      sourceReceiptVerifiedCount: candidates.filter((candidate) =>
        Object.values(candidate.sourceEvidence.receipts).every(
          (receipt) => receipt.status === "verified",
        ),
      ).length,
      sourceReceiptMissingCount: candidates.reduce(
        (total, candidate) =>
          total +
          Object.values(candidate.sourceEvidence.receipts).filter(
            (receipt) => receipt.status !== "verified",
          ).length,
        0,
      ),
      sourceVerificationClaim: false,
      runtimeAuthorityGrantedCount: candidates.filter(
        (candidate) => candidate.runtimeAuthority !== "not_granted",
      ).length,
      blacktechMechanismCount: blacktechMechanisms.length,
      blacktechReadyLocalOnlyCountBasis: "registered_design_claim_not_observed_by_radar",
      blacktechReadyLocalOnlyCount: blacktechMechanisms.filter(
        (mechanism) => mechanism.currentStatus === "owner_wired_local_only",
      ).length,
      blacktechPartialLocalOnlyCount: blacktechMechanisms.filter(
        (mechanism) => mechanism.currentStatus === "partially_wired_local_only",
      ).length,
      blacktechRuntimeAuthorityGrantedCount: blacktechMechanisms.filter(
        (mechanism) => mechanism.runtimeAuthority !== "not_granted",
      ).length,
      blacktechAutopilotRoutedCountBasis: "registered_trigger_contract_only",
      blacktechAutopilotRoutedCount: blacktechMechanisms.filter(
        (mechanism) =>
          mechanism.automaticTrigger &&
          mechanism.ownerGate &&
          mechanism.autopilotSurface &&
          mechanism.nextAutomationAction,
      ).length,
      perfectIntegrationClaim: false,
    },
    architectureFit: "registered_to_existing_lcx_owner_stack",
    perfectIntegrationReason:
      "No external project should be called perfectly integrated until a concrete local probe, eval/receipt, external-channel migration, and fresh External visible proof all pass. This radar only registers owner paths and proposed patterns. It does not read source contents, verify owner wiring, execute distillation/security/review, or produce acceptance or prediction-market receipts.",
    checks,
    candidates,
    blacktechMechanisms,
    nextLocalProbes: candidates.map((candidate) => ({
      id: candidate.id,
      ownerEntrypoint: candidate.ownerEntrypoint,
      firstLocalProbe: candidate.firstLocalProbe,
    })),
    nextBlacktechProbes: blacktechMechanisms
      .toSorted((a, b) => a.priority - b.priority)
      .map((mechanism) => ({
        id: mechanism.id,
        priority: mechanism.priority,
        ownerEntrypoint: mechanism.ownerEntrypoint,
        automaticTrigger: mechanism.automaticTrigger,
        ownerGate: mechanism.ownerGate,
        autopilotSurface: mechanism.autopilotSurface,
        nextSafeLocalProbe: mechanism.nextSafeLocalProbe,
        nextAutomationAction: mechanism.nextAutomationAction,
        blockedUntilIdle: mechanism.blockedUntilIdle,
      })),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

function parseArgs(args: string[]) {
  const options: {
    json: boolean;
    workspaceDir?: string;
    manifestPath?: string;
    manifestSha256?: string;
    accountId?: string;
    runId?: string;
    predictionSource?: string;
    predictionSha256?: string;
    predictionVersion?: string;
  } = { json: false };
  const fields = {
    "--workspace": "workspaceDir",
    "--local-intake": "manifestPath",
    "--local-intake-sha256": "manifestSha256",
    "--intake-account-id": "accountId",
    "--intake-run-id": "runId",
    "--prediction-source": "predictionSource",
    "--prediction-source-sha256": "predictionSha256",
    "--prediction-source-version": "predictionVersion",
  } as const;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const field = fields[arg as keyof typeof fields];
    if (!field || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(
        "Usage: lcx-external-agent-upgrade-radar.ts [--json] [--local-intake FILE --local-intake-sha256 HASH --workspace DIR --intake-account-id ID --intake-run-id ID]",
      );
    }
    options[field] = args[++index];
  }
  if (
    [options.manifestPath, options.manifestSha256].some((value) => value !== undefined) &&
    ![
      options.manifestPath,
      options.manifestSha256,
      options.workspaceDir,
      options.accountId,
      options.runId,
    ].every(Boolean)
  ) {
    throw new Error("external_local_intake_explicit_host_and_pins_required");
  }
  if (
    [options.predictionSource, options.predictionSha256, options.predictionVersion].some(
      (value) => value !== undefined,
    ) &&
    ![
      options.predictionSource,
      options.predictionSha256,
      options.predictionVersion,
      options.workspaceDir,
      options.accountId,
      options.runId,
    ].every(Boolean)
  ) {
    throw new Error("prediction_intake_explicit_host_and_pins_required");
  }
  if (options.predictionSource && options.manifestPath) {
    throw new Error("prediction_and_external_intake_are_separate_attempts");
  }
  if ((options.accountId || options.runId) && !options.manifestPath && !options.predictionSource) {
    throw new Error("external_local_intake_explicit_host_and_pins_required");
  }
  return options;
}

function renderText(payload: ReturnType<typeof buildExternalAgentUpgradeRadar>): string {
  const lines = [
    `external agent upgrade radar ${payload.ok ? "ok" : "failed"}`,
    `boundary=${payload.boundary}`,
    `registeredCandidateCount=${payload.summary.registeredCandidateCount}`,
    `blacktechMechanismCount=${payload.summary.blacktechMechanismCount}`,
    `architectureFit=${payload.architectureFit}`,
    `proofLevel=${payload.proofLevel}`,
    `executionStatus=${payload.executionStatus}`,
    `sourceContentRead=${payload.sourceContentRead}`,
    `distillationExecuted=${payload.distillationExecuted}`,
    `acceptanceEvalExecuted=${payload.acceptanceEvalExecuted}`,
    `predictionMarketPacketProduced=${payload.predictionMarketPacketProduced}`,
    `perfectIntegrationClaim=${payload.summary.perfectIntegrationClaim}`,
    `sourceRegistrationOnlyCount=${payload.summary.sourceRegistrationOnlyCount}`,
    `sourceReceiptVerifiedCount=${payload.summary.sourceReceiptVerifiedCount}`,
    `sourceReceiptMissingCount=${payload.summary.sourceReceiptMissingCount}`,
    `sourceVerificationClaim=${payload.summary.sourceVerificationClaim}`,
    `runtimeAuthorityGrantedCount=${payload.summary.runtimeAuthorityGrantedCount}`,
    `liveTouched=${payload.liveTouched}`,
    `providerConfigTouched=${payload.providerConfigTouched}`,
    `protectedMemoryTouched=${payload.protectedMemoryTouched}`,
    "",
    "Candidates:",
    ...payload.candidates.map(
      (candidate) =>
        `- ${candidate.label}: owner=${candidate.ownerEntrypoint}; mode=${candidate.adoptionMode}; authority=${candidate.runtimeAuthority}`,
    ),
    "",
    "Blacktech mechanisms:",
    ...payload.blacktechMechanisms.map(
      (mechanism) =>
        `- ${mechanism.priority}. ${mechanism.label}: owner=${mechanism.ownerEntrypoint}; status=${mechanism.currentStatus}; authority=${mechanism.runtimeAuthority}`,
    ),
  ];
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(args);
  } catch (error) {
    const argumentError = error instanceof Error ? error.message : String(error);
    const payload = { ...buildExternalAgentUpgradeRadar(), ok: false, argumentError };
    process.stdout.write(
      args.includes("--json")
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${renderText(payload)}\nargument_error=${argumentError}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const localIntake = options.manifestPath
    ? await readExternalAgentLocalIntake({
        workspaceDir: options.workspaceDir!,
        manifest: { path: options.manifestPath, sha256: options.manifestSha256! },
        scope: { accountId: options.accountId!, runId: options.runId! },
      })
    : undefined;
  const radar = buildExternalAgentUpgradeRadar();
  const predictionIntake = options.predictionSource
    ? await readPredictionMarketResearchIntake({
        workspaceDir: options.workspaceDir!,
        source: {
          path: options.predictionSource,
          sha256: options.predictionSha256!,
          version: options.predictionVersion!,
        },
        scope: { accountId: options.accountId!, runId: options.runId! },
      })
    : undefined;
  const payload = {
    ...radar,
    ok: radar.ok && localIntake?.status !== "failed" && predictionIntake?.status !== "failed",
    ...(localIntake ? { localIntake } : {}),
    ...(predictionIntake ? { predictionIntake } : {}),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const localLines = localIntake
      ? [
          `local_intake=${localIntake.status}`,
          ...localIntake.gaps.map((gap) => `local_intake_gap=${gap}`),
          "local_intake_downstream_started=false",
        ]
      : [];
    const predictionLines = predictionIntake
      ? [
          `prediction_intake=${predictionIntake.status}`,
          ...predictionIntake.gaps.map((gap) => `prediction_intake_gap=${gap}`),
          "prediction_directional_conclusion_allowed=false",
        ]
      : [];
    process.stdout.write(
      `${[renderText(payload), ...localLines, ...predictionLines].join("\n")}\n`,
    );
  }
  if (!payload.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
