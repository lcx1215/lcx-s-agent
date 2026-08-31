import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

async function runUniverseIndex(args: string[] = ["--json", "--no-write"]) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-universe-index.ts", ...args],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    boundary: string;
    latestStatePath: string;
    summary: {
      trackedFiles: number;
      visibleFiles: number;
      dirtyFiles: number;
      workspaceArtifactFiles: number;
      liveSidecarFiles: number;
      unmatchedChangedFiles: number;
    };
    repo: {
      trackedFileCount: number;
      visibleFileCount: number;
      dirtyFileCount: number;
      topLevelCounts: Record<string, number>;
      changedFiles: string[];
    };
    ownerCoverage: {
      changeImpact: { ok: boolean; unmatchedFiles: string[]; affectedLanes: string[] };
      governanceOwners: string[];
      governanceOwnerCount: number;
    };
    artifacts: {
      workspaceState: { exists: boolean; fileCount: number; largestFiles: unknown[] };
      workspaceLogs: { exists: boolean; fileCount: number };
      workspaceMemory: { exists: boolean; fileCount: number };
      workspaceTmp: { exists: boolean; fileCount: number };
      liveSidecar: { path: string; exists: boolean; fileCount: number };
    };
    garbageCandidates: {
      untrackedRepoFiles: string[];
      unmatchedChangedFiles: string[];
      staleRuntimeFiles: unknown[];
      largeRuntimeFiles: unknown[];
      staleSnapshots: unknown[];
    };
    nextSafeCommands: string[];
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
}

describe("LCX universe index", () => {
  it("builds one read-only index for repo files, runtime artifacts, live sidecar, and owner coverage", async () => {
    const payload = await runUniverseIndex();

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_universe_index_only",
        latestStatePath:
          "/Users/liuchengxu/.openclaw/workspace/state/lcx-universe-index-latest.json",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary.trackedFiles).toBeGreaterThan(100);
    expect(payload.summary.visibleFiles).toBeGreaterThan(100);
    expect(payload.repo.trackedFileCount).toBe(payload.summary.trackedFiles);
    expect(payload.repo.visibleFileCount).toBe(payload.summary.visibleFiles);
    expect(payload.repo.topLevelCounts).toEqual(
      expect.objectContaining({
        scripts: expect.any(Number),
        test: expect.any(Number),
      }),
    );
    expect(payload.ownerCoverage.changeImpact.ok).toBe(true);
    expect(payload.ownerCoverage.changeImpact.unmatchedFiles).toEqual([]);
    expect(Array.isArray(payload.ownerCoverage.changeImpact.affectedLanes)).toBe(true);
    expect(Array.isArray(payload.ownerCoverage.governanceOwners)).toBe(true);
    expect(payload.ownerCoverage.governanceOwnerCount).toBe(
      payload.ownerCoverage.governanceOwners.length,
    );
    expect(payload.artifacts.workspaceState.exists).toBe(true);
    expect(Array.isArray(payload.artifacts.workspaceState.largestFiles)).toBe(true);
    expect(payload.artifacts.liveSidecar.path).toBe(
      "/Users/liuchengxu/.openclaw/external-channel-runtime/lcx-s-openclaw",
    );
    expect(Array.isArray(payload.garbageCandidates.untrackedRepoFiles)).toBe(true);
    expect(Array.isArray(payload.garbageCandidates.staleRuntimeFiles)).toBe(true);
    expect(Array.isArray(payload.garbageCandidates.largeRuntimeFiles)).toBe(true);
    expect(Array.isArray(payload.garbageCandidates.staleSnapshots)).toBe(true);
    expect(payload.nextSafeCommands).toEqual(
      expect.arrayContaining([
        "node --import tsx scripts/operator/lcx-governance-autopilot.ts --json",
      ]),
    );
  }, 120_000);

  it("persists the latest snapshot when not run with --no-write", async () => {
    const payload = await runUniverseIndex(["--json"]);
    const latest = JSON.parse(await fs.readFile(payload.latestStatePath, "utf8")) as {
      boundary: string;
      summary: { trackedFiles: number };
    };

    expect(latest.boundary).toBe("local_universe_index_only");
    expect(latest.summary.trackedFiles).toBe(payload.summary.trackedFiles);
  }, 120_000);
});
