import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  loadTargetPacketsWithFallback,
  type FundamentalTargetPacketsArtifact,
} from "../fundamental-target-workfiles/handler.js";

const log = createSubsystemLogger("hooks/fundamental-target-reports");

type TargetReportEntry = {
  targetLabel: string;
  relativePath: string;
  sourceDraftPath: string;
  sourceSkeletonPath: string;
  evidenceReadinessLevel: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number]["evidenceReadinessLevel"];
  reviewPriority: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number]["reviewPriority"];
};

export type FundamentalTargetReportsArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  targetPacketsPath: string;
  outputDir: string;
  reportFiles: TargetReportEntry[];
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

function buildArtifactNotes(reportCount: number): string[] {
  return [
    `${reportCount} target report file(s) were materialized from dossier-ready targets.`,
    "These reports remain research-only and do not imply approvals, ratings, or execution readiness.",
  ];
}

function renderTargetReport(params: {
  manifestId: string;
  dossier: FundamentalTargetPacketsArtifact["deeperReviewDossiers"][number];
  sourceDraftPath: string;
  sourceSkeletonPath: string;
}): string {
  const { dossier } = params;
  return [
    `# ${dossier.targetLabel} Fundamental Research Report`,
    "",
    `- manifest_id: ${params.manifestId}`,
    `- target: ${dossier.targetLabel}`,
    `- review_priority: ${dossier.reviewPriority}`,
    `- evidence_readiness_level: ${dossier.evidenceReadinessLevel}`,
    `- source_draft: ${params.sourceDraftPath}`,
    `- source_skeleton: ${params.sourceSkeletonPath}`,
    "",
    "## Executive Summary",
    "_TODO: consolidate the thesis seeds and document-backed evidence into a crisp summary._",
    ...dossier.thesisTemplate.map((line) => `- seed: ${line}`),
    "",
    "## Key Findings",
    ...(dossier.evidenceMatrix.length > 0
      ? dossier.evidenceMatrix.map((line) => `- ${line}`)
      : ["- none"]),
    "",
    "## Source Confidence",
    "- Only local, document-backed evidence should be treated as valid input.",
    "- Track any source-quality caveats before promoting this report further.",
    ...(dossier.documentPaths.length > 0
      ? dossier.documentPaths.map((line) => `- local_source: ${line}`)
      : ["- local_source: none"]),
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
    "## Recommendation",
    "- Continue research-only review until all material claims are traceable to local sources.",
    "- Do not treat this report as a scoring, approval, or execution artifact.",
    ...(dossier.immediateTasks.length > 0
      ? dossier.immediateTasks.map((line) => `- next_step: ${line}`)
      : []),
    "",
  ].join("\n");
}

function renderTargetReportsNote(params: {
  dateStr: string;
  timeStr: string;
  reportsPath: string;
  artifact: FundamentalTargetReportsArtifact;
}): string {
  return [
    `# Fundamental Target Reports: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.artifact.manifestId}`,
    `- target_reports_path: ${params.reportsPath}`,
    `- report_files: ${params.artifact.reportFiles.length}`,
    "",
    "## Report Files",
    ...params.artifact.reportFiles.map(
      (entry) => `- ${entry.targetLabel} -> ${entry.relativePath}`,
    ),
    "",
  ].join("\n");
}

const materializeFundamentalTargetReports: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const entries = await loadTargetPacketsWithFallback(workspaceDir);
    if (entries.length === 0) {
      return;
    }

    const nowIso = new Date(event.timestamp).toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      entries.map(async ({ relativePath, targetPackets }) => {
        if (targetPackets.deeperReviewDossiers.length === 0) {
          return;
        }

        const outputDir = `bank/fundamental/reports/${targetPackets.manifestId}`;
        const reportFiles: TargetReportEntry[] = [];
        const writes: Array<Promise<void>> = [];

        for (const dossier of targetPackets.deeperReviewDossiers) {
          const targetSlug = slugifyTargetLabel(dossier.targetLabel);
          const relativeFile = `${outputDir}/${targetSlug}.md`;
          const sourceDraftPath = `bank/fundamental/drafts/${targetPackets.manifestId}/${targetSlug}.md`;
          const sourceSkeletonPath = `bank/fundamental/deliverables/${targetPackets.manifestId}/dossiers/${targetSlug}.md`;
          reportFiles.push({
            targetLabel: dossier.targetLabel,
            relativePath: relativeFile,
            sourceDraftPath,
            sourceSkeletonPath,
            evidenceReadinessLevel: dossier.evidenceReadinessLevel,
            reviewPriority: dossier.reviewPriority,
          });
          writes.push(
            writeFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: relativeFile,
              data: renderTargetReport({
                manifestId: targetPackets.manifestId,
                dossier,
                sourceDraftPath,
                sourceSkeletonPath,
              }),
              encoding: "utf-8",
            }),
          );
        }

        const artifact: FundamentalTargetReportsArtifact = {
          version: 1,
          generatedAt: nowIso,
          manifestId: targetPackets.manifestId,
          manifestPath: targetPackets.manifestPath,
          targetPacketsPath: relativePath,
          outputDir,
          reportFiles,
          notes: buildArtifactNotes(reportFiles.length),
        };
        const reportsPath = `bank/fundamental/target-reports/${targetPackets.manifestId}.json`;
        const noteRelativePath = `${dateStr}-fundamental-target-reports-${targetPackets.manifestId}.md`;
        writes.push(
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: reportsPath,
            data: `${JSON.stringify(artifact, null, 2)}\n`,
            encoding: "utf-8",
          }),
        );
        writes.push(
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderTargetReportsNote({
              dateStr,
              timeStr,
              reportsPath,
              artifact,
            }),
            encoding: "utf-8",
          }),
        );
        await Promise.all(writes);
      }),
    );

    log.info(`Fundamental target reports materialized ${entries.length} packet set(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental target reports", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalTargetReports;
