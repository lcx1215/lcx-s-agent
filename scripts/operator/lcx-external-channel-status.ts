import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;
const OWNER_CHILD_TIMEOUT_MS = 30_000;
const WORKSPACE_DIR = path.join(process.env.HOME ?? "", ".openclaw", "workspace");
const BINDING_LATEST_PATH = path.join(
  WORKSPACE_DIR,
  "state",
  "lcx-external-channel-binding-latest.json",
);
const EXTERNAL_CANDIDATE_ROOTS = [
  "memory/external-message-intent-candidates",
  "memory/external-brain-distillation-candidates",
] as const;
const EXTERNAL_REVIEW_ROOT = "memory/external-brain-distillation-reviews";
const EXTERNAL_HANDOFF_ROOT = "memory/external-message-handoff-receipts";

type CliOptions = {
  json: boolean;
  withProbe: boolean;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function externalChannelNextHumanStep(params: {
  externalChannelBound: boolean;
  userVisibleObserved: boolean;
  bindingStatus: unknown;
}): string {
  if (params.userVisibleObserved) {
    return "none_external_channel_user_visible_observed";
  }
  if (params.externalChannelBound) {
    return "send_real_external_canary_for_user_visible_proof";
  }
  if (params.bindingStatus === "ready_for_channel_bind_apply") {
    return "run_lcx_external_channel_binding_apply";
  }
  return "inspect_lcx_external_channel_binding_owner";
}

function externalChannelVisibleProof(legacyVisibleProof: Record<string, unknown> | undefined) {
  const canonicalReplyFlowProbeCommand =
    "node --import tsx scripts/operator/lcx-external-channel-status.ts --json --with-probe";
  const legacyReplyFlowProbeCommand =
    typeof legacyVisibleProof?.replyFlowProbeCommand === "string"
      ? legacyVisibleProof.replyFlowProbeCommand
      : "node --import tsx scripts/operator/lcx-external-channel-compat.ts --status --json --with-probe";
  return {
    ...legacyVisibleProof,
    status: legacyVisibleProof?.status ?? "unavailable",
    acceptanceMatched: legacyVisibleProof?.acceptanceMatched === true,
    replyFlowProbeCommand: canonicalReplyFlowProbeCommand,
    legacyReplyFlowProbeCommand,
  };
}

export function resolveExternalChannelTruth(params: {
  binding: Record<string, unknown> | undefined;
  legacyExternalChannelStatus: Record<string, unknown> | undefined;
  visibleProof: Record<string, unknown> | undefined;
  /** Set when the canonical binding owner was invoked this run. */
  bindingOwnerAvailable?: boolean;
}): {
  externalChannelBound: boolean;
  userVisibleObserved: boolean;
  bindingStatus: unknown;
  visibleProofObservation?: {
    reported: true;
    adoptedForCurrentBinding: false;
    reason: "binding_probe_or_visible_status_not_confirmed";
  };
} {
  const bindingStatus = params.binding?.status ?? "unavailable";
  const bindingOwnerInvoked = params.bindingOwnerAvailable !== undefined;
  const bindingAvailable = params.bindingOwnerAvailable ?? params.binding !== undefined;
  // Once the canonical owner was invoked, its unavailable result is authoritative.
  // Do not fall back to legacy evidence after an owner timeout/failure.
  const bindingAuthoritative = bindingOwnerInvoked || params.binding !== undefined;
  const bindingProvedChannelBound =
    bindingStatus === "channel_runtime_probe_ok_user_visible_pending" ||
    bindingStatus === "channel_runtime_probe_ok_user_visible_observed";
  const bindingVisibleClaimed = params.binding?.userVisibleObserved === true;
  const independentVisibleReported =
    bindingVisibleClaimed ||
    recordValue(params.binding?.visibleProofObservation)?.reported === true;
  const bindingUserVisibleObserved =
    bindingStatus === "channel_runtime_probe_ok_user_visible_observed" && bindingVisibleClaimed;
  const legacyExternalChannelBound =
    params.legacyExternalChannelStatus?.externalChannelBound === true;
  const legacyUserVisibleObserved =
    params.legacyExternalChannelStatus?.userVisibleObserved === true;
  const compatibilityVisibleProofObserved =
    legacyExternalChannelBound &&
    (params.visibleProof?.status === "live_visible_fixed" ||
      params.visibleProof?.status === "user_visible_observed") &&
    params.visibleProof?.acceptanceMatched === true;

  return {
    externalChannelBound: bindingAuthoritative
      ? bindingAvailable && bindingProvedChannelBound
      : legacyExternalChannelBound,
    userVisibleObserved: bindingAvailable
      ? bindingUserVisibleObserved
      : bindingAuthoritative
        ? false
        : legacyUserVisibleObserved || compatibilityVisibleProofObserved,
    bindingStatus,
    ...(bindingAvailable && independentVisibleReported && !bindingUserVisibleObserved
      ? {
          visibleProofObservation: {
            reported: true as const,
            adoptedForCurrentBinding: false as const,
            reason: "binding_probe_or_visible_status_not_confirmed" as const,
          },
        }
      : {}),
  };
}

function externalChannelDriftStatus(params: {
  legacyRepositoryDrift: Record<string, unknown> | undefined;
  externalChannelBound: boolean;
}) {
  if (!params.legacyRepositoryDrift) {
    return undefined;
  }
  const { devLiveDrift: legacyDriftState, ...canonicalDrift } = params.legacyRepositoryDrift;
  if (!params.externalChannelBound) {
    return {
      ...canonicalDrift,
      legacyLiveMatchesCurrentCanonical: params.legacyRepositoryDrift.liveMatchesCurrentCanonical,
      legacyLiveNeedsPromotion: params.legacyRepositoryDrift.liveNeedsPromotion,
      repositoryDrift: legacyDriftState,
    };
  }
  return {
    ...canonicalDrift,
    liveMatchesCurrentCanonical: true,
    liveNeedsPromotion: false,
    repositoryDrift: "external_channel_bound_legacy_commit_diff_ignored",
    legacyLiveMatchesCurrentCanonical: params.legacyRepositoryDrift.liveMatchesCurrentCanonical,
    legacyLiveNeedsPromotion: params.legacyRepositoryDrift.liveNeedsPromotion,
  };
}

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-external-channel-status.ts [--json] [--with-probe]",
      "",
      "Read-only external-channel status wrapper. It reads compatibility evidence from",
      "lcx-external-channel-compat.ts without making old live wording the owner.",
    ].join("\n"),
  );
}

