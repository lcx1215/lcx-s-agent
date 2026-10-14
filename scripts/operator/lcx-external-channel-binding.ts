import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { LCX_USER_HOME } from "./lcx-local-paths.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_SIDECAR_ROOT = path.join(
  LCX_USER_HOME,
  ".openclaw",
  "external-channel-runtime",
  "lcx-s-openclaw",
);
const DEFAULT_SNAPSHOT_PATH = path.join(
  LCX_USER_HOME,
  ".openclaw",
  "workspace",
  "state",
  "lcx-external-channel-binding-latest.json",
);
const SYNC_DOCTOR = path.join(
  LCX_USER_HOME,
  ".codex",
  "skills",
  "live-sidecar-sync-doctor",
  "scripts",
  "live-sidecar-sync-doctor.sh",
);
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = (() => {
  const value = Number(process.env.LCX_EXTERNAL_CHANNEL_COMMAND_TIMEOUT_MS ?? "");
  return Number.isFinite(value) && value > 0 ? value : 90_000;
})();
const SIDECAR_BUILD_TIMEOUT_MS = 600_000;

type JsonRecord = Record<string, unknown>;

type ExternalVisibleProofObservation = {
  reported: true;
  adoptedForCurrentBinding: false;
  reason: "current_binding_probe_failed";
};

type BindingDecision = {
  status:
    | "blocked_missing_training_plan"
    | "deferred_active_training_or_eval"
    | "deferred_training_plan_not_ready"
    | "ready_for_apply"
    | "applied_runtime_probe_ok"
    | "applied_runtime_user_visible_observed"
    | "applied_runtime_probe_failed";
  action:
    | "fix_training_plan_owner_first"
    | "wait_for_current_eval_then_bind_live_to_selected_clean_adapter"
    | "wait_for_training_plan_live_binding_ready"
    | "run_apply_when_operator_allows_live_runtime_restart"
    | "keep_waiting_for_real_external_user_seen_proof"
    | "no_action_external_channel_user_visible_observed"
    | "debug_live_runtime_probe_before_claiming_bound";
  selectedCleanAdapter?: string;
  missingProof: string[];
  heavyActive: boolean;
  activeProcessSummary: Array<{ pid?: number; role?: string; elapsed?: string }>;
  userVisibleObserved: boolean;
  visibleProofObservation?: ExternalVisibleProofObservation;
  /** @deprecated Boundary projection for historical binding receipts. */
  liveUserSeen: boolean;
  liveTouched: boolean;
  providerConfigTouched: false;
  protectedMemoryTouched: false;
};

type ExternalChannelBindingSummary = {
  boundary: "local_external_channel_binding_operator_only";
  channel: "external";
  role: "owner_agent_communication_medium";
  objective: "external_receives_current_best_verified_lcx_agent_answer";
  selectedCleanAdapter?: string;
  status:
    | "blocked_missing_training_plan"
    | "deferred_active_training_or_eval"
    | "deferred_training_plan_not_ready"
    | "ready_for_channel_bind_apply"
    | "channel_runtime_probe_ok_user_visible_pending"
    | "channel_runtime_probe_ok_user_visible_observed"
    | "channel_runtime_probe_failed";
  action:
    | "fix_training_plan_owner_first"
    | "wait_for_current_eval_then_route_external_transport_to_selected_clean_answer_path"
    | "wait_for_training_plan_external_channel_ready"
    | "run_apply_when_operator_allows_external_channel_restart"
    | "keep_waiting_for_real_external_user_visible_proof"
    | "none_external_channel_user_visible_observed"
    | "debug_external_channel_probe_before_claiming_user_visible";
  missingProof: string[];
  userVisibleObserved: boolean;
  visibleProofObservation?: ExternalVisibleProofObservation;
  legacyLiveCompatibility: {
    legacyScript: "lcx-external-channel-binding";
    legacyDecisionStatus: BindingDecision["status"];
    legacyLiveUserSeen: boolean;
  };
};

type CliOptions = {
  json: boolean;
  apply: boolean;
  compatibilityOnly: boolean;
  snapshotPath: string;
  sidecarRoot: string;
  localVerificationReceipt?: string;
  localVerificationTestResultSha256?: string;
  /** Independent host root, never selected by the receipt. */
  localVerificationSourceRoot?: string;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-external-channel-binding.ts [--json] [--apply | --compatibility-only]",
      "",
      "External-channel operator for making the External transport route to the selected clean LCX answer path.",
      "The historical live script name is legacy compatibility; External is the owner-agent communication medium, not a brain.",
      "Default is read-only. --apply is allowed only when local-brain-training-plan exposes",
      "externalChannelBinding.status=ready_for_apply and no eval/MLX process is active.",
    ].join("\n"),
  );
}

