import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";
import {
  buildFailureCurriculumPrompts,
  reviewFailureCurriculum,
} from "../scripts/operator/minimax-brain-failure-curriculum.js";
import {
  appendOriginalEval,
  deliverToOriginalTeacher,
  frozenCurriculum,
  feedbackHash,
  beginOriginalGuardCaller,
  originalTeacherReadFailure,
  originalProviderPaymentStop,
} from "./fixtures/lcx-waterflow-training-feedback-probe.js";
let root: string;
beforeEach(async () => {
  const retained = process.env.LCX_TRAINING_FEEDBACK_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
  }
  root = await fs.mkdtemp(path.join(retained ?? os.tmpdir(), "lcx-training-feedback-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden")));
});
afterEach(async () => {
  if (!process.env.LCX_TRAINING_FEEDBACK_PROOF_DIR) {
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});
const failed = {
  adapterPath: "/private/offline-adapter",
  summary: {
    passed: 1,
    total: 2,
    passRate: 0.5,
    failedCaseIds: ["data_vendor_conflict_reconciliation"],
    promotionReady: false,
  },
};
const passing = {
  ...failed,
  summary: { passed: 50, total: 50, passRate: 1, failedCaseIds: [], promotionReady: true },
};
async function save(name: string, proof: unknown) {
  const e = process.env.LCX_TRAINING_FEEDBACK_PROOF_DIR;
  if (!e) {
    return;
  }
  const dir = path.join(e, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(root, path.join(dir, "private-bytes"), { recursive: true });
  await fs.writeFile(path.join(dir, "owner-functions.json"), JSON.stringify(proof, null, 2) + "\n");
}
describe("original training feedback consumption", () => {
  it("feeds the original scoped failure curriculum into the same quota attempt before payment blocks continuation", async () => {
    const caller = await beginOriginalGuardCaller(root);
    const rows = await appendOriginalEval(
      path.join(root, "guard.jsonl"),
      new Date().toISOString(),
      failed,
    );
    const result = await originalProviderPaymentStop(root, "HTTP 402", {
      curriculumCaller: caller.caller,
    });
    const consumed = result.nativeInputs[0].promptConsumption as {
      inputs: string[];
      readback: { status: string; source: { sha256: string }; callerRef: unknown };
    };
    expect(consumed.readback.status).toBe("read");
    expect(consumed.inputs[0]).toContain("数据供应商冲突");
    expect(consumed.inputs[0]).toContain(consumed.readback.source.sha256);
    expect(consumed.readback.callerRef).toEqual(caller.caller);
    expect(result.quotaOutput).toMatchObject({ status: "blocked_provider_payment_required" });
    expect(result.sidecarAtDecision.stopReason).toBe("provider_payment_required");
    expect(result.serialFallbacks + result.datasetCalls + result.smokeCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    await save("scoped-curriculum-payment-stop", { caller, rows, result });
  });
  it.each([
    "MiniMax teacher call failed 402: Payment Required",
    "provider_payment_required",
    "HTTP 402",
    "insufficient balance",
  ])(
    "halts %s despite partial samples and propagates the result before paid fallback or training",
    async (error) => {
      const result = await originalProviderPaymentStop(root, error);
      await save(`payment-stop-${error.replaceAll(/\W+/gu, "_")}`, result);
      expect(result.teacherRequests).toBe(1);
      expect(result.nativeInputs[0].command).toBe("node");
      expect(
        (result.nativeInputs[0].args as unknown[]).every((arg) => typeof arg === "string"),
      ).toBe(true);
      expect(result.integrityChecks).toBe(0);
      expect(result.quotaOutput).toMatchObject({
        ok: false,
        owner: "minimax-quota-brain-saturator",
        status: "blocked_provider_payment_required",
        stopReason: "provider_payment_required",
        attempted: 2,
      });
      expect(result.localExitCode).toBe(1);
      expect(result.sidecarAtDecision).toMatchObject({
        exitCode: 1,
        stopReason: "provider_payment_required",
      });
      expect(result.guardError).toContain("provider_payment_required");
      expect(result.serialFallbacks).toBe(0);
      expect(result.datasetCalls).toBe(0);
      expect(result.smokeCalls).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("retains the payment cause when the deadline expires while writing the terminal receipt", async () => {
    const result = await originalProviderPaymentStop(root, "provider_payment_required", {
      expireOnCompletion: true,
    });
    expect(result.quotaOutput).toMatchObject({
      status: "blocked_provider_payment_required",
      stopReason: "provider_payment_required",
    });
    expect(result.serialFallbacks).toBe(0);
    await save("payment-at-deadline", result);
  });
  it("keeps normal successful work and quoted price 402 from becoming a payment blocker", async () => {
    const result = await originalProviderPaymentStop(root, undefined);
    expect(result.teacherRequests).toBe(2);
    expect(result.quotaOutput).toMatchObject({ ok: true, status: "complete", attempted: 4 });
    expect(result.sidecarAtDecision.exitCode).toBe(0);
    expect(result.serialFallbacks).toBe(0);
    expect(result.datasetCalls).toBe(1);
    expect(result.smokeCalls).toBe(1);
    await save("healthy-no-payment-false-positive", result);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not turn successful answer text into payment evidence when a different sample fails", async () => {
    const result = await originalProviderPaymentStop(root, "output_contract_invalid_price_402");
    expect(result.teacherRequests).toBe(2);
    expect(result.quotaOutput).toMatchObject({ ok: true, status: "complete" });
    expect(result.datasetCalls).toBe(1);
    expect(result.serialFallbacks).toBe(0);
    await save("partial-non-payment-no-false-positive", result);
  });
  it("records the original caller and independently reads selected failure content despite unrelated log append", async () => {
    const caller = await beginOriginalGuardCaller(root);
    expect(
      JSON.parse(caller.dispatch.args[caller.dispatch.args.indexOf("--caller-receipt") + 1]),
    ).toEqual(caller.caller);
    const log = path.join(root, "guard.jsonl");
    await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
    const delivery = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts, {
      caller: caller.caller,
      beforeTeacherRead: async () => {
        await fs.appendFile(log, JSON.stringify({ event: "unrelated_observer_note" }) + "\n");
      },
    });
    expect(delivery.promptReadback).toMatchObject({
      status: "read",
      caller: { runId: caller.caller.runId },
      semanticAdoption: "not_proven",
    });
    expect(delivery.promptReadback?.source?.lineSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(delivery.promptReadback?.source?.sha256).not.toBe(
      delivery.promptReadback?.source?.observedFileSha256,
    );
    expect(delivery.inputs[0]).toContain("数据供应商冲突");
    expect(delivery.inputs[0]).toContain(delivery.promptReadback?.source?.sha256);
    expect(delivery.promptReadback?.callerRef).toEqual(caller.caller);
    await save("native-caller-independent-read", { caller, delivery });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["source_changed", "newer_pass", "newer_timeout", "prompt_changed", "caller_changed"])(
    "keeps %s blocked in the original teacher JSON before dispatch",
    async (fault) => {
      const caller = await beginOriginalGuardCaller(root);
      const log = path.join(root, "guard.jsonl");
      await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
      let pin: { promptPath: string; handoff?: { path: string; sha256: string } } | undefined;
      await expect(
        deliverToOriginalTeacher(root, buildFailureCurriculumPrompts, {
          caller: caller.caller,
          beforeTeacherRead: async (input) => {
            pin = input;
            if (fault === "source_changed") {
              const raw = await fs.readFile(log, "utf8");
              await fs.writeFile(
                log,
                raw.replace("data_vendor_conflict_reconciliation", "changed_failure"),
              );
            } else if (fault === "newer_pass" || fault === "newer_timeout") {
              await appendOriginalEval(
                log,
                "2026-10-11T01:01:00.000Z",
                passing,
                fault === "newer_timeout",
              );
            } else if (fault === "prompt_changed") {
              await fs.appendFile(input.promptPath, " ");
            } else {
              const raw = await fs.readFile(log, "utf8");
              await fs.writeFile(log, raw.replace(caller.caller.runId, "foreign-caller"));
            }
          },
        }),
      ).rejects.toThrow(
        fault === "source_changed"
          ? "training_failure_source_hash_conflict"
          : fault.startsWith("newer_")
            ? "training_failure_source_superseded"
            : fault === "prompt_changed"
              ? "training_prompt_hash_conflict"
              : "training_caller_hash_conflict",
      );
      if (!pin?.handoff) {
        throw new Error("Original prompt/handoff production missing");
      }
      const receipt = await originalTeacherReadFailure(
        root,
        caller.caller,
        pin.promptPath,
        pin.handoff,
      );
      expect(receipt).toMatchObject({
        ok: false,
        status: "blocked",
        acceptedCandidates: 0,
        promptReadback: { status: "blocked", semanticAdoption: "not_proven" },
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      });
      expect(receipt.reason).toContain("training_");
      await save(`native-caller-${fault}`, { caller, pin, receipt });
      expect(fetch).not.toHaveBeenCalled();
    },
    20000,
  );
  it.each(["receipt_then_log_timeout", "log_then_receipt_pass"])(
    "rejects cross-source supersession %s before original teacher dispatch",
    async (direction) => {
      const caller = await beginOriginalGuardCaller(root);
      const log = path.join(root, "guard.jsonl");
      const evalPath = path.join(root, "state/lcx-targeted-challenger-eval-receipt-latest.json");
      // Private source input in the original receipt format; no evaluator is run.
      const writeEvalInput = async (at: string, result: typeof failed | typeof passing) => {
        await fs.mkdir(path.dirname(evalPath), { recursive: true });
        await fs.writeFile(
          evalPath,
          JSON.stringify({
            boundary: "local_brain_eval_receipt_only",
            generatedAt: at,
            resolved: { adapterPath: result.adapterPath },
            summary: result.summary,
          }),
        );
      };
      await appendOriginalEval(
        log,
        direction.startsWith("receipt") ? "2026-10-11T01:00:00.000Z" : "2026-10-11T01:01:00.000Z",
        failed,
      );
      await writeEvalInput(
        direction.startsWith("receipt") ? "2026-10-11T01:01:00.000Z" : "2026-10-11T01:00:00.000Z",
        failed,
      );
      const selectedPath = direction.startsWith("receipt") ? evalPath : log;
      const selectedShaBefore = await feedbackHash(selectedPath);
      let pin: { promptPath: string; handoff?: { path: string; sha256: string } } | undefined;
      const delivery = deliverToOriginalTeacher(root, buildFailureCurriculumPrompts, {
        caller: caller.caller,
        beforeTeacherRead: async (input) => {
          pin = input;
          if (direction.startsWith("receipt")) {
            await appendOriginalEval(log, "2026-10-11T01:02:00.000Z", passing, true);
          } else {
            await writeEvalInput("2026-10-11T01:02:00.000Z", passing);
          }
        },
      });
      if (process.env.LCX_TRAINING_FEEDBACK_CROSS_SOURCE_BEFORE) {
        const stale = await delivery;
        expect(stale.promptReadback?.status).toBe("read");
        expect(stale.inputs[0]).toContain("数据供应商冲突");
        await save(`cross-source-before-${direction}`, { caller, stale, selectedShaBefore });
      } else {
        await expect(delivery).rejects.toThrow("training_failure_source_superseded");
        if (!pin?.handoff) {
          throw new Error("Missing original pinned prompt");
        }
        const receipt = await originalTeacherReadFailure(
          root,
          caller.caller,
          pin.promptPath,
          pin.handoff,
        );
        expect(receipt).toMatchObject({
          ok: false,
          status: "blocked",
          acceptedCandidates: 0,
          promptReadback: { status: "blocked" },
          providerConfigTouched: false,
          protectedMemoryTouched: false,
        });
        expect(receipt.reason).toContain("training_failure_source_superseded");
        await save(`cross-source-after-${direction}`, { caller, pin, receipt, selectedShaBefore });
      }
      expect(await feedbackHash(selectedPath)).toBe(selectedShaBefore);
      expect(fetch).not.toHaveBeenCalled();
    },
    20000,
  );
  it.skipIf(!process.env.LCX_TRAINING_FEEDBACK_BEFORE_SOURCE)(
    "preserves original stale failure reaching real next teacher input after passing evaluation",
    async () => {
      const before = process.env.LCX_TRAINING_FEEDBACK_BEFORE_SOURCE;
      if (!before) {
        throw new Error("Frozen source required");
      }
      const log = path.join(root, "guard.jsonl");
      await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
      const rows = await appendOriginalEval(log, "2026-10-11T01:01:00.000Z", passing);
      const native = await frozenCurriculum(before);
      const delivery = await deliverToOriginalTeacher(root, native.buildFailureCurriculumPrompts, {
        saturatorSource: before.replace(
          "minimax-brain-failure-curriculum.ts",
          "minimax-quota-brain-saturator.ts",
        ),
      });
      expect(delivery.batch.failureFocusPrompts).toBe(1);
      expect(delivery.inputs[0]).toContain("数据供应商冲突");
      await save("before-pass-resurrects-failure", { rows, delivery });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("actually sends the original failure case and source summary into next teacher input", async () => {
    const log = path.join(root, "guard.jsonl");
    const rows = await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
    const reviewSpy = vi.fn(reviewFailureCurriculum);
    const delivery = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts, {
      review: reviewSpy,
    });
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    expect(delivery.batch.failureFocusPrompts).toBe(1);
    expect(delivery.consumed[0]).toEqual(delivery.batch.prompts[0]);
    expect(delivery.inputs[0]).toContain("数据供应商冲突");
    const receipt = await reviewFailureCurriculum({ guardLogPath: log, maxPrompts: 1 });
    expect(delivery.inputs[0]).toContain(await feedbackHash(log));
    expect(delivery.inputs[0]).toContain(log);
    expect(receipt.status).toBe("ready");
    const logRows = (await fs.readFile(path.join(root, "saturator.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(logRows[0]).toMatchObject({
      event: "failure_curriculum_review",
      status: "ready",
      source: { sha256: await feedbackHash(log) },
      promptIds: [delivery.consumed[0].id],
    });
    await save("after-failure-used", { rows, delivery, receipt });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["pass", "timeout"])(
    "does not revive superseded failures after newer %s",
    async (kind) => {
      const log = path.join(root, "guard.jsonl");
      await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
      const rows = await appendOriginalEval(
        log,
        "2026-10-11T01:01:00.000Z",
        passing,
        kind === "timeout",
      );
      const delivery = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts);
      expect(delivery.batch.failureFocusPrompts).toBe(0);
      expect(delivery.inputs.join("\n")).not.toContain("Latest failed eval adapter");
      const receipt = await reviewFailureCurriculum({ guardLogPath: log, maxPrompts: 1 });
      expect(receipt.status).toBe(kind === "timeout" ? "blocked" : "no_failure");
      const logRows = (await fs.readFile(path.join(root, "saturator.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(logRows[0].status).toBe(receipt.status);
      expect(logRows[0].reason).toBe(receipt.reason);
      await save(`after-${kind}`, { rows, delivery, receipt });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("newer successful original eval receipt resolves prior log failure", async () => {
    const log = path.join(root, "guard.jsonl");
    await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
    const evalPath = path.join(root, "state/lcx-targeted-challenger-eval-receipt-latest.json");
    await fs.mkdir(path.dirname(evalPath), { recursive: true });
    await fs.writeFile(
      evalPath,
      JSON.stringify({
        boundary: "local_brain_eval_receipt_only",
        generatedAt: "2026-10-11T01:01:00.000Z",
        resolved: { adapterPath: passing.adapterPath },
        summary: passing.summary,
      }),
    );
    const receipt = await reviewFailureCurriculum({
      guardLogPath: log,
      evalReceiptPath: evalPath,
      maxPrompts: 1,
    });
    expect(receipt.status).toBe("no_failure");
    const delivery = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts);
    expect(delivery.batch.failureFocusPrompts).toBe(0);
    await save("after-receipt-pass", { receipt, delivery });
  });
  it("changed original failure content selects a different next teacher uncertainty", async () => {
    const log = path.join(root, "guard.jsonl");
    await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
    const first = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts);
    const oldSha = await feedbackHash(log);
    await appendOriginalEval(log, "2026-10-11T01:01:00.000Z", {
      ...failed,
      summary: { ...failed.summary, failedCaseIds: ["drawdown_budget_without_weights"] },
    });
    const second = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts);
    expect(second.consumed[0].id).toContain("drawdown_budget_without_weights");
    expect(second.inputs[0]).toContain("最大回撤定义");
    expect(second.inputs[0]).not.toContain("数据供应商冲突");
    expect(second.inputs[0]).toContain(await feedbackHash(log));
    expect(second.inputs[0]).not.toContain(oldSha);
    await save("after-content-changes-selection", { first, second, oldSha });
  });
  it("same timestamp contradictory sources cannot select a failure curriculum", async () => {
    const log = path.join(root, "guard.jsonl");
    await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
    const evalPath = path.join(root, "state/lcx-targeted-challenger-eval-receipt-latest.json");
    await fs.mkdir(path.dirname(evalPath), { recursive: true });
    await fs.writeFile(
      evalPath,
      JSON.stringify({
        boundary: "local_brain_eval_receipt_only",
        generatedAt: "2026-10-11T01:00:00.000Z",
        resolved: { adapterPath: passing.adapterPath },
        summary: passing.summary,
      }),
    );
    const receipt = await reviewFailureCurriculum({
      guardLogPath: log,
      evalReceiptPath: evalPath,
      maxPrompts: 1,
    });
    expect(receipt).toMatchObject({
      status: "blocked",
      reason: "eval_sources_same_time_conflict",
      prompts: [],
    });
    const delivery = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts);
    expect(delivery.batch.failureFocusPrompts).toBe(0);
    await save("after-source-conflict", { receipt, delivery });
  });
  it.each(["missing", "future", "malformed"])(
    "records original %s source block instead of older failures",
    async (kind) => {
      const log = path.join(root, "guard.jsonl");
      if (kind !== "missing") {
        await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
        await appendOriginalEval(
          log,
          kind === "future" ? "2099-01-01T01:00:00.000Z" : "2026-10-11T01:01:00.000Z",
          kind === "malformed"
            ? {
                adapterPath: failed.adapterPath,
                summary: { failedCaseIds: ["fabricated_missing_score"] },
              }
            : failed,
        );
      }
      const receipt = await reviewFailureCurriculum({ guardLogPath: log, maxPrompts: 1 });
      expect(receipt.status).toBe("blocked");
      expect(receipt.prompts).toEqual([]);
      await save(`after-${kind}`, { receipt });
    },
  );
  it("original auditor rejects changed bytes and retains the exact unobserved whole-scene nodes", async () => {
    const log = path.join(root, "guard.jsonl");
    await appendOriginalEval(log, "2026-10-11T01:00:00.000Z", failed);
    const receipt = await reviewFailureCurriculum({ guardLogPath: log, maxPrompts: 1 });
    const p = path.join(root, "original-curriculum.json");
    await fs.writeFile(p, JSON.stringify(receipt));
    const sha = await feedbackHash(p);
    const ref = (pointer: string) => ({ path: p, sha256: sha, pointer });
    const index: WorkflowHandoffEvidence[] = [
      {
        scenarioId: "training_failure_feedback_waterflow",
        environment: "offline_fixture",
        nodes: [
          {
            nodeId: "failure_curriculum",
            scope: ref("/selectedEvaluation/snapshot/adapterPath"),
            output: ref("/prompts"),
          },
        ],
      },
    ];
    const audits = await auditWorkflowHandoffs(index);
    const audit = audits.find((row) => row.scenarioId === "training_failure_feedback_waterflow");
    expect(audit?.status).toBe("handoff_gap");
    expect(
      audit?.gaps.some(
        (g) => g.node === "qwen_training" && g.reason === "original_receipt_not_observed",
      ),
    ).toBe(true);
    await fs.copyFile(p, path.join(root, "original-curriculum-valid.json"));
    await fs.appendFile(p, " ");
    const conflicts = await auditWorkflowHandoffs(index);
    const conflict = conflicts.find(
      (row) => row.scenarioId === "training_failure_feedback_waterflow",
    );
    expect(conflict?.gaps.some((g) => g.reason === "receipt_hash_conflict")).toBe(true);
    await save("after-original-partial-audit", { receipt, index, audit, conflict });
  });
});
