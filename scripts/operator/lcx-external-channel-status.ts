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
  if (!legacyVisibleProof) {
    return undefined;
  }
  return {
    ...legacyVisibleProof,
    replyFlowProbeCommand:
      "node --import tsx scripts/operator/lcx-external-channel-status.ts --json --with-probe",
    legacyReplyFlowProbeCommand: legacyVisibleProof.replyFlowProbeCommand,
  };
}

export function resolveExternalChannelTruth(params: {
  binding: Record<string, unknown> | undefined;
  legacyExternalChannelStatus: Record<string, unknown> | undefined;
  visibleProof: Record<string, unknown> | undefined;
  /** Set when the canonical binding owner was invoked this run. */
  bindingOwnerAvailable?: boolean;
}): { externalChannelBound: boolean; userVisibleObserved: boolean; bindingStatus: unknown } {
  const bindingStatus = params.binding?.status ?? "unavailable";
  const bindingOwnerInvoked = params.bindingOwnerAvailable !== undefined;
  const bindingAvailable = params.bindingOwnerAvailable ?? params.binding !== undefined;
  // Once the canonical owner was invoked, its unavailable result is authoritative.
  // Do not fall back to legacy evidence after an owner timeout/failure.
  const bindingAuthoritative = bindingOwnerInvoked || params.binding !== undefined;
  const bindingProvedChannelBound =
    bindingStatus === "channel_runtime_probe_ok_user_visible_pending" ||
    bindingStatus === "channel_runtime_probe_ok_user_visible_observed";
  const bindingUserVisibleObserved = params.binding?.userVisibleObserved === true;
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

function candidateStatusCounts(candidates: readonly Record<string, unknown>[]) {
  let accepted = 0;
  let rejected = 0;
  let discarded = 0;
  for (const candidate of candidates) {
    const status = typeof candidate.status === "string" ? candidate.status : "";
    if (status === "accepted_brain_plan" || status === "accepted") {
      accepted += 1;
    } else if (status === "rejected_brain_plan" || status === "rejected") {
      rejected += 1;
    } else if (status === "discarded") {
      discarded += 1;
    }
  }
  return { accepted, rejected, discarded };
}

async function readExternalCandidateCapture(): Promise<ExternalCandidateCaptureStatus> {
  const candidateFiles = (
    await Promise.all(
      EXTERNAL_CANDIDATE_ROOTS.map((relativeRoot) =>
        listJsonFiles(path.join(WORKSPACE_DIR, relativeRoot)),
      ),
    )
  ).flat();
  const handoffFiles = await listJsonFiles(path.join(WORKSPACE_DIR, EXTERNAL_HANDOFF_ROOT));
  let candidateArtifactCount = 0;
  let invalidArtifactCount = 0;
  let candidateCount = 0;
  let acceptedCandidateCount = 0;
  let rejectedCandidateCount = 0;
  let discardedCandidateCount = 0;
  let latestCandidatePath: string | null = null;
  let latestCandidateGeneratedAt: string | null = null;
  for (const file of candidateFiles) {
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      const record = recordValue(value);
      if (!record) {
        invalidArtifactCount += 1;
        continue;
      }
      parsed = record;
    } catch {
      invalidArtifactCount += 1;
      continue;
    }
    const candidates = candidateEntries(parsed);
    if (candidates.length === 0) {
      invalidArtifactCount += 1;
      continue;
    }
    candidateArtifactCount += 1;
    candidateCount += candidates.length;
    const counts = candidateStatusCounts(candidates);
    acceptedCandidateCount += counts.accepted;
    rejectedCandidateCount += counts.rejected;
    discardedCandidateCount += counts.discarded;
    const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : null;
    if (generatedAt && (!latestCandidateGeneratedAt || generatedAt > latestCandidateGeneratedAt)) {
      latestCandidateGeneratedAt = generatedAt;
      latestCandidatePath = path.relative(WORKSPACE_DIR, file).replaceAll(path.sep, "/");
    }
  }
  let latestHandoffPath: string | null = null;
  if (handoffFiles.length > 0) {
    const latestHandoffFile = handoffFiles.toSorted().at(-1);
    if (latestHandoffFile) {
      latestHandoffPath = path.relative(WORKSPACE_DIR, latestHandoffFile).replaceAll(path.sep, "/");
    }
  }
  const rejectedRate =
    candidateCount > 0 ? Number((rejectedCandidateCount / candidateCount).toFixed(4)) : 0;
  const source =
    candidateArtifactCount > 0
      ? "candidate_artifacts"
      : handoffFiles.length > 0
        ? "handoff_receipt_derived"
        : "none";
  const status =
    candidateArtifactCount === 0
      ? handoffFiles.length > 0
        ? "needs_candidate_capture"
        : "not_observed"
      : rejectedRate >= 0.3
        ? "needs_route_family_hardening"
        : candidateArtifactCount > 0 && (acceptedCandidateCount === 0 || candidateCount < 10)
          ? "needs_review_promotion"
          : "ready_for_reviewed_batch_absorption";
  return {
    candidateRoots: [...EXTERNAL_CANDIDATE_ROOTS],
    handoffRoot: EXTERNAL_HANDOFF_ROOT,
    handoffReceiptCount: handoffFiles.length,
    candidateArtifactCount,
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
    const { bindingStatus, externalChannelBound, userVisibleObserved } =
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
