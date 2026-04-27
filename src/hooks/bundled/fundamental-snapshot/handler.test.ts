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
import {
  bridgeManifest,
  type FundamentalManifestReadiness,
} from "../fundamental-manifest-bridge/handler.js";
import {
  buildSnapshotInput,
  type FundamentalSnapshotInput,
} from "../fundamental-snapshot-bridge/handler.js";
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";

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
  requestText?: string;
}): FundamentalManifestScaffold {
  const nowIso = "2026-03-15T12:00:00.000Z";
  const { manifestScaffold } = summarizeFundamentalIntakeSession(
    [
      {
        role: "user",
        text:
          params?.requestText ??
          "Build a fundamental research scaffold for AAPL in the US. Use annual reports, investor presentations, and research reports.",
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

function withManifestId(
  manifest: FundamentalManifestScaffold,
  manifestId: string,
): FundamentalManifestScaffold {
  return {
    ...manifest,
    manifestId,
    documentWorkspace: {
      ...manifest.documentWorkspace,
      baseDir: `bank/fundamental/documents/${manifestId}`,
      targetDirs: manifest.documentWorkspace.targetDirs.map((targetDir) => ({
        ...targetDir,
        dir: `bank/fundamental/documents/${manifestId}/${targetDir.dir.split("/").at(-1)}`,
      })),
    },
  };
}

async function writeManifestState(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  readiness: FundamentalManifestReadiness;
  snapshotInput: FundamentalSnapshotInput;
}): Promise<void> {
  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  const readinessDir = path.join(params.workspaceDir, "bank", "fundamental", "readiness");
  const snapshotInputsDir = path.join(
    params.workspaceDir,
    "bank",
    "fundamental",
    "snapshot-inputs",
  );
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(readinessDir, { recursive: true });
  await fs.mkdir(snapshotInputsDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestsDir, `2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`),
    `${JSON.stringify(params.manifest, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(readinessDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(params.readiness, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(snapshotInputsDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(params.snapshotInput, null, 2)}\n`,
    "utf-8",
  );
}

async function writeTargetDocument(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  fileName: string;
  targetLabel?: string;
  metadata?: FundamentalDocumentMetadata;
}): Promise<void> {
  const targetDir =
    params.manifest.documentWorkspace.targetDirs.find(
      (entry) => entry.targetLabel === (params.targetLabel ?? params.manifest.targets[0]?.label),
    )?.dir ?? params.manifest.documentWorkspace.targetDirs[0]?.dir;
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

async function prepareSnapshotState(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  documents?: Array<
    | string
    | {
        fileName: string;
        metadata?: FundamentalDocumentMetadata;
        targetLabel?: string;
      }
  >;
}): Promise<void> {
  for (const document of params.documents ?? []) {
    await writeTargetDocument({
      workspaceDir: params.workspaceDir,
      manifest: params.manifest,
      fileName: typeof document === "string" ? document : document.fileName,
      metadata: typeof document === "string" ? undefined : document.metadata,
      targetLabel: typeof document === "string" ? undefined : document.targetLabel,
    });
  }
  const manifestPath = `bank/fundamental/manifests/2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`;
  const readiness = await bridgeManifest({
    workspaceDir: params.workspaceDir,
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath,
    manifest: params.manifest,
  });
  const snapshotInput = buildSnapshotInput({
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    manifest: readiness.manifest,
    readiness: readiness.readiness,
  });
  await writeManifestState({
    workspaceDir: params.workspaceDir,
    manifest: readiness.manifest,
    readiness: readiness.readiness,
    snapshotInput,
  });
}

async function runSnapshotHook(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<
    | string
    | {
        fileName: string;
        metadata?: FundamentalDocumentMetadata;
        targetLabel?: string;
      }
  >;
}): Promise<{
  snapshot: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareSnapshotState({
    workspaceDir: tempDir,
    manifest: params.manifest,
    documents: params.documents,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
  });
  event.timestamp = new Date("2026-03-15T12:00:00.000Z");

  await handler(event);

  const memoryDir = path.join(tempDir, "memory");
  const snapshotPath = buildFundamentalArtifactJsonPath(
    "fundamental-snapshot",
    params.manifest.manifestId,
  );
  const notePath = buildFundamentalArtifactNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-snapshot",
    manifestId: params.manifest.manifestId,
  });

  return {
    snapshot: JSON.parse(await fs.readFile(path.join(tempDir, snapshotPath), "utf-8")) as Record<
      string,
      unknown
    >,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-snapshot-artifact-"),
  );
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("fundamental-snapshot hook", () => {
  it("keeps scoring blocked when critical inputs are still missing", async () => {
    const manifest = createManifestFixture();
    const result = await runSnapshotHook({ manifest });

    expect(result.snapshot.snapshotStatus).toBe("blocked");
    expect(result.snapshot.scoringGate).toBe("blocked");
    expect(result.snapshot.evidenceReadinessLevel).toBe("insufficient");
    expect(result.snapshot.targets).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        assetType: "equity",
        issuerType: "public_company",
        availableDocumentCategories: [],
        sourceCoverage: {
          requiredSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          presentSourceTypes: [],
          missingPreferredSourceTypes: [
            "issuer_primary",
            "regulatory_filing",
            "company_presentation",
          ],
        },
        evidenceReadinessLevel: "insufficient",
        metadataConfidence: {
          classifiedByMetadata: 0,
          classifiedByFilename: 0,
          mode: "none",
        },
        fallbackExposure: {
          filenameFallbackCount: 0,
          validationNoteCount: 0,
        },
        missingCriticalInputs: [
          "review_gate_approval",
          "document:annual_report",
          "document:investor_presentation",
        ],
        scoringGate: "blocked",
        documentPaths: [],
        notes: [
          "Review gate is still pending human approval.",
          "Required categories still missing: annual_report, investor_presentation.",
          "Target remains blocked from scoring.",
        ],
      },
    ]);
    expect(result.noteContent).toContain("scoring_gate: blocked");
  });

  it("marks scoring partial when document coverage exists but fallback exposure remains", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runSnapshotHook({
      manifest,
      documents: [
        "aapl-annual-report.pdf",
        "aapl-investor-presentation.pdf",
        "aapl-research-report.pdf",
      ],
    });

    expect(result.snapshot.snapshotStatus).toBe("ready");
    expect(result.snapshot.scoringGate).toBe("partial");
    expect(result.snapshot.evidenceReadinessLevel).toBe("partial");
    expect(result.snapshot.metadataConfidenceSummary).toEqual({
      metadataOnlyTargets: 0,
      mixedTargets: 0,
      filenameOnlyTargets: 1,
      noClassificationTargets: 0,
    });
    expect(result.snapshot.targets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        evidenceReadinessLevel: "partial",
        scoringGate: "partial",
        fallbackExposure: {
          filenameFallbackCount: 3,
          validationNoteCount: 0,
        },
        metadataConfidence: {
          classifiedByMetadata: 0,
          classifiedByFilename: 3,
          mode: "filename_only",
        },
      }),
    ]);
    expect(result.noteContent).toContain("scoring=partial");
  });

  it("allows scoring when metadata-backed source coverage is baseline-ready", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runSnapshotHook({
      manifest,
      documents: [
        {
          fileName: "doc-annual-primary.bin",
          metadata: {
            version: 1,
            targetLabel: "AAPL",
            category: "annual_report",
            sourceType: "issuer_primary",
          },
        },
        {
          fileName: "doc-annual-regulatory.bin",
          metadata: {
            version: 1,
            targetLabel: "AAPL",
            category: "annual_report",
            sourceType: "regulatory_filing",
          },
        },
        {
          fileName: "doc-presentation.bin",
          metadata: {
            version: 1,
            targetLabel: "AAPL",
            category: "investor_presentation",
            sourceType: "company_presentation",
          },
        },
      ],
    });

    expect(result.snapshot.snapshotStatus).toBe("ready");
    expect(result.snapshot.scoringGate).toBe("allowed");
    expect(result.snapshot.evidenceReadinessLevel).toBe("baseline_ready");
    expect(result.snapshot.metadataConfidenceSummary).toEqual({
      metadataOnlyTargets: 1,
      mixedTargets: 0,
      filenameOnlyTargets: 0,
      noClassificationTargets: 0,
    });
    expect(result.snapshot.targets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        region: "us",
        assetType: "equity",
        issuerType: "public_company",
        availableDocumentCategories: ["annual_report", "investor_presentation"],
        sourceCoverage: {
          requiredSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          presentSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          missingPreferredSourceTypes: [],
        },
        evidenceReadinessLevel: "baseline_ready",
        metadataConfidence: {
          classifiedByMetadata: 3,
          classifiedByFilename: 0,
          mode: "metadata_only",
        },
        fallbackExposure: {
          filenameFallbackCount: 0,
          validationNoteCount: 0,
        },
        missingCriticalInputs: [],
        scoringGate: "allowed",
        notes: ["Target has baseline-ready local inputs for controlled scoring entry."],
      }),
    ]);
    expect(result.noteContent).toContain("scoring=allowed");
  });

  it("quarantines malformed readiness artifacts without dropping healthy manifests", async () => {
    const tempDir = await createCaseWorkspace("malformed-readiness");
    const healthyManifest = withManifestId(
      createManifestFixture({
        reviewGateStatus: "approved_for_collection",
        requestText:
          "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
      }),
      "aapl-healthy",
    );
    const brokenManifest = withManifestId(
      createManifestFixture({
        reviewGateStatus: "approved_for_collection",
        requestText:
          "Build a fundamental research scaffold for MSFT in the US. Use annual reports and investor presentations.",
      }),
      "msft-artifact-error",
    );

    await prepareSnapshotState({
      workspaceDir: tempDir,
      manifest: healthyManifest,
      documents: [
        {
          fileName: "doc-annual-primary.bin",
          metadata: {
            version: 1,
            targetLabel: "AAPL",
            category: "annual_report",
            sourceType: "issuer_primary",
          },
        },
        {
          fileName: "doc-presentation-primary.bin",
          metadata: {
            version: 1,
            targetLabel: "AAPL",
            category: "investor_presentation",
            sourceType: "company_presentation",
          },
        },
      ],
    });
    await prepareSnapshotState({
      workspaceDir: tempDir,
      manifest: brokenManifest,
      documents: [
        {
          fileName: "doc-annual-msft.bin",
          metadata: {
            version: 1,
            targetLabel: "MSFT",
            category: "annual_report",
            sourceType: "issuer_primary",
          },
        },
      ],
    });

    await fs.writeFile(
      path.join(tempDir, "bank", "fundamental", "readiness", `${brokenManifest.manifestId}.json`),
      '{"broken": true',
      "utf-8",
    );

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(tempDir),
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const snapshotsDir = path.join(tempDir, "bank", "fundamental", "snapshots");
    const snapshotFiles = await fs.readdir(snapshotsDir);
    expect(snapshotFiles).toEqual([`${healthyManifest.manifestId}.json`]);

    const artifactErrorsDir = path.join(tempDir, "bank", "fundamental", "artifact-errors");
    const artifactError = JSON.parse(
      await fs.readFile(
        path.join(artifactErrorsDir, `snapshot-${brokenManifest.manifestId}.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(artifactError.errorStatus).toBe("blocked_due_to_artifact_error");
    expect(artifactError.manifestId).toBe(brokenManifest.manifestId);

    const memoryDir = path.join(tempDir, "memory");
    const memoryFiles = await fs.readdir(memoryDir);
    expect(
      memoryFiles.some((name) =>
        name.includes(`fundamental-artifact-error-snapshot-${brokenManifest.manifestId}`),
      ),
    ).toBe(true);
  });
});
