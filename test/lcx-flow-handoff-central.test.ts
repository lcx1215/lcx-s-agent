import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import { probeOriginalCentral } from "./fixtures/lcx-waterflow-central-probe.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-central-native-waterflow-"));
  roots.push(root);
  return root;
}

describe("original central owner -> real tools -> retained outcome -> next judgment (loopback model fixture)", () => {
  it.each([2, 7])(
    "the original beta=%s result determines the later scripted judgment and its source-bound receipt",
    async (seed) => {
      const result = await probeOriginalCentral({ directory: await directory(), seed });
      expect(result.receipts).toHaveLength(3);
      expect(result.trace.httpRequests).toHaveLength(3);
      expect(
        result.receipts.every(
          (receipt) => receipt.brainCall.modelCall?.transport?.stage === "body_complete",
        ),
      ).toBe(true);
      expect(result.trace.gateCalls.every((call) => call.result.ok)).toBe(true);
      const first = result.receipts[0];
      expect(first.steps[0]).toMatchObject({
        status: "ran_ok",
        ownerId: "quant_math",
        outcome: { beta: seed },
        resultArtifact: { status: "registered" },
      });
      const read = result.receipts[1].steps[0];
      expect(read).toMatchObject({
        ownerId: "artifact_memory_recall",
        status: "ran_ok",
        outcome: {
          available: true,
          selectedValue: seed,
          artifactId: first.steps[0].resultArtifact?.id,
        },
      });
      expect(JSON.stringify(result.trace.brainCalls[2].perception.backlog)).toContain(
        `"selectedValue":${seed}`,
      );
      const judgment = result.receipts[2];
      expect(judgment.brainCall.note).toBe(
        `beta=${seed}: ${seed > 3 ? "change: measure scaling bottleneck" : "retain baseline"}`,
      );
      expect(judgment.evidenceUse).toMatchObject([
        {
          artifactId: read.outcome?.artifactId,
          sourceSha256: read.outcome?.sourceSha256,
          effect: seed > 3 ? "change" : "retain",
          verification: "reference_verified",
        },
      ]);
      expect(judgment.boundaries).toContain("no_execution_authority");
      expect(judgment.liveTouched).toBe(false);
      expect(
        result.receipts.every(
          (receipt) => !receipt.providerConfigTouched && !receipt.protectedMemoryTouched,
        ),
      ).toBe(true);
      for (const [index, file] of result.cyclePaths.entries()) {
        expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(result.receipts[index]);
      }
      const rows = await auditWorkflowHandoffs([result.evidence!]);
      expect(
        rows.find((row) => row.scenarioId === "central_agent_decision_waterflow"),
      ).toMatchObject({
        status: "handoffs_verified",
        gaps: [],
        evidenceOrigin: "offline_fixture",
        semanticAdoption: "not_proven",
      });
    },
  );

  it("retains an absent original source through the read receipt and next judgment without claiming adoption", async () => {
    const result = await probeOriginalCentral({
      directory: await directory(),
      seed: 7,
      fault: "missing_evidence",
    });
    expect(result.trace.sourceFault?.changes).toBe(1);
    const read = result.receipts[1].steps[0];
    expect(read).toMatchObject({ outcome: { available: false }, observedOk: false });
    expect(result.receipts[1].nextAction).toBe("follow_up_on_owners_reporting_not_ok");
    expect(result.trace.httpRequests[2].prompt).toContain('"available":false');
    expect(result.receipts[2].brainCall.note).toBe(
      "unresolved: original artifact evidence unavailable",
    );
    expect(result.receipts[2].evidenceUse).toBeUndefined();
  });

  it("settles a native HTTP-200 body timeout, leaves late results unable to invoke a tool or replace failure", async () => {
    const result = await probeOriginalCentral({
      directory: await directory(),
      seed: 7,
      fault: "body_timeout",
    });
    expect(result.trace.httpRequests).toHaveLength(1);
    expect(result.trace.httpRequests[0].responseEnded).toBe(true);
    expect(result.receipts[0]).toMatchObject({
      brainCall: {
        outcome: "failed",
        modelCall: { transport: { stage: "cancelled", httpStatus: 200 } },
      },
      actionsApproved: 0,
      steps: [],
      nextAction: "halt_and_report",
    });
    expect(result.trace.gateCalls).toEqual([]);
    expect(result.latePreserved).toBe(true);
    expect(JSON.parse(await fs.readFile(result.cyclePaths[0], "utf8"))).toEqual(result.receipts[0]);
  });

  it("names a missing perception source in the actual model input and retains the unresolved judgment", async () => {
    const result = await probeOriginalCentral({
      directory: await directory(),
      seed: 2,
      fault: "missing_snapshot",
    });
    expect(result.trace.brainCalls[0].perception.controlRoom.runtimeFreshness).toMatchObject({
      snapshotReadFailures: { controlRoom: "missing" },
    });
    expect(result.trace.httpRequests[0].prompt).toContain('"controlRoom":"missing"');
    expect(result.receipts[0].brainCall.note).toBe(
      "unresolved: original controlRoom snapshot missing",
    );
    expect(result.receipts[0].steps).toEqual([]);
  });
});
