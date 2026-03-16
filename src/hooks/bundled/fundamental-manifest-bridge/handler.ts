import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import type {
  DocumentType,
  FundamentalDocumentMetadata,
  FundamentalDocumentPlanStatus,
  FundamentalManifestScaffold,
  FundamentalRiskHandoffStatus,
  FundamentalReviewGateStatus,
  FundamentalScaffoldStatus,
  FundamentalSourceType,
} from "../fundamental-intake/handler.js";

const log = createSubsystemLogger("hooks/fundamental-manifest-bridge");

export type ReadinessTarget = {
  targetLabel: string;
  presentCategories: DocumentType[];
  presentFiles: string[];
  classificationSources: Array<"metadata" | "filename">;
  presentSourceTypes: FundamentalSourceType[];
  filenameFallbackCount: number;
  missingRequiredCategories: DocumentType[];
  validationNotes: string[];
};

export type FundamentalManifestReadiness = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  scaffoldStatus: FundamentalScaffoldStatus;
  reviewGateStatus: FundamentalReviewGateStatus;
  riskHandoffStatus: FundamentalRiskHandoffStatus;
  collectionStatus: FundamentalManifestScaffold["collectionStatus"];
  metadataCoverage: {
    classifiedByMetadata: number;
    classifiedByFilename: number;
    metadataMissingCount: number;
  };
  missingRequiredDocuments: Array<{
    targetLabel: string;
    categories: DocumentType[];
  }>;
  targets: ReadinessTarget[];
};

const DOCUMENT_PATTERNS: Record<DocumentType, RegExp[]> = {
  annual_report: [/\bannual\b/, /\b10-k\b/, /year[-_\s]?end/, /年报/],
  quarterly_report: [/\bquarterly\b/, /\b10-q\b/, /\bq[1-4]\b/, /季报/],
  interim_report: [/\binterim\b/, /half[-_\s]?year/],
  earnings_release: [/\bearnings\b/, /\bresults\b/],
  earnings_presentation: [/\bearnings[-_\s]?presentation\b/, /\bresults[-_\s]?deck\b/],
  investor_presentation: [/\binvestor\b/, /\bpresentation\b/, /\bdeck\b/],
  regulatory_filing: [/\bfiling\b/, /\bregulatory\b/, /\bsec\b/, /\bexchange\b/],
  research_report: [/\bresearch\b/, /\breport\b/, /研报/],
  transcript: [/\btranscript\b/, /\bcall\b/],
};

function classifyDocumentType(filePath: string): DocumentType | undefined {
  const normalized = filePath.toLowerCase();
  const entries = Object.entries(DOCUMENT_PATTERNS) as Array<[DocumentType, RegExp[]]>;
  for (const [documentType, patterns] of entries) {
    if (patterns.some((pattern) => pattern.test(normalized))) {
      return documentType;
    }
  }
  return undefined;
}

function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === "string" && Object.hasOwn(DOCUMENT_PATTERNS, value);
}

function isSourceType(value: unknown): value is FundamentalSourceType {
  return (
    value === "issuer_primary" ||
    value === "regulatory_filing" ||
    value === "exchange_disclosure" ||
    value === "company_presentation" ||
    value === "third_party_research"
  );
}

async function loadDocumentMetadata(
  filePath: string,
): Promise<FundamentalDocumentMetadata | undefined> {
  try {
    const raw = await fs.readFile(`${filePath}.meta.json`, "utf-8");
    const parsed = JSON.parse(raw) as FundamentalDocumentMetadata;
    if (
      parsed?.version === 1 &&
      typeof parsed.targetLabel === "string" &&
      isDocumentType(parsed.category) &&
      isSourceType(parsed.sourceType)
    ) {
      return parsed;
    }
  } catch {
    // Ignore missing or invalid metadata sidecars and fall back to filename heuristics.
  }
  return undefined;
}

async function listFilesRecursive(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return listFilesRecursive(entryPath);
        }
        return entry.isFile() ? [entryPath] : [];
      }),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

function toRelativeWorkspacePath(workspaceDir: string, absolutePath: string): string {
  return path.relative(workspaceDir, absolutePath).split(path.sep).join("/");
}

function summarizeTargetDocuments(params: {
  workspaceDir: string;
  targetDir: string;
  targetLabel: string;
  requiredCategories: DocumentType[];
  manifestCategories: DocumentType[];
}): Promise<
  ReadinessTarget & {
    metadataCoverage: FundamentalManifestReadiness["metadataCoverage"];
  }
