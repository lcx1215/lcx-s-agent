import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import {
  summarizeFundamentalIntakeSession,
  type FundamentalDocumentMetadata,
  type FundamentalManifestScaffold,
  type FundamentalReviewGateStatus,
} from "../fundamental-intake/handler.js";

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "workspace"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeConfig(tempDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
  } satisfies OpenClawConfig;
}

function createManifestFixture(params?: {
  reviewGateStatus?: FundamentalReviewGateStatus;
}): FundamentalManifestScaffold {
  const nowIso = "2026-03-15T12:00:00.000Z";
  const { manifestScaffold } = summarizeFundamentalIntakeSession(
    [
      {
        role: "user",
        text: "Build a fundamental research scaffold for AAPL in the US. Use annual reports, investor presentations, and research reports.",
      },
      {
        role: "assistant",
        text: "I will keep this manifest-first and approval-gated.",
      },
    ],
    nowIso,
  );
  return {
    ...manifestScaffold,
    reviewGate: {
      ...manifestScaffold.reviewGate,
      status: params?.reviewGateStatus ?? manifestScaffold.reviewGate.status,
    },
  };
}

async function writeManifestFixture(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
}): Promise<string> {
  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  await fs.mkdir(manifestsDir, { recursive: true });
  const manifestPath = path.join(
    manifestsDir,
    `2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`,
  );
  await fs.writeFile(manifestPath, `${JSON.stringify(params.manifest, null, 2)}\n`, "utf-8");
  return manifestPath;
}

async function writeTargetDocument(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  fileName: string;
  metadata?: FundamentalDocumentMetadata;
}): Promise<void> {
  const targetDir = params.manifest.documentWorkspace.targetDirs[0]?.dir;
  if (!targetDir) {
    throw new Error("manifest fixture missing target dir");
  }
  const absoluteTargetDir = path.join(params.workspaceDir, targetDir);
  await fs.mkdir(absoluteTargetDir, { recursive: true });
  const filePath = path.join(absoluteTargetDir, params.fileName);
  await fs.writeFile(filePath, "fixture", "utf-8");
  if (params.metadata) {
    await fs.writeFile(
      `${filePath}.meta.json`,
      `${JSON.stringify(params.metadata, null, 2)}\n`,
      "utf-8",
    );
  }
}

