import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  buildFundamentalReviewChainJsonPath,
  buildFundamentalReviewChainNoteFilename,
} from "../lobster-brain-registry.js";
import {
  loadReviewBriefsWithFallback,
  type FundamentalReviewBriefArtifact,
} from "../fundamental-review-brief/handler.js";

const log = createSubsystemLogger("hooks/fundamental-review-plan");

type ReviewPlanStatus = "blocked" | "follow_up" | "active_review";
type ReviewPlanAction = "deeper_review" | "follow_up_collection" | "blocked_monitoring";

type ReviewPlanItem = {
  targetLabel: string;
  reviewPriority: "low" | "medium" | "high";
  planAction: ReviewPlanAction;
  evidenceReadinessLevel: FundamentalReviewBriefArtifact["deeperReviewTargets"][number]["evidenceReadinessLevel"];
  reviewGoals: string[];
  researchQuestions: string[];
  collectionTasks: string[];
  blockerChecks: string[];
  requestedMaterials: string[];
  availableDocumentCategories: string[];
  presentSourceTypes: string[];
  documentPaths: string[];
  notes: string[];
};

export type FundamentalReviewPlanArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  reviewBriefPath: string;
  reviewQueuePath: string;
  riskHandoffPath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  planStatus: ReviewPlanStatus;
  summary: {
    totalTargets: number;
    deeperReviewItems: number;
    followUpItems: number;
    blockedItems: number;
  };
  deeperReviewPlan: ReviewPlanItem[];
  followUpPlan: ReviewPlanItem[];
  blockedMonitoringPlan: ReviewPlanItem[];
  nextStepSummary: string[];
  notes: string[];
};

async function loadJsonFiles<T>(params: {
  dirPath: string;
  relativePrefix: string;
}): Promise<Array<{ relativePath: string; data: T }>> {
  try {
    const fileNames = (await fs.readdir(params.dirPath))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    return await Promise.all(
      fileNames.map(async (name) => {
        const relativePath = `${params.relativePrefix}/${name}`;
        const raw = await fs.readFile(path.join(params.dirPath, name), "utf-8");
        return {
          relativePath,
          data: JSON.parse(raw) as T,
        };
      }),
    );
  } catch {
    return [];
  }
}

function humanizeRequestedMaterial(material: string): string {
  if (material === "document_metadata_sidecar") {
    return ".meta.json metadata sidecars";
  }
  return material.replaceAll("_", " ");
}

function humanizeMissingCriticalInput(input: string): string {
  if (input === "review_gate_approval") {
    return "human collection approval";
  }
  if (input === "named_target_resolution") {
    return "named target resolution";
  }
  if (input === "manifest_document_alignment") {
    return "manifest/document alignment";
  }
  if (input === "document_metadata_sidecar") {
    return ".meta.json metadata sidecars";
  }
  if (input.startsWith("document:")) {
    return input.slice("document:".length).replaceAll("_", " ");
  }
  return input.replaceAll("_", " ");
}

function deriveCollectionTasks(
  target: FundamentalReviewBriefArtifact["deeperReviewTargets"][number],
): string[] {
  const tasks = new Set<string>();
  for (const nextAction of target.nextActions) {
    if (nextAction === "resolve_review_gate_approval") {
      tasks.add(`Obtain human collection approval for ${target.targetLabel}.`);
    } else if (nextAction === "resolve_named_target") {
      tasks.add(`Resolve ${target.targetLabel} into a named issuer before deeper review.`);
    } else if (nextAction === "align_documents_to_manifest_plan") {
      tasks.add(`Align local documents for ${target.targetLabel} with the manifest plan.`);
    } else if (nextAction === "collect_missing_documents") {
      for (const material of target.requestedMaterials.filter(
        (item) => item !== "document_metadata_sidecar",
      )) {
        tasks.add(`Collect ${humanizeRequestedMaterial(material)} for ${target.targetLabel}.`);
      }
    } else if (nextAction === "add_metadata_sidecars") {
      tasks.add(`Add .meta.json sidecars for ${target.targetLabel} documents.`);
    } else if (nextAction === "resolve_validation_notes") {
      tasks.add(`Clear validation-note fallout for ${target.targetLabel}.`);
    }
  }

  if (target.nextActions.includes("start_deeper_review")) {
    tasks.add(`Open a deeper-review workstream for ${target.targetLabel}.`);
  }

  if (tasks.size === 0 && target.requestedMaterials.length > 0) {
    for (const material of target.requestedMaterials) {
      tasks.add(`Collect ${humanizeRequestedMaterial(material)} for ${target.targetLabel}.`);
    }
  }

  return [...tasks];
}

