import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import type { FundamentalManifestScaffold } from "../fundamental-intake/handler.js";
import {
  buildFundamentalReviewQueue,
  type FundamentalReviewQueueArtifact,
} from "../fundamental-review-queue/handler.js";
import {
  buildFundamentalRiskHandoff,
  type FundamentalRiskHandoffArtifact,
} from "../fundamental-risk-handoff/handler.js";
import type { FundamentalScoringGateArtifact } from "../fundamental-scoring-gate/handler.js";

const log = createSubsystemLogger("hooks/fundamental-review-brief");

type BriefStatus = "blocked" | "follow_up" | "ready_for_review";

type ReviewBriefTarget = {
  targetLabel: string;
  reviewPriority: "low" | "medium" | "high";
  queueAction: "blocked" | "follow_up_missing_inputs" | "deeper_review";
  requestedMaterials: string[];
  nextActions: string[];
  availableDocumentCategories: string[];
  presentSourceTypes: string[];
  missingCriticalInputs: string[];
  documentPaths: string[];
  evidenceReadinessLevel: FundamentalRiskHandoffArtifact["targetDecisions"][number]["evidenceReadinessLevel"];
  notes: string[];
};

export type FundamentalReviewBriefArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  reviewQueuePath: string;
  riskHandoffPath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  briefStatus: BriefStatus;
  reviewFocus: string[];
  deeperReviewTargets: ReviewBriefTarget[];
  followUpTargets: ReviewBriefTarget[];
  blockedTargets: ReviewBriefTarget[];
  notes: string[];
};

async function loadJsonFiles<T>(params: {
  dirPath: string;
  relativePrefix: string;
}): Promise<Array<{ relativePath: string; data: T }>> {
  try {
    const fileNames = (await fs.readdir(params.dirPath))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    return await Promise.all(
      fileNames.map(async (name) => {
        const relativePath = `${params.relativePrefix}/${name}`;
        const raw = await fs.readFile(path.join(params.dirPath, name), "utf-8");
        return {
          relativePath,
          data: JSON.parse(raw) as T,
        };
      }),
    );
  } catch {
    return [];
  }
}

async function loadRiskHandoffsWithFallback(
  workspaceDir: string,
): Promise<Array<{ relativePath: string; handoff: FundamentalRiskHandoffArtifact }>> {
  const [manifests, scoringGates, persistedHandoffs] = await Promise.all([
    loadJsonFiles<FundamentalManifestScaffold>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
      relativePrefix: "bank/fundamental/manifests",
    }),
    loadJsonFiles<FundamentalScoringGateArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "scoring-gates"),
      relativePrefix: "bank/fundamental/scoring-gates",
    }),
    loadJsonFiles<FundamentalRiskHandoffArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "risk-handoffs"),
      relativePrefix: "bank/fundamental/risk-handoffs",
    }),
  ]);

  const manifestById = new Map(manifests.map(({ data }) => [data.manifestId, data]));
  const resolved = new Map(
    persistedHandoffs.map(({ relativePath, data }) => [
      data.manifestId,
      { relativePath, handoff: data },
    ]),
  );

  for (const { relativePath, data: scoringGate } of scoringGates) {
    if (resolved.has(scoringGate.manifestId)) {
      continue;
    }
    const manifest = manifestById.get(scoringGate.manifestId);
    if (!manifest) {
      continue;
    }
    resolved.set(scoringGate.manifestId, {
      relativePath: `bank/fundamental/risk-handoffs/${scoringGate.manifestId}.json`,
      handoff: buildFundamentalRiskHandoff({
        nowIso: scoringGate.generatedAt,
        scoringGatePath: relativePath,
        manifestRiskHandoffStatus: manifest.riskHandoff.status,
        scoringGate,
      }),
    });
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.handoff.generatedAt.localeCompare(a.handoff.generatedAt) ||
      a.handoff.manifestId.localeCompare(b.handoff.manifestId),
  );
}

async function loadReviewQueuesWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    reviewQueue: FundamentalReviewQueueArtifact;
    riskHandoffPath: string;
    handoff: FundamentalRiskHandoffArtifact;
  }>
