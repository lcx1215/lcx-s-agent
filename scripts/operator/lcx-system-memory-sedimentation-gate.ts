import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  workspaceDir: string;
  repoDir: string;
  protectedStatusPath?: string;
  json: boolean;
};

type FileEntry = {
  path: string;
  mtimeMs: number;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const PROTECTED_MEMORY_PATHS = ["memory/current-research-line.md", "memory/unified-risk-view.md"];
const CURRENT_CLAIM_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-system-memory-sedimentation-gate.ts [--workspace DIR] [--repo DIR] [--protected-status PATH] [--json]",
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
    const text = await fs.readFile(options.protectedStatusPath, "utf8").catch(() => "");
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

async function buildGate(options: CliOptions) {
  const memoryDir = path.join(options.workspaceDir, "memory");
  const [localMemoryFiles, rootMemoryFiles, protectedStatus] = await Promise.all([
    listFiles(path.join(memoryDir, "local-memory")),
    listFiles(memoryDir),
    protectedStatusLines(options),
  ]);
  const correctionNotes = rootMemoryFiles.filter((entry) =>
    /(?:^|\/)\d{4}-\d{2}-\d{2}-correction-note-|(?:^|\/)correction-note-/u.test(
      relativeToWorkspace(options.workspaceDir, entry.path),
    ),
  );
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
  const blockers = [
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
    workspaceDir: options.workspaceDir,
    repoDir: options.repoDir,
    recallReady: systemMemoryPresent && protectedMemoryClean,
    recallClaimReady: systemMemoryPresent && protectedMemoryClean && freshEnoughForRecallClaim,
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
        ...(systemMemoryPresent && protectedMemoryClean ? ["system_memory_recall_ready"] : []),
        ...(systemMemoryPresent && protectedMemoryClean && freshEnoughForRecallClaim
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
