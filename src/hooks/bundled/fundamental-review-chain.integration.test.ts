import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { HookHandler } from "../hooks.js";
import { createHookEvent } from "../hooks.js";
import { writeFundamentalArtifactErrors } from "./fundamental-artifact-errors.js";
import type { FundamentalArtifactErrorStatus } from "./fundamental-artifact-errors.js";
import {
  summarizeFundamentalIntakeSession,
  type FundamentalDocumentMetadata,
  type FundamentalManifestScaffold,
  type FundamentalReviewGateStatus,
} from "./fundamental-intake/handler.js";
import { bridgeManifest } from "./fundamental-manifest-bridge/handler.js";
import { buildFundamentalReviewBrief } from "./fundamental-review-brief/handler.js";
import { buildFundamentalReviewPlan } from "./fundamental-review-plan/handler.js";
import { buildFundamentalReviewQueue } from "./fundamental-review-queue/handler.js";
import { buildFundamentalRiskHandoff } from "./fundamental-risk-handoff/handler.js";
import { buildFundamentalScoringGate } from "./fundamental-scoring-gate/handler.js";
import { buildSnapshotInput } from "./fundamental-snapshot-bridge/handler.js";
import { buildFundamentalSnapshot } from "./fundamental-snapshot/handler.js";

type ReviewQueueArtifact = {
  queueStatus: string;
};

type ReviewBriefArtifact = {
  briefStatus: string;
};

type ReviewPlanArtifact = {
  planStatus: string;
};

type ReviewWorkbenchArtifact = {
  workbenchStatus: string;
};

