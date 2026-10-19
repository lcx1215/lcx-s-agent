import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SELF_REPAIR_SOURCE_FRESHNESS_MS,
  readSelfRepairReplacementRule,
  verifySelfRepairSourceContent,
} from "../../src/agents/self-repair-source-review.js";
import { readFileWithinRoot } from "../../src/infra/fs-safe.js";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  workspaceDir: string;
  repoDir: string;
  protectedStatusPath?: string;
  correctionReviewPath?: string;
  reviewAccountId?: string;
  reviewRunId?: string;
  json: boolean;
};

type FileEntry = {
  path: string;
  mtimeMs: number;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const PROTECTED_MEMORY_PATHS = ["memory/current-research-line.md", "memory/unified-risk-view.md"];
const CURRENT_CLAIM_FRESHNESS_MS = SELF_REPAIR_SOURCE_FRESHNESS_MS;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-system-memory-sedimentation-gate.ts [--workspace DIR] [--repo DIR] [--protected-status PATH] [--correction-review PATH --review-account-id ID --review-run-id ID] [--json]",
      "",
      "Checks system-memory/correction/downrank sedimentation separately from module learning.",
      "This is read-only local evidence and never writes memory, touches the external channel, changes providers, or promotes adapters.",
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    repoDir: DEFAULT_REPO_DIR,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace" || arg === "--worktree") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--repo" || arg === "--repo-dir") {
      options.repoDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--protected-status") {
      options.protectedStatusPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--correction-review") {
      options.correctionReviewPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--review-account-id") {
      options.reviewAccountId = readValue(args, index);
      index += 1;
    } else if (arg === "--review-run-id") {
      options.reviewRunId = readValue(args, index);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.workspaceDir = path.resolve(options.workspaceDir);
  return options;
}

async function listFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath);
          return;
        }
        if (!entry.isFile()) {
          return;
        }
        const stat = await fs.stat(filePath).catch(() => undefined);
        if (stat) {
          files.push({ path: filePath, mtimeMs: stat.mtimeMs });
        }
      }),
    );
  }
  await visit(root);
  return files.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  return path.relative(workspaceDir, filePath).split(path.sep).join("/");
}

