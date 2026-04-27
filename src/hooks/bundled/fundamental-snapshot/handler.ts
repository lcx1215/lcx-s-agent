import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  loadJsonFilesIsolated,
  writeFundamentalArtifactErrors,
} from "../fundamental-artifact-errors.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";
import type {
  DocumentType,
  FundamentalManifestScaffold,
  FundamentalSourceType,
} from "../fundamental-intake/handler.js";
import type {
  FundamentalManifestReadiness,
  ReadinessTarget,
} from "../fundamental-manifest-bridge/handler.js";
import type {
  BlockedSnapshotTarget,
  FundamentalSnapshotInput,
  SnapshotInputTarget,
} from "../fundamental-snapshot-bridge/handler.js";

const log = createSubsystemLogger("hooks/fundamental-snapshot");

type FundamentalEvidenceReadinessLevel = "insufficient" | "partial" | "baseline_ready";
type FundamentalScoringGate = "blocked" | "partial" | "allowed";

type FundamentalSnapshotTarget = {
  targetLabel: string;
  region: string;
  assetType: FundamentalManifestScaffold["targets"][number]["assetType"];
  issuerType: FundamentalManifestScaffold["targets"][number]["issuerType"];
  availableDocumentCategories: DocumentType[];
  sourceCoverage: {
    requiredSourceTypes: FundamentalSourceType[];
    presentSourceTypes: FundamentalSourceType[];
    missingPreferredSourceTypes: FundamentalSourceType[];
  };
  evidenceReadinessLevel: FundamentalEvidenceReadinessLevel;
  metadataConfidence: SnapshotInputTarget["metadataConfidence"];
  fallbackExposure: {
    filenameFallbackCount: number;
    validationNoteCount: number;
  };
  missingCriticalInputs: string[];
  scoringGate: FundamentalScoringGate;
  documentPaths: string[];
  notes: string[];
};

export type FundamentalSnapshotArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  readinessPath: string;
  snapshotInputPath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  snapshotStatus: FundamentalSnapshotInput["snapshotStatus"];
  scoringGate: FundamentalScoringGate;
  evidenceReadinessLevel: FundamentalEvidenceReadinessLevel;
  metadataConfidenceSummary: {
    metadataOnlyTargets: number;
    mixedTargets: number;
    filenameOnlyTargets: number;
    noClassificationTargets: number;
  };
  targets: FundamentalSnapshotTarget[];
  notes: string[];
};

function parseManifestIdFromManifestFileName(fileName: string): string | undefined {
  return fileName.match(/fundamental-manifest-(.+)\.json$/)?.[1];
}

function findReadinessTarget(
  readiness: FundamentalManifestReadiness,
  targetLabel: string,
): ReadinessTarget | undefined {
  return readiness.targets.find((target) => target.targetLabel === targetLabel);
}

function buildMissingCriticalInputs(params: {
  blockedTarget?: BlockedSnapshotTarget;
  readinessTarget?: ReadinessTarget;
}): string[] {
  const missing = new Set<string>();
  for (const blocker of params.blockedTarget?.blockerCodes ?? []) {
    if (blocker === "approval_not_ready") {
      missing.add("review_gate_approval");
    }
    if (blocker === "unresolved_target") {
      missing.add("named_target_resolution");
    }
    if (blocker === "readiness_missing") {
      missing.add("readiness_record");
    }
  }
  for (const category of params.blockedTarget?.missingRequiredCategories ?? []) {
    missing.add(`document:${category}`);
  }
  for (const note of params.readinessTarget?.validationNotes ?? []) {
    if (note.includes("outside the manifest document plan")) {
      missing.add("manifest_document_alignment");
    }
    if (note.includes("could not be classified")) {
      missing.add("document_metadata_sidecar");
    }
  }
  return [...missing];
}

function deriveEvidenceReadinessLevel(params: {
  blockedTarget?: BlockedSnapshotTarget;
  readyTarget?: SnapshotInputTarget;
  readinessTarget?: ReadinessTarget;
}): FundamentalEvidenceReadinessLevel {
  if (params.blockedTarget) {
    return params.blockedTarget.missingRequiredCategories.length > 0 ||
      params.blockedTarget.blockerCodes.includes("approval_not_ready") ||
      params.blockedTarget.blockerCodes.includes("unresolved_target")
      ? "insufficient"
      : "partial";
  }
  if (!params.readyTarget || !params.readinessTarget) {
    return "insufficient";
  }
  const missingPreferredSourceTypes = params.readyTarget.sourceCoverage.missingPreferredSourceTypes;
  if (
    missingPreferredSourceTypes.length > 0 ||
    params.readyTarget.metadataConfidence.mode !== "metadata_only" ||
    params.readinessTarget.validationNotes.length > 0
  ) {
    return "partial";
  }
  return "baseline_ready";
}

