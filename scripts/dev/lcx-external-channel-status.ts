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

export async function runExternalChannelStatus(options: CliOptions) {
  const args = ["--import", "tsx", "scripts/dev/lcx-promote-live.ts", "--status", "--json"];
  if (options.withProbe) {
    args.push("--with-probe");
  }
  const command = `${process.execPath} ${args.join(" ")}`;
  const bindingArgs = ["--import", "tsx", "scripts/dev/lcx-external-channel-binding.ts", "--json"];
  const bindingCommand = `${process.execPath} ${bindingArgs.join(" ")}`;
  try {
    const [result, bindingResult] = await Promise.all([
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
    const legacy = parseJsonObjectFromOutput(result.stdout);
    const bindingPayload = parseJsonObjectFromOutput(bindingResult.stdout);
    const binding = recordValue(bindingPayload.externalChannelBinding);
    const legacyExternalChannelStatus = recordValue(legacy.externalChannelStatus);
    const bindingStatus = binding?.status;
    const bindingProvedChannelBound =
      bindingStatus === "channel_runtime_probe_ok_user_visible_pending";
    const bindingUserVisibleObserved = binding?.userVisibleObserved === true;
    const externalChannelStatus = {
      ...legacyExternalChannelStatus,
      externalChannelBound:
        bindingProvedChannelBound || legacyExternalChannelStatus?.externalChannelBound === true,
      userVisibleObserved:
        bindingUserVisibleObserved || legacyExternalChannelStatus?.userVisibleObserved === true,
      canonicalBindingStatus: bindingStatus,
      canonicalBindingMissingProof: binding?.missingProof,
      canonicalBindingSelectedCleanAdapter: binding?.selectedCleanAdapter,
      canonicalBindingOwner: "lcx-external-channel-binding",
    };
    return {
      ...legacy,
      ok: legacy.ok !== false,
      boundary: "dev_external_channel_status_only",
      owner: "lcx-external-channel-status",
      command,
      bindingCommand,
      conceptStatus: "legacy_promote_live_status_wrapped_by_external_channel_status",
      externalChannelStatus,
      externalChannelBinding: binding,
      legacyPromoteLiveStatus: {
        owner: "lcx-promote-live",
        boundary: legacy.boundary ?? "dev_external_channel_status_only",
        status: legacy.status,
        liveStatus: legacy.liveStatus,
        operatorStatus: legacy.operatorStatus,
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
