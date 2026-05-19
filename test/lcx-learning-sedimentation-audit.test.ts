import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

async function runAudit(workspaceDir: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/dev/lcx-learning-sedimentation-audit.ts",
      "--workspace",
      workspaceDir,
      "--json",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    boundary: string;
    assessment: string;
    sufficientForCurrentUse: boolean;
    chains: {
      financeLearning: { ok: boolean; researchSources: number; applyReceipts: number };
      brainDistillation: { ok: boolean; reviewFiles: number; acceptedCandidates: number };
      reviewPanel: { ok: boolean; receiptFiles: number };
      correctionAndDownrank: { ok: boolean; correctionNotes: number; learningCouncilNotes: number };
      moduleLearningPipeline: {
        ok: boolean;
        planReceipts: number;
        reviewFiles: number;
        evalAbsorbed: number;
        weakModuleLearning: number;
        cumulativeWeakModuleLearning?: number;
        latestReview?: {
          path: string;
          evalAbsorbed: number;
          weakModuleLearning: number;
          applicationReady: number;
        };
      };
    };
    gaps: Array<{ id: string; severity: string }>;
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
}

async function runAuditText(workspaceDir: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/dev/lcx-learning-sedimentation-audit.ts",
      "--workspace",
      workspaceDir,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );
  return stdout;
}

async function seedGeneralLearningEvidence(workspaceDir: string): Promise<void> {
  const memoryDir = path.join(workspaceDir, "memory");
  await writeText(path.join(memoryDir, "research-sources", "source.md"), "source");
  await writeText(
    path.join(memoryDir, "local-memory", "finance-learning-capability-candidates.md"),
    "capability",
  );
  await writeJson(path.join(memoryDir, "finance-learning-retrieval-receipts", "day", "r.json"), {
    ok: true,
  });
  await writeJson(path.join(memoryDir, "finance-learning-retrieval-reviews", "day.json"), {
    ok: true,
  });
  await writeJson(path.join(memoryDir, "finance-learning-apply-usage-receipts", "day", "a.json"), {
    ok: true,
  });
  await writeJson(path.join(memoryDir, "finance-learning-apply-usage-reviews", "day.json"), {
    ok: true,
  });
  await writeJson(path.join(memoryDir, "lark-brain-distillation-reviews", "day", "b.json"), {
    acceptedCandidates: [
      {
        boundary: "brain_distillation_candidate",
        status: "accepted_brain_plan",
        review: { accepted: true },
      },
    ],
  });
  await writeJson(path.join(memoryDir, "review-panel-receipts", "day", "p.json"), {
    ok: true,
  });
  await writeText(path.join(memoryDir, "2026-05-14-correction-note-test.md"), "correction");
}

