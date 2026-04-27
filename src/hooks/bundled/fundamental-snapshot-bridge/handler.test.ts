import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import {
  summarizeFundamentalIntakeSession,
  type FundamentalManifestScaffold,
  type FundamentalReviewGateStatus,
} from "../fundamental-intake/handler.js";
import {
  bridgeManifest,
  type FundamentalManifestReadiness,
} from "../fundamental-manifest-bridge/handler.js";
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

async function writeManifestAndReadiness(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  readiness: FundamentalManifestReadiness;
}): Promise<void> {
  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  const readinessDir = path.join(params.workspaceDir, "bank", "fundamental", "readiness");
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(readinessDir, { recursive: true });
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
}

async function writeTargetDocument(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  targetLabel?: string;
  fileName: string;
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
  await fs.writeFile(path.join(absoluteTargetDir, params.fileName), "fixture", "utf-8");
}

async function prepareManifestState(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  documents?: string[];
}): Promise<void> {
  for (const fileName of params.documents ?? []) {
    await writeTargetDocument({
      workspaceDir: params.workspaceDir,
      manifest: params.manifest,
      fileName,
    });
  }
  const bridged = await bridgeManifest({
    workspaceDir: params.workspaceDir,
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath: `bank/fundamental/manifests/2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`,
    manifest: params.manifest,
  });
  await writeManifestAndReadiness({
    workspaceDir: params.workspaceDir,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
  });
}

