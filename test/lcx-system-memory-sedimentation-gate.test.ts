import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/dev/lcx-system-memory-sedimentation-gate.ts");

async function seedFile(workspaceDir: string, relativePath: string, body = "x") {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, body, "utf8");
  return absolutePath;
}

function runCli(workspaceDir: string, protectedStatusPath: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "--workspace",
      workspaceDir,
      "--protected-status",
      protectedStatusPath,
      "--json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

describe("lcx-system-memory-sedimentation-gate", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("allows system recall without allowing module-learning claims", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-system-memory-gate-"));
    await seedFile(workspaceDir, "memory/local-memory/lesson.md", "lesson");
    await seedFile(workspaceDir, "memory/2026-05-14-correction-note-test.md", "note");
    await seedFile(workspaceDir, "memory/2026-05-14-learning-council-test.md", "council");
    const protectedStatusPath = await seedFile(workspaceDir, "protected-status.txt", "");

    const result = runCli(workspaceDir, protectedStatusPath);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_system_memory_sedimentation_gate_only",
        recallReady: true,
        recallClaimReady: true,
        freshEnoughForRecallClaim: true,
        moduleLearningClaimAllowed: false,
        protectedMemoryClean: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        languageCorpusTouched: false,
      }),
    );
    expect(parsed.claimBoundaries).toEqual(
      expect.objectContaining({
        canClaim: expect.arrayContaining([
          "system_memory_present",
          "system_memory_recall_ready",
          "system_memory_recall_claim_ready",
        ]),
        cannotClaim: expect.arrayContaining([
          "module_eval_absorbed",
          "qwen_weight_absorbed",
          "live_visible_fixed",
          "protected_memory_updated",
        ]),
      }),
    );
  });

  it("blocks recall readiness when protected repo memory is dirty", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-system-memory-gate-"));
    await seedFile(workspaceDir, "memory/local-memory/lesson.md", "lesson");
    const protectedStatusPath = await seedFile(
      workspaceDir,
      "protected-status.txt",
      " M memory/current-research-line.md\n",
    );

    const result = runCli(workspaceDir, protectedStatusPath);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        recallReady: false,
        protectedMemoryClean: false,
      }),
    );
    expect(parsed.blockers).toContain("protected_repo_memory_dirty_or_unreadable");
  });

  it("keeps an empty system-memory lane explicit", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-system-memory-gate-"));
    const protectedStatusPath = await seedFile(workspaceDir, "protected-status.txt", "");

    const result = runCli(workspaceDir, protectedStatusPath);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        recallReady: false,
        recallClaimReady: false,
        moduleLearningClaimAllowed: false,
      }),
    );
    expect(parsed.blockers).toContain("system_memory_evidence_missing");
  });
});
