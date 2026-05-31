import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

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
    return "send_real_lark_canary_for_user_visible_proof";
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
      "node --import tsx scripts/dev/lcx-external-channel-status.ts --json --with-probe",
    legacyReplyFlowProbeCommand: legacyVisibleProof.replyFlowProbeCommand,
  };
}

function externalChannelDriftStatus(params: {
  legacyDevLiveDrift: Record<string, unknown> | undefined;
  externalChannelBound: boolean;
}) {
  if (!params.legacyDevLiveDrift) {
    return undefined;
  }
  if (!params.externalChannelBound) {
    return {
      ...params.legacyDevLiveDrift,
      legacyLiveMatchesCurrentDev: params.legacyDevLiveDrift.liveMatchesCurrentDev,
      legacyLiveNeedsPromotion: params.legacyDevLiveDrift.liveNeedsPromotion,
      legacyDevLiveDrift: params.legacyDevLiveDrift.devLiveDrift,
    };
  }
  return {
    ...params.legacyDevLiveDrift,
    liveMatchesCurrentDev: true,
    liveNeedsPromotion: false,
    devLiveDrift: "external_channel_bound_legacy_commit_diff_ignored",
    legacyLiveMatchesCurrentDev: params.legacyDevLiveDrift.liveMatchesCurrentDev,
    legacyLiveNeedsPromotion: params.legacyDevLiveDrift.liveNeedsPromotion,
    legacyDevLiveDrift: params.legacyDevLiveDrift.devLiveDrift,
  };
}

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-external-channel-status.ts [--json] [--with-probe]",
      "",
      "Read-only external-channel status wrapper. It preserves the legacy promote-live",
      "status surface as compatibility evidence without making old live wording the owner.",
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
    } else if (arg === "--status") {
      // Compatibility with old lcx-promote-live status invocations.
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

export async function runExternalChannelStatus(options: CliOptions) {
  const args = ["--import", "tsx", "scripts/dev/lcx-promote-live.ts", "--status", "--json"];
  if (options.withProbe) {
    args.push("--with-probe");
  }
  const command = `${process.execPath} ${args.join(" ")}`;
  const bindingArgs = ["--import", "tsx", "scripts/dev/lcx-external-channel-binding.ts", "--json"];
  const bindingCommand = `${process.execPath} ${bindingArgs.join(" ")}`;
  try {
    const [legacyResult, bindingResult] = await Promise.allSettled([
      execFileAsync(process.execPath, args, {
        cwd: REPO_ROOT,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
      }),
      execFileAsync(process.execPath, bindingArgs, {
        cwd: REPO_ROOT,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
      }),
    ]);
    const legacyOutput = settledCommandText(legacyResult);
    const bindingOutput = settledCommandText(bindingResult);
    const legacy = legacyOutput.stdout ? parseJsonObjectFromOutput(legacyOutput.stdout) : {};
    const bindingPayload = parseJsonObjectFromOutput(bindingOutput.stdout);
    const binding = recordValue(bindingPayload.externalChannelBinding);
    const legacyExternalChannelStatus = recordValue(legacy.externalChannelStatus);
    const visibleProof = externalChannelVisibleProof(recordValue(legacy.visibleProof));
    const legacyDevLiveDrift = recordValue(legacy.devLiveDrift);
    const bindingStatus = binding?.status;
    const bindingProvedChannelBound =
      bindingStatus === "channel_runtime_probe_ok_user_visible_pending" ||
      bindingStatus === "channel_runtime_probe_ok_user_visible_observed";
    const bindingUserVisibleObserved = binding?.userVisibleObserved === true;
    const externalChannelBound =
      bindingProvedChannelBound || legacyExternalChannelStatus?.externalChannelBound === true;
    const visibleProofUserVisibleObserved =
      externalChannelBound &&
      visibleProof?.status === "live_visible_fixed" &&
      visibleProof.acceptanceMatched === true;
    const userVisibleObserved =
      bindingUserVisibleObserved ||
      legacyExternalChannelStatus?.userVisibleObserved === true ||
      visibleProofUserVisibleObserved;
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
      ...legacy,
      ok: bindingPayload.ok !== false,
      boundary: "dev_external_channel_status_only",
      owner: "lcx-external-channel-status",
      command,
      bindingCommand,
      conceptStatus: "legacy_promote_live_status_wrapped_by_external_channel_status",
      externalChannelStatus,
      externalChannelBinding: binding,
      devLiveDrift: externalChannelDriftStatus({
        legacyDevLiveDrift,
        externalChannelBound,
      }),
      visibleProof,
      legacyPromoteLiveStatus: {
        owner: "lcx-promote-live",
        boundary: legacy.boundary ?? "dev_external_channel_status_only",
        status: legacy.status,
        liveStatus: legacy.liveStatus,
        operatorStatus: legacy.operatorStatus,
        devLiveDrift: legacyDevLiveDrift,
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
      boundary: "dev_external_channel_status_only",
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
