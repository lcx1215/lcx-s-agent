import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import { writeFundamentalArtifactErrors } from "../fundamental-artifact-errors.js";
import {
  summarizeFundamentalIntakeSession,
  type FundamentalArtifactErrorStatus,
  type FundamentalDocumentMetadata,
  type FundamentalManifestScaffold,
  type FundamentalReviewGateStatus,
} from "../fundamental-intake/handler.js";
import { bridgeManifest } from "../fundamental-manifest-bridge/handler.js";
import {
  buildFundamentalReviewChainJsonPath,
  buildFundamentalReviewChainNoteFilename,
} from "../lobster-brain-registry.js";
import { buildFundamentalReviewQueue } from "../fundamental-review-queue/handler.js";
import { buildFundamentalRiskHandoff } from "../fundamental-risk-handoff/handler.js";
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

async function prepareReviewQueueArtifact(params: {
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
  const riskHandoff = buildFundamentalRiskHandoff({
    nowIso: "2026-03-15T12:00:00.000Z",
    scoringGatePath: `bank/fundamental/scoring-gates/${params.manifest.manifestId}.json`,
    manifestRiskHandoffStatus: bridged.manifest.riskHandoff.status,
    scoringGate,
  });
  const reviewQueue = buildFundamentalReviewQueue({
    nowIso: "2026-03-15T12:00:00.000Z",
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    handoff: riskHandoff,
  });

  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  const scoringGatesDir = path.join(params.workspaceDir, "bank", "fundamental", "scoring-gates");
  const handoffsDir = path.join(params.workspaceDir, "bank", "fundamental", "risk-handoffs");
  const queuesDir = path.join(params.workspaceDir, "bank", "fundamental", "review-queues");
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(scoringGatesDir, { recursive: true });
  await fs.mkdir(handoffsDir, { recursive: true });
  await fs.mkdir(queuesDir, { recursive: true });
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
  await fs.writeFile(
    path.join(handoffsDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(riskHandoff, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(queuesDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(reviewQueue, null, 2)}\n`,
    "utf-8",
  );
}

async function runReviewBrief(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  reviewBrief: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareReviewQueueArtifact({
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
  const reviewBriefPath = buildFundamentalReviewChainJsonPath(
    "fundamental-review-brief",
    params.manifest.manifestId,
  );
  const notePath = buildFundamentalReviewChainNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-review-brief",
    manifestId: params.manifest.manifestId,
  });

  return {
    reviewBrief: JSON.parse(
      await fs.readFile(path.join(tempDir, reviewBriefPath), "utf-8"),
    ) as Record<string, unknown>,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
  };
}

async function writeArtifactError(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  nowIso: string;
  stage?: string;
  errorStatus?: FundamentalArtifactErrorStatus;
}): Promise<void> {
  await fs.mkdir(path.join(params.workspaceDir, "memory"), { recursive: true });
  await writeFundamentalArtifactErrors({
    workspaceDir: params.workspaceDir,
    memoryDir: path.join(params.workspaceDir, "memory"),
    nowIso: params.nowIso,
    errors: [
      {
        stage: params.stage ?? "snapshot",
        relativePath: `bank/fundamental/${params.stage ?? "snapshot"}/${params.manifest.manifestId}.json`,
        fileName: `${params.manifest.manifestId}.json`,
        manifestId: params.manifest.manifestId,
        errorStatus: params.errorStatus ?? "blocked_due_to_artifact_error",
        errorMessage: "Unexpected end of JSON input",
      },
    ],
  });
}

async function runReviewBriefWithArtifactScenario(params: {
  manifest: FundamentalManifestScaffold;
  artifactErrorAt: string;
  prepareQueue?: boolean;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  reviewBrief: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace("artifact-error");
  if (params.prepareQueue) {
    await prepareReviewQueueArtifact({
      workspaceDir: tempDir,
      manifest: params.manifest,
      documents: params.documents,
    });
  } else {
    const manifestsDir = path.join(tempDir, "bank", "fundamental", "manifests");
    await fs.mkdir(manifestsDir, { recursive: true });
    await fs.writeFile(
      path.join(manifestsDir, `2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`),
      `${JSON.stringify(params.manifest, null, 2)}\n`,
      "utf-8",
    );
  }
  await writeArtifactError({
    workspaceDir: tempDir,
    manifest: params.manifest,
    nowIso: params.artifactErrorAt,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
  });
  event.timestamp = new Date("2026-03-15T13:00:00.000Z");

  await handler(event);

  const memoryDir = path.join(tempDir, "memory");
  const reviewBriefPath = buildFundamentalReviewChainJsonPath(
    "fundamental-review-brief",
    params.manifest.manifestId,
  );
  const notePath = buildFundamentalReviewChainNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-review-brief",
    manifestId: params.manifest.manifestId,
  });

  return {
    reviewBrief: JSON.parse(
      await fs.readFile(path.join(tempDir, reviewBriefPath), "utf-8"),
    ) as Record<string, unknown>,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-review-brief-"),
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

describe("fundamental-review-brief hook", () => {
  it("keeps blocked targets in a blocked brief", async () => {
    const manifest = createManifestFixture();
    const result = await runReviewBrief({ manifest });

    expect(result.reviewBrief.briefStatus).toBe("blocked");
    expect(result.reviewBrief.deeperReviewTargets).toEqual([]);
    expect(result.reviewBrief.followUpTargets).toEqual([]);
    expect(result.reviewBrief.blockedTargets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        queueAction: "blocked",
        requestedMaterials: ["annual_report", "investor_presentation"],
      }),
    ]);
    expect(result.reviewBrief.reviewFocus).toEqual([
      "Keep AAPL blocked until review_gate_approval, document:annual_report, document:investor_presentation is cleared.",
    ]);
    expect(result.noteContent).toContain("brief_status: blocked");
  });

  it("turns partial review queues into follow-up briefs", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runReviewBrief({
      manifest,
      documents: [
        { fileName: "aapl-annual-report.pdf" },
        { fileName: "aapl-investor-presentation.pdf" },
        { fileName: "aapl-research-report.pdf" },
      ],
    });

    expect(result.reviewBrief.briefStatus).toBe("follow_up");
    expect(result.reviewBrief.deeperReviewTargets).toEqual([]);
    expect(result.reviewBrief.followUpTargets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        queueAction: "follow_up_missing_inputs",
        requestedMaterials: ["document_metadata_sidecar"],
        nextActions: ["add_metadata_sidecars"],
        evidenceReadinessLevel: "partial",
      }),
    ]);
    expect(result.reviewBrief.reviewFocus).toEqual([
      "Collect or repair document_metadata_sidecar for AAPL.",
    ]);
    expect(result.noteContent).toContain("brief_status: follow_up");
  });

  it("turns ready review queues into deeper review briefs", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runReviewBrief({
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

    expect(result.reviewBrief.briefStatus).toBe("ready_for_review");
    expect(result.reviewBrief.followUpTargets).toEqual([]);
    expect(result.reviewBrief.blockedTargets).toEqual([]);
    expect(result.reviewBrief.deeperReviewTargets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        queueAction: "deeper_review",
        reviewPriority: "high",
        availableDocumentCategories: ["annual_report", "investor_presentation"],
        presentSourceTypes: ["issuer_primary", "regulatory_filing", "company_presentation"],
        evidenceReadinessLevel: "baseline_ready",
      }),
    ]);
    expect(result.reviewBrief.reviewFocus).toEqual(["Start deeper review for AAPL."]);
    expect(result.noteContent).toContain("brief_status: ready_for_review");
  });

  it("materializes an explicit blocked brief when upstream artifact errors are newer than recovery", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runReviewBriefWithArtifactScenario({
      manifest,
      prepareQueue: true,
      artifactErrorAt: "2026-03-15T13:00:00.000Z",
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

    expect(result.reviewBrief.briefStatus).toBe("blocked");
    expect(result.reviewBrief.deeperReviewTargets).toEqual([]);
    expect(result.reviewBrief.followUpTargets).toEqual([]);
    expect(result.reviewBrief.blockedTargets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        queueAction: "blocked",
        missingCriticalInputs: ["artifact_error"],
      }),
    ]);
    expect(result.noteContent).toContain("brief_status: blocked");
  });

  it("clears artifact blocking when a newer valid review queue exists for the same manifest", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runReviewBriefWithArtifactScenario({
      manifest,
      prepareQueue: true,
      artifactErrorAt: "2026-03-15T11:00:00.000Z",
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

    expect(result.reviewBrief.briefStatus).toBe("ready_for_review");
    expect(result.reviewBrief.blockedTargets).toEqual([]);
    expect(result.reviewBrief.deeperReviewTargets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        queueAction: "deeper_review",
      }),
    ]);
    expect(result.noteContent).toContain("brief_status: ready_for_review");
  });
});
