import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeExternalAbsorption,
  type ExternalAbsorptionFault,
} from "./fixtures/lcx-waterflow-external-absorption-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected native readback record");
  }
  return value as Record<string, unknown>;
}
async function run(fault?: ExternalAbsorptionFault) {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External Skill provider forbidden"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-external-absorption-"));
  roots.push(workspace);
  const proofDir = process.env.LCX_EXTERNAL_ABSORPTION_PROOF_DIR
    ? path.join(process.env.LCX_EXTERNAL_ABSORPTION_PROOF_DIR, fault ?? "normal")
    : path.join(workspace, "private-proof");
  return probeExternalAbsorption({ workspaceDir: workspace, proofDir, fault });
}
function selected(result: Awaited<ReturnType<typeof run>>) {
  const rows = record(result.consumerReadback.consumedReview).selectedReceipts;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Original gate must read exactly this source receipt");
  }
  return record(rows[0]);
}
describe("external Skill original producer to independent absorption gate", () => {
  it.each([undefined, "candidate_content_conflict"] as const)(
    "retains content hold with actual CLI readback: %s",
    async (fault) => {
      const result = await run(fault);
      expect(result.consumerReadback).toEqual(result.consumer);
      expect(result.consumerReadback).toMatchObject({
        absorptionReady: false,
        gateDecision: "hold_at_application_ready",
        reviewReadMode: "fresh_read_only",
        notPromoted: true,
        writeAvailable: false,
        writtenAbsorptionReceipts: [],
        latestEval: null,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      });
      expect(result.producerReceiptUnchanged).toBe(true);
      expect(selected(result)).toMatchObject({
        targetModule: "skill_pattern_distillation",
        status: "application_ready",
        receiptSha256: result.producerReceiptSHA256,
        evaluationVerified: true,
        missingEvidence: expect.arrayContaining(["application_content_acceptance_not_observed"]),
      });
      expect(result.consumerReadback.nextProofQueue).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nextProofOwner: "module_learning_pipeline_apply_validation",
          }),
        ]),
      );
      expect(record(result.consumerReadback.consumedReview).hostScope).toEqual({
        workspaceId: result.hostWorkspaceSHA256,
        runId: null,
      });
      expect(result.canonicalRunIdentity).toContain("unavailable");
      expect(result.producer.unresolved).toContain("license_legal_review");
      expect(result.producer.centralBudgetPathExercised).toBe(false);
      expect(result.stderr).toBe("");
    },
  );
  it("keeps missing body before plan as a missing selected receipt, never a supplied fake review", async () => {
    const result = await run("missing_source");
    expect(result.producer.plan).toBeNull();
    expect(result.producer.review).toBeNull();
    expect(result.consumerReadback.absorptionReady).toBe(false);
    expect(record(result.consumerReadback.consumedReview).gaps).toContain(
      "selected_source_module_receipt_missing",
    );
    expect(record(result.consumerReadback.counts).planReceiptFiles).toBe(0);
  });
  it.each(["hash_conflict", "body_removed_after_plan", "eval_removed_after_plan"] as const)(
    "actually re-reads source/eval and refuses its lost byte verification: %s",
    async (fault) => {
      const result = await run(fault);
      expect(result.consumerReadback.absorptionReady).toBe(false);
      expect(selected(result).evaluationVerified).toBe(false);
      expect(result.producerReceiptUnchanged).toBe(true);
      expect(result.consumerReadback.blockers).toContain("module_receipts_not_eval_absorbed");
      expect(selected(result).missingEvidence).toContain(
        "unverified_source_bound_application_eval",
      );
      if (fault === "body_removed_after_plan") {
        expect(result.producer.review?.rows).toEqual(
          expect.arrayContaining([expect.objectContaining({ evaluationVerified: true })]),
        );
      }
      if (fault === "eval_removed_after_plan") {
        expect(record(result.consumerReadback.consumedReview).gaps).toContain(
          "selected_evidence_unreadable:local/eval.json",
        );
      }
    },
  );
  it.each([
    ["registry_pin_conflict", "selected_source_hash_conflict"],
    ["receipt_pin_conflict", "selected_receipt_hash_conflict"],
    ["cross_workspace", "selected_source_module_receipt_missing"],
  ] as const)("refuses %s at the original CLI byte/scope read seam", async (fault, reason) => {
    const result = await run(fault);
    expect(result.consumerReadback.gateDecision).toBe("hold_at_application_ready");
    expect(result.consumerReadback.absorptionReady).toBe(false);
    expect(record(result.consumerReadback.consumedReview).gaps).toContain(reason);
    expect(result.consumerReadback.blockers).toContain(reason);
    expect(result.producerReceiptUnchanged).toBe(true);
    expect(result.consumerReadback.writtenAbsorptionReceipts).toEqual([]);
  });
});
