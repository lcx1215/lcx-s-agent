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
  buildFundamentalReviewWorkbench,
  type FundamentalReviewWorkbenchArtifact,
} from "../fundamental-review-workbench/handler.js";
import {
  buildFundamentalRiskHandoff,
  type FundamentalRiskHandoffArtifact,
} from "../fundamental-risk-handoff/handler.js";
import type { FundamentalScoringGateArtifact } from "../fundamental-scoring-gate/handler.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
  buildFundamentalReviewChainJsonPath,
} from "../lobster-brain-registry.js";

const log = createSubsystemLogger("hooks/fundamental-target-packets");

type TargetPacketStatus = "blocked" | "collection" | "dossier_ready";

type DeeperReviewDossier = {
  targetLabel: string;
  reviewPriority: "low" | "medium" | "high";
  dossierTitle: string;
  evidenceReadinessLevel: FundamentalReviewWorkbenchArtifact["deeperReviewScaffolds"][number]["evidenceReadinessLevel"];
  thesisTemplate: string[];
  evidenceMatrix: string[];
  citationTasks: string[];
  writingChecklist: string[];
  openQuestions: string[];
  immediateTasks: string[];
  documentPaths: string[];
  notes: string[];
};

type FollowUpCollectionPacket = {
  targetLabel: string;
  reviewPriority: "low" | "medium" | "high";
  packetFocus: "metadata_repair" | "document_collection" | "mixed_follow_up";
  requestedMaterials: string[];
  collectionSequence: string[];
  namingReminders: string[];
  metadataChecklist: string[];
  verificationChecklist: string[];
  nextCollectionTasks: string[];
  notes: string[];
};

type BlockedHoldPacket = {
  targetLabel: string;
  reviewPriority: "low" | "medium" | "high";
  holdSummary: string[];
  requestedMaterials: string[];
  unblockConditions: string[];
  nextReviewGateChecks: string[];
  notes: string[];
};

export type FundamentalTargetPacketsArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  reviewWorkbenchPath: string;
  reviewPlanPath: string;
  reviewBriefPath: string;
  reviewQueuePath: string;
  riskHandoffPath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  packetStatus: TargetPacketStatus;
  summary: {
    totalTargets: number;
    deeperReviewDossiers: number;
    followUpCollectionPackets: number;
    blockedHoldPackets: number;
  };
  deeperReviewDossiers: DeeperReviewDossier[];
  followUpCollectionPackets: FollowUpCollectionPacket[];
  blockedHoldPackets: BlockedHoldPacket[];
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

async function loadReviewWorkbenchesWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    workbench: FundamentalReviewWorkbenchArtifact;
    reviewPlanPath: string;
    reviewBriefPath: string;
    reviewQueuePath: string;
    riskHandoffPath: string;
  }>
> {
  const [persistedWorkbenches, reviewPlans] = await Promise.all([
    loadJsonFiles<FundamentalReviewWorkbenchArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "review-workbenches"),
      relativePrefix: "bank/fundamental/review-workbenches",
    }),
    loadReviewPlansWithFallback(workspaceDir),
  ]);

  const planById = new Map(reviewPlans.map((entry) => [entry.reviewPlan.manifestId, entry]));
  const resolved = new Map<
    string,
    {
      relativePath: string;
      workbench: FundamentalReviewWorkbenchArtifact;
      reviewPlanPath: string;
      reviewBriefPath: string;
      reviewQueuePath: string;
      riskHandoffPath: string;
    }
  >();

  for (const { relativePath, data } of persistedWorkbenches) {
    const reviewPlan = planById.get(data.manifestId);
    if (!reviewPlan) {
      continue;
    }
    resolved.set(data.manifestId, {
      relativePath,
      workbench: data,
      reviewPlanPath: reviewPlan.relativePath,
      reviewBriefPath: reviewPlan.reviewBriefPath,
      reviewQueuePath: reviewPlan.reviewQueuePath,
      riskHandoffPath: reviewPlan.riskHandoffPath,
    });
  }

  for (const reviewPlan of reviewPlans) {
    if (resolved.has(reviewPlan.reviewPlan.manifestId)) {
      continue;
    }
    resolved.set(reviewPlan.reviewPlan.manifestId, {
      relativePath: `bank/fundamental/review-workbenches/${reviewPlan.reviewPlan.manifestId}.json`,
      workbench: buildFundamentalReviewWorkbench({
        nowIso: reviewPlan.reviewPlan.generatedAt,
        reviewPlanPath: reviewPlan.relativePath,
        reviewBriefPath: reviewPlan.reviewBriefPath,
        reviewQueuePath: reviewPlan.reviewQueuePath,
        riskHandoffPath: reviewPlan.riskHandoffPath,
        reviewPlan: reviewPlan.reviewPlan,
      }),
      reviewPlanPath: reviewPlan.relativePath,
      reviewBriefPath: reviewPlan.reviewBriefPath,
      reviewQueuePath: reviewPlan.reviewQueuePath,
      riskHandoffPath: reviewPlan.riskHandoffPath,
    });
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.workbench.generatedAt.localeCompare(a.workbench.generatedAt) ||
      a.workbench.manifestId.localeCompare(b.workbench.manifestId),
  );
}