function deriveReviewGoals(params: {
  target: FundamentalReviewBriefArtifact["deeperReviewTargets"][number];
  planAction: ReviewPlanAction;
}): string[] {
  const goals: string[] = [];
  if (params.planAction === "deeper_review") {
    goals.push(
      `Establish a first-pass issuer thesis for ${params.target.targetLabel} from the current local document set.`,
    );
  } else if (params.planAction === "follow_up_collection") {
    goals.push(
      `Repair document and metadata coverage for ${params.target.targetLabel} so it can re-enter deeper review.`,
    );
  } else {
    goals.push(
      `Keep blockers explicit for ${params.target.targetLabel} without upgrading it into active review.`,
    );
  }

  if (params.target.availableDocumentCategories.includes("annual_report")) {
    goals.push(
      "Use annual reports to extract business model, segment mix, capital allocation, and disclosed risks.",
    );
  }
  if (params.target.availableDocumentCategories.includes("investor_presentation")) {
    goals.push(
      "Cross-check management framing and KPI claims from investor presentations against primary documents.",
    );
  }
  if (params.target.availableDocumentCategories.includes("quarterly_report")) {
    goals.push("Compare recent quarterly updates against the annual baseline.");
  }
  if (params.target.availableDocumentCategories.includes("research_report")) {
    goals.push("Use third-party research only as secondary context, not primary evidence.");
  }

  return goals;
}

function deriveResearchQuestions(params: {
  target: FundamentalReviewBriefArtifact["deeperReviewTargets"][number];
  planAction: ReviewPlanAction;
}): string[] {
  const questions = new Set<string>();
  if (params.planAction === "deeper_review") {
    questions.add(
      `What do the available local documents imply about business quality, capital allocation, and principal risks for ${params.target.targetLabel}?`,
    );
    if (params.target.availableDocumentCategories.includes("annual_report")) {
      questions.add(
        `Which risk factors or segment disclosures in the annual report for ${params.target.targetLabel} need follow-up?`,
      );
    }
    if (params.target.availableDocumentCategories.includes("investor_presentation")) {
      questions.add(
        `Which management claims in investor presentations for ${params.target.targetLabel} still need verification against primary evidence?`,
      );
    }
  } else if (params.planAction === "follow_up_collection") {
    questions.add(
      `What is the minimum missing material set required to move ${params.target.targetLabel} back into deeper review?`,
    );
    if (params.target.requestedMaterials.includes("document_metadata_sidecar")) {
      questions.add(
        `Which local files for ${params.target.targetLabel} still need metadata sidecars to become auditable?`,
      );
    }
  } else {
    questions.add(
      `Which blocker must clear first before ${params.target.targetLabel} can re-enter the research queue?`,
    );
  }
  return [...questions];
}

function deriveBlockerChecks(
  target: FundamentalReviewBriefArtifact["deeperReviewTargets"][number],
): string[] {
  const checks = target.missingCriticalInputs.map((input) => {
    if (input.startsWith("document:")) {
      return `Confirm ${target.targetLabel} has ${humanizeMissingCriticalInput(input)} locally.`;
    }
    return `Resolve ${humanizeMissingCriticalInput(input)} for ${target.targetLabel}.`;
  });
  if (
    target.requestedMaterials.includes("document_metadata_sidecar") &&
    !checks.includes(`Resolve .meta.json metadata sidecars for ${target.targetLabel}.`)
  ) {
    checks.push(`Resolve .meta.json metadata sidecars for ${target.targetLabel}.`);
  }
  return checks;
}

