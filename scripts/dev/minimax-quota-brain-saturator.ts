import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CliOptions = {
  profile: "manual" | "minimax-plus-brain";
  used?: number;
  windowLimit?: number;
  resetMinutes?: number;
  reserve: number;
  batchLimit: number;
  maxCalls?: number;
  durationMinutes: number;
  write: boolean;
  mock: boolean;
  directApi: boolean;
  allowPartialWrite: boolean;
  openclawAgent: string;
  timeoutSeconds: number;
  concurrency: number;
  workspaceDir: string;
  logPath: string;
  promptDir: string;
  datasetEvery: number;
  smokeEvery: number;
  adaptive: boolean;
  minConcurrency: number;
  minBatchLimit: number;
  rateLimitCooldownSeconds: number;
  maxRateLimitRounds: number;
};

type TeacherPrompt = {
  id: string;
  userMessage: string;
  sourceSummary: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number | null;
};

type StepResult = CommandResult & {
  parsed: unknown;
};

const HOME = process.env.HOME ?? os.homedir();
const DEFAULT_WORKSPACE = path.join(HOME, ".openclaw", "workspace");
const DEFAULT_PROMPT_DIR = path.join(DEFAULT_WORKSPACE, "tmp", "minimax-quota-prompts");
const DEFAULT_LOG = path.join(
  DEFAULT_WORKSPACE,
  "logs",
  `minimax-quota-brain-saturator-${new Date().toISOString().slice(0, 10)}.jsonl`,
);

const TASK_TEMPLATES = [
  {
    family: "portfolio_regime_risk",
    message:
      "我持有 {assetA}、{assetB}、{assetC}，担心未来 {horizon} 的利率、美元流动性和风险偏好切换。先拆模块，不要给买卖建议。",
    summary: "portfolio regime planning with no execution authority and incomplete live data.",
  },
  {
    family: "missing_quant_inputs",
    message:
      "帮我算 {assetA}/{assetB}/{assetC} 的相关性、波动、回撤和利率敏感性，但我还没给仓位权重和收益率序列。先说本地数学模块怎么做。",
    summary: "quant math request with missing position weights and return series.",
  },
  {
    family: "source_gated_learning",
    message:
      "去学习一篇关于 {theme} 的高质量金融论文，沉淀成可复用规则，但我没有给 URL 或本地文件。",
    summary: "finance learning intake without safe local source path or URL.",
  },
  {
    family: "factor_overfit_guard",
    message: "学一个 {theme} 策略，但不要回测神话，要检查样本外、幸存者偏差、交易成本和失效条件。",
    summary: "factor timing learning with overfit and out-of-sample guardrails.",
  },
  {
    family: "single_company_transmission",
    message:
      "研究 {assetA} 的基本面风险：收入质量、估值、客户集中度和宏观传导，只输出 research-only 风险图。",
    summary: "single company fundamentals with portfolio transmission, no trade recommendation.",
  },
  {
    family: "context_reset_guard",
    message: "重新来一遍，但这次别串到旧的 {theme} 任务；如果我没说清楚，就先问我要当前对象。",
    summary: "ambiguous repeat requiring current subject instead of old Lark context reuse.",
  },
  {
    family: "evidence_audit",
    message:
      "你刚才关于 {theme} 的判断证据在哪里？没有 artifact、source 或 receipt 就标 unverified。",
    summary: "evidence audit before durable memory or user-visible conclusion.",
  },
  {
    family: "review_panel_handoff",
    message: "本地大脑先做 {theme} 分析，再让三个大模型审阅，最后给我一个可用的中文控制室总结。",
    summary: "local planning plus multi-model review handoff with final user-facing answer.",
  },
] as const;

const ASSETS = [
  ["QQQ", "TLT", "NVDA"],
  ["SPY", "IEF", "MSFT"],
  ["IWM", "HYG", "AAPL"],
  ["XLK", "XLF", "GOOGL"],
  ["GLD", "UUP", "AMD"],
] as const;

const THEMES = [
  "ETF regime timing",
  "duration risk",
  "earnings revision quality",
  "AI capex transmission",
  "credit liquidity stress",
  "volatility risk premium",
  "fundamental moat deterioration",
  "macro inflation re-acceleration",
  "portfolio drawdown control",
  "factor crowding",
] as const;

