import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  loadTargetPacketsWithFallback,
  type FundamentalTargetPacketsArtifact,
} from "../fundamental-target-workfiles/handler.js";

const log = createSubsystemLogger("hooks/fundamental-dossier-drafts");

type DossierDraftEntry = {
  targetLabel: string;
  relativePath: string;
  sourceSkeletonPath: string;
  sourceWorkfilePath: string;
  evidenceReadinessLevel: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number]["evidenceReadinessLevel"];
  reviewPriority: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number]["reviewPriority"];
};

export type FundamentalDossierDraftsArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  targetPacketsPath: string;
  outputDir: string;
  draftFiles: DossierDraftEntry[];
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

function buildArtifactNotes(draftCount: number): string[] {
  return [
    `${draftCount} dossier draft file(s) were materialized from dossier-ready targets.`,
    "These drafts are research-only writing starters and do not constitute approvals or final ratings.",
  ];
}

function renderDossierDraft(params: {
  manifestId: string;
  dossier: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number];
  sourceSkeletonPath: string;
  sourceWorkfilePath: string;
}): string {
  const { dossier } = params;
  return [
    `# ${dossier.targetLabel} Fundamental Dossier Draft`,
    "",
    `- manifest_id: ${params.manifestId}`,
    `- target: ${dossier.targetLabel}`,
    `- review_priority: ${dossier.reviewPriority}`,
    `- evidence_readiness_level: ${dossier.evidenceReadinessLevel}`,
    `- source_skeleton: ${params.sourceSkeletonPath}`,
    `- source_workfile: ${params.sourceWorkfilePath}`,
    "",
    "## Executive Summary Draft",
    "_TODO: turn the seed bullets below into a concise 5-8 sentence summary grounded in local source material only._",
    ...dossier.thesisTemplate.map((line) => `- seed: ${line}`),
    "",
    "## Evidence Notes",
    ...(dossier.evidenceMatrix.length > 0
      ? dossier.evidenceMatrix.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Source Inventory",
    ...(dossier.documentPaths.length > 0
      ? dossier.documentPaths.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Open Questions",
    ...(dossier.openQuestions.length > 0
      ? dossier.openQuestions.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Citation Plan",
    ...(dossier.citationTasks.length > 0
      ? dossier.citationTasks.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Draft Outline",
    "- Business and issuer context",
    "- Document-backed evidence summary",
    "- Source confidence and caveats",
    "- Outstanding unknowns",
    "- Next research recommendation",
    "",
    "## Drafting Checklist",
    ...(dossier.writingChecklist.length > 0
      ? dossier.writingChecklist.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Next Drafting Steps",
    ...(dossier.immediateTasks.length > 0
      ? dossier.immediateTasks.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function renderDossierDraftsNote(params: {
  dateStr: string;
  timeStr: string;
  draftsPath: string;
  dossierDrafts: FundamentalDossierDraftsArtifact;
}): string {
  return [
    `# Fundamental Dossier Drafts: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.dossierDrafts.manifestId}`,
    `- dossier_drafts_path: ${params.draftsPath}`,
    `- draft_files: ${params.dossierDrafts.draftFiles.length}`,
    "",
    "## Draft Files",
    ...params.dossierDrafts.draftFiles.map(
      (entry) => `- ${entry.targetLabel} -> ${entry.relativePath}`,
    ),
    "",
  ].join("\n");
}

const materializeFundamentalDossierDrafts: HookHandler = async (event) => {
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
        if (targetPackets.deeperReviewDossiers.length === 0) {
          return;
        }

        const outputDir = `bank/fundamental/drafts/${targetPackets.manifestId}`;
        const draftFiles: DossierDraftEntry[] = [];
        const writes: Array<Promise<void>> = [];

        for (const dossier of targetPackets.deeperReviewDossiers) {
          const targetSlug = slugifyTargetLabel(dossier.targetLabel);
          const relativeFile = `${outputDir}/${targetSlug}.md`;
          const sourceSkeletonPath = `bank/fundamental/deliverables/${targetPackets.manifestId}/dossiers/${targetSlug}.md`;
          const sourceWorkfilePath = `bank/fundamental/workfiles/${targetPackets.manifestId}/dossiers/${targetSlug}.md`;
          draftFiles.push({
            targetLabel: dossier.targetLabel,
            relativePath: relativeFile,
            sourceSkeletonPath,
            sourceWorkfilePath,
            evidenceReadinessLevel: dossier.evidenceReadinessLevel,
            reviewPriority: dossier.reviewPriority,
          });
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: relativeFile,
              data: renderDossierDraft({
                manifestId: targetPackets.manifestId,
                dossier,
                sourceSkeletonPath,
                sourceWorkfilePath,
              }),
              encoding: "utf-8",
            }),
          );
        }

        const artifact: FundamentalDossierDraftsArtifact = {
          version: 1,
          generatedAt: nowIso,
          manifestId: targetPackets.manifestId,
          manifestPath: targetPackets.manifestPath,
          targetPacketsPath: relativePath,
          outputDir,
          draftFiles,
          notes: buildArtifactNotes(draftFiles.length),
        };
        const draftsPath = `bank/fundamental/dossier-drafts/${targetPackets.manifestId}.json`;
        const noteRelativePath = `${dateStr}-fundamental-dossier-drafts-${targetPackets.manifestId}.md`;
        writes.push(
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: draftsPath,
            data: `${JSON.stringify(artifact, null, 2)}\n`,
            encoding: "utf-8",
          }),
        );
        writes.push(
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderDossierDraftsNote({
              dateStr,
              timeStr,
              draftsPath,
              dossierDrafts: artifact,
            }),
            encoding: "utf-8",
          }),
        );
        await Promise.all(writes);
      }),
    );

    log.info(`Fundamental dossier drafts materialized ${entries.length} packet set(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental dossier drafts", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalDossierDrafts;
