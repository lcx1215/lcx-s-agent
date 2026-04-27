import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  loadJsonFilesIsolated,
  writeFundamentalArtifactErrors,
} from "../fundamental-artifact-errors.js";
import type { FundamentalSnapshotArtifact } from "../fundamental-snapshot/handler.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";

const log = createSubsystemLogger("hooks/fundamental-scoring-gate");

type FundamentalScoringDecision = "blocked" | "partial" | "allowed";

type TargetScoringDecision = {
  targetLabel: string;
  region: string;
  scoringDecision: FundamentalScoringDecision;
  allowedForScoring: boolean;
  evidenceReadinessLevel: FundamentalSnapshotArtifact["targets"][number]["evidenceReadinessLevel"];
  availableDocumentCategories: FundamentalSnapshotArtifact["targets"][number]["availableDocumentCategories"];
  sourceCoverage: FundamentalSnapshotArtifact["targets"][number]["sourceCoverage"];
  metadataConfidence: FundamentalSnapshotArtifact["targets"][number]["metadataConfidence"];
  fallbackExposure: FundamentalSnapshotArtifact["targets"][number]["fallbackExposure"];
  missingCriticalInputs: string[];
  documentPaths: string[];
  notes: string[];
};

export type FundamentalScoringGateArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  snapshotPath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  scoringDecision: FundamentalScoringDecision;
  gateSummary: {
    totalTargets: number;
    allowedTargets: number;
    partialTargets: number;
    blockedTargets: number;
    fallbackExposedTargets: number;
    metadataOnlyTargets: number;
  };
  targetDecisions: TargetScoringDecision[];
  notes: string[];
};

function buildScoringGateNotes(params: {
  scoringDecision: FundamentalScoringDecision;
  allowedTargets: number;
  partialTargets: number;
  blockedTargets: number;
}): string[] {
  if (params.scoringDecision === "allowed") {
    return [
      "All named targets have baseline snapshot inputs and may enter controlled downstream scoring consumers.",
      "This artifact is a gate only; it does not calculate valuation, quality, or risk scores.",
    ];
  }
  if (params.scoringDecision === "partial") {
    return [
      `${params.allowedTargets} target(s) may enter controlled scoring, ${params.partialTargets} require limited handling, and ${params.blockedTargets} remain blocked.`,
      "Blocked and partial targets should remain visible so missing inputs can be resolved before broader scoring.",
    ];
  }
  return [
    "No targets are eligible for downstream scoring yet.",
    "This artifact only records blockers and fallback exposure; it does not override missing document or approval requirements.",
  ];
}

function renderScoringGateNote(params: {
  dateStr: string;
  timeStr: string;
  scoringGatePath: string;
  scoringGate: FundamentalScoringGateArtifact;
}): string {
  return [
    `# Fundamental Scoring Gate: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.scoringGate.manifestId}`,
    `- scoring_gate_path: ${params.scoringGatePath}`,
    `- scoring_decision: ${params.scoringGate.scoringDecision}`,
    `- allowed_targets: ${params.scoringGate.gateSummary.allowedTargets}/${params.scoringGate.gateSummary.totalTargets}`,
    `- partial_targets: ${params.scoringGate.gateSummary.partialTargets}`,
    `- blocked_targets: ${params.scoringGate.gateSummary.blockedTargets}`,
    "",
    "## Target Decisions",
    ...(params.scoringGate.targetDecisions.length > 0
      ? params.scoringGate.targetDecisions.map(
          (target) =>
            `- ${target.targetLabel}: decision=${target.scoringDecision}, readiness=${target.evidenceReadinessLevel}, missing=${target.missingCriticalInputs.join(", ") || "none"}`,
        )
      : ["- none"]),
    "",
  ].join("\n");
}

export function buildFundamentalScoringGate(params: {
  nowIso: string;
  snapshotPath: string;
  snapshot: FundamentalSnapshotArtifact;
}): FundamentalScoringGateArtifact {
  const targetDecisions = params.snapshot.targets.map((target) => ({
    targetLabel: target.targetLabel,
    region: target.region,
    scoringDecision: target.scoringGate,
    allowedForScoring: target.scoringGate === "allowed",
    evidenceReadinessLevel: target.evidenceReadinessLevel,
    availableDocumentCategories: target.availableDocumentCategories,
    sourceCoverage: target.sourceCoverage,
    metadataConfidence: target.metadataConfidence,
    fallbackExposure: target.fallbackExposure,
    missingCriticalInputs: target.missingCriticalInputs,
    documentPaths: target.documentPaths,
    notes: target.notes,
  }));

  const gateSummary = targetDecisions.reduce(
    (summary, target) => {
      if (target.scoringDecision === "allowed") {
        summary.allowedTargets += 1;
      } else if (target.scoringDecision === "partial") {
        summary.partialTargets += 1;
      } else {
        summary.blockedTargets += 1;
      }
      if (
        target.fallbackExposure.filenameFallbackCount > 0 ||
        target.fallbackExposure.validationNoteCount > 0
      ) {
        summary.fallbackExposedTargets += 1;
      }
      if (target.metadataConfidence.mode === "metadata_only") {
        summary.metadataOnlyTargets += 1;
      }
      return summary;
    },
    {
      totalTargets: targetDecisions.length,
      allowedTargets: 0,
      partialTargets: 0,
      blockedTargets: 0,
      fallbackExposedTargets: 0,
      metadataOnlyTargets: 0,
    },
  );

  const scoringDecision: FundamentalScoringDecision =
    gateSummary.allowedTargets === gateSummary.totalTargets
      ? "allowed"
      : gateSummary.allowedTargets > 0 || gateSummary.partialTargets > 0
        ? "partial"
        : "blocked";

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.snapshot.manifestId,
    manifestPath: params.snapshot.manifestPath,
    snapshotPath: params.snapshotPath,
    requestTitle: params.snapshot.requestTitle,
    researchBranch: params.snapshot.researchBranch,
    scoringDecision,
    gateSummary,
    targetDecisions,
    notes: buildScoringGateNotes({
      scoringDecision,
      allowedTargets: gateSummary.allowedTargets,
      partialTargets: gateSummary.partialTargets,
      blockedTargets: gateSummary.blockedTargets,
    }),
  };
}

const materializeFundamentalScoringGate: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const snapshots = await loadJsonFilesIsolated<FundamentalSnapshotArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "snapshots"),
      relativePrefix: "bank/fundamental/snapshots",
      stage: "scoring-gate",
      manifestIdFromFileName: (fileName) => path.basename(fileName, ".json"),
    });
    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    await writeFundamentalArtifactErrors({
      workspaceDir,
      memoryDir,
      nowIso,
      errors: snapshots.errors,
    });
    if (snapshots.entries.length === 0) {
      return;
    }

    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      snapshots.entries.map(async ({ relativePath, data: snapshot }) => {
        const scoringGate = buildFundamentalScoringGate({
          nowIso,
          snapshotPath: relativePath,
          snapshot,
        });
        const scoringGatePath = buildFundamentalArtifactJsonPath(
          "fundamental-scoring-gate",
          snapshot.manifestId,
        );
        const noteRelativePath = buildFundamentalArtifactNoteFilename({
          dateStr,
          stageName: "fundamental-scoring-gate",
          manifestId: snapshot.manifestId,
        });

        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: scoringGatePath,
            data: `${JSON.stringify(scoringGate, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderScoringGateNote({
              dateStr,
              timeStr,
              scoringGatePath,
              scoringGate,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental scoring gate materialized ${snapshots.entries.length} snapshot(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental scoring gate", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalScoringGate;