const HORIZONS = ["一周", "两周", "一个月", "一个季度"] as const;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/minimax-quota-brain-saturator.ts --used N --window-limit N --reset-minutes N [--write]",
      "",
      "Purpose:",
      "  Generate non-sensitive MiniMax teacher prompts until the current 5h text-generation quota is mostly used.",
      "  Accepted samples are written only as brain distillation review artifacts.",
      "",
      "Options:",
      "  --used N              optional current used calls/tokens shown by MiniMax",
      "  --window-limit N      optional current 5h window limit",
      "  --reset-minutes N     optional minutes until reset",
      "  --duration-minutes N  automatic run budget when quota numbers are omitted, default 285",
      "  --reserve N           keep this much quota unused when quota numbers are supplied, default 150",
      "  --batch-limit N       prompts per teacher batch, default 12",
      "  --max-calls N         hard cap attempts for this run",
      "  --profile NAME        reusable preset: minimax-plus-brain",
      "  --adaptive            lower batch/concurrency and cool down on provider rate limits",
      "  --min-concurrency N   adaptive floor, default 4",
      "  --min-batch-limit N   adaptive floor, default 12",
      "  --rate-limit-cooldown-seconds N  wait after 429/2062, default 120",
      "  --max-rate-limit-rounds N        stop after this many limit rounds, default 4",
      "  --write               actually call MiniMax and write review artifacts; default is dry-run",
      "  --mock                use mock teacher for smoke without provider quota",
      "  --direct-api          call MiniMax directly with auth profile fallback instead of openclaw agent",
      "  --allow-partial-write write accepted teacher samples even when some calls fail",
      "  --openclaw-agent ID   default research-minimax",
      "  --concurrency N       parallel MiniMax teacher calls per batch, default 8",
      "  --dataset-every N     rebuild dataset every N rounds, default 5",
      "  --smoke-every N       run local smoke every N rounds, default 10",
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

function readNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    usage();
  }
  return parsed;
}