export function parseExternalChannelBindingArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    apply: false,
    compatibilityOnly: false,
    snapshotPath: DEFAULT_SNAPSHOT_PATH,
    sidecarRoot: DEFAULT_SIDECAR_ROOT,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--compatibility-only") {
      options.compatibilityOnly = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--snapshot-path") {
      const value = args[index + 1];
      if (!value) {
        usage();
      }
      options.snapshotPath = path.resolve(value);
      index += 1;
    } else if (
      arg === "--local-verification-receipt" ||
      arg === "--local-verification-test-result-sha256"
    ) {
      const value = args[index + 1];
      if (!value) {
        usage();
      }
      if (arg === "--local-verification-receipt") {
        options.localVerificationReceipt = path.resolve(value);
      } else {
        options.localVerificationTestResultSha256 = value;
      }
      index += 1;
    } else if (arg === "--sidecar-root") {
      const value = args[index + 1];
      if (!value) {
        usage();
      }
      options.sidecarRoot = path.resolve(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (options.compatibilityOnly && !args.includes("--snapshot-path")) {
    options.snapshotPath = path.join(
      path.dirname(DEFAULT_SNAPSHOT_PATH),
      "lcx-external-channel-compatibility-latest.json",
    );
  }
  if (options.compatibilityOnly && options.apply) {
    throw new Error("--compatibility-only cannot apply or restart a channel runtime");
  }
  return options;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function externalChannelStatusSucceeded(value: JsonRecord | undefined): boolean {
  if (!value || value.ok === false) {
    return false;
  }
  if (value.ok === true) {
    return true;
  }
  const channels = recordValue(value.channels);
  const channel = recordValue(channels?.external);
  if (channel?.configured === true && channel.enabled !== false) {
    return true;
  }
  const channelAccounts = recordValue(value.channelAccounts);
  const accounts = channelAccounts?.external;
  return (
    Array.isArray(accounts) &&
    accounts.some((entry) => {
      const account = recordValue(entry);
      return account?.configured === true && account.enabled !== false;
    })
  );
}

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRecord;
  } catch {
    return undefined;
  }
}

/**
 * Element type of `activeProcesses` entries that survived `recordValue`. Spelled with
 * required-but-nullable fields so the `filter` predicate below is assignable to the
 * mapped element type; an optional-field spelling fails that assignability check.
 */
type ActiveProcessEntry = {
  pid: number | undefined;
  role: string | undefined;
  elapsed: string | undefined;
};

function activeProcessSummary(trainingPlan: JsonRecord | undefined) {
  const activeProcesses = Array.isArray(trainingPlan?.activeProcesses)
    ? trainingPlan.activeProcesses
    : [];
  return activeProcesses
    .map((entry): ActiveProcessEntry | undefined => {
      const record = recordValue(entry);
      if (!record) {
        return undefined;
      }
      return {
        pid: typeof record.pid === "number" ? record.pid : undefined,
        role: stringValue(record.role),
        elapsed: stringValue(record.elapsed),
      };
    })
    .filter((entry): entry is ActiveProcessEntry => Boolean(entry));
}

function sidecarDriftIsZero(summary: string | undefined): boolean {
  return summary?.includes("missing=0") === true && summary.includes("different=0");
}

const RUNTIME_PROOF_NAMES = [
  "external_channel_source_drift_zero_after_selected_adapter",
  "external_message_channel_gateway_restarted_after_selected_adapter",
  "external_message_channel_status_ok_after_restart",
  "live_sidecar_source_drift_zero_after_selected_adapter",
  "live_gateway_and_external_proxy_restarted_after_selected_adapter",
  "live_external_channel_status_ok_after_restart",
];

function requireRuntimeApply(decision: BindingDecision): BindingDecision {
  return {
    ...decision,
    status: "ready_for_apply",
    action: "run_apply_when_operator_allows_live_runtime_restart",
    missingProof: Array.from(
      new Set([...RUNTIME_PROOF_NAMES.slice(0, 3), ...decision.missingProof]),
    ),
  };
}

function removeRuntimeProofNames(missingProof: string[]): string[] {
  return missingProof.filter((entry) => !RUNTIME_PROOF_NAMES.includes(entry));
}

