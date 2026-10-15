import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExternalAgentUpgradeRadar } from "../scripts/operator/lcx-external-agent-upgrade-radar.ts";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.ts";
import { probeOriginalUpgradeRadar } from "./fixtures/lcx-waterflow-upgrade-probe.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function proofRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-upgrade-native-"));
  roots.push(root);
  return process.env.LCX_UPGRADE_PROOF_DIR ?? root;
}
const scenarios = [
  "external_agent_skill_distillation_waterflow",
  "prediction_market_research_only_waterflow",
] as const;
describe("original upgrade radar actual boundary", () => {
  it("reports registered design rather than pretending source/owner wiring or executed adoption", async () => {
    const sample = await probeOriginalUpgradeRadar();
    expect(sample.owner.ok).toBe(true);
    expect(sample.owner.payload).toMatchObject({
      proofLevel: "static_registration_only",
      executionStatus: "planning_contract_only",
      architectureFit: "registered_to_existing_lcx_owner_stack",
      sourceContentRead: false,
      distillationExecuted: false,
      acceptanceEvalExecuted: false,
      predictionMarketPacketProduced: false,
      summary: {
        sourceReceiptMissingCount: 100,
        sourceReceiptVerifiedCount: 0,
        architectureIntegratedCountBasis: "static_owner_mapping_only",
      },
    });
    expect(sample.owner.payload?.perfectIntegrationReason).not.toContain(
      "proves architecture wiring",
    );
    expect(sample.consumerInput.externalAgentUpgrade.payload).toEqual(sample.owner.payload);
    const root = await proofRoot();
    await fs.mkdir(root, { recursive: true });
    const nativePath = path.join(root, "after-native-cli-consumer.json");
    const bytes = JSON.stringify(sample, null, 2) + "\n";
    await fs.writeFile(nativePath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ref = (pointer: string) => ({ path: nativePath, sha256, pointer });
    // No native source packet or run identity exists for either workflow. Do not relabel
    // registry JSON as source-reading/distillation/prediction handoff evidence.
    const evidence: WorkflowHandoffEvidence[] = scenarios.map((scenarioId) => ({
      scenarioId,
      environment: "offline_fixture",
      nodes: [],
    }));
    const audits = await auditWorkflowHandoffs(evidence);
    for (const scenarioId of scenarios) {
      expect(audits.find((row) => row.scenarioId === scenarioId)?.status).toBe("handoff_gap");
    }
    await fs.writeFile(
      path.join(root, "original-fieldrefs-input.json"),
      JSON.stringify(
        {
          evidence,
          diagnosticOnlyRefs: {
            producerRegisteredCount: ref("/owner/payload/summary/registeredCandidateCount"),
            consumerRegisteredCount: ref(
              "/consumerInput/externalAgentUpgrade/payload/summary/registeredCandidateCount",
            ),
          },
          noNativeWorkflowScopeObserved: true,
        },
        null,
        2,
      ) + "\n",
    );
    await fs.writeFile(
      path.join(root, "original-fieldrefs-audit.json"),
      JSON.stringify(
        audits.filter((row) => scenarios.includes(row.scenarioId as (typeof scenarios)[number])),
        null,
        2,
      ) + "\n",
    );
  });
  it("keeps actual missing-source/license/reading receipts missing for prediction candidates", () => {
    const owner = buildExternalAgentUpgradeRadar();
    const candidates = owner.candidates.filter((candidate) =>
      candidate.id.startsWith("prediction_market_"),
    );
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.status).toBe("static_owner_mapping_registered");
      expect(candidate.blockedDirectAdoption).toBe(true);
      expect(
        Object.values(candidate.sourceEvidence.receipts).every(
          (receipt) => receipt.status === "missing",
        ),
      ).toBe(true);
    }
    expect(candidates[0].requiredFilters).toContain("ambiguous_resolution_blocks_conclusion");
    expect(candidates[1].requiredFilters).toContain("fees_slippage_and_sample_out_required");
  });
  it("feeds actual child timeout into the original owner-availability consumer without claiming source timeout handling", async () => {
    const sample = await probeOriginalUpgradeRadar({ timeoutMs: 1 });
    expect(sample.owner.ok).toBe(false);
    expect(sample.owner.payload).toBeUndefined();
    expect(sample.owner.error).toContain("native_radar_process_timeout");
    expect(
      sample.consumer.clusters.find((cluster) => cluster.id === "owner_output_availability_cluster")
        ?.signals.length,
    ).toBeGreaterThan(0);
    const root = await proofRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "native-process-timeout-consumer.json"),
      JSON.stringify(sample, null, 2) + "\n",
    );
  });
  it("original receipt auditor rejects a changed diagnostic file hash, without inventing a source conflict consumer", async () => {
    const root = await proofRoot();
    await fs.mkdir(root, { recursive: true });
    const native = path.join(root, "native-hash-conflict.json");
    const bytes = JSON.stringify(buildExternalAgentUpgradeRadar());
    await fs.writeFile(native, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.appendFile(native, " ");
    const evidence: WorkflowHandoffEvidence = {
      scenarioId: scenarios[0],
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "external_upgrade_radar",
          scope: { path: native, sha256, pointer: "/boundary" },
          output: { path: native, sha256, pointer: "/summary/registeredCandidateCount" },
        },
      ],
    };
    const audit = (await auditWorkflowHandoffs([evidence])).find(
      (row) => row.scenarioId === scenarios[0],
    );
    expect(audit?.status).toBe("handoff_gap");
    expect(JSON.stringify(audit)).toContain("receipt_hash_conflict");
    await fs.writeFile(
      path.join(root, "original-hash-conflict-audit.json"),
      JSON.stringify(audit, null, 2) + "\n",
    );
  });
});
