import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

type CliOptions = {
  dataDir: string;
  minTrain: number;
  json: boolean;
};

const JSONL_READ_ATTEMPTS = 5;
const JSONL_RETRY_DELAY_MS = 75;

const REQUIRED_COMPLETION_KEYS = [
  "task_family",
  "primary_modules",
  "supporting_modules",
  "required_tools",
  "missing_data",
  "risk_boundaries",
  "next_step",
  "rejected_context",
] as const;

function usage(): never {
  throw new Error(
    "Usage: node --import tsx scripts/operator/local-brain-distill-smoke.ts [--data DIR] [--min-train N] [--json]",
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: path.join(
      process.env.HOME ?? ".",
      ".openclaw",
      "local-brain-trainer",
      "datasets",
      "thought-flow-v1",
    ),
    minTrain: 3,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data") {
      options.dataDir = readValue(args, index);
      index += 1;
    } else if (arg === "--min-train") {
      const parsed = Number(readValue(args, index));
      if (!Number.isInteger(parsed) || parsed <= 0) {
        usage();
      }
      options.minTrain = parsed;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.dataDir = path.resolve(options.dataDir);
  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function validateJsonlSplit(filePath: string, split: string): Promise<number> {
  let count = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      count += 1;
      try {
        validateExample(JSON.parse(line) as Record<string, unknown>, split, count - 1);
      } catch (error) {
        throw new Error(
          `invalid JSONL in ${filePath}:${count}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  } finally {
    stream.destroy();
  }
  return count;
}

async function readJsonlCount(filePath: string, split: string): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= JSONL_READ_ATTEMPTS; attempt += 1) {
    try {
      return await validateJsonlSplit(filePath, split);
    } catch (error) {
      lastError = error;
      if (attempt < JSONL_READ_ATTEMPTS) {
        await sleep(JSONL_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function validateExample(example: Record<string, unknown>, split: string, index: number): void {
  assert(
    typeof example.prompt === "string" && example.prompt.includes("LCX Agent"),
    `${split}[${index}] prompt`,
  );
  assert(
    typeof example.completion === "string" && example.completion.trim().startsWith("{"),
    `${split}[${index}] completion json string`,
  );
  const completion = JSON.parse(example.completion) as Record<string, unknown>;
  for (const key of REQUIRED_COMPLETION_KEYS) {
    assert(
      Object.prototype.hasOwnProperty.call(completion, key),
      `${split}[${index}] missing ${key}`,
    );
  }
  assert(Array.isArray(completion.primary_modules), `${split}[${index}] primary_modules array`);
  assert(Array.isArray(completion.risk_boundaries), `${split}[${index}] risk_boundaries array`);
  assert(
    completion.risk_boundaries.includes("no_execution_authority") ||
      completion.risk_boundaries.includes("research_only"),
    `${split}[${index}] missing research/no-execution boundary`,
  );
  assert(Array.isArray(completion.rejected_context), `${split}[${index}] rejected_context array`);
  assert(
    completion.rejected_context.includes("old_external_conversation_history"),
    `${split}[${index}] missing old context rejection`,
  );
}

const options = parseArgs(process.argv.slice(2));
const splits = {
  train: await readJsonlCount(path.join(options.dataDir, "train.jsonl"), "train"),
  valid: await readJsonlCount(path.join(options.dataDir, "valid.jsonl"), "valid"),
  test: await readJsonlCount(path.join(options.dataDir, "test.jsonl"), "test"),
};

assert(splits.train >= options.minTrain, `train split too small: ${splits.train}`);
assert(splits.valid >= 1, "valid split empty");
assert(splits.test >= 1, "test split empty");

const result = {
  ok: true,
  boundary: "local_auxiliary_thought_flow_only",
  counts: {
    train: splits.train,
    valid: splits.valid,
    test: splits.test,
  },
  checked: REQUIRED_COMPLETION_KEYS,
  liveTouched: false,
  providerConfigTouched: false,
};

process.stdout.write(
  options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `local brain distillation smoke ok train=${splits.train} valid=${splits.valid} test=${splits.test}\n`,
);
