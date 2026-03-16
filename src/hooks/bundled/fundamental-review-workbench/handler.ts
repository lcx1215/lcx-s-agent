import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import type { FundamentalManifestScaffold } from "../fundamental-intake/handler.js";
import {
  buildFundamentalReviewBrief,
  type FundamentalReviewBriefArtifact,
} from "../fundamental-review-brief/handler.js";
import {
  buildFundamentalReviewPlan,
  type FundamentalReviewPlanArtifact,
} from "../fundamental-review-plan/handler.js";
import {
  buildFundamentalReviewQueue,
  type FundamentalReviewQueueArtifact,
} from "../fundamental-review-queue/handler.js";
import {
  buildFundamentalRiskHandoff,
  type FundamentalRiskHandoffArtifact,
} from "../fundamental-risk-handoff/handler.js";
import type { FundamentalScoringGateArtifact } from "../fundamental-scoring-gate/handler.js";

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

async function loadRiskHandoffsWithFallback(
  workspaceDir: string,
): Promise<Array<{ relativePath: string; handoff: FundamentalRiskHandoffArtifact }>> {
  const [manifests, scoringGates, persistedHandoffs] = await Promise.all([
    loadJsonFiles<FundamentalManifestScaffold>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
      relativePrefix: "bank/fundamental/manifests",
    }),
    loadJsonFiles<FundamentalScoringGateArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "scoring-gates"),
      relativePrefix: "bank/fundamental/scoring-gates",
    }),
    loadJsonFiles<FundamentalRiskHandoffArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "risk-handoffs"),
      relativePrefix: "bank/fundamental/risk-handoffs",
    }),
  ]);

  const manifestById = new Map(manifests.map(({ data }) => [data.manifestId, data]));
  const resolved = new Map(
    persistedHandoffs.map(({ relativePath, data }) => [
      data.manifestId,
      { relativePath, handoff: data },
    ]),
  );

  for (const { relativePath, data: scoringGate } of scoringGates) {
    if (resolved.has(scoringGate.manifestId)) {
      continue;
    }
    const manifest = manifestById.get(scoringGate.manifestId);
    if (!manifest) {
      continue;
    }
    resolved.set(scoringGate.manifestId, {
      relativePath: `bank/fundamental/risk-handoffs/${scoringGate.manifestId}.json`,
      handoff: buildFundamentalRiskHandoff({
        nowIso: scoringGate.generatedAt,
        scoringGatePath: relativePath,
        manifestRiskHandoffStatus: manifest.riskHandoff.status,
        scoringGate,
      }),
    });
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.handoff.generatedAt.localeCompare(a.handoff.generatedAt) ||
      a.handoff.manifestId.localeCompare(b.handoff.manifestId),
  );
}

async function loadReviewQueuesWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    reviewQueue: FundamentalReviewQueueArtifact;
    riskHandoffPath: string;
    handoff: FundamentalRiskHandoffArtifact;
  }>
> {
  const [persistedQueues, handoffs] = await Promise.all([
    loadJsonFiles<FundamentalReviewQueueArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "review-queues"),
      relativePrefix: "bank/fundamental/review-queues",
    }),
    loadRiskHandoffsWithFallback(workspaceDir),
  ]);

  const handoffById = new Map(handoffs.map((entry) => [entry.handoff.manifestId, entry]));
  const resolved = new Map<
    string,
    {
      relativePath: string;
      reviewQueue: FundamentalReviewQueueArtifact;
      riskHandoffPath: string;
      handoff: FundamentalRiskHandoffArtifact;
    }
  >();

  for (const { relativePath, data } of persistedQueues) {
    const handoff = handoffById.get(data.manifestId);
    if (!handoff) {
      continue;
    }
    resolved.set(data.manifestId, {
      relativePath,
      reviewQueue: data,
      riskHandoffPath: handoff.relativePath,
      handoff: handoff.handoff,
    });
  }

  for (const handoff of handoffs) {
    if (resolved.has(handoff.handoff.manifestId)) {
      continue;
    }
    resolved.set(handoff.handoff.manifestId, {
      relativePath: `bank/fundamental/review-queues/${handoff.handoff.manifestId}.json`,
      reviewQueue: buildFundamentalReviewQueue({
        nowIso: handoff.handoff.generatedAt,
        riskHandoffPath: handoff.relativePath,
        handoff: handoff.handoff,
      }),
      riskHandoffPath: handoff.relativePath,
      handoff: handoff.handoff,
    });
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.reviewQueue.generatedAt.localeCompare(a.reviewQueue.generatedAt) ||
      a.reviewQueue.manifestId.localeCompare(b.reviewQueue.manifestId),
  );
}

async function loadReviewBriefsWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    reviewBrief: FundamentalReviewBriefArtifact;
    reviewQueuePath: string;
    riskHandoffPath: string;
  }>
