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
  buildFundamentalTargetPackets,
  type FundamentalTargetPacketsArtifact,
} from "../fundamental-target-packets/handler.js";
export type { FundamentalTargetPacketsArtifact } from "../fundamental-target-packets/handler.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";

const log = createSubsystemLogger("hooks/fundamental-target-workfiles");

type TargetWorkfileEntry = {
  targetLabel: string;
  kind: "dossier" | "collection" | "hold";
  relativePath: string;
};

export type FundamentalTargetWorkfilesArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  targetPacketsPath: string;
  outputDir: string;
  status: FundamentalTargetPacketsArtifact["packetStatus"];
  dossierFiles: TargetWorkfileEntry[];
  collectionFiles: TargetWorkfileEntry[];
  holdFiles: TargetWorkfileEntry[];
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

export async function loadTargetPacketsWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    targetPackets: FundamentalTargetPacketsArtifact;
    reviewWorkbenchPath: string;
    reviewPlanPath: string;
    reviewBriefPath: string;
    reviewQueuePath: string;
    riskHandoffPath: string;
  }>
> {
  const [persistedPackets, workbenches] = await Promise.all([
    loadJsonFiles<FundamentalTargetPacketsArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "target-packets"),
      relativePrefix: "bank/fundamental/target-packets",
    }),
    loadReviewWorkbenchesWithFallback(workspaceDir),
  ]);

  const workbenchById = new Map(workbenches.map((entry) => [entry.workbench.manifestId, entry]));
  const resolved = new Map<
    string,
    {
      relativePath: string;
      targetPackets: FundamentalTargetPacketsArtifact;
      reviewWorkbenchPath: string;
      reviewPlanPath: string;
      reviewBriefPath: string;
      reviewQueuePath: string;
      riskHandoffPath: string;
    }
  >();

  for (const { relativePath, data } of persistedPackets) {
    const workbench = workbenchById.get(data.manifestId);
    if (!workbench) {
      continue;
    }
    resolved.set(data.manifestId, {
      relativePath,
      targetPackets: data,
      reviewWorkbenchPath: workbench.relativePath,
      reviewPlanPath: workbench.reviewPlanPath,
      reviewBriefPath: workbench.reviewBriefPath,
      reviewQueuePath: workbench.reviewQueuePath,
      riskHandoffPath: workbench.riskHandoffPath,
    });
  }

  for (const workbench of workbenches) {
    if (resolved.has(workbench.workbench.manifestId)) {
      continue;
    }
    resolved.set(workbench.workbench.manifestId, {
      relativePath: `bank/fundamental/target-packets/${workbench.workbench.manifestId}.json`,
      targetPackets: buildFundamentalTargetPackets({
        nowIso: workbench.workbench.generatedAt,
        reviewWorkbenchPath: workbench.relativePath,
        reviewPlanPath: workbench.reviewPlanPath,
        reviewBriefPath: workbench.reviewBriefPath,
        reviewQueuePath: workbench.reviewQueuePath,
        riskHandoffPath: workbench.riskHandoffPath,
        workbench: workbench.workbench,
      }),
      reviewWorkbenchPath: workbench.relativePath,
      reviewPlanPath: workbench.reviewPlanPath,
      reviewBriefPath: workbench.reviewBriefPath,
      reviewQueuePath: workbench.reviewQueuePath,
      riskHandoffPath: workbench.riskHandoffPath,
    });
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.targetPackets.generatedAt.localeCompare(a.targetPackets.generatedAt) ||
      a.targetPackets.manifestId.localeCompare(b.targetPackets.manifestId),
  );
}

function slugifyTargetLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "target"
  );
}