function humanizeLabel(label: string): string {
  if (label === "document_metadata_sidecar") {
    return ".meta.json metadata sidecars";
  }
  return label.replaceAll("_", " ");
}

function buildThesisTemplate(
  dossier: FundamentalReviewWorkbenchArtifact["deeperReviewScaffolds"][number],
): string[] {
  return dossier.thesisSections.map((section) => `Fill section: ${section}.`);
}

function buildEvidenceMatrix(
  dossier: FundamentalReviewWorkbenchArtifact["deeperReviewScaffolds"][number],
): string[] {
  const matrix = [...dossier.evidenceChecklist];
  for (const path of dossier.documentPaths) {
    matrix.push(`Record what ${path} contributes to the dossier.`);
  }
  return matrix;
}

function buildCitationTasks(
  dossier: FundamentalReviewWorkbenchArtifact["deeperReviewScaffolds"][number],
): string[] {
  const tasks = new Set<string>();
  if (dossier.documentPaths.length > 0) {
    tasks.add(
      `Cite at least one local document path for ${dossier.targetLabel} in each major section.`,
    );
  }
  tasks.add(`Separate primary evidence from secondary interpretation for ${dossier.targetLabel}.`);
  return [...tasks];
}

function buildWritingChecklist(
  dossier: FundamentalReviewWorkbenchArtifact["deeperReviewScaffolds"][number],
): string[] {
  const checklist = [
    "State business model before opinions.",
    "Flag unresolved evidence gaps explicitly.",
    "Do not convert research conclusions into execution instructions.",
  ];
  if (dossier.evidenceReadinessLevel !== "baseline_ready") {
    checklist.push("Keep conclusions provisional until evidence readiness improves.");
  }
  return checklist;
}

function buildDeeperReviewDossier(
  dossier: FundamentalReviewWorkbenchArtifact["deeperReviewScaffolds"][number],
): DeeperReviewDossier {
  return {
    targetLabel: dossier.targetLabel,
    reviewPriority: dossier.reviewPriority,
    dossierTitle: `${dossier.targetLabel} deeper review dossier`,
    evidenceReadinessLevel: dossier.evidenceReadinessLevel,
    thesisTemplate: buildThesisTemplate(dossier),
    evidenceMatrix: buildEvidenceMatrix(dossier),
    citationTasks: buildCitationTasks(dossier),
    writingChecklist: buildWritingChecklist(dossier),
    openQuestions: dossier.openQuestions,
    immediateTasks: dossier.immediateTasks,
    documentPaths: dossier.documentPaths,
    notes: dossier.notes,
  };
}

function derivePacketFocus(
  packet: FundamentalReviewWorkbenchArtifact["followUpCollectionPlans"][number],
): FollowUpCollectionPacket["packetFocus"] {
  const hasMetadata = packet.requestedMaterials.includes("document_metadata_sidecar");
  const hasDocuments = packet.requestedMaterials.some(
    (material) => material !== "document_metadata_sidecar",
  );
  if (hasMetadata && hasDocuments) {
    return "mixed_follow_up";
  }
  if (hasMetadata) {
    return "metadata_repair";
  }
  return "document_collection";
}

function buildNamingReminders(
  packet: FundamentalReviewWorkbenchArtifact["followUpCollectionPlans"][number],
): string[] {
  return [
    "Use <target-slug>--<document-category>--<source-type>--<YYYYMMDD>.<ext> when adding files.",
    "Add matching .meta.json sidecars whenever classification would otherwise rely on filename heuristics.",
    ...(packet.requestedMaterials.some((material) => material !== "document_metadata_sidecar")
      ? ["Do not mark a document as present until it exists locally in the document workspace."]
      : []),
  ];
}