async function runSnapshotBridge(params: {
  manifest: FundamentalManifestScaffold;
  documents?: string[];
}): Promise<{
  snapshotInput: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareManifestState({
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
  const snapshotInputPath = buildFundamentalArtifactJsonPath(
    "fundamental-snapshot-bridge",
    params.manifest.manifestId,
  );
  const notePath = buildFundamentalArtifactNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-snapshot-bridge",
    manifestId: params.manifest.manifestId,
  });

  return {
    snapshotInput: JSON.parse(
      await fs.readFile(path.join(tempDir, snapshotInputPath), "utf-8"),
    ) as Record<string, unknown>,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fundamental-snapshot-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("fundamental-snapshot-bridge hook", () => {
  it("keeps unresolved or unapproved targets blocked from snapshot entry", async () => {
    const manifest = createManifestFixture();
    const result = await runSnapshotBridge({ manifest });

    expect(result.snapshotInput.snapshotStatus).toBe("blocked");
    expect(result.snapshotInput.coverageSummary).toEqual({
      totalEntityTargets: 1,
      readyTargetCount: 0,
      blockedTargetCount: 1,
      requiredCategories: ["annual_report", "investor_presentation"],
    });
    expect(result.snapshotInput.readyTargets).toEqual([]);
    expect(result.snapshotInput.blockedTargets).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        blockerCodes: ["approval_not_ready", "missing_required_documents"],
        missingRequiredCategories: ["annual_report", "investor_presentation"],
        presentCategories: [],
        presentSourceTypes: [],
        sourceCoverage: {
          requiredSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          presentSourceTypes: [],
          missingPreferredSourceTypes: [
            "issuer_primary",
            "regulatory_filing",
            "company_presentation",
          ],
        },
        metadataConfidence: {
          classifiedByMetadata: 0,
          classifiedByFilename: 0,
          mode: "none",
        },
        notes: [
          "Review gate is still pending human approval.",
          "Required categories still missing: annual_report, investor_presentation.",
        ],
      },
    ]);
    expect(result.noteContent).toContain("snapshot_status: blocked");
    expect(result.noteContent).toContain("AAPL: approval_not_ready, missing_required_documents");
  });

  it("emits partial snapshot inputs when only some targets are snapshot-ready", async () => {
    const manifest = createManifestFixture({
      requestText:
        "Build a fundamental research scaffold for AAPL, MSFT in the US. Use annual reports, investor presentations, and research reports.",
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runSnapshotBridge({
      manifest,
      documents: [
        "aapl-annual-report.pdf",
        "aapl-investor-presentation.pdf",
        "aapl-research-report.pdf",
      ],
    });

    expect(result.snapshotInput.snapshotStatus).toBe("partial");
    expect(result.snapshotInput.readyTargets).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        assetType: "equity",
        issuerType: "public_company",
        requiredCategories: ["annual_report", "investor_presentation"],
        presentCategories: ["annual_report", "investor_presentation", "research_report"],
        presentSourceTypes: [],
        sourceCoverage: {
          requiredSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          presentSourceTypes: [],
          missingPreferredSourceTypes: [
            "issuer_primary",
            "regulatory_filing",
            "company_presentation",
          ],
        },
        metadataConfidence: {
          classifiedByMetadata: 0,
          classifiedByFilename: 3,
          mode: "filename_only",
        },
        documentPaths: [
          "bank/fundamental/documents/broad-fundamental-watchlist/aapl/aapl-annual-report.pdf",
          "bank/fundamental/documents/broad-fundamental-watchlist/aapl/aapl-investor-presentation.pdf",
          "bank/fundamental/documents/broad-fundamental-watchlist/aapl/aapl-research-report.pdf",
        ],
      },
    ]);
    expect(result.snapshotInput.blockedTargets).toEqual([
      {
        targetLabel: "MSFT",
        region: "us",
        blockerCodes: ["missing_required_documents"],
        missingRequiredCategories: ["annual_report", "investor_presentation"],
        presentCategories: [],
        presentSourceTypes: [],
        sourceCoverage: {
          requiredSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          presentSourceTypes: [],
          missingPreferredSourceTypes: [
            "issuer_primary",
            "regulatory_filing",
            "company_presentation",
          ],
        },
        metadataConfidence: {
          classifiedByMetadata: 0,
          classifiedByFilename: 0,
          mode: "none",
        },
        notes: ["Required categories still missing: annual_report, investor_presentation."],
      },
    ]);
    expect(result.noteContent).toContain("snapshot_status: partial");
    expect(result.noteContent).toContain("ready_targets: 1/2");
  });

  it("emits ready snapshot inputs only when all named targets satisfy minimum conditions", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runSnapshotBridge({
      manifest,
      documents: [
        "aapl-annual-report.pdf",
        "aapl-investor-presentation.pdf",
        "aapl-research-report.pdf",
      ],
    });

    expect(result.snapshotInput.snapshotStatus).toBe("ready");
    expect(result.snapshotInput.coverageSummary).toEqual({
      totalEntityTargets: 1,
      readyTargetCount: 1,
      blockedTargetCount: 0,
      requiredCategories: ["annual_report", "investor_presentation"],
    });
    expect(result.snapshotInput.readyTargets).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        assetType: "equity",
        issuerType: "public_company",
        requiredCategories: ["annual_report", "investor_presentation"],
        presentCategories: ["annual_report", "investor_presentation", "research_report"],
        presentSourceTypes: [],
        sourceCoverage: {
          requiredSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          presentSourceTypes: [],
          missingPreferredSourceTypes: [
            "issuer_primary",
            "regulatory_filing",
            "company_presentation",
          ],
        },
        metadataConfidence: {
          classifiedByMetadata: 0,
          classifiedByFilename: 3,
          mode: "filename_only",
        },
        documentPaths: [
          "bank/fundamental/documents/broad-fundamental-watchlist/aapl/aapl-annual-report.pdf",
          "bank/fundamental/documents/broad-fundamental-watchlist/aapl/aapl-investor-presentation.pdf",
          "bank/fundamental/documents/broad-fundamental-watchlist/aapl/aapl-research-report.pdf",
        ],
      },
    ]);
    expect(result.snapshotInput.blockedTargets).toEqual([]);
    expect(result.noteContent).toContain("snapshot_status: ready");
    expect(result.noteContent).toContain(
      "AAPL: annual_report, investor_presentation, research_report",
    );
  });
});
