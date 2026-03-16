import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import type {
  DocumentType,
  FundamentalManifestScaffold,
  FundamentalSourceType,
} from "../fundamental-intake/handler.js";
import type { FundamentalManifestReadiness } from "../fundamental-manifest-bridge/handler.js";

const log = createSubsystemLogger("hooks/fundamental-snapshot-bridge");

type SnapshotBridgeStatus = "blocked" | "partial" | "ready";
type SnapshotBlockerCode =
  | "unresolved_target"
  | "missing_required_documents"
  | "approval_not_ready"
  | "readiness_missing";

export type SnapshotInputTarget = {
  targetLabel: string;
  region: string;
  assetType: FundamentalManifestScaffold["targets"][number]["assetType"];
  issuerType: FundamentalManifestScaffold["targets"][number]["issuerType"];
  requiredCategories: DocumentType[];
  presentCategories: DocumentType[];
  presentSourceTypes: FundamentalSourceType[];
  sourceCoverage: {
    requiredSourceTypes: FundamentalSourceType[];
    presentSourceTypes: FundamentalSourceType[];
    missingPreferredSourceTypes: FundamentalSourceType[];
  };
  metadataConfidence: {
    classifiedByMetadata: number;
    classifiedByFilename: number;
    mode: "metadata_only" | "mixed" | "filename_only" | "none";
  };
  documentPaths: string[];
};

export type BlockedSnapshotTarget = {
  targetLabel: string;
  region: string;
  blockerCodes: SnapshotBlockerCode[];
  missingRequiredCategories: DocumentType[];
  presentCategories: DocumentType[];
  presentSourceTypes: FundamentalSourceType[];
  sourceCoverage: {
    requiredSourceTypes: FundamentalSourceType[];
    presentSourceTypes: FundamentalSourceType[];
    missingPreferredSourceTypes: FundamentalSourceType[];
  };
  metadataConfidence: {
    classifiedByMetadata: number;
    classifiedByFilename: number;
    mode: "metadata_only" | "mixed" | "filename_only" | "none";
  };
  notes: string[];
};

export type FundamentalSnapshotInput = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  readinessPath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  snapshotStatus: SnapshotBridgeStatus;
  coverageSummary: {
    totalEntityTargets: number;
    readyTargetCount: number;
    blockedTargetCount: number;
    requiredCategories: DocumentType[];
  };
  readyTargets: SnapshotInputTarget[];
  blockedTargets: BlockedSnapshotTarget[];
  notes: string[];
};

function buildMetadataConfidence(params: {
  classifiedByMetadata: number;
  classifiedByFilename: number;
}): SnapshotInputTarget["metadataConfidence"] {
  if (params.classifiedByMetadata > 0 && params.classifiedByFilename === 0) {
    return { ...params, mode: "metadata_only" };
  }
  if (params.classifiedByMetadata > 0 && params.classifiedByFilename > 0) {
    return { ...params, mode: "mixed" };
  }
  if (params.classifiedByFilename > 0) {
    return { ...params, mode: "filename_only" };
  }
  return { ...params, mode: "none" };
}