> {
  return listFilesRecursive(params.targetDir).then(async (files) => {
    const filteredFiles = files.filter((filePath) => !filePath.endsWith(".meta.json"));
    const validationNotes: string[] = [];
    let classifiedByMetadata = 0;
    let classifiedByFilename = 0;
    let metadataMissingCount = 0;
    let filenameFallbackCount = 0;
    const matchedFiles: Array<{
      filePath: string;
      category: DocumentType;
      classificationSource: "metadata" | "filename";
      sourceType?: FundamentalSourceType;
    }> = [];

    for (const filePath of filteredFiles) {
      const metadata = await loadDocumentMetadata(filePath);
      if (metadata) {
        if (metadata.targetLabel !== params.targetLabel) {
          validationNotes.push(
            `${toRelativeWorkspacePath(params.workspaceDir, filePath)} metadata target ${metadata.targetLabel} does not match ${params.targetLabel}.`,
          );
          continue;
        }
        if (!params.manifestCategories.includes(metadata.category)) {
          validationNotes.push(
            `${toRelativeWorkspacePath(params.workspaceDir, filePath)} metadata category ${metadata.category} is outside the manifest document plan.`,
          );
          continue;
        }
        matchedFiles.push({
          filePath,
          category: metadata.category,
          classificationSource: "metadata",
          sourceType: metadata.sourceType,
        });
        classifiedByMetadata += 1;
        continue;
      }

      metadataMissingCount += 1;
      const category = classifyDocumentType(filePath);
      if (!category) {
        validationNotes.push(
          `${toRelativeWorkspacePath(params.workspaceDir, filePath)} could not be classified from filename; add a .meta.json sidecar.`,
        );
        continue;
      }
      if (!params.manifestCategories.includes(category)) {
        validationNotes.push(
          `${toRelativeWorkspacePath(params.workspaceDir, filePath)} classified as ${category}, which is outside the manifest document plan.`,
        );
        continue;
      }
      matchedFiles.push({
        filePath,
        category,
        classificationSource: "filename",
      });
      classifiedByFilename += 1;
      filenameFallbackCount += 1;
    }

    const presentCategories = [...new Set(matchedFiles.map((entry) => entry.category))];
    return {
      targetLabel: params.targetLabel,
      presentCategories,
      presentFiles: matchedFiles.map((entry) =>
        toRelativeWorkspacePath(params.workspaceDir, entry.filePath),
      ),
      classificationSources: matchedFiles.map((entry) => entry.classificationSource),
      presentSourceTypes: [
        ...new Set(
          matchedFiles
            .map((entry) => entry.sourceType)
            .filter((sourceType): sourceType is FundamentalSourceType => Boolean(sourceType)),
        ),
      ],
      filenameFallbackCount,
      missingRequiredCategories: params.requiredCategories.filter(
        (category) => !presentCategories.includes(category),
      ),
      validationNotes,
      metadataCoverage: {
        classifiedByMetadata,
        classifiedByFilename,
        metadataMissingCount,
      },
    };
  });
}

function buildCollectionNotes(params: {
  documentsPresent: boolean;
  evidenceReady: boolean;
  requiredDocumentsPresent: number;
  requiredDocumentsExpected: number;
  optionalDocumentsPresent: number;
  reviewGateStatus: FundamentalReviewGateStatus;
}): string[] {
  const notes = [
    params.documentsPresent
      ? "Local documents were detected under the manifest workspace."
      : "No local documents were detected under the manifest workspace yet.",
    `Required document coverage: ${params.requiredDocumentsPresent}/${params.requiredDocumentsExpected}.`,
  ];
  if (params.optionalDocumentsPresent > 0) {
    notes.push(`Optional supporting documents present: ${params.optionalDocumentsPresent}.`);
  }
  if (!params.evidenceReady) {
    notes.push(
      params.reviewGateStatus === "pending_human_approval"
        ? "Human approval is still pending before evidence readiness can be declared."
        : "Required local documents are still incomplete, so evidence readiness remains blocked.",
    );
  }
  return notes;
}

function buildRiskNotes(evidenceReady: boolean): string[] {
  return evidenceReady
    ? [
        "Required local documents are present and the manifest is ready for fundamental snapshot work.",
        "Risk handoff can now proceed to the controlled fundamental snapshot and scoring flow.",
      ]
    : [
        "Risk handoff remains blocked until the manifest has the required local documents and approval state.",
        "This bridge reflects local readiness only; it does not create evidence or scoring outputs.",
      ];
}

