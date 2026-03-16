import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import type {
  FundamentalDocumentConventions,
  FundamentalManifestScaffold,
} from "../fundamental-intake/handler.js";
import type { FundamentalTargetPacketsArtifact } from "../fundamental-target-packets/handler.js";
import {
  loadTargetPacketsWithFallback,
  type FundamentalTargetWorkfilesArtifact,
} from "../fundamental-target-workfiles/handler.js";

const log = createSubsystemLogger("hooks/fundamental-target-deliverables");

const DEFAULT_DOCUMENT_CONVENTIONS: FundamentalDocumentConventions = {
  fileNamePattern: "<target-slug>--<document-category>--<source-type>--<YYYYMMDD>.<ext>",
  metadataSidecarSuffix: ".meta.json",
  allowedExtensions: ["pdf", "html", "txt", "md", "docx", "xlsx", "csv"],
};

type DeliverableEntry = {
  targetLabel: string;
  kind: "dossier_skeleton" | "manifest_patch" | "hold_memo";
  relativePath: string;
  sourceWorkfilePath?: string;
};

type ManifestPatchOperation = {
  kind: "queue_requested_material" | "require_metadata_sidecar" | "verify_collection";
  description: string;
  targetDir: string | null;
};

export type FundamentalCollectionManifestPatch = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  targetLabel: string;
  patchType: "follow_up_collection";
  applyStatus: "proposed_only";
  packetFocus: FundamentalTargetPacketsArtifact["followUpCollectionPackets"][number]["packetFocus"];
  targetDir: string | null;
  fileNamePattern: FundamentalDocumentConventions["fileNamePattern"];
  metadataSidecarSuffix: FundamentalDocumentConventions["metadataSidecarSuffix"];
  requestedMaterials: string[];
  collectionSequence: string[];
  metadataChecklist: string[];
  verificationChecklist: string[];
  nextCollectionTasks: string[];
  operations: ManifestPatchOperation[];
  notes: string[];
};

export type FundamentalTargetDeliverablesArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  targetPacketsPath: string;
  targetWorkfilesPath: string;
  outputDir: string;
  status: FundamentalTargetPacketsArtifact["packetStatus"];
  dossierSkeletonFiles: DeliverableEntry[];
  manifestPatchFiles: DeliverableEntry[];
  holdMemoFiles: DeliverableEntry[];
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

function getTargetDir(
  manifest: FundamentalManifestScaffold | undefined,
  targetLabel: string,
): string | null {
  return (
    manifest?.documentWorkspace.targetDirs.find((entry) => entry.targetLabel === targetLabel)
      ?.dir ?? null
  );
}

function getSourceWorkfilePath(params: {
  targetWorkfiles: FundamentalTargetWorkfilesArtifact | undefined;
  manifestId: string;
  targetLabel: string;
  kind: "dossier" | "collection" | "hold";
}): string {
  const artifact = params.targetWorkfiles;
  const file =
    params.kind === "dossier"
      ? artifact?.dossierFiles.find((entry) => entry.targetLabel === params.targetLabel)
      : params.kind === "collection"
        ? artifact?.collectionFiles.find((entry) => entry.targetLabel === params.targetLabel)
        : artifact?.holdFiles.find((entry) => entry.targetLabel === params.targetLabel);
  return (
    file?.relativePath ??
    `bank/fundamental/workfiles/${params.manifestId}/${
      params.kind === "dossier" ? "dossiers" : params.kind === "collection" ? "collection" : "holds"
    }/${slugifyTargetLabel(params.targetLabel)}.md`
  );
}