function deriveScoringGate(
  evidenceReadinessLevel: FundamentalEvidenceReadinessLevel,
): FundamentalScoringGate {
  if (evidenceReadinessLevel === "baseline_ready") {
    return "allowed";
  }
  if (evidenceReadinessLevel === "partial") {
    return "partial";
  }
  return "blocked";
}

function buildTargetNotes(params: {
  blockedTarget?: BlockedSnapshotTarget;
  readyTarget?: SnapshotInputTarget;
  readinessTarget?: ReadinessTarget;
  scoringGate: FundamentalScoringGate;
}): string[] {
  const notes = [
    ...(params.blockedTarget?.notes ?? []),
    ...(params.readinessTarget?.validationNotes ?? []),
  ];
  if (params.scoringGate === "allowed") {
    notes.push("Target has baseline-ready local inputs for controlled scoring entry.");
  } else if (params.scoringGate === "partial") {
    notes.push(
      "Target can be reviewed, but scoring should remain partial until source coverage or metadata confidence improves.",
    );
  } else {
    notes.push("Target remains blocked from scoring.");
  }
  return notes;
}

function renderFundamentalSnapshotNote(params: {
  dateStr: string;
  timeStr: string;
  snapshotPath: string;
  snapshot: FundamentalSnapshotArtifact;
}): string {
  return [
    `# Fundamental Snapshot: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.snapshot.manifestId}`,
    `- snapshot_path: ${params.snapshotPath}`,
    `- snapshot_status: ${params.snapshot.snapshotStatus}`,
    `- scoring_gate: ${params.snapshot.scoringGate}`,
    `- evidence_readiness_level: ${params.snapshot.evidenceReadinessLevel}`,
    "",
    "## Targets",
    ...params.snapshot.targets.map(
      (target) =>
        `- ${target.targetLabel}: scoring=${target.scoringGate}, readiness=${target.evidenceReadinessLevel}, docs=${target.availableDocumentCategories.join(", ") || "none"}, sources=${target.sourceCoverage.presentSourceTypes.join(", ") || "none"}`,
    ),
    "",
  ].join("\n");
}

export function buildFundamentalSnapshot(params: {
  nowIso: string;
  manifestPath: string;
  readinessPath: string;
  snapshotInputPath: string;
  manifest: FundamentalManifestScaffold;
  readiness: FundamentalManifestReadiness;
  snapshotInput: FundamentalSnapshotInput;
}): FundamentalSnapshotArtifact {
  const targets = params.manifest.targets
    .filter((target) => target.kind === "entity")
    .map((manifestTarget) => {
      const readyTarget = params.snapshotInput.readyTargets.find(
        (target) => target.targetLabel === manifestTarget.label,
      );
      const blockedTarget = params.snapshotInput.blockedTargets.find(
        (target) => target.targetLabel === manifestTarget.label,
      );
      const readinessTarget = findReadinessTarget(params.readiness, manifestTarget.label);
      const availableDocumentCategories =
        readyTarget?.presentCategories ?? blockedTarget?.presentCategories ?? [];
      const sourceCoverage = readyTarget?.sourceCoverage ??
        blockedTarget?.sourceCoverage ?? {
          requiredSourceTypes: [],
          presentSourceTypes: [],
          missingPreferredSourceTypes: [],
        };
      const metadataConfidence = readyTarget?.metadataConfidence ??
        blockedTarget?.metadataConfidence ?? {
          classifiedByMetadata: 0,
          classifiedByFilename: 0,
          mode: "none" as const,
        };
      const evidenceReadinessLevel = deriveEvidenceReadinessLevel({
        blockedTarget,
        readyTarget,
        readinessTarget,
      });
      const scoringGate = deriveScoringGate(evidenceReadinessLevel);

      return {
        targetLabel: manifestTarget.label,
        region: manifestTarget.region,
        assetType: manifestTarget.assetType,
        issuerType: manifestTarget.issuerType,
        availableDocumentCategories,
        sourceCoverage,
        evidenceReadinessLevel,
        metadataConfidence,
        fallbackExposure: {
          filenameFallbackCount: readinessTarget?.filenameFallbackCount ?? 0,
          validationNoteCount: readinessTarget?.validationNotes.length ?? 0,
        },
        missingCriticalInputs: buildMissingCriticalInputs({
          blockedTarget,
          readinessTarget,
        }),
        scoringGate,
        documentPaths: readyTarget?.documentPaths ?? [],
        notes: buildTargetNotes({
          blockedTarget,
          readyTarget,
          readinessTarget,
          scoringGate,
        }),
      } satisfies FundamentalSnapshotTarget;
    });

  const metadataConfidenceSummary = targets.reduce(
    (summary, target) => {
      if (target.metadataConfidence.mode === "metadata_only") {
        summary.metadataOnlyTargets += 1;
      } else if (target.metadataConfidence.mode === "mixed") {
        summary.mixedTargets += 1;
      } else if (target.metadataConfidence.mode === "filename_only") {
        summary.filenameOnlyTargets += 1;
      } else {
        summary.noClassificationTargets += 1;
      }
      return summary;
    },
    {
      metadataOnlyTargets: 0,
      mixedTargets: 0,
      filenameOnlyTargets: 0,
      noClassificationTargets: 0,
    },
  );

  const scoringGate: FundamentalScoringGate = targets.every(
    (target) => target.scoringGate === "allowed",
  )
    ? "allowed"
    : targets.some((target) => target.scoringGate === "partial" || target.scoringGate === "allowed")
      ? "partial"
      : "blocked";
  const evidenceReadinessLevel: FundamentalEvidenceReadinessLevel =
    scoringGate === "allowed"
      ? "baseline_ready"
      : scoringGate === "partial"
        ? "partial"
        : "insufficient";

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.manifest.manifestId,
    manifestPath: params.manifestPath,
    readinessPath: params.readinessPath,
    snapshotInputPath: params.snapshotInputPath,
    requestTitle: params.manifest.requestTitle,
    researchBranch: params.manifest.researchBranch,
    snapshotStatus: params.snapshotInput.snapshotStatus,
    scoringGate,
    evidenceReadinessLevel,
    metadataConfidenceSummary,
    targets,
    notes: [
      "This is a minimal fundamental snapshot built from local manifest, readiness, and snapshot-input artifacts.",
      "It describes scoring eligibility and input quality, not final evidence extraction or model output.",
    ],
  };
}

