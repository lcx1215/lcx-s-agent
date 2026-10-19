import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import {
  readFinanceCaseRun,
  saveFinanceCaseRun,
  caseflowFingerprint,
} from "../src/agents/finance-caseflow.js";
import { appendFinanceOutcome } from "../src/agents/finance-outcome-ledger.js";
import { probeOriginalCaseflow } from "./fixtures/lcx-waterflow-caseflow-probe.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-caseflow-handoff-"));
  directories.push(dir);
  return dir;
}
describe("original whole research/caseflow/outcome seams", () => {
  it("executes source and quality owners, freezes their actual snapshot and reads original claims into outcome", async () => {
    const probe = await probeOriginalCaseflow({
      directory: await directory(),
      caseId: "offline-full-chain",
    });
    expect(probe.receipt.status).toBe("candidate");
    expect(probe.receipt.gates.every((gate) => gate.passed)).toBe(true);
    expect(probe.qualityRequests.length).toBeGreaterThan(0);
    expect(probe.sourceCalls.every((call) => call.request.instrument === "BTCUSDT")).toBe(true);
    const evidence = probe.receipt.batch!.committeeEvidence;
    expect(
      evidence.every((source) =>
        probe.qualityRequests.some((request) =>
          request.evidence.some((item) => source.id === item.id && source.text === item.text),
        ),
      ),
    ).toBe(true);
    expect(probe.readback.run.snapshot).toEqual(JSON.parse(JSON.stringify(probe.receipt)));
    expect(probe.readback.run.evidence).toEqual(evidence);
    expect(probe.readback.packet.adopted).toBe(true);
    expect(probe.outcome).toMatchObject({
      packetRef: probe.saved.ref,
      caseId: probe.frozen.case.id,
      runId: probe.frozen.run.id,
      status: "recorded_for_review",
      executionAuthority: "none",
    });
    expect(probe.outcome.originalClaims).toEqual(
      probe.readback.packet.claims.map((claim) => ({ id: claim.id, text: claim.text })),
    );
    expect(probe.outcomeReadback).toEqual([probe.outcome]);
    expect(probe.unchanged).toBe(true);
    expect(
      (await auditWorkflowHandoffs([probe.evidence])).find(
        (row) => row.scenarioId === "finance_caseflow_waterflow",
      ),
    ).toMatchObject({ status: "handoffs_verified", semanticAdoption: "not_proven", gaps: [] });
  });
  it.each(["missing_source", "timeout", "quality_failure"] as const)(
    "retains %s as unadopted through frozen packet and original outcome receipt",
    async (fault) => {
      const probe = await probeOriginalCaseflow({
        directory: await directory(),
        caseId: `offline-${fault}`,
        fault,
      });
      expect(probe.receipt.gates.some((gate) => !gate.passed)).toBe(true);
      expect(probe.receipt.quarterlyOutput.adopted).toBe(false);
      expect(probe.readback.packet.adopted).toBe(false);
      expect(probe.readback.packet.gaps.length).toBeGreaterThan(0);
      expect(probe.outcome.status).toBe("recorded_for_review");
      expect(probe.unchanged).toBe(true);
      expect(
        (await auditWorkflowHandoffs([probe.evidence])).find(
          (row) => row.scenarioId === "finance_caseflow_waterflow",
        ),
      ).toMatchObject({ status: "normal_block", gaps: [] });
      if (fault !== "quality_failure") {
        expect(probe.modelCalls).toBe(0);
      }
      if (fault === "timeout") {
        expect(probe.sourceCalls.every((call) => call.aborted)).toBe(true);
      }
    },
  );
  it("rejects unknown claim and post-cutoff evidence without rewriting the packet or ledger", async () => {
    const probe = await probeOriginalCaseflow({
      directory: await directory(),
      caseId: "offline-bad-reference",
    });
    await expect(
      appendFinanceOutcome(path.dirname(probe.saved.path), probe.saved.ref, {
        ...probe.outcomeInput,
        recordId: "bad-claim",
        assessments: [
          {
            ...probe.outcomeInput.assessments[0],
            claimId: "unknown",
            finding: "inconclusive",
            evidenceIds: ["offline-observation"],
            invalidationConditions: ["Recheck the original claim identity"],
          },
        ],
      }),
    ).rejects.toThrow(/unknown.*claim/);
    await expect(
      appendFinanceOutcome(path.dirname(probe.saved.path), probe.saved.ref, {
        ...probe.outcomeInput,
        recordId: "future-source",
        evidence: [
          { ...probe.outcomeInput.evidence[0], sourceTimestamp: "2026-10-02T00:00:00.000Z" },
        ],
      }),
    ).rejects.toThrow(/timestamp exceeds/);
    expect(await readFinanceCaseRun(path.dirname(probe.saved.path), probe.saved.ref)).toEqual(
      probe.readback,
    );
  });
  it("rejects a rehashed adopted packet whose actual source snapshot remains blocked", async () => {
    const dir = await directory();
    const probe = await probeOriginalCaseflow({
      directory: dir,
      caseId: "offline-false-adoption",
      fault: "missing_source",
    });
    const changed = structuredClone(probe.frozen);
    changed.packet.adopted = true;
    changed.packet.status = "candidate";
    changed.packet.gaps = [];
    await expect(saveFinanceCaseRun(dir, changed)).rejects.toThrow(/adoption conflicts/);
    // A valid content hash and legal ontology edges cannot turn failed source gates into adoption.
    const ref = caseflowFingerprint(changed);
    await fs.writeFile(path.join(dir, `${ref}.json`), JSON.stringify(changed));
    await expect(readFinanceCaseRun(dir, ref)).rejects.toThrow(/adoption conflicts/);
    await expect(appendFinanceOutcome(dir, ref, probe.outcomeInput)).rejects.toThrow(
      /adoption conflicts/,
    );
    expect(await readFinanceCaseRun(dir, probe.saved.ref)).toEqual(probe.readback);
  });
});
