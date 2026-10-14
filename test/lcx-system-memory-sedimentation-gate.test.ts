import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
} from "../scripts/operator/lcx-self-repair-hands.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/operator/lcx-system-memory-sedimentation-gate.ts");

async function seedFile(workspaceDir: string, relativePath: string, body = "x") {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, body, "utf8");
  return absolutePath;
}

function runCli(workspaceDir: string, protectedStatusPath: string, extraArgs: string[] = []) {
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
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

async function writeOriginalCorrection(workspaceDir: string) {
  const receipt = buildSelfRepairHandsReceipt({
    checkedAt: new Date().toISOString(),
    workspaceDir,
    signalKey: "offline_native_correction_handoff",
    issue: "offline_fixture_recall_gap",
    observedFailure: "original correction was absent from subsequent recall inventory",
    replacementRule: "retrieve the provisional correction and recheck original source evidence",
    domain: "offline_fixture",
    write: true,
  });
  await writeSelfRepairHandsReceipt(receipt);
  return receipt;
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

  it.each(["missing", "directory"] as const)(
    "blocks recall when declared protected-state evidence is %s instead of treating it as clean",
    async (fault) => {
      workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-system-memory-gate-"));
      const memoryPath = await seedFile(workspaceDir, "memory/local-memory/lesson.md", "lesson");
      const protectedStatusPath = path.join(workspaceDir, "protected-status.txt");
      if (fault === "directory") {
        await fs.mkdir(protectedStatusPath);
      }
      const result = runCli(workspaceDir, protectedStatusPath);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        status: "blocked",
        protectedMemoryClean: false,
        recallReady: false,
        recallClaimReady: false,
        protectedStatus: ["protected_status_evidence_unreadable"],
        protectedMemoryTouched: false,
        moduleLearningClaimAllowed: false,
      });
      expect(parsed.blockers).toContain("protected_repo_memory_dirty_or_unreadable");
      expect(parsed.claimBoundaries.canClaim).not.toContain("system_memory_recall_ready");
      expect(await fs.readFile(memoryPath, "utf8")).toBe("lesson");
      expect(result.stdout).not.toContain(protectedStatusPath);
    },
  );

  it("discovers the actual original self-repair correction without claiming learning or rewriting it", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "original-correction-recall-"));
    const receipt = await writeOriginalCorrection(workspaceDir);
    const notePath = receipt.hands.memoryCleaner.path;
    const noteBefore = await fs.readFile(notePath);
    const protectedStatusPath = await seedFile(workspaceDir, "protected-status.txt", "");
    const result = runCli(workspaceDir, protectedStatusPath);
    expect(result.status).toBe(0);
    const gate = JSON.parse(result.stdout);
    expect(gate).toMatchObject({
      recallReady: true,
      recallClaimReady: true,
      counts: { localMemoryFiles: 0, correctionNotes: 1, systemMemoryFiles: 1 },
      latestSystemMemory: {
        path: path.relative(workspaceDir, notePath).split(path.sep).join("/"),
      },
      moduleLearningClaimAllowed: false,
      protectedMemoryTouched: false,
    });
    expect(noteBefore.toString()).toContain("memoryTier: provisional_downrank");
    expect(noteBefore.toString()).toContain("Required Proof Before Reuse");
    expect(await fs.readFile(notePath)).toEqual(noteBefore);
  });

  it("does not substitute training or patch candidates for a missing original correction", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "original-correction-missing-"));
    const receipt = await writeOriginalCorrection(workspaceDir);
    await fs.unlink(receipt.hands.memoryCleaner.path);
    const protectedStatusPath = await seedFile(workspaceDir, "protected-status.txt", "");
    const result = runCli(workspaceDir, protectedStatusPath);
    const gate = JSON.parse(result.stdout);
    expect(gate).toMatchObject({
      status: "blocked",
      recallReady: false,
      counts: { correctionNotes: 0, systemMemoryFiles: 0 },
    });
    expect(gate.blockers).toContain("system_memory_evidence_missing");
    expect(await fs.stat(receipt.hands.trainingCaseBuilder.path)).toBeDefined();
    expect(await fs.stat(receipt.hands.patchCandidateBuilder.path)).toBeDefined();
  });

  it.each(["missing", "dirty"] as const)(
    "still blocks native correction recall when protected status is %s",
    async (fault) => {
      workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "original-correction-block-"));
      await writeOriginalCorrection(workspaceDir);
      const protectedStatusPath = path.join(workspaceDir, "protected-status.txt");
      if (fault === "dirty") {
        await fs.writeFile(protectedStatusPath, " M memory/current-research-line.md\n");
      }
      const gate = JSON.parse(runCli(workspaceDir, protectedStatusPath).stdout);
      expect(gate).toMatchObject({
        status: "blocked",
        counts: { correctionNotes: 1 },
        recallReady: false,
        protectedMemoryClean: false,
        moduleLearningClaimAllowed: false,
      });
      expect(gate.blockers).toContain("protected_repo_memory_dirty_or_unreadable");
    },
  );

  it.each(["missing_host_scope", "manifest_missing", "invalid_manifest", "path_alias"] as const)(
    "keeps an explicitly requested correction review blocked for %s",
    async (fault) => {
      workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "original-review-scope-"));
      const writer = await writeOriginalCorrection(workspaceDir);
      const protectedStatus = await seedFile(workspaceDir, "protected-status.txt", "");
      const manifestPath = path.join(workspaceDir, "state", "review.json");
      if (fault === "invalid_manifest") {
        await fs.writeFile(manifestPath, "null");
      } else if (fault !== "manifest_missing") {
        await fs.writeFile(
          manifestPath,
          JSON.stringify({
            schemaVersion: 1,
            correction: {
              path:
                fault === "path_alias"
                  ? "../correction.md"
                  : writer.hands.memoryCleaner.relativePath,
              sha256: "0".repeat(64),
            },
            source: { path: "state/source.json", sha256: "0".repeat(64) },
          }),
        );
      }
      const args = [
        "--correction-review",
        manifestPath,
        ...(fault === "missing_host_scope"
          ? []
          : ["--review-account-id", "paper", "--review-run-id", "run"]),
      ];
      const cli = runCli(workspaceDir, protectedStatus, args);
      expect(cli.status).toBe(0);
      const gate = JSON.parse(cli.stdout);
      const reason =
        fault === "missing_host_scope"
          ? "correction_review_host_scope_missing"
          : fault === "path_alias"
            ? "correction_path_outside_original_owner"
            : "correction_review_manifest_unreadable";
      expect(gate).toMatchObject({
        status: "blocked",
        recallReady: false,
        recallClaimReady: false,
        correctionReview: { status: "blocked", blockers: [reason], reuseAllowed: false },
      });
      expect(gate.claimBoundaries.canClaim).not.toContain("system_memory_recall_claim_ready");
      expect(gate.claimBoundaries.canClaim).not.toContain("system_memory_recall_ready");
      expect(await fs.readFile(writer.hands.memoryCleaner.path, "utf8")).toContain(
        "provisional_downrank",
      );
    },
  );
});