function buildPlanItem(params: {
  target: FundamentalReviewBriefArtifact["deeperReviewTargets"][number];
  planAction: ReviewPlanAction;
}): ReviewPlanItem {
  return {
    targetLabel: params.target.targetLabel,
    reviewPriority: params.target.reviewPriority,
    planAction: params.planAction,
    evidenceReadinessLevel: params.target.evidenceReadinessLevel,
    reviewGoals: deriveReviewGoals(params),
    researchQuestions: deriveResearchQuestions(params),
    collectionTasks: deriveCollectionTasks(params.target),
    blockerChecks: deriveBlockerChecks(params.target),
    requestedMaterials: params.target.requestedMaterials,
    availableDocumentCategories: params.target.availableDocumentCategories,
    presentSourceTypes: params.target.presentSourceTypes,
    documentPaths: params.target.documentPaths,
    notes: params.target.notes,
  };
}

function buildNextStepSummary(params: {
  deeperReviewPlan: ReviewPlanItem[];
  followUpPlan: ReviewPlanItem[];
  blockedMonitoringPlan: ReviewPlanItem[];
}): string[] {
  const summary: string[] = [];
  for (const item of params.deeperReviewPlan) {
    const categories =
      item.availableDocumentCategories.length > 0
        ? item.availableDocumentCategories.join(", ")
        : "current local documents";
    summary.push(`Begin deeper review for ${item.targetLabel} using ${categories}.`);
  }
  for (const item of params.followUpPlan) {
    const materials =
      item.requestedMaterials.length > 0
        ? item.requestedMaterials.map(humanizeRequestedMaterial).join(", ")
        : "remaining blockers";
    summary.push(`Collect or repair ${materials} for ${item.targetLabel}.`);
  }
  for (const item of params.blockedMonitoringPlan) {
    const blockers = item.blockerChecks.length > 0 ? item.blockerChecks.join(" ") : "its blockers";
    summary.push(`Keep ${item.targetLabel} blocked until ${blockers}`);
  }
  return summary;
}

function buildArtifactNotes(params: {
  planStatus: ReviewPlanStatus;
  deeperReviewItems: number;
  followUpItems: number;
  blockedItems: number;
}): string[] {
  if (params.planStatus === "active_review") {
    return [
      "At least one target has a concrete deeper-review work plan.",
      "This plan remains research-only and does not create approvals, vetoes, or execution instructions.",
    ];
  }
  if (params.planStatus === "follow_up") {
    return [
      `${params.deeperReviewItems} target(s) can start deeper review, ${params.followUpItems} need collection or metadata follow-up, and ${params.blockedItems} remain blocked.`,
      "Use this plan to drive the next research work cycle, not execution.",
    ];
  }
  return [
    "No targets are ready for active deeper review yet.",
    "This plan keeps blockers and collection work explicit without upgrading them into approvals.",
  ];
}