function updateDocumentPlanStatuses(params: {
  manifest: FundamentalManifestScaffold;
  targets: ReadinessTarget[];
}): FundamentalManifestScaffold["documentPlan"] {
  return params.manifest.documentPlan.map((plan) => {
    const planStatus: FundamentalDocumentPlanStatus =
      params.targets.length > 0 &&
      params.targets.every((target) => target.presentCategories.includes(plan.category))
        ? "present"
        : "missing";
    return {
      ...plan,
      status: planStatus,
    };
  });
}

function renderReadinessNote(params: {
  dateStr: string;
  timeStr: string;
  manifestId: string;
  manifestPath: string;
  readinessPath: string;
  readiness: FundamentalManifestReadiness;
}): string {
  return [
    `# Fundamental Readiness: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.manifestId}`,
    `- manifest_path: ${params.manifestPath}`,
    `- readiness_path: ${params.readinessPath}`,
    `- scaffold_status: ${params.readiness.scaffoldStatus}`,
    `- review_gate_status: ${params.readiness.reviewGateStatus}`,
    `- risk_handoff: ${params.readiness.riskHandoffStatus}`,
    `- required_documents: ${params.readiness.collectionStatus.requiredDocumentsPresent}/${params.readiness.collectionStatus.requiredDocumentsExpected}`,
    `- optional_documents_present: ${params.readiness.collectionStatus.optionalDocumentsPresent}`,
    `- metadata_classified: ${params.readiness.metadataCoverage.classifiedByMetadata}`,
    `- filename_fallback_classified: ${params.readiness.metadataCoverage.classifiedByFilename}`,
    "",
    "## Missing Required Documents",
    ...(params.readiness.missingRequiredDocuments.length > 0
      ? params.readiness.missingRequiredDocuments.map(
          (entry) => `- ${entry.targetLabel}: ${entry.categories.join(", ")}`,
        )
      : ["- none"]),
    "",
    "## Present Documents",
    ...params.readiness.targets.flatMap((target) =>
      target.presentFiles.length > 0
        ? [`- ${target.targetLabel}: ${target.presentFiles.join(", ")}`]
        : [],
    ),
    "",
    "## Validation Notes",
    ...params.readiness.targets.flatMap((target) =>
      target.validationNotes.length > 0 ? target.validationNotes.map((note) => `- ${note}`) : [],
    ),
    "",
  ].join("\n");
}

async function loadManifestFiles(
  workspaceDir: string,
): Promise<Array<{ relativePath: string; manifest: FundamentalManifestScaffold }>> {
  const manifestsDir = path.join(workspaceDir, "bank", "fundamental", "manifests");
  try {
    const files = (await fs.readdir(manifestsDir))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    const loaded = await Promise.all(
      files.map(async (fileName) => {
        const relativePath = `bank/fundamental/manifests/${fileName}`;
        const raw = await fs.readFile(path.join(manifestsDir, fileName), "utf-8");
        const manifest = JSON.parse(raw) as FundamentalManifestScaffold;
        return { relativePath, manifest };
      }),
    );
    return loaded.filter(
      (entry) =>
        entry.manifest &&
        entry.manifest.version === 1 &&
        Array.isArray(entry.manifest.documentPlan) &&
        Array.isArray(entry.manifest.documentWorkspace?.targetDirs),
    );
  } catch {
    return [];
  }
}

