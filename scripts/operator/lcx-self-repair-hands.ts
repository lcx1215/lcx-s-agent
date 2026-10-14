import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  inspectSelfRepairCandidateReview,
  readSelfRepairCandidateReviewInput,
  reviewSelfRepairCandidate,
  type SelfRepairCandidateReview,
} from "../../src/agents/self-repair-candidate-review.js";
import {
  readSelfRepairOwnerMapFeedback,
  type SelfRepairOwnerMapFeedback,
} from "../../src/agents/self-repair-owner-map-feedback.js";
import {
  readSelfRepairMemoryRecall,
  readSelfRepairReplacementRule,
  verifySelfRepairSourceContent,
  type SelfRepairMemoryRecallRequest,
  type SelfRepairMemoryScope,
} from "../../src/agents/self-repair-source-review.js";
import { openWritableFileWithinRoot, readFileWithinRoot } from "../../src/infra/fs-safe.js";
import {
  DEFAULT_WORKSPACE_DIR,
  SELF_REPAIR_HANDS_JSONL_PATH,
  SELF_REPAIR_HANDS_LATEST_PATH,
  SELF_REPAIR_HANDS_MARKDOWN_PATH,
} from "./lcx-local-paths.ts";

type CliOptions = {
  json: boolean;
  write: boolean;
  workspaceDir: string;
  signalKey: string;
  issue: string;
  observedFailure: string;
  replacementRule: string;
  domain: string;
  sourceReviewPath?: string;
  reviewAccountId?: string;
  reviewRunId?: string;
  memorySourceRunId?: string;
  artifactStorePath?: string;
  candidateReviewPath?: string;
  ownerMapFeedbackPath?: string;
  feedbackHostPath?: string;
};

type SelfRepairSourceReviewRequest = {
  schemaVersion: number;
  source?: { path: string; sha256: string };
  expectedScope: { accountId: string; runId: string };
  memoryRecall?: SelfRepairMemoryRecallRequest;
  expectedMemoryScope?: SelfRepairMemoryScope;
  artifactStorePath?: string;
  manifestReadError?: string;
};

type SelfRepairInput = {
  checkedAt: string;
  workspaceDir: string;
  signalKey: string;
  issue: string;
  observedFailure: string;
  replacementRule: string;
  domain: string;
  write: boolean;
  sourceReview?: SelfRepairSourceReviewRequest;
  diagnosticFeedback?: SelfRepairOwnerMapFeedback;
  diagnosticFeedbackRequest?: { request: unknown; host: unknown };
};

type SelfRepairProcessEvidence = {
  schemaVersion: 1;
  input?: {
    sha256: string;
    bytes: number;
    summary: { issue: string; domain: string; replacementRule: string };
  };
  branches: {
    field: string;
    inputSha256: string;
    pathSha256?: string;
    intendedBytes: { sha256: string; bytes: number };
    disposition: "candidate_only_not_adopted";
  }[];
  gates: {
    allowlist: string;
    source: string;
    diagnostic: string;
    reasons: string[];
    consumedPaths?: { field: string; pathSha256: string }[];
    consumedSource?: { status: string; source?: { path: string; sha256: string } };
    candidateWritesAllowed?: boolean;
  };
  writer: {
    status: "not_started" | "writing" | "completed" | "failed";
    successfulWrites: { field: string; sha256: string; bytes: number }[];
    candidateEligibility?: boolean;
    publicationInputs?: {
      candidateWritesAllowed: boolean;
      successfulWritesSha256: string;
      memoryTier: string;
      correctionSha256?: string;
      trainingSha256?: string;
    };
    publicationSource?: { successfulWritesSha256: string; memoryTier: string };
    diskReadback: "not_observed";
    publication: "not_started" | "pending_in_snapshot" | "completed_after_await" | "failed";
    failure?: { field: string; reason: string; persistence: "not_confirmed" };
  };
};

function shortEvidenceText(value: string, maxBytes: number) {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) {
      break;
    }
    result += character;
  }
  return result;
}

function byteEvidence(body: string) {
  return {
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    bytes: Buffer.byteLength(body),
  };
}

async function readDiagnosticFeedbackReadback(
  workspaceDir: string,
  latest: Record<string, unknown>,
): Promise<SelfRepairOwnerMapFeedback | undefined> {
  const stored = latest.diagnosticFeedback;
  if (stored === undefined) {
    return undefined;
  }
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const request = asRecord(latest.diagnosticFeedbackRequest);
  const host = asRecord(request?.host);
  const readback = await readSelfRepairOwnerMapFeedback(
    workspaceDir,
    request?.request,
    host ? { ...host, nowMs: Date.now() } : request?.host,
  );
  const prior = asRecord(stored);
  if (prior?.status === "blocked") {
    const blockers = Array.isArray(prior.blockers)
      ? prior.blockers.filter((value): value is string => typeof value === "string")
      : [];
    return {
      ...readback,
      status: "blocked",
      blockers: [
        ...new Set([
          ...(blockers.length ? blockers : ["owner_map_feedback_prior_attempt_blocked"]),
          ...(readback.status === "blocked" ? readback.blockers : []),
        ]),
      ],
      diagnostic: undefined,
      fieldRefs: undefined,
    };
  }
  return readback.status === "read" && !isDeepStrictEqual(stored, readback)
    ? { ...readback, status: "blocked", blockers: ["owner_map_feedback_content_conflict"] }
    : readback;
}

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-self-repair-hands.ts [--json] [--write]",
      "       [--workspace-dir DIR] [--signal-key TEXT] [--issue TEXT] [--observed-failure TEXT]",
      "       [--replacement-rule TEXT] [--domain TEXT]",
      "       [--source-review FILE --review-account-id ID --review-run-id ID]",
      "       [--memory-source-run-id ID --artifact-store-path RELATIVE_PATH]",
      "       [--candidate-review FILE --review-account-id ID --review-run-id ID]",
      "       [--owner-map-feedback FILE --feedback-host FILE]",
      "",
      "Builds or writes the three safe LCX self-repair hands:",
      "1) memory correction/downrank note, 2) training/eval candidate packet,",
      "3) repo patch candidate plan.",
      "It never edits repo source, external channel sender, provider config, protected memory,",
      "formal language corpus, or training processes.",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    write: false,
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    signalKey: "manual_finance_analysis_self_repair_probe",
    issue: "finance_analysis_self_repair_probe",
    observedFailure:
      "A finance answer or memory rule may be stale, overconfident, missing evidence, or missing a targeted eval case.",
    replacementRule:
      "Write a correction/downrank note and a training/eval candidate packet; require source evidence, fresh adjacent application, review, and keep/downrank/discard before claiming learned capability.",
    domain: "finance_memory_and_training_case_repair",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--workspace-dir") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--signal-key") {
      options.signalKey = readValue(args, index);
      index += 1;
    } else if (arg === "--issue") {
      options.issue = readValue(args, index);
      index += 1;
    } else if (arg === "--observed-failure") {
      options.observedFailure = readValue(args, index);
      index += 1;
    } else if (arg === "--replacement-rule") {
      options.replacementRule = readValue(args, index);
      index += 1;
    } else if (arg === "--domain") {
      options.domain = readValue(args, index);
      index += 1;
    } else if (arg === "--source-review") {
      options.sourceReviewPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--review-account-id") {
      options.reviewAccountId = readValue(args, index);
      index += 1;
    } else if (arg === "--review-run-id") {
      options.reviewRunId = readValue(args, index);
      index += 1;
    } else if (arg === "--memory-source-run-id") {
      options.memorySourceRunId = readValue(args, index);
      index += 1;
    } else if (arg === "--artifact-store-path") {
      options.artifactStorePath = readValue(args, index);
      index += 1;
    } else if (arg === "--candidate-review") {
      options.candidateReviewPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--owner-map-feedback") {
      options.ownerMapFeedbackPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--feedback-host") {
      options.feedbackHostPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 72);
  return slug || "self-repair";
}

