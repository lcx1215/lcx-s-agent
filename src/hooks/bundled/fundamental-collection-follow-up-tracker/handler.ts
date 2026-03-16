import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import type { FundamentalCollectionPacketsArtifact } from "../fundamental-collection-packets/handler.js";
import {
  buildManifestPatchReviewEntry,
  loadCollectionManifestPatchesWithFallback,
} from "../fundamental-manifest-patch-review/handler.js";
import type { FundamentalReviewMemoArtifact } from "../fundamental-review-memo/handler.js";
import {
  loadTargetPacketsWithFallback,
  type FundamentalTargetPacketsArtifact,
} from "../fundamental-target-workfiles/handler.js";

const log = createSubsystemLogger("hooks/fundamental-collection-follow-up-tracker");

type FollowUpBlockerReason =
  | "missing_metadata_sidecar"
  | "missing_local_documents"
  | "mixed_follow_up"
  | "manual_review_before_collection";

type FollowUpTrackerStatus = "follow_up_active" | "manual_review_required" | "blocked_only";

type FollowUpTrackerEntry = {
  targetLabel: string;
  reviewPriority: FundamentalTargetPacketsArtifact["followUpCollectionPackets"][number]["reviewPriority"];
  blockerReason: FollowUpBlockerReason;
  recommendation:
    | "collect_then_review"
    | "metadata_repair_then_review"
    | "manual_review_before_collection";
  missingMaterials: string[];
  missingMetadata: boolean;
  nextRequiredCollectionAction: string;
  collectionWorkfilePath: string;
  patchPath: string;
  manualChecks: string[];
};

type BlockedTrackerEntry = {
  targetLabel: string;
  reviewPriority: FundamentalTargetPacketsArtifact["blockedHoldPackets"][number]["reviewPriority"];
  blockerReason: "review_gate_blocked";
  missingMaterials: string[];
  unblockConditions: string[];
  nextReviewGateChecks: string[];
};

export type FundamentalCollectionFollowUpTrackerArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  reviewMemoPath: string;
  collectionPacketsPath: string;
  targetPacketsPath: string;
  trackerStatus: FollowUpTrackerStatus;
  followUpTargets: FollowUpTrackerEntry[];
  blockedTargets: BlockedTrackerEntry[];
  nextCollectionPriorities: string[];
  notes: string[];
};

type TrackerInputs = {
  manifestId: string;
  manifestPath: string;
  reviewMemoPath: string;
  collectionPacketsPath: string;
  targetPacketsPath: string;
  followUpTargets: FollowUpTrackerEntry[];
  blockedTargets: BlockedTrackerEntry[];
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

function slugifyTargetLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "target"
  );
}