function buildMetadataChecklist(
  packet: FundamentalReviewWorkbenchArtifact["followUpCollectionPlans"][number],
): string[] {
  const checklist = [
    "Confirm targetLabel and category are present in each sidecar.",
    "Record sourceType in each sidecar before re-running readiness checks.",
  ];
  if (packet.requestedMaterials.includes("document_metadata_sidecar")) {
    checklist.push("Backfill sidecars for all currently present local files first.");
  }
  return checklist;
}

function buildVerificationChecklist(
  packet: FundamentalReviewWorkbenchArtifact["followUpCollectionPlans"][number],
): string[] {
  return [
    ...packet.unblockConditions,
    "Re-run manifest/readiness processing after collection changes land.",
    "Verify the target leaves follow-up before opening a deeper-review packet.",
  ];
}

function buildFollowUpCollectionPacket(
  packet: FundamentalReviewWorkbenchArtifact["followUpCollectionPlans"][number],
): FollowUpCollectionPacket {
  return {
    targetLabel: packet.targetLabel,
    reviewPriority: packet.reviewPriority,
    packetFocus: derivePacketFocus(packet),
    requestedMaterials: packet.requestedMaterials,
    collectionSequence: packet.collectionOrder,
    namingReminders: buildNamingReminders(packet),
    metadataChecklist: buildMetadataChecklist(packet),
    verificationChecklist: buildVerificationChecklist(packet),
    nextCollectionTasks: packet.nextCollectionTasks,
    notes: packet.notes,
  };
}

function buildHoldSummary(
  packet: FundamentalReviewWorkbenchArtifact["blockedMonitoringChecklists"][number],
): string[] {
  if (packet.unblockConditions.length > 0) {
    return packet.unblockConditions;
  }
  return ["No unblock conditions recorded yet."];
}

function buildBlockedHoldPacket(
  packet: FundamentalReviewWorkbenchArtifact["blockedMonitoringChecklists"][number],
): BlockedHoldPacket {
  return {
    targetLabel: packet.targetLabel,
    reviewPriority: packet.reviewPriority,
    holdSummary: buildHoldSummary(packet),
    requestedMaterials: packet.requestedMaterials,
    unblockConditions: packet.unblockConditions,
    nextReviewGateChecks: packet.nextCheckpoints,
    notes: packet.holdNotes,
  };
}

function buildNextStepSummary(params: {
  deeperReviewDossiers: DeeperReviewDossier[];
  followUpCollectionPackets: FollowUpCollectionPacket[];
  blockedHoldPackets: BlockedHoldPacket[];
}): string[] {
  const summary: string[] = [];
  for (const dossier of params.deeperReviewDossiers) {
    summary.push(`Start drafting ${dossier.dossierTitle}.`);
  }
  for (const packet of params.followUpCollectionPackets) {
    const requested =
      packet.requestedMaterials.length > 0
        ? packet.requestedMaterials.map(humanizeLabel).join(", ")
        : "remaining blockers";
    summary.push(`Run a collection packet for ${packet.targetLabel}: ${requested}.`);
  }
  for (const packet of params.blockedHoldPackets) {
    summary.push(`Keep ${packet.targetLabel} on hold until its unblock conditions clear.`);
  }
  return summary;
}

function buildArtifactNotes(params: {
  packetStatus: TargetPacketStatus;
  dossiers: number;
  followUps: number;
  blocked: number;
}): string[] {
  if (params.packetStatus === "dossier_ready") {
    return [
      "At least one target now has a dossier-ready packet for deeper review.",
      "These packets remain research-only and do not create approvals or execution state.",
    ];
  }
  if (params.packetStatus === "collection") {
    return [
      `${params.dossiers} dossier-ready target(s), ${params.followUps} follow-up collection packet(s), and ${params.blocked} blocked hold packet(s) are currently active.`,
      "Use this artifact to drive the next human research cycle, not execution.",
    ];
  }
  return [
    "No dossier-ready targets exist yet.",
    "This artifact keeps blocked hold packets explicit without upgrading them into approvals.",
  ];
}

