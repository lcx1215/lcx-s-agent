import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewUniverseCleanup } from "../scripts/operator/lcx-change-impact-plan.js";
import {
  buildCleanupReviewProbe,
  probeCleanupReview,
  type CleanupReviewFault,
} from "./fixtures/lcx-waterflow-cleanup-review-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function root() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network forbidden");
    }),
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cleanup-review-"));
  roots.push(directory);
  return directory;
}

describe("original change-impact selected cleanup consumer", () => {
  it("consumes the original predecision builder archive before any terminal governance receipt exists", async () => {
    const result = await probeCleanupReview(await root(), undefined, true);
    await expect(fs.access(path.join(result.host.rootDir, "governance.json"))).rejects.toThrow();
    const reread = await reviewUniverseCleanup(result.input, result.host);
    expect(reread.status).toBe("reviewed");
    expect(reread.sourceReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: "/value/schemaVersion",
          value: "lcx_central_governance_input_v1",
        }),
        expect.objectContaining({
          pointer: "/value/byOwner/universeIndex/compact/artifactEvidence",
        }),
        expect.objectContaining({ pointer: "/value/byOwner/flowGraph/runReceipt" }),
      ]),
    );
    expect(reread.cleanupAuthorized).toBe(false);
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.cp(result.host.rootDir, path.join(proofDir, "predecision-positive"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(proofDir, "predecision-positive-proof.json"),
        `${JSON.stringify({ ...result, terminalGovernanceReceiptExists: false, originalPredecisionBuilder: true }, null, 2)}\n`,
      );
    }
  });
  it.each<CleanupReviewFault>([
    "missing",
    "hash",
    "field",
    "parent",
    "snapshot",
    "run",
    "binding",
    "quality",
    "schema",
    "host",
  ])("blocks predecision %s with original byOwner receipt validation", async (fault) => {
    const result = await probeCleanupReview(await root(), fault, true);
    expect(result.result.status).toBe("blocked");
    expect(result.result.dispositions).toEqual([]);
    expect(result.result.cleanupAuthorized).toBe(false);
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.cp(result.host.rootDir, path.join(proofDir, `predecision-${fault}`), {
        recursive: true,
      });
    }
  });
  it("reads original archived bodies and persists conservative dispositions without inventing cleanup checks", async () => {
    const result = await probeCleanupReview(await root());
    expect(result.result.status).toBe("reviewed");
    expect(result.result.dispositions.map((row) => row.disposition)).toEqual([
      "preserve",
      "unknown",
      "unknown",
    ]);
    expect(result.result.dispositions[0].owner).toContain("repository_cleanup");
    expect(result.result.dispositions[0].missingChecks).toContain("cleanup-reference-review");
    expect(result.result.sourceReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer: "/value/checks/0/id", value: "offline-structure-only" }),
        expect.objectContaining({ pointer: "/value/checks/0/ok", value: true }),
        expect.objectContaining({
          pointer: "/value/garbageCandidates/untrackedRepoFiles/0",
          value: "docs/lcx-capability-review-20260702.md",
        }),
      ]),
    );
    expect(result.result.cleanupAuthorized).toBe(false);
    expect(result.result.semanticTruth).toBe("not_proven");
    expect(result.originalOwnerRuns).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.cp(result.host.rootDir, path.join(proofDir, "positive"), { recursive: true });
      await fs.writeFile(
        path.join(proofDir, "positive-proof.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
  });
  it.each<CleanupReviewFault>([
    "missing",
    "hash",
    "field",
    "parent",
    "snapshot",
    "run",
    "binding",
    "quality",
    "schema",
    "host",
  ])("blocks %s without a disposition or cleanup authority", async (fault) => {
    const result = await probeCleanupReview(await root(), fault);
    expect(result.result.status).toBe("blocked");
    expect(result.result.dispositions).toEqual([]);
    expect(result.result.cleanupAuthorized).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.mkdir(proofDir, { recursive: true });
      await fs.cp(result.host.rootDir, path.join(proofDir, fault), { recursive: true });
    }
  });
  it("changing host parent cannot be satisfied by an otherwise coherent manifest and source set", async () => {
    const fixture = await buildCleanupReviewProbe(await root());
    const result = await reviewUniverseCleanup(fixture.input, {
      ...fixture.host,
      parentRunId: "independent-other-parent",
    });
    expect(result.reason).toBe("cleanup_review_governance_scope_conflict");
    expect(result.status).toBe("blocked");
  });
  it("rejects sources escaping the independent read boundary", async () => {
    const fixture = await buildCleanupReviewProbe(await root());
    const result = await reviewUniverseCleanup(
      { ...fixture.input, governance: { ...fixture.input.governance, path: "../governance.json" } },
      fixture.host,
    );
    expect(result.status).toBe("blocked");
    expect(result.sourceReads).toEqual([]);
  });
  it.skipIf(
    !process.env.LCX_UNIVERSE_NATIVE_RECEIPT_PATH || !process.env.LCX_UNIVERSE_NATIVE_REPO_ROOT,
  )(
    "consumes retained original Universe content in a clearly offline rearchive without claiming its original run scope",
    async () => {
      const fixture = await buildCleanupReviewProbe(await root(), undefined, {
        universePath: process.env.LCX_UNIVERSE_NATIVE_RECEIPT_PATH!,
        repoRoot: process.env.LCX_UNIVERSE_NATIVE_REPO_ROOT!,
      });
      fixture.input.candidates = [
        "/value/garbageCandidates/untrackedRepoFiles/0",
        "/value/garbageCandidates/staleRuntimeFiles/0",
      ];
      const before = await fs.readFile(process.env.LCX_UNIVERSE_NATIVE_RECEIPT_PATH!);
      const result = await reviewUniverseCleanup(fixture.input, fixture.host);
      expect(result.status).toBe("reviewed");
      expect(result.cleanupAuthorized).toBe(false);
      expect(result.scope.parentRunId).toBe(fixture.host.parentRunId);
      expect(await fs.readFile(process.env.LCX_UNIVERSE_NATIVE_RECEIPT_PATH!)).toEqual(before);
      const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
      if (proofDir) {
        await fs.cp(fixture.host.rootDir, path.join(proofDir, "retained-offline-rearchive"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(proofDir, "retained-offline-proof.json"),
          `${JSON.stringify({ ...fixture, result, environment: "offline_fixture", originalRunScopeProven: false, originalOwnerRuns: 0 }, null, 2)}\n`,
        );
      }
    },
  );
});
