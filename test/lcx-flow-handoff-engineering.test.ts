import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import {
  engineeringCli,
  engineeringLockArgs,
  engineeringRef,
  originalDoctorCheck,
  originalDoctorCancellation,
  originalDoctorUnconfirmedCancellation,
  originalPriorWorkProbe,
  originalDoctorTail,
  originalOperatorReceipt,
  originalGitTransportTimeout,
  originalTrainingDecisions,
  persistEngineering,
  privateEngineeringRepo,
  probeEngineeringPartial,
} from "./fixtures/lcx-waterflow-engineering-probe.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(name: string) {
  const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
  if (proofDir) {
    const dir = path.join(proofDir, name);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lcx-engineering-${name}-`));
  roots.push(dir);
  return dir;
}

describe("original engineering handoffs (private Git/lease, no automation or owner stack)", () => {
  it("executes the original selected repair command and consumes its plan input in the original lease gate", async () => {
    const root = await fixture("training-plan-lock-input");
    const cwd = await privateEngineeringRepo(root);
    const plan = await originalTrainingDecisions(cwd);
    const selected = plan.decisions.find(
      (decision) => decision.id === "guard_failed_after_latest_start",
    );
    expect(selected).toMatchObject({
      codexRepairEligible: true,
      repairContext: { worktree: cwd, decisionId: "guard_failed_after_latest_start" },
    });
    const lease = path.join(root, "private.lock");
    const command = `${String(selected!.nextCommand)} --lock '${lease.replaceAll("'", "'\\''")}'`;
    const native = await promisify(execFile)("/bin/zsh", ["-f", "-c", command], {
      cwd: path.resolve(import.meta.dirname, ".."),
      timeout: 10_000,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
    });
    const acquired = JSON.parse(native.stdout);
    expect(acquired.acquired).toBe(true);
    const stored = JSON.parse(await fs.readFile(lease, "utf8"));
    expect(stored.planningInput.context).toEqual(selected!.repairContext);
    expect(stored.planningInput.contentSha256).toEqual(
      crypto.createHash("sha256").update(JSON.stringify(selected!.repairContext)).digest("hex"),
    );
    const reader = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(cwd, lease, "status"),
    );
    expect(reader.value.lock).toEqual(acquired.lock);
    await persistEngineering(root, "original-plan-function.json", plan);
    await persistEngineering(root, "native-acquire.json", { command, ...acquired });
    await persistEngineering(root, "native-status-readback.json", reader.value);
    await persistEngineering(root, "native-lease.json", stored);
    await persistEngineering(root, "result.json", {
      scope:
        "original_pure_planner_function_to_generated_command_to_actual_original_cli_and_private_lease",
      wholeScene: "pending_local_change_tests_doctor_feedback",
      planSource: plan.source,
      acquired,
      reader: reader.value,
    });
  });

  it("observes the actual persisted lock readback and owned impact mapping while keeping missing seams visible", async () => {
    const root = await fixture("partial");
    const result = await probeEngineeringPartial(root);
    const audit = (await auditWorkflowHandoffs(result.evidence)).filter((row) =>
      ["automation_repair_lock_waterflow", "similar_engineering_consolidation_waterflow"].includes(
        row.scenarioId,
      ),
    );
    expect(result.read.value.lock).toEqual(result.acquired.value.lock);
    expect(result.released.value.released).toBe(true);
    expect(result.impact.value).toMatchObject({
      ok: true,
      boundary: "local_change_impact_plan_only",
    });
    const lock = audit.find((row) => row.scenarioId === "automation_repair_lock_waterflow");
    const consolidation = audit.find(
      (row) => row.scenarioId === "similar_engineering_consolidation_waterflow",
    );
    expect(lock?.status).toBe("handoff_gap");
    expect(lock?.gaps).toContainEqual(
      expect.objectContaining({ node: "training_plan", reason: "original_receipt_not_observed" }),
    );
    expect(
      lock?.gaps.some((gap) => gap.reason === "consumer_did_not_receive_output:schedule_gate"),
    ).toBe(false);
    expect(consolidation?.status).toBe("handoff_gap");
    expect(consolidation?.gaps).toContainEqual(
      expect.objectContaining({
        node: "prior_work_search",
        reason: "original_receipt_not_observed",
      }),
    );
    expect(
      consolidation?.gaps.some(
        (gap) => gap.reason === "consumer_did_not_receive_output:local_change",
      ),
    ).toBe(false);
    await persistEngineering(root, "result.json", { result, audit });
    await persistEngineering(root, "handoff-index.json", result.evidence);
  });

  it("reuses the original unknown-Git fail-closed repair rather than treating allow-dirty as authority", async () => {
    const root = await fixture("unknown-git-ceiling");
    const cwd = path.join(root, "not-git");
    await fs.mkdir(cwd, { recursive: true });
    const lease = path.join(root, "private.lock");
    const result = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(cwd, lease, "acquire", ["--allow-dirty"]),
    );
    expect(result.value).toMatchObject({
      acquired: false,
      status: "blocked_worktree_status_unavailable",
      liveTouched: false,
      providerConfigTouched: false,
    });
    expect(result.value.reason).toEqual(expect.stringContaining("Git status is unavailable"));
    await expect(fs.stat(lease)).rejects.toMatchObject({ code: "ENOENT" });
    await persistEngineering(root, "result.json", result);
  });

  it.each(["hash", "field"] as const)(
    "identifies the %s fault in an actual original lock consumer receipt",
    async (fault) => {
      const root = await fixture(`audit-${fault}`);
      const result = await probeEngineeringPartial(root);
      const evidence = structuredClone(result.evidence);
      const consumer = evidence[0].nodes[1];
      expect(consumer.inputs?.[0]).toBeDefined();
      const input = consumer.inputs![0].value;
      if (fault === "hash") {
        const copied = path.join(root, "native-status-readback-hash-conflict.json");
        await fs.writeFile(copied, (await fs.readFile(input.path, "utf8")) + "\n");
        consumer.scope.path = copied;
        consumer.output!.path = copied;
        input.path = copied;
      } else {
        input.pointer = "/missing_native_field";
      }
      const audit = (await auditWorkflowHandoffs(evidence)).find(
        (row) => row.scenarioId === "automation_repair_lock_waterflow",
      );
      expect(audit?.status).toBe("handoff_gap");
      expect(audit?.gaps).toContainEqual(
        expect.objectContaining({
          node: "repair_lock",
          reason: fault === "hash" ? "receipt_hash_conflict" : "receipt_field_missing",
        }),
      );
      await persistEngineering(root, "fault-audit.json", { evidence, audit });
    },
  );

  it("detects cross-root consumption from the native reader's own requested worktree field", async () => {
    const root = await fixture("audit-cross-root");
    const first = await privateEngineeringRepo(root, "first");
    const other = await privateEngineeringRepo(root, "other");
    const lease = path.join(root, "private.lock");
    const acquired = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(first, lease, "acquire"),
    );
    const read = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(other, lease, "status"),
    );
    const producer = await persistEngineering(root, "native-acquire.json", acquired.value);
    const consumer = await persistEngineering(root, "native-cross-root-reader.json", read.value);
    const evidence = [
      {
        scenarioId: "automation_repair_lock_waterflow" as const,
        environment: "offline_fixture" as const,
        nodes: [
          {
            nodeId: "schedule_gate" as const,
            scope: engineeringRef(producer, "/worktreeDir"),
            output: engineeringRef(producer, "/lock"),
          },
          {
            nodeId: "repair_lock" as const,
            scope: engineeringRef(consumer, "/worktreeDir"),
            output: engineeringRef(consumer, "/lock"),
            inputs: [{ from: "schedule_gate" as const, value: engineeringRef(consumer, "/lock") }],
          },
        ],
      },
    ];
    const audit = (await auditWorkflowHandoffs(evidence)).find(
      (row) => row.scenarioId === "automation_repair_lock_waterflow",
    );
    expect(audit?.gaps).toContainEqual(
      expect.objectContaining({ reason: "handoff_scope_conflict:schedule_gate" }),
    );
    await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(first, lease, "release", ["--token", String(acquired.value.token)]),
    );
    await persistEngineering(root, "result.json", { evidence, audit, acquired, read });
  });

  it("keeps occupied ownership and lease bytes unchanged", async () => {
    const root = await fixture("occupied");
    const cwd = await privateEngineeringRepo(root);
    const lease = path.join(root, "private.lock");
    const acquired = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(cwd, lease, "acquire"),
    );
    const before = await fs.readFile(lease);
    const refused = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(cwd, lease, "acquire"),
    );
    expect(refused.value).toMatchObject({ status: "locked", acquired: false });
    expect(await fs.readFile(lease)).toEqual(before);
    await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(cwd, lease, "release", ["--token", String(acquired.value.token)]),
    );
    await persistEngineering(root, "result.json", { acquired, refused, leaseBytesPreserved: true });
  });

  it("refuses wrong-root release while preserving the native lease for its actual owner", async () => {
    const root = await fixture("cross-root-after");
    const first = await privateEngineeringRepo(root, "first");
    const other = await privateEngineeringRepo(root, "other");
    const lease = path.join(root, "private.lock");
    const acquired = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(first, lease, "acquire"),
    );
    const before = await fs.readFile(lease, "utf8");
    const wrongRoot = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(other, lease, "release", ["--token", String(acquired.value.token)]),
    );
    expect(wrongRoot.exitCode).toBe(1);
    expect(wrongRoot.value).toMatchObject({ released: false, status: "worktree_mismatch" });
    expect(wrongRoot.value.worktreeDir).toBe(other);
    expect(JSON.parse(before).cwd).toBe(first);
    expect(await fs.readFile(lease, "utf8")).toBe(before);
    const released = await engineeringCli(
      "lcx-automation-repair-lock.ts",
      engineeringLockArgs(first, lease, "release", ["--token", String(acquired.value.token)]),
    );
    expect(released.value.released).toBe(true);
    await persistEngineering(root, "result.json", {
      acquired,
      before,
      wrongRoot,
      released,
      finding:
        "native_release_requires_matching_worktree_lane_and_token; rejected_attempt_preserves_lease",
    });
  });

  it("shows an original repair suggestion is a command string, without inventing its execution", async () => {
    const root = await fixture("training-suggestion");
    const cwd = await privateEngineeringRepo(root);
    const result = await originalTrainingDecisions(cwd);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        id: "guard_failed_after_latest_start",
        codexRepairEligible: true,
        nextCommand: expect.stringContaining("lcx-automation-repair-lock.ts --mode acquire"),
      }),
    );
    expect(await fs.readdir(cwd)).toEqual([".git"]);
    await persistEngineering(root, "result.json", result);
  });

  it("propagates the original owner's exit-zero failed receipt through the doctor consumer", async () => {
    const root = await fixture("doctor-false-clean-after");
    const impact = await engineeringCli("lcx-change-impact-plan.ts", [
      "--changed",
      "unowned-private-input.unknown",
    ]);
    expect(impact.exitCode).toBe(0);
    expect(impact.value.ok).toBe(false);
    const input = await persistEngineering(root, "native-impact-receipt.json", impact.value);
    const consumed = await originalDoctorCheck(root, input.path);
    expect(consumed.check.summary.ok).toBe(false);
    expect(consumed.check.ok).toBe(false);
    expect(consumed.check.error).toContain("unmatched changed files");
    expect(consumed.actionableFailures).toEqual([
      expect.stringContaining("unmatched changed files"),
    ]);
    const tail = await originalDoctorTail(consumed.check);
    expect(JSON.parse(tail.stdout)).toMatchObject({ ok: false, summary: { failed: 1 } });
    expect(tail.stderr).toContain("unmatched changed files");
    const doctorPath = path.join(root, "native-single-doctor-aggregate.json");
    await fs.writeFile(doctorPath, tail.stdout);
    const writerPath = process.env.LCX_NATIVE_OPERATOR_WRITER_PATH;
    const operator = writerPath
      ? await originalOperatorReceipt(root, doctorPath, writerPath, tail.stderr, tail.exitCode)
      : undefined;
    if (operator) {
      expect(operator.receipt).toMatchObject({ ok: false, doctor: { ok: false, failed: 1 } });
      expect(operator.io).toContainEqual({ op: "read", path: doctorPath });
      expect(operator.receipt.errors).toMatchObject({
        doctor: expect.stringContaining("unmatched changed files"),
      });
    }
    await persistEngineering(root, "result.json", {
      impact,
      consumed,
      tail,
      operator,
      finding: "original_owner_failed_result_retained_through_summary_and_actionable_failure",
    });
  });

  it.each([true, undefined])(
    "retains exit-zero %s owner compatibility without inventing a missing-ok failure",
    async (ok) => {
      const root = await fixture(`doctor-compatible-${String(ok)}`);
      const source = await persistEngineering(root, "private-response.json", {
        ...(ok === undefined ? {} : { ok }),
        owner: "explicit_private_transport_response",
      });
      const consumed = await originalDoctorCheck(root, source.path);
      expect(consumed.check.ok).toBe(true);
      expect(consumed.actionableFailures).toEqual([]);
      expect(consumed.check.summary).toMatchObject({
        owner: "explicit_private_transport_response",
      });
      const tail = await originalDoctorTail(consumed.check);
      expect(tail.stderr).toBe("");
      expect(tail.exitCode).toBe(0);
      expect(JSON.parse(tail.stdout)).toMatchObject({ ok: true });
    },
  );

  it("bounds original failure stderr by UTF-8 bytes while preserving stdout JSON", async () => {
    const root = await fixture("doctor-stderr-budget");
    const reason = "来源缺口🙂".repeat(400);
    const source = await persistEngineering(root, "private-response.json", { ok: false, reason });
    const consumed = await originalDoctorCheck(root, source.path);
    const tail = await originalDoctorTail(consumed.check);
    expect(tail.exitCode).toBe(1);
    expect(Buffer.byteLength(tail.stderr, "utf8")).toBeLessThanOrEqual(1024);
    expect(tail.stderr).toMatch(/…\n$/);
    expect(tail.stderr).not.toContain("\uFFFD");
    expect(JSON.parse(tail.stdout)).toMatchObject({
      ok: false,
      checks: [expect.objectContaining({ error: reason })],
    });
    await persistEngineering(root, "result.json", { consumed, tail });
  });

  it("retains nonzero exit, parse error and concrete original source reasons", async () => {
    const root = await fixture("doctor-failure-regressions");
    const source = await persistEngineering(root, "private-ok-response.json", { ok: true });
    const failedExit = await originalDoctorCheck(root, source.path, false, 7);
    expect(failedExit.check).toMatchObject({ ok: false, summary: { exitCode: 7 } });
    expect(failedExit.check.error).toContain("exited 7");
    await fs.writeFile(path.join(root, "private-malformed.json"), "{invalid");
    const parseFailure = await originalDoctorCheck(root, path.join(root, "private-malformed.json"));
    expect(parseFailure.check.ok).toBe(false);
    expect(parseFailure.actionableFailures.length).toBe(1);
    const explicit = await persistEngineering(root, "private-failed-response.json", {
      ok: false,
      reason: "original_source_unavailable",
    });
    const failedOwner = await originalDoctorCheck(root, explicit.path);
    expect(failedOwner.check).toMatchObject({
      ok: false,
      error: "original_source_unavailable",
      summary: { ok: false },
    });
    await persistEngineering(root, "result.json", { failedExit, parseFailure, failedOwner });
  });

  it("keeps a single original doctor command timeout failed with a concrete reason", async () => {
    const root = await fixture("doctor-timeout");
    const result = await originalDoctorCheck(root, "unused", true);
    expect(result.check.ok).toBe(false);
    expect(result.check.error).toContain("timed out");
    expect(result.actionableFailures).toEqual([expect.stringContaining("timed out")]);
    const before = JSON.stringify(result);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.stringify(result)).toBe(before);
    await persistEngineering(root, "result.json", result);
  });

  it.each([false, true])(
    "confirms the private doctor child is closed after ignored TERM and never adopts a late success: %s",
    async (lateOutputOnTerm) => {
      const root = await fixture(
        lateOutputOnTerm ? "doctor-ignored-term-late-body" : "doctor-ignored-term",
      );
      const result = await originalDoctorCancellation(root, lateOutputOnTerm);
      await persistEngineering(root, "result.json", result);
      expect(result.termIgnored).toBe("term_ignored");
      expect(result.check).toMatchObject({
        ok: false,
        summary: { cleanupStatus: "local_child_closed", timeoutMs: 400, signal: "SIGKILL" },
      });
      expect(result.check.error).toContain("timed out");
      expect(result.closedAtReturn).toBe(true);
      expect(result.aliveAtReturn).toBe(false);
      expect(result.cleanupByFixture).toBe(false);
      expect(result.lateResultWritten).toBe(lateOutputOnTerm);
      if (lateOutputOnTerm) {
        expect(result.check.summary.stdoutTail).toContain('"ok":true');
      }
      expect(result.signals).toEqual(["SIGTERM", "SIGKILL"]);
      const tail = await originalDoctorTail(result.check);
      expect(JSON.parse(tail.stdout)).toMatchObject({ ok: false, summary: { failed: 1 } });
      expect(tail.stderr).toContain("timed out");
      await persistEngineering(root, "native-doctor-tail.json", tail);
    },
  );

  it("keeps cleanup unconfirmed when close never arrives and a late close cannot change failure", async () => {
    const root = await fixture("doctor-no-close");
    const result = await originalDoctorUnconfirmedCancellation(root);
    expect(result.check).toMatchObject({
      ok: false,
      summary: { cleanupStatus: "cleanup_unconfirmed", timeoutMs: 10 },
    });
    expect(result.stableAfterLateClose).toBe(true);
    expect(result.signals).toEqual(["SIGTERM", "SIGKILL"]);
    const tail = await originalDoctorTail(result.check);
    expect(JSON.parse(tail.stdout)).toMatchObject({ ok: false, summary: { failed: 1 } });
    expect(tail.stderr).toContain("local child cleanup unconfirmed");
    const doctor = await persistEngineering(
      root,
      "native-doctor-output.json",
      JSON.parse(tail.stdout),
    );
    const writerPath = process.env.LCX_NATIVE_OPERATOR_WRITER_PATH;
    const operator = writerPath
      ? await originalOperatorReceipt(root, doctor.path, writerPath, tail.stderr, tail.exitCode)
      : undefined;
    if (operator) {
      expect(operator.receipt).toMatchObject({ ok: false, doctor: { ok: false, failed: 1 } });
      expect(operator.receipt.errors).toMatchObject({
        doctor: expect.stringContaining("local child cleanup unconfirmed"),
      });
      expect(operator.io).toContainEqual({ op: "read", path: doctor.path });
    }
    await persistEngineering(root, "result.json", { result, tail, operator });
  });

  it("does not acquire while Git is unresolved, then preserves its original unavailable refusal", async () => {
    const root = await fixture("git-timeout");
    const cwd = await privateEngineeringRepo(root);
    const result = await originalGitTransportTimeout(root, cwd);
    expect(result.settledBeforeTransportFailure).toBe(false);
    const options = result.calls[0].options;
    if (!options || typeof options !== "object" || !("timeout" in options)) {
      throw new Error("Original Git transport must have a bounded timeout");
    }
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(120_000);
    expect(result.receipt).toMatchObject({
      status: "blocked_worktree_status_unavailable",
      acquired: false,
    });
    await expect(fs.stat(path.join(root, "private-timeout.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await persistEngineering(root, "result.json", result);
  });
});

describe("original prior-work source comparison reaches governance and Central", () => {
  it("reads actual HEAD/current bytes and real diff without forwarding private literals", async () => {
    const result = await originalPriorWorkProbe(await fixture("prior-work-changed"), "changed");
    expect(result.result?.ok).toBe(true);
    expect(result.priorWork).toMatchObject({
      status: "observed",
      blocksPlan: false,
      semanticEquivalence: "not_proven",
    });
    expect(result.priorWork.reads[0]).toMatchObject({
      old: { sha256: result.proof.originalBodySha256 },
      current: { sha256: result.proof.newBodySha256 },
      disposition: "preserve_existing_path",
    });
    expect(result.priorWork.reads[0].diff.publicSymbols).toContainEqual({
      change: "added",
      name: "sourceDigest",
    });
    expect(result.priorWork.reads[0].diff.hunks.length).toBeGreaterThan(0);
    expect(result.central?.byOwner.changeImpact.compact.strayGate).toEqual(
      result.result?.strayGate,
    );
    expect(JSON.stringify(result.central)).not.toContain("fixture-secret-must-not-enter-central");
    expect(JSON.stringify(result.central)).not.toContain("new-private-literal");
  });
  it.each(["git_failure", "conflict"] as const)(
    "blocks actual %s comparison and preserves the reason in Central",
    async (mode) => {
      const result = await originalPriorWorkProbe(await fixture(`prior-work-${mode}`), mode);
      expect(result.result?.ok).toBe(false);
      expect(result.priorWork).toMatchObject({ status: "unknown", blocksPlan: true });
      expect(result.priorWork.gaps.length).toBeGreaterThan(0);
      expect(result.central?.byOwner.changeImpact.compact.strayGate).toEqual(
        result.result?.strayGate,
      );
    },
  );
  it("leaves byte-budget omissions partial for narrow reading without treating them as damage", async () => {
    const result = await originalPriorWorkProbe(await fixture("prior-work-too-large"), "too_large");
    expect(result.result?.ok).toBe(true);
    expect(result.priorWork).toMatchObject({ status: "partial", blocksPlan: false });
    expect(result.priorWork.reads).toEqual([]);
    expect(result.priorWork.omissions?.budgetIndices).toEqual([0]);
    expect(result.priorWork.gaps).toContain(
      "prior_work_byte_budget_partial:src/agents/finance-expectation-gap.ts",
    );
    expect(result.central?.byOwner.changeImpact.compact.strayGate).toEqual(
      result.result?.strayGate,
    );
  });
  it("actually reads a bounded production focus and preserves exact omissions from a mixed batch", async () => {
    const result = await originalPriorWorkProbe(
      await fixture("prior-work-mixed-batch"),
      "mixed_batch",
    );
    expect(result.result?.ok).toBe(false);
    expect(result.result?.unmatchedFiles).toContain("src/agents/finance-expectation-gap-00.ts");
    expect(result.result?.strayGate.nextAction).toContain("add an owner rule");
    expect(result.priorWork).toMatchObject({
      status: "partial",
      blocksPlan: false,
      scope: { changedFilesCount: 21, eligibleCount: 19, selectedCount: 16, focusLimit: 16 },
    });
    const readCount = result.priorWork.reads.length;
    expect(readCount).toBeGreaterThan(0);
    expect(readCount + (result.priorWork.omissions?.budgetIndices.length ?? 0)).toBe(16);
    expect(result.priorWork.reads.every((read) => read.old?.sha256 && read.current.sha256)).toBe(
      true,
    );
    expect(result.priorWork.omissions?.indices).toHaveLength(3);
    const changedFiles = result.result?.changedFiles as string[];
    const omittedPaths = result.priorWork.omissions?.indices.map((i) => changedFiles[i]);
    expect(omittedPaths).toEqual(
      changedFiles
        .filter((file) => file.startsWith("src/") && !file.endsWith(".test.ts"))
        .slice(16),
    );
    expect(
      result.priorWork.reads.some(
        (read) => read.path.includes(".test.") || read.path.startsWith("test/"),
      ),
    ).toBe(false);
    const centralGate = result.central?.byOwner.changeImpact.compact.strayGate as {
      priorWork: Record<string, unknown>;
    };
    const summary = centralGate.priorWork;
    expect(summary).toMatchObject({
      status: "partial",
      blocksPlan: false,
      fullReadbackPointer: "/strayGate/priorWork",
      scope: result.priorWork.scope,
    });
    expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeLessThanOrEqual(4096);
    const selected = summary.reads as unknown[];
    expect(selected).toEqual(result.priorWork.reads.slice(0, selected.length));
    expect(summary.readsOmitted).toBe(readCount - selected.length);
    expect(result.priorWork.reads).toHaveLength(readCount);
  });
  it("marks a new implementation unresolved without a blanket veto or equivalence claim", async () => {
    const result = await originalPriorWorkProbe(await fixture("prior-work-new"), "new");
    expect(result.result?.ok).toBe(true);
    expect(result.priorWork.reads[0]).toMatchObject({ disposition: "unresolved_new_comparison" });
    expect(result.priorWork.reads[0].old).toBeUndefined();
    expect(result.priorWork.gaps).toContain(
      "prior_HEAD_source_absent:src/agents/finance-source-recovery.ts",
    );
  });

  it("keeps the actual blocker ahead of earlier partial gaps in the bounded Central summary", async () => {
    const result = await originalPriorWorkProbe(
      await fixture("prior-work-mixed-conflict"),
      "mixed_conflict",
    );
    expect(result.priorWork).toMatchObject({ status: "unknown", blocksPlan: true });
    const failure = result.priorWork.gaps.at(-1);
    expect(failure).toContain("prior_work_diff_changed");
    const gate = result.central?.byOwner.changeImpact.compact.strayGate as {
      priorWork: { gaps: string[]; gapIndices: number[]; cleanup: string };
    };
    expect(gate.priorWork.gaps[0]).toBe(failure);
    expect(gate.priorWork.gapIndices[0]).toBe(result.priorWork.gaps.length - 1);
    expect(gate.priorWork.cleanup).toBe("local_read_or_descendant_cleanup_unconfirmed");
    expect(Buffer.byteLength(JSON.stringify(gate.priorWork), "utf8")).toBeLessThanOrEqual(4096);
  });
  it("records a confirmed deletion as pending original cleanup review without deletion authority", async () => {
    const result = await originalPriorWorkProbe(await fixture("prior-work-deleted"), "deleted");
    expect(result.priorWork).toMatchObject({
      status: "observed",
      semanticEquivalence: "not_proven",
    });
    expect(result.priorWork.reads[0]).toMatchObject({
      current: { status: "deleted" },
      disposition: "deletion_pending_cleanup_review",
    });
    expect(result.priorWork.gaps).toContain(
      "original_cleanup_review_required:src/agents/finance-expectation-gap.ts",
    );
  });
  it("seals original read deadline failure even when a safe file read resolves later", async () => {
    const result = await originalPriorWorkProbe(await fixture("prior-work-late"), "late_read");
    expect(result.proof.lateResolved).toBe(true);
    expect(result.priorWork).toMatchObject({
      status: "unknown",
      blocksPlan: true,
      cleanup: "local_read_or_descendant_cleanup_unconfirmed",
    });
    expect(result.priorWork.reads).toEqual([]);
    const calls = result.proof.calls as { args: string[] }[];
    expect(calls.filter((call) => call.args[0] === "show")).toHaveLength(1);
  });
});

describe("original main consumes canonical owner dispositions before Central", () => {
  it("preserves the approved shared Universe owner and actually reads both owner sources", async () => {
    const result = await originalPriorWorkProbe(
      await fixture("canonical-shared"),
      "canonical_shared",
    );
    expect(result.result?.ok).toBe(true);
    const review = result.result?.strayGate.consolidation;
    expect(review).toMatchObject({ status: "observed", blocksPlan: false, conflicts: [] });
    expect(review?.routes[0]).toMatchObject({
      disposition: "preserve_existing_owner",
      source: { path: "scripts/operator/lcx-universe-index.ts" },
    });
    expect(review?.routes[0].sharedApproval).toContain("architecture supervision");
    expect(review?.routes[0].ownerSources.map((row) => row.path).toSorted()).toEqual([
      "scripts/operator/lcx-mind-model.ts",
      "scripts/operator/lcx-universe-index.ts",
    ]);
    expect(review?.routes[0].ownerSources.every((row) => /^[a-f0-9]{64}$/u.test(row.sha256))).toBe(
      true,
    );
    const centralGate = result.central?.byOwner.changeImpact.compact.strayGate as {
      consolidation: unknown;
    };
    expect(centralGate.consolidation).toMatchObject({ status: "observed", blocksPlan: false });
  });
  it("rejects an explicit loaded-declaration share/owner conflict through original main and Central", async () => {
    const result = await originalPriorWorkProbe(
      await fixture("canonical-conflict"),
      "canonical_conflict",
    );
    expect(result.result?.ok).toBe(false);
    expect(result.result?.strayGate.consolidation).toMatchObject({
      status: "unknown",
      blocksPlan: true,
    });
    expect(result.result?.strayGate.consolidation.conflicts).toContainEqual({
      path: "scripts/operator/lcx-universe-index.ts",
      reason: "cross_family_share_not_approved",
    });
    expect(result.result?.strayGate.consolidation.conflicts).toContainEqual({
      path: "scripts/operator/lcx-universe-index.ts",
      reason: "declared_owner_conflict:universe_inventory_entrypoints",
    });
    const centralGate = result.central?.byOwner.changeImpact.compact.strayGate as {
      consolidation: unknown;
    };
    expect(centralGate.consolidation).toMatchObject({ status: "unknown", blocksPlan: true });
    expect(result.central?.byOwner.changeImpact.ok).toBe(false);
  });
  it("retains an unmapped canonical owner as unknown without inferring semantic duplication", async () => {
    const result = await originalPriorWorkProbe(
      await fixture("canonical-unknown"),
      "canonical_unknown",
    );
    expect(result.result?.ok).toBe(true);
    expect(result.result?.strayGate.consolidation).toMatchObject({
      status: "partial",
      blocksPlan: false,
      conflicts: [],
    });
    expect(result.result?.strayGate.consolidation.routes[0]).toMatchObject({
      disposition: "owner_unresolved",
      ownerSources: [],
    });
    expect(result.result?.strayGate.consolidation.routes[0].gaps).toEqual([
      "canonical_owner_not_declared",
    ]);
    const centralGate = result.central?.byOwner.changeImpact.compact.strayGate as {
      consolidation: unknown;
    };
    expect(centralGate.consolidation).toMatchObject({ status: "partial", blocksPlan: false });
  });
});
