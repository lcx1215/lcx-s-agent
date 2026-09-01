import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_SIDECAR_ROOT = "/Users/liuchengxu/.openclaw/external-channel-runtime/lcx-s-openclaw";
const DEFAULT_SNAPSHOT_PATH =
  "/Users/liuchengxu/.openclaw/workspace/state/lcx-external-channel-binding-latest.json";
const SYNC_DOCTOR =
  "/Users/liuchengxu/.codex/skills/live-sidecar-sync-doctor/scripts/live-sidecar-sync-doctor.sh";
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = (() => {
  const value = Number(process.env.LCX_EXTERNAL_CHANNEL_COMMAND_TIMEOUT_MS ?? "");
  return Number.isFinite(value) && value > 0 ? value : 90_000;
})();
const SIDECAR_BUILD_TIMEOUT_MS = 600_000;

type JsonRecord = Record<string, unknown>;

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
    | "keep_waiting_for_real_lark_user_seen_proof"
    | "no_action_external_channel_user_visible_observed"
    | "debug_live_runtime_probe_before_claiming_bound";
  selectedCleanAdapter?: string;
  missingProof: string[];
  heavyActive: boolean;
  activeProcessSummary: Array<{ pid?: number; role?: string; elapsed?: string }>;
  liveUserSeen: boolean;
  liveTouched: boolean;
  providerConfigTouched: false;
  protectedMemoryTouched: false;
};

type ExternalChannelBindingSummary = {
  boundary: "local_external_channel_binding_operator_only";
  channel: "lark";
  role: "owner_agent_communication_medium";
  objective: "lark_receives_current_best_verified_lcx_agent_answer";
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
    | "wait_for_current_eval_then_route_lark_transport_to_selected_clean_answer_path"
    | "wait_for_training_plan_external_channel_ready"
    | "run_apply_when_operator_allows_lark_channel_restart"
    | "keep_waiting_for_real_lark_user_visible_proof"
    | "none_external_channel_user_visible_observed"
    | "debug_lark_channel_probe_before_claiming_user_visible";
  missingProof: string[];
  userVisibleObserved: boolean;
  legacyLiveCompatibility: {
    legacyScript: "lcx-live-lark-brain-binding";
    legacyDecisionStatus: BindingDecision["status"];
    legacyLiveUserSeen: boolean;
  };
};

type CliOptions = {
  json: boolean;
  apply: boolean;
  snapshotPath: string;
  sidecarRoot: string;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-external-channel-binding.ts [--json] [--apply]",
      "",
      "External-channel operator for making the Lark transport route to the selected clean LCX answer path.",
      "The historical live script name is legacy compatibility; Lark is the owner-agent communication medium, not a brain.",
      "Default is read-only. --apply is allowed only when local-brain-training-plan exposes",
      "externalChannelBinding.status=ready_for_apply and no eval/MLX process is active.",
    ].join("\n"),
  );
}

export function parseExternalChannelBindingArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    apply: false,
    snapshotPath: DEFAULT_SNAPSHOT_PATH,
    sidecarRoot: DEFAULT_SIDECAR_ROOT,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--snapshot-path") {
      const value = args[index + 1];
      if (!value) {
        usage();
      }
      options.snapshotPath = path.resolve(value);
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

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRecord;
  } catch {
    return undefined;
  }
}

