import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  workspaceDir: string;
  json: boolean;
};

type FileEntry = {
  path: string;
  mtimeMs: number;
};

type SedimentationLane = {
  id: string;
  title: string;
  category:
    | "source_to_capability"
    | "module_absorption"
    | "training_material"
    | "system_memory"
    | "review_arbitration"
    | "runtime_continuity"
    | "boundary_only";
  status: string;
  proves: string[];
  doesNotProve: string[];
  evidenceSurfaces: string[];
  counts: Record<string, number | boolean>;
  nextGate: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-learning-sedimentation-map.ts [--workspace DIR] [--json]",
      "",
      "Separates learning sedimentation lanes so module learning, system memory, training material, finance source learning, and language corpus boundaries are not confused.",
      "This is read-only dev evidence and never writes memory, touches live, changes providers, or promotes adapters.",
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
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace" || arg === "--worktree") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.workspaceDir = path.resolve(options.workspaceDir);
  return options;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, suffix?: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath);
          return;
        }
        if (!entry.isFile() || (suffix && !entry.name.endsWith(suffix))) {
          return;
        }
        const stat = await fs.stat(filePath).catch(() => undefined);
        if (stat) {
          files.push({ path: filePath, mtimeMs: stat.mtimeMs });
        }
      }),
    );
  }
  await visit(root);
  return files.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countRecent(files: FileEntry[], maxAgeMs: number): number {
  const since = Date.now() - maxAgeMs;
  return files.filter((entry) => entry.mtimeMs >= since).length;
}

async function acceptedBrainCandidates(files: FileEntry[]): Promise<number> {
  let accepted = 0;
  for (const file of files) {
    const parsed = await readJsonObject(file.path);
    const candidates = Array.isArray(parsed?.acceptedCandidates) ? parsed.acceptedCandidates : [];
    accepted += candidates.filter((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return false;
      }
      const record = candidate as Record<string, unknown>;
      const review =
        record.review && typeof record.review === "object" && !Array.isArray(record.review)
          ? (record.review as Record<string, unknown>)
          : {};
      return (
        record.boundary === "brain_distillation_candidate" &&
        record.status === "accepted_brain_plan" &&
        review.accepted === true
      );
    }).length;
  }
  return accepted;
}

async function moduleReviewCounts(files: FileEntry[]) {
  const summary = {
    applicationReady: 0,
    evalAbsorbed: 0,
    weakModuleLearning: 0,
    boundaryViolations: 0,
    exactMissingProofReceipts: 0,
    proofGapSummary: {} as Record<string, number>,
    nextProofQueue: [] as unknown[],
  };
  for (const file of files) {
    const parsed = await readJsonObject(file.path);
    const counts =
      parsed?.counts && typeof parsed.counts === "object" && !Array.isArray(parsed.counts)
        ? (parsed.counts as Record<string, unknown>)
        : {};
    summary.applicationReady += numberValue(counts.applicationReady);
    summary.evalAbsorbed += numberValue(counts.evalAbsorbed);
    summary.weakModuleLearning += numberValue(counts.weakModuleLearning);
    summary.boundaryViolations += numberValue(counts.boundaryViolations);
    summary.exactMissingProofReceipts += numberValue(counts.exactMissingProofReceipts);
    const proofGapSummary =
      parsed?.proofGapSummary &&
      typeof parsed.proofGapSummary === "object" &&
      !Array.isArray(parsed.proofGapSummary)
        ? (parsed.proofGapSummary as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(proofGapSummary)) {
      const count = numberValue(value);
      if (count > 0) {
        summary.proofGapSummary[key] = (summary.proofGapSummary[key] ?? 0) + count;
      }
    }
    if (summary.nextProofQueue.length === 0 && Array.isArray(parsed?.nextProofQueue)) {
      summary.nextProofQueue = parsed.nextProofQueue.slice(0, 10);
    }
  }
  return summary;
}

function laneStatus(
  ok: boolean,
  partial: boolean,
  okStatus: string,
  partialStatus: string,
): string {
  if (ok) {
    return okStatus;
  }
  return partial ? partialStatus : "missing_evidence";
}

