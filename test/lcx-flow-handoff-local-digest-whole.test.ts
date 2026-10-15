import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditNativeLocalDigestWhole,
  nativeLocalDigestWholeObservation,
  persistNativeLocalDigestWhole,
} from "./fixtures/lcx-waterflow-local-digest-whole-probe.ts";

const blockedProof = process.env.LCX_LOCAL_DIGEST_WHOLE_BLOCKED_PROOF;
const healthyProof = process.env.LCX_LOCAL_DIGEST_WHOLE_HEALTHY_PROOF;
const evidenceDir = process.env.LCX_LOCAL_DIGEST_WHOLE_PROOF_DIR;
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function persist(name: string, value: unknown) {
  if (evidenceDir) {
    return persistNativeLocalDigestWhole(evidenceDir, name, value);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-local-digest-whole-"));
  temporaryRoots.push(root);
  return persistNativeLocalDigestWhole(root, name, value);
}

describe("local digest whole scene evidence limits", () => {
  it("keeps a scene with no indexed original receipts not observed", async () => {
    const result = await auditNativeLocalDigestWhole([]);
    await persist("before-not-observed-result", result);
    expect(result.status).toBe("not_observed");
    expect(result.semanticAdoption).toBe("not_proven");
  });
});

describe.skipIf(!blockedProof)(
  "reused actual host writer → independent original digest readback, canonical whole auditor",
  () => {
    it("proves the terminal structured reason handoff while retaining every missing upstream receipt", async () => {
      const observation = await nativeLocalDigestWholeObservation(blockedProof!);
      const result = await auditNativeLocalDigestWhole(observation.index);
      await persist("partial-handoff-index", observation.index);
      await persist("partial-native-manifest", observation.manifest);
      await persist("canonical-auditor-result", result);
      expect(result.status).toBe("handoff_gap");
      expect(result.blocked).toEqual(["operator_digest"]);
      expect(result.semanticAdoption).toBe("not_proven");
      expect(result.gaps).not.toContainEqual(
        expect.objectContaining({
          reason: "consumer_did_not_receive_output:operator_latest_receipt",
        }),
      );
      expect(result.gaps).not.toContainEqual(
        expect.objectContaining({ reason: "handoff_scope_conflict:operator_latest_receipt" }),
      );
      expect(result.gaps).toContainEqual({
        node: "local_operator_loop",
        owner: "host-installed:lcx-local-operator-loop.sh",
        reason: "original_receipt_not_observed",
      });
      const missing = result.gaps
        .filter((gap) => gap.reason === "original_receipt_not_observed")
        .map((gap) => gap.node);
      expect(missing).toEqual(
        observation.manifest.requiredNodes.filter(
          (node) => !observation.manifest.observedNodes.includes(node),
        ),
      );
      expect(missing).toHaveLength(11);
      expect(observation.manifest.canonicalRunBinding).toBe("unavailable");
      expect(observation.manifest.naturalCaller).toBe("not_observed");
      expect(observation.producer.path).not.toBe(observation.consumer.path);
      expect(recordReason(observation)).toContain(
        "local_operator_latest_matches_current_workflow_surface",
      );
    });
    it.each(["hash", "missing_field", "scope", "producer_as_consumer"] as const)(
      "canonical auditor retains the precise %s evidence fault without upgrading the scene",
      async (fault) => {
        const observation = await nativeLocalDigestWholeObservation(blockedProof!);
        const index = structuredClone(observation.index);
        const producer = index[0].nodes[0];
        const consumer = index[0].nodes[1];
        let expectedReason = "";
        if (fault === "hash") {
          producer.scope.sha256 = "0".repeat(64);
          producer.output!.sha256 = "0".repeat(64);
          expectedReason = "receipt_hash_conflict";
        } else if (fault === "missing_field") {
          producer.output!.pointer = "/contextRecovery/missing_original_field";
          expectedReason = "receipt_field_missing";
        } else if (fault === "scope") {
          consumer.scope.pointer = "/operatorDigest/source/repoRoot";
          expectedReason = "handoff_scope_conflict:operator_latest_receipt";
        } else {
          consumer.inputs![0].value = producer.output!;
          expectedReason = "consumption_not_in_consumer_receipt";
        }
        const result = await auditNativeLocalDigestWhole(index);
        await persist(`fault-${fault}`, { index, result });
        expect(result.status).toBe("handoff_gap");
        expect(result.gaps).toContainEqual(expect.objectContaining({ reason: expectedReason }));
      },
    );
  },
);

function recordReason(observation: Awaited<ReturnType<typeof nativeLocalDigestWholeObservation>>) {
  const evidence = observation.consumer.value.operatorDigest as Record<string, unknown>;
  const owners = evidence.owners as Record<string, Record<string, unknown>>;
  return owners.contextRecovery.reason;
}

describe.skipIf(!healthyProof)("healthy original warning summary is still partial evidence", () => {
  it("does not confuse rendered pending review with complete handoffs or a full normal block", async () => {
    const observation = await nativeLocalDigestWholeObservation(healthyProof!, false);
    const result = await auditNativeLocalDigestWhole(observation.index);
    await persist("healthy-partial-index", observation.index);
    await persist("healthy-partial-result", result);
    expect(result.status).toBe("handoff_gap");
    expect(result.blocked).toEqual([]);
    expect(result.gaps).not.toContainEqual(
      expect.objectContaining({
        reason: "consumer_did_not_receive_output:operator_latest_receipt",
      }),
    );
    expect((observation.consumer.value.operatorDigest as Record<string, unknown>).status).toBe(
      "rendered_requires_review",
    );
  });
});