export function buildExternalChannelBindingDecision(params: {
  trainingPlan?: JsonRecord;
  apply: boolean;
  externalChannelStatusOk?: boolean;
  userVisibleObserved?: boolean;
  liveTouched: boolean;
}): BindingDecision {
  const binding =
    recordValue(params.trainingPlan?.externalChannelBinding) ??
    recordValue(params.trainingPlan?.liveExternalBrainBinding);
  const active = activeProcessSummary(params.trainingPlan);
  const heavyActive = active.some(
    (entry) => entry.role === "local_brain_eval" || entry.role === "mlx",
  );
  const selectedCleanAdapter = stringValue(binding?.selectedCleanAdapter);
  const missingProof = stringArray(binding?.missingProof);
  const bindingStatus = stringValue(binding?.status);
  const userVisibleObserved = params.userVisibleObserved === true;
  const missingAfterUserVisibleProof = missingProof.filter(
    (entry) =>
      externalProofName(entry) !== "fresh_real_external_inbound_and_outbound_user_visible_observed",
  );
  const missingAfterRuntimeAndUserVisibleProof = removeRuntimeProofNames(
    missingAfterUserVisibleProof,
  );

  if (!params.trainingPlan || !binding) {
    return {
      status: "blocked_missing_training_plan",
      action: "fix_training_plan_owner_first",
      missingProof: ["training_plan_external_message_channel_binding"],
      heavyActive,
      activeProcessSummary: active,
      userVisibleObserved: false,
      liveUserSeen: false,
      liveTouched: params.liveTouched,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  }

  if (heavyActive) {
    return {
      status: "deferred_active_training_or_eval",
      action: "wait_for_current_eval_then_bind_live_to_selected_clean_adapter",
      selectedCleanAdapter,
      missingProof,
      heavyActive,
      activeProcessSummary: active,
      userVisibleObserved: false,
      liveUserSeen: false,
      liveTouched: params.liveTouched,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  }

  if (
    bindingStatus === "channel_runtime_probe_ok_user_visible_pending" ||
    bindingStatus === "channel_runtime_probe_ok_user_visible_observed"
  ) {
    if (userVisibleObserved) {
      return {
        status: "applied_runtime_user_visible_observed",
        action: "no_action_external_channel_user_visible_observed",
        selectedCleanAdapter,
        missingProof: missingAfterRuntimeAndUserVisibleProof,
        heavyActive,
        activeProcessSummary: active,
        userVisibleObserved: true,
        liveUserSeen: true,
        liveTouched: params.liveTouched,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      };
    }
    return {
      status: "applied_runtime_probe_ok",
      action: "keep_waiting_for_real_external_user_seen_proof",
      selectedCleanAdapter,
      missingProof,
      heavyActive,
      activeProcessSummary: active,
      userVisibleObserved: false,
      liveUserSeen: false,
      liveTouched: params.liveTouched,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  }

  if (bindingStatus !== "ready_for_apply" && bindingStatus !== "ready_for_live_runtime_binding") {
    return {
      status: "deferred_training_plan_not_ready",
      action: "wait_for_training_plan_live_binding_ready",
      selectedCleanAdapter,
      missingProof,
      heavyActive,
      activeProcessSummary: active,
      userVisibleObserved: false,
      liveUserSeen: false,
      liveTouched: params.liveTouched,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  }

  if (!params.apply) {
    return {
      status: "ready_for_apply",
      action: "run_apply_when_operator_allows_live_runtime_restart",
      selectedCleanAdapter,
      missingProof,
      heavyActive,
      activeProcessSummary: active,
      userVisibleObserved: false,
      liveUserSeen: false,
      liveTouched: params.liveTouched,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  }

  const runtimeProbeOk = params.externalChannelStatusOk === true;
  return {
    status:
      runtimeProbeOk && userVisibleObserved
        ? "applied_runtime_user_visible_observed"
        : runtimeProbeOk
          ? "applied_runtime_probe_ok"
          : "applied_runtime_probe_failed",
    action:
      runtimeProbeOk && userVisibleObserved
        ? "no_action_external_channel_user_visible_observed"
        : runtimeProbeOk
          ? "keep_waiting_for_real_external_user_seen_proof"
          : "debug_live_runtime_probe_before_claiming_bound",
    selectedCleanAdapter,
    missingProof:
      runtimeProbeOk && userVisibleObserved
        ? removeRuntimeProofNames(missingAfterUserVisibleProof)
        : missingProof.filter((entry) => {
            return !runtimeProbeOk || !RUNTIME_PROOF_NAMES.includes(entry);
          }),
    heavyActive,
    activeProcessSummary: active,
    userVisibleObserved: runtimeProbeOk && userVisibleObserved,
    liveUserSeen: runtimeProbeOk && userVisibleObserved,
    ...(!runtimeProbeOk && userVisibleObserved
      ? {
          visibleProofObservation: {
            reported: true as const,
            adoptedForCurrentBinding: false as const,
            reason: "current_binding_probe_failed" as const,
          },
        }
      : {}),
    liveTouched: params.liveTouched,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

export const buildLiveExternalBrainBindingDecision = buildExternalChannelBindingDecision;

function externalProofName(name: string): string {
  return name
    .replace(
      "training_plan_live_external_brain_binding",
      "training_plan_external_message_channel_binding",
    )
    .replace(
      "live_sidecar_source_drift_zero_after_selected_adapter",
      "external_channel_source_drift_zero_after_selected_adapter",
    )
    .replace(
      "live_gateway_and_external_proxy_restarted_after_selected_adapter",
      "external_message_channel_gateway_restarted_after_selected_adapter",
    )
    .replace(
      "live_external_channel_status_ok_after_restart",
      "external_message_channel_status_ok_after_restart",
    )
    .replace(
      "fresh_real_external_inbound_and_outbound_seen",
      "fresh_real_external_inbound_and_outbound_user_visible_observed",
    );
}

export function buildExternalChannelBindingSummary(
  decision: BindingDecision,
): ExternalChannelBindingSummary {
  const statusMap: Record<BindingDecision["status"], ExternalChannelBindingSummary["status"]> = {
    blocked_missing_training_plan: "blocked_missing_training_plan",
    deferred_active_training_or_eval: "deferred_active_training_or_eval",
    deferred_training_plan_not_ready: "deferred_training_plan_not_ready",
    ready_for_apply: "ready_for_channel_bind_apply",
    applied_runtime_probe_ok: "channel_runtime_probe_ok_user_visible_pending",
    applied_runtime_user_visible_observed: "channel_runtime_probe_ok_user_visible_observed",
    applied_runtime_probe_failed: "channel_runtime_probe_failed",
  };
  const actionMap: Record<BindingDecision["action"], ExternalChannelBindingSummary["action"]> = {
    fix_training_plan_owner_first: "fix_training_plan_owner_first",
    wait_for_current_eval_then_bind_live_to_selected_clean_adapter:
      "wait_for_current_eval_then_route_external_transport_to_selected_clean_answer_path",
    wait_for_training_plan_live_binding_ready: "wait_for_training_plan_external_channel_ready",
    run_apply_when_operator_allows_live_runtime_restart:
      "run_apply_when_operator_allows_external_channel_restart",
    keep_waiting_for_real_external_user_seen_proof:
      "keep_waiting_for_real_external_user_visible_proof",
    no_action_external_channel_user_visible_observed: "none_external_channel_user_visible_observed",
    debug_live_runtime_probe_before_claiming_bound:
      "debug_external_channel_probe_before_claiming_user_visible",
  };
  return {
    boundary: "local_external_channel_binding_operator_only",
    channel: "external",
    role: "owner_agent_communication_medium",
    objective: "external_receives_current_best_verified_lcx_agent_answer",
    selectedCleanAdapter: decision.selectedCleanAdapter,
    status: statusMap[decision.status],
    action: actionMap[decision.action],
    missingProof: decision.missingProof.map(externalProofName),
    userVisibleObserved: decision.userVisibleObserved,
    ...(decision.visibleProofObservation
      ? { visibleProofObservation: decision.visibleProofObservation }
      : {}),
    legacyLiveCompatibility: {
      legacyScript: "lcx-external-channel-binding",
      legacyDecisionStatus: decision.status,
      legacyLiveUserSeen: decision.userVisibleObserved,
    },
  };
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<{ ok: boolean; command: string; stdout: string; stderr: string; error?: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
    });
    return {
      ok: true,
      command: [command, ...args].join(" "),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const details = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
    };
    return {
      ok: false,
      command: [command, ...args].join(" "),
      stdout: details.stdout ?? "",
      stderr: details.stderr ?? "",
      error:
        details.killed === true
          ? `command timed out after ${timeoutMs}ms${details.signal ? ` (${details.signal})` : ""}`
          : (details.message ?? String(error)),
    };
  }
}

const LOCAL_VERIFICATION_SCHEMA = "lcx_channel_local_verification_v1";
const localSha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function localVerificationHead(sourceRoot: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], sourceRoot);
  if (!result.ok || !/^[a-f0-9]{40,64}$/u.test(result.stdout.trim())) {
    throw new Error("local_verification_head_unavailable");
  }
  return result.stdout.trim();
}

async function localVerificationRead(file: string, maxBytes = 65536): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error("local_verification_file_unavailable_or_oversize");
  }
  const bytes = await fs.readFile(file);
  if (bytes.length > maxBytes) {
    throw new Error("local_verification_file_oversize");
  }
  return bytes;
}

async function localChangedFiles(sourceRoot: string, files: readonly string[]) {
  if (!files.length || files.length > 32 || new Set(files).size !== files.length) {
    throw new Error("local_verification_changed_files_invalid");
  }
  const root = await fs.realpath(sourceRoot);
  return Promise.all(
    files.map(async (relative) => {
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative.includes("\\") ||
        path.posix.normalize(relative) !== relative ||
        relative.split("/").includes("..") ||
        /^(?:state|memory|node_modules|\.git)(?:\/|$)|(?:^|\/)\.env(?:[./]|$)/u.test(relative)
      ) {
        throw new Error("local_verification_changed_path_invalid");
      }
      const file = path.join(root, relative);
      if ((await fs.realpath(file)) !== file) {
        throw new Error("local_verification_changed_path_alias");
      }
      const bytes = await localVerificationRead(file, 1024 * 1024);
      return { path: relative, sha256: localSha(bytes), bytes: bytes.length };
    }),
  );
}

