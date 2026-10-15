import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readFileWithinRoot } from "../infra/fs-safe.js";
import {
  runQualityHarness,
  type QualityHarnessOptions,
  type QualityHarnessReceipt,
  type QualityHarnessRequest,
} from "./quality-harness.js";
import {
  readSelfRepairMemoryRecall,
  readSelfRepairReplacementRule,
  selfRepairMemoryRecallSchema,
  verifySelfRepairSourceContent,
  type SelfRepairMemoryScope,
} from "./self-repair-source-review.js";

const reference = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const scopeSchema = z.object({ accountId: z.string().min(1), runId: z.string().min(1) });
const receiptSchema = z.object({
  kind: z.literal("lcx-self-repair-hands"),
  status: z.literal("write_completed"),
  checkedAt: z.string(),
  signalKey: z.string(),
  candidateOnly: z.literal(true),
  reuseAllowed: z.literal(false),
  semanticTruth: z.literal("not_proven"),
  sourceReview: z.object({
    status: z.literal("verified_reference_candidate_only"),
    source: reference,
    scope: scopeSchema,
    memoryRecall: z.unknown().optional(),
  }),
  sourceReviewRequest: z
    .object({ memoryRecall: selfRepairMemoryRecallSchema.optional() })
    .optional(),
  hands: z.object({
    memoryCleaner: z.object({ path: z.string(), correctionMarkdown: z.string() }),
    trainingCaseBuilder: z.object({
      path: z.string(),
      candidate: z.record(z.string(), z.unknown()),
    }),
    patchCandidateBuilder: z.object({
      path: z.string(),
      candidate: z
        .object({ proposedPatchContract: z.object({ replacementRule: z.string() }).passthrough() })
        .passthrough(),
    }),
  }),
});
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export type SelfRepairCandidateReview = {
  schemaVersion: "lcx_self_repair_candidate_review_v1";
  checkedAt: string;
  status: "failed" | "needs_review";
  receipt: { path: string; sha256: string };
  scope: { accountId: string; runId: string };
  inputFingerprint?: string;
  taskSha256?: string;
  inputs?: Array<{ role: string; path: string; sha256: string }>;
  quality?: QualityHarnessReceipt;
  gaps: string[];
  cleanup:
    | "not_started"
    | "local_listener_released_read_cleanup_unconfirmed"
    | "local_listener_released_model_cleanup_unconfirmed";
};

