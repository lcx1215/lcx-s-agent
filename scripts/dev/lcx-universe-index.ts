import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_WORKSPACE_DIR,
  DEFAULT_WORKSPACE_LOG_DIR,
  LCX_USER_HOME,
  UNIVERSE_INDEX_LATEST_PATH,
} from "./lcx-local-paths.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const STALE_ARTIFACT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LARGE_ARTIFACT_BYTES = 50 * 1024 * 1024;
const LIVE_SIDECAR_ROOT = path.join(LCX_USER_HOME, ".openclaw", "live-sidecars", "lcx-s-openclaw");

type ArtifactFile = {
  path: string;
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  ageMs: number;
};

type ArtifactInventory = {
  path: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  largestFiles: ArtifactFile[];
  staleFiles: ArtifactFile[];
  skippedDirs: string[];
};

type Options = {
  json: boolean;
  write: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-universe-index.ts [--json] [--no-write]",
      "",
      "Builds the read-only LCX universe index: repo files, dirty state, runtime",
      "artifacts, live sidecar inventory, owner coverage, and garbage candidates.",
      "It may write only lcx-universe-index-latest.json unless --no-write is used.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): Options {
  const options: Options = { json: false, write: true };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-write") {
      options.write = false;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

async function execLines(
  command: string,
  args: string[],
  cwd = repoRoot,
  trimLines = true,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return stdout
      .split("\n")
      .map((line) => (trimLines ? line.trim() : line))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function topLevel(file: string): string {
  return file.split("/")[0] || ".";
}

function countByTopLevel(files: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = topLevel(file);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
}

function parseGitStatus(lines: readonly string[]) {
  const branch = lines.find((line) => line.startsWith("##")) ?? "";
  const entries = lines
    .filter((line) => !line.startsWith("##"))
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const filePath = rawPath.includes(" -> ")
        ? (rawPath.split(" -> ").at(-1) ?? rawPath)
        : rawPath;
      return { status, path: filePath };
    });
  return {
    branch,
    entries,
    changedFiles: entries.map((entry) => entry.path),
    untrackedFiles: entries.filter((entry) => entry.status === "??").map((entry) => entry.path),
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function changeImpactCoverage(files: readonly string[]) {
  if (files.length === 0) {
    return {
      ok: true,
      affectedLanes: [],
      unmatchedFiles: [],
      recommendedFastCommands: [],
      deferredCommands: [],
      source: "no_changed_files",
    };
  }
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-change-impact-plan.ts", "--json", "--files", ...files],
      {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    return {
      ok: payload.ok === true,
      affectedLanes: payload.affectedLanes ?? [],
      unmatchedFiles: payload.unmatchedFiles ?? [],
      strayGate: payload.strayGate ?? {
        ok: payload.ok === true && arrayValue(payload.unmatchedFiles).length === 0,
        unmatchedChangedFiles: payload.unmatchedFiles ?? [],
      },
      recommendedFastCommands: payload.recommendedFastCommands ?? [],
      deferredCommands: payload.deferredCommands ?? [],
      source: "lcx-change-impact-plan",
    };
  } catch (error) {
    return {
      ok: false,
      affectedLanes: [],
      unmatchedFiles: files,
      recommendedFastCommands: [],
      deferredCommands: [],
      source: "lcx-change-impact-plan_failed",
      error: String(error),
    };
  }
}

async function walkArtifacts(root: string, nowMs: number): Promise<ArtifactInventory> {
  const skippedDirs: string[] = [];
  const files: ArtifactFile[] = [];
  async function walk(current: string) {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          ["node_modules", ".git", ".venv", "__pycache__", "dist", ".next"].includes(entry.name)
        ) {
          skippedDirs.push(path.relative(root, absolutePath) || entry.name);
          continue;
        }
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(absolutePath).catch(() => undefined);
      if (!stat) {
        continue;
      }
      files.push({
        path: absolutePath,
        relativePath: path.relative(root, absolutePath),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ageMs: Math.max(0, nowMs - stat.mtimeMs),
      });
    }
  }

  const exists = await fs
    .access(root)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return {
      path: root,
      exists: false,
      fileCount: 0,
      totalBytes: 0,
      largestFiles: [],
      staleFiles: [],
      skippedDirs,
    };
  }
  await walk(root);
  return {
    path: root,
    exists: true,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    largestFiles: files.toSorted((a, b) => b.bytes - a.bytes).slice(0, 12),
    staleFiles: files
      .filter((file) => file.ageMs > STALE_ARTIFACT_AGE_MS)
      .toSorted((a, b) => b.ageMs - a.ageMs)
      .slice(0, 20),
    skippedDirs,
  };
}

