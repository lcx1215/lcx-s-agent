import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  buildFundamentalReviewChainJsonPath,
  buildFundamentalReviewChainNoteFilename,
} from "../lobster-brain-registry.js";
import {
  loadReviewPlansWithFallback,
  type FundamentalReviewPlanArtifact,
} from "../fundamental-review-plan/handler.js";

const log = createSubsystemLogger("hooks/fundamental-review-workbench");

type ReviewWorkbenchStatus = "blocked" | "collection" | "deeper_review";

type DeeperReviewScaffold = {
  targetLabel: string;
  reviewPriority: "low" | "medium" | "high";
  evidenceReadinessLevel: FundamentalReviewPlanArtifact["deeperReviewPlan"][number]["evidenceReadinessLevel"];
  readingOrder: string[];
  thesisSections: string[];
  evidenceChecklist: string[];
  openQuestions: string[];
  immediateTasks: string[];
  documentPaths: string[];
  notes: string[];
};

type FollowUpCollectionPlan = {
  targetLabel: string;
  reviewPriority: "low" | "medium" | "high";
  requestedMaterials: string[];
  collectionOrder: string[];
  metadataTasks: string[];
  unblockConditions: string[];
  nextCollectionTasks: string[];
  notes: string[];
};

type BlockedMonitoringChecklist = {
  targetLabel: string;
  reviewPriority: "low" | "medium" | "high";
  requestedMaterials: string[];
  unblockConditions: string[];
  holdNotes: string[];
  nextCheckpoints: string[];
};

export type FundamentalReviewWorkbenchArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  reviewPlanPath: string;
  reviewBriefPath: string;
  reviewQueuePath: string;
  riskHandoffPath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  workbenchStatus: ReviewWorkbenchStatus;
  summary: {
    totalTargets: number;
    deeperReviewScaffolds: number;
    followUpCollectionPlans: number;
    blockedMonitoringChecklists: number;
  };
  deeperReviewScaffolds: DeeperReviewScaffold[];
  followUpCollectionPlans: FollowUpCollectionPlan[];
  blockedMonitoringChecklists: BlockedMonitoringChecklist[];
  nextStepSummary: string[];
  notes: string[];
};

function formatMaterialLabel(material: string): string {
  if (material === "document_metadata_sidecar") {
    return ".meta.json metadata sidecars";
  }
  return material.replaceAll("_", " ");
}

function buildReadingOrder(
  item: FundamentalReviewPlanArtifact["deeperReviewPlan"][number],
): string[] {
  const priorities = [
    "annual_report",
    "quarterly_report",
    "investor_presentation",
    "management_guidance",
    "call_transcript",
    "research_report",
  ];
  const categories = [...item.availableDocumentCategories];
  categories.sort((a, b) => {
    const ai = priorities.indexOf(a);
    const bi = priorities.indexOf(b);
    const arank = ai === -1 ? priorities.length : ai;
    const brank = bi === -1 ? priorities.length : bi;
    return arank - brank || a.localeCompare(b);
  });
  return categories.map((category) => `Review ${category.replaceAll("_", " ")} evidence first.`);
}

function buildThesisSections(
  item: FundamentalReviewPlanArtifact["deeperReviewPlan"][number],
): string[] {
  const sections = [
    "Business model and revenue drivers",
    "Capital allocation and balance-sheet posture",
    "Primary risk factors and unresolved evidence gaps",
  ];
  if (item.availableDocumentCategories.includes("annual_report")) {
    sections.unshift("Annual report disclosures and segment mix");
  }
  if (item.availableDocumentCategories.includes("investor_presentation")) {
    sections.push("Management framing and KPI claims");
  }
  return sections;
}

function buildEvidenceChecklist(
  item: FundamentalReviewPlanArtifact["deeperReviewPlan"][number],
): string[] {
  const checklist = new Set<string>();
  for (const category of item.availableDocumentCategories) {
    checklist.add(`Confirm ${category.replaceAll("_", " ")} coverage is reflected in notes.`);
  }
  for (const source of item.presentSourceTypes) {
    checklist.add(`Record where ${source.replaceAll("_", " ")} evidence supports the review.`);
  }
  if (item.documentPaths.length > 0) {
    checklist.add(`Cite the local document paths used for ${item.targetLabel}.`);
  }
  return [...checklist];
}