export function parseExternalChannelStatusArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false, withProbe: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--with-probe") {
      options.withProbe = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function settledCommandText(result: PromiseSettledResult<{ stdout: string; stderr: string }>): {
  stdout: string;
  stderr?: string;
  error?: string;
} {
  if (result.status === "fulfilled") {
    return { stdout: result.value.stdout, stderr: result.value.stderr };
  }
  const reason = result.reason as { stdout?: string; stderr?: string; message?: string };
  return {
    stdout: reason.stdout ?? "",
    stderr: reason.stderr,
    error: [reason.message, reason.stderr?.slice(-1000)].filter(Boolean).join("\n"),
  };
}

function parseOptionalJsonObject(stdout: string): Record<string, unknown> {
  if (!stdout.trim()) {
    return {};
  }
  try {
    return parseJsonObjectFromOutput(stdout);
  } catch {
    return {};
  }
}

export function selectBindingOwnerPayload(params: {
  commandSucceeded: boolean;
  payload: Record<string, unknown>;
}): { payload: Record<string, unknown>; source: "command" | "unavailable" } {
  // The latest binding file is a write-side receipt and may be stale. It is
  // intentionally never used as a fallback for a failed or malformed owner run.
  if (!params.commandSucceeded || Object.keys(params.payload).length === 0) {
    return { payload: {}, source: "unavailable" };
  }
  return { payload: params.payload, source: "command" };
}

type ExternalCandidateCaptureStatus = {
  candidateRoots: string[];
  handoffRoot: string;
  handoffReceiptCount: number;
  candidateArtifactCount: number;
  reviewRoot: string;
  reviewArtifactCount: number;
  unmatchedReviewCandidateCount: number;
  excludedCandidateCount: number;
  teacherReviewAcceptedCount: number;
  teacherReviewRejectedCount: number;
  reviewedCandidateCount: number;
  pendingCandidateCount: number;
  invalidArtifactCount: number;
  candidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  discardedCandidateCount: number;
  latestCandidatePath: string | null;
  latestCandidateGeneratedAt: string | null;
  latestHandoffPath: string | null;
  currentReplay: {
    source: "candidate_artifacts" | "handoff_receipt_derived" | "none";
    candidateCount: number;
    rejectedRate: number;
  };
  replayLoop: {
    status:
      | "not_observed"
      | "needs_candidate_capture"
      | "needs_route_family_hardening"
      | "needs_review_promotion"
      | "ready_for_reviewed_batch_absorption";
    topRejectedReason: string | null;
    topRejectedSemanticFamily: string | null;
  };
};

async function listJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

function candidateEntries(value: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(value.candidates)) {
    return value.candidates.filter(
      (candidate): candidate is Record<string, unknown> =>
        candidate !== null && typeof candidate === "object" && !Array.isArray(candidate),
    );
  }
  return typeof value.id === "string" && value.id.trim().length > 0 ? [value] : [];
}

function captureDisposition(
  candidate: Record<string, unknown>,
): "accepted" | "rejected" | "discarded" | "pending" {
  if (candidate.status === "accepted_brain_plan" || candidate.status === "accepted") {
    return "accepted";
  }
  if (candidate.status === "rejected_brain_plan" || candidate.status === "rejected") {
    return "rejected";
  }
  return candidate.status === "discarded" ? "discarded" : "pending";
}

function candidateIdentity(candidate: Record<string, unknown>): string | undefined {
  return typeof candidate.id === "string" &&
    candidate.id.trim() &&
    typeof candidate.source === "string"
    ? JSON.stringify([candidate.source, candidate.id])
    : undefined;
}