> {
  const [persistedBriefs, reviewQueues] = await Promise.all([
    loadJsonFiles<FundamentalReviewBriefArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "review-briefs"),
      relativePrefix: "bank/fundamental/review-briefs",
    }),
    loadReviewQueuesWithFallback(workspaceDir),
  ]);

  const queueById = new Map(reviewQueues.map((entry) => [entry.reviewQueue.manifestId, entry]));
  const resolved = new Map<
    string,
    {
      relativePath: string;
      reviewBrief: FundamentalReviewBriefArtifact;
      reviewQueuePath: string;
      riskHandoffPath: string;
    }
  >();

  for (const { relativePath, data } of persistedBriefs) {
    const reviewQueue = queueById.get(data.manifestId);
    if (!reviewQueue) {
      continue;
    }
    resolved.set(data.manifestId, {
      relativePath,
      reviewBrief: data,
      reviewQueuePath: reviewQueue.relativePath,
      riskHandoffPath: reviewQueue.riskHandoffPath,
    });
  }

  for (const reviewQueue of reviewQueues) {
    if (resolved.has(reviewQueue.reviewQueue.manifestId)) {
      continue;
    }
    resolved.set(reviewQueue.reviewQueue.manifestId, {
      relativePath: `bank/fundamental/review-briefs/${reviewQueue.reviewQueue.manifestId}.json`,
      reviewBrief: buildFundamentalReviewBrief({
        nowIso: reviewQueue.reviewQueue.generatedAt,
        reviewQueuePath: reviewQueue.relativePath,
        riskHandoffPath: reviewQueue.riskHandoffPath,
        reviewQueue: reviewQueue.reviewQueue,
        handoff: reviewQueue.handoff,
      }),
      reviewQueuePath: reviewQueue.relativePath,
      riskHandoffPath: reviewQueue.riskHandoffPath,
    });
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.reviewBrief.generatedAt.localeCompare(a.reviewBrief.generatedAt) ||
      a.reviewBrief.manifestId.localeCompare(b.reviewBrief.manifestId),
  );
}

async function loadReviewPlansWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    reviewPlan: FundamentalReviewPlanArtifact;
    reviewBriefPath: string;
    reviewQueuePath: string;
    riskHandoffPath: string;
  }>
> {
  const [persistedPlans, reviewBriefs] = await Promise.all([
    loadJsonFiles<FundamentalReviewPlanArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "review-plans"),
      relativePrefix: "bank/fundamental/review-plans",
    }),
    loadReviewBriefsWithFallback(workspaceDir),
  ]);

  const briefById = new Map(reviewBriefs.map((entry) => [entry.reviewBrief.manifestId, entry]));
  const resolved = new Map<
    string,
    {
      relativePath: string;
      reviewPlan: FundamentalReviewPlanArtifact;
      reviewBriefPath: string;
      reviewQueuePath: string;
      riskHandoffPath: string;
    }
  >();

  for (const { relativePath, data } of persistedPlans) {
    const reviewBrief = briefById.get(data.manifestId);
    if (!reviewBrief) {
      continue;
    }
    resolved.set(data.manifestId, {
      relativePath,
      reviewPlan: data,
      reviewBriefPath: reviewBrief.relativePath,
      reviewQueuePath: reviewBrief.reviewQueuePath,
      riskHandoffPath: reviewBrief.riskHandoffPath,
    });
  }

  for (const reviewBrief of reviewBriefs) {
    if (resolved.has(reviewBrief.reviewBrief.manifestId)) {
      continue;
    }
    resolved.set(reviewBrief.reviewBrief.manifestId, {
      relativePath: `bank/fundamental/review-plans/${reviewBrief.reviewBrief.manifestId}.json`,
      reviewPlan: buildFundamentalReviewPlan({
        nowIso: reviewBrief.reviewBrief.generatedAt,
        reviewBriefPath: reviewBrief.relativePath,
        reviewQueuePath: reviewBrief.reviewQueuePath,
        riskHandoffPath: reviewBrief.riskHandoffPath,
        reviewBrief: reviewBrief.reviewBrief,
      }),
      reviewBriefPath: reviewBrief.relativePath,
      reviewQueuePath: reviewBrief.reviewQueuePath,
      riskHandoffPath: reviewBrief.riskHandoffPath,
    });
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.reviewPlan.generatedAt.localeCompare(a.reviewPlan.generatedAt) ||
      a.reviewPlan.manifestId.localeCompare(b.reviewPlan.manifestId),
  );
}

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
  riskHandoffPath: string;
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
    riskHandoffPath: params.riskHandoffPath,
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
        async ({ relativePath, reviewPlan, reviewBriefPath, reviewQueuePath, riskHandoffPath }) => {
          const reviewWorkbench = buildFundamentalReviewWorkbench({
            nowIso,
            reviewPlanPath: relativePath,
            reviewBriefPath,
            reviewQueuePath,
            riskHandoffPath,
            reviewPlan,
          });
          const reviewWorkbenchPath = `bank/fundamental/review-workbenches/${reviewPlan.manifestId}.json`;
          const noteRelativePath = `${dateStr}-fundamental-review-workbench-${reviewPlan.manifestId}.md`;
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
