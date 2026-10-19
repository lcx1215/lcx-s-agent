import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadOriginalTrainingChildOwners,
  preserveTrainingScope,
  trainingScopeOptions,
  trainingScopeRepo,
  probeOriginalTrainingTail,
} from "./fixtures/lcx-waterflow-training-child-scope-probe.js";
import { originalTeacherReadFailure } from "./fixtures/lcx-waterflow-training-feedback-probe.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-child-scope-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden")));
});
afterEach(async () => {
  const retained = process.env.LCX_TRAINING_SCOPE_PROOF_DIR;
  if (!retained || !root.startsWith(path.resolve(retained) + path.sep)) {
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});
const sourcePath = path.join(trainingScopeRepo, "scripts/operator/minimax-brain-training-guard.ts");
async function saveProof(name: string, proof: unknown) {
  if (!process.env.LCX_TRAINING_SCOPE_PROOF_DIR) {
    return;
  }
  const destination = path.join(process.env.LCX_TRAINING_SCOPE_PROOF_DIR, name);
  await preserveTrainingScope(root, destination);
  await fs.writeFile(
    path.join(destination, "owner-chain.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
}

describe("original training guard child scope", () => {
  it("consumes fresh senior failure subprocess bytes in the original guard promotion and cooldown branch", async () => {
    const retained = process.env.LCX_TRAINING_SCOPE_PROOF_DIR;
    if (retained) {
      await fs.mkdir(retained, { recursive: true });
      await fs.rm(root, { recursive: true, force: true });
      root = await fs.mkdtemp(path.join(path.resolve(retained), "senior-native-private-"));
    }
    const proof = await probeOriginalTrainingTail(root, undefined, {
      guardRounds: 2,
      seniorFailure: true,
    });
    const evalIo = proof.invocations.filter(
      (row) => row.args[2] === "scripts/operator/local-brain-distill-eval.ts",
    );
    const evalReads = proof.receipts.filter(
      (row) =>
        row.name === "candidate_hardened_eval" &&
        row.command === "node" &&
        Array.isArray(row.args) &&
        row.args[2] === "scripts/operator/local-brain-distill-eval.ts",
    );
    await saveProof("senior-failure-original-guard", {
      ...proof,
      wholeSceneClosed: false,
      seniorBoundary:
        "actual_guard_entry_and_parser_consumption_of_new_scripted_subprocess_schema_not_actual_eval_or_model_inference; source_and_learning_prerequisites_unobserved; minimum_eval_case_count_gate_also_applies",
    });
    expect(evalIo).toHaveLength(2);
    expect(evalReads).toHaveLength(2);
    for (const [index, io] of evalIo.entries()) {
      expect(io.args).toContain("--hardened");
      expect(io.args).not.toContain("--case-id");
      expect(io.boundary).toBe(
        "synthetic_eval_subprocess_stdout_no_original_evaluator_or_model_execution",
      );
      expect(io.exitCode).toBe(1);
      const parsed = JSON.parse(io.stdout ?? "");
      expect(parsed.summary).toMatchObject({
        failedCaseIds: ["senior_trader_failure_focus_promotion_chain"],
        promotionReady: false,
      });
      expect(evalReads[index]).toMatchObject({
        event: "step_non_passing",
        result: parsed,
        resultSha256: createHash("sha256").update(JSON.stringify(parsed)).digest("hex"),
      });
    }
    expect(
      proof.receipts.filter((row) => row.event === "adapter_rejected_for_guard_session"),
    ).toHaveLength(2);
    expect(proof.receipts.some((row) => row.event === "adapter_promoted_for_guard_session")).toBe(
      false,
    );
    expect(
      proof.receipts.find((row) => row.event === "evolution_cooldown_completed"),
    ).toMatchObject({ round: 1 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 60000);

  it("consumes the rejected first round in the original next quota caller and rejects late second-round eval through original deadline", async () => {
    const proof = await probeOriginalTrainingTail(root, "eval_timeout", { guardRounds: 2 });
    expect(proof.quotaRuns).toHaveLength(2);
    const cooldownCompleted = proof.receipts.find(
      (row) => row.event === "evolution_cooldown_completed" && row.round === 1,
    );
    expect(cooldownCompleted).toMatchObject({
      callerRef: proof.caller.caller,
      durationMs: 6,
    });
    const secondDispatchRows = proof.quotaRuns[1].invocation.guardLogInput?.raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(secondDispatchRows).toContainEqual(cooldownCompleted);
    for (const run of proof.quotaRuns) {
      expect(run.output).toMatchObject({ status: "complete", attempted: 2 });
      const teacher = run.teacher as {
        promptReadback: {
          status: string;
          callerRef: unknown;
          source: { observedFileSha256: string; pointer: string; lineSha256: string };
        };
      };
      expect(teacher.promptReadback).toMatchObject({
        status: "read",
        callerRef: proof.caller.caller,
      });
      expect(run.invocation.args[run.invocation.args.indexOf("--caller-receipt") + 1]).toBe(
        JSON.stringify(proof.caller.caller),
      );
      expect(teacher.promptReadback.source.observedFileSha256).toBe(
        run.invocation.guardLogInput?.sha256,
      );
    }
    const eval1 = proof.receipts.find(
      (row) => row.name === "candidate_hardened_eval" && row.round === 1,
    );
    const deny1 = proof.receipts.find(
      (row) => row.event === "adapter_rejected_for_guard_session" && row.round === 1,
    );
    const cool1 = proof.receipts.find(
      (row) => row.event === "evolution_cooldown" && row.round === 1,
    );
    expect(deny1).toMatchObject({
      candidateEvalSha256: eval1?.resultSha256,
      candidateEvalPromotionReady: false,
    });
    expect(cool1).toMatchObject({
      upstreamDecision: {
        candidateEvalSha256: deny1?.candidateEvalSha256,
        outcome: "rejected",
        reason: "candidate_eval_not_promotion_ready",
      },
    });
    const secondTeacher = proof.quotaRuns[1].teacher as {
      promptReadback: { source: { pointer: string; lineSha256: string } };
    };
    const readLines = proof.quotaRuns[1].invocation.guardLogInput?.raw.trim().split("\n");
    const selectedIndex = Number(secondTeacher.promptReadback.source.pointer.slice(5)) - 1;
    const selectedLine = readLines?.[selectedIndex];
    if (!selectedLine) {
      throw new Error("Original selected eval line not retained");
    }
    expect(JSON.parse(selectedLine)).toEqual(eval1);
    expect(createHash("sha256").update(selectedLine).digest("hex")).toBe(
      secondTeacher.promptReadback.source.lineSha256,
    );
    const eval2 = proof.receipts.findLast(
      (row) => row.name === "candidate_hardened_eval" && row.round === 2,
    );
    expect(eval2).toMatchObject({
      event: "step_timeout",
      result: { timedOut: true, summary: { total: 0, promotionReady: false } },
    });
    expect(
      proof.receipts.filter((row) => row.event === "adapter_rejected_for_guard_session"),
    ).toHaveLength(2);
    expect(proof.receipts.some((row) => row.event === "adapter_promoted_for_guard_session")).toBe(
      false,
    );
    expect(proof.receipts.find((row) => row.event === "guard_complete")).toMatchObject({
      rounds: 2,
    });
    expect(proof.clockEvents).toEqual([{ round: 2, offsetMs: 60000 }]);
    const late = proof.invocations.find((row) => row.lateClose);
    expect(late).toMatchObject({ kills: ["SIGTERM"], localTransportClosed: true });
    const resolver = proof.promotionAudit.resolverFailureOutput as {
      ok: boolean;
      status: string;
      sourceReads: {
        reads: Array<{ path: string; sha256: string; bytes: number; status: string }>;
      };
    };
    expect(resolver).toMatchObject({ ok: false, status: "blocked" });
    expect(resolver.sourceReads.reads).toContainEqual(
      expect.objectContaining({
        status: "read",
        path: proof.options.logPath,
        sha256: proof.guardLog.sha256,
        bytes: Buffer.byteLength(proof.guardLog.raw),
      }),
    );
    for (const negative of proof.promotionAudit.negativeResolverReads) {
      expect(negative.result).toMatchObject({ ok: false });
      expect(negative.result).toHaveProperty("failureReceipt", undefined);
      expect(negative.result).toHaveProperty(
        "failureReceiptGap",
        negative.kind === "missing_stdout"
          ? "failure_stdout_unavailable"
          : negative.kind === "non_json"
            ? "failure_stdout_unreadable"
            : "failure_stdout_exceeds_12kb",
      );
    }
    const teacherRow = proof.quotaRuns[1].receipts.find(
      (row) => row.name === "minimax_teacher_batch",
    );
    const args = teacherRow?.args as string[];
    const prompt = args[args.indexOf("--prompt-file") + 1];
    const handoff = JSON.parse(args[args.indexOf("--prompt-handoff") + 1]) as {
      path: string;
      sha256: string;
    };
    const badHash = await originalTeacherReadFailure(root, proof.caller.caller, prompt, {
      ...handoff,
      sha256: "0".repeat(64),
    });
    const missing = await originalTeacherReadFailure(
      root,
      proof.caller.caller,
      path.join(root, "missing-whole-prompt.json"),
      handoff,
    );
    expect(badHash).toMatchObject({ ok: false, status: "blocked", acceptedCandidates: 0 });
    expect(missing).toMatchObject({ ok: false, status: "blocked", acceptedCandidates: 0 });
    await saveProof("whole-guard-two-rounds", {
      ...proof,
      sourceNegatives: { badHash, missing },
      cleanupBoundary:
        "only_local_transport_task_and_streams_confirmed_no_external_process_tree_claim",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 60000);
  it("runs the original complete quota loop into the same tail and independent promotion audit without paid workers", async () => {
    const proof = await probeOriginalTrainingTail(root, undefined, { fullQuota: true });
    expect(proof.quota?.output).toMatchObject({
      ok: true,
      status: "complete",
      attempted: 2,
      completedRounds: 1,
    });
    const teacherIo = proof.quota?.io.filter((row) =>
      row.originalArgs[2].endsWith("teacher-batch.ts"),
    );
    expect(teacherIo).toHaveLength(1);
    expect(teacherIo?.[0].actualArgs).toEqual(teacherIo?.[0].originalArgs);
    expect(teacherIo?.[0].actualArgs).toContain("--mock");
    const teacher = proof.teacher as {
      reviewPath: string;
      promptReadback: { status: string; callerRef: unknown; prompt: { sha256: string } };
    };
    expect(teacher.promptReadback).toMatchObject({
      status: "read",
      callerRef: proof.caller.caller,
    });
    expect(teacherIo?.[0].prompt?.sha256).toBe(teacher.promptReadback.prompt.sha256);
    expect(proof.quota?.io.map((row) => row.originalArgs[2])).toEqual([
      "scripts/operator/minimax-brain-teacher-batch.ts",
      "scripts/operator/local-brain-distill-dataset.ts",
      "scripts/operator/local-brain-distill-smoke.ts",
    ]);
    expect(proof.invocations.some((row) => row.args[2]?.endsWith("teacher-batch.ts"))).toBe(false);
    expect(proof.smoke).toMatchObject({ ok: true });
    const dataset = proof.dataset as {
      sourceReads: {
        readCount: number;
        pins: Array<{ path: string; sha256: string; bytes: number }>;
        omittedCount: number;
      };
    };
    expect(
      dataset.sourceReads.pins.find((read) => read.path === proof.teacherReviewReadback.path),
    ).toEqual({
      path: proof.teacherReviewReadback.path,
      sha256: proof.teacherReviewReadback.sha256,
      bytes: proof.teacherReviewReadback.bytes,
    });
    expect(dataset.sourceReads.omittedCount).toBe(0);
    const evaluated = proof.receipts.findLast(
      (row) => row.name === "candidate_hardened_eval" && row.round === 2,
    );
    const rejected = proof.receipts.find(
      (row) => row.event === "adapter_rejected_for_guard_session",
    );
    const evaluationText = JSON.stringify(proof.candidateEval);
    if (evaluationText === undefined) {
      throw new Error("Actual evaluation input was not observed");
    }
    const actualEvalSha = createHash("sha256").update(evaluationText).digest("hex");
    expect(evaluated?.resultSha256).toBe(actualEvalSha);
    expect(rejected).toMatchObject({
      candidateEvalSha256: actualEvalSha,
      candidateEvalPromotionReady: false,
      promotionBlockedByDatasetShrink: false,
      rejectionReason: "candidate_eval_not_promotion_ready",
    });
    expect(proof.candidateEval).toMatchObject({ summary: { promotionReady: false } });
    expect(proof.receipts.some((row) => row.event === "adapter_rejected_for_guard_session")).toBe(
      true,
    );
    expect(proof.promotionAudit?.result).toMatchObject({ promotionDecision: "rejected" });
    expect(proof.promotionAudit?.result.latestEval).toMatchObject({
      adapterPath: path.join(root, "adapters/candidate-1"),
      promotionReady: false,
    });
    expect(proof.promotionAudit?.args).toContain(proof.options.logPath);
    expect(proof.nextCurriculum?.promptReadback?.status).toBe("read");
    const next = proof.nextCurriculum;
    if (!next?.promptHandoff) {
      throw new Error("Actual next prompt handoff is required");
    }
    const badHash = await originalTeacherReadFailure(root, proof.caller.caller, next.promptPath, {
      ...next.promptHandoff,
      sha256: "0".repeat(64),
    });
    const missing = await originalTeacherReadFailure(
      root,
      proof.caller.caller,
      path.join(root, "missing-prompt.json"),
      next.promptHandoff,
    );
    expect(badHash).toMatchObject({ ok: false, status: "blocked", acceptedCandidates: 0 });
    expect(missing).toMatchObject({ ok: false, status: "blocked", acceptedCandidates: 0 });
    await saveProof("whole-quota-promotion", { ...proof, sourceNegatives: { badHash, missing } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 60000);
  it.each([undefined, "eval_timeout", "train_nan"] as const)(
    "retains same-attempt original dataset trainer eval rejection and cooldown consumers (%s)",
    async (fault) => {
      const proof = await probeOriginalTrainingTail(root, fault);
      await saveProof(`whole-${fault ?? "eval_failure"}`, proof);
      expect(proof.curriculum.promptReadback?.status).toBe("read");
      expect(proof.curriculum.promptReadback?.callerRef).toEqual(proof.caller.caller);
      expect(proof.teacher).toMatchObject({ mock: true, workspaceDir: root });
      expect(proof.smoke).toMatchObject({ ok: true });
      const dataset = proof.dataset as { counts: { train: number; valid: number; test: number } };
      expect(dataset.counts.valid).toBeGreaterThan(0);
      expect(dataset.counts.test).toBeGreaterThan(0);
      const trainer = proof.invocations.find((row) => row.command === "nice");
      expect(trainer?.boundary).toBe("local_trainer_IO_reads_actual_slice_no_MLX_or_model");
      expect(trainer?.inputFiles?.map((file) => path.basename(file.path))).toEqual([
        "train.jsonl",
        "valid.jsonl",
        "test.jsonl",
        "manifest.json",
      ]);
      expect(trainer?.inputFiles?.find((file) => file.path.endsWith("train.jsonl"))?.raw).toContain(
        "brain_distillation_review",
      );
      expect(proof.selectedAdapter).toBeUndefined();
      expect(proof.receipts.some((row) => row.event === "adapter_promoted_for_guard_session")).toBe(
        false,
      );
      expect(proof.receipts.find((row) => row.event === "evolution_cooldown")).toMatchObject({
        round: 2,
        heavyWorkPaused: true,
      });
      if (fault === "train_nan") {
        expect(proof.trained).toMatchObject({ ok: false, reason: "train_loss_nan" });
        expect(proof.candidateEval).toBeUndefined();
        expect(proof.invocations.some((row) => row.args[2]?.endsWith("distill-eval.ts"))).toBe(
          false,
        );
        await expect(fs.stat(path.join(root, "adapters/candidate-1"))).rejects.toThrow();
      } else {
        expect(proof.trained).toMatchObject({
          ok: true,
          trainDataDir: path.join(root, "requested-slice"),
        });
        expect(
          proof.receipts.some((row) => row.event === "adapter_rejected_for_guard_session"),
        ).toBe(true);
        expect(proof.candidateEval).toMatchObject({ summary: { promotionReady: false } });
        if (fault === "eval_timeout") {
          expect(proof.candidateEval).toMatchObject({ timedOut: true, summary: { total: 0 } });
          const evaluation = proof.invocations.find((row) =>
            row.args[2]?.endsWith("distill-eval.ts"),
          );
          expect(evaluation?.lateClose).toBe(true);
          expect(evaluation?.kills).toEqual(["SIGTERM"]);
          expect(proof.nextReview).toMatchObject({
            status: "blocked",
            reason: "latest_eval_timeout",
          });
        } else {
          expect(proof.nextReview.selectedEvaluation?.snapshot?.adapterPath).toBe(
            path.join(root, "adapters/candidate-1"),
          );
          expect(proof.nextReview.selectedEvaluation?.source.sha256).toMatch(/^[a-f0-9]{64}$/u);
        }
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
    60000,
  );
  it.skipIf(!process.env.LCX_TRAINING_SCOPE_BEFORE_SOURCE)(
    "preserves the original before: teacher and dataset use fallback roots while the train-slice requested root is missing",
    async () => {
      const before = process.env.LCX_TRAINING_SCOPE_BEFORE_SOURCE;
      if (!before) {
        throw new Error("Original frozen source is required for the before proof");
      }
      const options = trainingScopeOptions(root);
      const { owners, invocations, sourceSha256 } = await loadOriginalTrainingChildOwners(
        before,
        root,
      );
      const teacher = (await owners.runTeacherStep(options, 1)) as Record<string, unknown>;
      const dataset = (await owners.runDatasetStep(options, 1)) as Record<string, unknown>;
      await expect(owners.runSmokeStep(options, 1)).rejects.toThrow("valid split empty");
      await expect(owners.buildTrainSlice(options, 1)).rejects.toThrow("ENOENT");
      expect(teacher.workspaceDir).not.toBe(options.workspaceDir);
      expect(dataset.workspaceDir).not.toBe(options.workspaceDir);
      expect(dataset.outDir).not.toBe(options.dataDir);
      expect(invocations[2].args).not.toContain("--data");
      await expect(fs.stat(options.dataDir)).rejects.toThrow();
      await saveProof("before", {
        boundary: "original_isolated_child_functions_original_mock_and_file_cli_no_guard_loop",
        options,
        sourceSha256,
        teacher,
        dataset,
        invocations,
      });
    },
    60000,
  );

  it.each(["first", "second"])(
    "uses this round's original teacher review in %s independent private workspace/data roots and actual train slice",
    async (name) => {
      const options = trainingScopeOptions(root);
      const { owners, invocations, sourceSha256 } = await loadOriginalTrainingChildOwners(
        sourcePath,
        root,
      );
      const teacher = (await owners.runTeacherStep(options, 1)) as Record<string, unknown>;
      const dataset = (await owners.runDatasetStep(options, 1)) as Record<string, unknown>;
      // Teacher reviews and curated seeds are train-only. The unmodified smoke
      // rejects their absent holdouts. Standalone slice conversion below is not
      // continuation of a guard past this gate, and never invokes a trainer.
      await expect(owners.runSmokeStep(options, 1)).rejects.toThrow("valid split empty");
      const slicePath = await owners.buildTrainSlice(options, 1);
      expect(teacher).toMatchObject({ mock: true, workspaceDir: options.workspaceDir });
      expect(dataset).toMatchObject({
        workspaceDir: options.workspaceDir,
        outDir: options.dataDir,
      });
      expect(invocations[2].args).toEqual(expect.arrayContaining(["--data", options.dataDir]));
      expect(invocations[2].stderr).toContain("valid split empty");
      expect((dataset.counts as Record<string, unknown>).valid).toBe(0);
      expect(slicePath).toBe(options.trainSliceDir);
      const reviewPath = String(teacher.reviewPath);
      const review = JSON.parse(
        await fs.readFile(path.resolve(options.workspaceDir, reviewPath), "utf8"),
      );
      const datasetRows = (await fs.readFile(path.join(options.dataDir, "train.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const sliceRows = (await fs.readFile(path.join(slicePath, "train.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const producerRows = datasetRows.filter(
        (row) =>
          row.meta.sourceKind === "brain_distillation_review" &&
          row.meta.sourcePath.startsWith(reviewPath),
      );
      expect(producerRows.length).toBeGreaterThan(0);
      expect(producerRows.every((row) => row.meta.generatedAt === review.reviewedAt)).toBe(true);
      expect(review.counts.accepted).toBe(1);
      expect(producerRows[0].prompt).toContain(review.acceptedCandidates[0].userMessage);
      const consumedRows = sliceRows.filter(
        (row) =>
          row.meta.sourceKind === "brain_distillation_review" &&
          row.meta.sourcePath.startsWith(reviewPath),
      );
      expect(consumedRows.length).toBeGreaterThan(0);
      expect(consumedRows[0].completion).toBe(producerRows[0].completion);
      await expect(
        fs.stat(
          path.join(root, "private-default-home", ".openclaw", "local-brain-trainer", "datasets"),
        ),
      ).rejects.toThrow();
      const receipts = (await fs.readFile(options.logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(receipts.map((row) => row.name)).toEqual([
        "minimax_teacher_batch",
        "dataset",
        "train_slice",
      ]);
      await saveProof(name, {
        boundary:
          "original_child_functions_original_teacher_mock_dataset_smoke_train_slice_only_no_guard_trainer_eval_provider",
        sourceSha256,
        options,
        teacher,
        review,
        dataset,
        smoke: { status: "normal_block", reason: "valid split empty", guardContinuation: false },
        slicePath,
        producerRows,
        consumedRows,
        receipts,
        invocations,
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
    60000,
  );

  it.skipIf(!process.env.LCX_TRAINING_FEEDBACK_BEFORE_SOURCE)(
    "preserves the original plus feedback scope omission without executing its full owner stack",
    async () => {
      const before = process.env.LCX_TRAINING_FEEDBACK_BEFORE_SOURCE;
      if (!before) {
        throw new Error("Original frozen feedback source is required for the before proof");
      }
      const options = { ...trainingScopeOptions(root), teacherProfile: "minimax-plus-brain" };
      const { owners, invocations, sourceSha256 } = await loadOriginalTrainingChildOwners(
        before,
        root,
      );
      await owners.runTeacherStep(options, 1);
      expect(invocations).toHaveLength(1);
      expect(invocations[0].boundary).toBe(
        "plus_teacher_branch_arguments_only_no_saturator_execution",
      );
      expect(invocations[0].args).not.toContain("--guard-log");
      await saveProof("plus-feedback-before", { options, sourceSha256, invocations });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps the existing plus-teacher branch scoped without executing its full owner stack", async () => {
    const options = { ...trainingScopeOptions(root), teacherProfile: "minimax-plus-brain" };
    const { owners, invocations, sourceSha256 } = await loadOriginalTrainingChildOwners(
      sourcePath,
      root,
    );
    await owners.runTeacherStep(options, 1);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].boundary).toBe(
      "plus_teacher_branch_arguments_only_no_saturator_execution",
    );
    expect(invocations[0].args).toEqual(
      expect.arrayContaining([
        "--workspace",
        options.workspaceDir,
        "--data-dir",
        options.dataDir,
        "--guard-log",
        options.logPath,
        "--mock",
      ]),
    );
    const feedbackFlag = invocations[0].args.indexOf("--guard-log");
    expect(invocations[0].args[feedbackFlag + 1]).toBe(options.logPath);
    const receipts = (await fs.readFile(options.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(receipts[0].name).toBe("minimax_plus_brain_saturator");
    await saveProof("plus-feedback-after", { options, sourceSha256, invocations, receipts });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