> {
  const [persistedQueues, handoffs] = await Promise.all([
    loadJsonFiles<FundamentalReviewQueueArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "review-queues"),
      relativePrefix: "bank/fundamental/review-queues",
    }),
    loadRiskHandoffsWithFallback(workspaceDir),
  ]);

  const handoffById = new Map(handoffs.map((entry) => [entry.handoff.manifestId, entry]));
  const resolved = new Map<
    string,
    {
      relativePath: string;
      reviewQueue: FundamentalReviewQueueArtifact;
      riskHandoffPath: string;
      handoff: FundamentalRiskHandoffArtifact;
    }
  >();

  for (const { relativePath, data } of persistedQueues) {
    const handoff = handoffById.get(data.manifestId);
    if (!handoff) {
      continue;
    }
    resolved.set(data.manifestId, {
      relativePath,
      reviewQueue: data,
      riskHandoffPath: handoff.relativePath,
      handoff: handoff.handoff,
    });
  }

  for (const handoff of handoffs) {
    if (resolved.has(handoff.handoff.manifestId)) {
      continue;
    }
    resolved.set(handoff.handoff.manifestId, {
      relativePath: `bank/fundamental/review-queues/${handoff.handoff.manifestId}.json`,
      reviewQueue: buildFundamentalReviewQueue({
        nowIso: handoff.handoff.generatedAt,
        riskHandoffPath: handoff.relativePath,
        handoff: handoff.handoff,
      }),
      riskHandoffPath: handoff.relativePath,
      handoff: handoff.handoff,
    });
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.reviewQueue.generatedAt.localeCompare(a.reviewQueue.generatedAt) ||
      a.reviewQueue.manifestId.localeCompare(b.reviewQueue.manifestId),
  );
}

function buildReviewFocus(params: {
  deeperReviewTargets: ReviewBriefTarget[];
  followUpTargets: ReviewBriefTarget[];
  blockedTargets: ReviewBriefTarget[];
}): string[] {
  const focus: string[] = [];
  for (const target of params.deeperReviewTargets) {
    focus.push(`Start deeper review for ${target.targetLabel}.`);
  }
  for (const target of params.followUpTargets) {
    if (target.requestedMaterials.length > 0) {
      focus.push(
        `Collect or repair ${target.requestedMaterials.join(", ")} for ${target.targetLabel}.`,
      );
    } else {
      focus.push(`Resolve follow-up blockers for ${target.targetLabel}.`);
    }
  }
  for (const target of params.blockedTargets) {
    focus.push(
      `Keep ${target.targetLabel} blocked until ${target.missingCriticalInputs.join(", ")} is cleared.`,
    );
  }
  return focus;
}

function buildBriefNotes(params: {
  briefStatus: BriefStatus;
  deeperReviewTargets: number;
  followUpTargets: number;
  blockedTargets: number;
}): string[] {
  if (params.briefStatus === "ready_for_review") {
    return [
      "This brief is ready for deeper non-execution research review.",
      "It does not create asset approvals, vetoes, or trading instructions.",
    ];
  }
  if (params.briefStatus === "follow_up") {
    return [
      `${params.deeperReviewTargets} target(s) can enter deeper review, ${params.followUpTargets} need additional materials or cleanup, and ${params.blockedTargets} remain blocked.`,
      "Use this brief to prioritize the next research step, not execution.",
    ];
  }
  return [
    "No targets are ready for deeper review yet.",
    "This brief keeps blockers visible without upgrading them into execution or approval state.",
  ];
}