const materializeFundamentalSnapshot: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const manifests = await loadJsonFilesIsolated<FundamentalManifestScaffold>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
      relativePrefix: "bank/fundamental/manifests",
      stage: "snapshot",
      manifestIdFromFileName: parseManifestIdFromManifestFileName,
    });
    const readinessFiles = await loadJsonFilesIsolated<FundamentalManifestReadiness>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "readiness"),
      relativePrefix: "bank/fundamental/readiness",
      stage: "snapshot",
      manifestIdFromFileName: (fileName) => path.basename(fileName, ".json"),
    });
    const snapshotInputs = await loadJsonFilesIsolated<FundamentalSnapshotInput>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "snapshot-inputs"),
      relativePrefix: "bank/fundamental/snapshot-inputs",
      stage: "snapshot",
      manifestIdFromFileName: (fileName) => path.basename(fileName, ".json"),
    });
    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    await writeFundamentalArtifactErrors({
      workspaceDir,
      memoryDir,
      nowIso,
      errors: [...manifests.errors, ...readinessFiles.errors, ...snapshotInputs.errors],
    });
    if (
      manifests.entries.length === 0 ||
      readinessFiles.entries.length === 0 ||
      snapshotInputs.entries.length === 0
    ) {
      return;
    }

    const readinessByManifestId = new Map(
      readinessFiles.entries.map((entry) => [entry.data.manifestId, entry]),
    );
    const snapshotInputByManifestId = new Map(
      snapshotInputs.entries.map((entry) => [entry.data.manifestId, entry]),
    );
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      manifests.entries.map(async ({ relativePath, data: manifest }) => {
        const readiness = readinessByManifestId.get(manifest.manifestId);
        const snapshotInput = snapshotInputByManifestId.get(manifest.manifestId);
        if (!readiness || !snapshotInput) {
          return;
        }

        const snapshot = buildFundamentalSnapshot({
          nowIso,
          manifestPath: relativePath,
          readinessPath: readiness.relativePath,
          snapshotInputPath: snapshotInput.relativePath,
          manifest,
          readiness: readiness.data,
          snapshotInput: snapshotInput.data,
        });
        const snapshotPath = buildFundamentalArtifactJsonPath(
          "fundamental-snapshot",
          manifest.manifestId,
        );
        const noteRelativePath = buildFundamentalArtifactNoteFilename({
          dateStr,
          stageName: "fundamental-snapshot",
          manifestId: manifest.manifestId,
        });

        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: snapshotPath,
            data: `${JSON.stringify(snapshot, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderFundamentalSnapshotNote({
              dateStr,
              timeStr,
              snapshotPath,
              snapshot: snapshot,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental snapshot materialized ${manifests.entries.length} manifest(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental snapshot", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalSnapshot;