function renderDossierWorkfile(
  dossier: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number],
): string {
  return [
    `# ${dossier.dossierTitle}`,
    "",
    `- target: ${dossier.targetLabel}`,
    `- review_priority: ${dossier.reviewPriority}`,
    `- evidence_readiness_level: ${dossier.evidenceReadinessLevel}`,
    "",
    "## Thesis Template",
    ...dossier.thesisTemplate.map((line) => `- ${line}`),
    "",
    "## Evidence Matrix",
    ...dossier.evidenceMatrix.map((line) => `- ${line}`),
    "",
    "## Citation Tasks",
    ...dossier.citationTasks.map((line) => `- ${line}`),
    "",
    "## Writing Checklist",
    ...dossier.writingChecklist.map((line) => `- ${line}`),
    "",
    "## Open Questions",
    ...dossier.openQuestions.map((line) => `- ${line}`),
    "",
    "## Immediate Tasks",
    ...dossier.immediateTasks.map((line) => `- ${line}`),
    "",
    "## Local Documents",
    ...(dossier.documentPaths.length > 0
      ? dossier.documentPaths.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function renderCollectionWorkfile(
  packet: FundamentalTargetPacketsArtifact["followUpCollectionPackets"][number],
): string {
  return [
    `# ${packet.targetLabel} Collection Packet`,
    "",
    `- target: ${packet.targetLabel}`,
    `- review_priority: ${packet.reviewPriority}`,
    `- packet_focus: ${packet.packetFocus}`,
    "",
    "## Requested Materials",
    ...(packet.requestedMaterials.length > 0
      ? packet.requestedMaterials.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Collection Sequence",
    ...packet.collectionSequence.map((line) => `- ${line}`),
    "",
    "## Naming Reminders",
    ...packet.namingReminders.map((line) => `- ${line}`),
    "",
    "## Metadata Checklist",
    ...packet.metadataChecklist.map((line) => `- ${line}`),
    "",
    "## Verification Checklist",
    ...packet.verificationChecklist.map((line) => `- ${line}`),
    "",
    "## Next Collection Tasks",
    ...packet.nextCollectionTasks.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function renderHoldWorkfile(
  packet: FundamentalTargetPacketsArtifact["blockedHoldPackets"][number],
): string {
  return [
    `# ${packet.targetLabel} Hold Packet`,
    "",
    `- target: ${packet.targetLabel}`,
    `- review_priority: ${packet.reviewPriority}`,
    "",
    "## Hold Summary",
    ...packet.holdSummary.map((line) => `- ${line}`),
    "",
    "## Requested Materials",
    ...(packet.requestedMaterials.length > 0
      ? packet.requestedMaterials.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Unblock Conditions",
    ...packet.unblockConditions.map((line) => `- ${line}`),
    "",
    "## Next Review-Gate Checks",
    ...packet.nextReviewGateChecks.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function buildArtifactNotes(params: {
  dossierFiles: number;
  collectionFiles: number;
  holdFiles: number;
}): string[] {
  return [
    `${params.dossierFiles} dossier file(s), ${params.collectionFiles} collection file(s), and ${params.holdFiles} hold file(s) were materialized.`,
    "These workfiles remain research-only and do not create approvals or execution state.",
  ];
}

function renderTargetWorkfilesNote(params: {
  dateStr: string;
  timeStr: string;
  targetWorkfilesPath: string;
  targetWorkfiles: FundamentalTargetWorkfilesArtifact;
}): string {
  return [
    `# Fundamental Target Workfiles: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.targetWorkfiles.manifestId}`,
    `- target_workfiles_path: ${params.targetWorkfilesPath}`,
    `- status: ${params.targetWorkfiles.status}`,
    `- dossier_files: ${params.targetWorkfiles.dossierFiles.length}`,
    `- collection_files: ${params.targetWorkfiles.collectionFiles.length}`,
    `- hold_files: ${params.targetWorkfiles.holdFiles.length}`,
    "",
    "## Workfiles",
    ...[
      ...params.targetWorkfiles.dossierFiles,
      ...params.targetWorkfiles.collectionFiles,
      ...params.targetWorkfiles.holdFiles,
    ].map((entry) => `- ${entry.kind}: ${entry.targetLabel} -> ${entry.relativePath}`),
    "",
  ].join("\n");
}

const materializeFundamentalTargetWorkfiles: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const entries = await loadTargetPacketsWithFallback(workspaceDir);
    if (entries.length === 0) {
      return;
    }

    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      entries.map(async ({ relativePath, targetPackets }) => {
        const outputDir = `bank/fundamental/workfiles/${targetPackets.manifestId}`;
        const dossierFiles: TargetWorkfileEntry[] = [];
        const collectionFiles: TargetWorkfileEntry[] = [];
        const holdFiles: TargetWorkfileEntry[] = [];
        const writes: Array<Promise<void>> = [];

        for (const dossier of targetPackets.deeperReviewDossiers) {
          const relativeFile = `${outputDir}/dossiers/${slugifyTargetLabel(dossier.targetLabel)}.md`;
          dossierFiles.push({
            targetLabel: dossier.targetLabel,
            kind: "dossier",
            relativePath: relativeFile,
          });
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: relativeFile,
              data: renderDossierWorkfile(dossier),
              encoding: "utf-8",
            }),
          );
        }

        for (const packet of targetPackets.followUpCollectionPackets) {
          const relativeFile = `${outputDir}/collection/${slugifyTargetLabel(packet.targetLabel)}.md`;
          collectionFiles.push({
            targetLabel: packet.targetLabel,
            kind: "collection",
            relativePath: relativeFile,
          });
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: relativeFile,
              data: renderCollectionWorkfile(packet),
              encoding: "utf-8",
            }),
          );
        }

        for (const packet of targetPackets.blockedHoldPackets) {
          const relativeFile = `${outputDir}/holds/${slugifyTargetLabel(packet.targetLabel)}.md`;
          holdFiles.push({
            targetLabel: packet.targetLabel,
            kind: "hold",
            relativePath: relativeFile,
          });
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: relativeFile,
              data: renderHoldWorkfile(packet),
              encoding: "utf-8",
            }),
          );
        }

        const targetWorkfiles: FundamentalTargetWorkfilesArtifact = {
          version: 1,
          generatedAt: nowIso,
          manifestId: targetPackets.manifestId,
          manifestPath: targetPackets.manifestPath,
          targetPacketsPath: relativePath,
          outputDir,
          status: targetPackets.packetStatus,
          dossierFiles,
          collectionFiles,
          holdFiles,
          notes: buildArtifactNotes({
            dossierFiles: dossierFiles.length,
            collectionFiles: collectionFiles.length,
            holdFiles: holdFiles.length,
          }),
        };
        const targetWorkfilesPath = buildFundamentalArtifactJsonPath(
          "fundamental-target-workfiles",
          targetPackets.manifestId,
        );
        const noteRelativePath = buildFundamentalArtifactNoteFilename({
          dateStr,
          stageName: "fundamental-target-workfiles",
          manifestId: targetPackets.manifestId,
        });
        writes.push(
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: targetWorkfilesPath,
            data: `${JSON.stringify(targetWorkfiles, null, 2)}\n`,
            encoding: "utf-8",
          }),
        );
        writes.push(
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderTargetWorkfilesNote({
              dateStr,
              timeStr,
              targetWorkfilesPath,
              targetWorkfiles,
            }),
            encoding: "utf-8",
          }),
        );
        await Promise.all(writes);
      }),
    );

    log.info(`Fundamental target workfiles materialized ${entries.length} packet set(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental target workfiles", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalTargetWorkfiles;
