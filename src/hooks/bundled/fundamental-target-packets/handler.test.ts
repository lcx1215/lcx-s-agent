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
import { buildFundamentalReviewBrief } from "../fundamental-review-brief/handler.js";
import { buildFundamentalReviewPlan } from "../fundamental-review-plan/handler.js";
import { buildFundamentalReviewQueue } from "../fundamental-review-queue/handler.js";
import { buildFundamentalReviewWorkbench } from "../fundamental-review-workbench/handler.js";
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

async function prepareReviewWorkbenchArtifact(params: {
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
  const workbench = buildFundamentalReviewWorkbench({
    nowIso,
    reviewPlanPath: `bank/fundamental/review-plans/${params.manifest.manifestId}.json`,
    reviewBriefPath: `bank/fundamental/review-briefs/${params.manifest.manifestId}.json`,
    reviewQueuePath: `bank/fundamental/review-queues/${params.manifest.manifestId}.json`,
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    reviewPlan,
  });

  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  const scoringGatesDir = path.join(params.workspaceDir, "bank", "fundamental", "scoring-gates");
  const handoffsDir = path.join(params.workspaceDir, "bank", "fundamental", "risk-handoffs");
  const queuesDir = path.join(params.workspaceDir, "bank", "fundamental", "review-queues");
  const briefsDir = path.join(params.workspaceDir, "bank", "fundamental", "review-briefs");
  const plansDir = path.join(params.workspaceDir, "bank", "fundamental", "review-plans");
  const workbenchesDir = path.join(
    params.workspaceDir,
    "bank",
    "fundamental",
    "review-workbenches",
  );
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(scoringGatesDir, { recursive: true });
  await fs.mkdir(handoffsDir, { recursive: true });
  await fs.mkdir(queuesDir, { recursive: true });
  await fs.mkdir(briefsDir, { recursive: true });
  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(workbenchesDir, { recursive: true });
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
  await fs.writeFile(
    path.join(workbenchesDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(workbench, null, 2)}\n`,
    "utf-8",
  );
}

async function runTargetPackets(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  targetPackets: Record<string, unknown>;
  noteContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareReviewWorkbenchArtifact({
    workspaceDir: tempDir,
    manifest: params.manifest,
    documents: params.documents,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
  });
  event.timestamp = new Date("2026-03-15T12:00:00.000Z");

  await handler(event);

  const packetsDir = path.join(tempDir, "bank", "fundamental", "target-packets");
  const packetFiles = await fs.readdir(packetsDir);
  const memoryDir = path.join(tempDir, "memory");
  const memoryFiles = await fs.readdir(memoryDir);

  return {
    targetPackets: JSON.parse(
      await fs.readFile(path.join(packetsDir, packetFiles[0]), "utf-8"),
    ) as Record<string, unknown>,
    noteContent: await fs.readFile(
      path.join(
        memoryDir,
        memoryFiles.find((name) => name.includes("fundamental-target-packets-")) ?? memoryFiles[0],
      ),
      "utf-8",
    ),
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-target-packets-"),
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

describe("fundamental-target-packets hook", () => {
  it("keeps blocked targets in blocked hold packets", async () => {
    const manifest = createManifestFixture();
    const result = await runTargetPackets({ manifest });

    expect(result.targetPackets.packetStatus).toBe("blocked");
    expect(result.targetPackets.deeperReviewDossiers).toEqual([]);
    expect(result.targetPackets.followUpCollectionPackets).toEqual([]);
    expect(result.targetPackets.blockedHoldPackets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        requestedMaterials: ["annual_report", "investor_presentation"],
        nextReviewGateChecks: [
          "Resolve human collection approval for AAPL.",
          "Confirm AAPL has annual report locally.",
          "Confirm AAPL has investor presentation locally.",
        ],
      }),
    ]);
    expect(result.targetPackets.nextStepSummary).toEqual([
      "Keep AAPL on hold until its unblock conditions clear.",
    ]);
    expect(result.noteContent).toContain("packet_status: blocked");
  });

  it("turns metadata follow-up into collection packets", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runTargetPackets({
      manifest,
      documents: [
        { fileName: "aapl-annual-report.pdf" },
        { fileName: "aapl-investor-presentation.pdf" },
        { fileName: "aapl-research-report.pdf" },
      ],
    });

    expect(result.targetPackets.packetStatus).toBe("collection");
    expect(result.targetPackets.deeperReviewDossiers).toEqual([]);
    expect(result.targetPackets.followUpCollectionPackets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        packetFocus: "metadata_repair",
        requestedMaterials: ["document_metadata_sidecar"],
        collectionSequence: ["Collect or repair .meta.json metadata sidecars first."],
        metadataChecklist: expect.arrayContaining([
          "Backfill sidecars for all currently present local files first.",
        ]),
      }),
    ]);
    expect(result.targetPackets.nextStepSummary).toEqual([
      "Run a collection packet for AAPL: .meta.json metadata sidecars.",
    ]);
    expect(result.noteContent).toContain("packet_status: collection");
  });

  it("turns ready workbenches into dossier-ready packets", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runTargetPackets({
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

    expect(result.targetPackets.packetStatus).toBe("dossier_ready");
    expect(result.targetPackets.followUpCollectionPackets).toEqual([]);
    expect(result.targetPackets.blockedHoldPackets).toEqual([]);
    expect(result.targetPackets.deeperReviewDossiers).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        dossierTitle: "AAPL deeper review dossier",
        evidenceReadinessLevel: "baseline_ready",
        thesisTemplate: expect.arrayContaining([
          "Fill section: Annual report disclosures and segment mix.",
        ]),
        citationTasks: expect.arrayContaining([
          "Cite at least one local document path for AAPL in each major section.",
        ]),
      }),
    ]);
    expect(result.targetPackets.nextStepSummary).toEqual([
      "Start drafting AAPL deeper review dossier.",
    ]);
    expect(result.noteContent).toContain("packet_status: dossier_ready");
  });
});