async function targetDirExists(workspaceDir: string, targetDir: string | null): Promise<boolean> {
  if (!targetDir) {
    return false;
  }
  try {
    const stat = await fs.stat(path.join(workspaceDir, targetDir));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function deriveBlockerReason(params: {
  recommendation: FollowUpTrackerEntry["recommendation"];
  packetFocus: "metadata_repair" | "document_collection" | "mixed_follow_up" | undefined;
}): FollowUpBlockerReason {
  if (params.recommendation === "manual_review_before_collection") {
    return "manual_review_before_collection";
  }
  if (params.recommendation === "metadata_repair_then_review") {
    return "missing_metadata_sidecar";
  }
  if (params.packetFocus === "mixed_follow_up") {
    return "mixed_follow_up";
  }
  return "missing_local_documents";
}

function buildNextCollectionPriorities(params: {
  followUpTargets: FollowUpTrackerEntry[];
  blockedTargets: BlockedTrackerEntry[];
}): string[] {
  const sortedFollowUps = [...params.followUpTargets].toSorted(
    (a, b) =>
      priorityWeight(b.reviewPriority) - priorityWeight(a.reviewPriority) ||
      a.targetLabel.localeCompare(b.targetLabel),
  );
  const lines = sortedFollowUps.map(
    (entry) =>
      `${entry.targetLabel}: ${entry.nextRequiredCollectionAction} (${entry.reviewPriority}, ${entry.blockerReason})`,
  );
  for (const target of params.blockedTargets) {
    lines.push(
      `${target.targetLabel}: remain blocked until ${target.unblockConditions.join(", ")} (${target.reviewPriority})`,
    );
  }
  return lines;
}

function buildArtifactNotes(params: {
  trackerStatus: FollowUpTrackerStatus;
  followUpTargets: number;
  blockedTargets: number;
}): string[] {
  if (params.trackerStatus === "manual_review_required") {
    return [
      `${params.followUpTargets} collection follow-up target(s) need manual review before collection can proceed.`,
      "This tracker remains research-only and does not approve collection automatically.",
    ];
  }
  if (params.trackerStatus === "follow_up_active") {
    return [
      `${params.followUpTargets} collection follow-up target(s) are ready for the next research-side collection action.`,
      "This tracker only records collection gaps, priorities, and next steps.",
    ];
  }
  return [
    `${params.blockedTargets} blocked target(s) remain outside collection follow-up until the review gate clears.`,
    "This tracker keeps blockers visible without promoting them into approvals or execution state.",
  ];
}

function priorityWeight(priority: "low" | "medium" | "high"): number {
  if (priority === "high") {
    return 3;
  }
  if (priority === "medium") {
    return 2;
  }
  return 1;
}

function renderTrackerMarkdown(params: {
  artifact: FundamentalCollectionFollowUpTrackerArtifact;
}): string {
  const { artifact } = params;
  return [
    `# Fundamental Collection Follow-Up Tracker: ${artifact.manifestId}`,
    "",
    `- manifest_id: ${artifact.manifestId}`,
    `- tracker_status: ${artifact.trackerStatus}`,
    `- review_memo_path: ${artifact.reviewMemoPath}`,
    `- collection_packets_path: ${artifact.collectionPacketsPath}`,
    `- target_packets_path: ${artifact.targetPacketsPath}`,
    "",
    "## Follow-Up Targets",
    ...(artifact.followUpTargets.length > 0
      ? artifact.followUpTargets.map(
          (entry) =>
            `- ${entry.targetLabel}: ${entry.blockerReason} -> ${entry.nextRequiredCollectionAction} (${entry.reviewPriority})`,
        )
      : ["- none"]),
    "",
    "## Blocked Targets",
    ...(artifact.blockedTargets.length > 0
      ? artifact.blockedTargets.map(
          (entry) =>
            `- ${entry.targetLabel}: ${entry.unblockConditions.join("; ")} (${entry.reviewPriority})`,
        )
      : ["- none"]),
    "",
    "## Next Collection Priorities",
    ...(artifact.nextCollectionPriorities.length > 0
      ? artifact.nextCollectionPriorities.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function renderTrackerNote(params: {
  dateStr: string;
  timeStr: string;
  trackerPath: string;
  artifact: FundamentalCollectionFollowUpTrackerArtifact;
}): string {
  return [
    `# Fundamental Collection Follow-Up Tracker: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.artifact.manifestId}`,
    `- collection_follow_up_tracker_path: ${params.trackerPath}`,
    `- tracker_status: ${params.artifact.trackerStatus}`,
    `- follow_up_targets: ${params.artifact.followUpTargets.length}`,
    `- blocked_targets: ${params.artifact.blockedTargets.length}`,
    "",
    "## Next Collection Priorities",
    ...(params.artifact.nextCollectionPriorities.length > 0
      ? params.artifact.nextCollectionPriorities.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

async function loadTrackerInputsWithFallback(workspaceDir: string): Promise<TrackerInputs[]> {
  const [reviewMemos, collectionPackets, targetPacketEntries, manifestPatches] = await Promise.all([
    loadJsonFiles<FundamentalReviewMemoArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "review-memos"),
      relativePrefix: "bank/fundamental/review-memos",
    }),
    loadJsonFiles<FundamentalCollectionPacketsArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "collection-packets"),
      relativePrefix: "bank/fundamental/collection-packets",
    }),
    loadTargetPacketsWithFallback(workspaceDir),
    loadCollectionManifestPatchesWithFallback(workspaceDir),
  ]);

  const targetPacketsById = new Map(
    targetPacketEntries.map(({ relativePath, targetPackets }) => [
      targetPackets.manifestId,
      { relativePath, targetPackets },
    ]),
  );
  const reviewMemoById = new Map(
    reviewMemos.map(({ relativePath, data }) => [data.manifestId, { relativePath, data }]),
  );
  const collectionPacketsById = new Map(
    collectionPackets.map(({ relativePath, data }) => [data.manifestId, { relativePath, data }]),
  );

  const patchGroups = new Map<string, typeof manifestPatches>();
  for (const patch of manifestPatches) {
    const list = patchGroups.get(patch.patch.manifestId) ?? [];
    list.push(patch);
    patchGroups.set(patch.patch.manifestId, list);
  }

  const inputs = await Promise.all(
    [...targetPacketsById.entries()].map(async ([manifestId, targetPacketsEntry]) => {
      const followUpByTarget = new Map(
        targetPacketsEntry.targetPackets.followUpCollectionPackets.map((entry) => [
          entry.targetLabel,
          entry,
        ]),
      );

      const blockedTargets = targetPacketsEntry.targetPackets.blockedHoldPackets.map((entry) => ({
        targetLabel: entry.targetLabel,
        reviewPriority: entry.reviewPriority,
        blockerReason: "review_gate_blocked" as const,
        missingMaterials: entry.requestedMaterials,
        unblockConditions: entry.unblockConditions,
        nextReviewGateChecks: entry.nextReviewGateChecks,
      }));

      const persistedCollection = collectionPacketsById.get(manifestId);
      const followUpTargets =
        persistedCollection?.data.collectionPackets.map((entry) => {
          const packet = followUpByTarget.get(entry.targetLabel);
          const missingMetadata =
            entry.recommendation === "metadata_repair_then_review" ||
            Boolean(packet?.requestedMaterials.includes("document_metadata_sidecar"));
          return {
            targetLabel: entry.targetLabel,
            reviewPriority: packet?.reviewPriority ?? "medium",
            blockerReason: deriveBlockerReason({
              recommendation: entry.recommendation,
              packetFocus: packet?.packetFocus,
            }),
            recommendation: entry.recommendation,
            missingMaterials: entry.requestedMaterials.filter(
              (material) => material !== "document_metadata_sidecar",
            ),
            missingMetadata,
            nextRequiredCollectionAction:
              entry.nextSteps[0] ?? "Review the proposal-only collection packet.",
            collectionWorkfilePath: entry.collectionWorkfilePath,
            patchPath: entry.patchPath,
            manualChecks: entry.manualChecks,
          };
        }) ??
        (await Promise.all(
          (patchGroups.get(manifestId) ?? []).map(async ({ relativePath, patch }) => {
            const packet = followUpByTarget.get(patch.targetLabel);
            const review = buildManifestPatchReviewEntry({
              patchPath: relativePath,
              patch,
              targetDirExists: await targetDirExists(workspaceDir, patch.targetDir),
            });
            return {
              targetLabel: patch.targetLabel,
              reviewPriority: packet?.reviewPriority ?? "medium",
              blockerReason: deriveBlockerReason({
                recommendation: review.recommendation,
                packetFocus: packet?.packetFocus,
              }),
              recommendation: review.recommendation,
              missingMaterials: patch.requestedMaterials.filter(
                (material) => material !== "document_metadata_sidecar",
              ),
              missingMetadata:
                review.recommendation === "metadata_repair_then_review" ||
                patch.requestedMaterials.includes("document_metadata_sidecar"),
              nextRequiredCollectionAction:
                review.nextReviewSteps[0] ?? "Review the proposal-only collection packet.",
              collectionWorkfilePath: `bank/fundamental/collection-work/${manifestId}/${slugifyTargetLabel(patch.targetLabel)}.md`,
              patchPath: relativePath,
              manualChecks: review.manualChecks,
            };
          }),
        ));

      if (followUpTargets.length === 0 && blockedTargets.length === 0) {
        return null;
      }

      return {
        manifestId,
        manifestPath: targetPacketsEntry.targetPackets.manifestPath,
        reviewMemoPath:
          reviewMemoById.get(manifestId)?.relativePath ??
          `bank/fundamental/review-memos/${manifestId}.json`,
        collectionPacketsPath:
          persistedCollection?.relativePath ??
          `bank/fundamental/collection-packets/${manifestId}.json`,
        targetPacketsPath: targetPacketsEntry.relativePath,
        followUpTargets,
        blockedTargets,
      } satisfies TrackerInputs;
    }),
  );

  return inputs
    .filter((entry): entry is TrackerInputs => entry !== null)
    .toSorted((a, b) => a.manifestId.localeCompare(b.manifestId));
}

const materializeFundamentalCollectionFollowUpTracker: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const inputs = await loadTrackerInputsWithFallback(workspaceDir);
    if (inputs.length === 0) {
      return;
    }

    const nowIso = new Date(event.timestamp).toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      inputs.map(async (input) => {
        const trackerStatus: FollowUpTrackerStatus = input.followUpTargets.some(
          (entry) => entry.recommendation === "manual_review_before_collection",
        )
          ? "manual_review_required"
          : input.followUpTargets.length > 0
            ? "follow_up_active"
            : "blocked_only";

        const artifact: FundamentalCollectionFollowUpTrackerArtifact = {
          version: 1,
          generatedAt: nowIso,
          manifestId: input.manifestId,
          manifestPath: input.manifestPath,
          reviewMemoPath: input.reviewMemoPath,
          collectionPacketsPath: input.collectionPacketsPath,
          targetPacketsPath: input.targetPacketsPath,
          trackerStatus,
          followUpTargets: input.followUpTargets,
          blockedTargets: input.blockedTargets,
          nextCollectionPriorities: buildNextCollectionPriorities({
            followUpTargets: input.followUpTargets,
            blockedTargets: input.blockedTargets,
          }),
          notes: buildArtifactNotes({
            trackerStatus,
            followUpTargets: input.followUpTargets.length,
            blockedTargets: input.blockedTargets.length,
          }),
        };
        const trackerPath = `bank/fundamental/collection-follow-up-trackers/${input.manifestId}.json`;
        const trackerFilePath = `bank/fundamental/follow-up-trackers/${input.manifestId}.md`;
        const noteRelativePath = `${dateStr}-fundamental-collection-follow-up-tracker-${input.manifestId}.md`;

        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: trackerPath,
            data: `${JSON.stringify(artifact, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: trackerFilePath,
            data: renderTrackerMarkdown({ artifact }),
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderTrackerNote({
              dateStr,
              timeStr,
              trackerPath,
              artifact,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental collection follow-up trackers materialized ${inputs.length} manifest(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental collection follow-up tracker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalCollectionFollowUpTracker;
