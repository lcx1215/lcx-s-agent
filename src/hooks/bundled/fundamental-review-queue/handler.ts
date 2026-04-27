import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { resolveMemorySessionContext } from "../artifact-memory.js";
import type { FundamentalArtifactErrorRecord } from "../fundamental-artifact-errors.js";
import {
  buildFundamentalReviewChainJsonPath,
  buildFundamentalReviewChainNoteFilename,
} from "../lobster-brain-registry.js";
import type { FundamentalManifestScaffold } from "../fundamental-intake/handler.js";
import {
  buildFundamentalRiskHandoff,
  type FundamentalRiskHandoffArtifact,
} from "../fundamental-risk-handoff/handler.js";
import type { FundamentalScoringGateArtifact } from "../fundamental-scoring-gate/handler.js";

const log = createSubsystemLogger("hooks/fundamental-review-queue");

type FundamentalReviewQueueStatus = "blocked" | "follow_up" | "deeper_review";
type FundamentalReviewQueueAction = "blocked" | "follow_up_missing_inputs" | "deeper_review";
type FundamentalReviewPriority = "low" | "medium" | "high";

type ReviewQueueTarget = {
  targetLabel: string;
  region: string;
  handoffDecision: FundamentalRiskHandoffArtifact["targetDecisions"][number]["handoffDecision"];
  queueAction: FundamentalReviewQueueAction;
  reviewPriority: FundamentalReviewPriority;
  watchlistCandidate: boolean;
  missingCriticalInputs: string[];
  requestedMaterials: string[];
  nextActions: string[];
  documentPaths: string[];
  notes: string[];
};

type FollowUpQueueItem = {
  targetLabel: string;
  reviewPriority: Exclude<FundamentalReviewPriority, "low">;
  requestedMaterials: string[];
  nextActions: string[];
};

type MissingDocumentsQueueItem = {
  targetLabel: string;
  requestedMaterials: string[];
};

export type FundamentalReviewQueueArtifact = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  manifestPath: string;
  riskHandoffPath: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  queueStatus: FundamentalReviewQueueStatus;
  summary: {
    totalTargets: number;
    deeperReviewTargets: number;
    followUpTargets: number;
    blockedTargets: number;
    watchlistTargets: number;
    missingDocumentsQueueItems: number;
  };
  watchlist: string[];
  blockedList: string[];
  reviewPriorityRanking: Array<{
    targetLabel: string;
    reviewPriority: FundamentalReviewPriority;
    queueAction: FundamentalReviewQueueAction;
  }>;
  followUpQueue: FollowUpQueueItem[];
  missingDocumentsQueue: MissingDocumentsQueueItem[];
  targets: ReviewQueueTarget[];
  notes: string[];
};

async function loadJsonFiles<T>(params: {
  dirPath: string;
  relativePrefix: string;
}): Promise<Array<{ fileName: string; relativePath: string; data: T }>> {
  try {
    const files = (await fs.readdir(params.dirPath))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    return await Promise.all(
      files.map(async (fileName) => {
        const relativePath = `${params.relativePrefix}/${fileName}`;
        const raw = await fs.readFile(path.join(params.dirPath, fileName), "utf-8");
        return {
          fileName,
          relativePath,
          data: JSON.parse(raw) as T,
        };
      }),
    );
  } catch {
    return [];
  }
}

export async function loadArtifactErrorsByManifestId(
  workspaceDir: string,
): Promise<Map<string, FundamentalArtifactErrorRecord[]>> {
  const records = await loadJsonFiles<FundamentalArtifactErrorRecord>({
    dirPath: path.join(workspaceDir, "bank", "fundamental", "artifact-errors"),
    relativePrefix: "bank/fundamental/artifact-errors",
  });
  const byManifestId = new Map<string, FundamentalArtifactErrorRecord[]>();
  for (const { data } of records) {
    if (!data.manifestId) {
      continue;
    }
    const existing = byManifestId.get(data.manifestId) ?? [];
    existing.push(data);
    byManifestId.set(data.manifestId, existing);
  }
  return byManifestId;
}

export function hasValidRecoveryAfterArtifactError(params: {
  artifactErrors: FundamentalArtifactErrorRecord[];
  recoveryGeneratedAt: string | undefined;
}): boolean {
  if (!params.recoveryGeneratedAt) {
    return false;
  }
  const latestError = params.artifactErrors.toSorted(
    (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.stage.localeCompare(b.stage),
  )[0];
  if (!latestError) {
    return true;
  }
  // Recovery must be both manifest-specific and strictly newer than the latest
  // recorded artifact failure. Equal timestamps are treated as ambiguous and do
  // not clear the blocked state.
  return params.recoveryGeneratedAt > latestError.lastSeenAt;
}

export function buildBlockedReviewQueueFromArtifactErrors(params: {
  nowIso: string;
  manifestPath: string;
  manifest: FundamentalManifestScaffold;
  artifactErrors: FundamentalArtifactErrorRecord[];
}): FundamentalReviewQueueArtifact {
  const latestError = params.artifactErrors.toSorted(
    (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.stage.localeCompare(b.stage),
  )[0];
  const stages = [...new Set(params.artifactErrors.map((error) => error.stage))].toSorted();
  const targets = params.manifest.targets.map((target) => ({
    targetLabel: target.label,
    region: target.region,
    handoffDecision: "blocked" as const,
    queueAction: "blocked" as const,
    reviewPriority: "medium" as const,
    watchlistCandidate: false,
    missingCriticalInputs: ["artifact_error"],
    requestedMaterials: [],
    nextActions: ["resolve_artifact_error"],
    documentPaths: [],
    notes: [
      `Target is blocked because upstream artifact parsing failed in stage(s): ${stages.join(", ")}.`,
      "Downstream review queue remains explicitly blocked until the artifact error is resolved.",
    ],
  }));

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.manifest.manifestId,
    manifestPath: params.manifestPath,
    riskHandoffPath: `bank/fundamental/risk-handoffs/${params.manifest.manifestId}.json`,
    requestTitle: params.manifest.requestTitle,
    researchBranch: params.manifest.researchBranch,
    queueStatus: "blocked",
    summary: {
      totalTargets: targets.length,
      deeperReviewTargets: 0,
      followUpTargets: 0,
      blockedTargets: targets.length,
      watchlistTargets: 0,
      missingDocumentsQueueItems: 0,
    },
    watchlist: [],
    blockedList: targets.map((target) => target.targetLabel),
    reviewPriorityRanking: targets.map((target) => ({
      targetLabel: target.targetLabel,
      reviewPriority: target.reviewPriority,
      queueAction: target.queueAction,
    })),
    followUpQueue: [],
    missingDocumentsQueue: [],
    targets,
    notes: [
      "This queue is explicitly blocked due to upstream artifact parsing failure.",
      `Latest artifact error stage: ${latestError?.stage ?? "unknown"}.`,
      `Latest artifact error seen at: ${latestError?.lastSeenAt ?? params.nowIso}.`,
      "Do not promote this manifest into deeper review until the artifact error is resolved.",
    ],
  };
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
  const persistedById = new Map(
    persistedHandoffs.map(({ relativePath, data }) => [
      data.manifestId,
      { relativePath, handoff: data },
    ]),
  );
  const resolved = new Map<
    string,
    { relativePath: string; handoff: FundamentalRiskHandoffArtifact }
  >();

  for (const [manifestId, persisted] of persistedById) {
    resolved.set(manifestId, persisted);
  }

  for (const { relativePath, data: scoringGate } of scoringGates) {
    const manifest = manifestById.get(scoringGate.manifestId);
    if (!manifest) {
      continue;
    }
    const persisted = persistedById.get(scoringGate.manifestId);
    if (persisted && persisted.handoff.generatedAt >= scoringGate.generatedAt) {
      resolved.set(scoringGate.manifestId, persisted);
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

export async function loadReviewQueuesWithFallback(workspaceDir: string): Promise<
  Array<{
    relativePath: string;
    reviewQueue: FundamentalReviewQueueArtifact;
    riskHandoffPath: string | null;
    handoff?: FundamentalRiskHandoffArtifact;
  }>
> {
  const [persistedQueues, handoffs, manifests, artifactErrorsByManifestId] = await Promise.all([
    loadJsonFiles<FundamentalReviewQueueArtifact>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "review-queues"),
      relativePrefix: "bank/fundamental/review-queues",
    }),
    loadRiskHandoffsWithFallback(workspaceDir),
    loadJsonFiles<FundamentalManifestScaffold>({
      dirPath: path.join(workspaceDir, "bank", "fundamental", "manifests"),
      relativePrefix: "bank/fundamental/manifests",
    }),
    loadArtifactErrorsByManifestId(workspaceDir),
  ]);

  const handoffById = new Map(handoffs.map((entry) => [entry.handoff.manifestId, entry]));
  const persistedById = new Map(
    persistedQueues.map(({ relativePath, data }) => [
      data.manifestId,
      { relativePath, reviewQueue: data },
    ]),
  );
  const manifestById = new Map(
    manifests.map(({ relativePath, data }) => [data.manifestId, { relativePath, manifest: data }]),
  );
  const manifestIds = new Set<string>([
    ...persistedById.keys(),
    ...handoffById.keys(),
    ...manifestById.keys(),
    ...artifactErrorsByManifestId.keys(),
  ]);
  const resolved = new Map<
    string,
    {
      relativePath: string;
      reviewQueue: FundamentalReviewQueueArtifact;
      riskHandoffPath: string | null;
      handoff?: FundamentalRiskHandoffArtifact;
    }
  >();

  for (const manifestId of manifestIds) {
    const artifactErrors = artifactErrorsByManifestId.get(manifestId);
    const persisted = persistedById.get(manifestId);
    const handoff = handoffById.get(manifestId);
    const manifestEntry = manifestById.get(manifestId);

    if (artifactErrors && artifactErrors.length > 0) {
      if (
        persisted &&
        hasValidRecoveryAfterArtifactError({
          artifactErrors,
          recoveryGeneratedAt: persisted.reviewQueue.generatedAt,
        })
      ) {
        resolved.set(manifestId, {
          relativePath: persisted.relativePath,
          reviewQueue: persisted.reviewQueue,
          riskHandoffPath: handoff?.relativePath ?? persisted.reviewQueue.riskHandoffPath,
          handoff: handoff?.handoff,
        });
        continue;
      }
      if (
        !persisted &&
        handoff &&
        hasValidRecoveryAfterArtifactError({
          artifactErrors,
          recoveryGeneratedAt: handoff.handoff.generatedAt,
        })
      ) {
        resolved.set(manifestId, {
          relativePath: `bank/fundamental/review-queues/${manifestId}.json`,
          reviewQueue: buildFundamentalReviewQueue({
            nowIso: handoff.handoff.generatedAt,
            riskHandoffPath: handoff.relativePath,
            handoff: handoff.handoff,
          }),
          riskHandoffPath: handoff.relativePath,
          handoff: handoff.handoff,
        });
        continue;
      }
      if (manifestEntry) {
        resolved.set(manifestId, {
          relativePath: `bank/fundamental/review-queues/${manifestId}.json`,
          reviewQueue: buildBlockedReviewQueueFromArtifactErrors({
            nowIso:
              artifactErrors.toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0]
                ?.lastSeenAt ?? new Date().toISOString(),
            manifestPath: manifestEntry.relativePath,
            manifest: manifestEntry.manifest,
            artifactErrors,
          }),
          riskHandoffPath: null,
        });
        continue;
      }
    }

    if (persisted) {
      resolved.set(manifestId, {
        relativePath: persisted.relativePath,
        reviewQueue: persisted.reviewQueue,
        riskHandoffPath: handoff?.relativePath ?? persisted.reviewQueue.riskHandoffPath,
        handoff: handoff?.handoff,
      });
      continue;
    }
    if (handoff) {
      resolved.set(manifestId, {
        relativePath: `bank/fundamental/review-queues/${manifestId}.json`,
        reviewQueue: buildFundamentalReviewQueue({
          nowIso: handoff.handoff.generatedAt,
          riskHandoffPath: handoff.relativePath,
          handoff: handoff.handoff,
        }),
        riskHandoffPath: handoff.relativePath,
        handoff: handoff.handoff,
      });
    }
  }

  return [...resolved.values()].toSorted(
    (a, b) =>
      b.reviewQueue.generatedAt.localeCompare(a.reviewQueue.generatedAt) ||
      a.reviewQueue.manifestId.localeCompare(b.reviewQueue.manifestId),
  );
}

