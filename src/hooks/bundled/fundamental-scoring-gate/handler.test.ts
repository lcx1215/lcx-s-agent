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
import { bridgeManifest } from "../fundamental-manifest-bridge/handler.js";
import { buildSnapshotInput } from "../fundamental-snapshot-bridge/handler.js";
import { buildFundamentalSnapshot } from "../fundamental-snapshot/handler.js";

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

async function prepareSnapshotArtifact(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<void> {
  for (const document of params.documents ?? []) {
    await writeTargetDocument({
      workspaceDir: params.workspaceDir,
      manifest: params.manifest,
      fileName: document.fileName,
      metadata: document.metadata,
    });
  }

  const manifestPath = `bank/fundamental/manifests/2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`;
  const bridged = await bridgeManifest({
    workspaceDir: params.workspaceDir,
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath,
    manifest: params.manifest,
  });
  const snapshotInput = buildSnapshotInput({
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
  });
  const snapshot = buildFundamentalSnapshot({
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    snapshotInputPath: `bank/fundamental/snapshot-inputs/${params.manifest.manifestId}.json`,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
    snapshotInput,
  });

  const snapshotsDir = path.join(params.workspaceDir, "bank", "fundamental", "snapshots");
  await fs.mkdir(snapshotsDir, { recursive: true });
  await fs.writeFile(
    path.join(snapshotsDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf-8",
  );
}

async function runScoringGate(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  scoringGate: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareSnapshotArtifact({
    workspaceDir: tempDir,
    manifest: params.manifest,
    documents: params.documents,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
  });
  event.timestamp = new Date("2026-03-15T12:00:00.000Z");

  await handler(event);

  const scoringGatesDir = path.join(tempDir, "bank", "fundamental", "scoring-gates");
  const scoringGateFiles = await fs.readdir(scoringGatesDir);
  const memoryDir = path.join(tempDir, "memory");
  const memoryFiles = await fs.readdir(memoryDir);

  return {
    scoringGate: JSON.parse(
      await fs.readFile(path.join(scoringGatesDir, scoringGateFiles[0]), "utf-8"),
    ) as Record<string, unknown>,
    noteContent: await fs.readFile(
      path.join(
        memoryDir,
        memoryFiles.find((name) => name.includes("fundamental-scoring-gate-")) ?? memoryFiles[0],
      ),
      "utf-8",
    ),
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-scoring-gate-"),
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

describe("fundamental-scoring-gate hook", () => {
  it("keeps targets blocked when the snapshot is still blocked", async () => {
    const manifest = createManifestFixture();
    const result = await runScoringGate({ manifest });

    expect(result.scoringGate.scoringDecision).toBe("blocked");
    expect(result.scoringGate.gateSummary).toEqual({
      totalTargets: 1,
      allowedTargets: 0,
      partialTargets: 0,
      blockedTargets: 1,
      fallbackExposedTargets: 0,
      metadataOnlyTargets: 0,
    });
    expect(result.scoringGate.targetDecisions).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        scoringDecision: "blocked",
        allowedForScoring: false,
        evidenceReadinessLevel: "insufficient",
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
        documentPaths: [],
        notes: [
          "Review gate is still pending human approval.",
          "Required categories still missing: annual_report, investor_presentation.",
          "Target remains blocked from scoring.",
        ],
      },
    ]);
    expect(result.noteContent).toContain("scoring_decision: blocked");
    expect(result.noteContent).toContain("AAPL: decision=blocked");
  });

  it("allows scoring when the snapshot reached baseline-ready inputs", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runScoringGate({
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

    expect(result.scoringGate.scoringDecision).toBe("allowed");
    expect(result.scoringGate.gateSummary).toEqual({
      totalTargets: 1,
      allowedTargets: 1,
      partialTargets: 0,
      blockedTargets: 0,
      fallbackExposedTargets: 0,
      metadataOnlyTargets: 1,
    });
    expect(result.scoringGate.targetDecisions).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        scoringDecision: "allowed",
        allowedForScoring: true,
        evidenceReadinessLevel: "baseline_ready",
        availableDocumentCategories: ["annual_report", "investor_presentation"],
        sourceCoverage: {
          requiredSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          presentSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
          missingPreferredSourceTypes: [],
        },
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
        documentPaths: [
          `bank/fundamental/documents/${manifest.manifestId}/aapl/doc-annual-primary.bin`,
          `bank/fundamental/documents/${manifest.manifestId}/aapl/doc-annual-regulatory.bin`,
          `bank/fundamental/documents/${manifest.manifestId}/aapl/doc-presentation.bin`,
        ],
        notes: ["Target has baseline-ready local inputs for controlled scoring entry."],
      },
    ]);
    expect(result.noteContent).toContain("scoring_decision: allowed");
    expect(result.noteContent).toContain("AAPL: decision=allowed, readiness=baseline_ready");
  });
});
