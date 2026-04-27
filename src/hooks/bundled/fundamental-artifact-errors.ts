import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../infra/fs-safe.js";
import { recordOperationalAnomaly } from "../../infra/operational-anomalies.js";

export type FundamentalArtifactErrorStatus = "blocked_due_to_artifact_error";

export type FundamentalArtifactLoadError = {
  stage: string;
  relativePath: string;
  fileName: string;
  manifestId?: string;
  errorStatus: FundamentalArtifactErrorStatus;
  errorMessage: string;
};

export type FundamentalArtifactErrorRecord = {
  version: 1;
  generatedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  stage: string;
  manifestId: string | null;
  relativePath: string;
  errorStatus: FundamentalArtifactErrorStatus;
  errorFingerprint: string;
  errorMessage: string;
};

type IsolatedJsonEntry<T> = {
  relativePath: string;
  data: T;
};

function sanitizeArtifactToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function buildErrorFingerprint(error: FundamentalArtifactLoadError): string {
  return `${error.stage}::${error.relativePath}::${error.errorMessage}`;
}

async function readExistingArtifactErrorRecord(params: {
  workspaceDir: string;
  recordPath: string;
}): Promise<FundamentalArtifactErrorRecord | undefined> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(params.workspaceDir, params.recordPath), "utf-8"),
    ) as FundamentalArtifactErrorRecord;
  } catch {
    return undefined;
  }
}

export async function loadJsonFilesIsolated<T>(params: {
  dirPath: string;
  relativePrefix: string;
  stage: string;
  manifestIdFromFileName?: (fileName: string) => string | undefined;
}): Promise<{
  entries: Array<IsolatedJsonEntry<T>>;
  errors: FundamentalArtifactLoadError[];
}> {
  let fileNames: string[];
  try {
    fileNames = (await fs.readdir(params.dirPath))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
  } catch {
    return { entries: [], errors: [] };
  }

  const settled = await Promise.all(
    fileNames.map(async (fileName) => {
      const relativePath = `${params.relativePrefix}/${fileName}`;
      try {
        const raw = await fs.readFile(path.join(params.dirPath, fileName), "utf-8");
        return {
          ok: true as const,
          entry: {
            relativePath,
            data: JSON.parse(raw) as T,
          },
        };
      } catch (err) {
        return {
          ok: false as const,
          error: {
            stage: params.stage,
            relativePath,
            fileName,
            manifestId: params.manifestIdFromFileName?.(fileName),
            errorStatus: "blocked_due_to_artifact_error" as const,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }),
  );

  const entries: Array<IsolatedJsonEntry<T>> = [];
  const errors: FundamentalArtifactLoadError[] = [];
  for (const item of settled) {
    if (item.ok) {
      entries.push(item.entry);
    } else {
      errors.push(item.error);
    }
  }
  return { entries, errors };
}

function renderArtifactErrorNote(params: {
  recordPath: string;
  record: FundamentalArtifactErrorRecord;
}): string {
  return [
    `# Fundamental Artifact Error: ${params.record.lastSeenAt.replace("T", " ").replace(".000Z", " UTC")}`,
    "",
    `- stage: ${params.record.stage}`,
    `- manifest_id: ${params.record.manifestId ?? "unknown"}`,
    `- error_status: ${params.record.errorStatus}`,
    `- artifact_path: ${params.recordPath}`,
    `- source_path: ${params.record.relativePath}`,
    `- occurrence_count: ${params.record.occurrenceCount}`,
    `- first_seen_at: ${params.record.firstSeenAt}`,
    `- last_seen_at: ${params.record.lastSeenAt}`,
    `- error: ${params.record.errorMessage}`,
    "",
    "## Effect",
    "- This manifest is explicitly blocked due to artifact error.",
    "- Healthy artifacts in the same batch should continue downstream.",
    "",
  ].join("\n");
}

export async function writeFundamentalArtifactErrors(params: {
  workspaceDir: string;
  memoryDir: string;
  nowIso: string;
  errors: FundamentalArtifactLoadError[];
}): Promise<void> {
  if (params.errors.length === 0) {
    return;
  }

  await Promise.all(
    params.errors.map(async (error) => {
      const artifactToken = sanitizeArtifactToken(
        error.manifestId ?? path.basename(error.fileName, ".json"),
      );
      const recordPath = `bank/fundamental/artifact-errors/${error.stage}-${artifactToken}.json`;
      const notePath = `fundamental-artifact-error-${error.stage}-${artifactToken}.md`;
      const errorFingerprint = buildErrorFingerprint(error);
      const existingRecord = await readExistingArtifactErrorRecord({
        workspaceDir: params.workspaceDir,
        recordPath,
      });
      const record: FundamentalArtifactErrorRecord = {
        version: 1,
        generatedAt: params.nowIso,
        firstSeenAt:
          existingRecord?.errorFingerprint === errorFingerprint
            ? existingRecord.firstSeenAt
            : params.nowIso,
        lastSeenAt: params.nowIso,
        occurrenceCount:
          existingRecord?.errorFingerprint === errorFingerprint
            ? existingRecord.occurrenceCount + 1
            : 1,
        stage: error.stage,
        manifestId: error.manifestId ?? null,
        relativePath: error.relativePath,
        errorStatus: error.errorStatus,
        errorFingerprint,
        errorMessage: error.errorMessage,
      };

      await Promise.all([
        writeFileWithinRoot({
          rootDir: params.workspaceDir,
          relativePath: recordPath,
          data: `${JSON.stringify(record, null, 2)}\n`,
          encoding: "utf-8",
        }),
        writeFileWithinRoot({
          rootDir: params.memoryDir,
          relativePath: notePath,
          data: renderArtifactErrorNote({
            recordPath,
            record,
          }),
          encoding: "utf-8",
        }),
      ]);

      await recordOperationalAnomaly({
        workspaceDir: params.workspaceDir,
        category: "artifact_integrity",
        severity: "medium",
        source: `fundamental.${error.stage}`,
        problem: `artifact error blocked manifest ${record.manifestId ?? "unknown"}`,
        evidence: [
          `manifest_id=${record.manifestId ?? "unknown"}`,
          `source_path=${record.relativePath}`,
          `error_status=${record.errorStatus}`,
          `occurrences=${record.occurrenceCount}`,
          `error=${record.errorMessage}`,
        ],
        impact:
          "fundamental research flow is blocked for this manifest until the artifact error is fixed",
        fingerprint: `${record.stage}::${record.manifestId ?? "unknown"}::${record.errorFingerprint}`,
        repairTicketThreshold: 2,
        nowIso: params.nowIso,
      });
    }),
  );
}
