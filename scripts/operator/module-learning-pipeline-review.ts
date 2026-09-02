import path from "node:path";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.ts";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  dateKey?: string;
  targetModule?: string;
  maxFiles?: number;
  workspaceDir: string;
  writeReview: boolean;
  json: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/module-learning-pipeline-review.ts [--date YYYY-MM-DD] [--target-module NAME] [--max-files N] [--workspace DIR] [--no-write] [--json]",
      "",
      "Default reads/writes under ~/.openclaw/workspace/memory/module-learning-pipeline-*.",
      "Use --no-write for a dry run. This is local review only and does not touch live/provider/protected-memory state.",
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
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    writeReview: true,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--date" || arg === "--date-key") {
      options.dateKey = readValue(args, index);
      index += 1;
    } else if (arg === "--target-module") {
      options.targetModule = readValue(args, index);
      index += 1;
    } else if (arg === "--max-files") {
      options.maxFiles = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--workspace" || arg === "--worktree") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--no-write" || arg === "--dry-run") {
      options.writeReview = false;
    } else if (arg === "--write") {
      options.writeReview = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (options.dateKey && !/^\d{4}-\d{2}-\d{2}$/u.test(options.dateKey)) {
    usage();
  }
  return options;
}

function stringValue(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function renderText(details: Record<string, unknown>): string {
  const counts =
    details.counts && typeof details.counts === "object"
      ? (details.counts as Record<string, unknown>)
      : {};
  const lines = [
    `Module learning pipeline review | mode=${details.updated ? "write" : "dry-run"}`,
    `boundary=${stringValue(details.boundary)}`,
    `date=${stringValue(details.dateKey)}`,
    `target_module=${stringValue(details.targetModule, "all")}`,
    `receipt_files=${numberValue(counts.receiptFiles)}`,
    `valid_receipts=${numberValue(counts.validReceipts)}`,
    `invalid_receipts=${numberValue(counts.invalidReceipts)}`,
    `weak_module_learning=${numberValue(counts.weakModuleLearning)}`,
    `boundary_violations=${numberValue(counts.boundaryViolations)}`,
  ];
  const reviewPath = stringValue(details.reviewPath, "");
  if (reviewPath) {
    lines.push(`review_path=${reviewPath}`);
  }
  const weak = Array.isArray(details.weakModuleLearning)
    ? (details.weakModuleLearning as Record<string, unknown>[])
    : [];
  for (const entry of weak.slice(0, 8)) {
    lines.push(
      `weak target=${stringValue(entry.targetModule)} status=${stringValue(
        entry.status,
      )} reason=${stringValue(entry.failedReason)}`,
    );
  }
  const proofGapSummary =
    details.proofGapSummary && typeof details.proofGapSummary === "object"
      ? (details.proofGapSummary as Record<string, unknown>)
      : {};
  for (const [proof, count] of Object.entries(proofGapSummary)
    .filter(([, count]) => numberValue(count) > 0)
    .slice(0, 10)) {
    lines.push(`missing_proof ${proof}=${numberValue(count)}`);
  }
  const nextProofQueue = Array.isArray(details.nextProofQueue)
    ? (details.nextProofQueue as Record<string, unknown>[])
    : [];
  for (const entry of nextProofQueue.slice(0, 5)) {
    lines.push(
      `next_proof target=${stringValue(entry.targetModule)} owner=${stringValue(
        entry.nextProofOwner,
      )} status=${stringValue(entry.status)}`,
    );
  }
  if (!details.updated) {
    lines.push("next=rerun without --no-write when the dry-run output is acceptable");
  }
  return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
const tool = createModuleLearningPipelineReviewTool({ workspaceDir: options.workspaceDir });
const result = await tool.execute("module-learning-pipeline-review-cli", {
  dateKey: options.dateKey,
  targetModule: options.targetModule,
  maxFiles: options.maxFiles,
  writeReview: options.writeReview,
});
const details = result.details as Record<string, unknown>;

if (options.json) {
  console.log(JSON.stringify(details, null, 2));
} else {
  process.stdout.write(renderText(details));
}
