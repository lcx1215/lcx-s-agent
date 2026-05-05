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
  trainEvery: number;
  evalEvery: number;
  trainIters: number;
  model: string;
  noTrain: boolean;
  mock: boolean;
  resolveCurrentAdapterOnly: boolean;
  workspaceDir: string;
  dataDir: string;
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
const DEFAULT_ADAPTER = path.join(
  TRAINER_ROOT,
  "adapters",
  "thought-flow-v1-qwen3-0.6b-teacher-v7",
);
const DEFAULT_ADAPTER_PREFIX = path.join(
  TRAINER_ROOT,
  "adapters",
  "thought-flow-v1-qwen3-0.6b-minimax-guard",
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

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/minimax-brain-training-guard.ts [options]",
      "",
      "Options:",
      "  --duration-minutes N   default 180",
      "  --batch-limit N         MiniMax teacher samples per round, default 36 for Plus profile",
      "  --teacher-profile NAME  batch|minimax-plus-brain, default minimax-plus-brain",
      "  --teacher-duration-minutes N  per-round teacher budget, default 20",
      "  --teacher-concurrency N       per-round teacher concurrency, default 12",
      "  --train-every N         train every N rounds, default 2",
      "  --eval-every N          eval current/new adapter every N rounds, default 1",
      "  --train-iters N         MLX LoRA iters, default 80",
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
  const options: CliOptions = {
    durationMinutes: 180,
    batchLimit: 36,
    teacherProfile: "minimax-plus-brain",
    teacherDurationMinutes: 20,
    teacherConcurrency: 12,
    trainEvery: 2,
    evalEvery: 1,
    trainIters: 80,
    model: "Qwen/Qwen3-0.6B",
    noTrain: false,
    mock: false,
    resolveCurrentAdapterOnly: false,
    workspaceDir: path.join(HOME, ".openclaw", "workspace"),
    dataDir: DEFAULT_DATA_DIR,
    pythonBin: path.join(TRAINER_ROOT, ".venv", "bin", "python"),
    currentAdapter: "latest-passing",
    adapterPrefix: DEFAULT_ADAPTER_PREFIX,
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
    } else if (arg === "--train-every") {
      options.trainEvery = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--eval-every") {
      options.evalEvery = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--train-iters") {
      options.trainIters = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--model") {
      options.model = readValue(args, index);
      index += 1;
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
  return options;
}

async function appendLog(logPath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`);
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
  return (
    command.includes("node --import tsx scripts/dev/minimax-brain-training-guard.ts") ||
    command.includes("node --import=tsx scripts/dev/minimax-brain-training-guard.ts")
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

function isPassingEvalEvent(payload: Record<string, unknown>): boolean {
  if (payload.event !== "step_ok") {
    return false;
  }
  if (payload.name !== "stable_hardened_eval" && payload.name !== "candidate_hardened_eval") {
    return false;
  }
  const result = payload.result;
  if (!result || typeof result !== "object") {
    return false;
  }
  const summary = (result as { summary?: unknown }).summary;
  return (
    typeof summary === "object" &&
    summary !== null &&
    (summary as { promotionReady?: unknown }).promotionReady === true
  );
}

function adapterPathFromEvalEvent(payload: Record<string, unknown>): string | undefined {
  const result = payload.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const adapterPath = (result as { adapterPath?: unknown }).adapterPath;
  return typeof adapterPath === "string" && adapterPath ? adapterPath : undefined;
}

async function resolveLatestPassingAdapter(): Promise<string | undefined> {
  let logFiles: string[];
  try {
    logFiles = (await fs.readdir(DEFAULT_GUARD_LOG_DIR))
      .filter((entry) => /^minimax-brain-training-guard.*\.jsonl$/u.test(entry))
      .map((entry) => path.join(DEFAULT_GUARD_LOG_DIR, entry));
  } catch {
    return undefined;
  }
  const rejected = new Set<string>();
  const passing: Array<{ at: string; adapterPath: string }> = [];
  for (const logFile of logFiles.toSorted()) {
    const raw = await fs.readFile(logFile, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) {
        continue;
      }
      const payload = JSON.parse(line) as Record<string, unknown>;
      const at = typeof payload.at === "string" ? payload.at : "";
      if (payload.event === "adapter_rejected_for_guard_session") {
        const adapterPath = payload.adapterPath;
        if (typeof adapterPath === "string" && adapterPath) {
          rejected.add(adapterPath);
        }
      } else if (payload.event === "adapter_promoted_for_guard_session") {
        const adapterPath = payload.adapterPath;
        if (typeof adapterPath === "string" && adapterPath) {
          passing.push({ at, adapterPath });
        }
      } else if (payload.event === "guard_complete") {
        const adapterPath = payload.currentAdapter;
        if (typeof adapterPath === "string" && adapterPath) {
          passing.push({ at, adapterPath });
        }
      } else if (isPassingEvalEvent(payload)) {
        const adapterPath = adapterPathFromEvalEvent(payload);
        if (adapterPath) {
          passing.push({ at, adapterPath });
        }
      }
    }
  }
  const candidates = passing
    .filter((entry) => !rejected.has(entry.adapterPath))
    .toSorted((left, right) => right.at.localeCompare(left.at));
  for (const candidate of candidates) {
    if (await hasAdapterConfig(candidate.adapterPath)) {
      return candidate.adapterPath;
    }
  }
  return undefined;
}

async function resolveCurrentAdapter(options: CliOptions): Promise<string> {
  if (options.currentAdapter !== "latest") {
    if (options.currentAdapter === "latest-passing") {
      const latestPassing = await resolveLatestPassingAdapter();
      if (latestPassing) {
        return latestPassing;
      }
      if (await hasAdapterConfig(DEFAULT_ADAPTER)) {
        return DEFAULT_ADAPTER;
      }
      throw new Error("no promotion-ready adapter found in guard logs");
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
  if (await hasAdapterConfig(DEFAULT_ADAPTER)) {
    return DEFAULT_ADAPTER;
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
    event: stepOptions.allowFailure && !evalPassed(parsed) ? "step_non_passing" : "step_ok",
    round,
    name,
    command,
    args,
    durationMs: result.durationMs,
    result: parsed,
  });
  return parsed;
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

async function runTrain(options: CliOptions, round: number, adapterPath: string): Promise<void> {
  process.stdout.write(`\n[minimax-guard] round=${round} step=train adapter=${adapterPath}\n`);
  await fs.rm(adapterPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(adapterPath), { recursive: true });
  const result = await runCommand(options.pythonBin, [
    "-m",
    "mlx_lm",
    "lora",
    "--model",
    options.model,
    "--train",
    "--data",
    options.dataDir,
    "--adapter-path",
    adapterPath,
    "--fine-tune-type",
    "lora",
    "--batch-size",
    "1",
    "--iters",
    String(options.trainIters),
    "--learning-rate",
    "1e-5",
    "--max-seq-length",
    "2048",
    "--mask-prompt",
    "--grad-checkpoint",
  ]);
  await appendLog(options.logPath, {
    event: "step_ok",
    round,
    name: "train",
    adapterPath,
    durationMs: result.durationMs,
  });
}

function evalPassed(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const payload = result as {
    ok?: unknown;
    promotionReady?: unknown;
    summary?: { promotionReady?: unknown };
  };
  return (
    payload.ok === true ||
    payload.promotionReady === true ||
    payload.summary?.promotionReady === true
  );
}

function adapterPathForRound(options: CliOptions, round: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${options.adapterPrefix}-${stamp}-r${round}`;
}

const options = parseArgs(process.argv.slice(2));
if (options.resolveCurrentAdapterOnly) {
  const selectedAdapter = await resolveCurrentAdapter(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        boundary: "local_auxiliary_thought_flow_only",
        selectedAdapter,
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
const startedAt = Date.now();
const deadline = startedAt + options.durationMinutes * 60_000;
let round = 0;
let currentAdapter = await resolveCurrentAdapter(options);

await appendLog(options.logPath, {
  event: "guard_start",
  mode: "minimax_teacher_additive_only",
  teacherProfile: options.teacherProfile,
  originalPipelineReplaced: false,
  liveTouched: false,
  providerConfigTouched: false,
  options: { ...options, currentAdapter },
});

try {
  while (Date.now() < deadline) {
    round += 1;
    await runTeacherStep(options, round);
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
      const stableEval = await runJsonStep(options, round, "stable_hardened_eval", "node", [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--model",
        options.model,
        "--adapter",
        currentAdapter,
        "--hardened",
        "--progress",
        "--timeout-ms",
        "180000",
        "--summary-only",
        "--json",
      ]);
      if (!evalPassed(stableEval)) {
        throw new Error(`stable adapter failed hardened eval: ${currentAdapter}`);
      }
    }

    if (!options.noTrain && round % options.trainEvery === 0) {
      const candidateAdapter = adapterPathForRound(options, round);
      await runTrain(options, round, candidateAdapter);
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
      if (evalPassed(candidateEval)) {
        currentAdapter = candidateAdapter;
        await appendLog(options.logPath, {
          event: "adapter_promoted_for_guard_session",
          round,
          adapterPath: currentAdapter,
          liveTouched: false,
        });
      } else {
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
  await releaseRunLock();
}