describe("LCX learning sedimentation audit", () => {
  it("recognizes usable non-module learning sedimentation while preserving the module certification gap", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-audit-"));
    await seedGeneralLearningEvidence(workspaceDir);

    const payload = await runAudit(workspaceDir);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_learning_sedimentation_audit_only",
        assessment: "usable_but_module_specific_certification_gap",
        sufficientForCurrentUse: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.chains.financeLearning).toEqual(
      expect.objectContaining({ ok: true, researchSources: 1, applyReceipts: 1 }),
    );
    expect(payload.chains.brainDistillation).toEqual(
      expect.objectContaining({ ok: true, reviewFiles: 1, acceptedCandidates: 1 }),
    );
    expect(payload.chains.reviewPanel).toEqual(
      expect.objectContaining({ ok: true, receiptFiles: 1 }),
    );
    expect(payload.chains.correctionAndDownrank).toEqual(
      expect.objectContaining({ ok: true, correctionNotes: 1 }),
    );
    expect(payload.chains.moduleLearningPipeline).toEqual(
      expect.objectContaining({ ok: false, planReceipts: 0, reviewFiles: 0, evalAbsorbed: 0 }),
    );
    expect(payload.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "module_learning_pipeline_has_no_plan_receipts" }),
        expect.objectContaining({ id: "module_learning_pipeline_has_no_reviews" }),
      ]),
    );
  });

  it("marks the chain module-certifiable when module plan and review receipts exist too", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-audit-"));
    await seedGeneralLearningEvidence(workspaceDir);
    const memoryDir = path.join(workspaceDir, "memory");
    await writeJson(
      path.join(memoryDir, "module-learning-pipeline-plan-receipts", "day", "m.json"),
      {
        ok: true,
      },
    );
    await writeJson(path.join(memoryDir, "module-learning-pipeline-reviews", "day.json"), {
      counts: {
        evalAbsorbed: 1,
        weakModuleLearning: 0,
        boundaryViolations: 0,
      },
    });

    const payload = await runAudit(workspaceDir);

    expect(payload.assessment).toBe("usable_and_module_certifiable");
    expect(payload.sufficientForCurrentUse).toBe(true);
    expect(payload.chains.moduleLearningPipeline).toEqual(
      expect.objectContaining({ ok: true, planReceipts: 1, reviewFiles: 1, evalAbsorbed: 1 }),
    );
    expect(payload.chains.moduleLearningPipeline.latestReview).toEqual(
      expect.objectContaining({
        path: "memory/module-learning-pipeline-reviews/day.json",
        evalAbsorbed: 1,
        weakModuleLearning: 0,
      }),
    );
    expect(payload.gaps.map((gap) => gap.id)).not.toContain(
      "module_learning_pipeline_has_no_plan_receipts",
    );
    expect(payload.gaps.map((gap) => gap.id)).not.toContain(
      "module_learning_pipeline_has_no_reviews",
    );
  });

  it("does not call the module pipeline certifiable when weak receipts remain", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-audit-"));
    await seedGeneralLearningEvidence(workspaceDir);
    const memoryDir = path.join(workspaceDir, "memory");
    await writeJson(
      path.join(memoryDir, "module-learning-pipeline-plan-receipts", "day", "m.json"),
      {
        ok: true,
      },
    );
    await writeJson(path.join(memoryDir, "module-learning-pipeline-reviews", "day.json"), {
      counts: {
        evalAbsorbed: 1,
        weakModuleLearning: 1,
        boundaryViolations: 0,
      },
    });

    const payload = await runAudit(workspaceDir);

    expect(payload.assessment).toBe("usable_with_partial_module_absorption_but_weak_receipts");
    expect(payload.chains.moduleLearningPipeline).toEqual(
      expect.objectContaining({
        ok: false,
        planReceipts: 1,
        reviewFiles: 1,
        evalAbsorbed: 1,
        weakModuleLearning: 1,
      }),
    );
    expect(payload.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "module_learning_review_has_weak_receipts" }),
      ]),
    );
  });

  it("does not let superseded historical weak reviews block a clean latest module review", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-audit-"));
    await seedGeneralLearningEvidence(workspaceDir);
    const memoryDir = path.join(workspaceDir, "memory");
    await writeJson(
      path.join(memoryDir, "module-learning-pipeline-plan-receipts", "day", "m.json"),
      {
        ok: true,
      },
    );
    await writeJson(path.join(memoryDir, "module-learning-pipeline-reviews", "2026-05-18.json"), {
      counts: {
        evalAbsorbed: 0,
        weakModuleLearning: 2,
        boundaryViolations: 0,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeJson(path.join(memoryDir, "module-learning-pipeline-reviews", "2026-05-19.json"), {
      counts: {
        evalAbsorbed: 2,
        weakModuleLearning: 0,
        boundaryViolations: 0,
      },
    });

    const payload = await runAudit(workspaceDir);

    expect(payload.assessment).toBe("usable_and_module_certifiable");
    expect(payload.chains.moduleLearningPipeline).toEqual(
      expect.objectContaining({
        ok: true,
        evalAbsorbed: 2,
        weakModuleLearning: 0,
        cumulativeWeakModuleLearning: 2,
      }),
    );
    expect(payload.gaps.map((gap) => gap.id)).not.toContain(
      "module_learning_review_has_weak_receipts",
    );
  });

  it("shows weak module receipts in the text summary", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-audit-"));
    await seedGeneralLearningEvidence(workspaceDir);
    const memoryDir = path.join(workspaceDir, "memory");
    await writeJson(
      path.join(memoryDir, "module-learning-pipeline-plan-receipts", "day", "m.json"),
      {
        ok: true,
      },
    );
    await writeJson(path.join(memoryDir, "module-learning-pipeline-reviews", "day.json"), {
      counts: {
        evalAbsorbed: 1,
        weakModuleLearning: 2,
        boundaryViolations: 0,
      },
    });

    const output = await runAuditText(workspaceDir);

    expect(output).toContain("module_eval_absorbed=1");
    expect(output).toContain("module_weak_receipts=2");
    expect(output).toContain(
      "module_latest_review=memory/module-learning-pipeline-reviews/day.json",
    );
    expect(output).toContain("module_latest_review_eval_absorbed=1");
    expect(output).toContain("module_latest_review_weak_receipts=2");
    expect(output).toContain("module_learning_review_has_weak_receipts");
  });

  it("does not call module learning certifiable when reviews have no eval absorption", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-audit-"));
    await seedGeneralLearningEvidence(workspaceDir);
    const memoryDir = path.join(workspaceDir, "memory");
    await writeJson(
      path.join(memoryDir, "module-learning-pipeline-plan-receipts", "day", "m.json"),
      {
        ok: true,
      },
    );
    await writeJson(path.join(memoryDir, "module-learning-pipeline-reviews", "day.json"), {
      counts: {
        evalAbsorbed: 0,
        weakModuleLearning: 1,
        boundaryViolations: 0,
      },
    });

    const payload = await runAudit(workspaceDir);

    expect(payload.assessment).toBe("usable_with_module_review_but_no_eval_absorption");
    expect(payload.sufficientForCurrentUse).toBe(true);
    expect(payload.chains.moduleLearningPipeline).toEqual(
      expect.objectContaining({
        ok: false,
        planReceipts: 1,
        reviewFiles: 1,
        evalAbsorbed: 0,
        weakModuleLearning: 1,
      }),
    );
    expect(payload.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "module_learning_review_has_no_eval_absorbed_receipts" }),
      ]),
    );
  });

  it("does not mark learning sufficient when review-panel arbitration is missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-audit-"));
    const memoryDir = path.join(workspaceDir, "memory");
    await writeText(path.join(memoryDir, "research-sources", "source.md"), "source");
    await writeText(
      path.join(memoryDir, "local-memory", "finance-learning-capability-candidates.md"),
      "capability",
    );
    await writeJson(path.join(memoryDir, "finance-learning-retrieval-receipts", "day", "r.json"), {
      ok: true,
    });
    await writeJson(
      path.join(memoryDir, "finance-learning-apply-usage-receipts", "day", "a.json"),
      {
        ok: true,
      },
    );
    await writeJson(path.join(memoryDir, "lark-brain-distillation-reviews", "day", "b.json"), {
      acceptedCandidates: [
        {
          boundary: "brain_distillation_candidate",
          status: "accepted_brain_plan",
          review: { accepted: true },
        },
      ],
    });

    const payload = await runAudit(workspaceDir);

    expect(payload.assessment).toBe("insufficient_learning_sedimentation_evidence");
    expect(payload.sufficientForCurrentUse).toBe(false);
    expect(payload.chains.reviewPanel.ok).toBe(false);
    expect(payload.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "review_panel_receipts_missing" })]),
    );
  });

  it("does not call an empty workspace sedimented", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-learning-audit-"));

    const payload = await runAudit(workspaceDir);

    expect(payload.assessment).toBe("insufficient_learning_sedimentation_evidence");
    expect(payload.sufficientForCurrentUse).toBe(false);
    expect(payload.chains.financeLearning.ok).toBe(false);
    expect(payload.chains.brainDistillation.ok).toBe(false);
  });
});