async function loadJsonFiles<T>(params: {
  dirPath: string;
  relativePrefix: string;
}): Promise<Array<{ relativePath: string; data: T }>> {
  try {
    const files = (await fs.readdir(params.dirPath))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    return await Promise.all(
      files.map(async (fileName) => {
        const relativePath = `${params.relativePrefix}/${fileName}`;
        const raw = await fs.readFile(path.join(params.dirPath, fileName), "utf-8");
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

function buildBlockedTargetNotes(params: {
  blockerCodes: SnapshotBlockerCode[];
  missingRequiredCategories: DocumentType[];
}): string[] {
  const notes: string[] = [];
  if (params.blockerCodes.includes("unresolved_target")) {
    notes.push("Target is still a placeholder and must be resolved before snapshot entry.");
  }
  if (params.blockerCodes.includes("approval_not_ready")) {
    notes.push("Review gate is still pending human approval.");
  }
  if (params.blockerCodes.includes("missing_required_documents")) {
    notes.push(
      `Required categories still missing: ${params.missingRequiredCategories.join(", ")}.`,
    );
  }
  if (params.blockerCodes.includes("readiness_missing")) {
    notes.push("No matching readiness target was found for this manifest target.");
  }
  return notes;
}

function buildSnapshotNotes(params: {
  snapshotStatus: SnapshotBridgeStatus;
  readyTargetCount: number;
  blockedTargetCount: number;
}): string[] {
  if (params.snapshotStatus === "ready") {
    return [
      "All named entity targets satisfy the minimum local conditions for snapshot entry.",
      "This artifact is an input bridge only; evidence extraction and scoring still happen later.",
    ];
  }
  if (params.snapshotStatus === "partial") {
    return [
      `${params.readyTargetCount} target(s) can enter the fundamental snapshot stage, while ${params.blockedTargetCount} remain blocked.`,
      "Blocked targets stay out of scoring until coverage or review-gate issues are resolved.",
    ];
  }
  return [
    "No targets are eligible for fundamental snapshot entry yet.",
    "This artifact records blockers only and does not create downstream evidence or score outputs.",
  ];
}

function renderSnapshotBridgeNote(params: {
  dateStr: string;
  timeStr: string;
  snapshotInputPath: string;
  snapshotInput: FundamentalSnapshotInput;
}): string {
  return [
    `# Fundamental Snapshot Bridge: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.snapshotInput.manifestId}`,
    `- snapshot_input_path: ${params.snapshotInputPath}`,
    `- snapshot_status: ${params.snapshotInput.snapshotStatus}`,
    `- ready_targets: ${params.snapshotInput.coverageSummary.readyTargetCount}/${params.snapshotInput.coverageSummary.totalEntityTargets}`,
    `- blocked_targets: ${params.snapshotInput.coverageSummary.blockedTargetCount}`,
    "",
    "## Ready Targets",
    ...(params.snapshotInput.readyTargets.length > 0
      ? params.snapshotInput.readyTargets.map(
          (target) =>
            `- ${target.targetLabel}: ${target.presentCategories.join(", ")} | ${target.documentPaths.join(", ")}`,
        )
      : ["- none"]),
    "",
    "## Blocked Targets",
    ...(params.snapshotInput.blockedTargets.length > 0
      ? params.snapshotInput.blockedTargets.map(
          (target) =>
            `- ${target.targetLabel}: ${target.blockerCodes.join(", ")}${target.missingRequiredCategories.length > 0 ? ` | missing: ${target.missingRequiredCategories.join(", ")}` : ""}`,
        )
      : ["- none"]),
    "",
  ].join("\n");
}

export function buildSnapshotInput(params: {
  nowIso: string;
  manifestPath: string;
  readinessPath: string;
  manifest: FundamentalManifestScaffold;
  readiness: FundamentalManifestReadiness;
}): FundamentalSnapshotInput {
  const requiredCategories = params.manifest.documentPlan
    .filter((plan) => plan.required)
    .map((plan) => plan.category);
  const entityTargets = params.manifest.targets.filter((target) => target.kind === "entity");

  const blockedTargets: BlockedSnapshotTarget[] = [];
  const readyTargets: SnapshotInputTarget[] = [];

  for (const target of entityTargets) {
    const readinessTarget = params.readiness.targets.find(
      (candidate) => candidate.targetLabel === target.label,
    );
    const blockerCodes = new Set<SnapshotBlockerCode>();

    if (target.resolution !== "named") {
      blockerCodes.add("unresolved_target");
    }
    if (params.readiness.reviewGateStatus === "pending_human_approval") {
      blockerCodes.add("approval_not_ready");
    }
    if (!readinessTarget) {
      blockerCodes.add("readiness_missing");
    } else if (readinessTarget.missingRequiredCategories.length > 0) {
      blockerCodes.add("missing_required_documents");
    }

    if (blockerCodes.size === 0 && readinessTarget) {
      const requiredSourceTypes = params.manifest.documentPlan
        .flatMap((plan) => (plan.required ? plan.preferredSources : []))
        .filter((sourceType, index, array) => array.indexOf(sourceType) === index);
      readyTargets.push({
        targetLabel: target.label,
        region: target.region,
        assetType: target.assetType,
        issuerType: target.issuerType,
        requiredCategories,
        presentCategories: readinessTarget.presentCategories,
        presentSourceTypes: readinessTarget.presentSourceTypes,
        sourceCoverage: {
          requiredSourceTypes,
          presentSourceTypes: readinessTarget.presentSourceTypes,
          missingPreferredSourceTypes: requiredSourceTypes.filter(
            (sourceType) => !readinessTarget.presentSourceTypes.includes(sourceType),
          ),
        },
        metadataConfidence: buildMetadataConfidence({
          classifiedByMetadata: readinessTarget.classificationSources.filter(
            (source) => source === "metadata",
          ).length,
          classifiedByFilename: readinessTarget.filenameFallbackCount,
        }),
        documentPaths: readinessTarget.presentFiles,
      });
      continue;
    }

    const requiredSourceTypes = params.manifest.documentPlan
      .flatMap((plan) => (plan.required ? plan.preferredSources : []))
      .filter((sourceType, index, array) => array.indexOf(sourceType) === index);
    blockedTargets.push({
      targetLabel: target.label,
      region: target.region,
      blockerCodes: [...blockerCodes],
      missingRequiredCategories: readinessTarget?.missingRequiredCategories ?? requiredCategories,
      presentCategories: readinessTarget?.presentCategories ?? [],
      presentSourceTypes: readinessTarget?.presentSourceTypes ?? [],
      sourceCoverage: {
        requiredSourceTypes,
        presentSourceTypes: readinessTarget?.presentSourceTypes ?? [],
        missingPreferredSourceTypes: requiredSourceTypes.filter(
          (sourceType) => !(readinessTarget?.presentSourceTypes ?? []).includes(sourceType),
        ),
      },
      metadataConfidence: buildMetadataConfidence({
        classifiedByMetadata:
          readinessTarget?.classificationSources.filter((source) => source === "metadata").length ??
          0,
        classifiedByFilename: readinessTarget?.filenameFallbackCount ?? 0,
      }),
      notes: buildBlockedTargetNotes({
        blockerCodes: [...blockerCodes],
        missingRequiredCategories: readinessTarget?.missingRequiredCategories ?? requiredCategories,
      }),
    });
  }

  const snapshotStatus: SnapshotBridgeStatus =
    readyTargets.length === 0 ? "blocked" : blockedTargets.length > 0 ? "partial" : "ready";

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.manifest.manifestId,
    manifestPath: params.manifestPath,
    readinessPath: params.readinessPath,
    requestTitle: params.manifest.requestTitle,
    researchBranch: params.manifest.researchBranch,
    snapshotStatus,
    coverageSummary: {
      totalEntityTargets: entityTargets.length,
      readyTargetCount: readyTargets.length,
      blockedTargetCount: blockedTargets.length,
      requiredCategories,
    },
    readyTargets,
    blockedTargets,
    notes: buildSnapshotNotes({
      snapshotStatus,
      readyTargetCount: readyTargets.length,
      blockedTargetCount: blockedTargets.length,
    }),
  };
}

const bridgeFundamentalSnapshot: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const manifests = await loadJsonFiles<FundamentalManifestScaffold>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
      relativePrefix: "bank/fundamental/manifests",
    });
    const readinessFiles = await loadJsonFiles<FundamentalManifestReadiness>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "readiness"),
      relativePrefix: "bank/fundamental/readiness",
    });
    if (manifests.length === 0 || readinessFiles.length === 0) {
      return;
    }

    const readinessByManifestId = new Map(
      readinessFiles.map((entry) => [entry.data.manifestId, entry]),
    );
    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      manifests.map(async ({ relativePath, data: manifest }) => {
        const readiness = readinessByManifestId.get(manifest.manifestId);
        if (!readiness) {
          return;
        }
        const snapshotInput = buildSnapshotInput({
          nowIso,
          manifestPath: relativePath,
          readinessPath: readiness.relativePath,
          manifest,
          readiness: readiness.data,
        });
        const snapshotInputPath = `bank/fundamental/snapshot-inputs/${manifest.manifestId}.json`;
        const noteRelativePath = `${dateStr}-fundamental-snapshot-bridge-${manifest.manifestId}.md`;

        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: snapshotInputPath,
            data: `${JSON.stringify(snapshotInput, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderSnapshotBridgeNote({
              dateStr,
              timeStr,
              snapshotInputPath,
              snapshotInput,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental snapshot bridge evaluated ${manifests.length} manifest(s)`);
  } catch (err) {
    log.error("Failed to build fundamental snapshot inputs", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default bridgeFundamentalSnapshot;
