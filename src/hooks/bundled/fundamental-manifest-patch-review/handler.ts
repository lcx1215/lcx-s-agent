import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import type { FundamentalManifestScaffold } from "../fundamental-intake/handler.js";
import {
  buildCollectionManifestPatch,
  type FundamentalCollectionManifestPatch,
} from "../fundamental-target-deliverables/handler.js";
import { loadTargetPacketsWithFallback } from "../fundamental-target-workfiles/handler.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";

const log = createSubsystemLogger("hooks/fundamental-manifest-patch-review");

type PatchReviewRecommendation =
  | "collect_then_review"
  | "metadata_repair_then_review"
  | "manual_review_before_collection";

export type FundamentalManifestPatchReviewEntry = {
  targetLabel: string;
  patchPath: string;
  targetDir: string | null;
  targetDirExists: boolean;
  recommendation: PatchReviewRecommendation;
  requiresMetadataSidecar: boolean;
  missingPrerequisites: string[];
  manualChecks: string[];
  requestedMaterials: string[];
  nextReviewSteps: string[];
};

export type FundamentalManifestPatchReviewArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  reviewStatus: "review_blocked" | "review_ready";
  patchReviews: FundamentalManifestPatchReviewEntry[];
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

export function buildManifestPatchReviewEntry(params: {
  patchPath: string;
  patch: FundamentalCollectionManifestPatch;
  targetDirExists: boolean;
}): FundamentalManifestPatchReviewEntry {
  const missingPrerequisites: string[] = [];
  if (!params.patch.targetDir) {
    missingPrerequisites.push("manifest target directory is unresolved");
  } else if (!params.targetDirExists) {
    missingPrerequisites.push("manifest target directory does not exist locally yet");
  }

  const requiresMetadataSidecar = params.patch.operations.some(
    (operation) => operation.kind === "require_metadata_sidecar",
  );
  const recommendation: PatchReviewRecommendation =
    missingPrerequisites.length > 0
      ? "manual_review_before_collection"
      : params.patch.packetFocus === "metadata_repair"
        ? "metadata_repair_then_review"
        : "collect_then_review";

  const manualChecks = [
    `Confirm target directory before collection: ${params.patch.targetDir ?? "unresolved"}.`,
    `Keep filenames aligned with ${params.patch.fileNamePattern}.`,
    requiresMetadataSidecar
      ? `Require sidecars with suffix ${params.patch.metadataSidecarSuffix} for every newly collected file.`
      : "No mandatory sidecar rule was inferred.",
    ...params.patch.verificationChecklist,
  ];

  return {
    targetLabel: params.patch.targetLabel,
    patchPath: params.patchPath,
    targetDir: params.patch.targetDir,
    targetDirExists: params.targetDirExists,
    recommendation,
    requiresMetadataSidecar,
    missingPrerequisites,
    manualChecks,
    requestedMaterials: params.patch.requestedMaterials,
    nextReviewSteps: [
      ...params.patch.nextCollectionTasks,
      "Keep this patch proposal-only until a human explicitly reviews the collection result.",
    ],
  };
}

function buildArtifactNotes(params: {
  patchReviews: FundamentalManifestPatchReviewEntry[];
}): string[] {
  return [
    `${params.patchReviews.length} manifest patch review item(s) were prepared.`,
    "These reviews are proposal-only and do not modify manifests automatically.",
  ];
}

function renderManifestPatchReviewNote(params: {
  dateStr: string;
  timeStr: string;
  reviewPath: string;
  artifact: FundamentalManifestPatchReviewArtifact;
}): string {
  return [
    `# Fundamental Manifest Patch Review: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.artifact.manifestId}`,
    `- manifest_patch_review_path: ${params.reviewPath}`,
    `- review_status: ${params.artifact.reviewStatus}`,
    `- reviewed_patches: ${params.artifact.patchReviews.length}`,
    "",
    "## Review Items",
    ...params.artifact.patchReviews.map(
      (entry) => `- ${entry.targetLabel}: ${entry.recommendation} -> ${entry.patchPath}`,
    ),
    "",
  ].join("\n");
}