/** Explicit operator/test producer only; the binding CLI never calls this executor. */
export async function runExternalChannelLocalVerificationTest(options: {
  sourceRoot?: string;
  changedFiles: readonly string[];
  command: string;
  args: string[];
  receiptPath: string;
  timeoutMs?: number;
}) {
  const sourceRoot = await fs.realpath(options.sourceRoot ?? REPO_ROOT);
  const head = await localVerificationHead(sourceRoot);
  const changedFiles = await localChangedFiles(sourceRoot, options.changedFiles);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let exitCode: number | null = 0;
  let stdout = "";
  let stderr = "";
  let failure: string | undefined;
  try {
    const result = await execFileAsync(options.command, options.args, {
      cwd: sourceRoot,
      encoding: "utf8",
      maxBuffer: 16384,
      timeout: options.timeoutMs ?? 30000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const result = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    exitCode = typeof result.code === "number" ? result.code : null;
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    failure = result.killed ? "local_verification_test_timeout" : "local_verification_test_failed";
  }
  const finishedAt = new Date().toISOString();
  const resultBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: LOCAL_VERIFICATION_SCHEMA,
      runId,
      sourceRoot,
      head,
      changedFiles,
      command: options.command,
      args: options.args,
      startedAt,
      finishedAt,
      exitCode,
      stdout,
      stderr,
      failure,
    }) + "\n",
  );
  if (resultBytes.length > 65536) {
    throw new Error("local_verification_result_oversize");
  }
  const receiptPath = path.resolve(options.receiptPath);
  const resultPath = `${receiptPath}.test-result.json`;
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.writeFile(resultPath, resultBytes, { flag: "wx", mode: 0o600 });
  const testResult = { path: resultPath, sha256: localSha(resultBytes), bytes: resultBytes.length };
  const receipt = {
    schemaVersion: LOCAL_VERIFICATION_SCHEMA,
    runId,
    sourceRoot,
    head,
    changedFiles,
    testResult,
  };
  await fs.writeFile(receiptPath, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
  return { receiptPath, testResult, receipt, exitCode };
}

