import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-self-repair-hands.ts [--json] [--write]",
      "       [--workspace-dir DIR] [--signal-key TEXT] [--issue TEXT] [--observed-failure TEXT]",
      "       [--replacement-rule TEXT] [--domain TEXT]",
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
    "- boundary: dev_self_repair_memory_correction_only",
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
    boundary: "dev_training_candidate_only_not_absorbed",
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
    boundary: "dev_repo_patch_candidate_only_not_applied",
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
  const correctionMarkdown = buildCorrectionMarkdown(input, correctionId);
  const trainingCandidate = buildTrainingCandidate(input, candidateId);
  const patchCandidate = buildPatchCandidate(input, `patch_candidate_${hashShort(baseSlug)}`);
  const writtenArtifacts = input.write
    ? [
        correctionPath,
        candidatePath,
        patchCandidatePath,
        paths.latestJsonPath,
        paths.latestMarkdownPath,
        paths.jsonlPath,
      ]
    : [];
  const markdown = [
    "# LCX Self-Repair Hands",
    "",
    `checkedAt: ${input.checkedAt}`,
    "boundary: dev_self_repair_hands_only",
    "",
    "一句话：LCX Agent 现在可以自己写允许范围内的记忆纠错/降权记录、训练/评测候选题包、repo 补丁候选计划，但不能自己改 repo 源码、提交、启动训练、碰 live/provider/protected memory。",
    "",
    "## 三只手",
    `- 记忆清洁手：${input.write ? "已写入" : "可写入"} ${correctionPath}`,
    `- 题库修复手：${input.write ? "已写入" : "可写入"} ${candidatePath}`,
    `- 补丁候选手：${input.write ? "已写入" : "可写入"} ${patchCandidatePath}`,
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
    ok: true,
    kind: "lcx-self-repair-hands",
    boundary: "dev_self_repair_hands_only",
    checkedAt: input.checkedAt,
    signalKey: input.signalKey,
    status: input.write ? "write_completed" : "dry_run_ready",
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
        ok: true,
        canWriteWithoutCodex: true,
        action: "write_correction_downrank_note",
        path: correctionPath,
        relativePath: relativeToWorkspace(workspaceDir, correctionPath),
        memoryTier: "provisional_downrank",
        correctionMarkdown,
      },
      trainingCaseBuilder: {
        ok: true,
        canWriteWithoutCodex: true,
        action: "write_training_eval_candidate_packet",
        path: candidatePath,
        relativePath: relativeToWorkspace(workspaceDir, candidatePath),
        absorptionStatus: "candidate_only_not_in_train_slice",
        candidate: trainingCandidate,
      },
      patchCandidateBuilder: {
        ok: true,
        canWriteWithoutCodex: true,
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
    writtenArtifacts,
    latestJsonPath: paths.latestJsonPath,
    latestMarkdownPath: paths.latestMarkdownPath,
    jsonlPath: paths.jsonlPath,
    markdown,
    nextSafeAction: input.write
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
  for (const filePath of [
    correctionPath,
    candidatePath,
    patchCandidatePath,
    receipt.latestJsonPath,
    receipt.latestMarkdownPath,
    receipt.jsonlPath,
  ]) {
    assertAllowedWrite(workspaceDir, filePath);
  }
  await fs.mkdir(path.dirname(correctionPath), { recursive: true });
  await fs.mkdir(path.dirname(candidatePath), { recursive: true });
  await fs.mkdir(path.dirname(patchCandidatePath), { recursive: true });
  await fs.mkdir(path.dirname(receipt.latestJsonPath), { recursive: true });
  await fs.mkdir(path.dirname(receipt.jsonlPath), { recursive: true });
  await fs.writeFile(correctionPath, `${receipt.hands.memoryCleaner.correctionMarkdown}\n`);
  await fs.writeFile(
    candidatePath,
    `${JSON.stringify(receipt.hands.trainingCaseBuilder.candidate, null, 2)}\n`,
  );
  await fs.writeFile(
    patchCandidatePath,
    `${JSON.stringify(receipt.hands.patchCandidateBuilder.candidate, null, 2)}\n`,
  );
  await fs.writeFile(receipt.latestJsonPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await fs.writeFile(receipt.latestMarkdownPath, `${receipt.markdown}\n`);
  await fs.appendFile(receipt.jsonlPath, `${JSON.stringify(receipt)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = buildSelfRepairHandsReceipt({
    checkedAt: new Date().toISOString(),
    workspaceDir: options.workspaceDir,
    signalKey: options.signalKey,
    issue: options.issue,
    observedFailure: options.observedFailure,
    replacementRule: options.replacementRule,
    domain: options.domain,
    write: options.write,
  });
  if (options.write) {
    await writeSelfRepairHandsReceipt(receipt);
  }
  let output: Record<string, unknown> = receipt;
  if (!options.write) {
    const latestRaw = await fs.readFile(receipt.latestJsonPath, "utf8").catch(() => undefined);
    if (latestRaw) {
      const latest = JSON.parse(latestRaw) as Record<string, unknown>;
      output = {
        ...receipt,
        latestWrittenReceipt: {
          status: latest.status,
          checkedAt: latest.checkedAt,
          signalKey: latest.signalKey,
          issue: latest.issue,
          domain: latest.domain,
          writtenArtifacts: latest.writtenArtifacts,
          latestJsonPath: receipt.latestJsonPath,
          latestMarkdownPath: receipt.latestMarkdownPath,
          jsonlPath: receipt.jsonlPath,
        },
      };
    }
  }
  console.log(options.json ? JSON.stringify(output, null, 2) : receipt.markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
