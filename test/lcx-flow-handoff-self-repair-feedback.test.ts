import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { buildSelfRepairHandsReceipt } from "../scripts/operator/lcx-self-repair-hands.js";
import {
  probeOriginalSelfRepairFeedback,
  type FeedbackFault,
} from "./fixtures/lcx-waterflow-self-repair-feedback-probe.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function probe(name: string, fault?: FeedbackFault) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-self-repair-feedback-"));
  roots.push(directory);
  const result = await probeOriginalSelfRepairFeedback({ directory, fault });
  const retained = process.env.LCX_SELF_REPAIR_FEEDBACK_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
    await fs.cp(directory, path.join(retained, name), { recursive: true });
  }
  return result;
}

// The native snapshot precedes fulfilled publication; CLI completion adds its own write pin.
function expectPersistedCandidate(
  result: Awaited<ReturnType<typeof probeOriginalSelfRepairFeedback>>,
) {
  const output = result.output as ReturnType<typeof buildSelfRepairHandsReceipt>;
  const persisted = result.persisted as ReturnType<typeof buildSelfRepairHandsReceipt>;
  const project = (receipt: typeof output) => {
    if (!receipt.processEvidence) {
      throw new Error("original_writer_evidence_missing");
    }
    const {
      status: _status,
      publication: _publication,
      successfulWrites,
      ...writer
    } = receipt.processEvidence.writer;
    return {
      ...receipt,
      writtenArtifacts: receipt.writtenArtifacts.filter((file) => file !== receipt.latestJsonPath),
      processEvidence: {
        ...receipt.processEvidence,
        writer: {
          ...writer,
          successfulWrites: successfulWrites.filter((item) => item.field !== "/latestJsonPath"),
        },
      },
    };
  };
  expect(project(persisted)).toEqual(project(output));
  expect(persisted.processEvidence?.writer).toMatchObject({
    status: "writing",
    publication: "pending_in_snapshot",
  });
  expect(output.processEvidence?.writer).toMatchObject({
    status: "completed",
    publication: "completed_after_await",
  });
}

describe("completed original owner-map -> explicitly requested self-repair diagnostic", () => {
  it("consumes the actual source blocker in new candidate bodies without granting reuse", async () => {
    const result = await probe("source_blocked_diagnostic");
    expect(result.selectedItem).toMatchObject({ status: "blocked_now" });
    expect(result.selectedItem?.reason).toContain("source_sha256_mismatch");
    expect(result.consumer.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      status: "write_completed",
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
      sourceReview: { requested: false, status: "not_requested" },
      diagnosticFeedback: { requested: true, status: "read", semanticTruth: "not_proven" },
    });
    expectPersistedCandidate(result);
    for (const body of Object.values(result.bodies)) {
      expect(body).toContain("source_sha256_mismatch");
    }
    expect(result.bodies.memoryCleaner).toContain(result.rule);
    const patch = JSON.parse(result.bodies.patchCandidateBuilder!) as {
      proposedPatchContract: { replacementRule: string };
    };
    expect(patch.proposedPatchContract.replacementRule).toBe(result.rule);
    const training = JSON.parse(result.bodies.trainingCaseBuilder!) as {
      trainExampleCandidate: { prompt: string };
    };
    expect(training.trainExampleCandidate.prompt).toContain(result.selectedItem!.reason);
    expect(result.bodies.memoryCleaner).toContain(result.selectedItem!.nextControl);
    expect(result.readbackOutput.latestWrittenReceipt).toMatchObject({ status: "write_completed" });
    expect(result.host.sourceRunId).not.toBe(result.output.signalKey);
  });

  it.each([
    "hash",
    "missing",
    "cross_governance",
    "cross_host",
    "standalone",
    "duplicate",
    "missing_item",
    "host_snapshot_missing",
    "item_status_array",
  ] as const)("blocks requested %s feedback with a complete native receipt", async (fault) => {
    const result = await probe(fault, fault);
    expect(result.consumer.exitCode).toBe(1);
    expect(result.output).toMatchObject({
      ok: false,
      status: "blocked",
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
      diagnosticFeedback: { requested: true, status: "blocked" },
    });
    const feedback = result.output.diagnosticFeedback as { blockers: string[] };
    expect(feedback.blockers.length).toBeGreaterThan(0);
    expect(feedback.blockers.join(" ")).toMatch(
      /hash|sha|read|missing|scope|snapshot|run|duplicate|item/iu,
    );
    expectPersistedCandidate(result);
    expect(Object.values(result.bodies)).toEqual([undefined, undefined, undefined]);
    expect(result.readbackOutput.latestWrittenReceipt).toMatchObject({ status: "blocked" });
  });

  it("re-reads the actual source before writing and never restores a failed feedback attempt", async () => {
    const result = await probe("changed_before_write", "changed_before_write");
    expect(result.initialFeedback).toMatchObject({ status: "read" });
    expect(result.changedMapBytesBeforeWrite).not.toBe(result.consumedMapBytes);
    expect(result.firstWriteOutput).toMatchObject({
      status: "blocked",
      diagnosticFeedback: { blockers: ["owner_map_feedback_map_hash_conflict"] },
    });
    // Re-publication updates fulfilled I/O pins, but cannot revive candidate eligibility.
    expect(result.recoveryOutput).toMatchObject({
      status: "blocked",
      ok: false,
      diagnosticFeedback: result.firstWriteOutput?.diagnosticFeedback,
      sourceReview: result.firstWriteOutput?.sourceReview,
      hands: result.firstWriteOutput?.hands,
      reuseAllowed: false,
      processEvidence: {
        gates: { candidateWritesAllowed: false },
        writer: {
          candidateEligibility: false,
          publicationInputs: { candidateWritesAllowed: false },
        },
      },
    });
    expect(result.output).toMatchObject({
      status: "blocked",
      ok: false,
      diagnosticFeedback: { status: "blocked", blockers: ["owner_map_feedback_map_hash_conflict"] },
      reuseAllowed: false,
    });
    expectPersistedCandidate(result);
    expect(Object.values(result.bodies)).toEqual([undefined, undefined, undefined]);
    expect(result.readbackOutput.latestWrittenReceipt).toMatchObject({ status: "blocked" });
  });

  it("reads never-auto diagnostic text without converting it into permission", async () => {
    const result = await probe("never_auto", "never_auto");
    expect(result.selectedItem).toMatchObject({ status: "never_auto", codexCanActWhenSafe: false });
    expect(result.output).toMatchObject({
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
      diagnosticFeedback: { status: "read", itemStatus: "never_auto" },
    });
    expect(result.bodies.memoryCleaner).toContain(result.selectedItem!.reason);
    expect(result.output.notTouched).toContain("protected_memory");
  });
});
