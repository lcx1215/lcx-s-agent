import fs from "node:fs/promises";
import path from "node:path";

type CliOptions = {
  dataDir: string;
  minTrain: number;
  json: boolean;
};

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
    "Usage: node --import tsx scripts/dev/local-brain-distill-smoke.ts [--data DIR] [--min-train N] [--json]",
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

async function readJsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
    completion.rejected_context.includes("old_lark_conversation_history"),
    `${split}[${index}] missing old context rejection`,
  );
}

const options = parseArgs(process.argv.slice(2));
const splits = {
  train: await readJsonl(path.join(options.dataDir, "train.jsonl")),
  valid: await readJsonl(path.join(options.dataDir, "valid.jsonl")),
  test: await readJsonl(path.join(options.dataDir, "test.jsonl")),
};

assert(splits.train.length >= options.minTrain, `train split too small: ${splits.train.length}`);
assert(splits.valid.length >= 1, "valid split empty");
assert(splits.test.length >= 1, "test split empty");

for (const [split, examples] of Object.entries(splits)) {
  examples.forEach((example, index) => validateExample(example, split, index));
}

const result = {
  ok: true,
  boundary: "local_auxiliary_thought_flow_only",
  counts: {
    train: splits.train.length,
    valid: splits.valid.length,
    test: splits.test.length,
  },
  checked: REQUIRED_COMPLETION_KEYS,
  liveTouched: false,
  providerConfigTouched: false,
};

process.stdout.write(
  options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `local brain distillation smoke ok train=${splits.train.length} valid=${splits.valid.length} test=${splits.test.length}\n`,
);
