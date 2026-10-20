import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeOriginalSelfRepairOwnerMap,
  type SelfRepairOwnerMapFault,
  type SelfRepairReaderFault,
} from "./fixtures/lcx-waterflow-self-repair-owner-map-probe.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function probe(
  name: string,
  options: {
    fault?: SelfRepairOwnerMapFault;
    readerFault?: SelfRepairReaderFault;
    governanceSourcePath?: string;
    controlMapSourcePath?: string;
  } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-self-repair-owner-map-"));
  roots.push(directory);
  const result = await probeOriginalSelfRepairOwnerMap({ directory, ...options });
  const retained = process.env.LCX_SELF_REPAIR_OWNER_MAP_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
    await fs.cp(directory, path.join(retained, name), { recursive: true });
  }
  return result;
}

const reasons = {
  missing: "source_evidence_unreadable",
  hash: "source_sha256_mismatch",
  scope: "correction_source_scope_mismatch",
  stale: "correction_source_not_fresh",
  future: "correction_source_not_fresh",
};
const selfRepairItem = (items: { id: string; status: string; reason: string }[]) =>
  items.find((item) => item.id === "self_repair_memory_and_training_candidate_hands");

describe("original self-repair safe reader -> governance -> owner control map", () => {
  const beforeSources = process.env.LCX_SELF_REPAIR_OWNER_MAP_BEFORE_SOURCES;
  it.skipIf(!beforeSources)(
    "reproduces the frozen original compaction and map failure",
    async () => {
      const result = await probe("before-compact-map", {
        fault: "hash",
        governanceSourcePath: path.join(
          beforeSources!,
          "scripts/operator/lcx-governance-autopilot.ts",
        ),
        controlMapSourcePath: path.join(
          beforeSources!,
          "scripts/operator/lcx-owner-control-map.ts",
        ),
      });
      expect(result.nativeWriter).toMatchObject({
        status: "blocked",
        sourceReview: { blockers: ["source_sha256_mismatch"] },
      });
      expect(result.directOwner.runReceipt.status).toBe("blocked");
      expect(result.directOwner.compact.sourceReview).toBeUndefined();
      expect(selfRepairItem(result.direct.map.items)?.status).toBe("codex_can_act_when_safe");
      expect(selfRepairItem(result.direct.map.items)?.reason).not.toContain(
        "source_sha256_mismatch",
      );
      // Writer and reader are current CLI; only the two frozen original consumer sources are replayed.
      // The independent before-reader stdout preserves the original earlier loss before compaction.
      expect(selfRepairItem(result.reader.map.items)?.status).toBe("codex_can_act_when_safe");
    },
  );
  it.each(Object.keys(reasons) as SelfRepairOwnerMapFault[])(
    "preserves current %s source block after a prior provisional write",
    async (fault) => {
      const result = await probe(fault, { fault });
      expect(JSON.parse(result.prior.stdout).status).toBe("write_completed");
      expect(result.nativeWriter).toMatchObject({
        ok: false,
        status: "blocked",
        reuseAllowed: false,
        semanticTruth: "not_proven",
        sourceReview: { status: "blocked", blockers: [reasons[fault]] },
      });
      const snapshot = structuredClone(result.persistedWriter);
      const completed = structuredClone(result.nativeWriter);
      expect(snapshot.processEvidence).toMatchObject({
        writer: { status: "writing", publication: "pending_in_snapshot" },
      });
      expect(completed.processEvidence).toMatchObject({
        writer: { status: "completed", publication: "completed_after_await" },
      });
      // A receipt cannot include the hash of its own completed write. Compare business contents
      // exactly while checking the publication snapshot and awaited completion separately.
      delete (snapshot.processEvidence as Record<string, unknown>).writer;
      delete (completed.processEvidence as Record<string, unknown>).writer;
      delete snapshot.writtenArtifacts;
      delete completed.writtenArtifacts;
      expect(snapshot).toEqual(completed);
      expect(result.candidateExists).toBe(false);
      expect(result.directOwner.runReceipt).toMatchObject({
        status: "blocked",
        parentRunId: result.parentRunId,
        snapshot: result.snapshot,
      });
      expect(result.directOwner.compact.sourceReview).toMatchObject({ blockers: [reasons[fault]] });
      const direct = selfRepairItem(result.direct.map.items);
      expect(direct?.status).toBe("blocked_now");
      expect(direct?.reason).toContain(reasons[fault]);
      const latest = result.readerOwner.compact.latestWrittenReceipt;
      expect(latest).toMatchObject({
        status: "blocked",
        sourceReview: { blockers: [reasons[fault]] },
        reuseAllowed: false,
      });
      const reader = selfRepairItem(result.reader.map.items);
      expect(reader?.status).toBe("blocked_now");
      expect(reader?.reason).toContain(reasons[fault]);
      expect(reader?.reason).not.toContain("已经能自己写");
    },
  );

  it("keeps reference-consistent writes provisional with no replacement or learned truth", async () => {
    const result = await probe("candidate_only");
    expect(result.nativeWriter).toMatchObject({
      status: "write_completed",
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
      sourceReview: { status: "verified_reference_candidate_only" },
    });
    expect(result.candidateExists).toBe(true);
    expect(result.directOwner.compact).toMatchObject({
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
    });
    expect(result.readerOwner.compact.latestWrittenReceipt).toMatchObject({
      status: "write_completed",
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
    });
    expect(result.directOwner.compact.artifactEvidence).toMatchObject({ status: "registered" });
  });

  it.each(["nonzero", "malformed_stdout", "timeout"] as const)(
    "keeps actual safe reader %s execution failed",
    async (readerFault) => {
      const result = await probe(readerFault, { fault: "hash", readerFault });
      expect(result.readerOwner.parsed).toBe(false);
      expect(result.readerOwner.runReceipt.status).toBe("failed");
      expect(result.readerOwner.exitCode).not.toBe(0);
      expect(result.readerOwner.error).toBeTruthy();
      expect(result.readerOwner.compact).toEqual({});
      expect(result.reader.governanceProjection.summary).toMatchObject({
        structuralOwnerFailures: ["selfRepairHands"],
      });
      const item = selfRepairItem(result.reader.map.items);
      expect(item).toBeDefined();
      expect(item?.status).toBe("blocked_now");
      expect(item?.reason).toContain("本轮自修回执读取失败");
    },
  );
});