function buildDeeperReviewScaffold(
  item: FundamentalReviewPlanArtifact["deeperReviewPlan"][number],
): DeeperReviewScaffold {
  return {
    targetLabel: item.targetLabel,
    reviewPriority: item.reviewPriority,
    evidenceReadinessLevel: item.evidenceReadinessLevel,
    readingOrder: buildReadingOrder(item),
    thesisSections: buildThesisSections(item),
    evidenceChecklist: buildEvidenceChecklist(item),
    openQuestions: item.researchQuestions,
    immediateTasks: item.collectionTasks.length > 0 ? item.collectionTasks : item.blockerChecks,
    documentPaths: item.documentPaths,
    notes: item.notes,
  };
}

function buildFollowUpCollectionPlan(
  item: FundamentalReviewPlanArtifact["followUpPlan"][number],
): FollowUpCollectionPlan {
  return {
    targetLabel: item.targetLabel,
    reviewPriority: item.reviewPriority,
    requestedMaterials: item.requestedMaterials,
    collectionOrder:
      item.requestedMaterials.length > 0
        ? item.requestedMaterials.map(
            (material) => `Collect or repair ${formatMaterialLabel(material)} first.`,
          )
        : ["Resolve remaining collection blockers first."],
    metadataTasks: item.collectionTasks.filter((task) => task.toLowerCase().includes("meta.json")),
    unblockConditions: item.blockerChecks,
    nextCollectionTasks: item.collectionTasks,
    notes: item.notes,
  };
}

function buildBlockedMonitoringChecklist(
  item: FundamentalReviewPlanArtifact["blockedMonitoringPlan"][number],
): BlockedMonitoringChecklist {
  return {
    targetLabel: item.targetLabel,
    reviewPriority: item.reviewPriority,
    requestedMaterials: item.requestedMaterials,
    unblockConditions: item.blockerChecks,
    holdNotes: item.notes,
    nextCheckpoints:
      item.blockerChecks.length > 0
        ? item.blockerChecks
        : ["Keep target out of active review until blockers are explicitly cleared."],
  };
}

function buildNextStepSummary(params: {
  deeperReviewScaffolds: DeeperReviewScaffold[];
  followUpCollectionPlans: FollowUpCollectionPlan[];
  blockedMonitoringChecklists: BlockedMonitoringChecklist[];
}): string[] {
  const summary: string[] = [];
  for (const item of params.deeperReviewScaffolds) {
    summary.push(`Open a deeper-review packet for ${item.targetLabel}.`);
  }
  for (const item of params.followUpCollectionPlans) {
    const requested =
      item.requestedMaterials.length > 0
        ? item.requestedMaterials.map(formatMaterialLabel).join(", ")
        : "remaining blockers";
    summary.push(`Collect or repair ${requested} for ${item.targetLabel}.`);
  }
  for (const item of params.blockedMonitoringChecklists) {
    summary.push(`Keep ${item.targetLabel} blocked and monitor its unblock conditions.`);
  }
  return summary;
}

function buildArtifactNotes(params: {
  workbenchStatus: ReviewWorkbenchStatus;
  deeperReviewScaffolds: number;
  followUpCollectionPlans: number;
  blockedMonitoringChecklists: number;
}): string[] {
  if (params.workbenchStatus === "deeper_review") {
    return [
      "At least one target now has a concrete deeper-review scaffold.",
      "This workbench remains research-only and does not approve execution or asset actions.",
    ];
  }
  if (params.workbenchStatus === "collection") {
    return [
      `${params.deeperReviewScaffolds} target(s) can move into deeper review, ${params.followUpCollectionPlans} need collection or metadata repair, and ${params.blockedMonitoringChecklists} remain blocked.`,
      "Use this workbench to drive the next human research cycle, not execution.",
    ];
  }
  return [
    "No targets are ready for deeper review packets yet.",
    "This workbench keeps blocked monitoring explicit without converting it into approval state.",
  ];
}

