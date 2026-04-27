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
import { buildFundamentalReviewBrief } from "../fundamental-review-brief/handler.js";
import { buildFundamentalReviewPlan } from "../fundamental-review-plan/handler.js";
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

async function prepareReviewPlanArtifact(params: {
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

  const nowIso = "2026-03-15T12:00:00.000Z";
  const manifestPath = `bank/fundamental/manifests/2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`;
  const bridged = await bridgeManifest({
    workspaceDir: params.workspaceDir,
    nowIso,
    manifestPath,
    manifest: params.manifest,
  });
  const snapshotInput = buildSnapshotInput({
    nowIso,
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
  });
  const snapshot = buildFundamentalSnapshot({
    nowIso,
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    snapshotInputPath: `bank/fundamental/snapshot-inputs/${params.manifest.manifestId}.json`,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
    snapshotInput,
  });
  const scoringGate = buildFundamentalScoringGate({
    nowIso,
    snapshotPath: `bank/fundamental/snapshots/${params.manifest.manifestId}.json`,
    snapshot,
  });
  const riskHandoff = buildFundamentalRiskHandoff({
    nowIso,
    scoringGatePath: `bank/fundamental/scoring-gates/${params.manifest.manifestId}.json`,
    manifestRiskHandoffStatus: bridged.manifest.riskHandoff.status,
    scoringGate,
  });
  const reviewQueue = buildFundamentalReviewQueue({
    nowIso,
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    handoff: riskHandoff,
  });
  const reviewBrief = buildFundamentalReviewBrief({
    nowIso,
    reviewQueuePath: `bank/fundamental/review-queues/${params.manifest.manifestId}.json`,
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    reviewQueue,
    handoff: riskHandoff,
  });
  const reviewPlan = buildFundamentalReviewPlan({
    nowIso,
    reviewBriefPath: `bank/fundamental/review-briefs/${params.manifest.manifestId}.json`,
    reviewQueuePath: `bank/fundamental/review-queues/${params.manifest.manifestId}.json`,
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    reviewBrief,
  });

  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  const scoringGatesDir = path.join(params.workspaceDir, "bank", "fundamental", "scoring-gates");
  const handoffsDir = path.join(params.workspaceDir, "bank", "fundamental", "risk-handoffs");
  const queuesDir = path.join(params.workspaceDir, "bank", "fundamental", "review-queues");
  const briefsDir = path.join(params.workspaceDir, "bank", "fundamental", "review-briefs");
  const plansDir = path.join(params.workspaceDir, "bank", "fundamental", "review-plans");
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(scoringGatesDir, { recursive: true });
  await fs.mkdir(handoffsDir, { recursive: true });
  await fs.mkdir(queuesDir, { recursive: true });
  await fs.mkdir(briefsDir, { recursive: true });
  await fs.mkdir(plansDir, { recursive: true });
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
  await fs.writeFile(
    path.join(briefsDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(reviewBrief, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(plansDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(reviewPlan, null, 2)}\n`,
    "utf-8",
  );
}

async function runReviewWorkbench(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  reviewWorkbench: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareReviewPlanArtifact({
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
  const workbenchPath = buildFundamentalReviewChainJsonPath(
    "fundamental-review-workbench",
    params.manifest.manifestId,
  );
  const notePath = buildFundamentalReviewChainNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-review-workbench",
    manifestId: params.manifest.manifestId,
  });

  return {
    reviewWorkbench: JSON.parse(
      await fs.readFile(path.join(tempDir, workbenchPath), "utf-8"),
    ) as Record<string, unknown>,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
  };
}

async function writeArtifactError(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  generatedAt: string;
  stage?: string;
  errorStatus?: FundamentalArtifactErrorStatus;
}): Promise<void> {
  await fs.mkdir(path.join(params.workspaceDir, "memory"), { recursive: true });
  await writeFundamentalArtifactErrors({
    workspaceDir: params.workspaceDir,
    memoryDir: path.join(params.workspaceDir, "memory"),
    nowIso: params.generatedAt,
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

async function runReviewWorkbenchWithArtifactScenario(params: {
  manifest: FundamentalManifestScaffold;
  artifactErrorGeneratedAt: string;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
  recoveryManifest?: FundamentalManifestScaffold;
  recoveryDocuments?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  reviewWorkbench: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace("artifact-error");
  await prepareReviewPlanArtifact({
    workspaceDir: tempDir,
    manifest: params.manifest,
    documents: params.documents,
  });
  if (params.recoveryManifest) {
    await prepareReviewPlanArtifact({
      workspaceDir: tempDir,
      manifest: params.recoveryManifest,
      documents: params.recoveryDocuments ?? params.documents,
    });
  }
  await writeArtifactError({
    workspaceDir: tempDir,
    manifest: params.manifest,
    generatedAt: params.artifactErrorGeneratedAt,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
  });
  event.timestamp = new Date("2026-03-15T13:00:00.000Z");

  await handler(event);

  const workbenchPath = path.join(
    tempDir,
    buildFundamentalReviewChainJsonPath("fundamental-review-workbench", params.manifest.manifestId),
  );
  const memoryDir = path.join(tempDir, "memory");
  const notePath = buildFundamentalReviewChainNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-review-workbench",
    manifestId: params.manifest.manifestId,
  });

  return {
    reviewWorkbench: JSON.parse(await fs.readFile(workbenchPath, "utf-8")) as Record<
      string,
      unknown
    >,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-review-workbench-"),
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

describe("fundamental-review-workbench hook", () => {
  it("keeps blocked targets in blocked monitoring checklists", async () => {
    const manifest = createManifestFixture();
    const result = await runReviewWorkbench({ manifest });

    expect(result.reviewWorkbench.workbenchStatus).toBe("blocked");
    expect(result.reviewWorkbench.deeperReviewScaffolds).toEqual([]);
    expect(result.reviewWorkbench.followUpCollectionPlans).toEqual([]);
    expect(result.reviewWorkbench.blockedMonitoringChecklists).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        requestedMaterials: ["annual_report", "investor_presentation"],
        nextCheckpoints: [
          "Resolve human collection approval for AAPL.",
          "Confirm AAPL has annual report locally.",
          "Confirm AAPL has investor presentation locally.",
        ],
      }),
    ]);
    expect(result.reviewWorkbench.nextStepSummary).toEqual([
      "Keep AAPL blocked and monitor its unblock conditions.",
    ]);
    expect(result.noteContent).toContain("workbench_status: blocked");
  });

  it("turns metadata follow-up into follow-up collection work packets", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runReviewWorkbench({
      manifest,
      documents: [
        { fileName: "aapl-annual-report.pdf" },
        { fileName: "aapl-investor-presentation.pdf" },
        { fileName: "aapl-research-report.pdf" },
      ],
    });

    expect(result.reviewWorkbench.workbenchStatus).toBe("collection");
    expect(result.reviewWorkbench.deeperReviewScaffolds).toEqual([]);
    expect(result.reviewWorkbench.followUpCollectionPlans).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        requestedMaterials: ["document_metadata_sidecar"],
        collectionOrder: ["Collect or repair .meta.json metadata sidecars first."],
        metadataTasks: ["Add .meta.json sidecars for AAPL documents."],
        unblockConditions: ["Resolve .meta.json metadata sidecars for AAPL."],
      }),
    ]);
    expect(result.reviewWorkbench.nextStepSummary).toEqual([
      "Collect or repair .meta.json metadata sidecars for AAPL.",
    ]);
    expect(result.noteContent).toContain("workbench_status: collection");
  });

  it("turns ready review plans into deeper-review scaffolds", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runReviewWorkbench({
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

    expect(result.reviewWorkbench.workbenchStatus).toBe("deeper_review");
    expect(result.reviewWorkbench.followUpCollectionPlans).toEqual([]);
    expect(result.reviewWorkbench.blockedMonitoringChecklists).toEqual([]);
    expect(result.reviewWorkbench.deeperReviewScaffolds).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        evidenceReadinessLevel: "baseline_ready",
        readingOrder: [
          "Review annual report evidence first.",
          "Review investor presentation evidence first.",
        ],
        immediateTasks: ["Open a deeper-review workstream for AAPL."],
      }),
    ]);
    expect(result.reviewWorkbench.nextStepSummary).toEqual([
      "Open a deeper-review packet for AAPL.",
    ]);
    expect(result.noteContent).toContain("workbench_status: deeper_review");
  });

  it("materializes an explicit blocked workbench when upstream artifact errors are newer than recovery", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const documents = [
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
    ] satisfies Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
    const result = await runReviewWorkbenchWithArtifactScenario({
      manifest,
      artifactErrorGeneratedAt: "2026-03-15T13:00:00.000Z",
      documents,
    });

    expect(result.reviewWorkbench.workbenchStatus).toBe("blocked");
    expect(result.reviewWorkbench.deeperReviewScaffolds).toEqual([]);
    expect(result.reviewWorkbench.followUpCollectionPlans).toEqual([]);
    expect(result.reviewWorkbench.blockedMonitoringChecklists).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        requestedMaterials: [],
      }),
    ]);
    expect(result.noteContent).toContain("workbench_status: blocked");
  });

  it("clears artifact blocking when a newer valid review plan exists for the same manifest", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const documents = [
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
    ] satisfies Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
    const result = await runReviewWorkbenchWithArtifactScenario({
      manifest,
      artifactErrorGeneratedAt: "2026-03-15T11:00:00.000Z",
      documents,
    });

    expect(result.reviewWorkbench.workbenchStatus).toBe("deeper_review");
    expect(result.reviewWorkbench.blockedMonitoringChecklists).toEqual([]);
    expect(result.reviewWorkbench.deeperReviewScaffolds).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        evidenceReadinessLevel: "baseline_ready",
      }),
    ]);
  });

  it("does not clear artifact blocking when recovery has the same generatedAt timestamp", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const documents = [
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
    ] satisfies Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
    const result = await runReviewWorkbenchWithArtifactScenario({
      manifest,
      artifactErrorGeneratedAt: "2026-03-15T12:00:00.000Z",
      documents,
    });

    expect(result.reviewWorkbench.workbenchStatus).toBe("blocked");
    expect(result.reviewWorkbench.deeperReviewScaffolds).toEqual([]);
    expect(result.reviewWorkbench.blockedMonitoringChecklists).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
      }),
    ]);
  });

  it("does not allow cross-manifest recovery to clear blocking", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const recoveryManifest = {
      ...createManifestFixture({
        reviewGateStatus: "approved_for_collection",
        requestText:
          "Build a fundamental research scaffold for MSFT in the US. Use annual reports and investor presentations.",
      }),
      manifestId: "msft-cross-manifest-recovery",
    };
    const aaplDocuments = [
      {
        fileName: "aapl-annual-primary.bin",
        metadata: {
          version: 1,
          targetLabel: "AAPL",
          category: "annual_report",
          sourceType: "issuer_primary",
        },
      },
      {
        fileName: "aapl-presentation.bin",
        metadata: {
          version: 1,
          targetLabel: "AAPL",
          category: "investor_presentation",
          sourceType: "company_presentation",
        },
      },
    ] satisfies Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
    const msftDocuments = [
      {
        fileName: "msft-annual-primary.bin",
        metadata: {
          version: 1,
          targetLabel: "MSFT",
          category: "annual_report",
          sourceType: "issuer_primary",
        },
      },
      {
        fileName: "msft-presentation.bin",
        metadata: {
          version: 1,
          targetLabel: "MSFT",
          category: "investor_presentation",
          sourceType: "company_presentation",
        },
      },
    ] satisfies Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
    const result = await runReviewWorkbenchWithArtifactScenario({
      manifest,
      artifactErrorGeneratedAt: "2026-03-15T13:00:00.000Z",
      documents: aaplDocuments,
      recoveryManifest,
      recoveryDocuments: msftDocuments,
    });

    expect(result.reviewWorkbench.workbenchStatus).toBe("blocked");
    expect(result.reviewWorkbench.deeperReviewScaffolds).toEqual([]);
    expect(result.reviewWorkbench.blockedMonitoringChecklists).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
      }),
    ]);
  });
});