function timeSlug(value: string): string {
  return value.replace(/[:.]/gu, "-");
}

function hashShort(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  const relative = path.relative(workspaceDir, filePath);
  return relative.startsWith("..") ? filePath : relative;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertAllowedWrite(workspaceDir: string, filePath: string) {
  const allowedRoots = [
    path.join(workspaceDir, "memory", "self-repair"),
    path.join(workspaceDir, "state"),
    path.join(workspaceDir, "logs"),
  ];
  if (!allowedRoots.some((root) => isInside(root, filePath) || root === filePath)) {
    throw new Error(`Self-repair write path is outside allowlist: ${filePath}`);
  }
}

function buildCorrectionMarkdown(input: SelfRepairInput, correctionId: string): string {
  return [
    `# LCX Self-Repair Correction: ${correctionId}`,
    "",
    `- checkedAt: ${input.checkedAt}`,
    `- signalKey: ${input.signalKey}`,
    `- issue: ${input.issue}`,
    `- domain: ${input.domain}`,
    "- memoryTier: provisional_downrank",
    "- writer: lcx_self_repair_memory_cleaner",
    "- boundary: local_self_repair_memory_correction_only",
    "",
    "## Observed Failure",
    `- ${input.observedFailure}`,
    "",
    "## Replacement Rule",
    `- ${input.replacementRule}`,
    "",
    "## Downrank Decision",
    "- old_or_conflicting_memory: downrank_until_fresher_source_and_adjacent_application",
    "- keep_downrank_or_discard: downrank",
    "- reason: stale_or_unverified_finance_memory_must_not_override_current_evidence",
    "",
    "## Required Proof Before Reuse",
    "- source_registry_record",
    "- memory_recall_scope_or_relevant_receipts",
    "- fresh_current_data_or_source_timestamp_when_needed",
    "- fresh_adjacent_application_task",
    "- review_panel_decision",
    "- local_brain_eval_or_training_candidate_if_the_failure_is_reusable",
    "",
    "## Not Touched",
    "- repo_source",
    "- external_channel_sender",
    "- provider_config",
    "- protected_memory",
    "- formal_language_corpus",
    "- training_processes",
    "",
  ].join("\n");
}

function buildTrainingCandidate(input: SelfRepairInput, candidateId: string) {
  const userAsk =
    "本地记忆或金融分析规则可能过期、缺证据或和外部模型判断冲突。请先写纠错/降权记录，再生成可复用的评测题候选，不要直接改受保护记忆、不要启动训练、不要给交易建议。";
  return {
    id: candidateId,
    kind: "lcx-self-repair-training-eval-candidate",
    boundary: "local_training_candidate_only_not_absorbed",
    checkedAt: input.checkedAt,
    signalKey: input.signalKey,
    issue: input.issue,
    domain: input.domain,
    source: "lcx_self_repair_training_case_builder",
    evalCaseCandidate: {
      id: candidateId,
      userAsk,
      sourceSummary:
        "self-repair candidate for dirty/stale finance memory and missing eval coverage; must produce correction/downrank and training-material plan without claiming model absorption.",
      requiredModules: [
        "finance_learning_memory",
        "source_registry",
        "data_provenance_quality",
        "causal_map",
        "portfolio_risk_gates",
        "review_panel",
        "control_room_summary",
        "eval_harness_design",
      ],
      minModuleMatches: 6,
      requiredMissingData: [
        "memory_recall_scope_or_relevant_receipts",
        "source_registry_record",
        "fresh_adjacent_application_task",
        "keep_downrank_or_discard_decision",
      ],
      requiredRiskBoundaries: [
        "research_only",
        "do_not_promote_unverified_memory_claims",
        "stored_receipt_not_model_absorption",
        "no_trade_advice",
      ],
    },
    trainExampleCandidate: {
      prompt: [
        "You are the LCX Agent local auxiliary thought-flow model.",
        "Task: produce a concise control-room planning packet for the main agent.",
        "Do not answer the finance question directly.",
        "Return only compact JSON.",
        "",
        `source_kind: self_repair_candidate`,
        `signal_key: ${input.signalKey}`,
        `user_or_task: ${userAsk}`,
        `source_summary: ${input.observedFailure}`,
      ].join("\n"),
      completion: JSON.stringify({
        task_family: "finance_memory_training_self_repair",
        primary_modules: [
          "finance_learning_memory",
          "source_registry",
          "data_provenance_quality",
          "causal_map",
          "review_panel",
          "control_room_summary",
          "eval_harness_design",
        ],
        supporting_modules: ["portfolio_risk_gates"],
        required_tools: [],
        missing_data: [
          "memory_recall_scope_or_relevant_receipts",
          "source_registry_record",
          "fresh_adjacent_application_task",
          "keep_downrank_or_discard_decision",
        ],
        risk_boundaries: [
          "research_only",
          "do_not_promote_unverified_memory_claims",
          "stored_receipt_not_model_absorption",
          "no_trade_advice",
        ],
        next_step: "write_correction_and_candidate_then_review",
        rejected_context: [
          "protected_memory_write",
          "direct_training_restart",
          "trade_or_execution_language",
        ],
      }),
    },
    absorptionStatus: "candidate_only_not_in_train_slice",
    nextOwnerReview: [
      "review candidate packet",
      "run focused non-MLX contract checks",
      "append to train/eval material only through owner-approved path",
    ],
    notTouched: [
      "repo_source",
      "external_channel_sender",
      "provider_config",
      "protected_memory",
      "formal_language_corpus",
      "training_processes",
    ],
  };
}

function buildPatchCandidate(input: SelfRepairInput, patchCandidateId: string) {
  return {
    id: patchCandidateId,
    kind: "lcx-self-repair-repo-patch-candidate",
    boundary: "local_repo_patch_candidate_only_not_applied",
    checkedAt: input.checkedAt,
    signalKey: input.signalKey,
    issue: input.issue,
    domain: input.domain,
    source: "lcx_self_repair_patch_candidate_builder",
    purpose:
      "Let LCX Agent propose a bounded repo repair plan that Codex and owner surfaces can review before any source edit.",
    proposedPatchContract: {
      failureFamily: input.observedFailure,
      replacementRule: input.replacementRule,
      candidateOnly: true,
      canEditRepoSource: false,
      canCommit: false,
      ownerReviewRequired: true,
      filesToInspect: [
        "scripts/operator/local-brain-contracts.ts",
        "scripts/operator/local-brain-distill-eval.ts",
        "scripts/operator/lcx-skillopt-lite.ts",
        "scripts/operator/lcx-governance-autopilot.ts",
        "test/focused-owner-test-for-this-failure.test.ts",
      ],
      requiredChecks: [
        "pnpm vitest run test/lcx-self-repair-hands.test.ts test/lcx-owner-control-map.test.ts",
        "run focused owner test named by the candidate before applying a repo patch",
        "rerun lcx-governance-autopilot after any accepted repo patch",
      ],
      stopConditions: [
        "active_training_or_eval_reads_mutable_repo_code",
        "patch_would_touch_external_channel_sender",
        "patch_would_touch_provider_config",
        "patch_would_touch_protected_memory",
        "patch_would_start_training_or_mlx",
        "patch_has_no_owner_lane_or_test",
      ],
    },
    nextOwnerReview: [
      "classify candidate into owner lane",
      "let Codex inspect the exact proposed files",
      "convert to repo patch only after active heavy work is idle or the patch is proven not to affect active runtime",
      "run focused tests before commit",
    ],
    notTouched: [
      "repo_source",
      "git_index",
      "git_commit",
      "external_channel_sender",
      "provider_config",
      "protected_memory",
      "formal_language_corpus",
      "training_processes",
    ],
  };
}

function selfRepairPaths(workspaceDir: string) {
  return {
    latestJsonPath:
      workspaceDir === DEFAULT_WORKSPACE_DIR
        ? SELF_REPAIR_HANDS_LATEST_PATH
        : path.join(workspaceDir, "state", "lcx-self-repair-hands-latest.json"),
    latestMarkdownPath:
      workspaceDir === DEFAULT_WORKSPACE_DIR
        ? SELF_REPAIR_HANDS_MARKDOWN_PATH
        : path.join(workspaceDir, "state", "lcx-self-repair-hands-latest.md"),
    jsonlPath:
      workspaceDir === DEFAULT_WORKSPACE_DIR
        ? SELF_REPAIR_HANDS_JSONL_PATH
        : path.join(workspaceDir, "logs", "lcx-self-repair-hands.jsonl"),
  };
}

export function buildSelfRepairHandsReceipt(input: SelfRepairInput) {
  const diagnosticFeedback =
    input.diagnosticFeedback && !input.diagnosticFeedbackRequest
      ? {
          ...input.diagnosticFeedback,
          status: "blocked" as const,
          blockers: ["owner_map_feedback_request_missing"],
        }
      : input.diagnosticFeedback;
  const diagnosticBlocked = diagnosticFeedback?.status === "blocked";
  const workspaceDir = path.resolve(input.workspaceDir);
  const paths = selfRepairPaths(workspaceDir);
  const stamp = timeSlug(input.checkedAt);
  const baseSlug = `${slugify(input.issue)}-${hashShort(
    `${input.issue}|${input.observedFailure}|${input.replacementRule}`,
  )}`;
  const correctionId = `self-repair-${baseSlug}`;
  const candidateId = `self_repair_${slugify(input.domain).replace(/-/gu, "_")}_${hashShort(
    baseSlug,
  )}`;
  const correctionPath = path.join(
    workspaceDir,
    "memory",
    "self-repair",
    "correction-downrank",
    `${stamp}-${baseSlug}.md`,
  );
  const candidatePath = path.join(
    workspaceDir,
    "memory",
    "self-repair",
    "training-candidates",
    `${stamp}-${baseSlug}.json`,
  );
  const patchCandidatePath = path.join(
    workspaceDir,
    "memory",
    "self-repair",
    "patch-candidates",
    `${stamp}-${baseSlug}.json`,
  );
  const correctionInputSha256 = byteEvidence(JSON.stringify(input)).sha256;
  const correctionMarkdown = buildCorrectionMarkdown(input, correctionId);
  const trainingInputSha256 = byteEvidence(JSON.stringify(input)).sha256;
  const trainingCandidate = buildTrainingCandidate(input, candidateId);
  const patchInputSha256 = byteEvidence(JSON.stringify(input)).sha256;
  const patchCandidate = buildPatchCandidate(input, `patch_candidate_${hashShort(baseSlug)}`);
  const writtenArtifacts: string[] = [];
  const inputBytes = JSON.stringify(input);
  const inputEvidence = byteEvidence(inputBytes);
  const processEvidence: SelfRepairProcessEvidence = {
    schemaVersion: 1,
    input: {
      ...inputEvidence,
      summary: {
        issue: shortEvidenceText(input.issue, 64),
        domain: shortEvidenceText(input.domain, 64),
        replacementRule: shortEvidenceText(input.replacementRule, 160),
      },
    },
    branches: [
      {
        field: "/hands/memoryCleaner/correctionMarkdown",
        body: `${correctionMarkdown}\n`,
        inputSha256: correctionInputSha256,
        pathSha256: byteEvidence(correctionPath).sha256,
      },
      {
        field: "/hands/trainingCaseBuilder/candidate",
        inputSha256: trainingInputSha256,
        pathSha256: byteEvidence(candidatePath).sha256,
        body: `${JSON.stringify(trainingCandidate, null, 2)}\n`,
      },
      {
        field: "/hands/patchCandidateBuilder/candidate",
        inputSha256: patchInputSha256,
        pathSha256: byteEvidence(patchCandidatePath).sha256,
        body: `${JSON.stringify(patchCandidate, null, 2)}\n`,
      },
    ].map(({ field, body, inputSha256, pathSha256 }) => ({
      field,
      inputSha256,
      pathSha256,
      intendedBytes: byteEvidence(body),
      disposition: "candidate_only_not_adopted",
    })),
    gates: {
      allowlist: "not_observed",
      source: "not_observed",
      diagnostic: "not_observed",
      reasons: [],
    },
    writer: {
      status: "not_started",
      successfulWrites: [],
      diskReadback: "not_observed",
      publication: "not_started",
    },
  };
  const markdown = diagnosticBlocked
    ? [
        "# LCX Self-Repair Hands",
        "status: blocked",
        `diagnosticFeedback: ${diagnosticFeedback?.blockers.join("; ")}`,
        "Candidate artifacts were not written.",
      ].join("\n")
    : [
        "# LCX Self-Repair Hands",
        "",
        `checkedAt: ${input.checkedAt}`,
        "boundary: local_self_repair_hands_only",
        "",
        "一句话：LCX Agent 现在可以自己写允许范围内的记忆纠错/降权记录、训练/评测候选题包、repo 补丁候选计划，但不能自己改 repo 源码、提交、启动训练、碰 live/provider/protected memory。",
        "",
        "## 三只手",
        `- 记忆清洁手：${input.write ? "待写入" : "可写入"} ${correctionPath}`,
        `- 题库修复手：${input.write ? "待写入" : "可写入"} ${candidatePath}`,
        `- 补丁候选手：${input.write ? "待写入" : "可写入"} ${patchCandidatePath}`,
        "",
        "## 监督入口",
        `- latestJson: ${paths.latestJsonPath}`,
        `- latestMarkdown: ${paths.latestMarkdownPath}`,
        `- jsonl: ${paths.jsonlPath}`,
        "",
        "## 下一步",
        "- Codex 或总控读取 latest/jsonl 后，只能审查并吸收到 owner-approved 训练/评测或 repo patch 路径。",
        "- 下一轮训练必须等候当前重活结束，并且等候训练计划确认安全。",
        "",
        "## 不允许",
        "- 不改 repo source",
        "- 不 git add/commit/push",
        "- 不碰 external channel sender/provider config/protected memory/formal language corpus",
        "- 不启动 guard/eval/MLX/lora",
        "",
      ].join("\n");

  return {
    ok: !diagnosticBlocked,
    kind: "lcx-self-repair-hands",
    boundary: "local_self_repair_hands_only",
    checkedAt: input.checkedAt,
    signalKey: input.signalKey,
    status: diagnosticBlocked
      ? "blocked"
      : input.write
        ? input.sourceReview
          ? "awaiting_source_review"
          : "awaiting_write"
        : "dry_run_ready",
    candidateOnly: true,
    reuseAllowed: false,
    semanticTruth: "not_proven",
    sourceReviewRequest: input.sourceReview,
    diagnosticFeedback,
    diagnosticFeedbackRequest: input.diagnosticFeedbackRequest,
    sourceReview: {
      requested: input.sourceReview !== undefined,
      status: input.sourceReview ? "pending" : "not_requested",
      blockers: [] as string[],
      source: input.sourceReview?.source,
      scope: input.sourceReview?.expectedScope,
      observedAt: undefined as string | undefined,
      memoryRecall: undefined as Awaited<ReturnType<typeof readSelfRepairMemoryRecall>> | undefined,
      reuseAllowed: false,
      semanticTruth: "not_proven",
    },
    workspaceDir,
    issue: input.issue,
    domain: input.domain,
    allowlistedWriteRoots: [
      path.join(workspaceDir, "memory", "self-repair"),
      path.join(workspaceDir, "state"),
      path.join(workspaceDir, "logs"),
    ],
    hands: {
      memoryCleaner: {
        ok: !diagnosticBlocked,
        canWriteWithoutCodex: !diagnosticBlocked,
        action: "write_correction_downrank_note",
        path: correctionPath,
        relativePath: relativeToWorkspace(workspaceDir, correctionPath),
        memoryTier: "provisional_downrank",
        correctionMarkdown,
      },
      trainingCaseBuilder: {
        ok: !diagnosticBlocked,
        canWriteWithoutCodex: !diagnosticBlocked,
        action: "write_training_eval_candidate_packet",
        path: candidatePath,
        relativePath: relativeToWorkspace(workspaceDir, candidatePath),
        absorptionStatus: "candidate_only_not_in_train_slice",
        candidate: trainingCandidate,
      },
      patchCandidateBuilder: {
        ok: !diagnosticBlocked,
        canWriteWithoutCodex: !diagnosticBlocked,
        action: "write_repo_patch_candidate_plan",
        path: patchCandidatePath,
        relativePath: relativeToWorkspace(workspaceDir, patchCandidatePath),
        absorptionStatus: "candidate_only_not_applied_to_repo",
        candidate: patchCandidate,
      },
    },
    supervision: {
      codexCanReview: true,
      governanceCanSeeLatest: true,
      ownerControlMapCanSurface: true,
      localFailureTraceCanIndex: true,
      nextReviewCommand: "node --import tsx scripts/operator/lcx-self-repair-hands.ts --json",
      proofCommand:
        "pnpm vitest run test/lcx-self-repair-hands.test.ts test/lcx-owner-control-map.test.ts",
    },
    processEvidence: processEvidence as SelfRepairProcessEvidence | undefined,
    writtenArtifacts,
    latestJsonPath: paths.latestJsonPath,
    latestMarkdownPath: paths.latestMarkdownPath,
    jsonlPath: paths.jsonlPath,
    markdown,
    nextSafeAction: diagnosticBlocked
      ? "repair_owner_map_feedback_reference_then_create_new_candidate_receipt"
      : input.write
        ? "review_self_repair_packets_then_absorb_through_owner_approved_train_eval_or_patch_path"
        : "rerun_with_write_when_owner_allows_memory_candidate_and_patch_plan_writes",
    notTouched: [
      "repo_source",
      "git_index",
      "git_commit",
      "external_channel_sender",
      "provider_config",
      "protected_memory",
      "formal_language_corpus",
      "training_processes",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

export type SelfRepairHandsReceipt = ReturnType<typeof buildSelfRepairHandsReceipt>;

export async function writeSelfRepairHandsReceipt(receipt: SelfRepairHandsReceipt) {
  const workspaceDir = path.resolve(receipt.workspaceDir);
  const correctionPath = receipt.hands.memoryCleaner.path;
  const candidatePath = receipt.hands.trainingCaseBuilder.path;
  const patchCandidatePath = receipt.hands.patchCandidateBuilder.path;
  // Legacy receipts remain writable; their original input is not reconstructed or claimed.
  const evidence = (receipt.processEvidence ??= {
    schemaVersion: 1,
    branches: [],
    gates: {
      allowlist: "not_observed",
      source: "not_observed",
      diagnostic: "not_observed",
      reasons: [],
    },
    writer: {
      status: "not_started",
      successfulWrites: [],
      diskReadback: "not_observed",
      publication: "not_started",
    },
  });
  const writeFailed = () => evidence.writer.status === "failed";
  if (writeFailed()) {
    throw new Error("self_repair_prior_write_failed_create_new_receipt");
  }
  if (evidence.writer.status === "not_started") {
    receipt.writtenArtifacts = [];
  }
  const recordWrite = (field: string, body: string) => {
    const record = { field, ...byteEvidence(body) };
    const prior = evidence.writer.successfulWrites.findIndex((item) => item.field === field);
    if (prior === -1) {
      evidence.writer.successfulWrites.push(record);
    } else {
      evidence.writer.successfulWrites[prior] = record;
    }
  };
  let activeField = "/allowlistedWriteRoots";
  try {
    evidence.gates.consumedPaths = [];
    for (const filePath of [
      correctionPath,
      candidatePath,
      patchCandidatePath,
      receipt.latestJsonPath,
      receipt.latestMarkdownPath,
      receipt.jsonlPath,
    ]) {
      assertAllowedWrite(workspaceDir, filePath);
      const field =
        filePath === correctionPath
          ? "/hands/memoryCleaner/correctionMarkdown"
          : filePath === candidatePath
            ? "/hands/trainingCaseBuilder/candidate"
            : filePath === patchCandidatePath
              ? "/hands/patchCandidateBuilder/candidate"
              : undefined;
      if (field) {
        evidence.gates.consumedPaths.push({ field, pathSha256: byteEvidence(filePath).sha256 });
      }
    }
    evidence.gates.allowlist = "allowed_by_original_write_roots";
  } catch (error) {
    evidence.gates.allowlist = "blocked";
    evidence.gates.reasons = ["write_path_outside_allowlist"];
    receipt.ok = false;
    receipt.status = "write_failed";
    evidence.writer.status = "failed";
    evidence.writer.failure = {
      field: activeField,
      reason: "write_path_outside_allowlist",
      persistence: "not_confirmed",
    };
    throw error;
  }
  const diagnosticRequest = receipt.diagnosticFeedbackRequest;
  if (diagnosticRequest && receipt.diagnosticFeedback?.status !== "blocked") {
    const readback = await readSelfRepairOwnerMapFeedback(
      workspaceDir,
      diagnosticRequest.request,
      diagnosticRequest.host,
    );
    receipt.diagnosticFeedback =
      readback.status === "read" && !isDeepStrictEqual(readback, receipt.diagnosticFeedback)
        ? { ...readback, status: "blocked", blockers: ["owner_map_feedback_content_conflict"] }
        : readback;
  }
  const requested = receipt.sourceReviewRequest;
  if (requested && receipt.sourceReview.status !== "blocked") {
    let failure: string | undefined;
    let observedAt: string | undefined;
    try {
      if (requested.manifestReadError) {
        throw new Error(requested.manifestReadError);
      }
      if (requested.schemaVersion !== 1 || !requested.source) {
        throw new Error("source_review_manifest_invalid");
      }
      const sourceRef = requested.source;
      if (
        typeof sourceRef.path !== "string" ||
        typeof sourceRef.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(sourceRef.sha256)
      ) {
        throw new Error("source_reference_invalid");
      }
      let buffer: Buffer;
      try {
        ({ buffer } = await readFileWithinRoot({
          rootDir: workspaceDir,
          relativePath: sourceRef.path,
          maxBytes: 512 * 1024,
        }));
      } catch {
        throw new Error("source_evidence_unreadable");
      }
      if (crypto.createHash("sha256").update(buffer).digest("hex") !== sourceRef.sha256) {
        throw new Error("source_sha256_mismatch");
      }
      const replacementRule =
        receipt.hands.patchCandidateBuilder.candidate.proposedPatchContract.replacementRule;
      if (
        readSelfRepairReplacementRule(
          receipt.hands.memoryCleaner.correctionMarkdown,
          replacementRule,
        ) !== replacementRule
      ) {
        throw new Error("correction_replacement_rule_source_mismatch");
      }
      const sourceReview = verifySelfRepairSourceContent({
        source: JSON.parse(buffer.toString("utf8")),
        accountId: requested.expectedScope.accountId,
        runId: requested.expectedScope.runId,
        replacementRule,
        nowMs: Date.now(),
      });
      if (!sourceReview.ok) {
        throw new Error(sourceReview.reason);
      }
      observedAt = sourceReview.observedAt;
      if (requested.memoryRecall !== undefined) {
        receipt.sourceReview.memoryRecall = await readSelfRepairMemoryRecall({
          workspaceDir,
          request: requested.memoryRecall,
          currentScope: requested.expectedScope,
          expectedMemoryScope: requested.expectedMemoryScope,
          artifactStorePath: requested.artifactStorePath,
          replacementRule,
        });
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : "source_review_invalid";
    }
    // A failed concurrent/earlier attempt is terminal for this receipt, even if a read arrives late.
    if (failure) {
      receipt.sourceReview.status = "blocked";
      receipt.sourceReview.blockers = [failure];
      receipt.sourceReview.memoryRecall = undefined;
    } else if (receipt.sourceReview.status !== "blocked") {
      receipt.sourceReview.status = "verified_reference_candidate_only";
      receipt.sourceReview.observedAt = observedAt;
    }
  }
  evidence.gates.consumedSource = {
    status: receipt.sourceReview.status,
    source: requested?.source ? { ...requested.source } : undefined,
  };
  const diagnosticBlocked = receipt.diagnosticFeedback?.status === "blocked";
  if (receipt.sourceReview.status === "blocked" || diagnosticBlocked) {
    receipt.ok = false;
    receipt.status = "blocked";
    receipt.hands.memoryCleaner.ok = false;
    receipt.hands.memoryCleaner.canWriteWithoutCodex = false;
    receipt.hands.trainingCaseBuilder.ok = false;
    receipt.hands.trainingCaseBuilder.canWriteWithoutCodex = false;
    receipt.hands.patchCandidateBuilder.ok = false;
    receipt.hands.patchCandidateBuilder.canWriteWithoutCodex = false;
    receipt.nextSafeAction = diagnosticBlocked
      ? "repair_owner_map_feedback_reference_then_create_new_candidate_receipt"
      : "repair_source_review_evidence_then_create_new_candidate_receipt";
    receipt.markdown = [
      "# LCX Self-Repair Hands",
      "status: blocked",
      `sourceReview: ${receipt.sourceReview.blockers.join("; ")}`,
      `diagnosticFeedback: ${receipt.diagnosticFeedback?.blockers.join("; ") ?? "not_requested"}`,
      "Candidate artifacts were not written. Reuse, replacement, ranking and training remain unconfirmed.",
    ].join("\n");
  }
  evidence.gates.source = receipt.sourceReview.status;
  evidence.gates.diagnostic = receipt.diagnosticFeedback?.status ?? "not_requested";
  evidence.gates.reasons = [
    ...receipt.sourceReview.blockers,
    ...(receipt.diagnosticFeedback?.blockers ?? []),
  ]
    .slice(0, 3)
    .map((reason) => shortEvidenceText(reason, 96));
  if (writeFailed()) {
    throw new Error("self_repair_prior_write_failed_create_new_receipt");
  }
  evidence.writer.status = "writing";
  const blocked = receipt.sourceReview.status === "blocked" || diagnosticBlocked;
  evidence.gates.candidateWritesAllowed = !blocked;
  // This is the actual decision consumed by the candidate-write branch, not a quality approval.
  evidence.writer.candidateEligibility = evidence.gates.candidateWritesAllowed;
  if (!blocked) {
    receipt.status = "writing";
  }
  const write = async (field: string, filePath: string, body: string, append = false) => {
    if (writeFailed()) {
      throw new Error("self_repair_prior_write_failed_create_new_receipt");
    }
    activeField = field;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (append) {
      await fs.appendFile(filePath, body);
    } else {
      await fs.writeFile(filePath, body);
    }
    // This witnesses fulfilled I/O only; the submitted-byte hash is not a disk readback.
    recordWrite(field, body);
    if (!receipt.writtenArtifacts.includes(filePath)) {
      receipt.writtenArtifacts.push(filePath);
    }
    if (writeFailed()) {
      throw new Error("self_repair_prior_write_failed_create_new_receipt");
    }
  };
  try {
    if (evidence.writer.candidateEligibility) {
      await write(
        "/hands/memoryCleaner/correctionMarkdown",
        correctionPath,
        `${receipt.hands.memoryCleaner.correctionMarkdown}\n`,
      );
      await write(
        "/hands/trainingCaseBuilder/candidate",
        candidatePath,
        `${JSON.stringify(receipt.hands.trainingCaseBuilder.candidate, null, 2)}\n`,
      );
      await write(
        "/hands/patchCandidateBuilder/candidate",
        patchCandidatePath,
        `${JSON.stringify(receipt.hands.patchCandidateBuilder.candidate, null, 2)}\n`,
      );
      receipt.markdown = receipt.markdown.replaceAll("待写入", "已写入");
    }
    evidence.writer.publication = "pending_in_snapshot";
    await write("/latestMarkdownPath", receipt.latestMarkdownPath, `${receipt.markdown}\n`);
    // Content completion is compatible with the original review schema. Publication remains pending.
    const publicationCandidateEligibility = !blocked;
    const snapshotStatus = publicationCandidateEligibility ? "write_completed" : "blocked";
    await write(
      "/jsonlPath",
      receipt.jsonlPath,
      `${JSON.stringify({ ...receipt, status: snapshotStatus })}\n`,
      true,
    );
    if (writeFailed()) {
      throw new Error("self_repair_prior_write_failed_create_new_receipt");
    }
    activeField = "/latestJsonPath";
    await fs.mkdir(path.dirname(receipt.latestJsonPath), { recursive: true });
    evidence.writer.publicationSource = {
      successfulWritesSha256: byteEvidence(JSON.stringify(evidence.writer.successfulWrites)).sha256,
      memoryTier: receipt.hands.memoryCleaner.memoryTier,
    };
    const latestSnapshot = { ...receipt, status: snapshotStatus };
    // Recompute from the exact snapshot passed to serialization; this is not a disk readback.
    evidence.writer.publicationInputs = {
      candidateWritesAllowed: publicationCandidateEligibility,
      successfulWritesSha256: byteEvidence(
        JSON.stringify(latestSnapshot.processEvidence?.writer.successfulWrites ?? []),
      ).sha256,
      memoryTier: latestSnapshot.hands.memoryCleaner.memoryTier,
      ...(blocked
        ? {}
        : {
            correctionSha256: byteEvidence(
              `${latestSnapshot.hands.memoryCleaner.correctionMarkdown}\n`,
            ).sha256,
            trainingSha256: byteEvidence(
              `${JSON.stringify(latestSnapshot.hands.trainingCaseBuilder.candidate, null, 2)}\n`,
            ).sha256,
          }),
    };
    const latestBody = `${JSON.stringify(latestSnapshot, null, 2)}\n`;
    await fs.writeFile(receipt.latestJsonPath, latestBody);
    recordWrite(activeField, latestBody);
    if (writeFailed()) {
      throw new Error("self_repair_prior_write_failed_create_new_receipt");
    }
    if (!receipt.writtenArtifacts.includes(receipt.latestJsonPath)) {
      receipt.writtenArtifacts.push(receipt.latestJsonPath);
    }
    receipt.status = snapshotStatus;
    evidence.writer.status = "completed";
    evidence.writer.publication = "completed_after_await";
  } catch (error) {
    receipt.ok = false;
    receipt.status = "write_failed";
    evidence.writer.status = "failed";
    evidence.writer.publication = "failed";
    evidence.writer.failure = {
      field: activeField,
      reason: error instanceof Error ? shortEvidenceText(error.message, 180) : "write_failed",
      persistence: "not_confirmed",
    };
    receipt.nextSafeAction = "inspect_partial_write_then_create_new_candidate_receipt";
    throw error;
  }
}

/** New review receipts may not alias an original candidate/receipt, even inside the workspace. */
async function writeCandidateReviewFile(
  workspaceDir: string,
  relativePath: string,
  data: string,
  append = false,
) {
  const opened = await openWritableFileWithinRoot({
    rootDir: workspaceDir,
    relativePath,
    truncateExisting: false,
  });
  try {
    const expectedPath = path.join(await fs.realpath(workspaceDir), relativePath);
    if (opened.openedRealPath !== expectedPath) {
      throw new Error("self_repair_review_write_alias_rejected");
    }
    if (!append) {
      await opened.handle.truncate(0);
      await opened.handle.writeFile(data, "utf8");
    } else {
      const bytes = Buffer.from(data, "utf8");
      let offset = 0;
      const start = (await opened.handle.stat()).size;
      while (offset < bytes.length) {
        const { bytesWritten } = await opened.handle.write(
          bytes,
          offset,
          bytes.length - offset,
          start + offset,
        );
        if (!bytesWritten) {
          throw new Error("self_repair_review_write_incomplete");
        }
        offset += bytesWritten;
      }
    }
  } finally {
    await opened.handle.close();
  }
}

export async function writeSelfRepairContentReviewReceipt(
  options: Parameters<typeof readSelfRepairCandidateReviewInput>[0],
  contentReview: SelfRepairCandidateReview,
) {
  if (contentReview.status !== "failed") {
    const input = await readSelfRepairCandidateReviewInput(options);
    const inspected = inspectSelfRepairCandidateReview(input, contentReview);
    if (inspected.status === "failed") {
      throw new Error(inspected.gaps.join("; "));
    }
  }
  await writeCandidateReviewFile(
    options.workspaceDir,
    "state/lcx-self-repair-content-review-latest.json",
    `${JSON.stringify(contentReview, null, 2)}\n`,
  );
  await writeCandidateReviewFile(
    options.workspaceDir,
    "logs/lcx-self-repair-content-review.jsonl",
    `${JSON.stringify(contentReview)}\n`,
    true,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidateReviewReceiptPath = path.join(
    options.workspaceDir,
    "state",
    "lcx-self-repair-content-review-latest.json",
  );
  if (options.candidateReviewPath) {
    const scope = { accountId: options.reviewAccountId ?? "", runId: options.reviewRunId ?? "" };
    const memoryHost = {
      expectedMemoryScope: options.memorySourceRunId
        ? { accountId: scope.accountId, runId: options.memorySourceRunId }
        : undefined,
      artifactStorePath: options.artifactStorePath,
    };
    let contentReview: SelfRepairCandidateReview;
    try {
      const manifest = JSON.parse(await fs.readFile(options.candidateReviewPath, "utf8")) as {
        receipt: { path: string; sha256: string };
      };
      contentReview = await reviewSelfRepairCandidate({
        workspaceDir: options.workspaceDir,
        receipt: manifest.receipt,
        scope,
        ...memoryHost,
      });
    } catch {
      contentReview = {
        schemaVersion: "lcx_self_repair_candidate_review_v1",
        checkedAt: new Date().toISOString(),
        status: "failed",
        receipt: { path: "", sha256: "" },
        scope,
        gaps: ["self_repair_review_manifest_unreadable"],
        cleanup: "not_started",
      };
    }
    // Explicit review writes only its own receipt; it never recreates or replaces candidate files.
    if (options.write) {
      assertAllowedWrite(options.workspaceDir, candidateReviewReceiptPath);
      const log = path.join(options.workspaceDir, "logs", "lcx-self-repair-content-review.jsonl");
      assertAllowedWrite(options.workspaceDir, log);
      try {
        await writeSelfRepairContentReviewReceipt(
          {
            workspaceDir: options.workspaceDir,
            receipt: contentReview.receipt,
            scope,
            ...memoryHost,
          },
          contentReview,
        );
      } catch (error) {
        contentReview = {
          ...contentReview,
          status: "failed",
          gaps: [
            ...contentReview.gaps,
            `self_repair_review_write_failed:${error instanceof Error ? error.message : "unknown"}`,
          ],
        };
        process.exitCode = 1;
      }
    }
    console.log(
      JSON.stringify(
        {
          kind: "lcx-self-repair-hands",
          boundary: "local_self_repair_hands_only",
          status: contentReview.status,
          ok: contentReview.status !== "failed",
          checkedAt: contentReview.checkedAt,
          contentReview,
          candidateOnly: true,
          reuseAllowed: false,
          semanticTruth: "not_proven",
          liveTouched: false,
          providerConfigTouched: false,
          protectedMemoryTouched: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  let sourceReview: SelfRepairSourceReviewRequest | undefined;
  if (options.sourceReviewPath) {
    sourceReview = {
      schemaVersion: 0,
      expectedScope: { accountId: options.reviewAccountId ?? "", runId: options.reviewRunId ?? "" },
      expectedMemoryScope: options.memorySourceRunId
        ? { accountId: options.reviewAccountId ?? "", runId: options.memorySourceRunId }
        : undefined,
      artifactStorePath: options.artifactStorePath,
    };
    try {
      const manifest = JSON.parse(await fs.readFile(options.sourceReviewPath, "utf8")) as {
        schemaVersion: number;
        source?: SelfRepairSourceReviewRequest["source"];
        memoryRecall?: SelfRepairMemoryRecallRequest;
      };
      sourceReview.schemaVersion = manifest.schemaVersion;
      sourceReview.source = manifest.source;
      sourceReview.memoryRecall = manifest.memoryRecall;
    } catch {
      sourceReview.manifestReadError = "source_review_manifest_unreadable";
    }
  }
  let diagnosticFeedback: SelfRepairOwnerMapFeedback | undefined;
  let diagnosticFeedbackRequest: { request: unknown; host: unknown } | undefined;
  if (options.ownerMapFeedbackPath || options.feedbackHostPath) {
    const readFeedbackJson = async (
      file: string | undefined,
      failure: string,
    ): Promise<unknown> => {
      try {
        if (!file) {
          throw new Error(failure);
        }
        const { buffer } = await readFileWithinRoot({
          rootDir: options.workspaceDir,
          relativePath: path.relative(options.workspaceDir, file),
          maxBytes: 512 * 1024,
        });
        return JSON.parse(buffer.toString("utf8")) as unknown;
      } catch {
        return { readError: failure };
      }
    };
    diagnosticFeedbackRequest = {
      request: await readFeedbackJson(
        options.ownerMapFeedbackPath,
        "owner_map_feedback_manifest_unreadable",
      ),
      host: await readFeedbackJson(options.feedbackHostPath, "owner_map_feedback_host_unreadable"),
    };
    diagnosticFeedback = await readSelfRepairOwnerMapFeedback(
      options.workspaceDir,
      diagnosticFeedbackRequest.request,
      diagnosticFeedbackRequest.host,
    );
  }
  const receipt = buildSelfRepairHandsReceipt({
    checkedAt: new Date().toISOString(),
    workspaceDir: options.workspaceDir,
    signalKey: options.signalKey,
    issue: options.issue,
    observedFailure:
      diagnosticFeedback?.status === "read"
        ? `${options.observedFailure}\n${diagnosticFeedback.diagnostic}`
        : options.observedFailure,
    replacementRule: options.replacementRule,
    diagnosticFeedback,
    diagnosticFeedbackRequest,
    domain: options.domain,
    write: options.write,
    sourceReview,
  });
  if (options.write) {
    await writeSelfRepairHandsReceipt(receipt);
  }
  let output: Record<string, unknown> = receipt;
  if (!options.write && !diagnosticFeedback) {
    const latestBytes = await fs.readFile(receipt.latestJsonPath).catch(() => undefined);
    const latestRaw = latestBytes?.toString("utf8");
    if (latestBytes && latestRaw) {
      const latestReceiptSha256 = crypto.createHash("sha256").update(latestBytes).digest("hex");
      const latest = JSON.parse(latestRaw) as Record<string, unknown>;
      output = {
        ...receipt,
        latestWrittenReceipt: {
          // This pins only the bytes observed here; source truth and reuse stay unproven.
          receipt: {
            path: receipt.latestJsonPath,
            sha256: latestReceiptSha256,
          },
          status: latest.status,
          checkedAt: latest.checkedAt,
          signalKey: latest.signalKey,
          issue: latest.issue,
          domain: latest.domain,
          processEvidence: latest.processEvidence,
          sourceReview: latest.sourceReview,
          diagnosticFeedback: latest.diagnosticFeedback,
          diagnosticFeedbackReadback: await readDiagnosticFeedbackReadback(
            options.workspaceDir,
            latest,
          ),
          candidateOnly: latest.candidateOnly,
          reuseAllowed: latest.reuseAllowed,
          semanticTruth: latest.semanticTruth,
          nextSafeAction: latest.nextSafeAction,
          writtenArtifacts: latest.writtenArtifacts,
          latestJsonPath: receipt.latestJsonPath,
          latestMarkdownPath: receipt.latestMarkdownPath,
          jsonlPath: receipt.jsonlPath,
        },
      };
      const reviewRaw = await fs
        .readFile(candidateReviewReceiptPath, "utf8")
        .catch(() => undefined);
      if (reviewRaw) {
        const latestSourceReviewRequest = latest.sourceReviewRequest as
          | { memoryRecall?: unknown }
          | undefined;
        const memoryHostMissing =
          latestSourceReviewRequest?.memoryRecall !== undefined &&
          (!options.memorySourceRunId || !options.artifactStorePath);
        if (!options.reviewAccountId || !options.reviewRunId || memoryHostMissing) {
          output.contentReview = {
            status: "not_observed",
            gaps: [
              memoryHostMissing
                ? "self_repair_memory_host_unavailable"
                : "self_repair_review_host_scope_unavailable",
            ],
            receiptPath: candidateReviewReceiptPath,
          };
        } else {
          try {
            const review: unknown = JSON.parse(reviewRaw);
            const input = await readSelfRepairCandidateReviewInput({
              workspaceDir: options.workspaceDir,
              receipt: {
                path: path.relative(options.workspaceDir, receipt.latestJsonPath),
                sha256: latestReceiptSha256,
              },
              scope: { accountId: options.reviewAccountId ?? "", runId: options.reviewRunId ?? "" },
              expectedMemoryScope: options.memorySourceRunId
                ? { accountId: options.reviewAccountId ?? "", runId: options.memorySourceRunId }
                : undefined,
              artifactStorePath: options.artifactStorePath,
            });
            output.contentReview = {
              ...inspectSelfRepairCandidateReview(input, review),
              receiptPath: candidateReviewReceiptPath,
            };
          } catch (error) {
            output.contentReview = {
              status: "failed",
              gaps: [error instanceof Error ? error.message : "self_repair_review_readback_failed"],
              receiptPath: candidateReviewReceiptPath,
            };
          }
        }
      }
    }
  }
  console.log(options.json ? JSON.stringify(output, null, 2) : receipt.markdown);
  if (receipt.diagnosticFeedback?.status === "blocked") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