export async function readExternalChannelLocalVerification(
  options: Pick<
    CliOptions,
    "localVerificationReceipt" | "localVerificationTestResultSha256" | "localVerificationSourceRoot"
  >,
): Promise<JsonRecord> {
  if (!options.localVerificationReceipt) {
    if (options.localVerificationTestResultSha256 !== undefined) {
      return {
        status: "blocked",
        gaps: ["local_verification_receipt_unavailable"],
        executionAuthority: false,
      };
    }
    return {
      status: "not_observed",
      gaps: ["local_verification_receipt_not_provided"],
      executionAuthority: false,
    };
  }
  const reads: JsonRecord[] = [];
  let reading = "source";
  try {
    if (!/^[a-f0-9]{64}$/u.test(options.localVerificationTestResultSha256 ?? "")) {
      throw new Error("local_verification_independent_test_pin_unavailable");
    }
    const sourceRoot = await fs.realpath(options.localVerificationSourceRoot ?? REPO_ROOT);
    const head = await localVerificationHead(sourceRoot);
    const receiptPath = path.resolve(options.localVerificationReceipt);
    reading = "receipt";
    const receiptBytes = await localVerificationRead(receiptPath);
    reads.push({ path: receiptPath, sha256: localSha(receiptBytes), bytes: receiptBytes.length });
    const receipt = recordValue(JSON.parse(receiptBytes.toString("utf8")));
    const pin = recordValue(receipt?.testResult);
    if (
      receipt?.schemaVersion !== LOCAL_VERIFICATION_SCHEMA ||
      receipt.sourceRoot !== sourceRoot ||
      receipt.head !== head ||
      typeof receipt.runId !== "string" ||
      !receipt.runId ||
      !pin ||
      pin.path !== `${receiptPath}.test-result.json`
    ) {
      throw new Error("local_verification_source_or_identity_conflict");
    }
    reading = "test_result";
    const resultBytes = await localVerificationRead(String(pin.path));
    const actualPin = { path: pin.path, sha256: localSha(resultBytes), bytes: resultBytes.length };
    reads.push(actualPin);
    if (
      actualPin.sha256 !== options.localVerificationTestResultSha256 ||
      actualPin.sha256 !== pin.sha256 ||
      actualPin.bytes !== pin.bytes
    ) {
      throw new Error("local_verification_test_result_hash_conflict");
    }
    const result = recordValue(JSON.parse(resultBytes.toString("utf8")));
    if (
      !result ||
      result.schemaVersion !== LOCAL_VERIFICATION_SCHEMA ||
      result.runId !== receipt.runId ||
      result.sourceRoot !== sourceRoot ||
      result.head !== head ||
      JSON.stringify(result.changedFiles) !== JSON.stringify(receipt.changedFiles) ||
      typeof result.command !== "string" ||
      !Array.isArray(result.args) ||
      !Number.isFinite(Date.parse(String(result.startedAt))) ||
      !Number.isFinite(Date.parse(String(result.finishedAt))) ||
      Date.parse(String(result.finishedAt)) < Date.parse(String(result.startedAt)) ||
      Date.parse(String(result.finishedAt)) > Date.now()
    ) {
      throw new Error("local_verification_execution_identity_conflict");
    }
    const declared = receipt.changedFiles;
    if (
      !Array.isArray(declared) ||
      declared.some((file) => !recordValue(file) || typeof file.path !== "string")
    ) {
      throw new Error("local_verification_changed_files_invalid");
    }
    reading = "changed_file";
    const actualFiles = await localChangedFiles(
      sourceRoot,
      declared.map((file) => String(file.path)),
    );
    if (JSON.stringify(actualFiles) !== JSON.stringify(declared)) {
      throw new Error("local_verification_changed_file_hash_conflict");
    }
    reads.push(...actualFiles.map((file) => ({ ...file, path: path.join(sourceRoot, file.path) })));
    if (result.exitCode !== 0 || result.failure !== undefined) {
      throw new Error("local_verification_executed_test_not_passed");
    }
    return {
      status: "verified",
      boundary: "host_pinned_local_test_result_not_channel_authority",
      sourceRoot,
      head,
      runId: receipt.runId,
      testResult: actualPin,
      changedFiles: actualFiles,
      command: result.command,
      args: result.args,
      exitCode: result.exitCode,
      reads,
      gaps: [],
      executionAuthority: false,
    };
  } catch (error) {
    return {
      status: "blocked",
      gaps: [
        (() => {
          const message = stringValue(recordValue(error)?.message);
          return message?.startsWith("local_verification_")
            ? message
            : `local_verification_${reading}_unavailable`;
        })(),
      ],
      reads,
      executionAuthority: false,
    };
  }
}

