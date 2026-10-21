import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOriginalCleanupGovernance } from "./fixtures/lcx-waterflow-cleanup-governance-probe.js";
const roots: string[] = [];
const inFlight = new Set<Promise<unknown>>();
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.abort(new Error("private cleanup probe teardown"));
  }
  // A test timeout does not cancel its promise: settle every writer/child before removing its root.
  await Promise.allSettled(inFlight);
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
describe("actual original predecision cleanup statement consumes and recaptures original result", () => {
  it.each([undefined, "quality", "hash"] as const)(
    "executes original %s join without importing the owner stack",
    async (fault) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden")));
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cleanup-original-join-"));
      roots.push(root);
      const controller = new AbortController();
      controllers.push(controller);
      const pending = probeOriginalCleanupGovernance(
        root,
        fault,
        AbortSignal.any([controller.signal, AbortSignal.timeout(18_000)]),
      );
      inFlight.add(pending);
      const result = await pending.finally(() => inFlight.delete(pending));
      expect(result.review.status).toBe(fault ? "blocked" : "reviewed");
      expect(result.received.runReceipt).toMatchObject({ status: fault ? "blocked" : "passed" });
      expect(result.received.payload).toMatchObject({
        impactSourceRunReceipt: result.sourceRun.runReceipt,
      });
      expect(result.audit.status).toBe("handoff_gap");
      expect(result.audit.gaps).toContainEqual(
        expect.objectContaining({
          node: "repo_inventory",
          reason: "original_receipt_not_observed",
        }),
      );
      if (!fault) {
        expect(result.audit.gaps).not.toContainEqual(
          expect.objectContaining({
            node: "cleanup_candidate_review",
            reason: "consumer_did_not_receive_output:fixed_evidence_recovery",
          }),
        );
        expect(result.audit.gaps).not.toContainEqual(
          expect.objectContaining({
            node: "change_impact_plan",
            reason: "consumer_did_not_receive_output:cleanup_candidate_review",
          }),
        );
      }
      expect(fetch).not.toHaveBeenCalled();
      const proof = process.env.LCX_WATERFLOW_PROOF_DIR;
      if (proof) {
        const destination = path.join(proof, `original-join-${fault ?? "positive"}`);
        await fs.cp(root, destination, { recursive: true });
        await fs.writeFile(
          path.join(destination, "proof.json"),
          JSON.stringify(result, null, 2) + "\n",
        );
        const evidence = structuredClone(result.evidence);
        for (const node of evidence.nodes) {
          const refs = [
            node.scope,
            node.output,
            ...(node.outputs ?? []).map((v) => v.value),
            ...(node.inputs ?? []).map((v) => v.value),
          ];
          for (const ref of refs) {
            if (ref) {
              ref.path = path.join(destination, path.relative(root, ref.path));
            }
          }
        }
        await fs.writeFile(
          path.join(destination, "original-fieldrefs-input.json"),
          JSON.stringify(evidence, null, 2) + "\n",
        );
      }
    },
    20_000,
  );
});