function deriveRequestedMaterials(
  target: FundamentalRiskHandoffArtifact["targetDecisions"][number],
): string[] {
  const requested = new Set<string>();
  for (const input of target.missingCriticalInputs) {
    if (input.startsWith("document:")) {
      requested.add(input.slice("document:".length));
    }
    if (input === "document_metadata_sidecar") {
      requested.add("document_metadata_sidecar");
    }
  }
  if (
    target.handoffDecision !== "ready" &&
    (target.metadataConfidence.classifiedByFilename > 0 ||
      target.fallbackExposure.filenameFallbackCount > 0 ||
      target.documentPaths.length > 0) &&
    target.metadataConfidence.mode !== "metadata_only"
  ) {
    requested.add("document_metadata_sidecar");
  }
  return [...requested];
}

function deriveNextActions(params: {
  target: FundamentalRiskHandoffArtifact["targetDecisions"][number];
  requestedMaterials: string[];
}): string[] {
  const actions = new Set<string>();
  if (params.target.handoffDecision === "ready") {
    actions.add("start_deeper_review");
    actions.add("assemble_review_brief");
    return [...actions];
  }
  if (params.target.missingCriticalInputs.includes("review_gate_approval")) {
    actions.add("resolve_review_gate_approval");
  }
  if (params.target.missingCriticalInputs.includes("named_target_resolution")) {
    actions.add("resolve_named_target");
  }
  if (params.target.missingCriticalInputs.includes("manifest_document_alignment")) {
    actions.add("align_documents_to_manifest_plan");
  }
  if (params.requestedMaterials.some((item) => item !== "document_metadata_sidecar")) {
    actions.add("collect_missing_documents");
  }
  if (params.requestedMaterials.includes("document_metadata_sidecar")) {
    actions.add("add_metadata_sidecars");
  }
  if (
    params.target.handoffDecision === "partial" &&
    params.target.fallbackExposure.validationNoteCount > 0
  ) {
    actions.add("resolve_validation_notes");
  }
  if (actions.size === 0) {
    actions.add("keep_target_in_follow_up_queue");
  }
  return [...actions];
}

