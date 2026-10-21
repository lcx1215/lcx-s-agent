import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { QUALITY_HARNESS_STAGES } from "../src/agents/quality-harness.js";
import { readSelfRepairCandidateReviewInput } from "../src/agents/self-repair-candidate-review.js";
import {
  probeOriginalSelfRepairContentReview,
  type SelfRepairContentReviewFault,
} from "./fixtures/lcx-waterflow-self-repair-review-probe.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function probe(name: string, fault?: SelfRepairContentReviewFault) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-self-repair-review-"));
  roots.push(directory);
  const result = await probeOriginalSelfRepairContentReview({ directory, fault });
  const retained = process.env.LCX_SELF_REPAIR_CONTENT_REVIEW_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
    await fs.cp(directory, path.join(retained, name), { recursive: true });
  }
  return result;
}

describe("actual self-repair candidate content -> original quality owner -> bound readback", () => {
  it("delivers all original candidate bodies and source binding to actual ten review stages", async () => {
    const result = await probe("content");
    expect(result.reviewed.status, JSON.stringify(result.reviewed)).toBe("needs_review");
    expect(result.reviewed.quality?.status).toBe("verified");
    expect(new Set(result.requests.map((request) => request.stage))).toEqual(
      new Set(QUALITY_HARNESS_STAGES),
    );
    for (const request of result.requests) {
      expect(request.evidence.find((item) => item.id === "self-repair-source")?.text).toBe(
        result.produced.sourceBody.trim(),
      );
      for (const [role, body] of [
        ["correction-downrank", result.produced.bodies.correction],
        ["training-candidates", result.produced.bodies.training],
        ["patch-candidates", result.produced.bodies.patch],
      ]) {
        expect(request.evidence.find((item) => item.id === `self-repair-${role}`)?.text).toBe(
          `candidate_under_review_not_original_source_fact\n${body}`.trim(),
        );
      }
      expect(request.sharedContext).toMatchObject({
        inputFingerprint: result.reviewed.inputFingerprint,
        selfRepairReviewScope: {
          scope: result.produced.scope,
          receipt: result.produced.receiptRef,
        },
      });
    }
    expect(result.reviewed.gaps).toContain("self_repair_semantic_acceptance_not_observed");
    expect(result.reviewed.quality?.execution.providerCallsMade).toBe("not-observed");
    expect(result.reviewed.quality?.evidenceCoverage?.passed).toBe(true);
    expect(result.promptReads.length).toBe(result.requests.length);
    for (const promptRead of result.promptReads) {
      expect(promptRead.evidenceCoverage?.includedEvidenceIds).toHaveLength(4);
      expect(promptRead.evidenceCoverage?.omittedEvidenceIds).toEqual([]);
      expect(promptRead.prompt).toContain(
        "Require fresh scoped evidence before provisional candidate reuse.",
      );
      expect(promptRead.prompt).toContain("candidate_under_review_not_original_source_fact");
    }
    expect(result.persistedReview).toEqual(result.reviewed);
    expect(result.reviewWriter.owner).toBe("writeSelfRepairContentReviewReceipt");
    expect(result.reviewWriter.receiptPath).toContain(
      path.join("state", "lcx-self-repair-content-review-latest.json"),
    );
    const reader = JSON.parse(result.safeReader!.stdout);
    expect(reader.contentReview).toMatchObject({
      status: "needs_review",
      gaps: ["self_repair_semantic_acceptance_not_observed"],
    });
    expect(result.compact?.contentReview).toEqual(reader.contentReview);
    const item = result.ownerMap?.items.find(
      (entry) => entry.id === "self_repair_memory_and_training_candidate_hands",
    );
    expect(item).toBeDefined();
    expect(item?.reason).toContain("候选内容审阅：needs_review");
    expect(result.candidateRootUnchangedAfterCli).toBe(true);
    expect(result.produced.writer).toMatchObject({
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
    });
  });

  it("checks the original candidate path guard with native Windows semantics", async () => {
    const source = await fs.readFile(
      new URL("../src/agents/self-repair-candidate-review.ts", import.meta.url),
      "utf8",
    );
    const receiptStart = source.indexOf("const receiptRef = reference.parse(");
    const receiptEnd = source.indexOf("const read =", receiptStart);
    expect(receiptStart).toBeGreaterThan(0);
    expect(receiptEnd).toBeGreaterThan(receiptStart);
    const normalizeReceipt = (receiptPath: string, nativePath: typeof path.win32) =>
      vm.runInNewContext(`${source.slice(receiptStart, receiptEnd)}; receiptRef.path`, {
        path: nativePath,
        reference: { parse: (value: unknown) => value },
        options: { receipt: { path: receiptPath, sha256: "a".repeat(64) } },
      }) as string;
    expect(normalizeReceipt(String.raw`state\receipt.json`, path.win32)).toBe("state/receipt.json");
    expect(normalizeReceipt("state/receipt.json", path.win32)).toBe("state/receipt.json");
    expect(normalizeReceipt(String.raw`state\receipt.json`, path.posix)).toBe(
      String.raw`state\receipt.json`,
    );
    const first = source.indexOf("const relativePath =");
    const last = source.indexOf("const text = await read(relativePath)", first);
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first);
    const originalGuard = source.slice(first, last);
    const workspaceDir = String.raw`C:\work\lcx`;
    const role = "correction-downrank";
    const evaluate = (filePath: string) =>
      vm.runInNewContext(`${originalGuard}; relativePath`, {
        path: path.win32,
        options: { workspaceDir },
        filePath,
        role,
      }) as string;
    expect(evaluate(path.win32.join(workspaceDir, "memory", "self-repair", role, "a.md"))).toBe(
      "memory/self-repair/correction-downrank/a.md",
    );
    expect(() => evaluate(String.raw`C:\outside\a.md`)).toThrow(
      "self_repair_review_candidate_path_invalid",
    );
    expect(() =>
      evaluate(path.win32.join(workspaceDir, "memory", "self-repair", role, "nested", "a.md")),
    ).toThrow("self_repair_review_candidate_path_invalid");
  });

  it.skipIf(path.sep === "\\")(
    "rejects a POSIX literal backslash candidate without redirecting its declared path",
    async () => {
      const result = await probe("literal-backslash-path");
      const workspaceDir = path.dirname(path.dirname(result.produced.sourcePath));
      const receipt = JSON.parse(result.produced.receiptBytes) as typeof result.produced.writer;
      receipt.hands.memoryCleaner.path = path.join(
        workspaceDir,
        `memory\\self-repair\\correction-downrank\\${path.basename(result.produced.writer.hands.memoryCleaner.path)}`,
      );
      const body = JSON.stringify(receipt) + "\n";
      const relativePath = "state/literal-backslash-receipt.json";
      await fs.writeFile(path.join(workspaceDir, relativePath), body);
      await expect(
        readSelfRepairCandidateReviewInput({
          workspaceDir,
          receipt: { path: relativePath, sha256: createHash("sha256").update(body).digest("hex") },
          scope: result.produced.scope,
        }),
      ).rejects.toThrow("self_repair_review_candidate_path_invalid");
    },
  );

  it.each(["source_missing", "source_hash", "receipt_hash", "body_mismatch", "scope"] as const)(
    "rejects actual %s input before model review",
    async (fault) => {
      const result = await probe(fault, fault);
      expect(result.reviewed.status).toBe("failed");
      const expectedGap = {
        source_missing: "file not found",
        source_hash: "self_repair_review_source_hash_mismatch",
        receipt_hash: "self_repair_review_receipt_hash_mismatch",
        body_mismatch: "self_repair_review_body_mismatch:correction-downrank",
        scope: "self_repair_review_scope_mismatch",
      }[fault];
      expect(result.reviewed.gaps).toContain(expectedGap);
      expect(result.requests).toEqual([]);
      expect(result.reviewed.quality).toBeUndefined();
    },
  );

  it("retains actual quality rejection without semantic acceptance", async () => {
    const result = await probe("quality_reject", "quality_reject");
    expect(result.reviewed.quality?.quality.passed).toBe(false);
    expect(result.reviewed.gaps).toContain(
      `self_repair_review_quality:${result.reviewed.quality?.status}`,
    );
    expect(result.reviewed.gaps).toContain("self_repair_semantic_acceptance_not_observed");
  });

  it("rejects an actual persisted A review for a newly written B candidate", async () => {
    const result = await probe("old_review", "old_review");
    expect(result.reviewed.quality?.status).toBe("verified");
    expect(result.revisedInput?.inputFingerprint).not.toBe(result.reviewed.inputFingerprint);
    expect(result.revisedInput?.taskSha256).not.toBe(result.reviewed.quality?.task.sha256);
    expect(result.oldInspection).toEqual({
      status: "failed",
      gaps: ["self_repair_review_quality_input_mismatch"],
    });
    expect(result.oldWriteRejection).toBeDefined();
    expect(result.oldWriteRejection?.error).toBe("self_repair_review_quality_input_mismatch");
    expect(result.oldWriteRejection?.sidecarBeforeBytes).toBe(result.persistedReviewBytes);
    expect(result.oldWriteRejection?.sidecarAfterBytes).toBe(
      result.oldWriteRejection?.sidecarBeforeBytes,
    );
    expect(result.oldWriteRejection?.rootBeforeBytes).toBe(result.revised?.receiptBytes);
    expect(result.oldWriteRejection?.rootAfterBytes).toBe(
      result.oldWriteRejection?.rootBeforeBytes,
    );
  });

  it("keeps deadline failure terminal when a scripted role response arrives late", async () => {
    const result = await probe("timeout", "timeout");
    expect(result.reviewed).toMatchObject({
      status: "failed",
      gaps: ["self_repair_review_deadline"],
    });
    expect(result.requests[0]?.stage).toBe("intake");
    expect(result.delayedAdapterEnteredAtMs).toBeDefined();
    expect(result.delayedAdapterCompletedAtMs).toBeDefined();
    expect(result.delayedAdapterEnteredAtMs!).toBeLessThan(result.reviewReturnedAtMs);
    expect(result.delayedAdapterCompletedAtMs!).toBeGreaterThan(result.reviewReturnedAtMs);
    expect(result.responses[0]?.request.stage).toBe("intake");
    expect(result.lateAttempted).toBe(true);
    expect(result.terminalUnchangedAfterLateCompletion).toBe(true);
    expect(result.reviewed.quality).toBeUndefined();
    expect(result.reviewed.cleanup).toBe("local_listener_released_model_cleanup_unconfirmed");
  }, 10000);

  it.each(["cli_no_adapter", "cli_source_gap"] as const)(
    "surfaces original %s through CLI safe reader, governance compact and owner map",
    async (fault) => {
      const result = await probe(fault, fault);
      const cli = JSON.parse(result.cliReview!.stdout);
      const reader = JSON.parse(result.safeReader!.stdout);
      expect(cli.contentReview.status).toBe("failed");
      expect(reader.contentReview.status).toBe("failed");
      expect(result.compact?.contentReview).toEqual(reader.contentReview);
      const item = result.ownerMap?.items.find(
        (entry) => entry.id === "self_repair_memory_and_training_candidate_hands",
      );
      expect(item).toBeDefined();
      expect(item?.reason).toContain("候选内容审阅：failed");
      expect(result.candidateRootUnchangedAfterCli).toBe(true);
      expect(reader).toMatchObject({
        candidateOnly: true,
        reuseAllowed: false,
        semanticTruth: "not_proven",
      });
      if (fault === "cli_no_adapter") {
        expect(cli.contentReview.gaps).toContain("self_repair_review_model_unavailable");
      } else {
        expect(reader.contentReview.gaps.length).toBeGreaterThan(0);
        expect(reader.contentReview.gaps).not.toContain("self_repair_review_model_unavailable");
      }
    },
  );
  it("keeps unscoped original safe readback not_observed without inventing a failure", async () => {
    const result = await probe("cli_scope_unavailable", "cli_scope_unavailable");
    const reader = JSON.parse(result.safeReader!.stdout);
    expect(reader.contentReview).toMatchObject({
      status: "not_observed",
      gaps: ["self_repair_review_host_scope_unavailable"],
    });
    expect(result.compact?.contentReview).toEqual(reader.contentReview);
    expect(result.candidateRootUnchangedAfterCli).toBe(true);
  });

  it.each(["cli_internal_alias", "cli_external_escape"] as const)(
    "rejects original %s review write without changing the target or candidate receipt",
    async (fault) => {
      const result = await probe(fault, fault);
      expect(result.writeFault).toBeDefined();
      expect(result.writeFault?.error).not.toBe("");
      expect(result.writeFault?.exitCode).toBe(1);
      const rejected = JSON.parse(result.writeFault!.stdout);
      expect(rejected).toMatchObject({
        kind: "lcx-self-repair-hands",
        status: "failed",
        ok: false,
        candidateOnly: true,
        reuseAllowed: false,
        semanticTruth: "not_proven",
        contentReview: { status: "failed" },
      });
      const writeFailure =
        fault === "cli_internal_alias"
          ? "self_repair_review_write_failed:self_repair_review_write_alias_rejected"
          : "self_repair_review_write_failed:path alias escape blocked";
      expect(rejected.contentReview.gaps).toContain(writeFailure);
      expect(result.writeFault?.after).toBe(result.writeFault?.before);
      expect(result.candidateRootUnchangedAfterCli).toBe(true);
      expect(result.cliReview).toBeUndefined();
    },
  );
  it("retains original coverage failure for a bare scripted modelInvoker", async () => {
    const result = await probe("coverage_missing", "coverage_missing");
    expect(result.reviewed.quality?.status).toBe("quality-failed");
    expect(result.reviewed.quality?.evidenceCoverage?.passed).toBe(false);
    expect(result.reviewed.quality?.evidenceCoverage?.issues).toContain(
      "evidence_coverage_attestation_missing:data_cleaning",
    );
    expect(result.requests.length).toBeGreaterThan(0);
    expect(result.promptReads).toEqual([]);
    expect(result.reviewed.gaps).toContain("self_repair_review_quality:quality-failed");
  });
});
