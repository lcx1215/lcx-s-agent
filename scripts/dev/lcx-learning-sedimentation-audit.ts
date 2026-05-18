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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-learning-sedimentation-audit.ts [--workspace DIR] [--json]",
      "",
      "Audits existing learning sedimentation surfaces without writing memory, touching live, or changing providers.",
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

function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  return path.relative(workspaceDir, filePath).split(path.sep).join("/");
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

function countRecent(files: FileEntry[], maxAgeMs: number): number {
  const since = Date.now() - maxAgeMs;
  return files.filter((entry) => entry.mtimeMs >= since).length;
}

async function countAcceptedBrainCandidates(files: FileEntry[]): Promise<number> {
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

async function summarizeModuleLearningReviews(files: FileEntry[]): Promise<{
  evalAbsorbed: number;
  weakModuleLearning: number;
  boundaryViolations: number;
}> {
  const summary = {
    evalAbsorbed: 0,
    weakModuleLearning: 0,
    boundaryViolations: 0,
  };
  for (const file of files) {
    const parsed = await readJsonObject(file.path);
    const counts =
      parsed?.counts && typeof parsed.counts === "object" && !Array.isArray(parsed.counts)
        ? (parsed.counts as Record<string, unknown>)
        : {};
    summary.evalAbsorbed += typeof counts.evalAbsorbed === "number" ? counts.evalAbsorbed : 0;
    summary.weakModuleLearning +=
      typeof counts.weakModuleLearning === "number" ? counts.weakModuleLearning : 0;
    summary.boundaryViolations +=
      typeof counts.boundaryViolations === "number" ? counts.boundaryViolations : 0;
  }
  return summary;
}

async function buildAudit(workspaceDir: string) {
  const memoryDir = path.join(workspaceDir, "memory");
  const [
    researchSources,
    retrievalReceipts,
    retrievalReviews,
    applyReceipts,
    applyReviews,
    brainReviewFiles,
    brainCandidateFiles,
    reviewPanelReceipts,
    modulePlanReceipts,
    moduleReviews,
    localMemoryFiles,
    rootMemoryFiles,
  ] = await Promise.all([
    listFiles(path.join(memoryDir, "research-sources")),
    listFiles(path.join(memoryDir, "finance-learning-retrieval-receipts"), ".json"),
    listFiles(path.join(memoryDir, "finance-learning-retrieval-reviews"), ".json"),
    listFiles(path.join(memoryDir, "finance-learning-apply-usage-receipts"), ".json"),
    listFiles(path.join(memoryDir, "finance-learning-apply-usage-reviews"), ".json"),
    listFiles(path.join(memoryDir, "lark-brain-distillation-reviews"), ".json"),
    listFiles(path.join(memoryDir, "lark-brain-distillation-candidates"), ".json"),
    listFiles(path.join(memoryDir, "review-panel-receipts"), ".json"),
    listFiles(path.join(memoryDir, "module-learning-pipeline-plan-receipts"), ".json"),
    listFiles(path.join(memoryDir, "module-learning-pipeline-reviews"), ".json"),
    listFiles(path.join(memoryDir, "local-memory")),
    listFiles(memoryDir),
  ]);

  const acceptedBrainCandidates = await countAcceptedBrainCandidates(brainReviewFiles);
  const moduleReviewSummary = await summarizeModuleLearningReviews(moduleReviews);
  const capabilityCandidatePath = path.join(
    memoryDir,
    "local-memory",
    "finance-learning-capability-candidates.md",
  );
  const correctionNotes = rootMemoryFiles.filter((entry) =>
    /(?:^|\/)\d{4}-\d{2}-\d{2}-correction-note-|(?:^|\/)correction-note-/u.test(
      relativeToWorkspace(workspaceDir, entry.path),
    ),
  );
  const learningCouncilNotes = rootMemoryFiles.filter((entry) =>
    /learning-council/u.test(path.basename(entry.path)),
  );

  const financeLearningFullChain =
    researchSources.length > 0 &&
    (await pathExists(capabilityCandidatePath)) &&
    retrievalReceipts.length > 0 &&
    applyReceipts.length > 0;
  const brainDistillationChain = brainReviewFiles.length > 0 && acceptedBrainCandidates > 0;
  const reviewChain = reviewPanelReceipts.length > 0;
  const correctionChain = correctionNotes.length > 0 || learningCouncilNotes.length > 0;
  const moduleLearningReviewed = modulePlanReceipts.length > 0 && moduleReviews.length > 0;
  const moduleLearningHasEvalAbsorption = moduleReviewSummary.evalAbsorbed > 0;
  const moduleLearningHasWeakReceipts = moduleReviewSummary.weakModuleLearning > 0;
  const moduleLearningCertifiable =
    moduleLearningReviewed &&
    moduleLearningHasEvalAbsorption &&
    !moduleLearningHasWeakReceipts &&
    moduleReviewSummary.boundaryViolations === 0;
  const sufficientForCurrentUse = financeLearningFullChain && brainDistillationChain && reviewChain;

  const gaps = [
    ...(modulePlanReceipts.length === 0
      ? [
          {
            id: "module_learning_pipeline_has_no_plan_receipts",
            severity: "P3",
            meaning:
              "General learning sedimentation exists, but module-specific source-to-eval claims still lack plan receipts.",
          },
        ]
      : []),
    ...(moduleReviews.length === 0
      ? [
          {
            id: "module_learning_pipeline_has_no_reviews",
            severity: "P3",
            meaning:
              "Module-learning review cannot certify module-specific keep/downrank/discard decisions yet.",
          },
        ]
      : []),
    ...(moduleLearningReviewed && moduleReviewSummary.evalAbsorbed === 0
      ? [
          {
            id: "module_learning_review_has_no_eval_absorbed_receipts",
            severity: "P3",
            meaning:
              "Module-learning receipts are reviewable, but none prove Qwen eval or training absorption yet.",
          },
        ]
      : []),
    ...(moduleLearningReviewed && moduleLearningHasWeakReceipts
      ? [
          {
            id: "module_learning_review_has_weak_receipts",
            severity: "P2",
            meaning:
              "Some module-learning receipts are still stored_only, retrieval_ready, or application_ready; historical eval_absorbed receipts do not make the whole module pipeline certifiable.",
          },
        ]
      : []),
    ...(!reviewChain
      ? [
          {
            id: "review_panel_receipts_missing",
            severity: "P2",
            meaning: "Learning outputs lack an arbitration proof surface.",
          },
        ]
      : []),
  ];

  return {
    ok: true,
    boundary: "dev_learning_sedimentation_audit_only",
    workspaceDir,
    assessment: sufficientForCurrentUse
      ? moduleLearningCertifiable
        ? "usable_and_module_certifiable"
        : moduleLearningReviewed
          ? moduleLearningHasEvalAbsorption && moduleLearningHasWeakReceipts
            ? "usable_with_partial_module_absorption_but_weak_receipts"
            : "usable_with_module_review_but_no_eval_absorption"
          : "usable_but_module_specific_certification_gap"
      : "insufficient_learning_sedimentation_evidence",
    sufficientForCurrentUse,
    chains: {
      financeLearning: {
        ok: financeLearningFullChain,
        researchSources: researchSources.length,
        capabilityCandidateFilePresent: await pathExists(capabilityCandidatePath),
        retrievalReceipts: retrievalReceipts.length,
        retrievalReviews: retrievalReviews.length,
        applyReceipts: applyReceipts.length,
        applyReviews: applyReviews.length,
        recentApplyReceipts24h: countRecent(applyReceipts, ONE_DAY_MS),
      },
      brainDistillation: {
        ok: brainDistillationChain,
        candidateFiles: brainCandidateFiles.length,
        reviewFiles: brainReviewFiles.length,
        acceptedCandidates: acceptedBrainCandidates,
        recentReviewFiles24h: countRecent(brainReviewFiles, ONE_DAY_MS),
      },
      reviewPanel: {
        ok: reviewChain,
        receiptFiles: reviewPanelReceipts.length,
        recentReceiptFiles24h: countRecent(reviewPanelReceipts, ONE_DAY_MS),
      },
      correctionAndDownrank: {
        ok: correctionChain,
        correctionNotes: correctionNotes.length,
        learningCouncilNotes: learningCouncilNotes.length,
        localMemoryFiles: localMemoryFiles.length,
      },
      moduleLearningPipeline: {
        ok: moduleLearningCertifiable,
        planReceipts: modulePlanReceipts.length,
        reviewFiles: moduleReviews.length,
        evalAbsorbed: moduleReviewSummary.evalAbsorbed,
        weakModuleLearning: moduleReviewSummary.weakModuleLearning,
        boundaryViolations: moduleReviewSummary.boundaryViolations,
      },
    },
    gaps,
    sampleArtifacts: {
      latestResearchSource: researchSources[0]
        ? relativeToWorkspace(workspaceDir, researchSources[0].path)
        : undefined,
      latestRetrievalReceipt: retrievalReceipts[0]
        ? relativeToWorkspace(workspaceDir, retrievalReceipts[0].path)
        : undefined,
      latestApplyReceipt: applyReceipts[0]
        ? relativeToWorkspace(workspaceDir, applyReceipts[0].path)
        : undefined,
      latestBrainReview: brainReviewFiles[0]
        ? relativeToWorkspace(workspaceDir, brainReviewFiles[0].path)
        : undefined,
      latestReviewPanelReceipt: reviewPanelReceipts[0]
        ? relativeToWorkspace(workspaceDir, reviewPanelReceipts[0].path)
        : undefined,
    },
    notTouched: [
      "live_sender",
      "provider_config",
      "protected_repo_memory",
      "formal_lark_routing_corpus",
      "finance_doctrine",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

function renderText(audit: Awaited<ReturnType<typeof buildAudit>>): string {
  return (
    [
      `Learning sedimentation audit | assessment=${audit.assessment}`,
      `boundary=${audit.boundary}`,
      `sufficient_for_current_use=${audit.sufficientForCurrentUse}`,
      `finance_learning_apply_receipts=${audit.chains.financeLearning.applyReceipts}`,
      `brain_distillation_reviews=${audit.chains.brainDistillation.reviewFiles}`,
      `review_panel_receipts=${audit.chains.reviewPanel.receiptFiles}`,
      `module_plan_receipts=${audit.chains.moduleLearningPipeline.planReceipts}`,
      `module_review_files=${audit.chains.moduleLearningPipeline.reviewFiles}`,
      `module_eval_absorbed=${audit.chains.moduleLearningPipeline.evalAbsorbed}`,
      `gaps=${audit.gaps.map((gap) => gap.id).join(",") || "none"}`,
    ].join("\n") + "\n"
  );
}

const options = parseArgs(process.argv.slice(2));
const audit = await buildAudit(options.workspaceDir);
if (options.json) {
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
} else {
  process.stdout.write(renderText(audit));
}