function renderReviewWorkbenchNote(params: {
  dateStr: string;
  timeStr: string;
  reviewWorkbenchPath: string;
  reviewWorkbench: FundamentalReviewWorkbenchArtifact;
}): string {
  return [
    `# Fundamental Review Workbench: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.reviewWorkbench.manifestId}`,
    `- review_workbench_path: ${params.reviewWorkbenchPath}`,
    `- workbench_status: ${params.reviewWorkbench.workbenchStatus}`,
    `- deeper_review_scaffolds: ${params.reviewWorkbench.deeperReviewScaffolds.length}`,
    `- follow_up_collection_plans: ${params.reviewWorkbench.followUpCollectionPlans.length}`,
    `- blocked_monitoring_checklists: ${params.reviewWorkbench.blockedMonitoringChecklists.length}`,
    "",
    "## Next Step Summary",
    ...(params.reviewWorkbench.nextStepSummary.length > 0
      ? params.reviewWorkbench.nextStepSummary.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

export function buildFundamentalReviewWorkbench(params: {
  nowIso: string;
  reviewPlanPath: string;
  reviewBriefPath: string;
  reviewQueuePath: string;
  riskHandoffPath: string | null;
  reviewPlan: FundamentalReviewPlanArtifact;
}): FundamentalReviewWorkbenchArtifact {
  const deeperReviewScaffolds = params.reviewPlan.deeperReviewPlan.map(buildDeeperReviewScaffold);
  const followUpCollectionPlans = params.reviewPlan.followUpPlan.map(buildFollowUpCollectionPlan);
  const blockedMonitoringChecklists = params.reviewPlan.blockedMonitoringPlan.map(
    buildBlockedMonitoringChecklist,
  );

  const totalTargets =
    deeperReviewScaffolds.length +
    followUpCollectionPlans.length +
    blockedMonitoringChecklists.length;
  const workbenchStatus: ReviewWorkbenchStatus =
    deeperReviewScaffolds.length === totalTargets && totalTargets > 0
      ? "deeper_review"
      : deeperReviewScaffolds.length > 0 || followUpCollectionPlans.length > 0
        ? "collection"
        : "blocked";

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.reviewPlan.manifestId,
    manifestPath: params.reviewPlan.manifestPath,
    reviewPlanPath: params.reviewPlanPath,
    reviewBriefPath: params.reviewBriefPath,
    reviewQueuePath: params.reviewQueuePath,
    riskHandoffPath:
      params.riskHandoffPath ??
      `bank/fundamental/risk-handoffs/${params.reviewPlan.manifestId}.json`,
    requestTitle: params.reviewPlan.requestTitle,
    researchBranch: params.reviewPlan.researchBranch,
    workbenchStatus,
    summary: {
      totalTargets,
      deeperReviewScaffolds: deeperReviewScaffolds.length,
      followUpCollectionPlans: followUpCollectionPlans.length,
      blockedMonitoringChecklists: blockedMonitoringChecklists.length,
    },
    deeperReviewScaffolds,
    followUpCollectionPlans,
    blockedMonitoringChecklists,
    nextStepSummary: buildNextStepSummary({
      deeperReviewScaffolds,
      followUpCollectionPlans,
      blockedMonitoringChecklists,
    }),
    notes: buildArtifactNotes({
      workbenchStatus,
      deeperReviewScaffolds: deeperReviewScaffolds.length,
      followUpCollectionPlans: followUpCollectionPlans.length,
      blockedMonitoringChecklists: blockedMonitoringChecklists.length,
    }),
  };
}

const materializeFundamentalReviewWorkbench: HookHandler = async (event) => {
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
      entries.map(
        async ({ reviewPlan, reviewBriefPath, reviewQueuePath, riskHandoffPath }) => {
          const reviewWorkbench = buildFundamentalReviewWorkbench({
            nowIso,
            reviewPlanPath: buildFundamentalReviewChainJsonPath(
              "fundamental-review-plan",
              reviewPlan.manifestId,
            ),
            reviewBriefPath,
            reviewQueuePath,
            riskHandoffPath,
            reviewPlan,
          });
          const reviewWorkbenchPath = buildFundamentalReviewChainJsonPath(
            "fundamental-review-workbench",
            reviewPlan.manifestId,
          );
          const noteRelativePath = buildFundamentalReviewChainNoteFilename({
            dateStr,
            stageName: "fundamental-review-workbench",
            manifestId: reviewPlan.manifestId,
          });
          await Promise.all([
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: reviewWorkbenchPath,
              data: `${JSON.stringify(reviewWorkbench, null, 2)}\n`,
              encoding: "utf-8",
            }),
            writeFileWithinRoot({
              rootDir: memoryDir,
              relativePath: noteRelativePath,
              data: renderReviewWorkbenchNote({
                dateStr,
                timeStr,
                reviewWorkbenchPath,
                reviewWorkbench,
              }),
              encoding: "utf-8",
            }),
          ]);
        },
      ),
    );

    log.info(`Fundamental review workbench materialized ${entries.length} review plan(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental review workbench", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalReviewWorkbench;
