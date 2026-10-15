import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import { probeOriginalExecution } from "./fixtures/lcx-waterflow-execution-probe.js";

async function audit(result: Awaited<ReturnType<typeof probeOriginalExecution>>) {
  return (await auditWorkflowHandoffs([result.handoffEvidence])).find(
    (row) => row.scenarioId === "finance_live_execution_waterflow",
  )!;
}
describe("whole original execution owner, isolated paper seam and actual ledger consumer", () => {
  it("traces six original handoffs and shows changed intent changes the native durable position", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-whole-"));
    try {
      const first = await probeOriginalExecution({ directory: path.join(root, "two") });
      const changed = await probeOriginalExecution({
        directory: path.join(root, "three"),
        quantity: 3,
      });
      for (const result of [first, changed]) {
        expect(await audit(result)).toMatchObject({
          status: "handoffs_verified",
          gaps: [],
          semanticAdoption: "not_proven",
        });
        expect(result.handoffEvidence.nodes).toHaveLength(6);
        expect(result.payload.boundary).toBe(
          "paper_execution_adapter_only_no_credentials_no_venue",
        );
        expect(result.payload.nodes.execution_receipt?.adapterKind).toBe("paper");
        expect(result.payload.nodes.execution_receipt?.accountId).toBe(result.accountId);
        expect(result.payload.durableLedger.written).toBe(true);
        expect(result.independentReadback.receipts).toEqual([
          result.payload.nodes.execution_receipt,
        ]);
        expect(result.independentReadback.recordCount).toBe(1);
        expect(result.independentReadback.ledger.unrealizedPnl).toBeNull();
        expect(result.lateResultIgnored).toBe(true);
      }
      expect(first.independentReadback.ledger.positions[0].quantity).toBe(2);
      expect(changed.independentReadback.ledger.positions[0].quantity).toBe(3);
      expect(first.payload.nodes.execution_receipt?.notional).toBe(200);
      expect(changed.payload.nodes.execution_receipt?.notional).toBe(300);
      expect(first.originalBinding?.intent.quantity).toBe(2);
      expect(changed.originalBinding?.intent.quantity).toBe(3);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each(["broker_unknown", "timeout", "missing_authorization"] as const)(
    "keeps %s blocked through the original owner, without writing a fill or late-result revival",
    async (fault) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-block-"));
      try {
        const result = await probeOriginalExecution({ directory: root, fault });
        expect(await audit(result)).toMatchObject({ status: "normal_block", gaps: [] });
        expect(result.payload.nodes.order_placement.status).toBe("refused");
        expect(result.payload.nodes.execution_receipt).toBeNull();
        expect(result.payload.durableLedger.written).toBe(false);
        expect(result.independentReadback.receipts).toEqual([]);
        expect(result.afterLate.receipts).toEqual([]);
        expect(result.lateResultIgnored).toBe(true);
        expect(
          result.events.some(
            (event) => event.node === "execution_receipt" || event.node === "position_ledger",
          ),
        ).toBe(false);
        if (fault === "broker_unknown") {
          expect(result.payload.nodes.order_placement.refusalReasons.join(" ")).toContain(
            "account_snapshot_unavailable",
          );
        }
        if (fault === "timeout") {
          expect(result.factsReads).toBe(1);
        }
        if (fault === "missing_authorization") {
          expect(result.factsReads).toBe(0);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
  it("keeps diagnostic sink mutation and exceptions from changing native execution or ledger values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-observer-"));
    try {
      const result = await probeOriginalExecution({ directory: root, disturbObserver: true });
      expect(result.payload.nodes.execution_receipt?.quantity).toBe(2);
      expect(result.independentReadback.ledger.positions[0].quantity).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