function protectedStatusFromGit(repoDir: string): string[] {
  const result = spawnSync("git", ["status", "--short", "--", ...PROTECTED_MEMORY_PATHS], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return [`git_status_failed:${result.stderr.trim() || result.status}`];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function protectedStatusLines(options: CliOptions): Promise<string[]> {
  if (options.protectedStatusPath) {
    const text = await fs.readFile(options.protectedStatusPath, "utf8").catch(() => undefined);
    if (text === undefined) {
      return ["protected_status_evidence_unreadable"];
    }
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return protectedStatusFromGit(options.repoDir);
}

function latestAgeMs(files: FileEntry[]): number | null {
  const latest = files[0];
  return latest ? Date.now() - latest.mtimeMs : null;
}

type CorrectionReviewManifest = {
  schemaVersion: 1;
  correction: { path: string; sha256: string };
  source: { path: string; sha256: string };
};

type CorrectionReview = {
  status: "not_provided" | "blocked" | "verified_provisional_downrank";
  blockers: string[];
  correction?: { path: string; sha256: string };
  source?: { path: string; sha256: string; observedAt: string };
  scope?: { accountId: string; runId: string };
  replacementRule?: string;
  downrankDecision?: "downrank";
  reuseAllowed: false;
  semanticTruth: "not_proven";
};

/** Exact local identity checks; a provisional downrank never approves source truth or reuse. */
async function reviewCorrection(options: CliOptions): Promise<CorrectionReview> {
  const blocked = (reason: string): CorrectionReview => ({
    status: "blocked",
    blockers: [reason],
    reuseAllowed: false,
    semanticTruth: "not_proven",
  });
  if (!options.correctionReviewPath) {
    return {
      status: "not_provided",
      blockers: [],
      reuseAllowed: false,
      semanticTruth: "not_proven",
    };
  }
  if (!options.reviewAccountId || !options.reviewRunId) {
    return blocked("correction_review_host_scope_missing");
  }
  let manifest: CorrectionReviewManifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(options.correctionReviewPath, "utf8"),
    ) as CorrectionReviewManifest;
    if (manifest.schemaVersion !== 1 || !manifest.correction || !manifest.source) {
      return blocked("correction_review_manifest_invalid");
    }
  } catch {
    return blocked("correction_review_manifest_unreadable");
  }
  const readExact = async (
    entry: { path: string; sha256: string },
    kind: "correction" | "source",
  ) => {
    if (
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`${kind}_reference_invalid`);
    }
    if (
      kind === "correction" &&
      !/^memory\/self-repair\/correction-downrank\/[^/]+\.md$/u.test(entry.path)
    ) {
      throw new Error("correction_path_outside_original_owner");
    }
    let buffer: Buffer;
    try {
      ({ buffer } = await readFileWithinRoot({
        rootDir: options.workspaceDir,
        relativePath: entry.path,
        maxBytes: 512 * 1024,
      }));
    } catch {
      throw new Error(`${kind}_evidence_unreadable`);
    }
    if (createHash("sha256").update(buffer).digest("hex") !== entry.sha256) {
      throw new Error(`${kind}_sha256_mismatch`);
    }
    return buffer.toString("utf8");
  };
  try {
    const correctionBody = await readExact(manifest.correction, "correction");
    const source = JSON.parse(await readExact(manifest.source, "source")) as Record<
      string,
      unknown
    >;
    const replacementRule = readSelfRepairReplacementRule(
      correctionBody,
      typeof source?.replacementRule === "string" ? source.replacementRule : undefined,
    );
    const sourceReview = verifySelfRepairSourceContent({
      source,
      accountId: options.reviewAccountId,
      runId: options.reviewRunId,
      replacementRule,
      nowMs: Date.now(),
    });
    if (!sourceReview.ok) {
      return blocked(sourceReview.reason);
    }
    if (
      !correctionBody.includes("- memoryTier: provisional_downrank\n") ||
      !correctionBody.includes("- keep_downrank_or_discard: downrank\n") ||
      !correctionBody.includes("- boundary: local_self_repair_memory_correction_only\n")
    ) {
      return blocked("correction_downrank_boundary_missing");
    }
    return {
      status: "verified_provisional_downrank",
      blockers: [],
      correction: manifest.correction,
      source: { ...manifest.source, observedAt: sourceReview.observedAt },
      scope: { accountId: options.reviewAccountId, runId: options.reviewRunId },
      replacementRule,
      downrankDecision: "downrank",
      reuseAllowed: false,
      semanticTruth: "not_proven",
    };
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "correction_review_invalid");
  }
}

