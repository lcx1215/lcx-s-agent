import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import {
  writeFundamentalArtifactErrors,
  type FundamentalArtifactErrorStatus,
} from "../fundamental-artifact-errors.js";
import {
  summarizeFundamentalIntakeSession,
  type FundamentalDocumentMetadata,
  type FundamentalManifestScaffold,
  type FundamentalReviewGateStatus,
} from "../fundamental-intake/handler.js";
import { bridgeManifest } from "../fundamental-manifest-bridge/handler.js";
import { buildFundamentalRiskHandoff } from "../fundamental-risk-handoff/handler.js";
import { buildFundamentalScoringGate } from "../fundamental-scoring-gate/handler.js";
import { buildSnapshotInput } from "../fundamental-snapshot-bridge/handler.js";
import { buildFundamentalSnapshot } from "../fundamental-snapshot/handler.js";
import {
  buildFundamentalReviewChainJsonPath,
  buildFundamentalReviewChainNoteFilename,
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

async function prepareRiskHandoffArtifact(params: {
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

  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  const scoringGatesDir = path.join(params.workspaceDir, "bank", "fundamental", "scoring-gates");
  const handoffsDir = path.join(params.workspaceDir, "bank", "fundamental", "risk-handoffs");
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(scoringGatesDir, { recursive: true });
  await fs.mkdir(handoffsDir, { recursive: true });
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
}

async function runReviewQueue(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  reviewQueue: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareRiskHandoffArtifact({
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
  const queuePath = buildFundamentalReviewChainJsonPath(
    "fundamental-review-queue",
    params.manifest.manifestId,
  );
  const notePath = buildFundamentalReviewChainNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-review-queue",
    manifestId: params.manifest.manifestId,
  });

  return {
    reviewQueue: JSON.parse(await fs.readFile(path.join(tempDir, queuePath), "utf-8")) as Record<
      string,
      unknown
    >,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
  };
}

async function runReviewQueueFromArtifactError(params: {
  manifest: FundamentalManifestScaffold;
  errorStage?: string;
  errorStatus?: FundamentalArtifactErrorStatus;
}): Promise<{
  reviewQueue: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace("artifact-error");
  const memoryDir = path.join(tempDir, "memory");
  const manifestsDir = path.join(tempDir, "bank", "fundamental", "manifests");
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestsDir, `2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`),
    `${JSON.stringify(params.manifest, null, 2)}\n`,
    "utf-8",
  );
  await writeFundamentalArtifactErrors({
    workspaceDir: tempDir,
    memoryDir,
    nowIso: "2026-03-15T12:00:00.000Z",
    errors: [
      {
        stage: params.errorStage ?? "snapshot",
        relativePath: `bank/fundamental/${params.errorStage ?? "snapshot"}/${params.manifest.manifestId}.json`,
        fileName: `${params.manifest.manifestId}.json`,
        manifestId: params.manifest.manifestId,
        errorStatus: params.errorStatus ?? "blocked_due_to_artifact_error",
        errorMessage: "Unexpected end of JSON input",
      },
    ],
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
  });
  event.timestamp = new Date("2026-03-15T13:00:00.000Z");

  await handler(event);

  const queuePath = buildFundamentalReviewChainJsonPath(
    "fundamental-review-queue",
    params.manifest.manifestId,
  );
  const notePath = buildFundamentalReviewChainNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-review-queue",
    manifestId: params.manifest.manifestId,
  });

  return {
    reviewQueue: JSON.parse(await fs.readFile(path.join(tempDir, queuePath), "utf-8")) as Record<
      string,
      unknown
    >,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-review-queue-"),
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

describe("fundamental-review-queue hook", () => {
  it("keeps blocked targets on the blocked list and missing-documents queue", async () => {
    const manifest = createManifestFixture();
    const result = await runReviewQueue({ manifest });

    expect(result.reviewQueue.queueStatus).toBe("blocked");
    expect(result.reviewQueue.watchlist).toEqual([]);
    expect(result.reviewQueue.blockedList).toEqual(["AAPL"]);
    expect(result.reviewQueue.summary).toEqual({
      totalTargets: 1,
      deeperReviewTargets: 0,
      followUpTargets: 0,
      blockedTargets: 1,
      watchlistTargets: 0,
      missingDocumentsQueueItems: 1,
    });
    expect(result.reviewQueue.missingDocumentsQueue).toEqual([
      {
        targetLabel: "AAPL",
        requestedMaterials: ["annual_report", "investor_presentation"],
      },
    ]);
    expect(result.reviewQueue.targets).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        handoffDecision: "blocked",
        queueAction: "blocked",
        reviewPriority: "low",
        watchlistCandidate: false,
        missingCriticalInputs: [
          "review_gate_approval",
          "document:annual_report",
          "document:investor_presentation",
        ],
        requestedMaterials: ["annual_report", "investor_presentation"],
        nextActions: ["resolve_review_gate_approval", "collect_missing_documents"],
        documentPaths: [],
        notes: [
          "Review gate is still pending human approval.",
          "Required categories still missing: annual_report, investor_presentation.",
          "Target remains blocked from scoring.",
          "Target remains blocked from downstream risk review.",
          "Target remains on the blocked list until approval or document blockers clear.",
        ],
      },
    ]);
    expect(result.noteContent).toContain("queue_status: blocked");
    expect(result.noteContent).toContain("AAPL: annual_report, investor_presentation");
  });

  it("keeps filename-only partial targets in the follow-up queue", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runReviewQueue({
      manifest,
      documents: [
        {
          fileName: "aapl-annual-report.pdf",
        },
        {
          fileName: "aapl-investor-presentation.pdf",
        },
        {
          fileName: "aapl-research-report.pdf",
        },
      ],
    });

    expect(result.reviewQueue.queueStatus).toBe("follow_up");
    expect(result.reviewQueue.watchlist).toEqual(["AAPL"]);
    expect(result.reviewQueue.blockedList).toEqual([]);
    expect(result.reviewQueue.followUpQueue).toEqual([
      {
        targetLabel: "AAPL",
        reviewPriority: "medium",
        requestedMaterials: ["document_metadata_sidecar"],
        nextActions: ["add_metadata_sidecars"],
      },
    ]);
    expect(result.reviewQueue.missingDocumentsQueue).toEqual([]);
    expect(result.reviewQueue.targets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        handoffDecision: "partial",
        queueAction: "follow_up_missing_inputs",
        reviewPriority: "medium",
        requestedMaterials: ["document_metadata_sidecar"],
        nextActions: ["add_metadata_sidecars"],
      }),
    ]);
    expect(result.noteContent).toContain("queue_status: follow_up");
    expect(result.noteContent).toContain("AAPL: priority=medium, action=follow_up_missing_inputs");
  });

  it("moves metadata-backed ready targets into deeper review", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runReviewQueue({
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

    expect(result.reviewQueue.queueStatus).toBe("deeper_review");
    expect(result.reviewQueue.watchlist).toEqual(["AAPL"]);
    expect(result.reviewQueue.blockedList).toEqual([]);
    expect(result.reviewQueue.followUpQueue).toEqual([]);
    expect(result.reviewQueue.missingDocumentsQueue).toEqual([]);
    expect(result.reviewQueue.reviewPriorityRanking).toEqual([
      {
        targetLabel: "AAPL",
        reviewPriority: "high",
        queueAction: "deeper_review",
      },
    ]);
    expect(result.reviewQueue.targets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        handoffDecision: "ready",
        queueAction: "deeper_review",
        reviewPriority: "high",
        watchlistCandidate: true,
        requestedMaterials: [],
        nextActions: ["start_deeper_review", "assemble_review_brief"],
      }),
    ]);
    expect(result.noteContent).toContain("queue_status: deeper_review");
    expect(result.noteContent).toContain("AAPL: priority=high, action=deeper_review");
  });

  it("materializes an explicit blocked queue when upstream artifact errors exist", async () => {
    const manifest = createManifestFixture();
    const result = await runReviewQueueFromArtifactError({ manifest });

    expect(result.reviewQueue.queueStatus).toBe("blocked");
    expect(result.reviewQueue.blockedList).toEqual(["AAPL"]);
    expect(result.reviewQueue.followUpQueue).toEqual([]);
    expect(result.reviewQueue.missingDocumentsQueue).toEqual([]);
    expect(result.reviewQueue.targets).toEqual([
      {
        targetLabel: "AAPL",
        region: "us",
        handoffDecision: "blocked",
        queueAction: "blocked",
        reviewPriority: "medium",
        watchlistCandidate: false,
        missingCriticalInputs: ["artifact_error"],
        requestedMaterials: [],
        nextActions: ["resolve_artifact_error"],
        documentPaths: [],
        notes: [
          "Target is blocked because upstream artifact parsing failed in stage(s): snapshot.",
          "Downstream review queue remains explicitly blocked until the artifact error is resolved.",
        ],
      },
    ]);
    expect(result.reviewQueue.notes).toContain(
      "This queue is explicitly blocked due to upstream artifact parsing failure.",
    );
    expect(result.noteContent).toContain("queue_status: blocked");
  });
});