function activeProcessSummary(trainingPlan: JsonRecord | undefined) {
  const activeProcesses = Array.isArray(trainingPlan?.activeProcesses)
    ? trainingPlan.activeProcesses
    : [];
  return activeProcesses
    .map((entry) => {
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
    .filter((entry): entry is { pid?: number; role?: string; elapsed?: string } => Boolean(entry));
}

function sidecarDriftIsZero(summary: string | undefined): boolean {
  return summary?.includes("missing=0") === true && summary.includes("different=0");
}

const RUNTIME_PROOF_NAMES = [
  "external_channel_source_drift_zero_after_selected_adapter",
  "lark_external_channel_gateway_restarted_after_selected_adapter",
  "lark_external_channel_diagnose_ok_after_restart",
  "live_sidecar_source_drift_zero_after_selected_adapter",
  "live_gateway_and_feishu_proxy_restarted_after_selected_adapter",
  "live_lark_loop_diagnose_ok_after_restart",
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
  larkLoopDiagnoseOk?: boolean;
  userVisibleObserved?: boolean;
  liveTouched: boolean;
}): BindingDecision {
  const binding =
    recordValue(params.trainingPlan?.externalChannelBinding) ??
    recordValue(params.trainingPlan?.liveLarkBrainBinding);
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
      externalProofName(entry) !== "fresh_real_lark_inbound_and_outbound_user_visible_observed",
  );
  const missingAfterRuntimeAndUserVisibleProof = removeRuntimeProofNames(
    missingAfterUserVisibleProof,
  );

  if (!params.trainingPlan || !binding) {
    return {
      status: "blocked_missing_training_plan",
      action: "fix_training_plan_owner_first",
      missingProof: ["training_plan_lark_external_channel_binding"],
      heavyActive,
      activeProcessSummary: active,
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
        liveUserSeen: true,
        liveTouched: params.liveTouched,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      };
    }
    return {
      status: "applied_runtime_probe_ok",
      action: "keep_waiting_for_real_lark_user_seen_proof",
      selectedCleanAdapter,
      missingProof,
      heavyActive,
      activeProcessSummary: active,
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
      liveUserSeen: false,
      liveTouched: params.liveTouched,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  }

  const runtimeProbeOk = params.larkLoopDiagnoseOk === true;
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
          ? "keep_waiting_for_real_lark_user_seen_proof"
          : "debug_live_runtime_probe_before_claiming_bound",
    selectedCleanAdapter,
    missingProof: userVisibleObserved
      ? removeRuntimeProofNames(missingAfterUserVisibleProof)
      : missingProof.filter((entry) => {
          return !runtimeProbeOk || !RUNTIME_PROOF_NAMES.includes(entry);
        }),
    heavyActive,
    activeProcessSummary: active,
    liveUserSeen: userVisibleObserved,
    liveTouched: params.liveTouched,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

export const buildLiveLarkBrainBindingDecision = buildExternalChannelBindingDecision;

function externalProofName(name: string): string {
  return name
    .replace("training_plan_live_lark_brain_binding", "training_plan_lark_external_channel_binding")
    .replace(
      "live_sidecar_source_drift_zero_after_selected_adapter",
      "external_channel_source_drift_zero_after_selected_adapter",
    )
    .replace(
      "live_gateway_and_feishu_proxy_restarted_after_selected_adapter",
      "lark_external_channel_gateway_restarted_after_selected_adapter",
    )
    .replace(
      "live_lark_loop_diagnose_ok_after_restart",
      "lark_external_channel_diagnose_ok_after_restart",
    )
    .replace(
      "fresh_real_lark_inbound_and_outbound_seen",
      "fresh_real_lark_inbound_and_outbound_user_visible_observed",
    );
}

function buildExternalChannelBindingSummary(
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
      "wait_for_current_eval_then_route_lark_transport_to_selected_clean_answer_path",
    wait_for_training_plan_live_binding_ready: "wait_for_training_plan_external_channel_ready",
    run_apply_when_operator_allows_live_runtime_restart:
      "run_apply_when_operator_allows_lark_channel_restart",
    keep_waiting_for_real_lark_user_seen_proof: "keep_waiting_for_real_lark_user_visible_proof",
    no_action_external_channel_user_visible_observed: "none_external_channel_user_visible_observed",
    debug_live_runtime_probe_before_claiming_bound:
      "debug_lark_channel_probe_before_claiming_user_visible",
  };
  return {
    boundary: "local_external_channel_binding_operator_only",
    channel: "lark",
    role: "owner_agent_communication_medium",
    objective: "lark_receives_current_best_verified_lcx_agent_answer",
    selectedCleanAdapter: decision.selectedCleanAdapter,
    status: statusMap[decision.status],
    action: actionMap[decision.action],
    missingProof: decision.missingProof.map(externalProofName),
    userVisibleObserved: decision.liveUserSeen,
    legacyLiveCompatibility: {
      legacyScript: "lcx-live-lark-brain-binding",
      legacyDecisionStatus: decision.status,
      legacyLiveUserSeen: decision.liveUserSeen,
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
    return (
      stringValue(proof?.status) === "live_visible_fixed" &&
      booleanValue(proof?.acceptanceMatched) === true &&
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
  const trainingPlan = await readTrainingPlan();
  const userVisibleObserved = await readUserVisibleObserved();
  let decision = buildExternalChannelBindingDecision({
    trainingPlan,
    apply: false,
    userVisibleObserved,
    liveTouched: false,
  });
  const commands: JsonRecord[] = [];
  let liveSidecarDriftBefore: string | undefined;
  let liveSidecarDriftAfter: string | undefined;
  let larkLoopDiagnose: JsonRecord | undefined;

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
  const previousDiagnose = recordValue(previousSnapshot?.larkLoopDiagnose);
  const previousChannelStillMatches =
    (stringValue(previousExternalChannel?.status) ===
      "channel_runtime_probe_ok_user_visible_pending" ||
      stringValue(previousExternalChannel?.status) ===
        "channel_runtime_probe_ok_user_visible_observed") &&
    stringValue(previousExternalChannel?.selectedCleanAdapter) === decision.selectedCleanAdapter &&
    sidecarDriftIsZero(liveSidecarDriftBefore) &&
    booleanValue(previousDiagnose?.ok) === true;
  if (!options.apply && decision.status === "ready_for_apply" && previousChannelStillMatches) {
    decision = buildExternalChannelBindingDecision({
      trainingPlan,
      apply: true,
      larkLoopDiagnoseOk: true,
      userVisibleObserved,
      liveTouched: false,
    });
    larkLoopDiagnose = {
      ok: true,
      preservedFromPreviousApply: true,
      nextBlocker: previousDiagnose?.nextBlocker,
      boundaries: previousDiagnose?.boundaries,
    };
  }

  if (
    !options.apply &&
    decision.status === "ready_for_apply" &&
    !previousChannelStillMatches &&
    sidecarDriftIsZero(liveSidecarDriftBefore)
  ) {
    const diagnose = await runCommand(
      "corepack",
      ["pnpm", "--silent", "openclaw", "capabilities", "lark-loop-diagnose", "--json"],
      options.sidecarRoot,
    );
    commands.push({ name: "lark-loop-diagnose read-only", ok: diagnose.ok });
    if (diagnose.ok) {
      try {
        larkLoopDiagnose = JSON.parse(diagnose.stdout) as JsonRecord;
      } catch {
        larkLoopDiagnose = { ok: false, parseError: "invalid_json" };
      }
    }
    decision = buildExternalChannelBindingDecision({
      trainingPlan,
      apply: true,
      larkLoopDiagnoseOk: diagnose.ok && recordValue(larkLoopDiagnose)?.ok === true,
      userVisibleObserved,
      liveTouched: false,
    });
  }

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
            "launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway && launchctl kickstart -k gui/$(id -u)/ai.openclaw.feishu.proxy",
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
    const diagnose = restart.ok
      ? await runCommand(
          "corepack",
          ["pnpm", "--silent", "openclaw", "capabilities", "lark-loop-diagnose", "--json"],
          options.sidecarRoot,
        )
      : {
          ok: false,
          command: "lark-loop-diagnose",
          stdout: "",
          stderr: "",
          error: "restart_failed",
        };
    commands.push({ name: "lark-loop-diagnose", ok: diagnose.ok });
    if (diagnose.ok) {
      try {
        larkLoopDiagnose = JSON.parse(diagnose.stdout) as JsonRecord;
      } catch {
        larkLoopDiagnose = { ok: false, parseError: "invalid_json" };
      }
    }
    decision = buildExternalChannelBindingDecision({
      trainingPlan,
      apply: true,
      larkLoopDiagnoseOk: diagnose.ok && recordValue(larkLoopDiagnose)?.ok === true,
      userVisibleObserved,
      liveTouched: syncApply.ok || build.ok || restart.ok,
    });
  }

  const payload = {
    ok: !["blocked_missing_training_plan", "applied_runtime_probe_failed"].includes(
      decision.status,
    ),
    boundary: "local_external_channel_binding_operator_only",
    legacyBoundary: "dev_live_lark_brain_binding_operator_only",
    conceptStatus: "legacy_live_terms_external_channel_owner_current",
    startedAt,
    generatedAt: new Date().toISOString(),
    cwd: REPO_ROOT,
    sidecarRoot: options.sidecarRoot,
    apply: options.apply,
    decision,
    externalChannelBinding: buildExternalChannelBindingSummary(decision),
    trainingPlanBoundary: trainingPlan?.boundary,
    liveLarkBrainBinding: recordValue(trainingPlan?.liveLarkBrainBinding),
    trainingPlanExternalChannelBinding: recordValue(trainingPlan?.externalChannelBinding),
    latestCandidateEval: trainingPlan?.latestCandidateEval,
    activeGuardAdapterTruth: trainingPlan?.activeGuardAdapterTruth,
    liveSidecarDriftBefore,
    liveSidecarDriftAfter,
    larkLoopDiagnose: larkLoopDiagnose
      ? {
          ok: larkLoopDiagnose.ok,
          nextBlocker: larkLoopDiagnose.nextBlocker,
          boundaries: larkLoopDiagnose.boundaries,
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
