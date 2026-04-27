import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";
import {
  buildManifestPatchReviewEntry,
  loadCollectionManifestPatchesWithFallback,
  type FundamentalManifestPatchReviewEntry,
} from "../fundamental-manifest-patch-review/handler.js";

const log = createSubsystemLogger("hooks/fundamental-collection-packets");

type CollectionPacketEntry = {
  targetLabel: string;
  patchPath: string;
  collectionWorkfilePath: string;
  recommendation: FundamentalManifestPatchReviewEntry["recommendation"];
  targetDir: string | null;
  fileNamePattern: string;
  metadataSidecarSuffix: string;
  requestedMaterials: string[];
  manualChecks: string[];
  nextSteps: string[];
  applyStatus: "proposal_only";
};

export type FundamentalCollectionPacketsArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  status: "pending_collection" | "manual_review_required";
  collectionPackets: CollectionPacketEntry[];
  notes: string[];
};

function slugifyTargetLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "target"
  );
}

function renderCollectionPacket(entry: CollectionPacketEntry): string {
  return [
    `# ${entry.targetLabel} Collection Patch Packet`,
    "",
    `- target: ${entry.targetLabel}`,
    `- patch_path: ${entry.patchPath}`,
    `- recommendation: ${entry.recommendation}`,
    `- target_dir: ${entry.targetDir ?? "unresolved"}`,
    `- file_name_pattern: ${entry.fileNamePattern}`,
    `- metadata_sidecar_suffix: ${entry.metadataSidecarSuffix}`,
    `- apply_status: ${entry.applyStatus}`,
    "",
    "## Requested Materials",
    ...(entry.requestedMaterials.length > 0
      ? entry.requestedMaterials.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Manual Checks",
    ...(entry.manualChecks.length > 0 ? entry.manualChecks.map((line) => `- ${line}`) : ["- none"]),
    "",
    "## Next Steps",
    ...(entry.nextSteps.length > 0 ? entry.nextSteps.map((line) => `- ${line}`) : ["- none"]),
    "",
  ].join("\n");
}

function buildArtifactNotes(packetCount: number): string[] {
  return [
    `${packetCount} collection patch packet(s) were prepared.`,
    "These packets remain proposal-only and must not modify manifests automatically.",
  ];
}

function renderCollectionPacketsNote(params: {
  dateStr: string;
  timeStr: string;
  collectionPacketsPath: string;
  artifact: FundamentalCollectionPacketsArtifact;
}): string {
  return [
    `# Fundamental Collection Packets: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.artifact.manifestId}`,
    `- collection_packets_path: ${params.collectionPacketsPath}`,
    `- status: ${params.artifact.status}`,
    `- packet_count: ${params.artifact.collectionPackets.length}`,
    "",
    "## Collection Packets",
    ...params.artifact.collectionPackets.map(
      (entry) =>
        `- ${entry.targetLabel}: ${entry.recommendation} -> ${entry.collectionWorkfilePath}`,
    ),
    "",
  ].join("\n");
}

const materializeFundamentalCollectionPackets: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const patches = await loadCollectionManifestPatchesWithFallback(workspaceDir);
    if (patches.length === 0) {
      return;
    }

    const grouped = new Map<(typeof patches)[number]["patch"]["manifestId"], typeof patches>();
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
        const collectionPackets = manifestPatches.map(({ relativePath, patch }) => {
          const review = buildManifestPatchReviewEntry({
            patchPath: relativePath,
            patch,
            targetDirExists: Boolean(patch.targetDir),
          });
          return {
            targetLabel: patch.targetLabel,
            patchPath: relativePath,
            collectionWorkfilePath: `bank/fundamental/collection-work/${manifestId}/${slugifyTargetLabel(patch.targetLabel)}.md`,
            recommendation: review.recommendation,
            targetDir: patch.targetDir,
            fileNamePattern: patch.fileNamePattern,
            metadataSidecarSuffix: patch.metadataSidecarSuffix,
            requestedMaterials: patch.requestedMaterials,
            manualChecks: review.manualChecks,
            nextSteps: review.nextReviewSteps,
            applyStatus: "proposal_only" as const,
          };
        });

        const artifact: FundamentalCollectionPacketsArtifact = {
          version: 1,
          generatedAt: nowIso,
          manifestId,
          manifestPath: manifestPatches[0]?.patch.manifestPath ?? "unknown",
          status: collectionPackets.some(
            (entry) => entry.recommendation === "manual_review_before_collection",
          )
            ? "manual_review_required"
            : "pending_collection",
          collectionPackets,
          notes: buildArtifactNotes(collectionPackets.length),
        };
        const collectionPacketsPath = buildFundamentalArtifactJsonPath(
          "fundamental-collection-packets",
          manifestId,
        );
        const noteRelativePath = buildFundamentalArtifactNoteFilename({
          dateStr,
          stageName: "fundamental-collection-packets",
          manifestId,
        });
        const writes: Array<Promise<void>> = [
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: collectionPacketsPath,
            data: `${JSON.stringify(artifact, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderCollectionPacketsNote({
              dateStr,
              timeStr,
              collectionPacketsPath,
              artifact,
            }),
            encoding: "utf-8",
          }),
        ];

        for (const entry of collectionPackets) {
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: entry.collectionWorkfilePath,
              data: renderCollectionPacket(entry),
              encoding: "utf-8",
            }),
          );
        }

        await Promise.all(writes);
      }),
    );

    log.info(`Fundamental collection packets materialized ${grouped.size} manifest(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental collection packets", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalCollectionPackets;