export function applyExternalChannelLocalVerification(
  decision: BindingDecision,
  verification: JsonRecord,
): BindingDecision {
  if (verification.status !== "blocked") {
    return decision;
  }
  return {
    ...decision,
    status:
      decision.status === "blocked_missing_training_plan"
        ? decision.status
        : "deferred_training_plan_not_ready",
    action:
      decision.status === "blocked_missing_training_plan"
        ? "fix_training_plan_owner_first"
        : "wait_for_training_plan_live_binding_ready",
    missingProof: [...new Set([...decision.missingProof, ...stringArray(verification.gaps)])],
    userVisibleObserved: false,
    liveUserSeen: false,
  };
}

async function readTrainingPlan(): Promise<JsonRecord | undefined> {
  const result = await runCommand(
    process.execPath,
    ["--import", "tsx", "scripts/operator/local-brain-training-plan.ts", "--json"],
    REPO_ROOT,
  );
  if (!result.ok) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout) as JsonRecord;
  } catch {
    return undefined;
  }
}

async function readUserVisibleObserved(): Promise<boolean> {
  const result = await runCommand(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/operator/lcx-external-channel-compat.ts",
      "--status",
      "--json",
      "--with-probe",
    ],
    REPO_ROOT,
  );
  if (!result.ok) {
    return false;
  }
  try {
    const payload = JSON.parse(result.stdout) as JsonRecord;
    const proof = recordValue(payload.visibleProof);
    const status = stringValue(proof?.status);
    const currentStatus =
      status === "user_visible_observed" || status === "post_migration_reply_seen";
    const legacyStatus = status === "live_visible_fixed";
    const correlatedPairCount = proof?.correlatedReplyPairCount;
    const correlationVerified =
      typeof correlatedPairCount === "number" ? correlatedPairCount > 0 : legacyStatus;
    const acceptanceVerified =
      status === "post_migration_reply_seen" || booleanValue(proof?.acceptanceMatched) === true;
    return (
      (currentStatus || legacyStatus) &&
      correlationVerified &&
      acceptanceVerified &&
      typeof proof?.freshInboundCount === "number" &&
      proof.freshInboundCount > 0 &&
      typeof proof?.freshOutboundResultCount === "number" &&
      proof.freshOutboundResultCount > 0
    );
  } catch {
    return false;
  }
}

