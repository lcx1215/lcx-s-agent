import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runFeishuLearningCouncil } from "../../extensions/feishu/src/learning-council.ts";
import { loadConfig } from "../../src/config/config.js";
import { DEFAULT_WORKSPACE_DIR, GOVERNANCE_AUTOPILOT_LATEST_PATH } from "./lcx-local-paths.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_FRESH_MINUTES = 120;
const COUNCIL_DIR = ["bank", "knowledge", "learning-councils"];
const REQUIRED_ROLES = ["kimi", "minimax", "deepseek"] as const;

type CliOptions = {
  json: boolean;
  write: boolean;
  workspaceDir: string;
  routeAgentId: string;
  profile: "balanced" | "aggressive";
  focus?: string;
  maxFreshMinutes: number;
  timeoutMs: number;
  pidFixture?: string;
};

type CouncilRole = {
  role: string;
  model: string;
  providerFamily: string;
  success: boolean;
  error?: string;
};

type LatestCouncil = {
  path: string;
  generatedAt?: string;
  ageMinutes?: number;
  status: string;
  roles: CouncilRole[];
  successfulRoles: string[];
  failedRoles: string[];
};

type ActivePidSummary = {
  guard: string[];
  eval: string[];
  mlx: string[];
  teacher: string[];
  quota: string[];
};

type DailyRoleUse = {
  role: string;
  calls: number;
  success: number;
  failed: number;
  latestAt?: string;
};

type DailyUseCoverage = {
  windowHours: number;
  completeCouncilInWindow: boolean;
  successfulRolesInWindow: string[];
  missingSuccessfulRoles: string[];
  roleUse: DailyRoleUse[];
  latestCompleteCouncilAt?: string;
  nextDueAt?: string;
  dueNow: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-provider-council-acceleration.ts [--write] [--json]",
      "  [--workspace DIR] [--route-agent-id ID] [--profile balanced|aggressive]",
      "  [--focus TEXT] [--max-fresh-minutes N] [--timeout-ms N]",
      "",
      "Plans or runs one bounded Kimi/MiniMax/DeepSeek learning-council acceleration pass.",
      "Default is dry-run. --write calls providers only when active eval/MLX is idle, git is clean,",
      "and no fresh complete three-role learning council already exists.",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    write: false,
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    routeAgentId: "main",
    profile: "balanced",
    maxFreshMinutes: DEFAULT_FRESH_MINUTES,
    timeoutMs: 900_000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--no-write" || arg === "--dry-run") {
      options.write = false;
    } else if (arg === "--workspace" || arg === "--workspace-dir") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--route-agent-id") {
      options.routeAgentId = readValue(args, index);
      index += 1;
    } else if (arg === "--profile") {
      const profile = readValue(args, index);
      if (profile !== "balanced" && profile !== "aggressive") {
        usage();
      }
      options.profile = profile;
      index += 1;
    } else if (arg === "--focus") {
      options.focus = readValue(args, index);
      index += 1;
    } else if (arg === "--max-fresh-minutes") {
      options.maxFreshMinutes = positiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--pid-fixture") {
      options.pidFixture = readValue(args, index);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }

  return options;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function displayValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function gitStatusLines(): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
    cwd: repoRoot,
  });
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function activePidSummary(options: CliOptions): Promise<ActivePidSummary> {
  const stdout =
    options.pidFixture !== undefined
      ? await fs.readFile(options.pidFixture, "utf8")
      : (await execFileAsync("ps", ["-axo", "pid,etime,command"])).stdout;
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      return (
        line.includes("scripts/dev/minimax-brain-training-guard.ts") ||
        line.includes("scripts/dev/minimax-quota-brain-saturator.ts") ||
        line.includes("scripts/dev/minimax-brain-teacher-batch.ts") ||
        line.includes("scripts/dev/local-brain-distill-eval.ts") ||
        /mlx_lm (generate|lora)/u.test(line)
      );
    });
  return {
    guard: lines.filter((line) => line.includes("scripts/dev/minimax-brain-training-guard.ts")),
    eval: lines.filter((line) => line.includes("scripts/dev/local-brain-distill-eval.ts")),
    mlx: lines.filter((line) => /mlx_lm (generate|lora)/u.test(line)),
    teacher: lines.filter((line) => line.includes("scripts/dev/minimax-brain-teacher-batch.ts")),
    quota: lines.filter((line) => line.includes("scripts/dev/minimax-quota-brain-saturator.ts")),
  };
}