/** Reads only supplied workspace artifacts; does not invoke channel/probe owners. */
export async function readExternalCandidateCapture(
  workspaceDir = WORKSPACE_DIR,
): Promise<ExternalCandidateCaptureStatus> {
  const candidateFiles = (
    await Promise.all(
      EXTERNAL_CANDIDATE_ROOTS.map((relativeRoot) =>
        listJsonFiles(path.join(workspaceDir, relativeRoot)),
      ),
    )
  ).flat();
  const reviewFiles = await listJsonFiles(path.join(workspaceDir, EXTERNAL_REVIEW_ROOT));
  const handoffFiles = await listJsonFiles(path.join(workspaceDir, EXTERNAL_HANDOFF_ROOT));
  const captures = new Map<
    string,
    {
      paths: Set<string>;
      dispositions: Set<ReturnType<typeof captureDisposition>>;
      reviews: Set<"accepted" | "rejected">;
    }
  >();
  let candidateArtifactCount = 0;
  let reviewArtifactCount = 0;
  let invalidArtifactCount = 0;
  let unmatchedReviewCandidateCount = 0;
  let excludedCandidateCount = 0;
  let latestCandidatePath: string | null = null;
  let latestCandidateGeneratedAt: string | null = null;
  const relativeArtifactPath = (file: string) =>
    path.relative(workspaceDir, file).split(path.sep).join("/");
  const artifacts = new Map<string, Record<string, unknown> | undefined>();
  const readArtifact = async (file: string) => {
    if (artifacts.has(file)) {
      return artifacts.get(file);
    }
    try {
      const parsed = recordValue(JSON.parse(await fs.readFile(file, "utf8")) as unknown);
      if (parsed) {
        artifacts.set(file, parsed);
        return parsed;
      }
    } catch {
      // Retain an invalid count without inventing a candidate from unreadable data.
    }
    invalidArtifactCount += 1;
    artifacts.set(file, undefined);
    return undefined;
  };
  for (const file of candidateFiles) {
    const parsed = await readArtifact(file);
    if (!parsed) {
      continue;
    }
    // A misplaced review is still read in the review pass, never as capture.
    if (parsed.boundary === "brain_distillation_review") {
      continue;
    }
    const candidates = candidateEntries(parsed);
    if (candidates.length === 0) {
      invalidArtifactCount += 1;
      continue;
    }
    let naturalEntries = 0;
    for (const candidate of candidates) {
      const identity = candidateIdentity(candidate);
      if (
        !identity ||
        !["api_reply", "external_visible_reply", "external_user_utterance"].includes(
          String(candidate.source),
        )
      ) {
        excludedCandidateCount += 1;
        continue;
      }
      naturalEntries += 1;
      const capture = captures.get(identity) ?? {
        paths: new Set<string>(),
        dispositions: new Set<ReturnType<typeof captureDisposition>>(),
        reviews: new Set<"accepted" | "rejected">(),
      };
      capture.paths.add(relativeArtifactPath(file));
      capture.dispositions.add(captureDisposition(candidate));
      captures.set(identity, capture);
    }
    if (naturalEntries === 0) {
      continue;
    }
    candidateArtifactCount += 1;
    const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : null;
    if (generatedAt && (!latestCandidateGeneratedAt || generatedAt > latestCandidateGeneratedAt)) {
      latestCandidateGeneratedAt = generatedAt;
      latestCandidatePath = relativeArtifactPath(file);
    }
  }
  const teacherReviews = new Map<string, Set<"accepted" | "rejected">>();
  for (const file of [...reviewFiles, ...candidateFiles]) {
    const parsed = await readArtifact(file);
    if (!parsed || parsed.boundary !== "brain_distillation_review") {
      continue;
    }
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.sourceArtifacts) ||
      !Array.isArray(parsed.acceptedCandidates) ||
      !Array.isArray(parsed.rejectedCandidates)
    ) {
      invalidArtifactCount += 1;
      continue;
    }
    reviewArtifactCount += 1;
    const sources = new Set(
      parsed.sourceArtifacts
        .filter((source): source is string => typeof source === "string")
        .map((source) => relativeArtifactPath(path.resolve(workspaceDir, source))),
    );
    for (const [entries, verdict] of [
      [parsed.acceptedCandidates, "accepted"],
      [parsed.rejectedCandidates, "rejected"],
    ] as const) {
      for (const entry of entries) {
        const candidate = recordValue(entry);
        const identity = candidate && candidateIdentity(candidate);
        if (!identity || !candidate) {
          unmatchedReviewCandidateCount += 1;
          continue;
        }
        if (candidate.source === "teacher_review") {
          const verdicts = teacherReviews.get(identity) ?? new Set<"accepted" | "rejected">();
          verdicts.add(verdict);
          teacherReviews.set(identity, verdicts);
          continue;
        }
        const capture = captures.get(identity);
        if (!capture || ![...capture.paths].some((source) => sources.has(source))) {
          unmatchedReviewCandidateCount += 1;
          continue;
        }
        capture.reviews.add(verdict);
      }
    }
  }
  let acceptedCandidateCount = 0;
  let rejectedCandidateCount = 0;
  let discardedCandidateCount = 0;
  let pendingCandidateCount = 0;
  for (const capture of captures.values()) {
    const terminal = new Set([...capture.dispositions].filter((value) => value !== "pending"));
    for (const review of capture.reviews) {
      terminal.add(review);
    }
    // Conflicting dispositions fail closed instead of depending on directory order.
    if (terminal.size !== 1) {
      pendingCandidateCount += 1;
    } else if (terminal.has("accepted")) {
      acceptedCandidateCount += 1;
    } else if (terminal.has("rejected")) {
      rejectedCandidateCount += 1;
    } else {
      discardedCandidateCount += 1;
    }
  }
  const candidateCount = captures.size;
  const reviewedCandidateCount = acceptedCandidateCount + rejectedCandidateCount;
  const teacherReviewAcceptedCount = [...teacherReviews.values()].filter(
    (values) => values.size === 1 && values.has("accepted"),
  ).length;
  const teacherReviewRejectedCount = [...teacherReviews.values()].filter(
    (values) => values.size === 1 && values.has("rejected"),
  ).length;
  let latestHandoffPath: string | null = null;
  if (handoffFiles.length > 0) {
    const latestHandoffFile = handoffFiles.toSorted().at(-1);
    if (latestHandoffFile) {
      latestHandoffPath = path.relative(workspaceDir, latestHandoffFile).replaceAll(path.sep, "/");
    }
  }
  const rejectedRate =
    reviewedCandidateCount > 0
      ? Number((rejectedCandidateCount / reviewedCandidateCount).toFixed(4))
      : 0;
  const source =
    candidateArtifactCount > 0
      ? "candidate_artifacts"
      : handoffFiles.length > 0
        ? "handoff_receipt_derived"
        : "none";
  const status =
    candidateArtifactCount === 0
      ? handoffFiles.length > 0 || reviewArtifactCount > 0
        ? "needs_candidate_capture"
        : "not_observed"
      : rejectedRate >= 0.3
        ? "needs_route_family_hardening"
        : acceptedCandidateCount === 0 || reviewedCandidateCount < 10 || pendingCandidateCount > 0
          ? "needs_review_promotion"
          : "ready_for_reviewed_batch_absorption";
  return {
    candidateRoots: [...EXTERNAL_CANDIDATE_ROOTS],
    handoffRoot: EXTERNAL_HANDOFF_ROOT,
    handoffReceiptCount: handoffFiles.length,
    candidateArtifactCount,
    reviewRoot: EXTERNAL_REVIEW_ROOT,
    reviewArtifactCount,
    unmatchedReviewCandidateCount,
    excludedCandidateCount,
    teacherReviewAcceptedCount,
    teacherReviewRejectedCount,
    reviewedCandidateCount,
    pendingCandidateCount,
    invalidArtifactCount,
    candidateCount,
    acceptedCandidateCount,
    rejectedCandidateCount,
    discardedCandidateCount,
    latestCandidatePath,
    latestCandidateGeneratedAt,
    latestHandoffPath,
    currentReplay: {
      source,
      candidateCount: candidateArtifactCount > 0 ? candidateCount : 0,
      rejectedRate,
    },
    replayLoop: {
      status,
      topRejectedReason: null,
      topRejectedSemanticFamily: null,
    },
  };
}