export async function loadCollectionManifestPatchesWithFallback(
  workspaceDir: string,
): Promise<Array<{ relativePath: string; patch: FundamentalCollectionManifestPatch }>> {
  const [persistedPatches, manifests, targetPacketEntries] = await Promise.all([
    loadJsonFiles<FundamentalCollectionManifestPatch>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "deliverables"),
      relativePrefix: "bank/fundamental/deliverables",
    }),
    loadJsonFiles<FundamentalManifestScaffold>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
      relativePrefix: "bank/fundamental/manifests",
    }),
    loadTargetPacketsWithFallback(workspaceDir),
  ]);

  const manifestById = new Map(manifests.map(({ data }) => [data.manifestId, data]));
  const resolved = new Map<
    string,
    { relativePath: string; patch: FundamentalCollectionManifestPatch }
  >();

  for (const entry of persistedPatches) {
    if (!entry.relativePath.includes("/manifest-patches/")) {
      continue;
    }
    resolved.set(`${entry.data.manifestId}:${entry.data.targetLabel}`, {
      relativePath: entry.relativePath,
      patch: entry.data,
    });
  }

  for (const { targetPackets } of targetPacketEntries) {
    const manifest = manifestById.get(targetPackets.manifestId);
    for (const packet of targetPackets.followUpCollectionPackets) {
      const key = `${targetPackets.manifestId}:${packet.targetLabel}`;
      if (resolved.has(key)) {
        continue;
      }
      resolved.set(key, {
        relativePath: `bank/fundamental/deliverables/${targetPackets.manifestId}/manifest-patches/${slugifyTargetLabel(packet.targetLabel)}.json`,
        patch: buildCollectionManifestPatch({
          nowIso: targetPackets.generatedAt,
          manifestPath: targetPackets.manifestPath,
          manifest,
          packet,
        }),
      });
    }
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      a.patch.manifestId.localeCompare(b.patch.manifestId) ||
      a.patch.targetLabel.localeCompare(b.patch.targetLabel),
  );
}

const materializeFundamentalManifestPatchReview: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const patches = await loadCollectionManifestPatchesWithFallback(workspaceDir);
    if (patches.length === 0) {
      return;
    }

    const grouped = new Map<
      string,
      Array<{ relativePath: string; patch: FundamentalCollectionManifestPatch }>
    >();
    for (const patch of patches) {
      const list = grouped.get(patch.patch.manifestId) ?? [];
      list.push(patch);
      grouped.set(patch.patch.manifestId, list);
    }

    const nowIso = new Date(event.timestamp).toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      [...grouped.entries()].map(async ([manifestId, manifestPatches]) => {
        const patchReviews = await Promise.all(
          manifestPatches.map(async ({ relativePath, patch }) =>
            buildManifestPatchReviewEntry({
              patchPath: relativePath,
              patch,
              targetDirExists: await targetDirExists(workspaceDir, patch.targetDir),
            }),
          ),
        );

        const artifact: FundamentalManifestPatchReviewArtifact = {
          version: 1,
          generatedAt: nowIso,
          manifestId,
          manifestPath: manifestPatches[0]?.patch.manifestPath ?? "unknown",
          reviewStatus: patchReviews.some((entry) => entry.missingPrerequisites.length > 0)
            ? "review_blocked"
            : "review_ready",
          patchReviews,
          notes: buildArtifactNotes({ patchReviews }),
        };
        const reviewPath = buildFundamentalArtifactJsonPath(
          "fundamental-manifest-patch-review",
          manifestId,
        );
        const noteRelativePath = buildFundamentalArtifactNoteFilename({
          dateStr,
          stageName: "fundamental-manifest-patch-review",
          manifestId,
        });

        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: reviewPath,
            data: `${JSON.stringify(artifact, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderManifestPatchReviewNote({
              dateStr,
              timeStr,
              reviewPath,
              artifact,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental manifest patch reviews materialized ${grouped.size} manifest(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental manifest patch reviews", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalManifestPatchReview;
