import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  loadJsonFilesIsolated,
  writeFundamentalArtifactErrors,
} from "../fundamental-artifact-errors.js";
import type {
  FundamentalManifestScaffold,
  FundamentalRiskHandoffStatus,
} from "../fundamental-intake/handler.js";
import type { FundamentalScoringGateArtifact } from "../fundamental-scoring-gate/handler.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";

const log = createSubsystemLogger("hooks/fundamental-risk-handoff");

type FundamentalRiskReviewDecision = "blocked" | "partial" | "ready";

type TargetRiskHandoffDecision = {
  targetLabel: string;
  region: string;
  handoffDecision: FundamentalRiskReviewDecision;
  allowedForRiskReview: boolean;
  scoringDecision: FundamentalScoringGateArtifact["targetDecisions"][number]["scoringDecision"];
  evidenceReadinessLevel: FundamentalScoringGateArtifact["targetDecisions"][number]["evidenceReadinessLevel"];
  availableDocumentCategories: FundamentalScoringGateArtifact["targetDecisions"][number]["availableDocumentCategories"];
  sourceCoverage: FundamentalScoringGateArtifact["targetDecisions"][number]["sourceCoverage"];
  metadataConfidence: FundamentalScoringGateArtifact["targetDecisions"][number]["metadataConfidence"];
  fallbackExposure: FundamentalScoringGateArtifact["targetDecisions"][number]["fallbackExposure"];
  missingCriticalInputs: string[];
  documentPaths: string[];
  notes: string[];
};

export type FundamentalRiskHandoffArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  snapshotPath: string;
  scoringGatePath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  manifestRiskHandoffStatus: FundamentalRiskHandoffStatus;
  handoffDecision: FundamentalRiskReviewDecision;
  handoffReady: boolean;
  handoffSummary: {
    totalTargets: number;
    readyTargets: number;
    partialTargets: number;
    blockedTargets: number;
    fallbackExposedTargets: number;
    metadataOnlyTargets: number;
  };
  targetDecisions: TargetRiskHandoffDecision[];
  notes: string[];
};

function parseManifestIdFromManifestFileName(fileName: string): string | undefined {
  return fileName.match(/fundamental-manifest-(.+)\.json$/)?.[1];
}

function deriveTargetHandoffDecision(
  scoringDecision: TargetRiskHandoffDecision["scoringDecision"],
): FundamentalRiskReviewDecision {
  if (scoringDecision === "allowed") {
    return "ready";
  }
  if (scoringDecision === "partial") {
    return "partial";
  }
  return "blocked";
}

function buildTargetNotes(params: {
  handoffDecision: FundamentalRiskReviewDecision;
  target: FundamentalScoringGateArtifact["targetDecisions"][number];
}): string[] {
  const notes = [...params.target.notes];
  if (params.handoffDecision === "ready") {
    notes.push("Target may enter controlled downstream risk review.");
  } else if (params.handoffDecision === "partial") {
    notes.push(
      "Target may be carried as partial downstream context, but risk review should remain limited until missing inputs are resolved.",
    );
  } else {
    notes.push("Target remains blocked from downstream risk review.");
  }
  return notes;
}

function buildHandoffNotes(params: {
  handoffDecision: FundamentalRiskReviewDecision;
  manifestRiskHandoffStatus: FundamentalRiskHandoffStatus;
  readyTargets: number;
  partialTargets: number;
  blockedTargets: number;
}): string[] {
  const notes: string[] = [];
  if (params.handoffDecision === "ready") {
    notes.push(
      "All named targets have cleared the local scoring gate and may enter controlled downstream risk review.",
    );
  } else if (params.handoffDecision === "partial") {
    notes.push(
      `${params.readyTargets} target(s) are ready for downstream risk review, ${params.partialTargets} remain partial, and ${params.blockedTargets} remain blocked.`,
    );
  } else {
    notes.push("No targets are ready for downstream risk review yet.");
  }
  if (params.manifestRiskHandoffStatus !== "ready_for_fundamental_snapshot") {
    notes.push(
      "The manifest readiness layer is still below `ready_for_fundamental_snapshot`; treat this handoff artifact as downstream bookkeeping, not a readiness override.",
    );
  }
  notes.push(
    "This artifact is a handoff summary only; it does not create a risk audit, veto assets, or approve execution.",
  );
  return notes;
}

function renderRiskHandoffNote(params: {
  dateStr: string;
  timeStr: string;
  riskHandoffPath: string;
  handoff: FundamentalRiskHandoffArtifact;
}): string {
  return [
    `# Fundamental Risk Handoff: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.handoff.manifestId}`,
    `- risk_handoff_path: ${params.riskHandoffPath}`,
    `- manifest_risk_handoff_status: ${params.handoff.manifestRiskHandoffStatus}`,
    `- handoff_decision: ${params.handoff.handoffDecision}`,
    `- ready_targets: ${params.handoff.handoffSummary.readyTargets}/${params.handoff.handoffSummary.totalTargets}`,
    `- partial_targets: ${params.handoff.handoffSummary.partialTargets}`,
    `- blocked_targets: ${params.handoff.handoffSummary.blockedTargets}`,
    "",
    "## Target Decisions",
    ...(params.handoff.targetDecisions.length > 0
      ? params.handoff.targetDecisions.map(
          (target) =>
            `- ${target.targetLabel}: handoff=${target.handoffDecision}, scoring=${target.scoringDecision}, missing=${target.missingCriticalInputs.join(", ") || "none"}`,
        )
      : ["- none"]),
    "",
  ].join("\n");
}