async function runBridge(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<
    | string
    | {
        fileName: string;
        metadata?: FundamentalDocumentMetadata;
      }
  >;
}): Promise<{
  manifest: FundamentalManifestScaffold;
  readiness: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await writeManifestFixture({
    workspaceDir: tempDir,
    manifest: params.manifest,
  });
  for (const document of params.documents ?? []) {
    await writeTargetDocument({
      workspaceDir: tempDir,
      manifest: params.manifest,
      fileName: typeof document === "string" ? document : document.fileName,
      metadata: typeof document === "string" ? undefined : document.metadata,
    });
  }

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
  });
  event.timestamp = new Date("2026-03-15T12:00:00.000Z");

  await handler(event);

  const readinessDir = path.join(tempDir, "bank", "fundamental", "readiness");
  const readinessFiles = await fs.readdir(readinessDir);
  const memoryDir = path.join(tempDir, "memory");
  const memoryFiles = await fs.readdir(memoryDir);
  const manifestsDir = path.join(tempDir, "bank", "fundamental", "manifests");
  const manifestFiles = await fs.readdir(manifestsDir);

  const readiness = JSON.parse(
    await fs.readFile(path.join(readinessDir, readinessFiles[0]), "utf-8"),
  ) as Record<string, unknown>;
  const manifest = JSON.parse(
    await fs.readFile(path.join(manifestsDir, manifestFiles[0]), "utf-8"),
  ) as FundamentalManifestScaffold;
  const noteContent = await fs.readFile(path.join(memoryDir, memoryFiles[0]), "utf-8");

  return {
    manifest,
    readiness,
    noteContent,
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fundamental-bridge-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("fundamental-manifest-bridge hook", () => {
  it("keeps untouched scaffolds in scaffold_only when no local documents exist", async () => {
    const manifest = createManifestFixture();
    const result = await runBridge({ manifest });

    expect(result.manifest.scaffoldStatus).toBe("scaffold_only");
    expect(result.manifest.reviewGate.status).toBe("pending_human_approval");
    expect(result.manifest.collectionStatus).toEqual({
      documentsPresent: false,
      evidenceReady: false,
      requiredDocumentsExpected: 2,
      requiredDocumentsPresent: 0,
      optionalDocumentsPresent: 0,
      notes: [
        "No local documents were detected under the manifest workspace yet.",
        "Required document coverage: 0/2.",
        "Human approval is still pending before evidence readiness can be declared.",
      ],
    });
    expect(result.readiness.scaffoldStatus).toBe("scaffold_only");
    expect(result.readiness.metadataCoverage).toEqual({
      classifiedByMetadata: 0,
      classifiedByFilename: 0,
      metadataMissingCount: 0,
    });
    expect(result.readiness.targets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        presentSourceTypes: [],
        filenameFallbackCount: 0,
      }),
    ]);
    expect(result.noteContent).toContain("scaffold_status: scaffold_only");
    expect(result.noteContent).toContain("AAPL: annual_report, investor_presentation");
  });

  it("marks manifests partial when some required local documents exist", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runBridge({
      manifest,
      documents: ["aapl-annual-report.pdf"],
    });

    expect(result.manifest.scaffoldStatus).toBe("partial");
    expect(result.manifest.reviewGate.status).toBe("approved_for_collection");
    expect(result.manifest.collectionStatus.requiredDocumentsPresent).toBe(1);
    expect(result.manifest.collectionStatus.requiredDocumentsExpected).toBe(2);
    expect(result.manifest.collectionStatus.evidenceReady).toBe(false);
    expect(result.manifest.documentPlan).toEqual([
      expect.objectContaining({ category: "annual_report", status: "present" }),
      expect.objectContaining({ category: "investor_presentation", status: "missing" }),
      expect.objectContaining({ category: "research_report", status: "missing" }),
    ]);
    expect(result.readiness.missingRequiredDocuments).toEqual([
      {
        targetLabel: "AAPL",
        categories: ["investor_presentation"],
      },
    ]);
    expect(result.readiness.targets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        presentSourceTypes: [],
        filenameFallbackCount: 1,
      }),
    ]);
    expect(result.noteContent).toContain("scaffold_status: partial");
    expect(result.noteContent).toContain("required_documents: 1/2");
  });

  it("marks manifests ready only when required documents exist and approval has advanced", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runBridge({
      manifest,
      documents: [
        "aapl-annual-report.pdf",
        "aapl-investor-presentation.pdf",
        "aapl-research-report.pdf",
      ],
    });

    expect(result.manifest.scaffoldStatus).toBe("ready");
    expect(result.manifest.reviewGate.status).toBe("approved_for_evidence");
    expect(result.manifest.collectionStatus).toEqual({
      documentsPresent: true,
      evidenceReady: true,
      requiredDocumentsExpected: 2,
      requiredDocumentsPresent: 2,
      optionalDocumentsPresent: 1,
      notes: [
        "Local documents were detected under the manifest workspace.",
        "Required document coverage: 2/2.",
        "Optional supporting documents present: 1.",
      ],
    });
    expect(result.manifest.riskHandoff.status).toBe("ready_for_fundamental_snapshot");
    expect(result.readiness.riskHandoffStatus).toBe("ready_for_fundamental_snapshot");
    expect(result.readiness.missingRequiredDocuments).toEqual([]);
    expect(result.readiness.targets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        presentSourceTypes: [],
        filenameFallbackCount: 3,
      }),
    ]);
    expect(result.noteContent).toContain("scaffold_status: ready");
    expect(result.noteContent).toContain("aapl-research-report.pdf");
  });

  it("prefers metadata sidecars over filename heuristics and records coverage", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runBridge({
      manifest,
      documents: [
        {
          fileName: "doc-001.bin",
          metadata: {
            version: 1,
            targetLabel: "AAPL",
            category: "annual_report",
            sourceType: "issuer_primary",
          },
        },
        {
          fileName: "doc-002.bin",
          metadata: {
            version: 1,
            targetLabel: "AAPL",
            category: "investor_presentation",
            sourceType: "company_presentation",
          },
        },
      ],
    });

    expect(result.manifest.scaffoldStatus).toBe("ready");
    expect(result.readiness.metadataCoverage).toEqual({
      classifiedByMetadata: 2,
      classifiedByFilename: 0,
      metadataMissingCount: 0,
    });
    expect(result.readiness.targets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        presentCategories: ["annual_report", "investor_presentation"],
        classificationSources: ["metadata", "metadata"],
        presentSourceTypes: ["issuer_primary", "company_presentation"],
        filenameFallbackCount: 0,
        validationNotes: [],
      }),
    ]);
    expect(result.noteContent).toContain("metadata_classified: 2");
    expect(result.noteContent).toContain("filename_fallback_classified: 0");
  });
});