function renderTargetPacketsNote(params: {
  dateStr: string;
  timeStr: string;
  targetPacketsPath: string;
  targetPackets: FundamentalTargetPacketsArtifact;
}): string {
  return [
    `# Fundamental Target Packets: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.targetPackets.manifestId}`,
    `- target_packets_path: ${params.targetPacketsPath}`,
    `- packet_status: ${params.targetPackets.packetStatus}`,
    `- deeper_review_dossiers: ${params.targetPackets.deeperReviewDossiers.length}`,
    `- follow_up_collection_packets: ${params.targetPackets.followUpCollectionPackets.length}`,
    `- blocked_hold_packets: ${params.targetPackets.blockedHoldPackets.length}`,
    "",
    "## Next Step Summary",
    ...(params.targetPackets.nextStepSummary.length > 0
      ? params.targetPackets.nextStepSummary.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

export function buildFundamentalTargetPackets(params: {
  nowIso: string;
  reviewWorkbenchPath: string;
  reviewPlanPath: string;
  reviewBriefPath: string;
  reviewQueuePath: string;
  riskHandoffPath: string;
  workbench: FundamentalReviewWorkbenchArtifact;
}): FundamentalTargetPacketsArtifact {
  const deeperReviewDossiers = params.workbench.deeperReviewScaffolds.map(buildDeeperReviewDossier);
  const followUpCollectionPackets = params.workbench.followUpCollectionPlans.map(
    buildFollowUpCollectionPacket,
  );
  const blockedHoldPackets =
    params.workbench.blockedMonitoringChecklists.map(buildBlockedHoldPacket);

  const totalTargets =
    deeperReviewDossiers.length + followUpCollectionPackets.length + blockedHoldPackets.length;
  const packetStatus: TargetPacketStatus =
    deeperReviewDossiers.length === totalTargets && totalTargets > 0
      ? "dossier_ready"
      : deeperReviewDossiers.length > 0 || followUpCollectionPackets.length > 0
        ? "collection"
        : "blocked";

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.workbench.manifestId,
    manifestPath: params.workbench.manifestPath,
    reviewWorkbenchPath: params.reviewWorkbenchPath,
    reviewPlanPath: params.reviewPlanPath,
    reviewBriefPath: params.reviewBriefPath,
    reviewQueuePath: params.reviewQueuePath,
    riskHandoffPath: params.riskHandoffPath,
    requestTitle: params.workbench.requestTitle,
    researchBranch: params.workbench.researchBranch,
    packetStatus,
    summary: {
      totalTargets,
      deeperReviewDossiers: deeperReviewDossiers.length,
      followUpCollectionPackets: followUpCollectionPackets.length,
      blockedHoldPackets: blockedHoldPackets.length,
    },
    deeperReviewDossiers,
    followUpCollectionPackets,
    blockedHoldPackets,
    nextStepSummary: buildNextStepSummary({
      deeperReviewDossiers,
      followUpCollectionPackets,
      blockedHoldPackets,
    }),
    notes: buildArtifactNotes({
      packetStatus,
      dossiers: deeperReviewDossiers.length,
      followUps: followUpCollectionPackets.length,
      blocked: blockedHoldPackets.length,
    }),
  };
}

const materializeFundamentalTargetPackets: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const entries = await loadReviewWorkbenchesWithFallback(workspaceDir);
    if (entries.length === 0) {
      return;
    }

    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      entries.map(
        async ({
          workbench,
          reviewPlanPath,
          reviewBriefPath,
          reviewQueuePath,
          riskHandoffPath,
        }) => {
          const reviewWorkbenchPath = buildFundamentalReviewChainJsonPath(
            "fundamental-review-workbench",
            workbench.manifestId,
          );
          const targetPackets = buildFundamentalTargetPackets({
            nowIso,
            reviewWorkbenchPath,
            reviewPlanPath,
            reviewBriefPath,
            reviewQueuePath,
            riskHandoffPath,
            workbench,
          });
          const targetPacketsPath = buildFundamentalArtifactJsonPath(
            "fundamental-target-packets",
            workbench.manifestId,
          );
          const noteRelativePath = buildFundamentalArtifactNoteFilename({
            dateStr,
            stageName: "fundamental-target-packets",
            manifestId: workbench.manifestId,
          });
          await Promise.all([
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: targetPacketsPath,
              data: `${JSON.stringify(targetPackets, null, 2)}\n`,
              encoding: "utf-8",
            }),
            writeFileWithinRoot({
              rootDir: memoryDir,
              relativePath: noteRelativePath,
              data: renderTargetPacketsNote({
                dateStr,
                timeStr,
                targetPacketsPath,
                targetPackets,
              }),
              encoding: "utf-8",
            }),
          ]);
        },
      ),
    );

    log.info(`Fundamental target packets materialized ${entries.length} workbench(es)`);
  } catch (err) {
    log.error("Failed to materialize fundamental target packets", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalTargetPackets;
