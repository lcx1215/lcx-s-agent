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
  type FundamentalManifestPatchReviewEntry,
} from "../fundamental-manifest-patch-review/handler.js";
import type { FundamentalTargetReportsArtifact } from "../fundamental-target-reports/handler.js";
import {
  loadTargetPacketsWithFallback,
  type FundamentalTargetPacketsArtifact,
} from "../fundamental-target-workfiles/handler.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";

const log = createSubsystemLogger("hooks/fundamental-review-memo");

type ReportReviewTarget = {
  targetLabel: string;
  reportPath: string;
  reviewPriority: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number]["reviewPriority"];
  evidenceReadinessLevel: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number]["evidenceReadinessLevel"];
  sourceDraftPath: string;
  sourceSkeletonPath: string;
};

type CollectionFollowUpTarget = {
  targetLabel: string;
  patchPath: string;
  collectionWorkfilePath: string;
  recommendation: FundamentalManifestPatchReviewEntry["recommendation"];
  requestedMaterials: string[];
  manualChecks: string[];
  nextSteps: string[];
};

type BlockedMemoTarget = {
  targetLabel: string;
  reviewPriority: FundamentalTargetPacketsArtifact["blockedHoldPackets"][number]["reviewPriority"];
  requestedMaterials: string[];
  unblockConditions: string[];
  nextReviewGateChecks: string[];
};

type ReviewMemoStatus = "ready_for_report_review" | "follow_up_collection_needed" | "blocked_only";

export type FundamentalReviewMemoArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  targetReportsPath: string;
  collectionPacketsPath: string;
  targetPacketsPath: string;
  memoStatus: ReviewMemoStatus;
  reportReviewTargets: ReportReviewTarget[];
  collectionFollowUpTargets: CollectionFollowUpTarget[];
  blockedTargets: BlockedMemoTarget[];
  reviewFocus: string[];
  nextActions: string[];
  notes: string[];
};