function staleLatestSnapshot(latest: Record<string, unknown> | undefined, maxAgeMs: number) {
  const checkedAt =
    typeof latest?.checkedAt === "string" ? Date.parse(latest.checkedAt) : undefined;
  if (checkedAt === undefined || Number.isNaN(checkedAt)) {
    return { stale: true, checkedAt: latest?.checkedAt, ageMs: undefined };
  }
  const ageMs = Date.now() - checkedAt;
  return { stale: ageMs < 0 || ageMs > maxAgeMs, checkedAt: latest?.checkedAt, ageMs };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();
  const [trackedFiles, rgFilesRaw, gitStatusLines] = await Promise.all([
    execLines("git", ["ls-files"]),
    execLines("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules"]),
    execLines("git", ["status", "--short", "--branch"], repoRoot, false),
  ]);
  const rgFiles = rgFilesRaw.length > 0 ? rgFilesRaw : trackedFiles;
  const gitStatus = parseGitStatus(gitStatusLines);
  const [
    changeImpact,
    workspaceState,
    workspaceLogs,
    workspaceMemory,
    workspaceTmp,
    liveSidecar,
    latestGovernance,
    latestOperator,
  ] = await Promise.all([
    changeImpactCoverage(gitStatus.changedFiles),
    walkArtifacts(path.join(DEFAULT_WORKSPACE_DIR, "state"), nowMs),
    walkArtifacts(DEFAULT_WORKSPACE_LOG_DIR, nowMs),
    walkArtifacts(path.join(DEFAULT_WORKSPACE_DIR, "memory"), nowMs),
    walkArtifacts(path.join(DEFAULT_WORKSPACE_DIR, "tmp"), nowMs),
    walkArtifacts(LIVE_SIDECAR_ROOT, nowMs),
    readJson(path.join(DEFAULT_WORKSPACE_DIR, "state", "lcx-governance-autopilot-latest.json")),
    readJson(path.join(DEFAULT_WORKSPACE_DIR, "state", "lcx-local-operator-latest.json")),
  ]);

  const staleSnapshots = [
    {
      id: "lcx-governance-autopilot-latest",
      ...staleLatestSnapshot(latestGovernance, 2 * 60 * 60 * 1000),
    },
    {
      id: "lcx-local-operator-latest",
      ...staleLatestSnapshot(latestOperator, 2 * 60 * 60 * 1000),
    },
  ].filter((snapshot) => snapshot.stale);
  const artifactInventories = [workspaceState, workspaceLogs, workspaceMemory, workspaceTmp];
  const largeRuntimeFiles = artifactInventories.flatMap((inventory) =>
    inventory.largestFiles
      .filter((file) => file.bytes >= LARGE_ARTIFACT_BYTES)
      .map((file) => ({ area: inventory.path, ...file })),
  );
  const staleRuntimeFiles = artifactInventories.flatMap((inventory) =>
    inventory.staleFiles.map((file) => ({ area: inventory.path, ...file })),
  );
  const governanceOwners = arrayValue(latestGovernance?.autoTriggeredOwnerCommands).filter(
    (item): item is string => typeof item === "string",
  );
  const unmatchedChangedFiles = arrayValue(changeImpact.unmatchedFiles);
  const result = {
    ok: changeImpact.ok && unmatchedChangedFiles.length === 0,
    boundary: "dev_universe_index_only",
    checkedAt: new Date().toISOString(),
    repoRoot,
    latestStatePath: UNIVERSE_INDEX_LATEST_PATH,
    summary: {
      trackedFiles: trackedFiles.length,
      visibleFiles: rgFiles.length,
      dirtyFiles: gitStatus.changedFiles.length,
      untrackedFiles: gitStatus.untrackedFiles.length,
      workspaceArtifactFiles: artifactInventories.reduce(
        (sum, inventory) => sum + inventory.fileCount,
        0,
      ),
      liveSidecarFiles: liveSidecar.fileCount,
      unmatchedChangedFiles: unmatchedChangedFiles.length,
      staleRuntimeCandidates: staleRuntimeFiles.length,
      largeRuntimeCandidates: largeRuntimeFiles.length,
      staleSnapshots: staleSnapshots.length,
    },
    repo: {
      branch: gitStatus.branch,
      trackedFileCount: trackedFiles.length,
      visibleFileCount: rgFiles.length,
      dirtyFileCount: gitStatus.changedFiles.length,
      untrackedFileCount: gitStatus.untrackedFiles.length,
      topLevelCounts: countByTopLevel(rgFiles),
      changedFiles: gitStatus.changedFiles,
      untrackedFiles: gitStatus.untrackedFiles,
    },
    ownerCoverage: {
      changeImpact,
      governanceOwners,
      governanceOwnerCount: governanceOwners.length,
      latestGovernanceBoundary: latestGovernance?.boundary,
      latestOperatorBoundary: latestOperator?.boundary,
    },
    artifacts: {
      workspaceState,
      workspaceLogs,
      workspaceMemory,
      workspaceTmp,
      liveSidecar,
    },
    garbageCandidates: {
      untrackedRepoFiles: gitStatus.untrackedFiles,
      unmatchedChangedFiles,
      staleRuntimeFiles,
      largeRuntimeFiles,
      staleSnapshots,
    },
    nextSafeCommands:
      unmatchedChangedFiles.length > 0
        ? [
            "extend scripts/dev/lcx-change-impact-plan.ts for unmatched files, then rerun universe index",
          ]
        : [
            "node --import tsx scripts/dev/lcx-governance-autopilot.ts --json",
            "node --import tsx scripts/dev/lcx-context-recovery-exam.ts --json",
          ],
    note: "Inventory only: this owner finds files, artifacts, coverage gaps, and cleanup candidates; it never deletes, migrates live runtime, changes provider config, or touches protected memory.",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  if (options.write) {
    await fs.mkdir(path.dirname(UNIVERSE_INDEX_LATEST_PATH), { recursive: true });
    await fs.writeFile(UNIVERSE_INDEX_LATEST_PATH, `${JSON.stringify(result, null, 2)}\n`);
  }

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `LCX universe index: ok=${result.ok}`,
          `tracked=${result.summary.trackedFiles} visible=${result.summary.visibleFiles} dirty=${result.summary.dirtyFiles}`,
          `artifacts=${result.summary.workspaceArtifactFiles} liveSidecar=${result.summary.liveSidecarFiles}`,
          `unmatchedChangedFiles=${result.summary.unmatchedChangedFiles}`,
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

await main();