function deriveQueueAction(
  handoffDecision: FundamentalRiskHandoffArtifact["targetDecisions"][number]["handoffDecision"],
): FundamentalReviewQueueAction {
  if (handoffDecision === "ready") {
    return "deeper_review";
  }
  if (handoffDecision === "partial") {
    return "follow_up_missing_inputs";
  }
  return "blocked";
}

function deriveReviewPriority(
  target: FundamentalRiskHandoffArtifact["targetDecisions"][number],
): FundamentalReviewPriority {
  if (target.handoffDecision === "ready") {
    return "high";
  }
  if (target.handoffDecision === "partial") {
    return "medium";
  }
  return target.missingCriticalInputs.includes("review_gate_approval") ? "low" : "medium";
}

function buildTargetNotes(params: {
  target: FundamentalRiskHandoffArtifact["targetDecisions"][number];
  queueAction: FundamentalReviewQueueAction;
}): string[] {
  const notes = [...params.target.notes];
  if (params.queueAction === "deeper_review") {
    notes.push("Target should move into deeper non-execution research review.");
  } else if (params.queueAction === "follow_up_missing_inputs") {
    notes.push(
      "Target should stay visible in the follow-up queue until missing inputs are resolved.",
    );
  } else {
    notes.push("Target remains on the blocked list until approval or document blockers clear.");
  }
  return notes;
}