type ReviewMemoInputs = {
  manifestId: string;
  manifestPath: string;
  targetReportsPath: string;
  collectionPacketsPath: string;
  targetPacketsPath: string;
  reportReviewTargets: ReportReviewTarget[];
  collectionFollowUpTargets: CollectionFollowUpTarget[];
  blockedTargets: BlockedMemoTarget[];
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

function getMemoStatus(params: {
  reportReviewTargets: number;
  collectionFollowUpTargets: number;
}): ReviewMemoStatus {
  if (params.reportReviewTargets > 0 && params.collectionFollowUpTargets === 0) {
    return "ready_for_report_review";
  }
  if (params.collectionFollowUpTargets > 0 || params.reportReviewTargets > 0) {
    return "follow_up_collection_needed";
  }
  return "blocked_only";
}

function buildReviewFocus(params: {
  reportReviewTargets: ReportReviewTarget[];
  collectionFollowUpTargets: CollectionFollowUpTarget[];
  blockedTargets: BlockedMemoTarget[];
}): string[] {
  const lines: string[] = [];
  for (const target of params.reportReviewTargets) {
    lines.push(`Review the formal target report for ${target.targetLabel}.`);
  }
  for (const target of params.collectionFollowUpTargets) {
    if (target.requestedMaterials.length > 0) {
      lines.push(
        `Collect or repair ${target.requestedMaterials.join(", ")} for ${target.targetLabel}.`,
      );
    } else {
      lines.push(`Resolve collection prerequisites for ${target.targetLabel}.`);
    }
  }
  for (const target of params.blockedTargets) {
    lines.push(
      `Keep ${target.targetLabel} blocked until ${target.unblockConditions.join(", ")} is cleared.`,
    );
  }
  return lines;
}

function buildNextActions(params: {
  reportReviewTargets: ReportReviewTarget[];
  collectionFollowUpTargets: CollectionFollowUpTarget[];
  blockedTargets: BlockedMemoTarget[];
}): string[] {
  const actions: string[] = [];
  for (const target of params.reportReviewTargets) {
    actions.push(`Read ${target.reportPath} and validate each claim against local sources.`);
  }
  for (const target of params.collectionFollowUpTargets) {
    actions.push(...target.nextSteps.map((line) => `${target.targetLabel}: ${line}`));
  }
  for (const target of params.blockedTargets) {
    actions.push(...target.nextReviewGateChecks.map((line) => `${target.targetLabel}: ${line}`));
  }
  return actions;
}

function buildArtifactNotes(params: {
  memoStatus: ReviewMemoStatus;
  reportReviewTargets: number;
  collectionFollowUpTargets: number;
  blockedTargets: number;
}): string[] {
  if (params.memoStatus === "ready_for_report_review") {
    return [
      `${params.reportReviewTargets} target report(s) are ready for research-only review.`,
      "This memo does not create approvals, ratings, or execution state.",
    ];
  }
  if (params.memoStatus === "follow_up_collection_needed") {
    return [
      `${params.reportReviewTargets} report-ready target(s), ${params.collectionFollowUpTargets} collection follow-up target(s), and ${params.blockedTargets} blocked target(s) were summarized.`,
      "Use this memo to drive the next research step, not execution.",
    ];
  }
  return [
    `${params.blockedTargets} target(s) remain blocked with no report-ready outputs yet.`,
    "This memo keeps blockers visible without upgrading them into approvals or execution state.",
  ];
}

function renderReviewMemo(params: { artifact: FundamentalReviewMemoArtifact }): string {
  const { artifact } = params;
  return [
    `# Fundamental Review Memo: ${artifact.manifestId}`,
    "",
    `- manifest_id: ${artifact.manifestId}`,
    `- memo_status: ${artifact.memoStatus}`,
    `- target_reports_path: ${artifact.targetReportsPath}`,
    `- collection_packets_path: ${artifact.collectionPacketsPath}`,
    `- target_packets_path: ${artifact.targetPacketsPath}`,
    "",
    "## Review Focus",
    ...(artifact.reviewFocus.length > 0
      ? artifact.reviewFocus.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Report Review Targets",
    ...(artifact.reportReviewTargets.length > 0
      ? artifact.reportReviewTargets.map(
          (entry) =>
            `- ${entry.targetLabel}: ${entry.reportPath} (${entry.reviewPriority}, ${entry.evidenceReadinessLevel})`,
        )
      : ["- none"]),
    "",
    "## Collection Follow-Ups",
    ...(artifact.collectionFollowUpTargets.length > 0
      ? artifact.collectionFollowUpTargets.map(
          (entry) =>
            `- ${entry.targetLabel}: ${entry.recommendation} -> ${entry.collectionWorkfilePath}`,
        )
      : ["- none"]),
    "",
    "## Blocked Targets",
    ...(artifact.blockedTargets.length > 0
      ? artifact.blockedTargets.map(
          (entry) => `- ${entry.targetLabel}: unblock -> ${entry.unblockConditions.join("; ")}`,
        )
      : ["- none"]),
    "",
    "## Next Actions",
    ...(artifact.nextActions.length > 0
      ? artifact.nextActions.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function renderReviewMemoNote(params: {
  dateStr: string;
  timeStr: string;
  reviewMemoPath: string;
  artifact: FundamentalReviewMemoArtifact;
}): string {
  return [
    `# Fundamental Review Memo: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.artifact.manifestId}`,
    `- review_memo_path: ${params.reviewMemoPath}`,
    `- memo_status: ${params.artifact.memoStatus}`,
    `- report_review_targets: ${params.artifact.reportReviewTargets.length}`,
    `- collection_follow_up_targets: ${params.artifact.collectionFollowUpTargets.length}`,
    `- blocked_targets: ${params.artifact.blockedTargets.length}`,
    "",
    "## Review Focus",
    ...(params.artifact.reviewFocus.length > 0
      ? params.artifact.reviewFocus.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

async function loadReviewMemoInputsWithFallback(workspaceDir: string): Promise<ReviewMemoInputs[]> {
  const [persistedReports, persistedCollectionPackets, targetPacketEntries, manifestPatches] =
    await Promise.all([
      loadJsonFiles<FundamentalTargetReportsArtifact>({
        dirPath: path.join(workspaceDir, "bank", "fundamental", "target-reports"),
        relativePrefix: "bank/fundamental/target-reports",
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
  const reportsById = new Map(
    persistedReports.map(({ relativePath, data }) => [data.manifestId, { relativePath, data }]),
  );
  const collectionPacketsById = new Map(
    persistedCollectionPackets.map(({ relativePath, data }) => [
      data.manifestId,
      { relativePath, data },
    ]),
  );

  const patchGroups = new Map<string, typeof manifestPatches>();
  for (const patch of manifestPatches) {
    const list = patchGroups.get(patch.patch.manifestId) ?? [];
    list.push(patch);
    patchGroups.set(patch.patch.manifestId, list);
  }

  const manifestIds = new Set<string>([
    ...targetPacketsById.keys(),
    ...reportsById.keys(),
    ...collectionPacketsById.keys(),
    ...patchGroups.keys(),
  ]);

  const resolved = await Promise.all(
    [...manifestIds].map(async (manifestId) => {
      const targetPacketsEntry = targetPacketsById.get(manifestId);
      if (!targetPacketsEntry) {
        return null;
      }

      const reportEntry = reportsById.get(manifestId);
      const collectionEntry = collectionPacketsById.get(manifestId);
      const reportReviewTargets =
        reportEntry?.data.reportFiles.map((entry) => ({
          targetLabel: entry.targetLabel,
          reportPath: entry.relativePath,
          reviewPriority: entry.reviewPriority,
          evidenceReadinessLevel: entry.evidenceReadinessLevel,
          sourceDraftPath: entry.sourceDraftPath,
          sourceSkeletonPath: entry.sourceSkeletonPath,
        })) ??
        targetPacketsEntry.targetPackets.deeperReviewDossiers.map((dossier) => {
          const targetSlug = slugifyTargetLabel(dossier.targetLabel);
          return {
            targetLabel: dossier.targetLabel,
            reportPath: `bank/fundamental/reports/${manifestId}/${targetSlug}.md`,
            reviewPriority: dossier.reviewPriority,
            evidenceReadinessLevel: dossier.evidenceReadinessLevel,
            sourceDraftPath: `bank/fundamental/drafts/${manifestId}/${targetSlug}.md`,
            sourceSkeletonPath: `bank/fundamental/deliverables/${manifestId}/dossiers/${targetSlug}.md`,
          };
        });

      const collectionFollowUpTargets =
        collectionEntry?.data.collectionPackets.map((entry) => ({
          targetLabel: entry.targetLabel,
          patchPath: entry.patchPath,
          collectionWorkfilePath: entry.collectionWorkfilePath,
          recommendation: entry.recommendation,
          requestedMaterials: entry.requestedMaterials,
          manualChecks: entry.manualChecks,
          nextSteps: entry.nextSteps,
        })) ??
        (await Promise.all(
          (patchGroups.get(manifestId) ?? []).map(async ({ relativePath, patch }) => {
            const review = buildManifestPatchReviewEntry({
              patchPath: relativePath,
              patch,
              targetDirExists: await targetDirExists(workspaceDir, patch.targetDir),
            });
            return {
              targetLabel: patch.targetLabel,
              patchPath: relativePath,
              collectionWorkfilePath: `bank/fundamental/collection-work/${manifestId}/${slugifyTargetLabel(patch.targetLabel)}.md`,
              recommendation: review.recommendation,
              requestedMaterials: patch.requestedMaterials,
              manualChecks: review.manualChecks,
              nextSteps: review.nextReviewSteps,
            };
          }),
        ));

      const blockedTargets = targetPacketsEntry.targetPackets.blockedHoldPackets.map((entry) => ({
        targetLabel: entry.targetLabel,
        reviewPriority: entry.reviewPriority,
        requestedMaterials: entry.requestedMaterials,
        unblockConditions: entry.unblockConditions,
        nextReviewGateChecks: entry.nextReviewGateChecks,
      }));

      return {
        manifestId,
        manifestPath: targetPacketsEntry.targetPackets.manifestPath,
        targetReportsPath:
          reportEntry?.relativePath ?? `bank/fundamental/target-reports/${manifestId}.json`,
        collectionPacketsPath:
          collectionEntry?.relativePath ?? `bank/fundamental/collection-packets/${manifestId}.json`,
        targetPacketsPath: targetPacketsEntry.relativePath,
        reportReviewTargets,
        collectionFollowUpTargets,
        blockedTargets,
      } satisfies ReviewMemoInputs;
    }),
  );

  return resolved
    .filter((entry): entry is ReviewMemoInputs => entry !== null)
    .toSorted((a, b) => a.manifestId.localeCompare(b.manifestId));
}

const materializeFundamentalReviewMemo: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const inputs = await loadReviewMemoInputsWithFallback(workspaceDir);
    if (inputs.length === 0) {
      return;
    }

    const nowIso = new Date(event.timestamp).toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      inputs.map(async (input) => {
        const memoStatus = getMemoStatus({
          reportReviewTargets: input.reportReviewTargets.length,
          collectionFollowUpTargets: input.collectionFollowUpTargets.length,
        });
        const artifact: FundamentalReviewMemoArtifact = {
          version: 1,
          generatedAt: nowIso,
          manifestId: input.manifestId,
          manifestPath: input.manifestPath,
          targetReportsPath: input.targetReportsPath,
          collectionPacketsPath: input.collectionPacketsPath,
          targetPacketsPath: input.targetPacketsPath,
          memoStatus,
          reportReviewTargets: input.reportReviewTargets,
          collectionFollowUpTargets: input.collectionFollowUpTargets,
          blockedTargets: input.blockedTargets,
          reviewFocus: buildReviewFocus({
            reportReviewTargets: input.reportReviewTargets,
            collectionFollowUpTargets: input.collectionFollowUpTargets,
            blockedTargets: input.blockedTargets,
          }),
          nextActions: buildNextActions({
            reportReviewTargets: input.reportReviewTargets,
            collectionFollowUpTargets: input.collectionFollowUpTargets,
            blockedTargets: input.blockedTargets,
          }),
          notes: buildArtifactNotes({
            memoStatus,
            reportReviewTargets: input.reportReviewTargets.length,
            collectionFollowUpTargets: input.collectionFollowUpTargets.length,
            blockedTargets: input.blockedTargets.length,
          }),
        };
        const reviewMemoPath = buildFundamentalArtifactJsonPath(
          "fundamental-review-memo",
          input.manifestId,
        );
        const memoFilePath = `bank/fundamental/memos/${input.manifestId}.md`;
        const noteRelativePath = buildFundamentalArtifactNoteFilename({
          dateStr,
          stageName: "fundamental-review-memo",
          manifestId: input.manifestId,
        });
        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: reviewMemoPath,
            data: `${JSON.stringify(artifact, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: memoFilePath,
            data: renderReviewMemo({ artifact }),
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderReviewMemoNote({
              dateStr,
              timeStr,
              reviewMemoPath,
              artifact,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental review memos materialized ${inputs.length} manifest(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental review memo", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalReviewMemo;
