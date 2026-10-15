import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";

const nativeProof = process.env.LCX_ACCEPTANCE_PARENT_PROOF_PATH;
const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type DebugEvent = {
  kind: string;
  name: string;
  sequence: number;
  parentFunction?: string | null;
  parentCallSequence?: number | null;
  args?: unknown[];
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// Reads retained native debug bytes. Fault mutations are explicitly repinned adversarial evidence,
// never a new successful owner receipt. No producer or child actor executes in these tests.
async function evidence(mutate?: (events: DebugEvent[]) => void): Promise<WorkflowHandoffEvidence> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acceptance-control-readback-"));
  roots.push(root);
  const proof = JSON.parse(await fs.readFile(nativeProof!, "utf8")) as {
    capture: { path: string; sha256: string };
  };
  const capture = JSON.parse(await fs.readFile(proof.capture.path, "utf8")) as {
    events: DebugEvent[];
  };
  mutate?.(capture.events);
  const captureText = JSON.stringify(capture);
  const capturePath = path.join(root, "retained-or-tampered-capture.json");
  await fs.writeFile(capturePath, captureText);
  proof.capture = { path: capturePath, sha256: hash(captureText) };
  const proofText = JSON.stringify(proof),
    proofPath = path.join(root, "proof.json");
  await fs.writeFile(proofPath, proofText);
  const collectorResult = capture.events.findIndex(
    (event) => event.kind === "result" && event.name === "collectOwnerSnapshots",
  );
  expect(collectorResult).toBeGreaterThan(0);
  const ref = (pointer: string) => ({ path: capturePath, sha256: hash(captureText), pointer });
  return {
    scenarioId: "commercial_acceptance_harness_waterflow",
    environment: "offline_fixture",
    nodes: [
      {
        nodeId: "local_operator_loop",
        scope: ref("/identity"),
        output: ref(`/events/${collectorResult}/result`),
      },
    ],
    controlAttempts: (
      ["training_plan", "mind_model", "flow_graph", "external_channel_binding"] as const
    ).map((to) => ({
      from: "local_operator_loop",
      to,
      receipt: { path: proofPath, sha256: hash(proofText), pointer: "" },
    })),
  };
}
async function audit(input: WorkflowHandoffEvidence) {
  return (await auditWorkflowHandoffs([input])).find((row) => row.scenarioId === input.scenarioId)!;
}

describe.skipIf(!nativeProof)("acceptance retained ALS control attempts", () => {
  it("observes four consumed failed dispatches without supplying child execution or skipped doctor", async () => {
    const row = await audit(await evidence());
    expect(row.controlAttemptsObserved).toHaveLength(4);
    expect(row.controlAttemptBoundary).toBe(
      "debug_dispatch_attempt_only_child_execution_not_observed",
    );
    expect(row.status).toBe("handoff_gap");
    expect(row.gaps).toContainEqual(
      expect.objectContaining({
        node: "system_doctor",
        reason: "control_dispatch_not_observed:local_operator_loop",
      }),
    );
    expect(row.gaps).toContainEqual(
      expect.objectContaining({ node: "flow_graph", reason: "original_receipt_not_observed" }),
    );
  });

  it("rejects an absent actual parent even when original failed return and source pins remain", async () => {
    const row = await audit(
      await evidence((events) => {
        const call = events.find(
          (event) =>
            event.kind === "call" &&
            event.name === "runJsonOwner" &&
            event.args?.[0] === "lcx-flow-graph",
        )!;
        delete call.parentCallSequence;
      }),
    );
    expect(row.controlAttemptsObserved).toHaveLength(3);
    expect(row.gaps).toContainEqual(
      expect.objectContaining({
        node: "flow_graph",
        reason: expect.stringContaining("actual_parent_conflict"),
      }),
    );
  });

  it("rejects an original failed result whose binder actually consumed different content", async () => {
    const row = await audit(
      await evidence((events) => {
        const binder = events.find(
          (event) =>
            event.kind === "call" &&
            event.name === "bindActualCollectedSnapshot" &&
            (event.args?.[0] as { owner?: string } | undefined)?.owner === "lcx-flow-graph",
        )!;
        binder.args![0] = {
          ...(binder.args![0] as Record<string, unknown>),
          error: "tampered-negative-unconsumed-return",
        };
      }),
    );
    expect(row.controlAttemptsObserved).toHaveLength(3);
    expect(row.gaps).toContainEqual(
      expect.objectContaining({
        node: "flow_graph",
        reason: expect.stringContaining("failed_return_not_consumed"),
      }),
    );
  });
});