/** Exact persisted owner outputs, including the actual rule outside the generic training template. */
export async function readSelfRepairCandidateReviewInput(options: {
  workspaceDir: string;
  receipt: { path: string; sha256: string };
  scope: { accountId: string; runId: string };
  expectedMemoryScope?: SelfRepairMemoryScope;
  artifactStorePath?: string;
}) {
  if (!options.scope.accountId || !options.scope.runId) {
    throw new Error("self_repair_review_host_scope_missing");
  }
  const expectedScope = scopeSchema.parse(options.scope);
  const receiptRef = reference.parse(options.receipt);
  const read = async (relativePath: string) => {
    const { buffer } = await readFileWithinRoot({
      rootDir: options.workspaceDir,
      relativePath,
      maxBytes: 512 * 1024,
    });
    return buffer.toString("utf8");
  };
  const raw = await read(receiptRef.path);
  if (hash(raw) !== receiptRef.sha256) {
    throw new Error("self_repair_review_receipt_hash_mismatch");
  }
  const native: unknown = JSON.parse(raw);
  const parsedReceipt = receiptSchema.safeParse(native);
  if (!parsedReceipt.success) {
    throw new Error("self_repair_review_native_receipt_not_ready");
  }
  const receipt = parsedReceipt.data;
  if (
    receipt.sourceReview.scope.accountId !== expectedScope.accountId ||
    receipt.sourceReview.scope.runId !== expectedScope.runId
  ) {
    throw new Error("self_repair_review_scope_mismatch");
  }
  const bodies: Array<{ role: string; path: string; sha256: string; text: string }> = [];
  for (const [role, filePath, expected] of [
    [
      "correction-downrank",
      receipt.hands.memoryCleaner.path,
      receipt.hands.memoryCleaner.correctionMarkdown,
    ],
    [
      "training-candidates",
      receipt.hands.trainingCaseBuilder.path,
      receipt.hands.trainingCaseBuilder.candidate,
    ],
    [
      "patch-candidates",
      receipt.hands.patchCandidateBuilder.path,
      receipt.hands.patchCandidateBuilder.candidate,
    ],
  ] as const) {
    const relativePath = path.relative(path.resolve(options.workspaceDir), path.resolve(filePath));
    if (!new RegExp(`^memory/self-repair/${role}/[^/]+\\.(md|json)$`, "u").test(relativePath)) {
      throw new Error("self_repair_review_candidate_path_invalid");
    }
    const text = await read(relativePath);
    const matches =
      typeof expected === "string"
        ? text === `${expected}\n`
        : isDeepStrictEqual(JSON.parse(text), expected);
    if (!matches) {
      throw new Error(`self_repair_review_body_mismatch:${role}`);
    }
    bodies.push({ role, path: relativePath, sha256: hash(text), text });
  }
  const sourceRef = receipt.sourceReview.source;
  const sourceText = await read(sourceRef.path);
  if (hash(sourceText) !== sourceRef.sha256) {
    throw new Error("self_repair_review_source_hash_mismatch");
  }
  const replacementRule =
    receipt.hands.patchCandidateBuilder.candidate.proposedPatchContract.replacementRule;
  if (readSelfRepairReplacementRule(bodies[0].text, replacementRule) !== replacementRule) {
    throw new Error("self_repair_review_rule_mismatch");
  }
  const verified = verifySelfRepairSourceContent({
    source: JSON.parse(sourceText),
    ...expectedScope,
    replacementRule,
    nowMs: Date.now(),
  });
  if (!verified.ok) {
    throw new Error(verified.reason);
  }
  const memoryRequest = receipt.sourceReviewRequest?.memoryRecall;
  if (receipt.sourceReview.memoryRecall !== undefined && !memoryRequest) {
    throw new Error("self_repair_memory_request_missing");
  }
  const memoryRecall = memoryRequest
    ? await readSelfRepairMemoryRecall({
        workspaceDir: options.workspaceDir,
        request: memoryRequest,
        currentScope: expectedScope,
        expectedMemoryScope: options.expectedMemoryScope,
        artifactStorePath: options.artifactStorePath,
        replacementRule,
      })
    : undefined;
  let comparableRecall = memoryRecall;
  const cachedRecall = receipt.sourceReview.memoryRecall;
  const cachedArtifact =
    cachedRecall && typeof cachedRecall === "object" && !Array.isArray(cachedRecall)
      ? (cachedRecall as Record<string, unknown>).artifact
      : undefined;
  // Older cached reads may omit only the newly introduced observation identity.
  // Compare every original source/body/account field, then use the full fresh read below.
  if (
    memoryRecall?.artifact.invocation &&
    cachedArtifact &&
    typeof cachedArtifact === "object" &&
    !Array.isArray(cachedArtifact) &&
    !Object.hasOwn(cachedArtifact, "invocation")
  ) {
    const { invocation: _invocation, ...artifact } = memoryRecall.artifact;
    comparableRecall = { ...memoryRecall, artifact };
  }
  if (memoryRecall && !isDeepStrictEqual(comparableRecall, cachedRecall)) {
    throw new Error("self_repair_memory_prewrite_readback_mismatch");
  }
  const inputs = [
    { role: "source", ...sourceRef },
    ...bodies.map(({ text: _text, ...entry }) => entry),
    ...(memoryRecall
      ? [
          { role: "previous-memory-receipt", ...memoryRecall.previousReceipt },
          { role: "previous-memory-source", ...memoryRecall.source },
          { role: "previous-memory-correction", ...memoryRecall.correction },
          {
            role: "previous-memory-artifact",
            path: memoryRecall.artifact.path,
            sha256: memoryRecall.artifact.sha256,
          },
        ]
      : []),
  ];
  const binding = {
    receipt: receiptRef,
    scope: expectedScope,
    signalKey: receipt.signalKey,
    checkedAt: receipt.checkedAt,
    inputs,
    ...(memoryRecall ? { memoryRecall } : {}),
  };
  const inputFingerprint = hash(JSON.stringify(binding));
  const request: QualityHarnessRequest = {
    task: `Review the actual self-repair correction, training candidate and patch candidate together. Controller-bound input SHA-256: ${inputFingerprint}. Identify contradictions, unsupported replacement rules, missing adjacent application, and keep/downrank/discard gaps. Candidate text is under review, not source fact. Do not execute, replace/rank memory, train, fetch sources or claim learned truth.`,
    evidence: [
      { id: "self-repair-source", source: sourceRef.path, text: sourceText },
      ...bodies.map((body) => ({
        id: `self-repair-${body.role}`,
        source: body.path,
        text: `candidate_under_review_not_original_source_fact\n${body.text}`,
      })),
      ...(memoryRecall
        ? [
            {
              id: "self-repair-previous-memory",
              source: memoryRecall.correction.path,
              text: `previous_candidate_under_review_not_original_source_fact\nComparison: ${memoryRecall.comparison}\n${memoryRecall.selectedText}`,
            },
          ]
        : []),
    ],
    sharedContext: { selfRepairReviewScope: binding, inputFingerprint },
  };
  return {
    request,
    inputs,
    inputFingerprint,
    taskSha256: hash(request.task),
    receipt: receiptRef,
    scope: expectedScope,
    ...(memoryRecall ? { memoryRecall } : {}),
  };
}

