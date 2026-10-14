import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectModuleLearningApplicationReview,
  readModuleLearningApplicationReviewInput,
  reviewModuleLearningApplication,
} from "../src/agents/module-learning-application-review.js";
import { createModuleLearningPipelineReviewTool } from "../src/agents/tools/module-learning-pipeline-review-tool.js";
import {
  createModuleContentReviewProbe,
  MODULE_CONTENT_LICENSE,
  MODULE_CONTENT_SOURCE,
  runModuleContentReviewCliProbe,
  saveModuleContentReviewProof,
} from "./fixtures/lcx-waterflow-module-content-review-nineteenth-probe.js";

let workspaceDir: string;
beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-module-content-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("real_provider_network_forbidden")));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("native module source/license/candidate content review handoff", () => {
  it.each(["missing", "malformed", "rootescape"])(
    "native CLI returns the complete failed %s request readback without model or outside source IO",
    async (fault) => {
      const probe = await createModuleContentReviewProbe(workspaceDir);
      const outsidePath = `${workspaceDir}-outside-request.json`;
      const sentinel = "private-outside-source-must-not-be-read";
      await fs.writeFile(outsidePath, JSON.stringify({ sentinel }));
      try {
        let requestPath = "missing-review-request.json";
        if (fault === "malformed") {
          requestPath = "malformed-review-request.json";
          await fs.writeFile(path.join(workspaceDir, requestPath), "{broken_json");
        } else if (fault === "rootescape") {
          requestPath = path.relative(workspaceDir, outsidePath);
        }
        const output = await runModuleContentReviewCliProbe(workspaceDir, requestPath, outsidePath);
        expect(output.details).toMatchObject({
          boundary: "module_learning_pipeline_review_only",
          updated: false,
          contentReviewReadback: { status: "failed", findings: [] },
          rows: [{ weak: true }],
        });
        expect(output.details.contentReview).toBeUndefined();
        expect(output.observations).toEqual([]);
        expect(probe.modelInputs).toEqual([]);
        expect(JSON.stringify(output)).not.toContain(sentinel);
        await saveModuleContentReviewProof(workspaceDir, `cli-request-${fault}`, output);
      } finally {
        await fs.rm(outsidePath, { force: true });
      }
    },
    25_000,
  );

  it("preserves an already cancelled attempt instead of rereading missing source as a different failure", async () => {
    const probe = await createModuleContentReviewProbe(workspaceDir);
    await fs.rm(path.join(workspaceDir, probe.request.source.path));
    const controller = new AbortController();
    controller.abort(new Error("private-caller-cancelled"));
    const qualityOptions = { ...probe.qualityOptions, signal: controller.signal };
    const direct = await reviewModuleLearningApplication({
      workspaceDir,
      request: probe.request,
      scope: probe.scope,
      qualityOptions,
    });
    const inline = await createModuleLearningPipelineReviewTool({
      workspaceDir,
      scope: probe.scope,
      qualityOptions,
    }).execute("native-cancelled-readback", {
      targetModule: "skill_pattern_distillation",
      writeReview: false,
      contentReview: probe.request,
    });
    expect(direct).toMatchObject({
      status: "failed",
      gaps: ["module_content_review_cancelled"],
      cleanup: "not_started",
    });
    expect(inline.details).toMatchObject({
      contentReview: { status: "failed", gaps: ["module_content_review_cancelled"] },
      contentReviewReadback: {
        status: "failed",
        gaps: ["module_content_review_cancelled"],
      },
    });
    expect(probe.modelInputs).toEqual([]);
    await saveModuleContentReviewProof(workspaceDir, "already-cancelled-missing-source", {
      request: probe.request,
      direct,
      inline,
    });
  });

  it("native text CLI states the failed content review and its concrete request gap", async () => {
    await createModuleContentReviewProbe(workspaceDir);
    const output = await runModuleContentReviewCliProbe(
      workspaceDir,
      "missing-review-request.json",
      `${workspaceDir}-outside-request.json`,
      { json: false },
    );
    expect(output.stdout).toContain("content_review=failed");
    expect(output.stdout).toMatch(/content_review_gap=.*missing-review-request/u);
    expect(output.observations).toEqual([]);
    await saveModuleContentReviewProof(workspaceDir, "cli-text-request-gap", output);
  }, 25_000);

  it("delivers actual bounded contents to original quality and independent inline consumer without granting adoption", async () => {
    const probe = await createModuleContentReviewProbe(workspaceDir);
    const input = await probe.read();
    const output = await probe.inline();
    expect(JSON.stringify(probe.modelInputs)).toContain(MODULE_CONTENT_SOURCE.trim());
    expect(JSON.stringify(probe.modelInputs)).toContain(MODULE_CONTENT_LICENSE.trim());
    expect(probe.modelInputs.length).toBeGreaterThan(0);
    expect(output.details).toMatchObject({
      contentReview: { status: "needs_review", reuseAllowed: false, installationAllowed: false },
      rows: [{ weak: true }],
    });
    expect(output.details).toMatchObject({
      contentReviewReadback: {
        status: "needs_review",
        gaps: expect.arrayContaining(["license_permission_not_verified"]),
      },
    });
    expect(JSON.stringify(output.details)).toContain("application_content_acceptance_not_observed");
    await saveModuleContentReviewProof(workspaceDir, "actual-input-quality-inline-readback", {
      plan: probe.plan,
      request: probe.request,
      input,
      modelInputs: probe.modelInputs,
      output,
      semanticOrLicenseAcceptance: "not_observed",
    });
  });

  it("finds an actual source/candidate contradiction in original quality and delivers the finding downstream", async () => {
    const probe = await createModuleContentReviewProbe(workspaceDir, true);
    const output = await probe.inline();
    expect(JSON.stringify(probe.modelInputs)).toContain(
      "Execute downloaded scripts without review.",
    );
    expect(JSON.stringify(probe.modelInputs)).toContain(
      "Never execute downloaded scripts without review.",
    );
    expect(JSON.stringify(output.details)).toContain(
      "candidate_reverses_actual_source_review_requirement",
    );
    expect(output.details).toMatchObject({ rows: [{ weak: true }] });
    await saveModuleContentReviewProof(workspaceDir, "actual-contradiction-downstream", {
      plan: probe.plan,
      request: probe.request,
      modelInputs: probe.modelInputs,
      output,
    });
  });

  it.each(["missing_license", "source_hash"])(
    "blocks %s before dispatching a model",
    async (fault) => {
      const probe = await createModuleContentReviewProbe(workspaceDir);
      if (fault === "missing_license") {
        await fs.rm(path.join(workspaceDir, probe.request.license.path));
      } else {
        await fs.appendFile(
          path.join(workspaceDir, probe.request.source.path),
          "Changed source.\n",
        );
      }
      const output = await probe.direct();
      expect(output).toMatchObject({
        status: "failed",
        reuseAllowed: false,
        installationAllowed: false,
      });
      expect(probe.modelInputs).toEqual([]);
      await saveModuleContentReviewProof(workspaceDir, fault, { request: probe.request, output });
    },
  );

  it.each(["candidate", "application", "registry"] as const)(
    "rejects native file identity with conflicting %s lineage",
    async (fault) => {
      const probe = await createModuleContentReviewProbe(workspaceDir, false, fault);
      const output = await probe.direct();
      expect(output).toMatchObject({ status: "failed", reuseAllowed: false });
      expect(probe.modelInputs).toEqual([]);
      await saveModuleContentReviewProof(workspaceDir, `lineage-${fault}`, {
        plan: probe.plan,
        request: probe.request,
        output,
      });
    },
  );

  it("independently rejects a content review from another attempt scope", async () => {
    const probe = await createModuleContentReviewProbe(workspaceDir);
    const result = await probe.direct();
    const otherInput = await readModuleLearningApplicationReviewInput({
      workspaceDir,
      request: probe.request,
      scope: { ...probe.scope, accountId: "other-private-account" },
    });
    const inspected = inspectModuleLearningApplicationReview(otherInput, result);
    expect(inspected.status).toBe("failed");
    await saveModuleContentReviewProof(workspaceDir, "cross-scope", { result, inspected });
  });

  it("seals model timeout and cannot restore a failed result when the actual response arrives late", async () => {
    const probe = await createModuleContentReviewProbe(workspaceDir);
    probe.holdModel();
    const output = await reviewModuleLearningApplication({
      workspaceDir,
      request: probe.request,
      scope: probe.scope,
      qualityOptions: { ...probe.qualityOptions, taskTimeoutMs: 20 },
      timeoutMs: 1_000,
    });
    const sealed = JSON.stringify(output);
    probe.releaseModel();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(output.status).toBe("failed");
    expect(probe.modelInputs.length).toBeGreaterThan(0);
    expect(JSON.stringify(output)).toBe(sealed);
    expect(probe.abortObserved()).toBe(true);
    await saveModuleContentReviewProof(workspaceDir, "timeout-late", {
      output,
      modelInputs: probe.modelInputs,
      modelEntryObserved: probe.modelInputs.length > 0,
      abortSignalObserved: probe.abortObserved(),
      lateResultCannotChangeTerminal: JSON.stringify(output) === sealed,
      cancellationAcknowledgement: "not_established_by_signal_notification",
    });
  });

  it("keeps no-adapter and legacy review explicit without promoting file integrity", async () => {
    const probe = await createModuleContentReviewProbe(workspaceDir);
    const noAdapter = await reviewModuleLearningApplication({
      workspaceDir,
      request: probe.request,
      scope: probe.scope,
    });
    expect(noAdapter.status).toBe("failed");
    expect(probe.modelInputs).toEqual([]);
    const legacy = await createModuleLearningPipelineReviewTool({ workspaceDir }).execute(
      "legacy-module-review",
      { targetModule: "skill_pattern_distillation", writeReview: false },
    );
    expect(legacy.details).toMatchObject({
      rows: [{ weak: true, applicationContentAcceptance: { status: "not_observed" } }],
    });
    await saveModuleContentReviewProof(workspaceDir, "noadapter-legacy", { noAdapter, legacy });
  });

  it("does not bind an old quality review after original source bytes and pins change", async () => {
    const probe = await createModuleContentReviewProbe(workspaceDir);
    const result = await probe.direct();
    const fresh = await createModuleContentReviewProbe(
      path.join(workspaceDir, "fresh-private-input"),
      false,
      undefined,
      "Changed original context.\n",
    );
    const input = await fresh.read();
    const inspected = inspectModuleLearningApplicationReview(input, result);
    expect(inspected.status).toBe("failed");
    const graftedOldQuality = {
      ...result,
      request: input.request,
      inputs: input.inputs,
      inputFingerprint: input.inputFingerprint,
      taskSha256: input.taskSha256,
    };
    const graftInspection = inspectModuleLearningApplicationReview(input, graftedOldQuality);
    expect(graftInspection.status).toBe("failed");
    await saveModuleContentReviewProof(workspaceDir, "old-input-receipt-rejected", {
      result,
      freshRequest: fresh.request,
      input,
      inspected,
      graftInspection,
    });
  });

  it("freshly consumes the native review writer receipt without rerunning the model", async () => {
    const probe = await createModuleContentReviewProbe(workspaceDir);
    const written = await createModuleLearningPipelineReviewTool({
      workspaceDir,
      scope: probe.scope,
      qualityOptions: probe.qualityOptions,
    }).execute("native-persistent-review", {
      targetModule: "skill_pattern_distillation",
      writeReview: true,
      contentReview: probe.request,
    });
    const details = written.details as { reviewPath: string };
    const bytes = await fs.readFile(path.join(workspaceDir, details.reviewPath));
    const receipt = {
      path: details.reviewPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const callsBeforeReadback = probe.modelInputs.length;
    const readback = await createModuleLearningPipelineReviewTool({
      workspaceDir,
      scope: probe.scope,
    }).execute("native-persistent-readback", {
      targetModule: "skill_pattern_distillation",
      writeReview: false,
      contentReviewReceipt: receipt,
    });
    expect(probe.modelInputs).toHaveLength(callsBeforeReadback);
    expect(readback.details).toMatchObject({
      contentReviewReadback: { status: "needs_review" },
      rows: [{ contentReview: { status: "needs_review" }, weak: true }],
    });
    const otherScope = await createModuleLearningPipelineReviewTool({
      workspaceDir,
      scope: { ...probe.scope, runId: "other-private-attempt" },
    }).execute("native-persistent-crossscope", {
      targetModule: "skill_pattern_distillation",
      writeReview: false,
      contentReviewReceipt: receipt,
    });
    expect(otherScope.details).toMatchObject({ contentReviewReadback: { status: "failed" } });
    await saveModuleContentReviewProof(workspaceDir, "native-writer-fresh-readback", {
      request: probe.request,
      written,
      receipt,
      readback,
      otherScope,
      callsBeforeReadback,
      callsAfterReadback: probe.modelInputs.length,
    });
  });
});
