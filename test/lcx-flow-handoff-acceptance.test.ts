import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCommercialAcceptanceHarness,
  collectOwnerSnapshots,
} from "../scripts/operator/lcx-commercial-acceptance-harness.js";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";
import {
  prepareAcceptanceProbe,
  type AcceptanceProbeFault,
  type AcceptanceSourcePaths,
} from "./fixtures/lcx-waterflow-acceptance-probe.js";

const child = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(
    () => {
      throw new Error("real child execution forbidden in offline acceptance proof");
    },
    {
      [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => child.execute(...args),
    },
  );
  return { ...original, execFile };
});
const roots: string[] = [];
afterEach(async () => {
  child.execute.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function run(fault?: AcceptanceProbeFault) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-acceptance-native-"));
  roots.push(root);
  const proofRoot = process.env.LCX_WATERFLOW_ACCEPTANCE_PROOF_DIR ?? root;
  const directory = await fs.mkdtemp(path.join(proofRoot, `${fault ?? "normal"}-`));
  const frozenRoot = process.env.LCX_WATERFLOW_ACCEPTANCE_FROZEN_SOURCE_DIR;
  const sourcePaths: AcceptanceSourcePaths = frozenRoot
    ? {
        training: path.join(frozenRoot, "local-brain-training-plan.ts.json"),
        flow: path.join(frozenRoot, "lcx-flow-graph.ts.json"),
        mind: path.join(frozenRoot, "lcx-mind-model.ts.json"),
        channel: path.join(frozenRoot, "lcx-external-channel-status.ts.json"),
        learning: path.join(frozenRoot, "lcx-module-learning-absorption-gate.ts.json"),
      }
    : {};
  const probe = await prepareAcceptanceProbe(directory, sourcePaths, fault);
  child.execute.mockImplementation(probe.execute);
  const options = { withChannelProbe: false, skipDoctor: false };
  const collected = await collectOwnerSnapshots(options);
  const consumerInput = structuredClone(collected);
  const terminal = buildCommercialAcceptanceHarness(collected);
  const proof = {
    boundary: "offline_original_collector_and_gate_private_caller_observation",
    sourceManifest: probe.sources,
    childCalls: probe.calls,
    collectorOptions: options,
    collectorOutput: collected,
    consumerInput,
    terminal,
    naturalExecutionObserved: false,
    userVisibleObserved: false,
    nativeBusinessScopeAvailable: false,
    nativeHostCollectionScopeAvailable: true,
    nativeReceiptContainsCollectorInputs: false,
    nativeReceiptContainsBoundedOwnerIdentityReadback: true,
  };
  const raw = JSON.stringify(proof, null, 2) + "\n";
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const artifact = path.join(directory, `collector-gate-${sha256}.json`);
  await fs.writeFile(artifact, raw);
  return { ...probe, collected, consumerInput, terminal, directory, artifact, sha256 };
}

describe("original acceptance collector to native gate offline handoff", () => {
  it.each(["doctor_timeout", "doctor_nonzero", "doctor_check_unconfirmed"] as const)(
    "does not adopt %s council stdout as completed provider evidence",
    async (fault) => {
      const sample = await run(fault);
      const doctor = sample.collected.systemDoctor;
      const council = sample.terminal.gates.find(
        (entry) =>
          entry.owner === "scripts/operator/lcx-system-doctor.ts" ||
          entry.id === "lcx-system-doctor_owner_unavailable",
      );
      expect(doctor?.payload).toBeDefined();
      if (fault !== "doctor_check_unconfirmed") {
        expect(doctor?.commandSucceeded).toBe(false);
        expect(doctor?.error).toContain(fault);
        expect(council?.id).toBe("lcx-system-doctor_owner_unavailable");
      } else {
        expect(doctor?.commandSucceeded).toBe(true);
        expect(council?.id).toBe("provider_council_check_unconfirmed");
      }
      expect(sample.terminal.gates.some((entry) => entry.id === "provider_council_clean")).toBe(
        false,
      );
      expect(sample.terminal.readyForCommercialRelease).toBe(false);
    },
  );
  it("retains independently completed council check when another doctor check makes aggregate not ok", async () => {
    const sample = await run("doctor_other_failure");
    expect(sample.collected.systemDoctor).toMatchObject({ ok: false, commandSucceeded: true });
    expect(
      sample.terminal.gates.find((entry) => entry.id === "provider_council_clean")?.status,
    ).toBe("passed");
  });
  it("joins real sibling calls and preserves independent gate consumption", async () => {
    const sample = await run();
    expect(sample.calls).toHaveLength(14);
    expect(new Set(sample.calls.map((call) => call.sourceId)).size).toBe(14);
    for (const call of sample.calls) {
      expect(call.executable).toBe(process.execPath);
      expect(call.args.slice(0, 2)).toEqual(["--import", "tsx"]);
      expect(call.args).not.toEqual(expect.arrayContaining(["--with-probe"]));
      expect(call.timeout).toBe(120_000);
      expect(call.maxBuffer).toBe(32 * 1024 * 1024);
    }
    expect(sample.consumerInput).toEqual(sample.collected);
    expect(sample.collected.directedDailyResearchBrief?.owner).toBe(
      "lcx-directed-daily-research-brief",
    );
    expect(sample.sources.find((source) => source.id === "short")?.origin).toBe(
      "actual_original_pure_producer",
    );
    const training = sample.terminal.gates.find((gate) => gate.id === "training_idle");
    expect(training?.evidence.decisions).toEqual(sample.collected.trainingPlan?.payload?.decisions);
    const architecture = sample.terminal.gates.find(
      (gate) => gate.id === "architecture_governance_clean",
    );
    expect(architecture?.evidence.flowGraphSummary).toEqual(
      sample.collected.flowGraph?.payload?.summary,
    );
    expect(architecture?.evidence.mindModelSummary).toEqual(
      sample.collected.mindModel?.payload?.summary,
    );
    expect(sample.terminal.readyForCommercialRelease).toBe(false);
    expect(
      sample.terminal.blockedGates.length + sample.terminal.failedGates.length,
    ).toBeGreaterThan(0);

    const ref = (pointer: string) => ({ path: sample.artifact, sha256: sample.sha256, pointer });
    const trainingIndex = sample.terminal.gates.findIndex((gate) => gate.id === "training_idle");
    const architectureIndex = sample.terminal.gates.findIndex(
      (gate) => gate.id === "architecture_governance_clean",
    );
    const consumptionIndex = (field: string) =>
      sample.terminal.ownerConsumption.owners.findIndex((owner) => owner.inputField === field);
    expect(sample.terminal.ownerConsumption.status).toBe("consistent");
    expect(sample.terminal.ownerConsumption.collectionRunId).toBe(
      sample.collected.trainingPlan?.collectionRunId,
    );
    expect(
      new Set(Object.values(sample.collected).map((snapshot) => snapshot.collectionRunId)).size,
    ).toBe(1);
    const evidence: WorkflowHandoffEvidence[] = [
      {
        scenarioId: "commercial_acceptance_harness_waterflow",
        environment: "offline_fixture",
        nodes: [
          {
            nodeId: "training_plan",
            scope: ref("/collectorOutput/trainingPlan/collectionRunId"),
            output: ref("/collectorOutput/trainingPlan/payload/decisions"),
          },
          {
            nodeId: "flow_graph",
            scope: ref("/collectorOutput/flowGraph/collectionRunId"),
            output: ref("/collectorOutput/flowGraph/payload/summary"),
          },
          {
            nodeId: "mind_model",
            scope: ref("/collectorOutput/mindModel/collectionRunId"),
            output: ref("/collectorOutput/mindModel/payload/summary"),
          },
          {
            nodeId: "commercial_acceptance_harness",
            scope: ref("/terminal/ownerConsumption/collectionRunId"),
            output: ref("/terminal"),
            inputs: [
              {
                from: "training_plan",
                value: ref(`/terminal/gates/${trainingIndex}/evidence/decisions`),
              },
              {
                from: "flow_graph",
                value: ref(`/terminal/gates/${architectureIndex}/evidence/flowGraphSummary`),
              },
              {
                from: "mind_model",
                value: ref(`/terminal/gates/${architectureIndex}/evidence/mindModelSummary`),
              },
            ],
          },
        ],
      },
    ];
    for (const field of ["trainingPlan", "flowGraph", "mindModel"]) {
      const identity = sample.terminal.ownerConsumption.owners[consumptionIndex(field)];
      expect(identity.sourceFingerprintMatches).toBe(true);
    }
    const audit = (await auditWorkflowHandoffs(evidence)).find(
      (entry) => entry.scenarioId === evidence[0].scenarioId,
    );
    expect(audit?.status).toBe("handoff_gap");
    expect(
      audit?.gaps.some(
        (gap) =>
          ["training_plan", "flow_graph", "mind_model", "commercial_acceptance_harness"].includes(
            gap.node,
          ) && gap.reason.includes("receipt_field_missing"),
      ),
    ).toBe(false);
    await fs.writeFile(
      path.join(sample.directory, "fieldrefs-input.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    await fs.writeFile(
      path.join(sample.directory, "fieldrefs-audit.json"),
      JSON.stringify(audit, null, 2) + "\n",
    );
    const wrongScope = structuredClone(evidence);
    wrongScope[0].nodes[0].scope.pointer = "/collectorOutput/trainingPlan/owner";
    const wrongScopeAudit = (await auditWorkflowHandoffs(wrongScope)).find(
      (entry) => entry.scenarioId === evidence[0].scenarioId,
    );
    expect(wrongScopeAudit?.gaps.some((gap) => gap.reason.includes("scope_conflict"))).toBe(true);
    await fs.writeFile(
      path.join(sample.directory, "scope-conflict-audit.json"),
      JSON.stringify(wrongScopeAudit, null, 2) + "\n",
    );
    const badHash = structuredClone(evidence);
    badHash[0].nodes[0].scope.sha256 = "0".repeat(64);
    badHash[0].nodes[0].output!.sha256 = "0".repeat(64);
    const badAudit = (await auditWorkflowHandoffs(badHash)).find(
      (entry) => entry.scenarioId === evidence[0].scenarioId,
    );
    expect(badAudit?.gaps.some((gap) => gap.reason.includes("hash_conflict"))).toBe(true);
    await fs.writeFile(
      path.join(sample.directory, "hash-conflict-audit.json"),
      JSON.stringify(badAudit, null, 2) + "\n",
    );
  });

  it.each(["failed_training", "missing_training_state", "training_child_exception"] as const)(
    "keeps %s blocked with native child diagnosis instead of training idle",
    async (fault) => {
      const sample = await run(fault);
      expect(sample.calls).toHaveLength(14);
      expect(sample.terminal.readyForCommercialRelease).toBe(false);
      expect(sample.terminal.gates.some((gate) => gate.id === "training_idle")).toBe(false);
      const gate = sample.terminal.gates.find(
        (entry) => entry.id === "local-brain-training-plan_owner_unavailable",
      );
      expect(gate?.status).toBe("failed");
      if (fault === "failed_training") {
        expect(sample.collected.trainingPlan?.commandSucceeded).toBe(false);
        expect(gate?.evidence.payloadFailedReason).toBe("offline_training_source_unavailable");
        expect(gate?.evidence.error).toBe("owner_reported_failure");
      } else if (fault === "missing_training_state") {
        expect(gate?.evidence.missingStateFields).toEqual(["overlappingHeavyEval"]);
      } else {
        expect(gate?.evidence.error).toContain("private owner read unavailable");
        expect(sample.collected.trainingPlan?.payload).toBeUndefined();
      }
      expect(sample.collected.flowGraph?.payload).toBeDefined();
    },
  );

  it.each(["", "another_training_owner"])(
    "rejects caller ownership corruption %j after actual collection",
    async (owner) => {
      const sample = await run();
      const altered = structuredClone(sample.collected);
      altered.trainingPlan!.owner = owner;
      const terminal = buildCommercialAcceptanceHarness(altered);
      const gate = terminal.gates.find(
        (entry) => entry.id === "local-brain-training-plan_owner_unavailable",
      );
      expect(gate?.evidence.ownerIdentityMatches).toBe(false);
      expect(terminal.gates.some((entry) => entry.id === "training_idle")).toBe(false);
      await fs.writeFile(
        path.join(sample.directory, "caller-owner-fault.json"),
        JSON.stringify(
          {
            boundary: "post_collection_caller_fault_not_child_owner_identity",
            consumerInput: altered,
            terminal,
          },
          null,
          2,
        ) + "\n",
      );
    },
  );
  it.each(["wrong_batch", "changed_source"] as const)(
    "rejects provided %s in the original consumer receipt",
    async (fault) => {
      const sample = await run();
      const altered = structuredClone(sample.collected);
      if (fault === "wrong_batch") {
        altered.trainingPlan!.collectionRunId = "unrelated-host-collection";
      } else {
        altered.trainingPlan!.payload!.decisions = [{ action: "altered_after_collection" }];
      }
      const terminal = buildCommercialAcceptanceHarness(altered);
      expect(terminal.ownerConsumption.status).toBe("conflict");
      expect(terminal.failedGates).toContain("acceptance_owner_collection_identity_conflict");
      expect(terminal.readyForCommercialRelease).toBe(false);
      await fs.writeFile(
        path.join(sample.directory, `${fault}-consumer.json`),
        JSON.stringify({ consumerInput: altered, terminal }, null, 2) + "\n",
      );
    },
  );

  it("does not relabel injected or legacy owner snapshots as an observed host collection", async () => {
    const sample = await run();
    const legacy = structuredClone(sample.collected);
    for (const snapshot of Object.values(legacy)) {
      delete snapshot.collectionRunId;
      delete snapshot.sourceFingerprint;
    }
    const before = structuredClone(legacy);
    const terminal = buildCommercialAcceptanceHarness(legacy);
    expect(terminal.ownerConsumption.status).toBe("not_observed");
    expect(terminal.ownerConsumption.collectionRunId).toBeUndefined();
    expect(legacy).toEqual(before);
    expect(terminal.readyForCommercialRelease).toBe(false);
  });
});
