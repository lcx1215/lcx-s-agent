import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeUniverseJoin,
  readUniverseSnapshotSources,
} from "./fixtures/lcx-waterflow-universe-join-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
describe("native private same-parent Universe owner join and failure feedback", () => {
  it("includes untracked source while excluding ignored files without changing the host index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-source-inventory-"));
    roots.push(root);
    const git = async (args: string[]) =>
      (await promisify(execFile)("git", args, { cwd: root, timeout: 10_000 })).stdout;
    await git(["init", "--quiet"]);
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, ".gitignore"), "src/ignored.ts\n");
    await fs.writeFile(path.join(root, "src/tracked.ts"), "export const tracked = true;\n");
    await git(["add", ".gitignore", "src/tracked.ts"]);
    await fs.writeFile(path.join(root, "src/new.ts"), "export const added = true;\n");
    await fs.writeFile(path.join(root, "src/ignored.ts"), "private ignored content");
    const before = await fs.readFile(path.join(root, ".git/index"));
    const { indexed } = await readUniverseSnapshotSources(root, git);
    expect(indexed.find((entry) => entry.file === "src/tracked.ts")?.objectId).toMatch(
      /^[a-f0-9]{40}$/u,
    );
    expect(indexed.find((entry) => entry.file === "src/new.ts")).toMatchObject({ objectId: "" });
    expect(indexed.some((entry) => entry.file === "src/ignored.ts")).toBe(false);
    expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(before);
  });
  it.each([undefined, "missing_source", "hash_conflict"] as const)(
    "preserves actual %s source failure through original join",
    async (fault) => {
      const network = vi
        .fn()
        .mockRejectedValue(new Error("provider/model/channel network forbidden"));
      vi.stubGlobal("fetch", network);
      const proof = process.env.LCX_UNIVERSE_JOIN_PROOF_DIR;
      if (proof) {
        await fs.mkdir(proof, { recursive: true });
      }
      const root = await fs.mkdtemp(
        path.join(proof ?? os.tmpdir(), `lcx-native-universe-join-${fault ?? "native_failure"}-`),
      );
      if (!proof) {
        roots.push(root);
      }
      const result = await probeUniverseJoin(root, fault);
      expect(result.snapshotImport).toMatchObject({
        mode: "read_only_host_objects_private_index_and_dirty_blobs",
        hostIndexUnchanged: true,
        dirtyProof: { path: "test/changed.test.ts" },
      });
      expect(result.snapshotImport.indexedPaths).toBeGreaterThan(1_000);
      expect(result.snapshotImport.dirtyPaths).toBeGreaterThan(0);
      expect(result.before).toHaveLength(5);
      expect(result.callerInputs).toHaveLength(5);
      for (const owner of result.before) {
        expect(owner.runReceipt).toMatchObject({
          parentRunId: result.parentRunId,
          snapshot: result.snapshot,
        });
      }
      const recovered = result.sourceCalls
        .filter((call) => call.id === "contextRecovery")
        .map(
          (call) =>
            JSON.parse(call.stdout) as {
              ok: boolean;
              compressedContextRecovered: boolean;
              actionableFailures: string[];
            },
        );
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ ok: false, compressedContextRecovered: false });
      expect(recovered[0].actionableFailures.length).toBeGreaterThan(0);
      expect(result.denied.some((row) => row.script.includes("local-brain-training-plan.ts"))).toBe(
        true,
      );
      expect(result.review.status).toBe("blocked");
      if (
        !fault &&
        result.copiedArchitecture.some(
          (source) => source.path === "host-installed:lcx-local-operator-loop.sh",
        )
      ) {
        expect(result.before.find((owner) => owner.id === "mindModel")?.ok).toBe(true);
        expect(result.before.find((owner) => owner.id === "flowGraph")?.ok).toBe(true);
        expect(result.review.reason).toBe("cleanup_review_upstream_quality_failed:contextRecovery");
        expect(result.audit.status).toBe("normal_block");
        expect(result.audit.gaps).toEqual([]);
        for (const id of ["universeIndex", "mindModel", "flowGraph", "contextRecovery"]) {
          expect(
            result.review.sourceReads.some(
              (read) => read.pointer === `/value/byOwner/${id}/runReceipt`,
            ),
          ).toBe(true);
        }
      }
      if (fault === "hash_conflict") {
        expect(result.review.reason).toContain("hash_conflict");
      }
      if (fault === "missing_source") {
        expect(result.review.reason).not.toBe("cleanup_review_not_completed");
      }
      expect(result.received.ok).toBe(false);
      expect(result.received.payload).toMatchObject({
        cleanupReview: result.review,
        impactSourceRunReceipt: result.before.find((owner) => owner.id === "changeImpact")
          ?.runReceipt,
      });
      expect(result.received.runReceipt.status).not.toBe("passed");
      expect(result.cleanup.directChildCloseObserved).toBe(true);
      expect(
        result.processes.every(
          (child) =>
            child.timeoutMs <=
              (child.command === process.execPath &&
              child.args.some((arg) => path.basename(arg) === "lcx-universe-index.ts")
                ? 45_000
                : 20_000) &&
            child.closeObserved &&
            child.stdioClosed,
        ),
      ).toBe(true);
      expect(network).not.toHaveBeenCalled();
      await fs.writeFile(
        path.join(root, "native-guards.json"),
        JSON.stringify(
          {
            snapshotImport: result.snapshotImport,
            timing: result.timing,
            fetchCallCount: network.mock.calls.length,
            actualProcessCount: result.processes.length,
            deniedOriginalChildRequests: result.denied,
            processTimeoutMaxMs: Math.max(...result.processes.map((child) => child.timeoutMs)),
            directChildrenClosed: result.cleanup.directChildCloseObserved,
            descendants: result.cleanup.descendants,
          },
          null,
          2,
        ) + "\n",
      );
      expect(["handoff_gap", "normal_block"]).toContain(result.audit.status);
      expect(
        result.audit.gaps.some((gap) =>
          /not_in_.*receipt|receipt_hash_conflict|scope_conflict|producer_field_cannot/u.test(
            gap.reason,
          ),
        ),
      ).toBe(false);
      expect(result.audit.gaps).not.toContainEqual(
        expect.objectContaining({
          node: "change_impact_plan",
          reason: "handoff_not_observed:cleanup_candidate_review",
        }),
      );
      expect(result.audit.gaps).not.toContainEqual(
        expect.objectContaining({
          node: "change_impact_plan",
          reason: "consumer_did_not_receive_output:cleanup_candidate_review",
        }),
      );
      expect(result.naturalAdoption).toBe("not_proven");
    },
    90_000,
  );
});