function renderReviewPlanNote(params: {
  dateStr: string;
  timeStr: string;
  reviewPlanPath: string;
  reviewPlan: FundamentalReviewPlanArtifact;
}): string {
  return [
    `# Fundamental Review Plan: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.reviewPlan.manifestId}`,
    `- review_plan_path: ${params.reviewPlanPath}`,
    `- plan_status: ${params.reviewPlan.planStatus}`,
    `- deeper_review_items: ${params.reviewPlan.deeperReviewPlan.length}`,
    `- follow_up_items: ${params.reviewPlan.followUpPlan.length}`,
    `- blocked_items: ${params.reviewPlan.blockedMonitoringPlan.length}`,
    "",
    "## Next Step Summary",
    ...(params.reviewPlan.nextStepSummary.length > 0
      ? params.reviewPlan.nextStepSummary.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

export function buildFundamentalReviewPlan(params: {
  nowIso: string;
  reviewBriefPath: string;
  reviewQueuePath: string;
  riskHandoffPath: string;
  reviewBrief: FundamentalReviewBriefArtifact;
}): FundamentalReviewPlanArtifact {
  const deeperReviewPlan = params.reviewBrief.deeperReviewTargets.map((target) =>
    buildPlanItem({ target, planAction: "deeper_review" }),
  );
  const followUpPlan = params.reviewBrief.followUpTargets.map((target) =>
    buildPlanItem({ target, planAction: "follow_up_collection" }),
  );
  const blockedMonitoringPlan = params.reviewBrief.blockedTargets.map((target) =>
    buildPlanItem({ target, planAction: "blocked_monitoring" }),
  );

  const totalTargets = deeperReviewPlan.length + followUpPlan.length + blockedMonitoringPlan.length;
  const planStatus: ReviewPlanStatus =
    deeperReviewPlan.length === totalTargets && totalTargets > 0
      ? "active_review"
      : deeperReviewPlan.length > 0 || followUpPlan.length > 0
        ? "follow_up"
        : "blocked";

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.reviewBrief.manifestId,
    manifestPath: params.reviewBrief.manifestPath,
    reviewBriefPath: params.reviewBriefPath,
    reviewQueuePath: params.reviewQueuePath,
    riskHandoffPath: params.riskHandoffPath,
    requestTitle: params.reviewBrief.requestTitle,
    researchBranch: params.reviewBrief.researchBranch,
    planStatus,
    summary: {
      totalTargets,
      deeperReviewItems: deeperReviewPlan.length,
      followUpItems: followUpPlan.length,
      blockedItems: blockedMonitoringPlan.length,
    },
    deeperReviewPlan,
    followUpPlan,
    blockedMonitoringPlan,
    nextStepSummary: buildNextStepSummary({
      deeperReviewPlan,
      followUpPlan,
      blockedMonitoringPlan,
    }),
    notes: buildArtifactNotes({
      planStatus,
      deeperReviewItems: deeperReviewPlan.length,
      followUpItems: followUpPlan.length,
      blockedItems: blockedMonitoringPlan.length,
    }),
  };
}

export async function loadReviewPlansWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    reviewPlan: FundamentalReviewPlanArtifact;
    reviewBriefPath: string;
    reviewQueuePath: string;
    riskHandoffPath: string | null;
  }>
> {
  const [persistedPlans, reviewBriefs] = await Promise.all([
    loadJsonFiles<FundamentalReviewPlanArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "review-plans"),
      relativePrefix: "bank/fundamental/review-plans",
    }),
    loadReviewBriefsWithFallback(workspaceDir),
  ]);

  const persistedByManifestId = new Map(
    persistedPlans.map(({ relativePath, data }) => [
      data.manifestId,
      { relativePath, reviewPlan: data },
    ]),
  );

  return reviewBriefs
    .map(({ relativePath, reviewBrief, reviewQueuePath, riskHandoffPath }) => {
      const persisted = persistedByManifestId.get(reviewBrief.manifestId);
      if (persisted && persisted.reviewPlan.generatedAt > reviewBrief.generatedAt) {
        return {
          relativePath: persisted.relativePath,
          reviewPlan: persisted.reviewPlan,
          reviewBriefPath: relativePath,
          reviewQueuePath,
          riskHandoffPath,
        };
      }

      return {
        relativePath: `bank/fundamental/review-plans/${reviewBrief.manifestId}.json`,
        reviewPlan: buildFundamentalReviewPlan({
          nowIso: reviewBrief.generatedAt,
          reviewBriefPath: relativePath,
          reviewQueuePath,
          riskHandoffPath,
          reviewBrief,
        }),
        reviewBriefPath: relativePath,
        reviewQueuePath,
        riskHandoffPath,
      };
    })
    .toSorted(
      (a, b) =>
        b.reviewPlan.generatedAt.localeCompare(a.reviewPlan.generatedAt) ||
        a.reviewPlan.manifestId.localeCompare(b.reviewPlan.manifestId),
    );
}

const materializeFundamentalReviewPlan: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const entries = await loadReviewPlansWithFallback(workspaceDir);
    if (entries.length === 0) {
      return;
    }

    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      entries.map(async ({ reviewPlan }) => {
        const reviewPlanPath = buildFundamentalReviewChainJsonPath(
          "fundamental-review-plan",
          reviewPlan.manifestId,
        );
        const noteRelativePath = buildFundamentalReviewChainNoteFilename({
          dateStr,
          stageName: "fundamental-review-plan",
          manifestId: reviewPlan.manifestId,
        });
        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: reviewPlanPath,
            data: `${JSON.stringify(reviewPlan, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderReviewPlanNote({
              dateStr,
              timeStr,
              reviewPlanPath,
              reviewPlan,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental review plan materialized ${entries.length} review brief(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental review plan", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalReviewPlan;