async function buildMap(workspaceDir: string) {
  const memoryDir = path.join(workspaceDir, "memory");
  const stateDir = path.join(workspaceDir, "state");
  const [
    researchSources,
    retrievalReceipts,
    retrievalReviews,
    applyReceipts,
    applyReviews,
    modulePlanReceipts,
    moduleReviews,
    brainCandidateFiles,
    brainReviewFiles,
    reviewPanelReceipts,
    localMemoryFiles,
    rootMemoryFiles,
  ] = await Promise.all([
    listFiles(path.join(memoryDir, "research-sources")),
    listFiles(path.join(memoryDir, "finance-learning-retrieval-receipts"), ".json"),
    listFiles(path.join(memoryDir, "finance-learning-retrieval-reviews"), ".json"),
    listFiles(path.join(memoryDir, "finance-learning-apply-usage-receipts"), ".json"),
    listFiles(path.join(memoryDir, "finance-learning-apply-usage-reviews"), ".json"),
    listFiles(path.join(memoryDir, "module-learning-pipeline-plan-receipts"), ".json"),
    listFiles(path.join(memoryDir, "module-learning-pipeline-reviews"), ".json"),
    listFiles(path.join(memoryDir, "lark-brain-distillation-candidates"), ".json"),
    listFiles(path.join(memoryDir, "lark-brain-distillation-reviews"), ".json"),
    listFiles(path.join(memoryDir, "review-panel-receipts"), ".json"),
    listFiles(path.join(memoryDir, "local-memory")),
    listFiles(memoryDir),
  ]);
  const capabilityCandidatePresent = await pathExists(
    path.join(memoryDir, "local-memory", "finance-learning-capability-candidates.md"),
  );
  const operatorLatestPresent = await pathExists(
    path.join(stateDir, "lcx-local-operator-latest.json"),
  );
  const acceptedCandidates = await acceptedBrainCandidates(brainReviewFiles);
  const reviewCounts = await moduleReviewCounts(moduleReviews);
  const moduleAbsorptionReady =
    reviewCounts.evalAbsorbed > 0 &&
    reviewCounts.weakModuleLearning === 0 &&
    reviewCounts.boundaryViolations === 0;
  const moduleLearningHasWeakReceipts = reviewCounts.weakModuleLearning > 0;
  const moduleLearningHasBoundaryViolations = reviewCounts.boundaryViolations > 0;
  const moduleLearningHasEvalAbsorption = reviewCounts.evalAbsorbed > 0;
  const moduleLearningStatus = moduleLearningHasBoundaryViolations
    ? "boundary_violation_blocks_absorption"
    : moduleAbsorptionReady
      ? "module_eval_absorbed_receipts_clean"
      : moduleLearningHasEvalAbsorption && moduleLearningHasWeakReceipts
        ? "partial_eval_absorption_with_weak_receipts"
        : moduleReviews.length > 0
          ? "reviewable_not_absorbed"
          : modulePlanReceipts.length > 0
            ? "planned_not_reviewed"
            : "missing_evidence";
  const correctionNotes = rootMemoryFiles.filter((entry) =>
    /(?:^|\/)\d{4}-\d{2}-\d{2}-correction-note-|(?:^|\/)correction-note-/u.test(
      path.relative(workspaceDir, entry.path).split(path.sep).join("/"),
    ),
  );
  const learningCouncilNotes = rootMemoryFiles.filter((entry) =>
    /learning-council/u.test(path.basename(entry.path)),
  );

  const lanes: SedimentationLane[] = [
    {
      id: "finance_source_capability_sedimentation",
      title: "Finance source -> capability -> retrieval/apply evidence",
      category: "source_to_capability",
      status: laneStatus(
        researchSources.length > 0 &&
          capabilityCandidatePresent &&
          retrievalReceipts.length > 0 &&
          applyReceipts.length > 0,
        researchSources.length > 0 || retrievalReceipts.length > 0 || applyReceipts.length > 0,
        "source_to_apply_usable",
        "source_chain_partial",
      ),
      proves: [
        "A finance source was stored, made retrievable, and used in an apply receipt when the full chain is present.",
      ],
      doesNotProve: [
        "It does not prove a local module learned the source.",
        "It does not prove Qwen weights absorbed the rule.",
      ],
      evidenceSurfaces: [
        "memory/research-sources",
        "memory/local-memory/finance-learning-capability-candidates.md",
        "memory/finance-learning-retrieval-receipts",
        "memory/finance-learning-apply-usage-receipts",
      ],
      counts: {
        researchSources: researchSources.length,
        capabilityCandidatePresent,
        retrievalReceipts: retrievalReceipts.length,
        retrievalReviews: retrievalReviews.length,
        applyReceipts: applyReceipts.length,
        applyReviews: applyReviews.length,
        recentApplyReceipts24h: countRecent(applyReceipts, ONE_DAY_MS),
      },
      nextGate: "module_learning_pipeline_plan_or_review_before_claiming_module_learning",
    },
    {
      id: "local_module_learning_sedimentation",
      title: "Local module learning plan/review/absorption",
      category: "module_absorption",
      status: moduleLearningStatus,
      proves: [
        "Module-specific learning is only certifiable after plan, review, per-receipt absorption evidence, and keep/downrank/discard decision.",
      ],
      doesNotProve: [
        "application_ready is not eval_absorbed.",
        "A clean global eval alone is not per-module absorption proof.",
      ],
      evidenceSurfaces: [
        "memory/module-learning-pipeline-plan-receipts",
        "memory/module-learning-pipeline-reviews",
        "scripts/dev/lcx-module-learning-absorption-gate.ts",
      ],
      counts: {
        planReceipts: modulePlanReceipts.length,
        reviewFiles: moduleReviews.length,
        applicationReady: reviewCounts.applicationReady,
        evalAbsorbed: reviewCounts.evalAbsorbed,
        weakModuleLearning: reviewCounts.weakModuleLearning,
        boundaryViolations: reviewCounts.boundaryViolations,
        exactMissingProofReceipts: reviewCounts.exactMissingProofReceipts,
        proofGapSummary: reviewCounts.proofGapSummary,
        nextProofQueueSize: reviewCounts.nextProofQueue.length,
      },
      nextGate: "lcx-module-learning-absorption-gate_must_return_absorptionReady_true",
    },
    {
      id: "brain_distillation_training_material",
      title: "Brain distillation candidates/reviews for Qwen training material",
      category: "training_material",
      status:
        acceptedCandidates > 0
          ? "accepted_training_material_available"
          : brainCandidateFiles.length > 0 || brainReviewFiles.length > 0
            ? "training_material_partial"
            : "missing_evidence",
      proves: [
        "Accepted candidate material exists for dataset/training loops when review accepted it.",
      ],
      doesNotProve: [
        "It does not prove the current selected adapter learned it.",
        "It is not a language-routing corpus.",
      ],
      evidenceSurfaces: [
        "memory/lark-brain-distillation-candidates",
        "memory/lark-brain-distillation-reviews",
        "local-brain-distill-dataset",
        "minimax-brain-training-guard",
      ],
      counts: {
        candidateFiles: brainCandidateFiles.length,
        reviewFiles: brainReviewFiles.length,
        acceptedCandidates,
        recentReviewFiles24h: countRecent(brainReviewFiles, ONE_DAY_MS),
      },
      nextGate: "dataset_build_training_and_hardened_eval_before_claiming_adapter_absorption",
    },
    {
      id: "system_memory_correction_sedimentation",
      title: "System memory, correction, and downrank sedimentation",
      category: "system_memory",
      status:
        localMemoryFiles.length > 0 || correctionNotes.length > 0 || learningCouncilNotes.length > 0
          ? "system_memory_present"
          : "missing_evidence",
      proves: [
        "System-level notes, correction/downrank artifacts, or local memory files exist for future recall and hygiene.",
      ],
      doesNotProve: [
        "It does not prove module learning.",
        "It does not authorize overwriting protected repo memory.",
      ],
      evidenceSurfaces: [
        "memory/local-memory",
        "memory/*correction-note*",
        "memory/*learning-council*",
      ],
      counts: {
        localMemoryFiles: localMemoryFiles.length,
        correctionNotes: correctionNotes.length,
        learningCouncilNotes: learningCouncilNotes.length,
      },
      nextGate: "freshness_downrank_and_protected_memory_guard_before_durable_claims",
    },
    {
      id: "review_panel_arbitration",
      title: "Review-panel arbitration receipts",
      category: "review_arbitration",
      status: reviewPanelReceipts.length > 0 ? "arbitration_receipts_present" : "missing_evidence",
      proves: [
        "A separate review surface exists to arbitrate learning outputs before summary or promotion claims.",
      ],
      doesNotProve: [
        "A review receipt is not model-weight absorption.",
        "It is not live-user-seen proof.",
      ],
      evidenceSurfaces: ["memory/review-panel-receipts"],
      counts: {
        receiptFiles: reviewPanelReceipts.length,
        recentReceiptFiles24h: countRecent(reviewPanelReceipts, ONE_DAY_MS),
      },
      nextGate: "use_review_panel_together_with_source_apply_and_absorption_evidence",
    },
    {
      id: "operator_runtime_continuity_memory",
      title: "Operator latest state for compressed-context recovery",
      category: "runtime_continuity",
      status: operatorLatestPresent ? "operator_latest_state_present" : "missing_evidence",
      proves: [
        "A future Codex window has a machine-readable state anchor for current ops and recovery.",
      ],
      doesNotProve: [
        "It does not prove live-visible-fixed.",
        "It does not prove a stale receipt is current unless freshness checks pass.",
      ],
      evidenceSurfaces: ["state/lcx-local-operator-latest.json", "lcx-context-recovery-exam"],
      counts: {
        operatorLatestPresent,
      },
      nextGate: "context_recovery_exam_must_confirm_fresh_operator_state",
    },
    {
      id: "language_routing_corpus_boundary",
      title: "Language-routing corpus stays separate",
      category: "boundary_only",
      status: "separate_boundary_enforced",
      proves: [
        "This map treats language routing corpus as a boundary-only lane, not as local-brain training material.",
      ],
      doesNotProve: [
        "Language handoff receipts are not brain distillation artifacts.",
        "Brain distillation artifacts must not write the formal Lark routing corpus.",
      ],
      evidenceSurfaces: ["formal_lark_routing_corpus", "lark_language_handoff_receipt"],
      counts: {
        separatedFromBrainDistillation: true,
      },
      nextGate: "use_lark_visible_language_waterflow_for_language_corpus_changes",
    },
  ];

  const riskyConflations = [
    {
      from: "finance_source_capability_sedimentation",
      to: "local_module_learning_sedimentation",
      rule: "source_to_apply_usable_does_not_equal_module_eval_absorbed",
    },
    {
      from: "brain_distillation_training_material",
      to: "local_module_learning_sedimentation",
      rule: "accepted_training_material_does_not_equal_selected_adapter_absorption",
    },
    {
      from: "system_memory_correction_sedimentation",
      to: "local_module_learning_sedimentation",
      rule: "system_memory_recall_does_not_equal_module_learning",
    },
    {
      from: "language_routing_corpus_boundary",
      to: "brain_distillation_training_material",
      rule: "language_corpus_must_not_be_mixed_with_brain_distillation_artifacts",
    },
    {
      from: "review_panel_arbitration",
      to: "operator_runtime_continuity_memory",
      rule: "review_panel_arbitration_does_not_equal_current_machine_truth",
    },
  ];

  return {
    ok: true,
    boundary: "dev_learning_sedimentation_map_only",
    workspaceDir,
    summary: {
      laneCount: lanes.length,
      moduleAbsorptionReady,
      systemMemoryPresent:
        localMemoryFiles.length > 0 ||
        correctionNotes.length > 0 ||
        learningCouncilNotes.length > 0,
      trainingMaterialPresent: acceptedCandidates > 0,
      sourceCapabilityPresent:
        researchSources.length > 0 && retrievalReceipts.length > 0 && applyReceipts.length > 0,
      languageCorpusSeparated: true,
    },
    lanes,
    riskyConflations,
    notTouched: [
      "external_channel_sender",
      "provider_config",
      "protected_repo_memory",
      "formal_lark_routing_corpus",
      "finance_doctrine",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    languageCorpusTouched: false,
  };
}

function renderText(result: Awaited<ReturnType<typeof buildMap>>): string {
  return (
    [
      `Learning sedimentation map | lanes=${result.summary.laneCount}`,
      `boundary=${result.boundary}`,
      `module_absorption_ready=${result.summary.moduleAbsorptionReady}`,
      `source_capability_present=${result.summary.sourceCapabilityPresent}`,
      `system_memory_present=${result.summary.systemMemoryPresent}`,
      `training_material_present=${result.summary.trainingMaterialPresent}`,
      `language_corpus_separated=${result.summary.languageCorpusSeparated}`,
      ...result.lanes.map((lane) => `lane=${lane.id} status=${lane.status}`),
    ].join("\n") + "\n"
  );
}

const options = parseArgs(process.argv.slice(2));
const result = await buildMap(options.workspaceDir);
if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(renderText(result));
}
