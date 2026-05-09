import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CliOptions = {
  durationMinutes: number;
  batchLimit: number;
  teacherProfile: "batch" | "minimax-plus-brain";
  teacherDurationMinutes: number;
  teacherConcurrency: number;
  teacherSidecar: boolean;
  teacherSidecarMaxCalls: number;
  teacherSidecarDurationMinutes: number;
  teacherSidecarBatchLimit: number;
  teacherSidecarConcurrency: number;
  requestedDurationMinutes: number;
  durationAutoUpgraded: boolean;
  trainEvery: number;
  evalEvery: number;
  trainIters: number;
  loadMax: number;
  trainLoadMax: number;
  model: string;
  bootstrapIfMissing: boolean;
  noTrain: boolean;
  mock: boolean;
  resolveCurrentAdapterOnly: boolean;
  workspaceDir: string;
  dataDir: string;
  trainSliceDir: string;
  trainSliceMaxReviewExamples: number;
  trainSliceCuratedRepeat: number;
  trainSliceNonReviewRepeat: number;
  noTrainSlice: boolean;
  pythonBin: string;
  currentAdapter: string;
  adapterPrefix: string;
  logPath: string;
  lockPath: string;
  lockEnabled: boolean;
};

type CommandResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
};

type ActiveProcess = {
  pid: number;
  command: string;
};

const HOME = process.env.HOME ?? os.homedir();
const TRAINER_ROOT = path.join(HOME, ".openclaw", "local-brain-trainer");
const DEFAULT_DATA_DIR = path.join(TRAINER_ROOT, "datasets", "thought-flow-v1");
const DEFAULT_MODEL = "Qwen/Qwen3-0.6B";
const LEGACY_QWEN_0_6B_SEED_ADAPTER = path.join(
  TRAINER_ROOT,
  "adapters",
  "thought-flow-v1-qwen3-0.6b-teacher-v7",
);
const DEFAULT_LOG = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "logs",
  "minimax-brain-training-guard.jsonl",
);
const DEFAULT_GUARD_LOG_DIR = path.dirname(DEFAULT_LOG);
const DEFAULT_LOCK = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "run",
  "minimax-brain-training-guard.lock",
);
const CPU_COUNT = Math.max(1, os.cpus().length);
const DEFAULT_LOAD_MAX = 100;
const DEFAULT_TRAIN_LOAD_MAX = 12;
const MIN_PROMOTION_EVAL_CASES = 50;
const MEDIUM_MINIMAX_SIDECAR_DURATION_MINUTES = 285;
const TRAIN_SKIP_BACKOFF_MS = 5 * 60_000;
const DEFAULT_TRAIN_SLICE_MAX_REVIEW_EXAMPLES = 1024;
const DEFAULT_TRAIN_SLICE_CURATED_REPEAT = 6;
const DEFAULT_TRAIN_SLICE_NON_REVIEW_REPEAT = 2;
const CATASTROPHIC_CANDIDATE_MIN_CASES = 10;
const CATASTROPHIC_CANDIDATE_MAX_PASS_RATE = 0.05;
const LOCAL_TRAINING_COLLAPSE_BACKOFF_SEED_LIMIT = 2;
const TRAINING_ABSORPTION_CONTRACT_VERSION = "compact_teacher_review_v2";
const TRAIN_NAN_PATTERN = /\b(?:train|val)\s+loss\s+nan\b|\bloss\s*[:=]\s*nan\b|\bnan\b/iu;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/minimax-brain-training-guard.ts [options]",
      "",
      "Options:",
      "  --duration-minutes N   default 285 for real MiniMax sidecar training",
      "  --batch-limit N         MiniMax teacher samples per round, default 20",
      "  --teacher-profile NAME  batch|minimax-plus-brain, default minimax-plus-brain",
      "  --teacher-duration-minutes N  per-round teacher budget, default 12",
      "  --teacher-concurrency N       per-round teacher concurrency, default 6",
      "  --teacher-sidecar       run MiniMax teacher as a continuous sidecar, default on for minimax-plus-brain",
      "  --no-teacher-sidecar    keep old serial per-round MiniMax teacher behavior",
      "  --teacher-sidecar-max-calls N  sidecar attempt cap, default 900",
      "  --teacher-sidecar-duration-minutes N  sidecar budget, default matches guard duration",
      "  --teacher-sidecar-batch-limit N       sidecar batch size, default 36",
      "  --teacher-sidecar-concurrency N       sidecar concurrency, default 8",
      "  --train-every N         train every N rounds, default 3",
      "  --eval-every N          eval current/new adapter every N rounds, default 1",
      "  --train-iters N         MLX LoRA iters, default 40",
      "  --train-slice-dir DIR   bounded balanced MLX train data dir, default <data>-train-slice",
      "  --train-slice-max-review-examples N  review examples kept in local train slice, default 1024",
      "  --train-slice-curated-repeat N       curated seed repeat in train slice, default 6",
      "  --train-slice-non-review-repeat N    non-review receipt repeat in train slice, default 2",
      "  --no-train-slice       train directly on full dataset; not recommended for Qwen3-0.6B",
      "  --load-max N            skip the guard when 1m system load is above N, default 100",
      "  --train-load-max N      skip local MLX LoRA train when 1m system load is above N, default 12",
      "  --bootstrap-if-missing  train a first adapter from the base model when no matching adapter exists",
      "  --no-train              only generate/rebuild/smoke/eval",
      "  --mock                  use mock MiniMax teacher for mechanism smoke",
      "  --resolve-current-adapter  print selected stable adapter and exit without writes",
      "  --current-adapter DIR   stable adapter, latest-passing, or latest directory match",
      "  --adapter-prefix DIR    new adapter prefix",
      "  --log PATH              JSONL guard log",
      "  --lock PATH             lock file path",
      "  --no-lock               disable lock file, but still checks active guard process",
    ].join("\n"),
  );
}