function buildArtifactNotes(params: {
  queueStatus: FundamentalReviewQueueStatus;
  deeperReviewTargets: number;
  followUpTargets: number;
  blockedTargets: number;
}): string[] {
  if (params.queueStatus === "deeper_review") {
    return [
      "At least one target is ready for deeper research review without claiming execution approval.",
      "This queue is research-only and does not create asset approvals or vetoes.",
    ];
  }
  if (params.queueStatus === "follow_up") {
    return [
      `${params.deeperReviewTargets} target(s) are ready for deeper review, ${params.followUpTargets} remain in follow-up, and ${params.blockedTargets} remain blocked.`,
      "Use this queue to decide the next document collection and review steps, not execution.",
    ];
  }
  return [
    "All targets remain blocked or incomplete for deeper research review.",
    "This queue keeps blockers visible without promoting targets into execution or approval flows.",
  ];
}

function renderReviewQueueNote(params: {
  dateStr: string;
  timeStr: string;
  reviewQueuePath: string;
  reviewQueue: FundamentalReviewQueueArtifact;
}): string {
  return [
    `# Fundamental Review Queue: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- manifest_id: ${params.reviewQueue.manifestId}`,
    `- review_queue_path: ${params.reviewQueuePath}`,
    `- queue_status: ${params.reviewQueue.queueStatus}`,
    `- watchlist_targets: ${params.reviewQueue.summary.watchlistTargets}`,
    `- deeper_review_targets: ${params.reviewQueue.summary.deeperReviewTargets}`,
    `- follow_up_targets: ${params.reviewQueue.summary.followUpTargets}`,
    `- blocked_targets: ${params.reviewQueue.summary.blockedTargets}`,
    "",
    "## Review Priority Ranking",
    ...(params.reviewQueue.reviewPriorityRanking.length > 0
      ? params.reviewQueue.reviewPriorityRanking.map(
          (entry) =>
            `- ${entry.targetLabel}: priority=${entry.reviewPriority}, action=${entry.queueAction}`,
        )
      : ["- none"]),
    "",
    "## Missing Documents Queue",
    ...(params.reviewQueue.missingDocumentsQueue.length > 0
      ? params.reviewQueue.missingDocumentsQueue.map(
          (entry) => `- ${entry.targetLabel}: ${entry.requestedMaterials.join(", ")}`,
        )
      : ["- none"]),
    "",
  ].join("\n");
}