function readPositiveInteger(value: string): number {
  const parsed = readNonNegativeInteger(value);
  if (parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    profile: "manual",
    used: undefined,
    windowLimit: undefined,
    resetMinutes: undefined,
    reserve: 150,
    batchLimit: 12,
    durationMinutes: 285,
    write: false,
    mock: false,
    directApi: false,
    allowPartialWrite: false,
    openclawAgent: "research-minimax",
    timeoutSeconds: 600,
    concurrency: 8,
    workspaceDir: DEFAULT_WORKSPACE,
    logPath: DEFAULT_LOG,
    promptDir: DEFAULT_PROMPT_DIR,
    datasetEvery: 5,
    smokeEvery: 10,
    adaptive: false,
    minConcurrency: 4,
    minBatchLimit: 12,
    rateLimitCooldownSeconds: 120,
    maxRateLimitRounds: 4,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      const profile = readValue(args, index);
      if (profile !== "minimax-plus-brain") {
        usage();
      }
      options.profile = profile;
      options.directApi = true;
      options.allowPartialWrite = true;
      options.adaptive = true;
      options.batchLimit = 36;
      options.concurrency = 12;
      options.datasetEvery = 2;
      options.smokeEvery = 4;
      options.reserve = 100;
      index += 1;
    } else if (arg === "--used") {
      options.used = readNonNegativeInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--window-limit") {
      options.windowLimit = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--reset-minutes") {
      options.resetMinutes = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--reserve") {
      options.reserve = readNonNegativeInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--batch-limit") {
      options.batchLimit = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--max-calls") {
      options.maxCalls = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--adaptive") {
      options.adaptive = true;
    } else if (arg === "--min-concurrency") {
      options.minConcurrency = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--min-batch-limit") {
      options.minBatchLimit = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--rate-limit-cooldown-seconds") {
      options.rateLimitCooldownSeconds = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--max-rate-limit-rounds") {
      options.maxRateLimitRounds = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--duration-minutes") {
      options.durationMinutes = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--direct-api") {
      options.directApi = true;
    } else if (arg === "--allow-partial-write") {
      options.allowPartialWrite = true;
    } else if (arg === "--openclaw-agent") {
      options.openclawAgent = readValue(args, index);
      index += 1;
    } else if (arg === "--timeout") {
      options.timeoutSeconds = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--concurrency") {
      options.concurrency = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--workspace") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--log") {
      options.logPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--prompt-dir") {
      options.promptDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--dataset-every") {
      options.datasetEvery = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--smoke-every") {
      options.smokeEvery = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (options.minConcurrency > options.concurrency) {
    throw new Error("--min-concurrency cannot exceed --concurrency");
  }
  if (options.minBatchLimit > options.batchLimit) {
    throw new Error("--min-batch-limit cannot exceed --batch-limit");
  }
  const hasQuotaSnapshot =
    options.used !== undefined ||
    options.windowLimit !== undefined ||
    options.resetMinutes !== undefined;
  if (
    hasQuotaSnapshot &&
    (options.used === undefined ||
      options.windowLimit === undefined ||
      options.resetMinutes === undefined)
  ) {
    throw new Error("--used, --window-limit, and --reset-minutes must be supplied together");
  }
  if (
    options.used !== undefined &&
    options.windowLimit !== undefined &&
    options.used >= options.windowLimit
  ) {
    throw new Error("used quota is already greater than or equal to the window limit");
  }
  options.workspaceDir = path.resolve(options.workspaceDir);
  return options;
}

function targetCalls(options: CliOptions): number {
  if (options.used === undefined || options.windowLimit === undefined) {
    return options.maxCalls ?? 1_000_000;
  }
  const available = Math.max(0, options.windowLimit - options.used - options.reserve);
  return Math.max(0, Math.min(available, options.maxCalls ?? available));
}

function quotaMode(options: CliOptions): "snapshot" | "automatic" {
  return options.used !== undefined && options.windowLimit !== undefined ? "snapshot" : "automatic";
}

function fillTemplate(template: string, index: number): string {
  const assets = ASSETS[index % ASSETS.length];
  return template
    .replaceAll("{assetA}", assets[0])
    .replaceAll("{assetB}", assets[1])
    .replaceAll("{assetC}", assets[2])
    .replaceAll("{theme}", THEMES[index % THEMES.length])
    .replaceAll("{horizon}", HORIZONS[index % HORIZONS.length]);
}

function buildPrompt(index: number): TeacherPrompt {
  const template = TASK_TEMPLATES[index % TASK_TEMPLATES.length];
  const variant = Math.floor(index / TASK_TEMPLATES.length);
  return {
    id: `quota_${template.family}_${String(variant).padStart(5, "0")}`,
    userMessage: `${fillTemplate(template.message, index)} 验收码 minimax-quota-${String(index).padStart(5, "0")}`,
    sourceSummary: `${template.summary} Synthetic quota-training prompt; no private user data or live market claim supplied.`,
  };
}

function buildPrompts(start: number, count: number): TeacherPrompt[] {
  return Array.from({ length: count }, (_unused, offset) => buildPrompt(start + offset));
}

async function appendLog(logPath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`);
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, durationMs: Date.now() - started, exitCode });
    });
  });
}

function parseJsonFromStdout(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return JSON.parse(stdout.slice(start, end + 1)) as unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runJsonStep(
  options: CliOptions,
  round: number,
  name: string,
  command: string,
  args: string[],
  stepOptions: { allowFailure?: boolean } = {},
): Promise<StepResult> {
  process.stdout.write(`\n[minimax-quota] round=${round} step=${name}\n`);
  const result = await runCommand(command, args);
  const parsed = parseJsonFromStdout(result.stdout);
  await appendLog(options.logPath, {
    event: result.exitCode === 0 ? "step_ok" : "step_failed",
    round,
    name,
    command,
    args,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    result: parsed,
  });
  if (result.exitCode !== 0 && !stepOptions.allowFailure) {
    throw new Error(`${name} failed with exit code ${result.exitCode}`);
  }
  return { ...result, parsed };
}

async function writePromptFile(
  options: CliOptions,
  round: number,
  prompts: TeacherPrompt[],
): Promise<string> {
  await fs.mkdir(options.promptDir, { recursive: true });
  const promptPath = path.join(
    options.promptDir,
    `quota-prompts-${new Date().toISOString().replace(/[:.]/gu, "-")}-r${round}.json`,
  );
  await fs.writeFile(promptPath, `${JSON.stringify(prompts, null, 2)}\n`, "utf8");
  return promptPath;
}

const options = parseArgs(process.argv.slice(2));
const calls = targetCalls(options);
const rounds = Math.ceil(calls / options.batchLimit);
const deadline = Date.now() + options.durationMinutes * 60_000;
const plan = {
  ok: true,
  mode: options.write ? "execute" : "dry_run",
  boundary: "brain_distillation_review_only",
  profile: options.profile,
  quotaMode: quotaMode(options),
  used: options.used,
  windowLimit: options.windowLimit,
  resetMinutes: options.resetMinutes,
  reserve: options.reserve,
  targetCalls: calls,
  batchLimit: options.batchLimit,
  estimatedRounds: quotaMode(options) === "snapshot" ? rounds : "until_quota_or_deadline",
  durationMinutes: options.durationMinutes,
  openclawAgent: options.openclawAgent,
  concurrency: options.concurrency,
  adaptive: options.adaptive,
  minConcurrency: options.minConcurrency,
  minBatchLimit: options.minBatchLimit,
  rateLimitCooldownSeconds: options.rateLimitCooldownSeconds,
  maxRateLimitRounds: options.maxRateLimitRounds,
  mock: options.mock,
  directApi: options.directApi,
  allowPartialWrite: options.allowPartialWrite,
  workspaceDir: options.workspaceDir,
  logPath: options.logPath,
  promptDir: options.promptDir,
  notTouched: [
    "live_sender",
    "provider_config",
    "protected_repo_memory",
    "formal_lark_routing_corpus",
    "finance_doctrine",
  ],
};

if (!options.write) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

await appendLog(options.logPath, { event: "quota_saturator_start", plan });

let attempted = 0;
let completedRounds = 0;
let stopReason = "target_calls_reached";
let currentBatchLimit = options.batchLimit;
let currentConcurrency = options.concurrency;
let consecutiveRateLimitRounds = 0;

function isProviderLimitSignal(result: StepResult): boolean {
  const haystack =
    `${result.stdout}\n${result.stderr}\n${JSON.stringify(result.parsed)}`.toLowerCase();
  return [
    "429",
    "rate limit",
    "ratelimit",
    "quota exceeded",
    "quota limit",
    "usage quota",
    "insufficient quota",
    "too many requests",
    "usage limit",
    "resource_exhausted",
    "billing",
  ].some((needle) => haystack.includes(needle));
}

function acceptedCandidatesFromResult(result: StepResult): number {
  if (!result.parsed || typeof result.parsed !== "object") {
    return 0;
  }
  const payload = result.parsed as { acceptedCandidates?: unknown };
  return typeof payload.acceptedCandidates === "number" &&
    Number.isFinite(payload.acceptedCandidates)
    ? payload.acceptedCandidates
    : 0;
}

async function runIntegrityChecks(round: number, force: boolean): Promise<void> {
  if (force || round % options.datasetEvery === 0 || attempted >= calls) {
    await runJsonStep(options, round, "dataset", "node", [
      "--import",
      "tsx",
      "scripts/dev/local-brain-distill-dataset.ts",
      "--json",
    ]);
  }
  if (force || round % options.smokeEvery === 0 || attempted >= calls) {
    await runJsonStep(options, round, "smoke", "node", [
      "--import",
      "tsx",
      "scripts/dev/local-brain-distill-smoke.ts",
      "--json",
    ]);
  }
}

async function backOffAfterRateLimit(round: number): Promise<boolean> {
  const previousBatchLimit = currentBatchLimit;
  const previousConcurrency = currentConcurrency;
  currentBatchLimit = Math.max(options.minBatchLimit, Math.floor(currentBatchLimit / 2));
  currentConcurrency = Math.max(options.minConcurrency, Math.floor(currentConcurrency / 2));
  await appendLog(options.logPath, {
    event: "adaptive_rate_limit_backoff",
    round,
    consecutiveRateLimitRounds,
    previousBatchLimit,
    previousConcurrency,
    nextBatchLimit: currentBatchLimit,
    nextConcurrency: currentConcurrency,
    cooldownSeconds: options.rateLimitCooldownSeconds,
  });
  process.stdout.write(
    `[minimax-quota] adaptive_backoff round=${round} concurrency=${previousConcurrency}->${currentConcurrency} batch=${previousBatchLimit}->${currentBatchLimit} cooldown=${options.rateLimitCooldownSeconds}s\n`,
  );
  if (Date.now() + options.rateLimitCooldownSeconds * 1_000 >= deadline) {
    stopReason = "provider_quota_or_rate_limit";
    return false;
  }
  await sleep(options.rateLimitCooldownSeconds * 1_000);
  return true;
}

try {
  for (let round = 1; attempted < calls && Date.now() < deadline; round += 1) {
    const remaining = calls - attempted;
    const batchSize = Math.min(currentBatchLimit, remaining);
    const prompts = buildPrompts(attempted, batchSize);
    const promptPath = await writePromptFile(options, round, prompts);
    const teacherResult = await runJsonStep(
      options,
      round,
      "minimax_teacher_batch",
      "node",
      [
        "--import",
        "tsx",
        "scripts/dev/minimax-brain-teacher-batch.ts",
        "--prompt-file",
        promptPath,
        "--limit",
        String(batchSize),
        "--write",
        "--json",
        "--timeout",
        String(options.timeoutSeconds),
        "--concurrency",
        String(currentConcurrency),
        ...(options.directApi ? ["--direct-api"] : ["--openclaw-agent", options.openclawAgent]),
        ...(options.allowPartialWrite ? ["--allow-partial-write"] : []),
        ...(options.mock ? ["--mock"] : []),
      ],
      { allowFailure: true },
    );
    const providerLimited = isProviderLimitSignal(teacherResult);
    if (teacherResult.exitCode !== 0) {
      const acceptedCandidates = acceptedCandidatesFromResult(teacherResult);
      if (options.allowPartialWrite && acceptedCandidates > 0) {
        await appendLog(options.logPath, {
          event: "teacher_batch_partial_ok",
          round,
          acceptedCandidates,
          exitCode: teacherResult.exitCode,
        });
        attempted += batchSize;
        completedRounds = round;
        if (providerLimited) {
          stopReason = "provider_quota_or_rate_limit";
          consecutiveRateLimitRounds += 1;
          await runIntegrityChecks(round, true);
          if (
            !options.adaptive ||
            consecutiveRateLimitRounds >= options.maxRateLimitRounds ||
            !(await backOffAfterRateLimit(round))
          ) {
            break;
          }
          continue;
        }
      } else if (providerLimited) {
        stopReason = "provider_quota_or_rate_limit";
        consecutiveRateLimitRounds += 1;
        if (
          !options.adaptive ||
          consecutiveRateLimitRounds >= options.maxRateLimitRounds ||
          !(await backOffAfterRateLimit(round))
        ) {
          break;
        }
        continue;
      } else {
        throw new Error(`minimax_teacher_batch failed with exit code ${teacherResult.exitCode}`);
      }
    } else {
      consecutiveRateLimitRounds = 0;
      stopReason = "target_calls_reached";
      attempted += batchSize;
      completedRounds = round;
    }

    await runIntegrityChecks(round, false);
  }
  await appendLog(options.logPath, {
    event: "quota_saturator_complete",
    attempted,
    completedRounds,
    stopReason: Date.now() >= deadline ? "duration_deadline" : stopReason,
    finalBatchLimit: currentBatchLimit,
    finalConcurrency: currentConcurrency,
    consecutiveRateLimitRounds,
    liveTouched: false,
    providerConfigTouched: false,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        attempted,
        completedRounds,
        stopReason: Date.now() >= deadline ? "duration_deadline" : stopReason,
        finalBatchLimit: currentBatchLimit,
        finalConcurrency: currentConcurrency,
        consecutiveRateLimitRounds,
        logPath: options.logPath,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  await appendLog(options.logPath, {
    event: "quota_saturator_failed",
    attempted,
    completedRounds,
    finalBatchLimit: currentBatchLimit,
    finalConcurrency: currentConcurrency,
    consecutiveRateLimitRounds,
    error: String(error),
    liveTouched: false,
    providerConfigTouched: false,
  });
  throw error;
}
