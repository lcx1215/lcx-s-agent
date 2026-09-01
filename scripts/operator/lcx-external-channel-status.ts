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
}): { externalChannelBound: boolean; userVisibleObserved: boolean; bindingStatus: unknown } {
  const bindingStatus = params.binding?.status ?? "unavailable";
  const bindingAvailable = params.binding !== undefined;
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
    externalChannelBound: bindingAvailable ? bindingProvedChannelBound : legacyExternalChannelBound,
    userVisibleObserved: bindingAvailable
      ? bindingUserVisibleObserved
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

async function readLatestBindingSnapshot(): Promise<Record<string, unknown>> {
  try {
    const text = await fs.readFile(BINDING_LATEST_PATH, "utf8");
    return parseOptionalJsonObject(text);
  } catch {
    return {};
  }
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
    const latestBindingSnapshot =
      Object.keys(liveBindingPayload).length > 0 ? {} : await readLatestBindingSnapshot();
    const bindingPayload =
      Object.keys(liveBindingPayload).length > 0 ? liveBindingPayload : latestBindingSnapshot;
    const binding = recordValue(bindingPayload.externalChannelBinding);
    const legacyExternalChannelStatus = recordValue(legacy.externalChannelStatus);
    const visibleProof = externalChannelVisibleProof(recordValue(legacy.visibleProof));
    const legacyRepositoryDrift = recordValue(legacy.devLiveDrift);
    const { bindingStatus, externalChannelBound, userVisibleObserved } =
      resolveExternalChannelTruth({
        binding,
        legacyExternalChannelStatus,
        visibleProof,
      });
    const externalChannelStatus = {
      ...legacyExternalChannelStatus,
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
    return {
      ok: bindingPayload.ok !== false,
      boundary: "local_external_channel_status_only",
      owner: "lcx-external-channel-status",
      command,
      bindingCommand,
      conceptStatus: "legacy_promote_live_status_wrapped_by_external_channel_status",
      externalChannelStatus,
      externalChannelBinding: binding,
      ownerChildStatus: {
        timeoutMs: OWNER_CHILD_TIMEOUT_MS,
        legacyStatusAvailable: Object.keys(legacy).length > 0,
        bindingStatusAvailable: Object.keys(bindingPayload).length > 0,
        bindingStatusSource:
          Object.keys(liveBindingPayload).length > 0
            ? "command"
            : Object.keys(latestBindingSnapshot).length > 0
              ? "latest_snapshot"
              : "unavailable",
        bindingLatestPath: BINDING_LATEST_PATH,
        legacyError: legacyOutput.error,
        bindingError: bindingOutput.error,
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