export async function bridgeManifest(params: {
  workspaceDir: string;
  nowIso: string;
  manifestPath: string;
  manifest: FundamentalManifestScaffold;
}): Promise<{
  manifest: FundamentalManifestScaffold;
  readiness: FundamentalManifestReadiness;
}> {
  const requiredCategories = params.manifest.documentPlan
    .filter((plan) => plan.required)
    .map((plan) => plan.category);
  const optionalCategories = params.manifest.documentPlan
    .filter((plan) => !plan.required)
    .map((plan) => plan.category);
  const manifestCategories = params.manifest.documentPlan.map((plan) => plan.category);

  const targets = await Promise.all(
    params.manifest.documentWorkspace.targetDirs.map((targetDir) =>
      summarizeTargetDocuments({
        workspaceDir: params.workspaceDir,
        targetDir: path.join(params.workspaceDir, targetDir.dir),
        targetLabel: targetDir.targetLabel,
        requiredCategories,
        manifestCategories,
      }),
    ),
  );

  const documentsPresent = targets.some((target) => target.presentFiles.length > 0);
  const requiredDocumentsExpected = requiredCategories.length * targets.length;
  const requiredDocumentsPresent = targets.reduce(
    (count, target) =>
      count + (requiredCategories.length - target.missingRequiredCategories.length),
    0,
  );
  const optionalDocumentsPresent = targets.reduce(
    (count, target) =>
      count +
      optionalCategories.filter((category) => target.presentCategories.includes(category)).length,
    0,
  );
  const metadataCoverage = targets.reduce(
    (coverage, target) => ({
      classifiedByMetadata:
        coverage.classifiedByMetadata + target.metadataCoverage.classifiedByMetadata,
      classifiedByFilename:
        coverage.classifiedByFilename + target.metadataCoverage.classifiedByFilename,
      metadataMissingCount:
        coverage.metadataMissingCount + target.metadataCoverage.metadataMissingCount,
    }),
    {
      classifiedByMetadata: 0,
      classifiedByFilename: 0,
      metadataMissingCount: 0,
    },
  );

  const nextReviewGateStatus: FundamentalReviewGateStatus =
    params.manifest.reviewGate.status === "approved_for_collection" &&
    requiredDocumentsExpected > 0 &&
    requiredDocumentsPresent === requiredDocumentsExpected
      ? "approved_for_evidence"
      : params.manifest.reviewGate.status;
  const evidenceReady =
    requiredDocumentsExpected > 0 &&
    requiredDocumentsPresent === requiredDocumentsExpected &&
    nextReviewGateStatus === "approved_for_evidence";
  const scaffoldStatus: FundamentalScaffoldStatus = !documentsPresent
    ? "scaffold_only"
    : evidenceReady
      ? "ready"
      : "partial";
  const riskHandoffStatus: FundamentalRiskHandoffStatus = evidenceReady
    ? "ready_for_fundamental_snapshot"
    : "not_ready_for_risk_handoff";
  const collectionStatus = {
    documentsPresent,
    evidenceReady,
    requiredDocumentsExpected,
    requiredDocumentsPresent,
    optionalDocumentsPresent,
    notes: buildCollectionNotes({
      documentsPresent,
      evidenceReady,
      requiredDocumentsPresent,
      requiredDocumentsExpected,
      optionalDocumentsPresent,
      reviewGateStatus: nextReviewGateStatus,
    }),
  } satisfies FundamentalManifestScaffold["collectionStatus"];

  const updatedManifest: FundamentalManifestScaffold = {
    ...params.manifest,
    generatedAt: params.nowIso,
    scaffoldStatus,
    documentPlan: updateDocumentPlanStatuses({
      manifest: params.manifest,
      targets,
    }),
    reviewGate: {
      ...params.manifest.reviewGate,
      status: nextReviewGateStatus,
    },
    collectionStatus,
    riskHandoff: {
      status: riskHandoffStatus,
      riskAuditPath: params.manifest.riskHandoff.riskAuditPath,
      notes: buildRiskNotes(evidenceReady),
    },
  };

  const readiness: FundamentalManifestReadiness = {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: updatedManifest.manifestId,
    manifestPath: params.manifestPath,
    scaffoldStatus,
    reviewGateStatus: nextReviewGateStatus,
    riskHandoffStatus,
    collectionStatus,
    metadataCoverage,
    missingRequiredDocuments: targets
      .filter((target) => target.missingRequiredCategories.length > 0)
      .map((target) => ({
        targetLabel: target.targetLabel,
        categories: target.missingRequiredCategories,
      })),
    targets: targets.map(({ metadataCoverage: _metadataCoverage, ...target }) => target),
  };

  return {
    manifest: updatedManifest,
    readiness,
  };
}

const bridgeFundamentalManifest: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const manifests = await loadManifestFiles(workspaceDir);
    if (manifests.length === 0) {
      return;
    }

    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      manifests.map(async ({ relativePath, manifest }) => {
        const bridged = await bridgeManifest({
          workspaceDir,
          nowIso,
          manifestPath: relativePath,
          manifest,
        });
        const readinessRelativePath = `bank/fundamental/readiness/${bridged.manifest.manifestId}.json`;
        const noteRelativePath = `${dateStr}-fundamental-readiness-${bridged.manifest.manifestId}.md`;

        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath,
            data: `${JSON.stringify(bridged.manifest, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: readinessRelativePath,
            data: `${JSON.stringify(bridged.readiness, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderReadinessNote({
              dateStr,
              timeStr,
              manifestId: bridged.manifest.manifestId,
              manifestPath: relativePath,
              readinessPath: readinessRelativePath,
              readiness: bridged.readiness,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental manifest bridge updated ${manifests.length} manifest(s)`);
  } catch (err) {
    log.error("Failed to bridge fundamental manifests", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default bridgeFundamentalManifest;
