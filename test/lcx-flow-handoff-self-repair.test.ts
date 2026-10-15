import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeOriginalSelfRepair,
  type SelfRepairFault,
} from "./fixtures/lcx-waterflow-self-repair-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function probe(fault?: SelfRepairFault, replacementRule?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network forbidden");
    }),
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "selfrepair-handoff-"));
  roots.push(root);
  const result = await probeOriginalSelfRepair(root, fault, replacementRule);
  const dest = process.env.LCX_WATERFLOW_PROOF_DIR;
  if (dest) {
    const dir = path.join(dest, fault ?? (replacementRule ? "multiline" : "positive"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "native-builder.json"),
      await fs.readFile(path.join(root, "state/self-repair-builder.json")),
    );
    await fs.writeFile(
      path.join(dir, "native-writer.json"),
      await fs.readFile(result.writer.latestJsonPath),
    );
    await fs.writeFile(path.join(dir, "native-review.json"), await fs.readFile(result.gatePath));
    await fs.writeFile(path.join(dir, "native-source.json"), result.sourceBody);
    if (result.candidateExists) {
      await fs.writeFile(path.join(dir, "native-correction.md"), result.correctionBody);
    }
    for (const i of result.receipts.keys()) {
      await fs.writeFile(
        path.join(dir, `native-cycle-${i + 1}.json`),
        await fs.readFile(path.join(root, "state", `self-repair-cycle-${i + 1}.json`)),
      );
      await fs.writeFile(
        path.join(dir, `native-input-${i + 1}.json`),
        `${JSON.stringify(result.inputs[i], null, 2)}\n`,
      );
    }
    await fs.writeFile(path.join(dir, "proof.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}
describe("original self-repair provenance and provisional handoff", () => {
  it("preserves the full legal multiline rule through both original review consumers", async () => {
    const rule =
      " require current source  \n  preserve account identity\n\nretain exact trailing whitespace  \n";
    const r = await probe(undefined, rule);
    expect(r.writer).toMatchObject({
      status: "write_completed",
      sourceReview: { status: "verified_reference_candidate_only" },
    });
    expect(
      r.writer.hands.patchCandidateBuilder.candidate.proposedPatchContract.replacementRule,
    ).toBe(rule);
    expect(r.consumedReview.correctionReview).toMatchObject({
      status: "verified_provisional_downrank",
      replacementRule: rule,
      reuseAllowed: false,
    });
    expect(r.receipts[2].evidenceUse?.[0].verification).toBe("reference_verified");
  });
  it("reads original written/reviewed note into next input while retaining actual reuse hold", async () => {
    const r = await probe();
    expect(r.writer.sourceReview.status).toBe("verified_reference_candidate_only");
    expect(r.candidateExists).toBe(true);
    expect(r.consumedReview.correctionReview).toMatchObject({
      status: "verified_provisional_downrank",
      reuseAllowed: false,
    });
    expect(r.receipts[2].evidenceUse?.[0]).toMatchObject({
      verification: "reference_verified",
      effect: "retain",
    });
    expect(r.inputs[3].backlog.some((e) => e.note === r.receipts[2].brainCall.note)).toBe(true);
    expect(r.actualReplacement).toBe("not_proven");
    expect(r.actualSearchRankingChange).toBe("not_proven");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["missing", "source_evidence_unreadable"],
    ["hash", "source_sha256_mismatch"],
    ["account", "correction_source_scope_mismatch"],
    ["run", "correction_source_scope_mismatch"],
    ["stale", "correction_source_not_fresh"],
    ["future", "correction_source_not_fresh"],
    ["conflict", "correction_replacement_rule_source_mismatch"],
  ] as const)(
    "blocks %s before any candidate write and carries actual gap forward",
    async (fault, reason) => {
      const r = await probe(fault);
      expect(r.writer).toMatchObject({
        ok: false,
        status: "blocked",
        reuseAllowed: false,
        sourceReview: { status: "blocked", blockers: [reason] },
      });
      expect(r.candidateExists).toBe(false);
      expect(r.consumedReview.status).toBe("blocked");
      expect(r.receipts[1].brainCall.note).toContain(reason);
      expect(r.receipts[1].steps).toEqual([]);
      expect(r.inputs[2].backlog.some((e) => e.note === r.receipts[1].brainCall.note)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("keeps old unrequested candidate path compatible without claiming prewrite source was passed", async () => {
    const r = await probe("unreviewed");
    expect(r.writer).toMatchObject({
      status: "write_completed",
      candidateOnly: true,
      reuseAllowed: false,
      sourceReview: { requested: false, status: "not_requested" },
    });
    expect(r.candidateExists).toBe(true);
    expect(r.receipts[2].evidenceUse?.[0].effect).toBe("retain");
  });
});