let reviewQueueHandler: HookHandler;
let reviewBriefHandler: HookHandler;
let reviewPlanHandler: HookHandler;
let reviewWorkbenchHandler: HookHandler;
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
  manifestId?: string;
}): FundamentalManifestScaffold {
  const nowIso = "2026-03-15T12:00:00.000Z";
  const { manifestScaffold } = summarizeFundamentalIntakeSession(
    [
      {
        role: "user",
        text:
          params?.requestText ??
          "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
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
    manifestId: params?.manifestId ?? manifestScaffold.manifestId,
    reviewGate: {
      ...manifestScaffold.reviewGate,
      status: params?.reviewGateStatus ?? manifestScaffold.reviewGate.status,
    },
  };
}

function buildReadyDocuments(params: {
  prefix: string;
  targetLabel: string;
}): Array<{ fileName: string; metadata: FundamentalDocumentMetadata }> {
  return [
    {
      fileName: `${params.prefix}-annual-primary.bin`,
      metadata: {
        version: 1,
        targetLabel: params.targetLabel,
        category: "annual_report",
        sourceType: "issuer_primary",
      },
    },
    {
      fileName: `${params.prefix}-annual-regulatory.bin`,
      metadata: {
        version: 1,
        targetLabel: params.targetLabel,
        category: "annual_report",
        sourceType: "regulatory_filing",
      },
    },
    {
      fileName: `${params.prefix}-presentation.bin`,
      metadata: {
        version: 1,
        targetLabel: params.targetLabel,
        category: "investor_presentation",
        sourceType: "company_presentation",
      },
    },
  ];
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

async function prepareRecoveryChainThroughReviewPlan(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  nowIso: string;
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
    nowIso: params.nowIso,
    manifestPath,
    manifest: params.manifest,
  });
  const snapshotInput = buildSnapshotInput({
    nowIso: params.nowIso,
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
  });
  const snapshot = buildFundamentalSnapshot({
    nowIso: params.nowIso,
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    snapshotInputPath: `bank/fundamental/snapshot-inputs/${params.manifest.manifestId}.json`,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
    snapshotInput,
  });
  const scoringGate = buildFundamentalScoringGate({
    nowIso: params.nowIso,
    snapshotPath: `bank/fundamental/snapshots/${params.manifest.manifestId}.json`,
    snapshot,
  });
  const riskHandoff = buildFundamentalRiskHandoff({
    nowIso: params.nowIso,
    scoringGatePath: `bank/fundamental/scoring-gates/${params.manifest.manifestId}.json`,
    manifestRiskHandoffStatus: bridged.manifest.riskHandoff.status,
    scoringGate,
  });
  const reviewQueue = buildFundamentalReviewQueue({
    nowIso: params.nowIso,
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    handoff: riskHandoff,
  });
  const reviewBrief = buildFundamentalReviewBrief({
    nowIso: params.nowIso,
    reviewQueuePath: `bank/fundamental/review-queues/${params.manifest.manifestId}.json`,
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    reviewQueue,
    handoff: riskHandoff,
  });
  const reviewPlan = buildFundamentalReviewPlan({
    nowIso: params.nowIso,
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
  await fs.mkdir(path.join(params.workspaceDir, "memory"), { recursive: true });
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

async function runReviewChain(params: {
  workspaceDir: string;
  eventTimestamp: string;
}): Promise<void> {
  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(params.workspaceDir),
  });
  event.timestamp = new Date(params.eventTimestamp);

  for (const handler of [
    reviewQueueHandler,
    reviewBriefHandler,
    reviewPlanHandler,
    reviewWorkbenchHandler,
  ]) {
    await handler(event);
  }
}

async function readChainStatuses(params: { workspaceDir: string; manifestId: string }): Promise<{
  queueStatus: string;
  briefStatus: string;
  planStatus: string;
  workbenchStatus: string;
}> {
  const queue = JSON.parse(
    await fs.readFile(
      path.join(
        params.workspaceDir,
        "bank",
        "fundamental",
        "review-queues",
        `${params.manifestId}.json`,
      ),
      "utf-8",
    ),
  ) as ReviewQueueArtifact;
  const brief = JSON.parse(
    await fs.readFile(
      path.join(
        params.workspaceDir,
        "bank",
        "fundamental",
        "review-briefs",
        `${params.manifestId}.json`,
      ),
      "utf-8",
    ),
  ) as ReviewBriefArtifact;
  const plan = JSON.parse(
    await fs.readFile(
      path.join(
        params.workspaceDir,
        "bank",
        "fundamental",
        "review-plans",
        `${params.manifestId}.json`,
      ),
      "utf-8",
    ),
  ) as ReviewPlanArtifact;
  const workbench = JSON.parse(
    await fs.readFile(
      path.join(
        params.workspaceDir,
        "bank",
        "fundamental",
        "review-workbenches",
        `${params.manifestId}.json`,
      ),
      "utf-8",
    ),
  ) as ReviewWorkbenchArtifact;

  return {
    queueStatus: queue.queueStatus,
    briefStatus: brief.briefStatus,
    planStatus: plan.planStatus,
    workbenchStatus: workbench.workbenchStatus,
  };
}

beforeAll(async () => {
  ({ default: reviewQueueHandler } = await import("./fundamental-review-queue/handler.js"));
  ({ default: reviewBriefHandler } = await import("./fundamental-review-brief/handler.js"));
  ({ default: reviewPlanHandler } = await import("./fundamental-review-plan/handler.js"));
  ({ default: reviewWorkbenchHandler } = await import("./fundamental-review-workbench/handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-review-chain-"),
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

describe("fundamental review chain integration", () => {
  it("keeps the full chain blocked when artifact errors are newer than recovery", async () => {
    const workspaceDir = await createCaseWorkspace("blocked");
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    await prepareRecoveryChainThroughReviewPlan({
      workspaceDir,
      manifest,
      nowIso: "2026-03-15T12:00:00.000Z",
      documents: buildReadyDocuments({ prefix: "aapl", targetLabel: "AAPL" }),
    });
    await writeArtifactError({
      workspaceDir,
      manifest,
      nowIso: "2026-03-15T13:00:00.000Z",
    });

    await runReviewChain({
      workspaceDir,
      eventTimestamp: "2026-03-15T14:00:00.000Z",
    });

    await expect(
      readChainStatuses({ workspaceDir, manifestId: manifest.manifestId }),
    ).resolves.toEqual({
      queueStatus: "blocked",
      briefStatus: "blocked",
      planStatus: "blocked",
      workbenchStatus: "blocked",
    });
  });

  it("re-opens the full chain when same-manifest recovery is strictly newer than the artifact error", async () => {
    const workspaceDir = await createCaseWorkspace("recovered");
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    await prepareRecoveryChainThroughReviewPlan({
      workspaceDir,
      manifest,
      nowIso: "2026-03-15T12:00:00.000Z",
      documents: buildReadyDocuments({ prefix: "aapl", targetLabel: "AAPL" }),
    });
    await writeArtifactError({
      workspaceDir,
      manifest,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    await runReviewChain({
      workspaceDir,
      eventTimestamp: "2026-03-15T14:00:00.000Z",
    });

    const statuses = await readChainStatuses({
      workspaceDir,
      manifestId: manifest.manifestId,
    });
    expect(statuses.queueStatus).not.toBe("blocked");
    expect(statuses).toEqual({
      queueStatus: "deeper_review",
      briefStatus: "ready_for_review",
      planStatus: "active_review",
      workbenchStatus: "deeper_review",
    });
  });

  it("keeps the full chain blocked when recovery and artifact error timestamps are equal", async () => {
    const workspaceDir = await createCaseWorkspace("equal-timestamp");
    const manifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    await prepareRecoveryChainThroughReviewPlan({
      workspaceDir,
      manifest,
      nowIso: "2026-03-15T12:00:00.000Z",
      documents: buildReadyDocuments({ prefix: "aapl", targetLabel: "AAPL" }),
    });
    await writeArtifactError({
      workspaceDir,
      manifest,
      nowIso: "2026-03-15T12:00:00.000Z",
    });

    await runReviewChain({
      workspaceDir,
      eventTimestamp: "2026-03-15T14:00:00.000Z",
    });

    await expect(
      readChainStatuses({ workspaceDir, manifestId: manifest.manifestId }),
    ).resolves.toEqual({
      queueStatus: "blocked",
      briefStatus: "blocked",
      planStatus: "blocked",
      workbenchStatus: "blocked",
    });
  });

  it("keeps manifest-level isolation when a different manifest has a newer recovery chain", async () => {
    const workspaceDir = await createCaseWorkspace("cross-manifest");
    const aaplManifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    });
    const msftManifest = createManifestFixture({
      reviewGateStatus: "approved_for_collection",
      requestText:
        "Build a fundamental research scaffold for MSFT in the US. Use annual reports and investor presentations.",
      manifestId: "msft-cross-manifest-recovery",
    });
    await prepareRecoveryChainThroughReviewPlan({
      workspaceDir,
      manifest: aaplManifest,
      nowIso: "2026-03-15T12:00:00.000Z",
      documents: buildReadyDocuments({ prefix: "aapl", targetLabel: "AAPL" }),
    });
    await prepareRecoveryChainThroughReviewPlan({
      workspaceDir,
      manifest: msftManifest,
      nowIso: "2026-03-15T13:00:00.000Z",
      documents: buildReadyDocuments({ prefix: "msft", targetLabel: "MSFT" }),
    });
    await writeArtifactError({
      workspaceDir,
      manifest: aaplManifest,
      nowIso: "2026-03-15T12:30:00.000Z",
    });

    await runReviewChain({
      workspaceDir,
      eventTimestamp: "2026-03-15T14:00:00.000Z",
    });

    await expect(
      readChainStatuses({ workspaceDir, manifestId: aaplManifest.manifestId }),
    ).resolves.toEqual({
      queueStatus: "blocked",
      briefStatus: "blocked",
      planStatus: "blocked",
      workbenchStatus: "blocked",
    });
    await expect(
      readChainStatuses({ workspaceDir, manifestId: msftManifest.manifestId }),
    ).resolves.toEqual({
      queueStatus: "deeper_review",
      briefStatus: "ready_for_review",
      planStatus: "active_review",
      workbenchStatus: "deeper_review",
    });
  });
});
