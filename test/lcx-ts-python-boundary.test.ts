import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runBoundary() {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/dev/lcx-ts-python-boundary.ts", "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    boundary: string;
    summary: {
      pythonFiles: number;
      keep: number;
      wrap: number;
      migrate: number;
      unknown: number;
    };
    classification: {
      keep: Array<{ path: string; plainRole: string; reason: string }>;
      wrap: Array<{ path: string; plainRole: string; reason: string; targetTsOwner?: string }>;
      migrate: Array<{ path: string; plainRole: string; reason: string; targetTsOwner?: string }>;
    };
    unknownFiles: string[];
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
}

describe("lcx-ts-python-boundary", () => {
  it("classifies every current Python file into keep, wrap, or migrate", async () => {
    const payload = await runBoundary();

    expect(payload.ok).toBe(true);
    expect(payload.boundary).toBe("local_ts_python_boundary_only");
    expect(payload.unknownFiles).toEqual([]);
    expect(payload.summary.pythonFiles).toBe(
      payload.summary.keep + payload.summary.wrap + payload.summary.migrate,
    );
    expect(payload.classification.keep).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "evals/local-brain/inspect_local_brain.py",
          plainRole: "保留",
        }),
      ]),
    );
    expect(payload.classification.wrap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "lobster_orchestrator.py",
          plainRole: "包装",
          targetTsOwner: "scripts/dev/lcx-system-doctor.ts",
        }),
      ]),
    );
    expect(payload.classification.migrate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "scripts/branch_freshness.py",
          plainRole: "迁走",
          targetTsOwner: "scripts/dev/lcx-change-impact-plan.ts",
        }),
      ]),
    );
    expect(payload.liveTouched).toBe(false);
    expect(payload.providerConfigTouched).toBe(false);
    expect(payload.protectedMemoryTouched).toBe(false);
  });
});