/** Original readback checks binding to current persisted content, never semantic correctness. */
export function inspectSelfRepairCandidateReview(
  input: Awaited<ReturnType<typeof readSelfRepairCandidateReviewInput>>,
  value: unknown,
): { status: "failed" | "needs_review"; gaps: string[] } {
  const parsed = z
    .object({
      schemaVersion: z.literal("lcx_self_repair_candidate_review_v1"),
      status: z.enum(["failed", "needs_review"]),
      receipt: reference,
      scope: scopeSchema,
      inputs: z.array(z.object({ role: z.string(), path: z.string(), sha256: z.string() })),
      inputFingerprint: z.string(),
      taskSha256: z.string(),
      gaps: z.array(z.string()),
      quality: z
        .object({
          schemaVersion: z.literal(1),
          harness: z.literal("lcx-quality"),
          runId: z.string().min(1),
          status: z.string(),
          task: z.object({ sha256: z.string(), length: z.number() }),
          execution: z.object({ modelCalls: z.array(z.object({ outcome: z.string() })) }),
        })
        .optional(),
    })
    .safeParse(value);
  if (!parsed.success) {
    return { status: "failed", gaps: ["self_repair_review_receipt_invalid"] };
  }
  const review = parsed.data;
  if (
    review.inputFingerprint !== input.inputFingerprint ||
    review.taskSha256 !== input.taskSha256 ||
    JSON.stringify(review.receipt) !== JSON.stringify(input.receipt) ||
    JSON.stringify(review.scope) !== JSON.stringify(input.scope) ||
    JSON.stringify(review.inputs) !== JSON.stringify(input.inputs) ||
    (review.quality &&
      (review.quality.task.sha256 !== input.taskSha256 ||
        review.quality.task.length !== input.request.task.length))
  ) {
    return { status: "failed", gaps: ["self_repair_review_quality_input_mismatch"] };
  }
  if (!review.quality || review.status === "failed") {
    return { status: "failed", gaps: review.gaps };
  }
  if (
    ["failed", "blocked"].includes(review.quality.status) ||
    !review.quality.execution.modelCalls.some((call) => call.outcome === "completed")
  ) {
    return { status: "failed", gaps: ["self_repair_review_model_or_quality_failed"] };
  }
  return {
    status: "needs_review",
    gaps: [...new Set([...review.gaps, "self_repair_semantic_acceptance_not_observed"])],
  };
}