export function buildFundamentalRiskHandoff(params: {
  nowIso: string;
  scoringGatePath: string;
  manifestRiskHandoffStatus: FundamentalRiskHandoffStatus;
  scoringGate: FundamentalScoringGateArtifact;
}): FundamentalRiskHandoffArtifact {
  const targetDecisions = params.scoringGate.targetDecisions.map((target) => {
    const handoffDecision = deriveTargetHandoffDecision(target.scoringDecision);
    return {
      targetLabel: target.targetLabel,
      region: target.region,
      handoffDecision,
      allowedForRiskReview: handoffDecision === "ready",
      scoringDecision: target.scoringDecision,
      evidenceReadinessLevel: target.evidenceReadinessLevel,
      availableDocumentCategories: target.availableDocumentCategories,
      sourceCoverage: target.sourceCoverage,
      metadataConfidence: target.metadataConfidence,
      fallbackExposure: target.fallbackExposure,
      missingCriticalInputs: target.missingCriticalInputs,
      documentPaths: target.documentPaths,
      notes: buildTargetNotes({
        handoffDecision,
        target,
      }),
    } satisfies TargetRiskHandoffDecision;
  });

  const handoffSummary = targetDecisions.reduce(
    (summary, target) => {
      if (target.handoffDecision === "ready") {
        summary.readyTargets += 1;
      } else if (target.handoffDecision === "partial") {
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
      readyTargets: 0,
      partialTargets: 0,
      blockedTargets: 0,
      fallbackExposedTargets: 0,
      metadataOnlyTargets: 0,
    },
  );

  const handoffDecision: FundamentalRiskReviewDecision =
    handoffSummary.readyTargets === handoffSummary.totalTargets
      ? "ready"
      : handoffSummary.readyTargets > 0 || handoffSummary.partialTargets > 0
        ? "partial"
        : "blocked";

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.scoringGate.manifestId,
    manifestPath: params.scoringGate.manifestPath,
    snapshotPath: params.scoringGate.snapshotPath,
    scoringGatePath: params.scoringGatePath,
    requestTitle: params.scoringGate.requestTitle,
    researchBranch: params.scoringGate.researchBranch,
    manifestRiskHandoffStatus: params.manifestRiskHandoffStatus,
    handoffDecision,
    handoffReady: handoffDecision === "ready",
    handoffSummary,
    targetDecisions,
    notes: buildHandoffNotes({
      handoffDecision,
      manifestRiskHandoffStatus: params.manifestRiskHandoffStatus,
      readyTargets: handoffSummary.readyTargets,
      partialTargets: handoffSummary.partialTargets,
      blockedTargets: handoffSummary.blockedTargets,
    }),
  };
}

const materializeFundamentalRiskHandoff: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const manifests = await loadJsonFilesIsolated<FundamentalManifestScaffold>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
      relativePrefix: "bank/fundamental/manifests",
      stage: "risk-handoff",
      manifestIdFromFileName: parseManifestIdFromManifestFileName,
    });
    const scoringGates = await loadJsonFilesIsolated<FundamentalScoringGateArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "scoring-gates"),
      relativePrefix: "bank/fundamental/scoring-gates",
      stage: "risk-handoff",
      manifestIdFromFileName: (fileName) => path.basename(fileName, ".json"),
    });
    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    await writeFundamentalArtifactErrors({
      workspaceDir,
      memoryDir,
      nowIso,
      errors: [...manifests.errors, ...scoringGates.errors],
    });
    if (manifests.entries.length === 0 || scoringGates.entries.length === 0) {
      return;
    }

    const manifestById = new Map(
      manifests.entries.map((entry) => [entry.data.manifestId, entry.data]),
    );
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      scoringGates.entries.map(async ({ relativePath, data: scoringGate }) => {
        const manifest = manifestById.get(scoringGate.manifestId);
        if (!manifest) {
          return;
        }

        const handoff = buildFundamentalRiskHandoff({
          nowIso,
          scoringGatePath: relativePath,
          manifestRiskHandoffStatus: manifest.riskHandoff.status,
          scoringGate,
        });
        const handoffPath = buildFundamentalArtifactJsonPath(
          "fundamental-risk-handoff",
          scoringGate.manifestId,
        );
        const noteRelativePath = buildFundamentalArtifactNoteFilename({
          dateStr,
          stageName: "fundamental-risk-handoff",
          manifestId: scoringGate.manifestId,
        });

        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: handoffPath,
            data: `${JSON.stringify(handoff, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderRiskHandoffNote({
              dateStr,
              timeStr,
              riskHandoffPath: handoffPath,
              handoff,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(
      `Fundamental risk handoff materialized ${scoringGates.entries.length} scoring gate(s)`,
    );
  } catch (err) {
    log.error("Failed to materialize fundamental risk handoff", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalRiskHandoff;
