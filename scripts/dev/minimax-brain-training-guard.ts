import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CliOptions = {
  durationMinutes: number;
  batchLimit: number;
  trainEvery: number;
  evalEvery: number;
  trainIters: number;
  model: string;
  noTrain: boolean;
  workspaceDir: string;
  dataDir: string;
  pythonBin: string;
  currentAdapter: string;
  adapterPrefix: string;
  logPath: string;
};

type CommandResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
};

const HOME = process.env.HOME ?? os.homedir();
const TRAINER_ROOT = path.join(HOME, ".openclaw", "local-brain-trainer");
const DEFAULT_DATA_DIR = path.join(TRAINER_ROOT, "datasets", "thought-flow-v1");
const DEFAULT_ADAPTER = path.join(
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

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/minimax-brain-training-guard.ts [options]",
      "",
      "Options:",
      "  --duration-minutes N   default 180",
      "  --batch-limit N         MiniMax teacher samples per round, default 12",
      "  --train-every N         train every N rounds, default 2",
      "  --eval-every N          eval current/new adapter every N rounds, default 1",
      "  --train-iters N         MLX LoRA iters, default 80",
      "  --no-train              only generate/rebuild/smoke/eval",
      "  --current-adapter DIR   stable adapter to evaluate and use until a new one passes",
      "  --adapter-prefix DIR    new adapter prefix",
      "  --log PATH              JSONL guard log",
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
    batchLimit: 12,
    trainEvery: 2,
    evalEvery: 1,
    trainIters: 80,
    model: "Qwen/Qwen3-0.6B",
    noTrain: false,
    workspaceDir: path.join(HOME, ".openclaw", "workspace"),
    dataDir: DEFAULT_DATA_DIR,
    pythonBin: path.join(TRAINER_ROOT, ".venv", "bin", "python"),
    currentAdapter: DEFAULT_ADAPTER,
    adapterPrefix: path.join(TRAINER_ROOT, "adapters", "thought-flow-v1-qwen3-0.6b-minimax-guard"),
    logPath: DEFAULT_LOG,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--duration-minutes") {
      options.durationMinutes = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--batch-limit") {
      options.batchLimit = readPositiveInteger(readValue(args, index));
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
      options.currentAdapter = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--adapter-prefix") {
      options.adapterPrefix = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--log") {
      options.logPath = path.resolve(readValue(args, index));
      index += 1;
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
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return JSON.parse(stdout.slice(start, end + 1));
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
const startedAt = Date.now();
const deadline = startedAt + options.durationMinutes * 60_000;
let round = 0;
let currentAdapter = options.currentAdapter;

await appendLog(options.logPath, {
  event: "guard_start",
  mode: "minimax_teacher_additive_only",
  originalPipelineReplaced: false,
  liveTouched: false,
  providerConfigTouched: false,
  options: { ...options, currentAdapter },
});

try {
  while (Date.now() < deadline) {
    round += 1;
    await runJsonStep(options, round, "minimax_teacher_batch", "node", [
      "--import",
      "tsx",
      "scripts/dev/minimax-brain-teacher-batch.ts",
      "--limit",
      String(options.batchLimit),
      "--write",
      "--json",
    ]);
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
}