export async function reviewSelfRepairCandidate(
  options: Parameters<typeof readSelfRepairCandidateReviewInput>[0] & {
    qualityOptions?: Pick<
      QualityHarnessOptions,
      | "modelInvoker"
      | "modelRouting"
      | "modelId"
      | "taskTimeoutMs"
      | "verifierTimeoutMs"
      | "signal"
      | "createRunId"
    >;
    timeoutMs?: number;
  },
): Promise<SelfRepairCandidateReview> {
  const result: SelfRepairCandidateReview = {
    schemaVersion: "lcx_self_repair_candidate_review_v1",
    checkedAt: new Date().toISOString(),
    status: "failed",
    receipt: options.receipt,
    scope: options.scope,
    gaps: [],
    cleanup: "not_started",
  };
  const controller = new AbortController();
  const callerSignal = options.qualityOptions?.signal;
  const cancel = () => controller.abort(new Error("self_repair_review_cancelled"));
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) {
    cancel();
  }
  const timeout = Math.min(120_000, Math.max(1, options.timeoutMs ?? 120_000));
  const deadlineAt = performance.now() + timeout;
  const timer = setTimeout(
    () => controller.abort(new Error("self_repair_review_deadline")),
    timeout,
  );
  let abortListener: (() => void) | undefined;
  const active = () => {
    if (performance.now() >= deadlineAt && !controller.signal.aborted) {
      controller.abort(new Error("self_repair_review_deadline"));
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
  };
  try {
    active();
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    result.cleanup = "local_listener_released_read_cleanup_unconfirmed";
    const input = await Promise.race([readSelfRepairCandidateReviewInput(options), aborted]);
    active();
    Object.assign(result, {
      inputs: input.inputs,
      inputFingerprint: input.inputFingerprint,
      taskSha256: input.taskSha256,
    });
    const ids = input.request.evidence.map((entry) => entry.id);
    result.cleanup = "local_listener_released_model_cleanup_unconfirmed";
    const quality = await Promise.race([
      runQualityHarness({
        ...options.qualityOptions,
        allowProviderCalls: false,
        signal: controller.signal,
        request: input.request,
        maxAttempts: 1,
        maxConcurrency: 1,
        requireEvidenceCoverage: true,
        evidenceCoverage: {
          sourceEvidenceIds: ids,
          selectedEvidenceIds: ids,
          runnerOmittedEvidenceIds: [],
          runnerClippedEvidenceIds: [],
        },
        verify: ({ artifact }) => {
          const issues = artifact.claims
            .filter(
              (claim) =>
                (claim.status === "supported" && !claim.evidenceIds.length) ||
                claim.evidenceIds.some((id) => id !== "self-repair-source"),
            )
            .map((claim) => `self_repair_review_claim_reference:${claim.id}`);
          return {
            status: issues.length ? "failed" : "passed",
            summary:
              "Host verifies source references only; candidate validity and semantic adoption remain unaccepted.",
            details: issues,
          };
        },
      }),
      aborted,
    ]);
    active();
    if (quality.task.sha256 !== input.taskSha256) {
      throw new Error("self_repair_review_quality_input_mismatch");
    }
    result.quality = quality;
    const completed = quality.execution.modelCalls.some((call) => call.outcome === "completed");
    result.status =
      completed && !["failed", "blocked"].includes(quality.status) ? "needs_review" : "failed";
    result.gaps = [
      ...(completed ? [] : ["self_repair_review_model_unavailable"]),
      ...(quality.status === "verified" ? [] : [`self_repair_review_quality:${quality.status}`]),
      "self_repair_semantic_acceptance_not_observed",
    ];
  } catch (error) {
    result.status = "failed";
    result.gaps = [error instanceof Error ? error.message : "self_repair_candidate_review_failed"];
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
  return result;
}