function renderReviewBriefNote(params: {
  dateStr: string;
  timeStr: string;
  reviewBriefPath: string;
  reviewBrief: FundamentalReviewBriefArtifact;
}): string {
  return [
    `# Fundamental Review Brief: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.reviewBrief.manifestId}`,
    `- review_brief_path: ${params.reviewBriefPath}`,
    `- brief_status: ${params.reviewBrief.briefStatus}`,
    `- deeper_review_targets: ${params.reviewBrief.deeperReviewTargets.length}`,
    `- follow_up_targets: ${params.reviewBrief.followUpTargets.length}`,
    `- blocked_targets: ${params.reviewBrief.blockedTargets.length}`,
    "",
    "## Review Focus",
    ...(params.reviewBrief.reviewFocus.length > 0
      ? params.reviewBrief.reviewFocus.map((line) => `- ${line}`)
      : ["- none"]),
    "",
  ].join("\n");
}

export function buildFundamentalReviewBrief(params: {
  nowIso: string;
  reviewQueuePath: string;
  riskHandoffPath: string;
  reviewQueue: FundamentalReviewQueueArtifact;
  handoff: FundamentalRiskHandoffArtifact;
}): FundamentalReviewBriefArtifact {
  const handoffByTarget = new Map(
    params.handoff.targetDecisions.map((target) => [target.targetLabel, target]),
  );
  const targets = params.reviewQueue.targets.map((target) => {
    const handoff = handoffByTarget.get(target.targetLabel);
    return {
      targetLabel: target.targetLabel,
      reviewPriority: target.reviewPriority,
      queueAction: target.queueAction,
      requestedMaterials: target.requestedMaterials,
      nextActions: target.nextActions,
      availableDocumentCategories: handoff?.availableDocumentCategories ?? [],
      presentSourceTypes: handoff?.sourceCoverage.presentSourceTypes ?? [],
      missingCriticalInputs: target.missingCriticalInputs,
      documentPaths: handoff?.documentPaths ?? target.documentPaths,
      evidenceReadinessLevel: handoff?.evidenceReadinessLevel ?? "insufficient",
      notes: target.notes,
    } satisfies ReviewBriefTarget;
  });

  const deeperReviewTargets = targets.filter((target) => target.queueAction === "deeper_review");
  const followUpTargets = targets.filter(
    (target) => target.queueAction === "follow_up_missing_inputs",
  );
  const blockedTargets = targets.filter((target) => target.queueAction === "blocked");

  const briefStatus: BriefStatus =
    deeperReviewTargets.length === targets.length && targets.length > 0
      ? "ready_for_review"
      : deeperReviewTargets.length > 0 || followUpTargets.length > 0
        ? "follow_up"
        : "blocked";

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.reviewQueue.manifestId,
    manifestPath: params.reviewQueue.manifestPath,
    reviewQueuePath: params.reviewQueuePath,
    riskHandoffPath: params.riskHandoffPath,
    requestTitle: params.reviewQueue.requestTitle,
    researchBranch: params.reviewQueue.researchBranch,
    briefStatus,
    reviewFocus: buildReviewFocus({
      deeperReviewTargets,
      followUpTargets,
      blockedTargets,
    }),
    deeperReviewTargets,
    followUpTargets,
    blockedTargets,
    notes: buildBriefNotes({
      briefStatus,
      deeperReviewTargets: deeperReviewTargets.length,
      followUpTargets: followUpTargets.length,
      blockedTargets: blockedTargets.length,
    }),
  };
}

const materializeFundamentalReviewBrief: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const entries = await loadReviewQueuesWithFallback(workspaceDir);
    if (entries.length === 0) {
      return;
    }

    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      entries.map(async ({ relativePath, reviewQueue, riskHandoffPath, handoff }) => {
        const reviewBrief = buildFundamentalReviewBrief({
          nowIso,
          reviewQueuePath: relativePath,
          riskHandoffPath,
          reviewQueue,
          handoff,
        });
        const reviewBriefPath = `bank/fundamental/review-briefs/${reviewQueue.manifestId}.json`;
        const noteRelativePath = `${dateStr}-fundamental-review-brief-${reviewQueue.manifestId}.md`;
        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: reviewBriefPath,
            data: `${JSON.stringify(reviewBrief, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderReviewBriefNote({
              dateStr,
              timeStr,
              reviewBriefPath,
              reviewBrief,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental review brief materialized ${entries.length} review queue(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental review brief", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalReviewBrief;