export async function runExternalChannelStatus(options: CliOptions) {
  const args = [
    "--import",
    "tsx",
    "scripts/operator/lcx-external-channel-compat.ts",
    "--status",
    "--json",
  ];
  if (options.withProbe) {
    args.push("--with-probe");
  }
  const command = `${process.execPath} ${args.join(" ")}`;
  const bindingArgs = [
    "--import",
    "tsx",
    "scripts/operator/lcx-external-channel-binding.ts",
    "--json",
  ];
  const bindingCommand = `${process.execPath} ${bindingArgs.join(" ")}`;
  try {
    const [legacyResult, bindingResult] = await Promise.allSettled([
      execFileAsync(process.execPath, args, {
        cwd: REPO_ROOT,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
        timeout: OWNER_CHILD_TIMEOUT_MS,
        killSignal: "SIGTERM",
      }),
      execFileAsync(process.execPath, bindingArgs, {
        cwd: REPO_ROOT,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
        timeout: OWNER_CHILD_TIMEOUT_MS,
        killSignal: "SIGTERM",
      }),
    ]);
    const legacyOutput = settledCommandText(legacyResult);
    const bindingOutput = settledCommandText(bindingResult);
    const legacy = parseOptionalJsonObject(legacyOutput.stdout);
    const liveBindingPayload = parseOptionalJsonObject(bindingOutput.stdout);
    const selectedBindingPayload = selectBindingOwnerPayload({
      commandSucceeded: bindingResult.status === "fulfilled",
      payload: liveBindingPayload,
    });
    const bindingPayload = selectedBindingPayload.payload;
    const binding = recordValue(bindingPayload.externalChannelBinding);
    const bindingOwnerAvailable =
      selectedBindingPayload.source === "command" && binding !== undefined;
    const legacyExternalChannelStatus = recordValue(legacy.externalChannelStatus);
    const visibleProof = externalChannelVisibleProof(recordValue(legacy.visibleProof));
    const legacyRepositoryDrift = recordValue(legacy.devLiveDrift);
    const { bindingStatus, externalChannelBound, userVisibleObserved, visibleProofObservation } =
      resolveExternalChannelTruth({
        binding,
        legacyExternalChannelStatus,
        visibleProof,
        bindingOwnerAvailable,
      });
    const externalChannelStatus = {
      ...legacyExternalChannelStatus,
      statusModel: "core-ready -> external-channel-bound -> user-visible-observed",
      externalChannelBound,
      userVisibleObserved,
      nextHumanStep: externalChannelNextHumanStep({
        externalChannelBound,
        userVisibleObserved,
        bindingStatus,
      }),
      canonicalBindingStatus: bindingStatus,
      canonicalBindingMissingProof: userVisibleObserved ? [] : binding?.missingProof,
      canonicalBindingSelectedCleanAdapter: binding?.selectedCleanAdapter,
      canonicalBindingOwner: "lcx-external-channel-binding",
      ...(visibleProofObservation ? { visibleProofObservation } : {}),
    };
    const externalCandidateCapture = await readExternalCandidateCapture();
    return {
      ok: bindingOwnerAvailable && bindingPayload.ok !== false,
      boundary: "local_external_channel_status_only",
      owner: "lcx-external-channel-status",
      command,
      bindingCommand,
      conceptStatus: "legacy_promote_live_status_wrapped_by_external_channel_status",
      externalChannelStatus,
      externalCandidateCapture,
      externalChannelBinding: binding,
      ownerChildStatus: {
        timeoutMs: OWNER_CHILD_TIMEOUT_MS,
        legacyStatusAvailable: Object.keys(legacy).length > 0,
        bindingStatusAvailable: bindingOwnerAvailable,
        bindingStatusSource: selectedBindingPayload.source,
        bindingLatestPath: BINDING_LATEST_PATH,
        legacyError: legacyOutput.error,
        bindingError:
          bindingOutput.error ??
          (bindingResult.status === "fulfilled" && selectedBindingPayload.source === "unavailable"
            ? bindingOutput.stdout.trim()
              ? "binding owner returned empty or non-JSON output"
              : "binding owner returned no JSON output"
            : undefined),
      },
      canonicalWorktreeDrift: externalChannelDriftStatus({
        legacyRepositoryDrift,
        externalChannelBound,
      }),
      visibleProof,
      legacyPromoteLiveStatus: {
        owner: "lcx-external-channel-compat",
        boundary: legacy.boundary ?? "local_external_channel_status_only",
        status: legacy.status,
        liveStatus: legacy.liveStatus,
        operatorStatus: legacy.operatorStatus,
        devLiveDrift: legacyRepositoryDrift,
        visibleProof: legacy.visibleProof,
        error: legacyOutput.error,
      },
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      boundary: "local_external_channel_status_only",
      owner: "lcx-external-channel-status",
      command,
      conceptStatus: "legacy_promote_live_status_wrapped_by_external_channel_status",
      error: [details.message, details.stderr?.slice(-1000)].filter(Boolean).join("\n"),
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  }
}

export function printExternalChannelStatusPayload(payload: unknown, options: CliOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const status =
    record.externalChannelStatus &&
    typeof record.externalChannelStatus === "object" &&
    !Array.isArray(record.externalChannelStatus)
      ? (record.externalChannelStatus as Record<string, unknown>).statusModel
      : "unknown";
  const boundary = typeof record.boundary === "string" ? record.boundary : "unknown";
  const statusModel = typeof status === "string" ? status : "unknown";
  process.stdout.write(
    [
      `ok=${record.ok === true}`,
      `boundary=${boundary}`,
      `statusModel=${statusModel}`,
      `liveTouched=${record.liveTouched === true}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseExternalChannelStatusArgs(process.argv.slice(2));
  const payload = await runExternalChannelStatus(options);
  printExternalChannelStatusPayload(payload, options);
}
