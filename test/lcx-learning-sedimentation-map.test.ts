import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/dev/lcx-learning-sedimentation-map.ts");

async function seedFile(workspaceDir: string, relativePath: string, body = "x") {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, body, "utf8");
  return absolutePath;
}

async function seedJson(workspaceDir: string, relativePath: string, payload: unknown) {
  return seedFile(workspaceDir, relativePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function runCli(workspaceDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--workspace", workspaceDir, "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function lane(parsed: Record<string, unknown>, id: string): Record<string, unknown> {
  const lanes = parsed.lanes as Array<Record<string, unknown>>;
  const found = lanes.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`missing lane ${id}`);
  }
  return found;
}

describe("lcx-learning-sedimentation-map", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("separates finance source learning, module learning, system memory, training material, and language boundary", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sedimentation-map-"));
    await seedFile(workspaceDir, "memory/research-sources/options.md", "source");
    await seedFile(
      workspaceDir,
      "memory/local-memory/finance-learning-capability-candidates.md",
      "capability",
    );
    await seedJson(workspaceDir, "memory/finance-learning-retrieval-receipts/2026-05-14/r.json", {
      boundary: "finance_learning_retrieval_receipt",
    });
    await seedJson(workspaceDir, "memory/finance-learning-apply-usage-receipts/2026-05-14/a.json", {
      boundary: "finance_learning_capability_apply_usage_receipt",
      ok: true,
    });
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-14/m.json",
      { boundary: "dev_module_learning_pipeline_plan", status: "application_ready" },
    );
    await seedJson(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json", {
      counts: {
        applicationReady: 1,
        evalAbsorbed: 0,
        weakModuleLearning: 1,
        boundaryViolations: 0,
      },
    });
    await seedJson(workspaceDir, "memory/lark-brain-distillation-reviews/review.json", {
      acceptedCandidates: [
        {
          boundary: "brain_distillation_candidate",
          status: "accepted_brain_plan",
          review: { accepted: true },
        },
      ],
    });
    await seedFile(workspaceDir, "memory/2026-05-14-correction-note-test.md", "note");
    await seedJson(workspaceDir, "memory/review-panel-receipts/r.json", { ok: true });
    await seedJson(workspaceDir, "state/lcx-local-operator-latest.json", { ok: true });

    const result = runCli(workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_learning_sedimentation_map_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        languageCorpusTouched: false,
      }),
    );
    expect(parsed.summary).toEqual(
      expect.objectContaining({
        laneCount: 7,
        moduleAbsorptionReady: false,
        sourceCapabilityPresent: true,
        systemMemoryPresent: true,
        trainingMaterialPresent: true,
        languageCorpusSeparated: true,
      }),
    );
    expect(lane(parsed, "finance_source_capability_sedimentation").status).toBe(
      "source_to_apply_usable",
    );
    expect(lane(parsed, "local_module_learning_sedimentation")).toEqual(
      expect.objectContaining({
        status: "reviewable_not_absorbed",
      }),
    );
    expect(lane(parsed, "brain_distillation_training_material").status).toBe(
      "accepted_training_material_available",
    );
    expect(lane(parsed, "system_memory_correction_sedimentation").status).toBe(
      "system_memory_present",
    );
    expect(lane(parsed, "language_routing_corpus_boundary")).toEqual(
      expect.objectContaining({
        status: "separate_boundary_enforced",
      }),
    );
  });

  it("keeps partial eval absorption separate from clean module absorption", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sedimentation-map-"));
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-14/m.json",
      { boundary: "dev_module_learning_pipeline_plan", status: "eval_absorbed" },
    );
    await seedJson(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json", {
      counts: {
        applicationReady: 1,
        evalAbsorbed: 1,
        weakModuleLearning: 1,
        boundaryViolations: 0,
      },
    });

    const result = runCli(workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed.summary).toEqual(
      expect.objectContaining({
        moduleAbsorptionReady: false,
      }),
    );
    expect(lane(parsed, "local_module_learning_sedimentation")).toEqual(
      expect.objectContaining({
        status: "partial_eval_absorption_with_weak_receipts",
      }),
    );
  });

  it("blocks module absorption when review boundary violations remain", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sedimentation-map-"));
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-14/m.json",
      { boundary: "dev_module_learning_pipeline_plan", status: "eval_absorbed" },
    );
    await seedJson(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-14.json", {
      counts: {
        applicationReady: 0,
        evalAbsorbed: 1,
        weakModuleLearning: 0,
        boundaryViolations: 1,
      },
    });

    const result = runCli(workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed.summary).toEqual(
      expect.objectContaining({
        moduleAbsorptionReady: false,
      }),
    );
    expect(lane(parsed, "local_module_learning_sedimentation")).toEqual(
      expect.objectContaining({
        status: "boundary_violation_blocks_absorption",
      }),
    );
  });

  it("does not call source or system memory evidence module absorption", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sedimentation-map-"));
    await seedFile(workspaceDir, "memory/research-sources/source.md", "source");
    await seedFile(workspaceDir, "memory/local-memory/lesson.md", "lesson");

    const result = runCli(workspaceDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(parsed.summary).toEqual(
      expect.objectContaining({
        moduleAbsorptionReady: false,
        systemMemoryPresent: true,
      }),
    );
    expect(lane(parsed, "local_module_learning_sedimentation").status).toBe("missing_evidence");
    expect(parsed.riskyConflations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "source_to_apply_usable_does_not_equal_module_eval_absorbed",
        }),
        expect.objectContaining({
          rule: "system_memory_recall_does_not_equal_module_learning",
        }),
      ]),
    );
  });
});
