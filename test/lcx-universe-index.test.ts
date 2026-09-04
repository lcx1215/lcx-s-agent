import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

async function runUniverseIndex(args: string[] = ["--json", "--no-write"]) {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/operator/lcx-universe-index.ts", ...args],
      {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
      },
    ));
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    stdout = details.stdout ?? "";
    if (!stdout) {
      throw new Error(
        [details.message ?? String(error), `stderr=${details.stderr ?? ""}`].join("\n"),
        { cause: error },
      );
    }
  }
  return JSON.parse(stdout) as {
    ok: boolean;
    boundary: string;
    latestStatePath: string;
    summary: {
      trackedFiles: number;
      visibleFiles: number;
      trackedAndVisibleFiles: number;
      dirtyFiles: number;
      workspaceArtifactFiles: number;
      liveSidecarFiles: number;
      unmatchedChangedFiles: number;
    };
    repo: {
      trackedFileCount: number;
      visibleFileCount: number;
      trackedAndVisibleFileCount: number;
      dirtyFileCount: number;
      topLevelCounts: Record<string, number>;
      changedFiles: string[];
    };
    ownerCoverage: {
      changeImpact: { ok: boolean; unmatchedFiles: string[]; affectedLanes: string[] };
      governanceCoverage: {
        status: string;
        scope: string;
        summary: {
          totalComponents: number;
          governedComponents: number;
          inventoryOnlyComponents: number;
          reviewRequiredComponents: number;
          coverageRate: number;
          inventoryAreaCount: number;
          inventoryAreaComponentCount: number;
        };
        routeOwnerValidation: {
          checked: string[];
          missing: string[];
        };
        unknownComponents: string[];
        components: Array<{
          path: string;
          inventoryOwner: string;
          routeOwner: string | null;
          proofSurface: string;
          boundary: string;
          disposition: string;
        }>;
        inventoryAreas: Array<{
          id: string;
          path: string;
          componentCount: number;
          inventoryOwner: string;
          routeOwner: string;
          proofSurface: string;
          boundary: string;
          disposition: string;
        }>;
      };
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
        boundary: "local_universe_index_only",
        latestStatePath: path.join(
          process.env.LCX_USER_HOME ?? "/Users/liuchengxu",
          ".openclaw",
          "workspace",
          "state",
          "lcx-universe-index-latest.json",
        ),
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.ok).toBe(
      payload.summary.unmatchedChangedFiles === 0 &&
        payload.ownerCoverage.governanceCoverage.status === "complete",
    );
    expect(payload.summary.trackedFiles).toBeGreaterThan(100);
    expect(payload.summary.visibleFiles).toBeGreaterThan(100);
    expect(payload.repo.trackedFileCount).toBe(payload.summary.trackedFiles);
    expect(payload.repo.visibleFileCount).toBe(payload.summary.visibleFiles);
    expect(payload.repo.trackedAndVisibleFileCount).toBe(payload.summary.trackedAndVisibleFiles);
    expect(payload.repo.topLevelCounts).toEqual(
      expect.objectContaining({
        scripts: expect.any(Number),
        test: expect.any(Number),
      }),
    );
    expect(payload.ownerCoverage.changeImpact.ok).toBe(
      payload.ownerCoverage.changeImpact.unmatchedFiles.length === 0,
    );
    expect(payload.ownerCoverage.governanceCoverage.status).toBe("complete");
    expect(payload.ownerCoverage.governanceCoverage.scope).toBe("repo_tracked_and_visible_files");
    expect(payload.ownerCoverage.governanceCoverage.summary.totalComponents).toBe(
      payload.summary.trackedAndVisibleFiles,
    );
    expect(payload.ownerCoverage.governanceCoverage.summary.reviewRequiredComponents).toBe(0);
    expect(payload.ownerCoverage.governanceCoverage.summary.coverageRate).toBe(1);
    expect(payload.ownerCoverage.governanceCoverage.routeOwnerValidation.missing).toEqual([]);
    expect(
      payload.ownerCoverage.governanceCoverage.routeOwnerValidation.checked.length,
    ).toBeGreaterThan(0);
    expect(payload.ownerCoverage.governanceCoverage.summary.inventoryAreaCount).toBe(5);
    expect(payload.ownerCoverage.governanceCoverage.summary.inventoryAreaComponentCount).toBe(
      payload.summary.workspaceArtifactFiles + payload.summary.liveSidecarFiles,
    );
    expect(payload.ownerCoverage.governanceCoverage.unknownComponents).toEqual([]);
    expect(payload.ownerCoverage.governanceCoverage.components).toHaveLength(
      payload.summary.trackedAndVisibleFiles,
    );
    expect(payload.ownerCoverage.governanceCoverage.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inventoryOwner: "lcx-universe-index",
          routeOwner: expect.any(String),
          proofSurface: expect.any(String),
          boundary: expect.any(String),
        }),
      ]),
    );
    expect(payload.ownerCoverage.governanceCoverage.inventoryAreas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "workspace_state",
          inventoryOwner: "lcx-universe-index",
          disposition: "inventory_only",
        }),
        expect.objectContaining({
          id: "live_sidecar",
          routeOwner: "scripts/operator/lcx-external-channel-status.ts",
          disposition: "inventory_only",
        }),
      ]),
    );
    expect(Array.isArray(payload.ownerCoverage.changeImpact.unmatchedFiles)).toBe(true);
    expect(Array.isArray(payload.ownerCoverage.changeImpact.affectedLanes)).toBe(true);
    expect(Array.isArray(payload.ownerCoverage.governanceOwners)).toBe(true);
    expect(payload.ownerCoverage.governanceOwnerCount).toBe(
      payload.ownerCoverage.governanceOwners.length,
    );
    expect(typeof payload.artifacts.workspaceState.exists).toBe("boolean");
    expect(Array.isArray(payload.artifacts.workspaceState.largestFiles)).toBe(true);
    expect(payload.artifacts.liveSidecar.path).toBe(
      path.join(
        process.env.LCX_USER_HOME ?? "/Users/liuchengxu",
        ".openclaw",
        "external-channel-runtime",
        "lcx-s-openclaw",
      ),
    );
    expect(Array.isArray(payload.garbageCandidates.untrackedRepoFiles)).toBe(true);
    expect(Array.isArray(payload.garbageCandidates.staleRuntimeFiles)).toBe(true);
    expect(Array.isArray(payload.garbageCandidates.largeRuntimeFiles)).toBe(true);
    expect(Array.isArray(payload.garbageCandidates.staleSnapshots)).toBe(true);
    expect(payload.nextSafeCommands).toEqual(expect.any(Array));
    expect(payload.nextSafeCommands).toContain(
      payload.summary.unmatchedChangedFiles === 0
        ? "node --import tsx scripts/operator/lcx-governance-autopilot.ts --json"
        : "extend scripts/operator/lcx-change-impact-plan.ts for unmatched files, then rerun universe index",
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
