import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCentralEvidenceUse } from "../src/agents/central-harness/evidence-use.js";
import {
  probeOriginalMemoryCorrection,
  type MemoryCorrectionFault,
} from "./fixtures/lcx-waterflow-memory-correction-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function probe(fault?: MemoryCorrectionFault, replacementRule?: string, gateRepo?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network forbidden");
    }),
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "original-memory-correction-"));
  roots.push(root);
  return probeOriginalMemoryCorrection(root, fault, replacementRule, gateRepo);
}
describe("original correction downrank review and actual next-input handoffs", () => {
  it("source-checks the original provisional note, consumes exact text and feeds the persisted result into another cycle", async () => {
    const result = await probe();
    expect(result.gate).toMatchObject({
      status: "ready",
      recallClaimReady: true,
      correctionReview: {
        status: "verified_provisional_downrank",
        downrankDecision: "downrank",
        reuseAllowed: false,
        semanticTruth: "not_proven",
      },
    });
    expect(result.consumedReview).toEqual(result.gate);
    expect(result.receipts).toHaveLength(4);
    expect(result.receipts[2].evidenceUse?.[0]).toMatchObject({
      verification: "reference_verified",
      effect: "change",
    });
    expect(result.receipts[2].steps).toEqual([]);
    expect(result.feedbackObserved).toBe(true);
    expect(result.wholeScene).toContain("partial");
    expect(fetch).not.toHaveBeenCalled();
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.mkdir(proofDir, { recursive: true });
      await fs.writeFile(
        path.join(proofDir, "memory-correction-owner-proof.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      await fs.writeFile(path.join(proofDir, "native-correction.md"), result.correctionBody);
      await fs.writeFile(
        path.join(proofDir, "native-writer.json"),
        await fs.readFile(result.writer.latestJsonPath),
      );
      await fs.writeFile(
        path.join(proofDir, "native-review.json"),
        await fs.readFile(result.gatePath),
      );
      await fs.writeFile(
        path.join(proofDir, "native-source.json"),
        await fs.readFile(path.join(result.writer.workspaceDir, result.manifest.source.path)),
      );
      const archive = result.receipts[0].steps[0].outcome?.artifactEvidence as
        | { relativePath?: string; sha256?: string }
        | undefined;
      expect(typeof archive?.relativePath).toBe("string");
      const archiveBody = await fs.readFile(
        path.join(result.writer.workspaceDir, archive!.relativePath!),
      );
      expect(createHash("sha256").update(archiveBody).digest("hex")).toBe(archive!.sha256);
      await fs.writeFile(path.join(proofDir, "native-read-artifact.json"), archiveBody);
      for (const index of result.receipts.keys()) {
        await fs.writeFile(
          path.join(proofDir, `native-cycle-${index + 1}.json`),
          await fs.readFile(
            path.join(result.writer.workspaceDir, "state", `memory-cycle-${index + 1}.json`),
          ),
        );
        await fs.writeFile(
          path.join(proofDir, `native-input-${index + 1}.json`),
          `${JSON.stringify(result.perceptions[index], null, 2)}\n`,
        );
      }
    }
  });
  it.each([
    ["missing_source", "source_evidence_unreadable"],
    ["source_hash", "source_sha256_mismatch"],
    ["correction_hash", "correction_sha256_mismatch"],
    ["account_scope", "correction_source_scope_mismatch"],
    ["run_scope", "correction_source_scope_mismatch"],
    ["rule_drift", "correction_replacement_rule_source_mismatch"],
    ["stale_source", "correction_source_not_fresh"],
    ["future_source", "correction_source_not_fresh"],
    ["missing_downrank", "correction_downrank_boundary_missing"],
    ["protected_unknown", "protected_repo_memory_dirty_or_unreadable"],
  ] as const)(
    "keeps %s in the actual unresolved next input with no downstream read",
    async (fault, gap) => {
      const result = await probe(fault);
      expect(result.gate).toMatchObject({ status: "blocked", recallClaimReady: false });
      expect(result.gate.blockers).toContain(gap);
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0].steps).toEqual([]);
      expect(result.receipts[0].brainCall.note).toContain(gap);
      expect(result.perceptions[0].controlRoom.memoryReview).toEqual(result.gate);
      expect(result.feedbackObserved).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
      if (proofDir) {
        await fs.mkdir(proofDir, { recursive: true });
        await fs.writeFile(
          path.join(proofDir, `memory-correction-${fault}-proof.json`),
          `${JSON.stringify(result, null, 2)}\n`,
        );
      }
    },
  );
  it("refuses missing delivery, wrong hash and cross-account attribution after a legitimate review", async () => {
    const result = await probe();
    const use = result.receipts[2].evidenceUse![0];
    const input = result.perceptions[2];
    expect(verifyCentralEvidenceUse([use], { ...input, backlog: [] })[0]).toMatchObject({
      verification: "invalid_reference",
      gap: "matching_read_not_delivered",
    });
    expect(
      verifyCentralEvidenceUse([{ ...use, sourceSha256: "0".repeat(64) }], input)[0].verification,
    ).toBe("invalid_reference");
    expect(
      verifyCentralEvidenceUse([{ ...use, scope: { accountId: "other-account" } }], input)[0],
    ).toMatchObject({ verification: "invalid_reference", gap: "source_scope_mismatch" });
  });
});
