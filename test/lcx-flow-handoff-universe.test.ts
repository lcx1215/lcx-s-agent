import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import { verifyCentralEvidenceUse } from "../src/agents/central-harness/evidence-use.js";
import {
  probeRetainedUniverseReadback,
  type UniverseReadbackFault,
} from "./fixtures/lcx-waterflow-universe-probe.js";

const roots: string[] = [];
const sourcePath = process.env.LCX_UNIVERSE_NATIVE_RECEIPT_PATH;
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function probe(fault?: UniverseReadbackFault) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network forbidden");
    }),
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retained-universe-handoff-"));
  roots.push(root);
  return probeRetainedUniverseReadback(root, sourcePath!, fault);
}
// Explicit retained receipt only: ordinary tests never inventory a real workspace or launch the owner.
describe.skipIf(!sourcePath)("retained original universe bytes through native readback", () => {
  it("consumes the original index field and feedback without claiming the declared whole pipeline ran", async () => {
    const result = await probe();
    expect(result.originalSourceReused).toBe(true);
    expect(result.newUniverseOwnerRuns).toBe(0);
    expect(result.receipts[1].evidenceUse?.[0].verification).toBe("reference_verified");
    expect(
      result.inputs[2].backlog.some((entry) => entry.note === result.receipts[1].brainCall.note),
    ).toBe(true);
    expect(result.audit.status).toBe("handoff_gap");
    expect(result.audit.gaps).toContainEqual(
      expect.objectContaining({
        node: "cleanup_candidate_review",
        reason: "original_receipt_not_observed",
      }),
    );
    expect(result.rawSourceUnchanged).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.mkdir(proofDir, { recursive: true });
      await fs.writeFile(
        path.join(proofDir, "retained-native-index.json"),
        await fs.readFile(sourcePath!),
      );
      await fs.writeFile(
        path.join(proofDir, "retained-readback-proof.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      for (const [index, receipt] of result.receipts.entries()) {
        await fs.writeFile(
          path.join(proofDir, `native-readback-${index + 1}.json`),
          `${JSON.stringify(receipt, null, 2)}\n`,
        );
        await fs.writeFile(
          path.join(proofDir, `native-input-${index + 1}.json`),
          `${JSON.stringify(result.inputs[index], null, 2)}\n`,
        );
      }
    }
  });
  it.each([
    ["missing", "artifact_original_missing"],
    ["hash", "artifact_original_hash_mismatch"],
    ["field", "artifact_field_missing"],
  ] as const)("retains %s through actual downstream read refusal", async (fault, gap) => {
    const result = await probe(fault);
    expect(result.receipts[0].steps[0].outcome).toMatchObject({ available: false, gap });
    expect(result.receipts[1].brainCall.note).toContain(gap);
    expect(result.receipts[1].steps).toEqual([]);
    expect(result.receipts[1].evidenceUse).toBeUndefined();
    expect(result.rawSourceUnchanged).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.mkdir(proofDir, { recursive: true });
      await fs.writeFile(
        path.join(proofDir, `retained-${fault}-proof.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
  });
  it("does not use wrong hash, cross-account scope or missing delivered content as adoption evidence", async () => {
    const result = await probe();
    const use = result.receipts[1].evidenceUse![0];
    const input = result.inputs[1];
    expect(
      verifyCentralEvidenceUse([{ ...use, sourceSha256: "0".repeat(64) }], input)[0].verification,
    ).toBe("invalid_reference");
    expect(
      verifyCentralEvidenceUse([{ ...use, scope: { accountId: "different-account" } }], input)[0],
    ).toMatchObject({ verification: "invalid_reference", gap: "source_scope_mismatch" });
    expect(verifyCentralEvidenceUse([use], { ...input, backlog: [] })[0]).toMatchObject({
      verification: "invalid_reference",
      gap: "matching_read_not_delivered",
    });
    const drift = structuredClone(result.evidence);
    drift.nodes[0].output!.sha256 = "0".repeat(64);
    const audit = (await auditWorkflowHandoffs([drift])).find(
      (row) => row.scenarioId === drift.scenarioId,
    )!;
    expect(audit.status).toBe("handoff_gap");
    expect(audit.gaps).toContainEqual(
      expect.objectContaining({ node: "universe_index", reason: "scope_not_in_owner_receipt" }),
    );
    drift.nodes[0].scope.sha256 = "0".repeat(64);
    const hashConflict = (await auditWorkflowHandoffs([drift])).find(
      (row) => row.scenarioId === drift.scenarioId,
    )!;
    expect(hashConflict.status).toBe("handoff_gap");
    expect(hashConflict.gaps).toContainEqual(
      expect.objectContaining({ node: "universe_index", reason: "receipt_hash_conflict" }),
    );
  });
});