function renderDossierSkeleton(params: {
  manifestId: string;
  targetDir: string | null;
  dossier: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number];
  sourceWorkfilePath: string;
}): string {
  const { dossier } = params;
  return [
    `# ${dossier.targetLabel} Fundamental Dossier Skeleton`,
    "",
    `- manifest_id: ${params.manifestId}`,
    `- target: ${dossier.targetLabel}`,
    `- review_priority: ${dossier.reviewPriority}`,
    `- evidence_readiness_level: ${dossier.evidenceReadinessLevel}`,
    `- source_workfile: ${params.sourceWorkfilePath}`,
    `- local_target_dir: ${params.targetDir ?? "unknown"}`,
    "",
    "## Review Thesis",
    "_TODO: write the target-level thesis in 3 to 6 concise bullets._",
    ...dossier.thesisTemplate.map((line) => `- seed: ${line}`),
    "",
    "## Source Inventory",
    ...(dossier.documentPaths.length > 0
      ? dossier.documentPaths.map((line) => `- ${line}`)
      : ["- none yet"]),
    "",
    "## Evidence Matrix",
    ...dossier.evidenceMatrix.map((line) => `- ${line}`),
    "",
    "## Open Questions",
    ...dossier.openQuestions.map((line) => `- ${line}`),
    "",
    "## Citation Tasks",
    ...dossier.citationTasks.map((line) => `- ${line}`),
    "",
    "## Draft Outline",
    "- Business and asset scope",
    "- Core evidence summary",
    "- Source-quality caveats",
    "- Outstanding questions",
    "- Next research decision",
    "",
    "## Writing Checklist",
    ...dossier.writingChecklist.map((line) => `- ${line}`),
    "",
    "## Immediate Tasks",
    ...dossier.immediateTasks.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function buildCollectionManifestPatch(params: {
  nowIso: string;
  manifestPath: string;
  manifest: FundamentalManifestScaffold | undefined;
  packet: FundamentalTargetPacketsArtifact["followUpCollectionPackets"][number];
}): FundamentalCollectionManifestPatch {
  const targetDir = getTargetDir(params.manifest, params.packet.targetLabel);
  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.manifest?.manifestId ?? "unknown-manifest",
    manifestPath: params.manifestPath,
    targetLabel: params.packet.targetLabel,
    patchType: "follow_up_collection",
    applyStatus: "proposed_only",
    packetFocus: params.packet.packetFocus,
    targetDir,
    fileNamePattern:
      params.manifest?.documentConventions.fileNamePattern ??
      DEFAULT_DOCUMENT_CONVENTIONS.fileNamePattern,
    metadataSidecarSuffix:
      params.manifest?.documentConventions.metadataSidecarSuffix ??
      DEFAULT_DOCUMENT_CONVENTIONS.metadataSidecarSuffix,
    requestedMaterials: params.packet.requestedMaterials,
    collectionSequence: params.packet.collectionSequence,
    metadataChecklist: params.packet.metadataChecklist,
    verificationChecklist: params.packet.verificationChecklist,
    nextCollectionTasks: params.packet.nextCollectionTasks,
    operations: [
      ...params.packet.requestedMaterials.map((description) => ({
        kind: "queue_requested_material" as const,
        description,
        targetDir,
      })),
      {
        kind: "require_metadata_sidecar" as const,
        description:
          "Require a matching .meta.json sidecar for each newly collected document before the manifest is treated as metadata-complete.",
        targetDir,
      },
      ...params.packet.verificationChecklist.map((description) => ({
        kind: "verify_collection" as const,
        description,
        targetDir,
      })),
    ],
    notes: [
      "This patch is proposal-only and must not be applied automatically.",
      "Collection remains manifest-first and research-only.",
    ],
  };
}

function renderHoldMemo(params: {
  manifestId: string;
  hold: FundamentalTargetPacketsArtifact["blockedHoldPackets"][number];
  sourceWorkfilePath: string;
}): string {
  const { hold } = params;
  return [
    `# ${hold.targetLabel} Blocked Review Memo`,
    "",
    `- manifest_id: ${params.manifestId}`,
    `- target: ${hold.targetLabel}`,
    `- review_priority: ${hold.reviewPriority}`,
    `- source_workfile: ${params.sourceWorkfilePath}`,
    "",
    "## Hold Summary",
    ...hold.holdSummary.map((line) => `- ${line}`),
    "",
    "## Requested Materials",
    ...(hold.requestedMaterials.length > 0
      ? hold.requestedMaterials.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Unblock Conditions",
    ...hold.unblockConditions.map((line) => `- ${line}`),
    "",
    "## Next Review-Gate Checks",
    ...hold.nextReviewGateChecks.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function buildArtifactNotes(params: {
  dossiers: number;
  patches: number;
  holds: number;
}): string[] {
  return [
    `${params.dossiers} dossier skeleton(s), ${params.patches} manifest patch proposal(s), and ${params.holds} hold memo(s) were materialized.`,
    "These deliverables remain research-only and do not update manifests automatically.",
  ];
}

function renderDeliverablesNote(params: {
  dateStr: string;
  timeStr: string;
  deliverablesPath: string;
  artifact: FundamentalTargetDeliverablesArtifact;
}): string {
  return [
    `# Fundamental Target Deliverables: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.artifact.manifestId}`,
    `- target_deliverables_path: ${params.deliverablesPath}`,
    `- status: ${params.artifact.status}`,
    `- dossier_skeleton_files: ${params.artifact.dossierSkeletonFiles.length}`,
    `- manifest_patch_files: ${params.artifact.manifestPatchFiles.length}`,
    `- hold_memo_files: ${params.artifact.holdMemoFiles.length}`,
    "",
    "## Deliverables",
    ...[
      ...params.artifact.dossierSkeletonFiles,
      ...params.artifact.manifestPatchFiles,
      ...params.artifact.holdMemoFiles,
    ].map((entry) => `- ${entry.kind}: ${entry.targetLabel} -> ${entry.relativePath}`),
    "",
  ].join("\n");
}

const materializeFundamentalTargetDeliverables: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const [targetPacketsEntries, manifests, persistedTargetWorkfiles] = await Promise.all([
      loadTargetPacketsWithFallback(workspaceDir),
      loadJsonFiles<FundamentalManifestScaffold>({
        dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
        relativePrefix: "bank/fundamental/manifests",
      }),
      loadJsonFiles<FundamentalTargetWorkfilesArtifact>({
        dirPath: path.join(workspaceDir, "bank", "fundamental", "target-workfiles"),
        relativePrefix: "bank/fundamental/target-workfiles",
      }),
    ]);
    if (targetPacketsEntries.length === 0) {
      return;
    }

    const manifestById = new Map(manifests.map(({ data }) => [data.manifestId, data]));
    const workfilesById = new Map(
      persistedTargetWorkfiles.map(({ relativePath, data }) => [
        data.manifestId,
        { relativePath, targetWorkfiles: data },
      ]),
    );

    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      targetPacketsEntries.map(async ({ relativePath, targetPackets }) => {
        const manifest = manifestById.get(targetPackets.manifestId);
        const targetWorkfiles = workfilesById.get(targetPackets.manifestId)?.targetWorkfiles;
        const targetWorkfilesPath =
          workfilesById.get(targetPackets.manifestId)?.relativePath ??
          `bank/fundamental/target-workfiles/${targetPackets.manifestId}.json`;
        const outputDir = `bank/fundamental/deliverables/${targetPackets.manifestId}`;
        const dossierSkeletonFiles: DeliverableEntry[] = [];
        const manifestPatchFiles: DeliverableEntry[] = [];
        const holdMemoFiles: DeliverableEntry[] = [];
        const writes: Array<Promise<void>> = [];

        for (const dossier of targetPackets.deeperReviewDossiers) {
          const relativeFile = `${outputDir}/dossiers/${slugifyTargetLabel(dossier.targetLabel)}.md`;
          const sourceWorkfilePath = getSourceWorkfilePath({
            targetWorkfiles,
            manifestId: targetPackets.manifestId,
            targetLabel: dossier.targetLabel,
            kind: "dossier",
          });
          dossierSkeletonFiles.push({
            targetLabel: dossier.targetLabel,
            kind: "dossier_skeleton",
            relativePath: relativeFile,
            sourceWorkfilePath,
          });
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: relativeFile,
              data: renderDossierSkeleton({
                manifestId: targetPackets.manifestId,
                targetDir: getTargetDir(manifest, dossier.targetLabel),
                dossier,
                sourceWorkfilePath,
              }),
              encoding: "utf-8",
            }),
          );
        }

        for (const packet of targetPackets.followUpCollectionPackets) {
          const relativeFile = `${outputDir}/manifest-patches/${slugifyTargetLabel(packet.targetLabel)}.json`;
          const sourceWorkfilePath = getSourceWorkfilePath({
            targetWorkfiles,
            manifestId: targetPackets.manifestId,
            targetLabel: packet.targetLabel,
            kind: "collection",
          });
          manifestPatchFiles.push({
            targetLabel: packet.targetLabel,
            kind: "manifest_patch",
            relativePath: relativeFile,
            sourceWorkfilePath,
          });
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: relativeFile,
              data: `${JSON.stringify(
                buildCollectionManifestPatch({
                  nowIso,
                  manifestPath: targetPackets.manifestPath,
                  manifest,
                  packet,
                }),
                null,
                2,
              )}\n`,
              encoding: "utf-8",
            }),
          );
        }

        for (const hold of targetPackets.blockedHoldPackets) {
          const relativeFile = `${outputDir}/holds/${slugifyTargetLabel(hold.targetLabel)}.md`;
          const sourceWorkfilePath = getSourceWorkfilePath({
            targetWorkfiles,
            manifestId: targetPackets.manifestId,
            targetLabel: hold.targetLabel,
            kind: "hold",
          });
          holdMemoFiles.push({
            targetLabel: hold.targetLabel,
            kind: "hold_memo",
            relativePath: relativeFile,
            sourceWorkfilePath,
          });
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: relativeFile,
              data: renderHoldMemo({
                manifestId: targetPackets.manifestId,
                hold,
                sourceWorkfilePath,
              }),
              encoding: "utf-8",
            }),
          );
        }

        const artifact: FundamentalTargetDeliverablesArtifact = {
          version: 1,
          generatedAt: nowIso,
          manifestId: targetPackets.manifestId,
          manifestPath: targetPackets.manifestPath,
          targetPacketsPath: relativePath,
          targetWorkfilesPath,
          outputDir,
          status: targetPackets.packetStatus,
          dossierSkeletonFiles,
          manifestPatchFiles,
          holdMemoFiles,
          notes: buildArtifactNotes({
            dossiers: dossierSkeletonFiles.length,
            patches: manifestPatchFiles.length,
            holds: holdMemoFiles.length,
          }),
        };
        const deliverablesPath = `bank/fundamental/target-deliverables/${targetPackets.manifestId}.json`;
        const noteRelativePath = `${dateStr}-fundamental-target-deliverables-${targetPackets.manifestId}.md`;
        writes.push(
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: deliverablesPath,
            data: `${JSON.stringify(artifact, null, 2)}\n`,
            encoding: "utf-8",
          }),
        );
        writes.push(
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderDeliverablesNote({
              dateStr,
              timeStr,
              deliverablesPath,
              artifact,
            }),
            encoding: "utf-8",
          }),
        );
        await Promise.all(writes);
      }),
    );

    log.info(
      `Fundamental target deliverables materialized ${targetPacketsEntries.length} packet set(s)`,
    );
  } catch (err) {
    log.error("Failed to materialize fundamental target deliverables", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalTargetDeliverables;
