import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import {
  loadReviewQueuesWithFallback,
  type FundamentalReviewQueueArtifact,
} from "../fundamental-review-queue/handler.js";
import type { FundamentalRiskHandoffArtifact } from "../fundamental-risk-handoff/handler.js";
import {
  buildFundamentalReviewChainJsonPath,
  buildFundamentalReviewChainNoteFilename,
} from "../lobster-brain-registry.js";

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
  riskHandoffPath: string | null;
  reviewQueue: FundamentalReviewQueueArtifact;
  handoff?: FundamentalRiskHandoffArtifact;
}): FundamentalReviewBriefArtifact {
  const handoffByTarget = new Map(
    (params.handoff?.targetDecisions ?? []).map((target) => [target.targetLabel, target]),
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
    riskHandoffPath:
      params.riskHandoffPath ??
      `bank/fundamental/risk-handoffs/${params.reviewQueue.manifestId}.json`,
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

export async function loadReviewBriefsWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    reviewBrief: FundamentalReviewBriefArtifact;
    reviewQueuePath: string;
    riskHandoffPath: string | null;
    handoff?: FundamentalRiskHandoffArtifact;
  }>
> {
  const entries = await loadReviewQueuesWithFallback(workspaceDir);
  return entries.map(({ relativePath, reviewQueue, riskHandoffPath, handoff }) => ({
    relativePath: `bank/fundamental/review-briefs/${reviewQueue.manifestId}.json`,
    reviewBrief: buildFundamentalReviewBrief({
      nowIso: reviewQueue.generatedAt,
      reviewQueuePath: relativePath,
      riskHandoffPath,
      reviewQueue,
      handoff,
    }),
    reviewQueuePath: relativePath,
    riskHandoffPath,
    handoff,
  }));
}

const materializeFundamentalReviewBrief: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    const entries = await loadReviewBriefsWithFallback(workspaceDir);
    if (entries.length === 0) {
      return;
    }

    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    await Promise.all(
      entries.map(async ({ reviewBrief }) => {
        const reviewBriefPath = buildFundamentalReviewChainJsonPath(
          "fundamental-review-brief",
          reviewBrief.manifestId,
        );
        const noteRelativePath = buildFundamentalReviewChainNoteFilename({
          dateStr,
          stageName: "fundamental-review-brief",
          manifestId: reviewBrief.manifestId,
        });
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