function modelSlug(model: string): string {
  const lastSegment = model.trim().split("/").filter(Boolean).at(-1) ?? model.trim();
  return lastSegment
    .toLowerCase()
    .replace(/[^a-z0-9.]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function defaultAdapterPrefixForModel(model: string): string {
  return path.join(TRAINER_ROOT, "adapters", `thought-flow-v1-${modelSlug(model)}-minimax-guard`);
}

function defaultSeedAdapterForModel(model: string): string | undefined {
  return modelSlug(model) === "qwen3-0.6b" ? LEGACY_QWEN_0_6B_SEED_ADAPTER : undefined;
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function readPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  let adapterPrefixProvided = false;
  let trainSliceDirProvided = false;
  const options: CliOptions = {
    durationMinutes: MEDIUM_MINIMAX_SIDECAR_DURATION_MINUTES,
    batchLimit: 20,
    teacherProfile: "minimax-plus-brain",
    teacherDurationMinutes: 12,
    teacherConcurrency: 6,
    teacherSidecar: true,
    teacherSidecarMaxCalls: 900,
    teacherSidecarDurationMinutes: 0,
    teacherSidecarBatchLimit: 36,
    teacherSidecarConcurrency: 8,
    requestedDurationMinutes: MEDIUM_MINIMAX_SIDECAR_DURATION_MINUTES,
    durationAutoUpgraded: false,
    trainEvery: 3,
    evalEvery: 1,
    trainIters: 40,
    loadMax: DEFAULT_LOAD_MAX,
    trainLoadMax: DEFAULT_TRAIN_LOAD_MAX,
    model: DEFAULT_MODEL,
    bootstrapIfMissing: false,
    noTrain: false,
    mock: false,
    resolveCurrentAdapterOnly: false,
    workspaceDir: path.join(HOME, ".openclaw", "workspace"),
    dataDir: DEFAULT_DATA_DIR,
    trainSliceDir: `${DEFAULT_DATA_DIR}-train-slice`,
    trainSliceMaxReviewExamples: DEFAULT_TRAIN_SLICE_MAX_REVIEW_EXAMPLES,
    trainSliceCuratedRepeat: DEFAULT_TRAIN_SLICE_CURATED_REPEAT,
    trainSliceNonReviewRepeat: DEFAULT_TRAIN_SLICE_NON_REVIEW_REPEAT,
    noTrainSlice: false,
    pythonBin: path.join(TRAINER_ROOT, ".venv", "bin", "python"),
    currentAdapter: "latest-passing",
    adapterPrefix: defaultAdapterPrefixForModel(DEFAULT_MODEL),
    logPath: DEFAULT_LOG,
    lockPath: DEFAULT_LOCK,
    lockEnabled: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--duration-minutes") {
      options.durationMinutes = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--batch-limit") {
      options.batchLimit = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--teacher-profile") {
      const value = readValue(args, index);
      if (value !== "batch" && value !== "minimax-plus-brain") {
        usage();
      }
      options.teacherProfile = value;
      index += 1;
    } else if (arg === "--teacher-duration-minutes") {
      options.teacherDurationMinutes = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--teacher-concurrency") {
      options.teacherConcurrency = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--teacher-sidecar") {
      options.teacherSidecar = true;
    } else if (arg === "--no-teacher-sidecar") {
      options.teacherSidecar = false;
    } else if (arg === "--teacher-sidecar-max-calls") {
      options.teacherSidecarMaxCalls = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--teacher-sidecar-duration-minutes") {
      options.teacherSidecarDurationMinutes = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--teacher-sidecar-batch-limit") {
      options.teacherSidecarBatchLimit = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--teacher-sidecar-concurrency") {
      options.teacherSidecarConcurrency = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--train-every") {
      options.trainEvery = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--eval-every") {
      options.evalEvery = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--train-iters") {
      options.trainIters = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--train-slice-dir") {
      options.trainSliceDir = path.resolve(readValue(args, index));
      trainSliceDirProvided = true;
      index += 1;
    } else if (arg === "--train-slice-max-review-examples") {
      options.trainSliceMaxReviewExamples = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--train-slice-curated-repeat") {
      options.trainSliceCuratedRepeat = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--train-slice-non-review-repeat") {
      options.trainSliceNonReviewRepeat = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--no-train-slice") {
      options.noTrainSlice = true;
    } else if (arg === "--load-max") {
      options.loadMax = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--train-load-max") {
      options.trainLoadMax = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--model") {
      options.model = readValue(args, index);
      index += 1;
    } else if (arg === "--bootstrap-if-missing") {
      options.bootstrapIfMissing = true;
    } else if (arg === "--no-train") {
      options.noTrain = true;
    } else if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--resolve-current-adapter") {
      options.resolveCurrentAdapterOnly = true;
    } else if (arg === "--workspace") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--data") {
      options.dataDir = path.resolve(readValue(args, index));
      if (!trainSliceDirProvided) {
        options.trainSliceDir = `${options.dataDir}-train-slice`;
      }
      index += 1;
    } else if (arg === "--python") {
      options.pythonBin = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--current-adapter") {
      const value = readValue(args, index);
      options.currentAdapter =
        value === "latest" || value === "latest-passing" ? value : path.resolve(value);
      index += 1;
    } else if (arg === "--adapter-prefix") {
      options.adapterPrefix = path.resolve(readValue(args, index));
      adapterPrefixProvided = true;
      index += 1;
    } else if (arg === "--log") {
      options.logPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--lock") {
      options.lockPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--no-lock") {
      options.lockEnabled = false;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (!adapterPrefixProvided) {
    options.adapterPrefix = defaultAdapterPrefixForModel(options.model);
  }
  if (!trainSliceDirProvided) {
    options.trainSliceDir = `${options.dataDir}-train-slice`;
  }
  options.requestedDurationMinutes = options.durationMinutes;
  if (shouldUpgradeToMediumMiniMaxWindow(options)) {
    options.durationMinutes = MEDIUM_MINIMAX_SIDECAR_DURATION_MINUTES;
    options.durationAutoUpgraded = true;
  }
  return options;
}

function shouldUpgradeToMediumMiniMaxWindow(options: CliOptions): boolean {
  return (
    options.teacherProfile === "minimax-plus-brain" &&
    options.teacherSidecar &&
    !options.mock &&
    !options.noTrain &&
    !options.resolveCurrentAdapterOnly &&
    options.durationMinutes < MEDIUM_MINIMAX_SIDECAR_DURATION_MINUTES
  );
}

async function appendLog(logPath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<CommandResult> {
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
    child.on("close", (code) => {
      const result = { command, args, stdout, stderr, durationMs: Date.now() - started };
      if (code === 0 || options.allowFailure) {
        resolve(result);
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr}\n${stdout}`));
      }
    });
  });
}

function parseJsonFromStdout(stdout: string): unknown {
  const end = stdout.lastIndexOf("}");
  if (end < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = end; index >= 0; index -= 1) {
    const char = stdout[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(stdout.slice(index, end + 1));
      }
    }
  }
  return null;
}

function runQuietCommand(command: string, args: string[]): Promise<CommandResult> {
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
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      resolve({ command, args, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isGuardRuntimeCommand(command: string): boolean {
  return /^(?:\S*\/)?node\s+--import(?:=tsx|\s+tsx)\s+scripts\/dev\/minimax-brain-training-guard\.ts(?:\s|$)/u.test(
    command.trim(),
  );
}

async function activeGuardProcesses(): Promise<ActiveProcess[]> {
  const result = await runQuietCommand("ps", ["-axo", "pid=,command="]);
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => isGuardRuntimeCommand(line))
    .map((line) => {
      const match = /^(\d+)\s+(.+)$/u.exec(line);
      if (!match) {
        return undefined;
      }
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter(
      (entry): entry is ActiveProcess =>
        Boolean(entry) &&
        entry.pid !== process.pid &&
        !entry.command.includes("--resolve-current-adapter"),
    );
}

async function reportAlreadyRunning(params: {
  reason: string;
  activeProcesses: ActiveProcess[];
  lockPath?: string;
}): Promise<never> {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        status: "already_running",
        boundary: "local_auxiliary_thought_flow_only",
        reason: params.reason,
        activeProcesses: params.activeProcesses,
        lockPath: params.lockPath,
        liveTouched: false,
        providerConfigTouched: false,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

async function acquireRunLock(options: CliOptions): Promise<() => Promise<void>> {
  const active = await activeGuardProcesses();
  if (active.length > 0) {
    await reportAlreadyRunning({ reason: "active_guard_process", activeProcesses: active });
  }
  if (!options.lockEnabled) {
    return async () => {};
  }
  await fs.mkdir(path.dirname(options.lockPath), { recursive: true });
  try {
    const handle = await fs.open(options.lockPath, "wx");
    await handle.writeFile(
      `${JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          command: process.argv.join(" "),
          logPath: options.logPath,
          cwd: process.cwd(),
        },
        null,
        2,
      )}\n`,
    );
    await handle.close();
  } catch {
    const raw = await fs.readFile(options.lockPath, "utf8").catch(() => "");
    const parsed = raw ? (JSON.parse(raw) as { pid?: unknown }) : {};
    const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
    if (pid && isProcessAlive(pid)) {
      await reportAlreadyRunning({
        reason: "active_lock",
        activeProcesses: [{ pid, command: "recorded in lock file" }],
        lockPath: options.lockPath,
      });
    }
    await fs.rm(options.lockPath, { force: true });
    return acquireRunLock(options);
  }
  return async () => {
    const raw = await fs.readFile(options.lockPath, "utf8").catch(() => "");
    const parsed = raw ? (JSON.parse(raw) as { pid?: unknown }) : {};
    if (parsed.pid === process.pid) {
      await fs.rm(options.lockPath, { force: true });
    }
  };
}

async function hasAdapterConfig(adapterPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path.join(adapterPath, "adapter_config.json"));
    return stats.isFile();
  } catch {
    return false;
  }
}

async function hasAdapterWeights(adapterPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path.join(adapterPath, "adapters.safetensors"));
    return stats.isFile();
  } catch {
    return false;
  }
}

async function resolveLatestAdapter(adapterPrefix: string): Promise<string | undefined> {
  const adapterRoot = path.dirname(adapterPrefix);
  const adapterNamePrefix = `${path.basename(adapterPrefix)}-`;
  let entries: string[];
  try {
    entries = await fs.readdir(adapterRoot);
  } catch {
    return undefined;
  }
  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(adapterNamePrefix))
        .toSorted()
        .toReversed()
        .map(async (entry) => {
          const adapterPath = path.join(adapterRoot, entry);
          return (await hasAdapterConfig(adapterPath)) ? adapterPath : undefined;
        }),
    )
  ).filter((entry): entry is string => Boolean(entry));
  return candidates[0];
}

type EvalVerdict = {
  at: string;
  adapterPath: string;
  promotionReady: boolean;
  passed: number;
  total: number;
  passRate: number;
  failedCount: number;
  source: string;
};

function evalSummaryFromPayload(payload: Record<string, unknown>):
  | {
      promotionReady: boolean;
      passed: number;
      total: number;
      passRate: number;
      failedCount: number;
    }
  | undefined {
  if (payload.event !== "step_ok") {
    return undefined;
  }
  if (
    payload.name !== "stable_hardened_eval" &&
    payload.name !== "training_seed_hardened_eval" &&
    payload.name !== "candidate_hardened_eval"
  ) {
    return undefined;
  }
  const result = payload.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const summary = (result as { summary?: unknown }).summary;
  if (typeof summary !== "object" || summary === null) {
    return undefined;
  }
  const promotionReady = (summary as { promotionReady?: unknown }).promotionReady === true;
  const passed = (summary as { passed?: unknown }).passed;
  const total = (summary as { total?: unknown }).total;
  const passRate = (summary as { passRate?: unknown }).passRate;
  const failedCaseIds = (summary as { failedCaseIds?: unknown }).failedCaseIds;
  const safePassed = typeof passed === "number" ? passed : 0;
  const safeTotal = typeof total === "number" ? total : 0;
  return {
    promotionReady,
    passed: safePassed,
    total: safeTotal,
    passRate: typeof passRate === "number" ? passRate : safeTotal > 0 ? safePassed / safeTotal : 0,
    failedCount: Array.isArray(failedCaseIds)
      ? failedCaseIds.length
      : Math.max(0, safeTotal - safePassed),
  };
}

function evalVerdictFromPayload(payload: Record<string, unknown>): EvalVerdict | undefined {
  if (payload.event !== "step_ok" && payload.event !== "step_non_passing") {
    return undefined;
  }
  if (
    payload.name !== "stable_hardened_eval" &&
    payload.name !== "training_seed_hardened_eval" &&
    payload.name !== "candidate_hardened_eval"
  ) {
    return undefined;
  }
  const adapterPath = adapterPathFromEvalEvent(payload);
  if (!adapterPath) {
    return undefined;
  }
  const summary = evalSummaryFromPayload({ ...payload, event: "step_ok" });
  if (!summary) {
    return undefined;
  }
  const at = typeof payload.at === "string" ? payload.at : "";
  return {
    at,
    adapterPath,
    promotionReady:
      payload.event === "step_ok" &&
      summary.promotionReady &&
      summary.total >= MIN_PROMOTION_EVAL_CASES,
    passed: summary.passed,
    total: summary.total,
    passRate: summary.passRate,
    failedCount: summary.failedCount,
    source: String(payload.name),
  };
}

function failedStableEvalVerdictFromGuardFailure(
  payload: Record<string, unknown>,
): EvalVerdict | undefined {
  if (payload.event !== "guard_failed") {
    return undefined;
  }
  const adapterPath = payload.currentAdapter;
  const error = payload.error;
  if (typeof adapterPath !== "string" || !adapterPath || typeof error !== "string") {
    return undefined;
  }
  const stableEvalFailed =
    error.includes("stable adapter failed hardened eval") ||
    (error.includes("scripts/dev/local-brain-distill-eval.ts") &&
      error.includes("--hardened") &&
      /"promotionReady":\s*false/u.test(error));
  if (!stableEvalFailed) {
    return undefined;
  }
  const totalMatch = /"total":\s*(\d+)/u.exec(error);
  const at = typeof payload.at === "string" ? payload.at : "";
  return {
    at,
    adapterPath,
    promotionReady: false,
    passed: 0,
    total: totalMatch ? Number(totalMatch[1]) : 0,
    passRate: 0,
    failedCount: totalMatch ? Number(totalMatch[1]) : 0,
    source: "guard_failed_stable_hardened_eval",
  };
}

function isPassingEvalEvent(payload: Record<string, unknown>): boolean {
  return evalVerdictFromPayload(payload)?.promotionReady === true;
}

function adapterPathFromEvalEvent(payload: Record<string, unknown>): string | undefined {
  const result = payload.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const adapterPath = (result as { adapterPath?: unknown }).adapterPath;
  return typeof adapterPath === "string" && adapterPath ? adapterPath : undefined;
}

function adapterMatchesPrefix(adapterPath: string, adapterPrefix: string): boolean {
  const adapterRoot = path.dirname(adapterPrefix);
  const adapterNamePrefix = `${path.basename(adapterPrefix)}-`;
  return (
    path.dirname(adapterPath) === adapterRoot &&
    path.basename(adapterPath).startsWith(adapterNamePrefix)
  );
}

type TrainingSeedSelection = {
  adapterPath: string;
  at: string;
  passed: number;
  total: number;
  passRate: number;
  failedCount: number;
  source: string;
};

function shouldPauseLocalTrainingAfterCollapse(backoffs: ReadonlySet<string>): boolean {
  return backoffs.size >= LOCAL_TRAINING_COLLAPSE_BACKOFF_SEED_LIMIT;
}

function isCatastrophicCandidateScore(seed: TrainingSeedSelection | undefined): boolean {
  if (!seed) {
    return false;
  }
  return (
    seed.total >= CATASTROPHIC_CANDIDATE_MIN_CASES &&
    seed.passRate <= CATASTROPHIC_CANDIDATE_MAX_PASS_RATE
  );
}

function trainingSeedFromVerdict(verdict: EvalVerdict): TrainingSeedSelection | undefined {
  if (verdict.source !== "candidate_hardened_eval") {
    return undefined;
  }
  if (verdict.total <= 0) {
    return undefined;
  }
  return {
    adapterPath: verdict.adapterPath,
    at: verdict.at,
    passed: verdict.passed,
    total: verdict.total,
    passRate: verdict.passRate,
    failedCount: verdict.failedCount,
    source: verdict.source,
  };
}

function compareTrainingSeedSelection(
  left: TrainingSeedSelection,
  right: TrainingSeedSelection,
): number {
  const passedDelta = right.passed - left.passed;
  if (passedDelta !== 0) {
    return passedDelta;
  }
  const coverageDelta = right.total - left.total;
  if (coverageDelta !== 0) {
    return coverageDelta;
  }
  const passRateDelta = right.passRate - left.passRate;
  if (passRateDelta !== 0) {
    return passRateDelta;
  }
  const failureDelta = left.failedCount - right.failedCount;
  if (failureDelta !== 0) {
    return failureDelta;
  }
  return right.at.localeCompare(left.at);
}

function trainingSeedFromEvalResult(
  adapterPath: string,
  result: unknown,
): TrainingSeedSelection | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const summary = (result as { summary?: unknown }).summary;
  if (!summary || typeof summary !== "object") {
    return undefined;
  }
  const passed = (summary as { passed?: unknown }).passed;
  const total = (summary as { total?: unknown }).total;
  const passRate = (summary as { passRate?: unknown }).passRate;
  const failedCaseIds = (summary as { failedCaseIds?: unknown }).failedCaseIds;
  const safePassed = typeof passed === "number" ? passed : 0;
  const safeTotal = typeof total === "number" ? total : 0;
  if (safeTotal <= 0) {
    return undefined;
  }
  return {
    adapterPath,
    at: new Date().toISOString(),
    passed: safePassed,
    total: safeTotal,
    passRate: typeof passRate === "number" ? passRate : safeTotal > 0 ? safePassed / safeTotal : 0,
    failedCount: Array.isArray(failedCaseIds)
      ? failedCaseIds.length
      : Math.max(0, safeTotal - safePassed),
    source: "candidate_hardened_eval",
  };
}

function shouldTrainRound(options: CliOptions, round: number, seedAdapter?: string): boolean {
  if (options.noTrain) {
    return false;
  }
  if (!seedAdapter) {
    return true;
  }
  return round % options.trainEvery === 0;
}

async function resolveBestTrainingSeedAdapter(
  adapterPrefix: string,
  options: { excludedAdapters?: ReadonlySet<string> } = {},
): Promise<TrainingSeedSelection | undefined> {
  let logFiles: string[];
  try {
    logFiles = (await fs.readdir(DEFAULT_GUARD_LOG_DIR))
      .filter((entry) => /^minimax-brain-training-guard.*\.jsonl$/u.test(entry))
      .map((entry) => path.join(DEFAULT_GUARD_LOG_DIR, entry));
  } catch {
    return undefined;
  }
  const candidates = new Map<string, TrainingSeedSelection>();
  for (const logFile of logFiles.toSorted()) {
    const raw = await fs.readFile(logFile, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) {
        continue;
      }
      const payload = JSON.parse(line) as Record<string, unknown>;
      const verdict = evalVerdictFromPayload(payload);
      if (!verdict || !adapterMatchesPrefix(verdict.adapterPath, adapterPrefix)) {
        continue;
      }
      const seed = trainingSeedFromVerdict(verdict);
      if (!seed) {
        continue;
      }
      const current = candidates.get(seed.adapterPath);
      if (!current || current.at.localeCompare(seed.at) <= 0) {
        candidates.set(seed.adapterPath, seed);
      }
    }
  }
  const ranked = [...candidates.values()].toSorted(compareTrainingSeedSelection);
  for (const candidate of ranked) {
    if (options.excludedAdapters?.has(candidate.adapterPath)) {
      continue;
    }
    if (
      (await hasAdapterConfig(candidate.adapterPath)) &&
      (await hasAdapterWeights(candidate.adapterPath))
    ) {
      return candidate;
    }
  }
  return undefined;
}

async function resolveCatastrophicTrainingSeedBackoffs(
  logPath: string,
  adapterPrefix: string,
): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return new Set();
  }
  const suspended = new Set<string>();
  let latestCatastrophicCandidate: string | undefined;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (payload.name === "candidate_hardened_eval") {
      const verdict = evalVerdictFromPayload(payload);
      const seed = verdict ? trainingSeedFromVerdict(verdict) : undefined;
      latestCatastrophicCandidate =
        seed &&
        isCatastrophicCandidateScore(seed) &&
        adapterMatchesPrefix(seed.adapterPath, adapterPrefix) &&
        payload.trainingAbsorptionContractVersion === TRAINING_ABSORPTION_CONTRACT_VERSION
          ? seed.adapterPath
          : undefined;
      continue;
    }
    if (payload.event === "candidate_catastrophic_eval_detected") {
      if (payload.trainingAbsorptionContractVersion !== TRAINING_ABSORPTION_CONTRACT_VERSION) {
        latestCatastrophicCandidate = undefined;
        continue;
      }
      const trainingSeedAdapter = payload.trainingSeedAdapter;
      if (
        typeof trainingSeedAdapter === "string" &&
        adapterMatchesPrefix(trainingSeedAdapter, adapterPrefix)
      ) {
        suspended.add(trainingSeedAdapter);
      }
      latestCatastrophicCandidate = undefined;
      continue;
    }
    if (
      latestCatastrophicCandidate &&
      (payload.event === "candidate_not_retained_as_training_seed" ||
        payload.event === "adapter_rejected_for_guard_session")
    ) {
      const adapterPath = payload.adapterPath;
      const trainingSeedAdapter = payload.currentTrainingSeedAdapter;
      if (
        payload.trainingAbsorptionContractVersion === TRAINING_ABSORPTION_CONTRACT_VERSION &&
        adapterPath === latestCatastrophicCandidate &&
        typeof trainingSeedAdapter === "string" &&
        adapterMatchesPrefix(trainingSeedAdapter, adapterPrefix)
      ) {
        suspended.add(trainingSeedAdapter);
      }
      latestCatastrophicCandidate = undefined;
    }
  }
  return suspended;
}

async function resolveLatestPassingAdapter(adapterPrefix: string): Promise<string | undefined> {
  let logFiles: string[];
  try {
    logFiles = (await fs.readdir(DEFAULT_GUARD_LOG_DIR))
      .filter((entry) => /^minimax-brain-training-guard.*\.jsonl$/u.test(entry))
      .map((entry) => path.join(DEFAULT_GUARD_LOG_DIR, entry));
  } catch {
    return undefined;
  }
  const rejected = new Set<string>();
  const latestEvalByAdapter = new Map<string, EvalVerdict>();
  const promotedOrCandidate: Array<{ at: string; adapterPath: string }> = [];
  const completed: Array<{ at: string; adapterPath: string }> = [];
  const stableFallback: Array<{ at: string; adapterPath: string }> = [];
  for (const logFile of logFiles.toSorted()) {
    const raw = await fs.readFile(logFile, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) {
        continue;
      }
      const payload = JSON.parse(line) as Record<string, unknown>;
      const at = typeof payload.at === "string" ? payload.at : "";
      const evalVerdict =
        evalVerdictFromPayload(payload) ?? failedStableEvalVerdictFromGuardFailure(payload);
      if (evalVerdict && adapterMatchesPrefix(evalVerdict.adapterPath, adapterPrefix)) {
        const current = latestEvalByAdapter.get(evalVerdict.adapterPath);
        if (!current || current.at.localeCompare(evalVerdict.at) <= 0) {
          latestEvalByAdapter.set(evalVerdict.adapterPath, evalVerdict);
        }
      }
      if (payload.event === "adapter_rejected_for_guard_session") {
        const adapterPath = payload.adapterPath;
        if (
          typeof adapterPath === "string" &&
          adapterPath &&
          adapterMatchesPrefix(adapterPath, adapterPrefix)
        ) {
          rejected.add(adapterPath);
        }
      } else if (payload.event === "adapter_promoted_for_guard_session") {
        const adapterPath = payload.adapterPath;
        if (
          typeof adapterPath === "string" &&
          adapterPath &&
          adapterMatchesPrefix(adapterPath, adapterPrefix)
        ) {
          promotedOrCandidate.push({ at, adapterPath });
        }
      } else if (payload.event === "guard_complete") {
        const adapterPath = payload.currentAdapter;
        if (
          typeof adapterPath === "string" &&
          adapterPath &&
          adapterMatchesPrefix(adapterPath, adapterPrefix)
        ) {
          completed.push({ at, adapterPath });
        }
      } else if (payload.name === "candidate_hardened_eval" && isPassingEvalEvent(payload)) {
        const adapterPath = adapterPathFromEvalEvent(payload);
        if (adapterPath && adapterMatchesPrefix(adapterPath, adapterPrefix)) {
          promotedOrCandidate.push({ at, adapterPath });
        }
      } else if (payload.name === "stable_hardened_eval" && isPassingEvalEvent(payload)) {
        const adapterPath = adapterPathFromEvalEvent(payload);
        if (adapterPath && adapterMatchesPrefix(adapterPath, adapterPrefix)) {
          stableFallback.push({ at, adapterPath });
        }
      }
    }
  }
  for (const group of [promotedOrCandidate, completed, stableFallback]) {
    const candidates = group
      .filter((entry) => {
        if (rejected.has(entry.adapterPath)) {
          return false;
        }
        const latestEval = latestEvalByAdapter.get(entry.adapterPath);
        return latestEval?.promotionReady === true;
      })
      .toSorted((left, right) => right.at.localeCompare(left.at));
    for (const candidate of candidates) {
      if (await hasAdapterConfig(candidate.adapterPath)) {
        return candidate.adapterPath;
      }
    }
  }
  return undefined;
}

async function resolveCurrentAdapter(options: CliOptions): Promise<string | undefined> {
  if (options.currentAdapter !== "latest") {
    if (options.currentAdapter === "latest-passing") {
      const latestPassing = await resolveLatestPassingAdapter(options.adapterPrefix);
      if (latestPassing) {
        return latestPassing;
      }
      if ((!options.resolveCurrentAdapterOnly || options.bootstrapIfMissing) && !options.noTrain) {
        return undefined;
      }
      throw new Error(`no promotion-ready adapter found for model ${options.model}`);
    }
    if (!(await hasAdapterConfig(options.currentAdapter))) {
      throw new Error(`current adapter is missing adapter_config.json: ${options.currentAdapter}`);
    }
    return options.currentAdapter;
  }
  const latest = await resolveLatestAdapter(options.adapterPrefix);
  if (latest) {
    return latest;
  }
  const seedAdapter = defaultSeedAdapterForModel(options.model);
  if (seedAdapter && (await hasAdapterConfig(seedAdapter))) {
    return seedAdapter;
  }
  if (options.bootstrapIfMissing && !options.noTrain) {
    return undefined;
  }
  throw new Error(
    `no usable adapter found for latest prefix ${options.adapterPrefix}; pass --current-adapter DIR`,
  );
}

async function runJsonStep(
  options: CliOptions,
  round: number,
  name: string,
  command: string,
  args: string[],
  stepOptions: { allowFailure?: boolean } = {},
): Promise<unknown> {
  process.stdout.write(`\n[minimax-guard] round=${round} step=${name}\n`);
  const result = await runCommand(command, args, stepOptions);
  const parsed = parseJsonFromStdout(result.stdout);
  await appendLog(options.logPath, {
    event:
      stepOptions.allowFailure && !promotionEvalPassed(parsed) ? "step_non_passing" : "step_ok",
    round,
    name,
    trainingAbsorptionContractVersion:
      name === "candidate_hardened_eval" ||
      name === "train" ||
      name === "train_slice" ||
      name === "training_seed_hardened_eval"
        ? TRAINING_ABSORPTION_CONTRACT_VERSION
        : undefined,
    command,
    args,
    durationMs: result.durationMs,
    result: parsed,
  });
  return parsed;
}

function systemLoad1m(): number {
  return os.loadavg()[0] ?? 0;
}

async function skipForHighLoad(params: {
  options: CliOptions;
  round?: number;
  phase: string;
  loadMax: number;
}): Promise<boolean> {
  const load1m = systemLoad1m();
  if (load1m <= params.loadMax) {
    return false;
  }
  await appendLog(params.options.logPath, {
    event: "resource_guard_skip",
    round: params.round,
    phase: params.phase,
    load1m: Number(load1m.toFixed(2)),
    loadMax: params.loadMax,
    cpuCount: CPU_COUNT,
    liveTouched: false,
    providerConfigTouched: false,
  });
  process.stdout.write(
    `[minimax-guard] resource skip phase=${params.phase} load1m=${load1m.toFixed(2)} max=${params.loadMax}\n`,
  );
  return true;
}

async function runTeacherStep(options: CliOptions, round: number): Promise<unknown> {
  if (options.teacherProfile === "minimax-plus-brain") {
    return runJsonStep(options, round, "minimax_plus_brain_saturator", "node", [
      "--import",
      "tsx",
      "scripts/dev/minimax-quota-brain-saturator.ts",
      "--profile",
      "minimax-plus-brain",
      "--max-calls",
      String(options.batchLimit),
      "--duration-minutes",
      String(options.teacherDurationMinutes),
      "--concurrency",
      String(options.teacherConcurrency),
      "--min-concurrency",
      String(Math.min(4, options.teacherConcurrency)),
      "--workspace",
      options.workspaceDir,
      "--data-dir",
      options.dataDir,
      "--write",
      ...(options.mock ? ["--mock"] : []),
    ]);
  }
  return runJsonStep(options, round, "minimax_teacher_batch", "node", [
    "--import",
    "tsx",
    "scripts/dev/minimax-brain-teacher-batch.ts",
    "--limit",
    String(options.batchLimit),
    "--write",
    "--json",
    "--concurrency",
    String(options.teacherConcurrency),
    ...(options.mock ? ["--mock"] : []),
  ]);
}

async function buildTrainSlice(options: CliOptions, round: number): Promise<string> {
  if (options.noTrainSlice) {
    await appendLog(options.logPath, {
      event: "train_slice_skipped",
      round,
      reason: "no_train_slice",
      dataDir: options.dataDir,
      liveTouched: false,
      providerConfigTouched: false,
    });
    return options.dataDir;
  }
  const result = await runJsonStep(options, round, "train_slice", "node", [
    "--import",
    "tsx",
    "scripts/dev/local-brain-distill-train-slice.ts",
    "--data",
    options.dataDir,
    "--out",
    options.trainSliceDir,
    "--max-review-examples",
    String(options.trainSliceMaxReviewExamples),
    "--curated-repeat",
    String(options.trainSliceCuratedRepeat),
    "--non-review-repeat",
    String(options.trainSliceNonReviewRepeat),
    "--json",
  ]);
  const payload = result as { outDir?: unknown };
  if (typeof payload.outDir !== "string" || !payload.outDir) {
    throw new Error("train slice did not return outDir");
  }
  return payload.outDir;
}

async function runTrain(
  options: CliOptions,
  round: number,
  adapterPath: string,
  resumeAdapterPath?: string,
): Promise<
  | { ok: true; trainDataDir: string; durationMs: number }
  | {
      ok: false;
      reason: "resource_backoff" | "train_loss_nan";
      trainDataDir?: string;
      durationMs?: number;
    }
> {
  if (
    await skipForHighLoad({
      options,
      round,
      phase: "train",
      loadMax: options.trainLoadMax,
    })
  ) {
    return { ok: false, reason: "resource_backoff" };
  }
  const trainDataDir = await buildTrainSlice(options, round);
  process.stdout.write(`\n[minimax-guard] round=${round} step=train adapter=${adapterPath}\n`);
  await fs.rm(adapterPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(adapterPath), { recursive: true });
  const result = await runCommand("nice", [
    "-n",
    "10",
    options.pythonBin,
    "-m",
    "mlx_lm",
    "lora",
    "--model",
    options.model,
    "--train",
    "--data",
    trainDataDir,
    "--adapter-path",
    adapterPath,
    ...(resumeAdapterPath
      ? ["--resume-adapter-file", path.join(resumeAdapterPath, "adapters.safetensors")]
      : []),
    "--fine-tune-type",
    "lora",
    "--batch-size",
    "1",
    "--iters",
    String(options.trainIters),
    "--learning-rate",
    "1e-5",
    "--max-seq-length",
    "1536",
    "--mask-prompt",
    "--grad-checkpoint",
  ]);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (TRAIN_NAN_PATTERN.test(combinedOutput)) {
    await fs.rm(adapterPath, { recursive: true, force: true });
    await appendLog(options.logPath, {
      event: "step_failed",
      round,
      name: "train",
      adapterPath,
      trainDataDir,
      resumeAdapterPath,
      durationMs: result.durationMs,
      reason: "train_loss_nan",
      trainingAbsorptionContractVersion: TRAINING_ABSORPTION_CONTRACT_VERSION,
      localTrainingBackoff: true,
      removedAdapterPath: adapterPath,
      liveTouched: false,
      providerConfigTouched: false,
    });
    return {
      ok: false,
      reason: "train_loss_nan",
      trainDataDir,
      durationMs: result.durationMs,
    };
  }
  await appendLog(options.logPath, {
    event: "step_ok",
    round,
    name: "train",
    adapterPath,
    trainDataDir,
    durationMs: result.durationMs,
    trainingAbsorptionContractVersion: TRAINING_ABSORPTION_CONTRACT_VERSION,
  });
  return { ok: true, trainDataDir, durationMs: result.durationMs };
}

function promotionEvalPassed(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const payload = result as { summary?: { promotionReady?: unknown; total?: unknown } };
  const total = payload.summary?.total;
  return (
    payload.summary?.promotionReady === true &&
    typeof total === "number" &&
    total >= MIN_PROMOTION_EVAL_CASES
  );
}

type TeacherSidecar = {
  pid?: number;
  exitCode?: number | null;
  stop: () => Promise<void>;
};

function shouldRunTeacherSidecar(options: CliOptions): boolean {
  return options.teacherSidecar && options.teacherProfile === "minimax-plus-brain";
}

async function startTeacherSidecar(options: CliOptions): Promise<TeacherSidecar | undefined> {
  if (!shouldRunTeacherSidecar(options)) {
    return undefined;
  }
  const durationMinutes =
    options.teacherSidecarDurationMinutes > 0
      ? options.teacherSidecarDurationMinutes
      : options.durationMinutes;
  const args = [
    "--import",
    "tsx",
    "scripts/dev/minimax-quota-brain-saturator.ts",
    "--profile",
    "minimax-plus-brain",
    "--max-calls",
    String(options.teacherSidecarMaxCalls),
    "--duration-minutes",
    String(durationMinutes),
    "--batch-limit",
    String(options.teacherSidecarBatchLimit),
    "--concurrency",
    String(options.teacherSidecarConcurrency),
    "--min-concurrency",
    String(Math.min(2, options.teacherSidecarConcurrency)),
    "--min-batch-limit",
    "8",
    "--provider-cooldown-seconds",
    "90",
    "--max-provider-instability-rounds",
    "3",
    "--failure-focus",
    "--guard-log",
    options.logPath,
    "--workspace",
    options.workspaceDir,
    "--data-dir",
    options.dataDir,
    "--dataset-every",
    "5",
    "--smoke-every",
    "10",
    "--adaptive",
    "--allow-partial-write",
    "--write",
    ...(options.mock ? ["--mock"] : []),
  ];
  const child = spawn("node", args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let settled = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      process.stdout.write(`[minimax-sidecar] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[minimax-sidecar] ${chunk}`);
    });
    child.on("error", async (error) => {
      settled = true;
      await appendLog(options.logPath, {
        event: "teacher_sidecar_error",
        error: String(error),
        liveTouched: false,
        providerConfigTouched: false,
      });
      resolve();
    });
    child.on("close", async (code) => {
      settled = true;
      await appendLog(options.logPath, {
        event: "teacher_sidecar_exit",
        pid: child.pid,
        exitCode: code,
        liveTouched: false,
        providerConfigTouched: false,
      });
      resolve();
    });
  });
  await appendLog(options.logPath, {
    event: "teacher_sidecar_started",
    pid: child.pid,
    command: "node",
    args,
    liveTouched: false,
    providerConfigTouched: false,
  });
  return {
    pid: child.pid,
    get exitCode() {
      return child.exitCode;
    },
    stop: async () => {
      if (!settled) {
        child.kill("SIGTERM");
        await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
      if (!settled) {
        child.kill("SIGKILL");
        await exitPromise;
      }
    },
  };
}

function adapterPathForRound(options: CliOptions, round: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${options.adapterPrefix}-${stamp}-r${round}`;
}

const options = parseArgs(process.argv.slice(2));
if (options.resolveCurrentAdapterOnly) {
  const selectedAdapter = await resolveCurrentAdapter(options);
  const catastrophicTrainingSeedBackoffs = await resolveCatastrophicTrainingSeedBackoffs(
    options.logPath,
    options.adapterPrefix,
  );
  const localTrainingPaused = shouldPauseLocalTrainingAfterCollapse(
    catastrophicTrainingSeedBackoffs,
  );
  const trainingSeed =
    !selectedAdapter && !options.noTrain && !localTrainingPaused
      ? await resolveBestTrainingSeedAdapter(options.adapterPrefix, {
          excludedAdapters: catastrophicTrainingSeedBackoffs,
        })
      : undefined;
  const trainingResumeSeed =
    !localTrainingPaused &&
    !options.noTrain &&
    (!selectedAdapter || catastrophicTrainingSeedBackoffs.has(selectedAdapter))
      ? await resolveBestTrainingSeedAdapter(options.adapterPrefix, {
          excludedAdapters: catastrophicTrainingSeedBackoffs,
        })
      : undefined;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        boundary: "local_auxiliary_thought_flow_only",
        selectedAdapter,
        trainingSeedAdapter: trainingSeed?.adapterPath,
        trainingSeed,
        trainingResumeAdapter:
          !localTrainingPaused &&
          selectedAdapter &&
          !catastrophicTrainingSeedBackoffs.has(selectedAdapter)
            ? selectedAdapter
            : trainingResumeSeed?.adapterPath,
        trainingResumeSeed: localTrainingPaused ? undefined : trainingResumeSeed,
        catastrophicTrainingSeedBackoffs: [...catastrophicTrainingSeedBackoffs],
        localTrainingPaused,
        localTrainingPauseReason: localTrainingPaused
          ? "repeated_catastrophic_training_seed_backoff"
          : undefined,
        model: options.model,
        adapterPrefix: options.adapterPrefix,
        bootstrapIfMissing: options.bootstrapIfMissing,
        selectionMode: options.currentAdapter,
        liveTouched: false,
        providerConfigTouched: false,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const releaseRunLock = await acquireRunLock(options);
if (
  await skipForHighLoad({
    options,
    phase: "start",
    loadMax: options.loadMax,
  })
) {
  await releaseRunLock();
  process.exit(0);
}
const startedAt = Date.now();
const deadline = startedAt + options.durationMinutes * 60_000;
let round = 0;
let currentAdapter = await resolveCurrentAdapter(options);
let catastrophicTrainingSeedBackoffs = await resolveCatastrophicTrainingSeedBackoffs(
  options.logPath,
  options.adapterPrefix,
);
let localTrainingPaused = shouldPauseLocalTrainingAfterCollapse(catastrophicTrainingSeedBackoffs);
let trainingSeed =
  currentAdapter || options.noTrain || localTrainingPaused
    ? undefined
    : await resolveBestTrainingSeedAdapter(options.adapterPrefix, {
        excludedAdapters: catastrophicTrainingSeedBackoffs,
      });
let trainingSeedAdapter =
  currentAdapter && !catastrophicTrainingSeedBackoffs.has(currentAdapter)
    ? currentAdapter
    : trainingSeed?.adapterPath;
let trainingResumeSeed =
  options.noTrain || (currentAdapter && !catastrophicTrainingSeedBackoffs.has(currentAdapter))
    ? undefined
    : await resolveBestTrainingSeedAdapter(options.adapterPrefix, {
        excludedAdapters: catastrophicTrainingSeedBackoffs,
      });
let trainingResumeAdapter =
  currentAdapter && !catastrophicTrainingSeedBackoffs.has(currentAdapter)
    ? currentAdapter
    : trainingResumeSeed?.adapterPath;
if (localTrainingPaused) {
  trainingResumeSeed = undefined;
  trainingResumeAdapter = undefined;
}
let teacherSidecar: TeacherSidecar | undefined;

await appendLog(options.logPath, {
  event: "guard_start",
  mode: "minimax_teacher_additive_only",
  teacherProfile: options.teacherProfile,
  originalPipelineReplaced: false,
  liveTouched: false,
  providerConfigTouched: false,
  options: {
    ...options,
    currentAdapter,
    trainingSeedAdapter,
    trainingResumeAdapter,
    localTrainingPaused,
    trainingAbsorptionContractVersion: TRAINING_ABSORPTION_CONTRACT_VERSION,
  },
});
if (!currentAdapter && trainingSeedAdapter) {
  await appendLog(options.logPath, {
    event: "best_effort_training_seed_selected",
    adapterPath: trainingSeedAdapter,
    score: trainingSeed
      ? {
          passed: trainingSeed.passed,
          total: trainingSeed.total,
          passRate: trainingSeed.passRate,
          failedCount: trainingSeed.failedCount,
        }
      : undefined,
    reason: "no_promotion_ready_adapter_available",
    strictPromotionUnchanged: true,
    liveTouched: false,
  });
}
if (trainingSeedAdapter && catastrophicTrainingSeedBackoffs.has(trainingSeedAdapter)) {
  await appendLog(options.logPath, {
    event: "training_seed_catastrophic_backoff_active",
    adapterPath: trainingSeedAdapter,
    reason: "recent_candidate_eval_collapsed_from_this_seed",
    liveTouched: false,
    providerConfigTouched: false,
  });
}
if (trainingResumeAdapter && trainingResumeAdapter !== trainingSeedAdapter) {
  await appendLog(options.logPath, {
    event: "training_resume_seed_selected",
    evalSeedAdapter: trainingSeedAdapter,
    trainingResumeAdapter,
    score: trainingResumeSeed
      ? {
          passed: trainingResumeSeed.passed,
          total: trainingResumeSeed.total,
          passRate: trainingResumeSeed.passRate,
          failedCount: trainingResumeSeed.failedCount,
        }
      : undefined,
    reason: "best_non_catastrophic_training_seed",
    strictPromotionUnchanged: true,
    liveTouched: false,
    providerConfigTouched: false,
  });
}
if (localTrainingPaused) {
  await appendLog(options.logPath, {
    event: "local_training_paused_after_repeated_collapse",
    reason: "repeated_catastrophic_training_seed_backoff",
    trainingAbsorptionContractVersion: TRAINING_ABSORPTION_CONTRACT_VERSION,
    catastrophicTrainingSeedBackoffCount: catastrophicTrainingSeedBackoffs.size,
    catastrophicTrainingSeedBackoffs: [...catastrophicTrainingSeedBackoffs],
    trainingSeedAdapter,
    trainingResumeAdapter,
    sidecarContinues: options.teacherSidecar,
    liveTouched: false,
    providerConfigTouched: false,
  });
}

try {
  teacherSidecar = await startTeacherSidecar(options);
  while (Date.now() < deadline) {
    round += 1;
    if (
      await skipForHighLoad({
        options,
        round,
        phase: "round_start",
        loadMax: options.loadMax,
      })
    ) {
      break;
    }
    if (teacherSidecar) {
      if (teacherSidecar.exitCode === null) {
        await appendLog(options.logPath, {
          event: "step_skipped",
          round,
          name: "minimax_plus_brain_saturator",
          reason: "teacher_sidecar_active",
          sidecarPid: teacherSidecar.pid,
          liveTouched: false,
          providerConfigTouched: false,
        });
      } else if (teacherSidecar.exitCode === 0) {
        await appendLog(options.logPath, {
          event: "step_skipped",
          round,
          name: "minimax_plus_brain_saturator",
          reason: "teacher_sidecar_completed",
          sidecarPid: teacherSidecar.pid,
          sidecarExitCode: teacherSidecar.exitCode,
          liveTouched: false,
          providerConfigTouched: false,
        });
      } else {
        await appendLog(options.logPath, {
          event: "step_resumed",
          round,
          name: "minimax_plus_brain_saturator",
          reason: "teacher_sidecar_failed_fallback_to_serial_teacher",
          sidecarPid: teacherSidecar.pid,
          sidecarExitCode: teacherSidecar.exitCode,
          liveTouched: false,
          providerConfigTouched: false,
        });
        teacherSidecar = undefined;
        await runTeacherStep(options, round);
      }
    } else {
      await runTeacherStep(options, round);
    }
    await runJsonStep(options, round, "dataset", "node", [
      "--import",
      "tsx",
      "scripts/dev/local-brain-distill-dataset.ts",
      "--json",
    ]);
    await runJsonStep(options, round, "smoke", "node", [
      "--import",
      "tsx",
      "scripts/dev/local-brain-distill-smoke.ts",
      "--json",
    ]);

    if (round % options.evalEvery === 0) {
      const evalAdapter = currentAdapter ?? trainingSeedAdapter;
      if (evalAdapter) {
        const evalName = currentAdapter ? "stable_hardened_eval" : "training_seed_hardened_eval";
        const stableEval = await runJsonStep(
          options,
          round,
          evalName,
          "node",
          [
            "--import",
            "tsx",
            "scripts/dev/local-brain-distill-eval.ts",
            "--model",
            options.model,
            "--adapter",
            evalAdapter,
            "--hardened",
            "--progress",
            "--timeout-ms",
            "180000",
            "--summary-only",
            "--json",
          ],
          currentAdapter ? {} : { allowFailure: true },
        );
        if (currentAdapter && !promotionEvalPassed(stableEval)) {
          throw new Error(`stable adapter failed hardened eval: ${currentAdapter}`);
        }
      } else {
        await appendLog(options.logPath, {
          event: "step_skipped",
          round,
          name: "stable_hardened_eval",
          reason: "bootstrap_adapter_missing",
          model: options.model,
          adapterPrefix: options.adapterPrefix,
          liveTouched: false,
        });
      }
    }

    const shouldRunRecoveryTrain =
      round === 1 &&
      Boolean(trainingResumeAdapter) &&
      Boolean(trainingSeedAdapter) &&
      trainingResumeAdapter !== trainingSeedAdapter;
    if (shouldTrainRound(options, round, trainingResumeAdapter) || shouldRunRecoveryTrain) {
      const resumeAdapter = trainingResumeAdapter;
      if (localTrainingPaused) {
        await appendLog(options.logPath, {
          event: "step_skipped",
          round,
          name: "train",
          reason: "local_training_paused_after_repeated_collapse",
          trainingAbsorptionContractVersion: TRAINING_ABSORPTION_CONTRACT_VERSION,
          catastrophicTrainingSeedBackoffCount: catastrophicTrainingSeedBackoffs.size,
          trainingSeedAdapter,
          trainingResumeAdapter,
          sidecarContinues: Boolean(teacherSidecar?.pid),
          liveTouched: false,
          providerConfigTouched: false,
        });
        continue;
      }
      if (shouldRunRecoveryTrain) {
        await appendLog(options.logPath, {
          event: "training_resume_recovery_train_scheduled",
          round,
          evalSeedAdapter: trainingSeedAdapter,
          trainingResumeAdapter,
          reason: "catastrophic_eval_seed_has_safe_resume_seed",
          liveTouched: false,
          providerConfigTouched: false,
        });
      }
      if (resumeAdapter && catastrophicTrainingSeedBackoffs.has(resumeAdapter)) {
        await appendLog(options.logPath, {
          event: "step_skipped",
          round,
          name: "train",
          reason: "catastrophic_training_seed_backoff",
          trainingSeedAdapter: resumeAdapter,
          liveTouched: false,
          providerConfigTouched: false,
        });
        continue;
      }
      if (!resumeAdapter && !options.bootstrapIfMissing) {
        await appendLog(options.logPath, {
          event: "step_skipped",
          round,
          name: "train",
          reason: "no_safe_training_resume_adapter",
          evalSeedAdapter: trainingSeedAdapter,
          liveTouched: false,
          providerConfigTouched: false,
        });
        continue;
      }
      const candidateAdapter = adapterPathForRound(options, round);
      const trained = await runTrain(options, round, candidateAdapter, resumeAdapter);
      if (!trained.ok) {
        if (trained.reason === "train_loss_nan") {
          const failedSeedAdapter = resumeAdapter ?? currentAdapter ?? trainingSeedAdapter;
          if (failedSeedAdapter) {
            catastrophicTrainingSeedBackoffs.add(failedSeedAdapter);
          }
          localTrainingPaused = shouldPauseLocalTrainingAfterCollapse(
            catastrophicTrainingSeedBackoffs,
          );
          if (localTrainingPaused) {
            trainingResumeSeed = undefined;
            trainingResumeAdapter = undefined;
          } else {
            trainingResumeSeed = await resolveBestTrainingSeedAdapter(options.adapterPrefix, {
              excludedAdapters: catastrophicTrainingSeedBackoffs,
            });
            trainingResumeAdapter = trainingResumeSeed?.adapterPath;
          }
          await appendLog(options.logPath, {
            event: "local_training_paused_after_train_nan",
            round,
            adapterPath: candidateAdapter,
            failedSeedAdapter,
            reason: "train_loss_nan",
            trainingAbsorptionContractVersion: TRAINING_ABSORPTION_CONTRACT_VERSION,
            catastrophicTrainingSeedBackoffCount: catastrophicTrainingSeedBackoffs.size,
            nextTrainingResumeAdapter: trainingResumeAdapter,
            sidecarContinues: Boolean(teacherSidecar?.pid),
            liveTouched: false,
            providerConfigTouched: false,
          });
          continue;
        }
        await appendLog(options.logPath, {
          event: "step_backoff",
          round,
          name: "train_skipped_resource_backoff",
          durationMs: TRAIN_SKIP_BACKOFF_MS,
          reason: "local_mlx_train_resource_guard_skip",
          sidecarPid: teacherSidecar?.pid,
          liveTouched: false,
          providerConfigTouched: false,
        });
        await sleep(TRAIN_SKIP_BACKOFF_MS);
        continue;
      }
      const candidateEval = await runJsonStep(
        options,
        round,
        "candidate_hardened_eval",
        "node",
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-distill-eval.ts",
          "--model",
          options.model,
          "--adapter",
          candidateAdapter,
          "--hardened",
          "--progress",
          "--timeout-ms",
          "180000",
          "--summary-only",
          "--json",
        ],
        { allowFailure: true },
      );
      if (promotionEvalPassed(candidateEval)) {
        currentAdapter = candidateAdapter;
        trainingSeedAdapter = candidateAdapter;
        trainingResumeAdapter = candidateAdapter;
        trainingResumeSeed = undefined;
        trainingSeed = trainingSeedFromEvalResult(candidateAdapter, candidateEval);
        await appendLog(options.logPath, {
          event: "adapter_promoted_for_guard_session",
          round,
          adapterPath: currentAdapter,
          liveTouched: false,
        });
      } else {
        const candidateSeed = trainingSeedFromEvalResult(candidateAdapter, candidateEval);
        if (isCatastrophicCandidateScore(candidateSeed)) {
          const failedSeedAdapter = resumeAdapter ?? currentAdapter ?? trainingSeedAdapter;
          if (failedSeedAdapter) {
            catastrophicTrainingSeedBackoffs.add(failedSeedAdapter);
          }
          localTrainingPaused = shouldPauseLocalTrainingAfterCollapse(
            catastrophicTrainingSeedBackoffs,
          );
          if (localTrainingPaused) {
            trainingResumeSeed = undefined;
            trainingResumeAdapter = undefined;
          } else {
            trainingResumeSeed = await resolveBestTrainingSeedAdapter(options.adapterPrefix, {
              excludedAdapters: catastrophicTrainingSeedBackoffs,
            });
            trainingResumeAdapter = trainingResumeSeed?.adapterPath;
          }
          await appendLog(options.logPath, {
            event: "candidate_catastrophic_eval_detected",
            round,
            adapterPath: candidateAdapter,
            trainingSeedAdapter: failedSeedAdapter,
            nextTrainingResumeAdapter: trainingResumeAdapter,
            trainingAbsorptionContractVersion: TRAINING_ABSORPTION_CONTRACT_VERSION,
            score: candidateSeed
              ? {
                  passed: candidateSeed.passed,
                  total: candidateSeed.total,
                  passRate: candidateSeed.passRate,
                  failedCount: candidateSeed.failedCount,
                }
              : undefined,
            reason: "candidate_eval_collapsed_near_zero_pass_rate",
            strictPromotionUnchanged: true,
            localTrainingBackoff: true,
            liveTouched: false,
            providerConfigTouched: false,
          });
        }
        if (!currentAdapter) {
          if (
            candidateSeed &&
            !isCatastrophicCandidateScore(candidateSeed) &&
            (!trainingSeed || compareTrainingSeedSelection(candidateSeed, trainingSeed) < 0)
          ) {
            trainingSeed = candidateSeed;
            trainingSeedAdapter = candidateAdapter;
            trainingResumeSeed = candidateSeed;
            trainingResumeAdapter = candidateAdapter;
            await appendLog(options.logPath, {
              event: "candidate_retained_as_training_seed",
              round,
              adapterPath: trainingSeedAdapter,
              score: {
                passed: candidateSeed.passed,
                total: candidateSeed.total,
                passRate: candidateSeed.passRate,
                failedCount: candidateSeed.failedCount,
              },
              reason: "best_available_non_promotion_eval_candidate",
              strictPromotionUnchanged: true,
              liveTouched: false,
            });
          } else {
            await appendLog(options.logPath, {
              event: "candidate_not_retained_as_training_seed",
              round,
              adapterPath: candidateAdapter,
              currentTrainingSeedAdapter: trainingSeedAdapter,
              reason: candidateSeed
                ? "lower_score_than_current_training_seed"
                : "missing_candidate_eval_score",
              strictPromotionUnchanged: true,
              liveTouched: false,
            });
          }
        }
        await appendLog(options.logPath, {
          event: "adapter_rejected_for_guard_session",
          round,
          adapterPath: candidateAdapter,
          liveTouched: false,
        });
      }
    }
  }
  await appendLog(options.logPath, {
    event: "guard_complete",
    rounds: round,
    currentAdapter,
    elapsedMinutes: Math.round((Date.now() - startedAt) / 60_000),
    liveTouched: false,
  });
  process.stdout.write(
    `\n[minimax-guard] complete rounds=${round} currentAdapter=${currentAdapter}\n`,
  );
} catch (error) {
  await appendLog(options.logPath, {
    event: "guard_failed",
    round,
    currentAdapter,
    error: String(error),
    liveTouched: false,
  });
  process.stderr.write(`\n[minimax-guard] failed round=${round}: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await teacherSidecar?.stop();
  await releaseRunLock();
}