export async function runExternalChannelBinding(options: CliOptions): Promise<JsonRecord> {
  const startedAt = new Date().toISOString();
  if (options.compatibilityOnly) {
    const { createFinanceResearchRunTool } =
      await import("../../src/agents/tools/finance-research-run-tool.js");
    const tool = createFinanceResearchRunTool();
    const payload = {
      ok: true,
      boundary: "local_external_channel_compatibility_only",
      generatedAt: startedAt,
      decision: {
        status: "compatibility_ready_runtime_not_bound",
        action: "implement_platform_adapter_using_existing_channel_plugin_and_agent_tool_contracts",
      },
      compatibility: {
        channelContract: "src/channels/plugins/types.plugin.ts#ChannelPlugin",
        inboundOwner: "src/auto-reply/dispatch.ts#dispatchInboundMessage",
        researchTool: tool.name,
        researchOwner: "src/agents/finance-research-runner.ts#runFinanceResearchRun",
        outboundContract: "src/channels/plugins/types.adapters.ts#ChannelOutboundAdapter",
        modelSelection: "configured_finance_workflow",
        localAdapterPromotionRequired: false,
        platformRequirements: [
          "account_and_sender_authorization",
          "message_and_thread_identity",
          "cancellation",
          "outbound_delivery_receipt",
        ],
        localProofCommand:
          "pnpm exec vitest run src/agents/tools/finance-research-run-tool.test.ts src/agents/openclaw-tools.finance-external-source-adapter-registration.test.ts",
      },
      externalChannelApplied: false,
      userVisibleObserved: false,
      modelWeightAbsorbed: false,
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
    await fs.mkdir(path.dirname(options.snapshotPath), { recursive: true });
    await fs.writeFile(options.snapshotPath, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  const localVerification = await readExternalChannelLocalVerification(options);
  const trainingPlan = await readTrainingPlan();
  const userVisibleObserved = await readUserVisibleObserved();
  let decision = buildExternalChannelBindingDecision({
    trainingPlan,
    apply: false,
    userVisibleObserved,
    liveTouched: false,
  });
  decision = applyExternalChannelLocalVerification(decision, localVerification);
  const commands: JsonRecord[] = [];
  let liveSidecarDriftBefore: string | undefined;
  let liveSidecarDriftAfter: string | undefined;
  let externalChannelStatus: JsonRecord | undefined;

  const driftBefore = await runCommand(SYNC_DOCTOR, [], REPO_ROOT);
  commands.push({ name: "live-sidecar-sync-doctor", ok: driftBefore.ok });
  liveSidecarDriftBefore = driftBefore.stdout
    .split("\n")
    .find((line) => line.startsWith("summary "));
  if (
    decision.status === "applied_runtime_probe_ok" &&
    !sidecarDriftIsZero(liveSidecarDriftBefore)
  ) {
    decision = requireRuntimeApply(decision);
  }

  const previousSnapshot = options.apply ? undefined : await readJson(options.snapshotPath);
  const previousExternalChannel = recordValue(previousSnapshot?.externalChannelBinding);
  const previousStatus = recordValue(previousSnapshot?.externalChannelStatus);
  const previousChannelStillMatches =
    (stringValue(previousExternalChannel?.status) ===
      "channel_runtime_probe_ok_user_visible_pending" ||
      stringValue(previousExternalChannel?.status) ===
        "channel_runtime_probe_ok_user_visible_observed") &&
    stringValue(previousExternalChannel?.selectedCleanAdapter) === decision.selectedCleanAdapter &&
    sidecarDriftIsZero(liveSidecarDriftBefore) &&
    externalChannelStatusSucceeded(previousStatus);
  if (!options.apply && decision.status === "ready_for_apply" && previousChannelStillMatches) {
    decision = buildExternalChannelBindingDecision({
      trainingPlan,
      apply: true,
      externalChannelStatusOk: true,
      userVisibleObserved,
      liveTouched: false,
    });
    externalChannelStatus = {
      ok: true,
      preservedFromPreviousApply: true,
      nextBlocker: previousStatus?.nextBlocker,
      boundaries: previousStatus?.boundaries,
    };
  }

  if (
    !options.apply &&
    decision.status === "ready_for_apply" &&
    !previousChannelStillMatches &&
    sidecarDriftIsZero(liveSidecarDriftBefore)
  ) {
    const statusCheck = await runCommand(
      "corepack",
      ["pnpm", "--silent", "openclaw", "channels", "status", "--probe", "--json"],
      options.sidecarRoot,
    );
    commands.push({ name: "external-channel-status read-only", ok: statusCheck.ok });
    if (statusCheck.ok) {
      try {
        externalChannelStatus = JSON.parse(statusCheck.stdout) as JsonRecord;
      } catch {
        externalChannelStatus = { ok: false, parseError: "invalid_json" };
      }
    }
    decision = buildExternalChannelBindingDecision({
      trainingPlan,
      apply: true,
      externalChannelStatusOk:
        statusCheck.ok && externalChannelStatusSucceeded(externalChannelStatus),
      userVisibleObserved,
      liveTouched: false,
    });
  }

  decision = applyExternalChannelLocalVerification(decision, localVerification);
  if (options.apply && decision.status === "ready_for_apply") {
    const syncApply = await runCommand(SYNC_DOCTOR, ["--apply"], REPO_ROOT);
    commands.push({ name: "live-sidecar-sync-doctor --apply", ok: syncApply.ok });
    const build = syncApply.ok
      ? await runCommand(
          "corepack",
          ["pnpm", "build"],
          options.sidecarRoot,
          SIDECAR_BUILD_TIMEOUT_MS,
        )
      : { ok: false, command: "corepack pnpm build", stdout: "", stderr: "", error: "sync_failed" };
    commands.push({ name: "sidecar pnpm build", ok: build.ok });
    const restart = build.ok
      ? await runCommand(
          "zsh",
          [
            "-lc",
            "launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway && launchctl kickstart -k gui/$(id -u)/ai.openclaw.external.proxy",
          ],
          options.sidecarRoot,
        )
      : {
          ok: false,
          command: "launchctl kickstart",
          stdout: "",
          stderr: "",
          error: "build_failed",
        };
    commands.push({ name: "restart live gateway/proxy", ok: restart.ok });
    const driftAfter = await runCommand(SYNC_DOCTOR, [], REPO_ROOT);
    commands.push({ name: "live-sidecar-sync-doctor post", ok: driftAfter.ok });
    liveSidecarDriftAfter = driftAfter.stdout
      .split("\n")
      .find((line) => line.startsWith("summary "));
    const statusCheck = restart.ok
      ? await runCommand(
          "corepack",
          ["pnpm", "--silent", "openclaw", "channels", "status", "--probe", "--json"],
          options.sidecarRoot,
        )
      : {
          ok: false,
          command: "external-channel-status",
          stdout: "",
          stderr: "",
          error: "restart_failed",
        };
    commands.push({ name: "external-channel-status", ok: statusCheck.ok });
    if (statusCheck.ok) {
      try {
        externalChannelStatus = JSON.parse(statusCheck.stdout) as JsonRecord;
      } catch {
        externalChannelStatus = { ok: false, parseError: "invalid_json" };
      }
    }
    decision = buildExternalChannelBindingDecision({
      trainingPlan,
      apply: true,
      externalChannelStatusOk:
        statusCheck.ok && externalChannelStatusSucceeded(externalChannelStatus),
      userVisibleObserved,
      liveTouched: syncApply.ok || build.ok || restart.ok,
    });
  }

  const payload = {
    ok: !["blocked_missing_training_plan", "applied_runtime_probe_failed"].includes(
      decision.status,
    ),
    boundary: "local_external_channel_binding_operator_only",
    legacyBoundary: "local_live_external_brain_binding_operator_only",
    conceptStatus: "legacy_live_terms_external_channel_owner_current",
    startedAt,
    generatedAt: new Date().toISOString(),
    cwd: REPO_ROOT,
    sidecarRoot: options.sidecarRoot,
    apply: options.apply,
    decision,
    externalChannelBinding: buildExternalChannelBindingSummary(decision),
    localVerification,
    trainingPlanBoundary: trainingPlan?.boundary,
    liveExternalBrainBinding: recordValue(trainingPlan?.liveExternalBrainBinding),
    trainingPlanExternalChannelBinding: recordValue(trainingPlan?.externalChannelBinding),
    latestCandidateEval: trainingPlan?.latestCandidateEval,
    activeGuardAdapterTruth: trainingPlan?.activeGuardAdapterTruth,
    liveSidecarDriftBefore,
    liveSidecarDriftAfter,
    externalChannelStatus: externalChannelStatus
      ? {
          ok: externalChannelStatus.ok,
          nextBlocker: externalChannelStatus.nextBlocker,
          boundaries: externalChannelStatus.boundaries,
        }
      : undefined,
    commands,
    nextCommand:
      decision.status === "ready_for_apply"
        ? "node --import tsx scripts/operator/lcx-external-channel-binding.ts --apply --json"
        : undefined,
    notTouched: [
      "provider_config",
      "protected_memory",
      "formal_language_corpus",
      "training_processes",
    ],
    liveTouched: decision.liveTouched,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  await fs.mkdir(path.dirname(options.snapshotPath), { recursive: true });
  await fs.writeFile(options.snapshotPath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function printExternalChannelBindingPayload(payload: JsonRecord, options: CliOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `status=${(payload.decision as BindingDecision).status}`,
      `action=${(payload.decision as BindingDecision).action}`,
      `selectedCleanAdapter=${(payload.decision as BindingDecision).selectedCleanAdapter ?? "unknown"}`,
      `liveTouched=${payload.liveTouched === true}`,
      `nextCommand=${stringValue(payload.nextCommand) ?? "none"}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseExternalChannelBindingArgs(process.argv.slice(2));
  const payload = await runExternalChannelBinding(options);
  printExternalChannelBindingPayload(payload, options);
}
