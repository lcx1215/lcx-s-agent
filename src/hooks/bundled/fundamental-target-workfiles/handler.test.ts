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
import {
  buildFundamentalArtifactJsonPath,
  buildFundamentalArtifactNoteFilename,
} from "../lobster-brain-registry.js";
import { buildFundamentalReviewBrief } from "../fundamental-review-brief/handler.js";
import { buildFundamentalReviewPlan } from "../fundamental-review-plan/handler.js";
import { buildFundamentalReviewQueue } from "../fundamental-review-queue/handler.js";
import { buildFundamentalReviewWorkbench } from "../fundamental-review-workbench/handler.js";
import { buildFundamentalRiskHandoff } from "../fundamental-risk-handoff/handler.js";
import { buildFundamentalScoringGate } from "../fundamental-scoring-gate/handler.js";
import { buildSnapshotInput } from "../fundamental-snapshot-bridge/handler.js";
import { buildFundamentalSnapshot } from "../fundamental-snapshot/handler.js";
import { buildFundamentalTargetPackets } from "../fundamental-target-packets/handler.js";

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

async function prepareTargetPacketsArtifact(params: {
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
  const targetPackets = buildFundamentalTargetPackets({
    nowIso,
    reviewWorkbenchPath: `bank/fundamental/review-workbenches/${params.manifest.manifestId}.json`,
    reviewPlanPath: `bank/fundamental/review-plans/${params.manifest.manifestId}.json`,
    reviewBriefPath: `bank/fundamental/review-briefs/${params.manifest.manifestId}.json`,
    reviewQueuePath: `bank/fundamental/review-queues/${params.manifest.manifestId}.json`,
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    workbench,
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
  const packetsDir = path.join(params.workspaceDir, "bank", "fundamental", "target-packets");
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(scoringGatesDir, { recursive: true });
  await fs.mkdir(handoffsDir, { recursive: true });
  await fs.mkdir(queuesDir, { recursive: true });
  await fs.mkdir(briefsDir, { recursive: true });
  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(workbenchesDir, { recursive: true });
  await fs.mkdir(packetsDir, { recursive: true });
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
  await fs.writeFile(
    path.join(packetsDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(targetPackets, null, 2)}\n`,
    "utf-8",
  );
}

async function runTargetWorkfiles(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
}): Promise<{
  targetWorkfiles: Record<string, unknown>;
  noteContent: string;
  workfiles: Record<string, string>;
}> {
  const tempDir = await createCaseWorkspace();
  await prepareTargetPacketsArtifact({
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
  const targetWorkfilesPath = buildFundamentalArtifactJsonPath(
    "fundamental-target-workfiles",
    params.manifest.manifestId,
  );
  const notePath = buildFundamentalArtifactNoteFilename({
    dateStr: "2026-03-15",
    stageName: "fundamental-target-workfiles",
    manifestId: params.manifest.manifestId,
  });

  const dossierPath = path.join(
    tempDir,
    "bank",
    "fundamental",
    "workfiles",
    params.manifest.manifestId,
    "dossiers",
    "aapl.md",
  );
  const collectionPath = path.join(
    tempDir,
    "bank",
    "fundamental",
    "workfiles",
    params.manifest.manifestId,
    "collection",
    "aapl.md",
  );
  const holdPath = path.join(
    tempDir,
    "bank",
    "fundamental",
    "workfiles",
    params.manifest.manifestId,
    "holds",
    "aapl.md",
  );

  const workfiles: Record<string, string> = {};
  for (const [key, filePath] of [
    ["dossier", dossierPath],
    ["collection", collectionPath],
    ["hold", holdPath],
  ] as const) {
    try {
      workfiles[key] = await fs.readFile(filePath, "utf-8");
    } catch {}
  }

  return {
    targetWorkfiles: JSON.parse(
      await fs.readFile(path.join(tempDir, targetWorkfilesPath), "utf-8"),
    ) as Record<string, unknown>,
    noteContent: await fs.readFile(path.join(memoryDir, notePath), "utf-8"),
    workfiles,
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-target-workfiles-"),
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

describe("fundamental-target-workfiles hook", () => {
  it("writes blocked hold workfiles", async () => {
    const manifest = createManifestFixture();
    const result = await runTargetWorkfiles({ manifest });

    expect(result.targetWorkfiles.status).toBe("blocked");
    expect(result.targetWorkfiles.dossierFiles).toEqual([]);
    expect(result.targetWorkfiles.collectionFiles).toEqual([]);
    expect(result.targetWorkfiles.holdFiles).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        kind: "hold",
        relativePath: `bank/fundamental/workfiles/${manifest.manifestId}/holds/aapl.md`,
      }),
    ]);
    expect(result.workfiles.hold).toContain("# AAPL Hold Packet");
    expect(result.workfiles.hold).toContain("## Unblock Conditions");
    expect(result.noteContent).toContain("status: blocked");
  });

  it("writes follow-up collection workfiles", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
    });
    const result = await runTargetWorkfiles({
      manifest,
      documents: [
        { fileName: "aapl-annual-report.pdf" },
        { fileName: "aapl-investor-presentation.pdf" },
        { fileName: "aapl-research-report.pdf" },
      ],
    });

    expect(result.targetWorkfiles.status).toBe("collection");
    expect(result.targetWorkfiles.collectionFiles).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        kind: "collection",
        relativePath: `bank/fundamental/workfiles/${manifest.manifestId}/collection/aapl.md`,
      }),
    ]);
    expect(result.workfiles.collection).toContain("# AAPL Collection Packet");
    expect(result.workfiles.collection).toContain("## Metadata Checklist");
    expect(result.workfiles.collection).toContain(
      "Add matching .meta.json sidecars whenever classification would otherwise rely on filename heuristics.",
    );
    expect(result.noteContent).toContain("status: collection");
  });

  it("writes dossier workfiles for dossier-ready targets", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const result = await runTargetWorkfiles({
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

    expect(result.targetWorkfiles.status).toBe("dossier_ready");
    expect(result.targetWorkfiles.dossierFiles).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        kind: "dossier",
        relativePath: `bank/fundamental/workfiles/${manifest.manifestId}/dossiers/aapl.md`,
      }),
    ]);
    expect(result.workfiles.dossier).toContain("# AAPL deeper review dossier");
    expect(result.workfiles.dossier).toContain("## Thesis Template");
    expect(result.workfiles.dossier).toContain("## Citation Tasks");
    expect(result.noteContent).toContain("status: dossier_ready");
  });
});
