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
import { buildFundamentalScoringGate } from "../fundamental-scoring-gate/handler.js";
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

async function prepareScoringGateArtifact(params: {
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
  const scoringGate = buildFundamentalScoringGate({
    nowIso: "2026-03-15T12:00:00.000Z",
    snapshotPath: `bank/fundamental/snapshots/${params.manifest.manifestId}.json`,
    snapshot,
  });

  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  const scoringGatesDir = path.join(params.workspaceDir, "bank", "fundamental", "scoring-gates");
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(scoringGatesDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestsDir, `2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`),
    `${JSON.stringify(bridged.manifest, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(scoringGatesDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(scoringGate, null, 2)}\n`,
    "utf-8",
  );
}

async function runRiskHandoff(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  riskHandoff: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareScoringGateArtifact({
    workspaceDir: tempDir,
    manifest: params.manifest,
    documents: params.documents,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
  });
  event.timestamp = new Date("2026-03-15T12:00:00.000Z");

  await handler(event);

  const handoffDir = path.join(tempDir, "bank", "fundamental", "risk-handoffs");
  const handoffFiles = await fs.readdir(handoffDir);
  const memoryDir = path.join(tempDir, "memory");
  const memoryFiles = await fs.readdir(memoryDir);

  return {
    riskHandoff: JSON.parse(
      await fs.readFile(path.join(handoffDir, handoffFiles[0]), "utf-8"),
    ) as Record<string, unknown>,
    noteContent: await fs.readFile(
      path.join(
        memoryDir,
        memoryFiles.find((name) => name.includes("fundamental-risk-handoff-")) ?? memoryFiles[0],
      ),
      "utf-8",
    ),
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-risk-handoff-"),
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

describe("fundamental-risk-handoff hook", () => {
  it("keeps handoff blocked when scoring is still blocked", async () => {
    const manifest = createManifestFixture();
    const result = await runRiskHandoff({ manifest });

    expect(result.riskHandoff.handoffDecision).toBe("blocked");
    expect(result.riskHandoff.handoffReady).toBe(false);
    expect(result.riskHandoff.manifestRiskHandoffStatus).toBe("not_ready_for_risk_handoff");
    expect(result.riskHandoff.handoffSummary).toEqual({
      totalTargets: 1,
      readyTargets: 0,
      partialTargets: 0,
      blockedTargets: 1,
      fallbackExposedTargets: 0,
      metadataOnlyTargets: 0,
    });
    expect(result.riskHandoff.targetDecisions).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        handoffDecision: "blocked",
        allowedForRiskReview: false,
        scoringDecision: "blocked",
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
          "Target remains blocked from downstream risk review.",
        ],
      },
    ]);
    expect(result.noteContent).toContain("handoff_decision: blocked");
    expect(result.noteContent).toContain("AAPL: handoff=blocked, scoring=blocked");
  });

  it("marks handoff ready when scoring reached baseline-ready inputs", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runRiskHandoff({
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

    expect(result.riskHandoff.handoffDecision).toBe("ready");
    expect(result.riskHandoff.handoffReady).toBe(true);
    expect(result.riskHandoff.manifestRiskHandoffStatus).toBe("ready_for_fundamental_snapshot");
    expect(result.riskHandoff.handoffSummary).toEqual({
      totalTargets: 1,
      readyTargets: 1,
      partialTargets: 0,
      blockedTargets: 0,
      fallbackExposedTargets: 0,
      metadataOnlyTargets: 1,
    });
    expect(result.riskHandoff.targetDecisions).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        handoffDecision: "ready",
        allowedForRiskReview: true,
        scoringDecision: "allowed",
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
        notes: [
          "Target has baseline-ready local inputs for controlled scoring entry.",
          "Target may enter controlled downstream risk review.",
        ],
      },
    ]);
    expect(result.noteContent).toContain("handoff_decision: ready");
    expect(result.noteContent).toContain("AAPL: handoff=ready, scoring=allowed");
  });
});
