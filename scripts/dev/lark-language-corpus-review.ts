import path from "node:path";
import {
  buildLarkRoutingCandidatePromotionReview,
  LARK_LANGUAGE_CANDIDATE_DIR,
  readLarkRoutingCandidatePromotionArtifacts,
  writeLarkRoutingCandidatePromotionReview,
} from "../../extensions/feishu/src/lark-routing-candidate-corpus.ts";
import { LARK_ROUTING_CORPUS } from "../../extensions/feishu/src/lark-routing-corpus.ts";

type CliOptions = {
  dateKey: string;
  rootDir?: string;
  minAcceptedPerFamily?: number;
  maxFiles?: number;
  write: boolean;
  json: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lark-language-corpus-review.ts [--date YYYY-MM-DD] [--root DIR] [--min N] [--max-files N] [--write] [--json]",
      "",
      "Default is dry-run. Add --write to create memory/lark-language-routing-reviews/<date>.json and .patch.ts.",
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

function defaultDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dateKey: defaultDateKey(),
    write: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--date") {
      options.dateKey = readValue(args, index);
      index += 1;
    } else if (arg === "--root") {
      options.rootDir = readValue(args, index);
      index += 1;
    } else if (arg === "--min") {
      options.minAcceptedPerFamily = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--max-files") {
      options.maxFiles = readPositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.dateKey)) {
    usage();
  }
  return options;
}

function normalizeRel(workspaceDir: string, value: string): string {
  return path.relative(workspaceDir, value).split(path.sep).join("/") || ".";
}

function resolveRootDir(workspaceDir: string, options: CliOptions): string {
  if (options.rootDir) {
    return path.isAbsolute(options.rootDir)
      ? options.rootDir
      : path.join(workspaceDir, options.rootDir);
  }
  return path.join(workspaceDir, LARK_LANGUAGE_CANDIDATE_DIR, options.dateKey);
}

function renderText(params: {
  workspaceDir: string;
  sourceRoot: string;
  write: boolean;
  reviewPath?: string;
  patchPath?: string;
  review: ReturnType<typeof buildLarkRoutingCandidatePromotionReview>;
  skipped: Awaited<ReturnType<typeof readLarkRoutingCandidatePromotionArtifacts>>["skipped"];
}): string {
  const lines = [
    `Lark language corpus review | mode=${params.write ? "write" : "dry-run"}`,
    `source_root=${normalizeRel(params.workspaceDir, params.sourceRoot)}`,
    `source_artifacts=${params.review.counts.sourceArtifacts}`,
    `accepted_cases=${params.review.counts.acceptedCases}`,
    `duplicate_cases=${params.review.counts.duplicateCases}`,
    `promoted_cases=${params.review.counts.promotedCases}`,
  ];
  if (params.reviewPath) {
    lines.push(`review_path=${params.reviewPath}`);
  }
  if (params.patchPath) {
    lines.push(`patch_path=${params.patchPath}`);
  }
  for (const decision of params.review.familyDecisions) {
    lines.push(
      `family=${decision.family} accepted=${decision.accepted} promoted=${decision.promoted} status=${decision.status}${
        decision.reason ? ` reason=${decision.reason}` : ""
      }`,
    );
  }
  for (const skipped of params.skipped) {
    lines.push(
      `skipped=${normalizeRel(params.workspaceDir, skipped.path)} reason=${skipped.reason}`,
    );
  }
  if (!params.write && params.review.counts.promotedCases > 0) {
    lines.push("next=rerun with --write after reviewing the dry-run output");
  }
  return `${lines.join("\n")}\n`;
}

const workspaceDir = process.cwd();
const options = parseArgs(process.argv.slice(2));
const sourceRoot = resolveRootDir(workspaceDir, options);

const result = options.write
  ? await writeLarkRoutingCandidatePromotionReview({
      workspaceDir,
      dateKey: options.dateKey,
      rootDir: sourceRoot,
      existingCorpus: LARK_ROUTING_CORPUS,
      minAcceptedPerFamily: options.minAcceptedPerFamily,
      maxFiles: options.maxFiles,
    })
  : undefined;

const readResult = result
  ? { artifacts: [], skipped: result.skipped }
  : await readLarkRoutingCandidatePromotionArtifacts({
      rootDir: sourceRoot,
      ...(options.maxFiles ? { maxFiles: options.maxFiles } : {}),
    });
const review =
  result?.review ??
  buildLarkRoutingCandidatePromotionReview({
    artifacts: readResult.artifacts,
    existingCorpus: LARK_ROUTING_CORPUS,
    minAcceptedPerFamily: options.minAcceptedPerFamily,
    skipped: readResult.skipped,
  });

const output = {
  ok: true,
  boundary: "language_routing_only",
  mode: options.write ? "write" : "dry-run",
  sourceRoot: normalizeRel(workspaceDir, sourceRoot),
  reviewPath: result?.reviewPath,
  patchPath: result?.patchPath,
  counts: review.counts,
  familyDecisions: review.familyDecisions,
  skippedCounts: review.skippedCounts,
  skipped: readResult.skipped.map((entry) => ({
    ...entry,
    path: normalizeRel(workspaceDir, entry.path),
  })),
};

if (options.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  process.stdout.write(
    renderText({
      workspaceDir,
      sourceRoot,
      write: options.write,
      reviewPath: result?.reviewPath,
      patchPath: result?.patchPath,
      review,
      skipped: readResult.skipped,
    }),
  );
}
