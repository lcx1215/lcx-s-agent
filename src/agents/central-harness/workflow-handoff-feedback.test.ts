import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPerception,
  projectGovernanceDigest,
  readCentralGovernanceInput,
} from "../../../scripts/operator/lcx-central-agent.js";
import { auditWorkflowHandoffs } from "../../../scripts/operator/lcx-flow-graph.js";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunSnapshot,
} from "../../shared/lcx-run-receipt.js";
import {
  buildCentralGovernanceInput,
  compactFlowGraphOwner,
  projectFlowHandoff,
} from "./governance-input.js";
import { boundPerception, compactReceipts, runCentralHarnessCycle } from "./harness-loop.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function actualUnknown() {
  return {
    summary: { proofLevel: "structure_only", passed: 10, failed: 0, total: 10, scenarios: 28 },
    handoffAudit: await auditWorkflowHandoffs(),
  };
}

describe("original workflow handoff results reach central judgment (offline scripted)", () => {
  it("retains the original auditor's unknown result despite a structural green check", async () => {
    const source = await actualUnknown();
    const compact = compactFlowGraphOwner(source);
    expect(compact.summary).toMatchObject({ failed: 0 });
    expect(compact.flowHandoff).toMatchObject({
      status: "observed",
      counts: { verified: 0, normalBlock: 0, gaps: 0, notObserved: 28 },
      semanticAdoption: "not_proven",
      gapDetailsOmitted: 27,
    });
    const digest = projectGovernanceDigest({ owners: { flowGraph: compact } });
    expect(digest.flowHandoff).toEqual(compact.flowHandoff);
    expect(Buffer.byteLength(JSON.stringify(compact.flowHandoff))).toBeLessThan(1000);
  });

  it.each(["unknown_status", "duplicate", "wrong_count", "unknown_origin", "missing"] as const)(
    "never turns %s evidence into a successful handoff claim",
    async (fault) => {
      const source = await actualUnknown();
      if (fault === "unknown_status") {
        source.handoffAudit[0] = { ...source.handoffAudit[0], status: "all_good" };
      }
      if (fault === "duplicate") {
        source.handoffAudit[1] = {
          ...source.handoffAudit[1],
          scenarioId: source.handoffAudit[0].scenarioId,
        };
      }
      if (fault === "wrong_count") {
        source.summary.scenarios = 27;
      }
      const raw: Record<string, unknown> = source;
      if (fault === "unknown_origin") {
        raw.handoffAudit = [{ scenarioId: "diagnostic_only", status: "handoffs_verified" }];
      }
      if (fault === "missing") {
        delete raw.handoffAudit;
      }
      const result = compactFlowGraphOwner(raw).flowHandoff;
      expect(result.status).toBe(fault === "missing" ? "not_provided" : "unavailable");
      expect(result.counts).toBeUndefined();
      expect(result.semanticAdoption).toBe("not_proven");
    },
  );

  it("keeps fixture verification and normal blocks separate from natural adoption", () => {
    const result = compactFlowGraphOwner({
      summary: { scenarios: 3 },
      handoffAudit: [
        {
          scenarioId: "fixture_verified",
          status: "handoffs_verified",
          evidenceOrigin: "offline_fixture",
        },
        {
          scenarioId: "fixture_blocked",
          status: "normal_block",
          evidenceOrigin: "offline_fixture",
          owner: "original_gate",
        },
        {
          scenarioId: "natural_gap",
          status: "handoff_gap",
          evidenceOrigin: "natural_receipt",
          owner: "original_reader",
          gaps: [{ reason: "receipt_hash_conflict" }],
        },
      ],
    }).flowHandoff;
    expect(result.counts).toEqual({ verified: 1, normalBlock: 1, gaps: 1, notObserved: 0 });
    expect(result.origins).toEqual({ offlineFixture: 2, naturalReceipt: 1 });
    expect(result.gapDetails?.[0]).toMatchObject({
      scenarioId: "natural_gap",
      reason: "receipt_hash_conflict",
    });
    expect(result.semanticAdoption).toBe("not_proven");
    expect(projectFlowHandoff({ flowHandoff: result })).toEqual(result);
    expect(
      projectFlowHandoff({ flowHandoff: { ...result, counts: { ...result.counts, verified: 99 } } })
        .status,
    ).toBe("unavailable");
  });

  it.each(["not_observed", "handoff_gap"] as const)(
    "passes %s through the original same-cycle reader, budget, judgment and following receipt",
    async (status) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-flow-judgment-"));
      roots.push(root);
      const source = await actualUnknown();
      const raw: Record<string, unknown> = source;
      if (status === "handoff_gap") {
        raw.handoffAudit = source.handoffAudit.map((row, index) =>
          index === 0
            ? {
                ...row,
                status,
                evidenceOrigin: "offline_fixture",
                gaps: [
                  {
                    node: "review_panel",
                    owner: "original_quality_owner",
                    reason: "receipt_hash_conflict",
                  },
                ],
              }
            : row,
        );
      }
      const now = new Date().toISOString();
      const snapshot = createLcxRunSnapshot({
        observedAt: now,
        sourceCommit: "offline-source",
        sourceBranch: "fixture",
        authorityOwner: "lcx-governance-autopilot",
      });
      const runReceipt = buildLcxRunReceipt({
        runId: "flow-offline",
        parentRunId: "governance-offline",
        owner: "flowGraph",
        phase: "observe",
        status: "passed",
        checkedAt: now,
        snapshot,
        boundary: boundaryFromFlags({ scope: "offline" }),
        nextAction: "inspect_original_handoffs",
      });
      const compact = compactFlowGraphOwner(raw);
      const handoff = buildCentralGovernanceInput(
        [{ id: "flowGraph", ok: true, compact, runReceipt }],
        { parentRunId: "governance-offline", snapshot, checkedAt: now },
      );
      const file = path.join(root, "original-handoff.json");
      await fs.writeFile(file, JSON.stringify(handoff));
      const read = await readCentralGovernanceInput(file);
      const perception = await buildPerception(
        [],
        { objective: "original handoff evidence", focus: "general" },
        read,
        undefined,
        { stateDirectory: root },
      );
      const bounded = boundPerception(perception);
      const delivered = (bounded.perception.controlRoom.governanceDigest as Record<string, unknown>)
        .flowHandoff;
      expect(delivered).toEqual(compact.flowHandoff);
      const note =
        status === "handoff_gap"
          ? "Inspect original receipt_hash_conflict; structure cannot close the handoff"
          : "28 handoffs unobserved; retain unknown rather than infer completion";
      const receipt = await runCentralHarnessCycle({
        perception: bounded.perception,
        registry: new Map(),
        brain: {
          propose: async (input) => {
            expect(
              (input.controlRoom.governanceDigest as Record<string, unknown>).flowHandoff,
            ).toEqual(delivered);
            return {
              kind: "proposed",
              provider: "offline",
              modelId: "scripted",
              plan: { actions: [], note },
            };
          },
        },
      });
      expect(receipt.brainCall.note).toBe(note);
      expect(receipt.actionsApproved).toBe(0);
      expect(JSON.stringify(compactReceipts([receipt], 10))).toContain(note);
      const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
      if (proofDir) {
        await fs.mkdir(proofDir, { recursive: true });
        await fs.writeFile(
          path.join(proofDir, `${status}-original-loop.json`),
          JSON.stringify(
            {
              boundary: "offline_original_functions_scripted_brain_no_natural_adoption",
              raw,
              handoff,
              read,
              bounded,
              receipt,
              next: compactReceipts([receipt], 10),
            },
            null,
            2,
          ) + "\n",
        );
      }
    },
  );
});
