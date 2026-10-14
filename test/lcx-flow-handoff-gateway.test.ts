import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import { probeOriginalGatewayWhole } from "./fixtures/lcx-waterflow-gateway-whole-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function probe(fault?: "missing_source" | "timeout" | "unchanged") {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline test forbids network"));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-gateway-whole-"));
  roots.push(directory);
  return probeOriginalGatewayWhole(directory, fault);
}
describe("original gateway whole research and feedback waterflow", () => {
  it("keeps terminal refusal when the requested source returns unchanged conflicting evidence", async () => {
    const result = await probe("unchanged");
    expect(result.after?.audited.terminalDecision).toBe("return_failed_reason");
    expect(result.final).toBe("unresolved");
    expect(result.executions).toHaveLength(2);
    expect(result.receipts.at(-1)?.steps).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("carries actual research sources through composition and terminal refusal to a corrected request and adopted research answer", async () => {
    const result = await probe();
    expect(result.before?.audited.terminalDecision).toBe("return_failed_reason");
    expect(result.after?.audited.terminalDecision).toBe("adopt_visible_answer");
    expect(result.executions).toHaveLength(2);
    expect(result.inputs[1].controlRoom.gatewayReview).toEqual(
      expect.objectContaining({ terminalDecision: "return_failed_reason" }),
    );
    expect(result.brokerConfirmed).toBe(false);
    const audit = (await auditWorkflowHandoffs([result.evidence])).find(
      (row) => row.scenarioId === result.evidence.scenarioId,
    );
    expect(audit).toMatchObject({ status: "handoffs_verified", gaps: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(["missing_source", "timeout"] as const)(
    "retains %s through the original source receipt and actual unresolved next input",
    async (fault) => {
      const result = await probe(fault);
      expect(result.sourceReceipt.status).toBe("blocked");
      expect(result.executions).toHaveLength(0);
      expect(result.modelCalls).toBe(0);
      expect(result.receipts[0].brainCall.note).toContain("Unresolved");
      const audit = (await auditWorkflowHandoffs([result.evidence])).find(
        (row) => row.scenarioId === result.evidence.scenarioId,
      );
      expect(audit).toMatchObject({ status: "normal_block", gaps: [] });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );
});