function activePidCounts(summary: ActivePidSummary): Record<string, number> {
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, value.length]));
}

async function listRecentCouncilFiles(workspaceDir: string): Promise<string[]> {
  const dir = path.join(workspaceDir, ...COUNCIL_DIR);
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((name) => name.endsWith(".json"))
      .toSorted((left, right) => right.localeCompare(left))
      .map((name) => path.join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function summarizeRoles(payload: Record<string, unknown>): CouncilRole[] {
  return (Array.isArray(payload.roles) ? payload.roles : [])
    .map((role): CouncilRole | undefined => {
      const record = recordValue(role);
      const roleName = typeof record.role === "string" ? record.role : "";
      if (!roleName) {
        return undefined;
      }
      return {
        role: roleName,
        model: typeof record.model === "string" ? record.model : "",
        providerFamily:
          typeof record.providerFamily === "string" ? record.providerFamily : "unknown",
        success: record.success === true,
        error: typeof record.error === "string" ? record.error : undefined,
      };
    })
    .filter((role): role is CouncilRole => Boolean(role));
}

function minutesSince(isoValue: string | undefined, nowMs = Date.now()): number | undefined {
  if (!isoValue) {
    return undefined;
  }
  const time = Date.parse(isoValue);
  if (!Number.isFinite(time)) {
    return undefined;
  }
  return Math.max(0, Math.round((nowMs - time) / 60_000));
}

async function latestCouncil(workspaceDir: string): Promise<LatestCouncil | undefined> {
  const files = await listRecentCouncilFiles(workspaceDir);
  for (const filePath of files) {
    const payload = await readJsonIfExists(filePath);
    if (!payload) {
      continue;
    }
    const roles = summarizeRoles(payload);
    return {
      path: path.relative(workspaceDir, filePath),
      generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : undefined,
      ageMinutes: minutesSince(
        typeof payload.generatedAt === "string" ? payload.generatedAt : undefined,
      ),
      status: typeof payload.status === "string" ? payload.status : "unknown",
      roles,
      successfulRoles: roles.filter((role) => role.success).map((role) => role.role),
      failedRoles: roles.filter((role) => !role.success).map((role) => role.role),
    };
  }
  return undefined;
}

async function dailyUseCoverage(
  workspaceDir: string,
  nowMs = Date.now(),
  windowHours = 24,
): Promise<DailyUseCoverage> {
  const files = await listRecentCouncilFiles(workspaceDir);
  const windowMs = windowHours * 60 * 60 * 1_000;
  const roleUse = new Map<string, DailyRoleUse>();
  let latestCompleteCouncilAt: string | undefined;
  for (const filePath of files) {
    const payload = await readJsonIfExists(filePath);
    if (!payload) {
      continue;
    }
    const generatedAt = typeof payload.generatedAt === "string" ? payload.generatedAt : undefined;
    const generatedAtMs = generatedAt ? Date.parse(generatedAt) : NaN;
    if (!Number.isFinite(generatedAtMs) || nowMs - generatedAtMs > windowMs) {
      continue;
    }
    const roles = summarizeRoles(payload);
    const successfulRoles = new Set(roles.filter((role) => role.success).map((role) => role.role));
    if (REQUIRED_ROLES.every((role) => successfulRoles.has(role))) {
      if (
        !latestCompleteCouncilAt ||
        Date.parse(generatedAt ?? "") > Date.parse(latestCompleteCouncilAt)
      ) {
        latestCompleteCouncilAt = generatedAt;
      }
    }
    for (const role of roles) {
      const stats = roleUse.get(role.role) ?? {
        role: role.role,
        calls: 0,
        success: 0,
        failed: 0,
      };
      stats.calls += 1;
      if (role.success) {
        stats.success += 1;
      } else {
        stats.failed += 1;
      }
      if (
        generatedAt &&
        (!stats.latestAt || Date.parse(generatedAt) > Date.parse(stats.latestAt))
      ) {
        stats.latestAt = generatedAt;
      }
      roleUse.set(role.role, stats);
    }
  }
  const roleRows = [...roleUse.values()].toSorted((left, right) =>
    left.role.localeCompare(right.role),
  );
  const successfulRolesInWindow = roleRows
    .filter((role) => role.success > 0)
    .map((role) => role.role);
  const missingSuccessfulRoles = REQUIRED_ROLES.filter(
    (role) => !successfulRolesInWindow.includes(role),
  );
  const nextDueAt = latestCompleteCouncilAt
    ? new Date(Date.parse(latestCompleteCouncilAt) + windowMs).toISOString()
    : undefined;
  return {
    windowHours,
    completeCouncilInWindow: Boolean(latestCompleteCouncilAt),
    successfulRolesInWindow,
    missingSuccessfulRoles,
    roleUse: roleRows,
    latestCompleteCouncilAt,
    nextDueAt,
    dueNow: !latestCompleteCouncilAt || (nextDueAt ? Date.parse(nextDueAt) <= nowMs : true),
  };
}

function councilFreshAndComplete(
  council: LatestCouncil | undefined,
  maxFreshMinutes: number,
): boolean {
  if (!council || council.status === "degraded") {
    return false;
  }
  if (council.ageMinutes === undefined || council.ageMinutes > maxFreshMinutes) {
    return false;
  }
  return REQUIRED_ROLES.every((role) => council.successfulRoles.includes(role));
}

function extractTrainingTruth(snapshot: Record<string, unknown> | undefined) {
  const owners = recordValue(snapshot?.owners);
  const trainingPlan = recordValue(owners.trainingPlan);
  const skillOptLite = recordValue(owners.skillOptLite);
  const problemRadar = recordValue(owners.problemRadar);
  const latestCandidateEval = recordValue(trainingPlan.latestCandidateEval);
  const evolutionAcceleration = recordValue(trainingPlan.evolutionAcceleration);
  return {
    selectedCleanAdapter:
      typeof trainingPlan.selectedCleanAdapter === "string"
        ? trainingPlan.selectedCleanAdapter
        : undefined,
    latestCandidateAdapter:
      typeof latestCandidateEval.adapterPath === "string"
        ? latestCandidateEval.adapterPath
        : undefined,
    promotionReady:
      typeof latestCandidateEval.promotionReady === "boolean"
        ? latestCandidateEval.promotionReady
        : undefined,
    failedCaseIds: stringArray(latestCandidateEval.failedCaseIds),
    parseErrorCaseIds: stringArray(latestCandidateEval.parseErrorCaseIds),
    parseRecoveredCaseIds: stringArray(latestCandidateEval.parseRecoveredCaseIds),
    skillOptLiteStatus: typeof skillOptLite.status === "string" ? skillOptLite.status : undefined,
    skillOptLiteSkillId:
      typeof skillOptLite.skillId === "string" ? skillOptLite.skillId : undefined,
    blockedClusters: stringArray(problemRadar.blockedClusters),
    actionableClusters: stringArray(problemRadar.actionableClusters),
    fastestSafeNextAction: evolutionAcceleration.fastestSafeNextAction,
  };
}

function buildFocusPrompt(params: {
  options: CliOptions;
  trainingTruth: ReturnType<typeof extractTrainingTruth>;
  latestCouncil: LatestCouncil | undefined;
}) {
  const blockedCaseIds = [
    ...params.trainingTruth.failedCaseIds,
    ...params.trainingTruth.parseErrorCaseIds,
    ...params.trainingTruth.parseRecoveredCaseIds,
  ];
  const focus =
    params.options.focus ??
    [
      "LCX Agent provider-council acceleration review.",
      "目标：多花 Kimi/DeepSeek/MiniMax token 来加速本体进化，但只能产出可验证的 SOP 小改动、eval case、teacher curriculum 和 rejected edit buffer。",
      "重点失败族：single_stock_curve_technical_timing_preflight、external knowledge/module absorption、finance data provenance、review panel、direct buy/sell refusal。",
      "不要给交易建议，不要改 provider config，不要碰 external channel sender，不要碰 protected memory。",
    ].join(" ");

  return [
    focus,
    "",
    "当前本地真相：",
    `- selected_clean_adapter: ${params.trainingTruth.selectedCleanAdapter ?? "unknown"}`,
    `- latest_candidate_adapter: ${params.trainingTruth.latestCandidateAdapter ?? "unknown"}`,
    `- promotion_ready: ${String(params.trainingTruth.promotionReady ?? false)}`,
    `- blocked_case_ids: ${blockedCaseIds.join(", ") || "none"}`,
    `- skillopt_status: ${params.trainingTruth.skillOptLiteStatus ?? "unknown"}`,
    `- skillopt_skill_id: ${params.trainingTruth.skillOptLiteSkillId ?? "unknown"}`,
    `- blocked_clusters: ${params.trainingTruth.blockedClusters.join(", ") || "none"}`,
    `- latest_council: ${params.latestCouncil?.path ?? "none"}`,
    "",
    "三模型分工：",
    "- Kimi：把失败样本压缩成一个可执行 SOP 小改动和验证集题目。",
    "- DeepSeek：挑 source_registry、data_provenance_quality、eval_absorbed、direct_buy_sell_answer、technical_timing_as_standalone_alpha 的漏洞。",
    "- MiniMax：做反例和风险审查，防止为了烧 token 制造垃圾产物。",
    "",
    "输出要求：",
    "- 只给可落地的 3-6 个改进项。",
    "- 每项标注应该进入 skillopt_candidate_edit、eval_case、teacher_curriculum、rejected_edit_buffer 还是 discard。",
    "- 明确哪些东西不能直接吸收，必须等本地 eval 或训练吸收证据。",
  ].join("\n");
}

async function runCouncil(prompt: string, options: CliOptions): Promise<string> {
  process.env.OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL = "moonshot/kimi-k2.6";
  process.env.OPENCLAW_LEARNING_COUNCIL_DEEPSEEK_MODEL =
    "custom-api-deepseek-com/deepseek-v4-flash";
  process.env.OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL = "minimax-portal/MiniMax-M2.7";
  const messageId = `provider-council-acceleration-${new Date()
    .toISOString()
    .replaceAll(":", "-")}`;
  return runFeishuLearningCouncil({
    cfg: loadConfig(),
    userMessage: prompt,
    routeAgentId: options.routeAgentId,
    sessionKey: `agent:${options.routeAgentId}:provider-council-acceleration`,
    messageId,
    workspaceDir: options.workspaceDir,
  });
}

function runCouncilWithTimeout(prompt: string, options: CliOptions): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`provider council timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
  });
  return Promise.race([runCouncil(prompt, options), timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function renderText(details: Record<string, unknown>) {
  const dailyUse = recordValue(details.dailyUse);
  return [
    `Provider council acceleration | status=${displayValue(details.status)}`,
    `boundary=${displayValue(details.boundary)}`,
    `write=${displayValue(details.write)}`,
    `profile=${displayValue(details.profile)}`,
    `timeout_ms=${displayValue(details.timeoutMs)}`,
    `git_clean=${displayValue(details.gitClean)}`,
    `active_eval_or_mlx=${displayValue(details.activeEvalOrMlx)}`,
    `fresh_complete_council=${displayValue(details.freshCompleteCouncil)}`,
    `daily_complete=${displayValue(dailyUse.completeCouncilInWindow)}`,
    `daily_due_now=${displayValue(dailyUse.dueNow)}`,
    `action=${displayValue(details.action)}`,
    `next_safe_command=${displayValue(details.nextSafeCommand)}`,
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [gitLines, activePids, snapshot, council, dailyUse] = await Promise.all([
    gitStatusLines(),
    activePidSummary(options),
    readJsonIfExists(
      options.workspaceDir === DEFAULT_WORKSPACE_DIR
        ? GOVERNANCE_AUTOPILOT_LATEST_PATH
        : path.join(options.workspaceDir, "state", "lcx-governance-autopilot-latest.json"),
    ),
    latestCouncil(options.workspaceDir),
    dailyUseCoverage(options.workspaceDir),
  ]);
  const trainingTruth = extractTrainingTruth(snapshot);
  const gitClean = gitLines.length <= 1;
  const activeCounts = activePidCounts(activePids);
  const activeEvalOrMlx = activePids.eval.length > 0 || activePids.mlx.length > 0;
  const freshCompleteCouncil = councilFreshAndComplete(council, options.maxFreshMinutes);
  const prompt = buildFocusPrompt({ options, trainingTruth, latestCouncil: council });
  const hardBlocks = [
    ...(activeEvalOrMlx ? ["active_eval_or_mlx"] : []),
    ...(!gitClean ? ["dirty_git_worktree"] : []),
    ...(freshCompleteCouncil ? ["fresh_complete_three_role_council_exists"] : []),
  ];
  const canRunProviderCouncilNow = hardBlocks.length === 0;
  let providerResultSnippet: string | undefined;
  let providerRunError: string | undefined;
  let providerRunTimedOut = false;
  let forceExitAfterOutput = false;
  let action = options.write ? "deferred" : "dry_run_plan_only";
  let status = options.write ? "deferred_by_safety_gate" : "ready_plan";
  let ok = !options.write || canRunProviderCouncilNow;

  if (options.write && canRunProviderCouncilNow) {
    try {
      const result = await runCouncilWithTimeout(prompt, options);
      providerResultSnippet = result.slice(0, 2_000);
      action = "provider_council_run_completed";
      status = "provider_council_acceleration_receipt_written";
      ok = true;
    } catch (error) {
      providerRunError = error instanceof Error ? error.message : String(error);
      providerRunTimedOut = providerRunError.includes("provider council timeout");
      forceExitAfterOutput = providerRunTimedOut;
      action = providerRunTimedOut
        ? "provider_council_run_timed_out"
        : "provider_council_run_failed";
      status = "provider_council_acceleration_failed";
      ok = false;
    }
  }

  const details = {
    ok,
    boundary: "local_provider_council_acceleration_only",
    checkedAt: new Date().toISOString(),
    status,
    action,
    profile: options.profile,
    write: options.write,
    timeoutMs: options.timeoutMs,
    workspaceDir: options.workspaceDir,
    routeAgentId: options.routeAgentId,
    gitClean,
    gitStatus: gitLines,
    activePidCounts: activeCounts,
    activeEvalOrMlx,
    latestCouncil: council,
    freshCompleteCouncil,
    dailyUse,
    hardBlocks,
    canRunProviderCouncilNow,
    selectedCleanAdapter: trainingTruth.selectedCleanAdapter,
    latestCandidateAdapter: trainingTruth.latestCandidateAdapter,
    blockedCaseIds: [
      ...trainingTruth.failedCaseIds,
      ...trainingTruth.parseErrorCaseIds,
      ...trainingTruth.parseRecoveredCaseIds,
    ],
    skillOptLiteStatus: trainingTruth.skillOptLiteStatus,
    plannedPrompt: prompt,
    providerResultSnippet,
    providerRunError,
    providerRunTimedOut,
    nextSafeCommand:
      "node --import tsx scripts/dev/lcx-provider-council-acceleration.ts --write --json --profile aggressive",
    outputsFeed: [
      "skillopt_candidate_edit",
      "eval_case",
      "teacher_curriculum",
      "rejected_edit_buffer",
      "discard",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  if (options.json) {
    console.log(JSON.stringify(details, null, 2));
  } else {
    process.stdout.write(`${renderText(details)}\n`);
  }
  if (forceExitAfterOutput) {
    process.exit(1);
  }
}

await main();