async function buildGate(options: CliOptions) {
  const memoryDir = path.join(options.workspaceDir, "memory");
  const [localMemoryFiles, rootMemoryFiles, protectedStatus] = await Promise.all([
    listFiles(path.join(memoryDir, "local-memory")),
    listFiles(memoryDir),
    protectedStatusLines(options),
  ]);
  const correctionNotes = rootMemoryFiles.filter((entry) => {
    const relativePath = relativeToWorkspace(options.workspaceDir, entry.path);
    return (
      /(?:^|\/)\d{4}-\d{2}-\d{2}-correction-note-|(?:^|\/)correction-note-/u.test(relativePath) ||
      /^memory\/self-repair\/correction-downrank\/[^/]+\.md$/u.test(relativePath)
    );
  });
  const learningCouncilNotes = rootMemoryFiles.filter((entry) =>
    /learning-council/u.test(path.basename(entry.path)),
  );
  const systemMemoryFiles = [
    ...localMemoryFiles,
    ...correctionNotes,
    ...learningCouncilNotes,
  ].toSorted((left, right) => right.mtimeMs - left.mtimeMs);
  const protectedMemoryClean = protectedStatus.length === 0;
  const systemMemoryPresent = systemMemoryFiles.length > 0;
  const latestSystemMemoryAgeMs = latestAgeMs(systemMemoryFiles);
  const freshEnoughForRecallClaim =
    latestSystemMemoryAgeMs !== null && latestSystemMemoryAgeMs <= CURRENT_CLAIM_FRESHNESS_MS;
  const correctionReview = await reviewCorrection(options);
  const blockers = [
    ...correctionReview.blockers,
    ...(!systemMemoryPresent ? ["system_memory_evidence_missing"] : []),
    ...(!protectedMemoryClean ? ["protected_repo_memory_dirty_or_unreadable"] : []),
  ];
  const warnings =
    systemMemoryPresent && !freshEnoughForRecallClaim
      ? ["latest_system_memory_is_not_fresh_enough_for_recall_claim_without_reverification"]
      : [];
  return {
    ok: true,
    boundary: "local_system_memory_sedimentation_gate_only",
    status: blockers.length ? "blocked" : warnings.length ? "needs_review" : "ready",
    workspaceDir: options.workspaceDir,
    repoDir: options.repoDir,
    recallReady:
      systemMemoryPresent && protectedMemoryClean && correctionReview.status !== "blocked",
    recallClaimReady:
      systemMemoryPresent &&
      protectedMemoryClean &&
      freshEnoughForRecallClaim &&
      correctionReview.status !== "blocked",
    correctionReview,
    freshEnoughForRecallClaim,
    moduleLearningClaimAllowed: false,
    protectedMemoryClean,
    protectedStatus,
    protectedMemoryPaths: PROTECTED_MEMORY_PATHS,
    counts: {
      localMemoryFiles: localMemoryFiles.length,
      correctionNotes: correctionNotes.length,
      learningCouncilNotes: learningCouncilNotes.length,
      systemMemoryFiles: systemMemoryFiles.length,
    },
    latestSystemMemory: systemMemoryFiles[0]
      ? {
          path: relativeToWorkspace(options.workspaceDir, systemMemoryFiles[0].path),
          ageMs: latestSystemMemoryAgeMs,
          freshEnoughForRecallClaim,
        }
      : null,
    claimBoundaries: {
      canClaim: [
        ...(systemMemoryPresent ? ["system_memory_present"] : []),
        ...(systemMemoryPresent && protectedMemoryClean && correctionReview.status !== "blocked"
          ? ["system_memory_recall_ready"]
          : []),
        ...(systemMemoryPresent &&
        protectedMemoryClean &&
        freshEnoughForRecallClaim &&
        correctionReview.status !== "blocked"
          ? ["system_memory_recall_claim_ready"]
          : []),
      ],
      cannotClaim: [
        "module_eval_absorbed",
        "qwen_weight_absorbed",
        "live_visible_fixed",
        "protected_memory_updated",
      ],
    },
    blockers,
    warnings,
    notTouched: [
      "external_channel_sender",
      "provider_config",
      "protected_repo_memory",
      "formal_external_routing_corpus",
      "module_learning_receipts",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    languageCorpusTouched: false,
  };
}

function renderText(result: Awaited<ReturnType<typeof buildGate>>): string {
  return (
    [
      `System memory sedimentation gate | recall_ready=${result.recallReady}`,
      `boundary=${result.boundary}`,
      `recall_claim_ready=${result.recallClaimReady}`,
      `fresh_enough_for_recall_claim=${result.freshEnoughForRecallClaim}`,
      `module_learning_claim_allowed=${result.moduleLearningClaimAllowed}`,
      `protected_memory_clean=${result.protectedMemoryClean}`,
      `local_memory_files=${result.counts.localMemoryFiles}`,
      `correction_notes=${result.counts.correctionNotes}`,
      `learning_council_notes=${result.counts.learningCouncilNotes}`,
      `blockers=${result.blockers.join(",") || "none"}`,
      `warnings=${result.warnings.join(",") || "none"}`,
    ].join("\n") + "\n"
  );
}

const options = parseArgs(process.argv.slice(2));
const result = await buildGate(options);
if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(renderText(result));
}