export function buildFundamentalReviewQueue(params: {
  nowIso: string;
  riskHandoffPath: string;
  handoff: FundamentalRiskHandoffArtifact;
}): FundamentalReviewQueueArtifact {
  const targets = params.handoff.targetDecisions.map((target) => {
    const queueAction = deriveQueueAction(target.handoffDecision);
    const requestedMaterials = deriveRequestedMaterials(target);
    return {
      targetLabel: target.targetLabel,
      region: target.region,
      handoffDecision: target.handoffDecision,
      queueAction,
      reviewPriority: deriveReviewPriority(target),
      watchlistCandidate: target.handoffDecision !== "blocked",
      missingCriticalInputs: target.missingCriticalInputs,
      requestedMaterials,
      nextActions: deriveNextActions({
        target,
        requestedMaterials,
      }),
      documentPaths: target.documentPaths,
      notes: buildTargetNotes({
        target,
        queueAction,
      }),
    } satisfies ReviewQueueTarget;
  });

  const reviewPriorityOrder: Record<FundamentalReviewPriority, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  const summary = targets.reduce(
    (acc, target) => {
      if (target.queueAction === "deeper_review") {
        acc.deeperReviewTargets += 1;
      } else if (target.queueAction === "follow_up_missing_inputs") {
        acc.followUpTargets += 1;
      } else {
        acc.blockedTargets += 1;
      }
      if (target.watchlistCandidate) {
        acc.watchlistTargets += 1;
      }
      if (target.requestedMaterials.some((item) => item !== "document_metadata_sidecar")) {
        acc.missingDocumentsQueueItems += 1;
      }
      return acc;
    },
    {
      totalTargets: targets.length,
      deeperReviewTargets: 0,
      followUpTargets: 0,
      blockedTargets: 0,
      watchlistTargets: 0,
      missingDocumentsQueueItems: 0,
    },
  );

  const queueStatus: FundamentalReviewQueueStatus =
    summary.deeperReviewTargets === summary.totalTargets
      ? "deeper_review"
      : summary.deeperReviewTargets > 0 || summary.followUpTargets > 0
        ? "follow_up"
        : "blocked";

  const reviewPriorityRanking = targets
    .map((target) => ({
      targetLabel: target.targetLabel,
      reviewPriority: target.reviewPriority,
      queueAction: target.queueAction,
    }))
    .toSorted(
      (a, b) =>
        reviewPriorityOrder[b.reviewPriority] - reviewPriorityOrder[a.reviewPriority] ||
        a.targetLabel.localeCompare(b.targetLabel),
    );

  return {
    version: 1,
    generatedAt: params.nowIso,
    manifestId: params.handoff.manifestId,
    manifestPath: params.handoff.manifestPath,
    riskHandoffPath: params.riskHandoffPath,
    requestTitle: params.handoff.requestTitle,
    researchBranch: params.handoff.researchBranch,
    queueStatus,
    summary,
    watchlist: targets
      .filter((target) => target.watchlistCandidate)
      .map((target) => target.targetLabel),
    blockedList: targets
      .filter((target) => target.queueAction === "blocked")
      .map((target) => target.targetLabel),
    reviewPriorityRanking,
    followUpQueue: targets
      .filter((target) => target.queueAction === "follow_up_missing_inputs")
      .map((target) => ({
        targetLabel: target.targetLabel,
        reviewPriority: target.reviewPriority as Exclude<FundamentalReviewPriority, "low">,
        requestedMaterials: target.requestedMaterials,
        nextActions: target.nextActions,
      })),
    missingDocumentsQueue: targets
      .filter((target) =>
        target.requestedMaterials.some((item) => item !== "document_metadata_sidecar"),
      )
      .map((target) => ({
        targetLabel: target.targetLabel,
        requestedMaterials: target.requestedMaterials.filter(
          (item) => item !== "document_metadata_sidecar",
        ),
      })),
    targets,
    notes: buildArtifactNotes({
      queueStatus,
      deeperReviewTargets: summary.deeperReviewTargets,
      followUpTargets: summary.followUpTargets,
      blockedTargets: summary.blockedTargets,
    }),
  };
}

const materializeFundamentalReviewQueue: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { workspaceDir, memoryDir } = await resolveMemorySessionContext({ event });
    // Keep queue materialization on the same semantic path as the upstream
    // fallback helper. A prior bug let the materializer rebuild queue candidates
    // directly from risk handoffs plus ad-hoc artifact blocking, which made
    // seam-by-seam tests pass while end-to-end chain validation still landed on
    // a false happy path. Reuse the helper here so blocked/recovery semantics
    // stay manifest-scoped and identical for queue -> brief -> plan -> workbench.
    const entries = await loadReviewQueuesWithFallback(workspaceDir);
    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];

    if (entries.length === 0) {
      return;
    }

    await Promise.all(
      entries.map(async ({ reviewQueue }) => {
        const reviewQueuePath = buildFundamentalReviewChainJsonPath(
          "fundamental-review-queue",
          reviewQueue.manifestId,
        );
        const noteRelativePath = buildFundamentalReviewChainNoteFilename({
          dateStr,
          stageName: "fundamental-review-queue",
          manifestId: reviewQueue.manifestId,
        });
        await Promise.all([
          writeFileWithinRoot({
            rootDir: workspaceDir,
            relativePath: reviewQueuePath,
            data: `${JSON.stringify(reviewQueue, null, 2)}\n`,
            encoding: "utf-8",
          }),
          writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: noteRelativePath,
            data: renderReviewQueueNote({
              dateStr,
              timeStr,
              reviewQueuePath,
              reviewQueue,
            }),
            encoding: "utf-8",
          }),
        ]);
      }),
    );

    log.info(`Fundamental review queue materialized ${entries.length} queue candidate(s)`);
  } catch (err) {
    log.error("Failed to materialize fundamental review queue", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default materializeFundamentalReviewQueue;
