import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

type CliOptions = {
  dataDir: string;
  outDir: string;
  maxReviewExamples: number;
  curatedRepeat: number;
  nonReviewRepeat: number;
  json: boolean;
};

type JsonRecord = {
  prompt?: unknown;
  completion?: unknown;
  meta?: {
    sourceKind?: unknown;
    sourcePath?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type SourceCounts = {
  sourceTrain: number;
  curatedSeen: number;
  nonReviewSeen: number;
  reviewSeen: number;
};

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  "datasets",
  "thought-flow-v1",
);
const DEFAULT_OUT_DIR = `${DEFAULT_DATA_DIR}-train-slice`;
const REVIEW_SOURCE_KIND = "brain_distillation_review";
const CURATED_SOURCE_KIND = "curated_seed";
const NON_REVIEW_SOURCE_KINDS_TO_REPEAT = new Set([
  "finance_learning_capability_apply_receipt",
  "feishu_work_receipt",
  "lark_language_handoff_receipt",
  "module_learning_plan_receipt",
  "module_learning_review_receipt",
]);

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/local-brain-distill-train-slice.ts [--data DIR] [--out DIR] [--max-review-examples N] [--curated-repeat N] [--non-review-repeat N] [--json]",
      "",
      "Builds a bounded, balanced MLX-LM training slice from the full local-brain dataset.",
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
    dataDir: DEFAULT_DATA_DIR,
    outDir: DEFAULT_OUT_DIR,
    maxReviewExamples: 1024,
    curatedRepeat: 6,
    nonReviewRepeat: 2,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data") {
      options.dataDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--out") {
      options.outDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--max-review-examples") {
      options.maxReviewExamples = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--curated-repeat") {
      options.curatedRepeat = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--non-review-repeat") {
      options.nonReviewRepeat = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function sourceKindOf(record: JsonRecord): string {
  return typeof record.meta?.sourceKind === "string" ? record.meta.sourceKind : "unknown";
}

async function* readJsonl(filePath: string): AsyncGenerator<JsonRecord> {
  const reader = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as JsonRecord;
    if (typeof parsed.prompt !== "string" || typeof parsed.completion !== "string") {
      throw new Error(`Invalid distillation line in ${filePath}`);
    }
    yield parsed;
  }
}

async function countSourceKinds(trainPath: string): Promise<SourceCounts> {
  const counts: SourceCounts = {
    sourceTrain: 0,
    curatedSeen: 0,
    nonReviewSeen: 0,
    reviewSeen: 0,
  };
  for await (const record of readJsonl(trainPath)) {
    counts.sourceTrain += 1;
    const sourceKind = sourceKindOf(record);
    if (sourceKind === CURATED_SOURCE_KIND) {
      counts.curatedSeen += 1;
    } else if (sourceKind === REVIEW_SOURCE_KIND) {
      counts.reviewSeen += 1;
    } else {
      counts.nonReviewSeen += 1;
    }
  }
  return counts;
}

function targetReviewIndexes(reviewSeen: number, maxReviewExamples: number): Set<number> {
  const selectedCount = Math.min(reviewSeen, maxReviewExamples);
  const indexes = new Set<number>();
  for (let index = 0; index < selectedCount; index += 1) {
    indexes.add(Math.floor((index * reviewSeen) / selectedCount));
  }
  return indexes;
}

function cloneForSlice(record: JsonRecord, repeat: number, lane: string): JsonRecord {
  const sourcePath =
    typeof record.meta?.sourcePath === "string" ? record.meta.sourcePath : "unknown-source";
  return {
    ...record,
    meta: {
      ...record.meta,
      sourcePath: `${sourcePath}#train-slice-${lane}-${repeat + 1}`,
      curriculumSlice: true,
    },
  };
}

async function writeFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}

async function copyFileAtomic(sourcePath: string, outPath: string): Promise<number> {
  const content = await fs.readFile(sourcePath);
  await writeFileAtomic(outPath, content);
  return content
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim()).length;
}

async function buildTrainSlice(options: CliOptions): Promise<Record<string, unknown>> {
  const trainPath = path.join(options.dataDir, "train.jsonl");
  const counts = await countSourceKinds(trainPath);
  const selectedReviewIndexes = targetReviewIndexes(counts.reviewSeen, options.maxReviewExamples);
  const trainOut = path.join(options.outDir, "train.jsonl");
  await fs.mkdir(options.outDir, { recursive: true });
  const tempTrainOut = path.join(options.outDir, `.train.jsonl.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(tempTrainOut, "w");
  let trainWritten = 0;
  let reviewIndex = 0;
  let reviewSelected = 0;
  let curatedWritten = 0;
  let nonReviewWritten = 0;

  try {
    for await (const record of readJsonl(trainPath)) {
      const sourceKind = sourceKindOf(record);
      if (sourceKind === CURATED_SOURCE_KIND) {
        for (let repeat = 0; repeat < options.curatedRepeat; repeat += 1) {
          await handle.write(`${JSON.stringify(cloneForSlice(record, repeat, "curated"))}\n`);
          trainWritten += 1;
          curatedWritten += 1;
        }
      } else if (sourceKind === REVIEW_SOURCE_KIND) {
        if (selectedReviewIndexes.has(reviewIndex)) {
          await handle.write(`${JSON.stringify(cloneForSlice(record, 0, "review"))}\n`);
          trainWritten += 1;
          reviewSelected += 1;
        }
        reviewIndex += 1;
      } else {
        const repeatCount = NON_REVIEW_SOURCE_KINDS_TO_REPEAT.has(sourceKind)
          ? options.nonReviewRepeat
          : 1;
        for (let repeat = 0; repeat < repeatCount; repeat += 1) {
          await handle.write(`${JSON.stringify(cloneForSlice(record, repeat, "non-review"))}\n`);
          trainWritten += 1;
          nonReviewWritten += 1;
        }
      }
    }
  } finally {
    await handle.close();
  }
  await fs.rename(tempTrainOut, trainOut);

  const validCopied = await copyFileAtomic(
    path.join(options.dataDir, "valid.jsonl"),
    path.join(options.outDir, "valid.jsonl"),
  );
  const testCopied = await copyFileAtomic(
    path.join(options.dataDir, "test.jsonl"),
    path.join(options.outDir, "test.jsonl"),
  );

  const manifest = {
    ok: true,
    boundary: "local_auxiliary_thought_flow_only",
    sourceDataDir: options.dataDir,
    outDir: options.outDir,
    policy: {
      selection: "curated_first_non_review_repeated_even_review_sample",
      maxReviewExamples: options.maxReviewExamples,
      curatedRepeat: options.curatedRepeat,
      nonReviewRepeat: options.nonReviewRepeat,
    },
    counts: {
      ...counts,
      reviewSelected,
      curatedWritten,
      nonReviewWritten,
      trainWritten,
      validCopied,
      testCopied,
    },
    notTouched: [
      "live_sender",
      "provider_config",
      "protected_repo_memory",
      "formal_lark_routing_corpus",
      "finance_doctrine",
    ],
  };
  await writeFileAtomic(
    path.join(options.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

const options = parseArgs(process.argv.slice(2));
const manifest = await buildTrainSlice(options);
if (options.json) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      "local brain training slice built",
      `out_dir=${options.outDir}`,
      `train=${(manifest.counts as { trainWritten: number }).trainWritten}`,
    ].join("\n") + "\n",
  );
}
