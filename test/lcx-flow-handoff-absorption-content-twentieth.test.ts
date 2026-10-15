import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  probeAbsorptionContentTwentieth,
  saveAbsorptionContentProof,
} from "./fixtures/lcx-waterflow-absorption-content-twentieth-probe.js";

let workspaceDir: string;
beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-absorption-content-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("real_network_forbidden")));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("original absorption gate independently consumes original content review", () => {
  it.each([false, true])(
    "uses native source/candidate findings in this cycle's hold guidance: contradictory=%s",
    async (contradictory) => {
      const result = await probeAbsorptionContentTwentieth({ workspaceDir, contradictory });
      expect(result.gate).toMatchObject({
        absorptionReady: false,
        gateDecision: "hold_at_application_ready",
        notPromoted: true,
        writeAvailable: false,
        writtenAbsorptionReceipts: [],
        blockers: expect.arrayContaining([
          "hardened_eval_evidence_missing",
          "module_receipts_not_eval_absorbed",
        ]),
        contentReviewReadback: { status: "needs_review" },
        contentReviewByReceipt: [
          {
            receiptPath: result.producer.request.planReceipt.path,
            receiptSha256: result.producer.request.planReceipt.sha256,
            attemptScope: {
              accountId: "private-fixture-account",
              runId: "private-content-review-run",
            },
            upstreamScope: "not_observed",
            gaps: expect.arrayContaining([
              "application_content_acceptance_not_observed",
              "license_permission_not_verified",
              "operator_signoff_not_observed",
            ]),
          },
        ],
      });
      const serialized = JSON.stringify(result.gate);
      if (contradictory) {
        expect(serialized).toContain("candidate_reverses_actual_source_review_requirement");
        expect(result.gate?.nextActions).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              "Candidate conflicts with the source's explicit review requirement. Hold this candidate.",
            ),
          ]),
        );
      } else {
        expect(serialized).not.toContain("candidate_reverses_actual_source_review_requirement");
        expect(result.gate?.nextActions).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              "Candidate retains source identity; permission and actual effectiveness remain unknown.",
            ),
          ]),
        );
      }
      expect(result.reviewReceiptUnchanged).toBe(true);
      expect(result.producer.callsAfterGate).toBe(result.producer.callsBeforeGate);
      expect(result.observations).toEqual([]);
      await saveAbsorptionContentProof(
        workspaceDir,
        contradictory ? "contradiction" : "consistent",
        result,
      );
    },
    25_000,
  );

  it("retains a concrete finding in repair guidance when the answer is generic", async () => {
    const result = await probeAbsorptionContentTwentieth({
      workspaceDir,
      contradictory: true,
      genericAnswer: true,
    });
    expect(result.gate?.nextActions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("candidate_reverses_actual_source_review_requirement"),
      ]),
    );
    expect(result.gate?.absorptionReady).toBe(false);
    expect(result.producer.callsAfterGate).toBe(result.producer.callsBeforeGate);
    expect(result.observations).toEqual([]);
    await saveAbsorptionContentProof(workspaceDir, "generic-answer-concrete-finding", result);
  }, 25_000);

  it.each([
    "missing_receipt",
    "receipt_hash",
    "foreign_scope",
    "missing_host",
    "source_changed",
    "root_escape",
  ] as const)(
    "preserves full native failed readback for %s without adoption or repeated model calls",
    async (fault) => {
      const result = await probeAbsorptionContentTwentieth({ workspaceDir, fault });
      expect(result.gate).toMatchObject({
        absorptionReady: false,
        gateDecision: "hold_at_application_ready",
        writtenAbsorptionReceipts: [],
        contentReviewReadback: { status: "failed", findings: [] },
      });
      const readback = result.gate?.contentReviewReadback as { gaps: string[] };
      expect(readback.gaps.length).toBeGreaterThan(0);
      const expectedGap = {
        missing_receipt: "file not found",
        receipt_hash: "module_content_review_receipt_hash_mismatch",
        foreign_scope: "module_content_review_input_mismatch",
        missing_host: "module_content_review_host_scope_missing",
        source_changed: "module_content_review_hash_mismatch:source",
        root_escape: "file is outside workspace root",
      }[fault];
      expect(readback.gaps.join("\n")).toContain(expectedGap);
      if (fault === "missing_receipt") {
        expect(result.gate?.requestedContentReviewReceipt).toMatchObject({
          path: "missing-content-review.json",
        });
      }
      expect(result.gate?.nextActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Restore the content review handoff:")]),
      );
      expect(result.observations).toEqual([]);
      expect(JSON.stringify(result.gate)).not.toContain("private-outside-review-must-not-be-read");
      expect(result.producer.callsAfterGate).toBe(result.producer.callsBeforeGate);
      await saveAbsorptionContentProof(workspaceDir, fault, result);
    },
    25_000,
  );

  it("shows actual contradiction and failure causes in the original human text receipt", async () => {
    const conflict = await probeAbsorptionContentTwentieth({
      workspaceDir,
      contradictory: true,
      json: false,
    });
    expect(conflict.stdout).toContain("content_review=needs_review");
    expect(conflict.stdout).toContain("candidate_reverses_actual_source_review_requirement");
    expect(conflict.stdout).toContain("Hold this candidate.");
    expect(conflict.stdout).toContain("absorption_ready=false");
    await saveAbsorptionContentProof(workspaceDir, "human-contradiction", conflict);
    const failed = await probeAbsorptionContentTwentieth({
      workspaceDir,
      fault: "receipt_hash",
      json: false,
    });
    expect(failed.stdout).toContain("content_review=failed");
    expect(failed.stdout).toContain("module_content_review_receipt_hash_mismatch");
    expect(failed.stdout).toContain("absorption_ready=false");
    expect(failed.observations).toEqual([]);
    await saveAbsorptionContentProof(workspaceDir, "human-failed", failed);
  }, 45_000);

  it("preserves legacy no-optional hold while the saved native contradiction is not consumed", async () => {
    const result = await probeAbsorptionContentTwentieth({
      workspaceDir,
      contradictory: true,
      includeContentReview: false,
    });
    expect(JSON.stringify(result.producer.written)).toContain(
      "candidate_reverses_actual_source_review_requirement",
    );
    expect(JSON.stringify(result.gate)).not.toContain(
      "candidate_reverses_actual_source_review_requirement",
    );
    expect(result.gate).toMatchObject({
      absorptionReady: false,
      gateDecision: "hold_at_application_ready",
      blockers: expect.arrayContaining(["hardened_eval_evidence_missing"]),
    });
    expect(result.observations).toEqual([]);
    expect(result.producer.callsAfterGate).toBe(result.producer.callsBeforeGate);
    await saveAbsorptionContentProof(workspaceDir, "default-original-gap", result);
  }, 25_000);
});
