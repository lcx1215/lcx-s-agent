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
import { buildFundamentalTargetPackets } from "../fundamental-target-packets/handler.js";

let handler: HookHandler;
let targetReportsHandler: HookHandler;
let collectionPacketsHandler: HookHandler;
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

async function runReviewMemo(params: {
  manifest: FundamentalManifestScaffold;
  documents?: Array<{ fileName: string; metadata?: FundamentalDocumentMetadata }>;
  persistTargetReports?: boolean;
  persistCollectionPackets?: boolean;
}): Promise<{
  artifact: Record<string, unknown> | null;
  noteContent: string | null;
  memoContent: string | null;
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

  if (params.persistTargetReports) {
    await targetReportsHandler(event);
  }
  if (params.persistCollectionPackets) {
    await collectionPacketsHandler(event);
  }
  await handler(event);

  const artifactPath = path.join(
    tempDir,
    "bank",
    "fundamental",
    "review-memos",
    `${params.manifest.manifestId}.json`,
  );
  const memoPath = path.join(
    tempDir,
    "bank",
    "fundamental",
    "memos",
    `${params.manifest.manifestId}.md`,
  );
  const notePath = await fs
    .readdir(path.join(tempDir, "memory"))
    .then((entries) =>
      entries.find((entry) =>
        entry.endsWith(`fundamental-review-memo-${params.manifest.manifestId}.md`),
      ),
    )
    .then((entry) => (entry ? path.join(tempDir, "memory", entry) : null))
    .catch(() => null);

  const artifact = await fs
    .readFile(artifactPath, "utf-8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => null);
  const noteContent = notePath ? await fs.readFile(notePath, "utf-8").catch(() => null) : null;
  const memoContent = await fs.readFile(memoPath, "utf-8").catch(() => null);

  return { artifact, noteContent, memoContent };
}

describe("fundamental-review-memo hook", () => {
  beforeAll(async () => {
    suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fundamental-review-memo-"));
    handler = (await import("./handler.js")).default;
    targetReportsHandler = (await import("../fundamental-target-reports/handler.js")).default;
    collectionPacketsHandler = (await import("../fundamental-collection-packets/handler.js"))
      .default;
  });

  afterAll(async () => {
    if (suiteWorkspaceRoot) {
      await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it("materializes a report-review memo for dossier-ready targets", async () => {
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const { artifact, noteContent, memoContent } = await runReviewMemo({
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
      persistTargetReports: true,
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.memoStatus).toBe("ready_for_report_review");
    expect(artifact?.reportReviewTargets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        reportPath: `bank/fundamental/reports/${manifest.manifestId}/aapl.md`,
      }),
    ]);
    expect(noteContent).toContain("report_review_targets: 1");
    expect(memoContent).toContain("# Fundamental Review Memo:");
    expect(memoContent).toContain("## Report Review Targets");
    expect(memoContent).toContain(`bank/fundamental/reports/${manifest.manifestId}/aapl.md`);
  });

  it("materializes a follow-up memo for collection-needed targets", async () => {
    const manifest = createManifestFixture({ reviewGateStatus: "approved_for_collection" });
    const { artifact, noteContent, memoContent } = await runReviewMemo({
      manifest,
      documents: [
        { fileName: "aapl-annual-report.pdf" },
        { fileName: "aapl-investor-presentation.pdf" },
        { fileName: "aapl-research-report.pdf" },
      ],
      persistCollectionPackets: true,
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.memoStatus).toBe("follow_up_collection_needed");
    expect(artifact?.collectionFollowUpTargets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
        recommendation: "metadata_repair_then_review",
      }),
    ]);
    expect(noteContent).toContain("collection_follow_up_targets: 1");
    expect(memoContent).toContain("## Collection Follow-Ups");
    expect(memoContent).toContain("metadata_repair_then_review");
  });

  it("materializes a blocked-only memo when no targets are ready", async () => {
    const manifest = createManifestFixture({ reviewGateStatus: "pending_human_approval" });
    const { artifact, noteContent, memoContent } = await runReviewMemo({
      manifest,
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.memoStatus).toBe("blocked_only");
    expect(artifact?.reportReviewTargets).toEqual([]);
    expect(artifact?.collectionFollowUpTargets).toEqual([]);
    expect(artifact?.blockedTargets).toEqual([
      expect.objectContaining({
        targetLabel: "AAPL",
      }),
    ]);
    expect(noteContent).toContain("blocked_targets: 1");
    expect(memoContent).toContain("## Blocked Targets");
    expect(memoContent).toContain("AAPL");
  });
});
