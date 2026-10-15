import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExternalChannelBindingDecision,
  buildExternalChannelBindingSummary,
} from "../scripts/operator/lcx-external-channel-binding.js";
import {
  auditWorkflowHandoffs,
  FLOW_SCENARIOS,
  workflowProcessEdges,
  type WorkflowFieldRef,
  type WorkflowHandoffEvidence,
  type WorkflowScopeBinding,
} from "../scripts/operator/lcx-flow-graph.js";
import { readFinanceActiveStrategyResearchScope } from "../src/agents/finance-night-review-context.js";
import { financeResearchScoredPath } from "../src/agents/finance-state-dir.js";
import {
  declareFinanceStrategyRule,
  activateFinanceStrategyRule,
} from "../src/agents/finance-strategy-rule-ledger.js";
import { runFinanceTuningLifecycle } from "../src/agents/finance-tuning-lifecycle.js";
import { LCX_ONTOLOGY_REGISTRY, validateLcxOntologyEdges } from "../src/shared/lcx-ontology.js";

const roots: string[] = [];
const financeCustodyProofDir = process.env.LCX_NATIVE_FINANCE_CUSTODY_PROOF_DIR;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const scenario = FLOW_SCENARIOS.find((item) => item.id === "finance_caseflow_waterflow")!;
async function fixture(selected = scenario, includeFeedback = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-handoff-audit-"));
  roots.push(root);
  const nodes: WorkflowHandoffEvidence["nodes"] = [];
  const edges = [...selected.edges, ...(includeFeedback ? (selected.feedbackEdges ?? []) : [])];
  const nodeIds = [...new Set([...selected.requiredNodes, ...edges.flat()])];
  for (const nodeId of nodeIds) {
    const payload = {
      scope: { runId: "fixture-run", accountId: "paper-fixture" },
      output: { nodeId, value: `result:${nodeId}` },
      inputs: Object.fromEntries(
        edges
          .filter(([, to]) => to === nodeId)
          .map(([from]) => [from, { nodeId: from, value: `result:${from}` }]),
      ),
    };
    const file = path.join(root, `${nodeId}.json`);
    const raw = JSON.stringify(payload);
    await fs.writeFile(file, raw);
    const ref = (pointer: string): WorkflowFieldRef => ({
      path: file,
      pointer,
      sha256: createHash("sha256").update(raw).digest("hex"),
    });
    nodes.push({
      nodeId,
      scope: ref("/scope"),
      output: ref("/output"),
      inputs: edges
        .filter(([, to]) => to === nodeId)
        .map(([from]) => ({ from, value: ref(`/inputs/${from}`) })),
    });
  }
  return { scenarioId: selected.id, environment: "offline_fixture" as const, nodes };
}
async function result(evidence: WorkflowHandoffEvidence) {
  return (await auditWorkflowHandoffs([evidence])).find((item) => item.scenarioId === scenario.id)!;
}
async function rewrite(
  entry: WorkflowHandoffEvidence["nodes"][number],
  patch: (value: Record<string, unknown>) => void,
) {
  const file = entry.output!.path;
  const payload = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  patch(payload);
  const raw = JSON.stringify(payload);
  await fs.writeFile(file, raw);
  const hash = createHash("sha256").update(raw).digest("hex");
  for (const ref of [
    entry.output!,
    entry.scope,
    ...(entry.block ? [entry.block.status, entry.block.reason] : []),
    ...(entry.inputs ?? []).map((input) => input.value),
    ...(entry.inputs ?? []).flatMap((input) =>
      Object.values(input.scopeBinding ?? {}).filter(
        (value): value is WorkflowFieldRef =>
          value !== null && typeof value === "object" && "path" in value && "sha256" in value,
      ),
    ),
  ]) {
    if (ref.path === file) {
      ref.sha256 = hash;
    }
  }
}

async function historicalFixture() {
  const evidence = await fixture();
  const [producer, consumer] = evidence.nodes;
  await rewrite(producer, (value) => {
    (value.scope as Record<string, string>).runId = "old-source-run";
  });
  const source = JSON.parse(await fs.readFile(producer.output!.path, "utf8")) as {
    scope: unknown;
  };
  await rewrite(consumer, (value) => {
    value.sourceReceipt = { path: producer.output!.path, sha256: producer.output!.sha256 };
    value.sourceScope = source.scope;
  });
  const ref = (pointer: string) => ({ ...consumer.output!, pointer });
  consumer.inputs![0].scopeBinding = {
    kind: "historical_to_attempt",
    receipt: ref("/sourceReceipt"),
    sourceScope: ref("/sourceScope"),
    sourceAccount: { ...producer.scope, pointer: "/scope/accountId" },
    targetAccount: ref("/scope/accountId"),
  };
  return evidence;
}

async function observationFixture() {
  const evidence = await fixture();
  const [producer, consumer] = evidence.nodes;
  const snapshot = {
    snapshotId: "current-snapshot",
    observedAt: "2026-10-12T00:00:00Z",
    sourceCommit: "fixture-commit",
    sourceBranch: "fixture-branch",
    authorityOwner: "fixture-observer",
  };
  for (const node of evidence.nodes.slice(1)) {
    await rewrite(node, (value) => {
      value.scope = snapshot;
    });
  }
  const source = JSON.parse(await fs.readFile(producer.output!.path, "utf8")) as {
    scope: unknown;
  };
  await rewrite(consumer, (value) => {
    value.snapshot = snapshot;
    value.runId = "current-observer-run";
    value.owners = {
      fixtureOwner: {
        latestWrittenReceipt: {
          receipt: { path: producer.output!.path, sha256: producer.output!.sha256 },
          sourceScope: source.scope,
          consumed: (value.inputs as Record<string, unknown>)[producer.nodeId],
        },
      },
    };
    value.ownerCommands = [
      {
        id: "fixtureOwner",
        runReceipt: {
          owner: "fixtureOwner",
          parentRunId: "current-observer-run",
          snapshot,
          phase: "observe",
        },
      },
    ];
  });
  consumer.scope.pointer = "/snapshot";
  const ref = (pointer: string) => ({ ...consumer.output!, pointer });
  consumer.inputs![0].value = ref("/owners/fixtureOwner/latestWrittenReceipt/consumed");
  consumer.inputs![0].scopeBinding = {
    kind: "read_only_observation",
    receipt: ref("/owners/fixtureOwner/latestWrittenReceipt/receipt"),
    sourceScope: ref("/owners/fixtureOwner/latestWrittenReceipt/sourceScope"),
    hostRunId: ref("/runId"),
    ownerParentRunId: ref("/ownerCommands/0/runReceipt/parentRunId"),
    ownerSnapshot: ref("/ownerCommands/0/runReceipt/snapshot"),
    ownerPhase: ref("/ownerCommands/0/runReceipt/phase"),
  };
  return evidence;
}

// These isolated receipt documents test the auditor contract, not a research execution.
async function scheduledResearchFixture(includeRules = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-scheduled-handoff-audit-"));
  roots.push(root);
  const manifestPath = path.join(root, "retained-original-manifest.json");
  const manifest = {
    schemaVersion: "finance_scheduled_research_handoff_v1",
    sourceScope: {
      runId: "scheduled-parent-run",
      accountId: "paper-fixture",
      venue: "paper",
      asOf: "2026-10-05T19:30:00.000Z",
    },
    inputs: {
      controllerEvidence: {
        path: path.join(root, "original-evidence.json"),
        sha256: "a".repeat(64),
        bytes: 20,
      },
      portfolioContext: {
        path: path.join(root, "original-context.json"),
        sha256: "b".repeat(64),
        bytes: 30,
      },
    },
  };
  const raw = JSON.stringify(manifest) + "\n";
  await fs.writeFile(manifestPath, raw);
  // Retained archive location differs from the original runtime producer path.
  const pin = {
    path: path.join(root, "original-runtime-manifest.json"),
    sha256: createHash("sha256").update(raw).digest("hex"),
    bytes: Buffer.byteLength(raw),
  };
  async function document(
    nodeId: "schedule_gate" | "finance_research_modules",
    payload: Record<string, unknown>,
  ) {
    const file = path.join(root, `${nodeId}.json`);
    const bytes = JSON.stringify(payload);
    await fs.writeFile(file, bytes);
    const ref = (pointer: string): WorkflowFieldRef => ({
      path: file,
      pointer,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    return { nodeId, scope: ref("/runId"), output: ref("/controllerHandoff/inputs") };
  }
  const producer = await document("schedule_gate", {
    runId: manifest.sourceScope.runId,
    accountId: manifest.sourceScope.accountId,
    controllerHandoff: { ...manifest, producer: pin },
  });
  const consumer: WorkflowHandoffEvidence["nodes"][number] = await document(
    "finance_research_modules",
    {
      runId: "native-child-checkpoint-run",
      accountId: manifest.sourceScope.accountId,
      venue: manifest.sourceScope.venue,
      asOf: manifest.sourceScope.asOf,
      controllerHandoff: { ...manifest, producer: pin },
    },
  );
  const ref = (pointer: string) => ({ ...consumer.output!, pointer });
  consumer.inputs = [
    {
      from: "schedule_gate",
      value: ref("/controllerHandoff/inputs"),
      scopeBinding: {
        kind: "scheduled_research_input",
        receipt: ref("/controllerHandoff/producer"),
        sourceScope: ref("/controllerHandoff/sourceScope"),
        expectedPin: { ...producer.output, pointer: "/controllerHandoff/producer" },
        manifest: { path: manifestPath, pointer: "", sha256: pin.sha256 },
        sourceAccount: { ...producer.output, pointer: "/accountId" },
        targetAccount: ref("/accountId"),
        targetVenue: ref("/venue"),
        targetAsOf: ref("/asOf"),
        consumerRunId: ref("/runId"),
      },
    },
  ];
  const evidence: WorkflowHandoffEvidence = {
    scenarioId: "finance_automatic_paper_trading_waterflow",
    environment: "offline_fixture",
    nodes: [producer, consumer],
  };
  let ruleNode: WorkflowHandoffEvidence["nodes"][number] | undefined;
  if (includeRules) {
    const ruleId = "private-original-rule";
    await declareFinanceStrategyRule(root, {
      kind: "declared",
      ruleId,
      form: "trend",
      instruments: ["SPY"],
      emits: "weights",
      schedule: { kind: "daily" },
      body: { frozenRule: { lookbackMonths: 6, budgetFraction: 0.4 } },
      observedAt: "2026-10-01T00:00:00Z",
    });
    await activateFinanceStrategyRule(root, {
      kind: "activated",
      ruleId,
      observedAt: "2026-10-02T00:00:00Z",
    });
    const originalScope = await readFinanceActiveStrategyResearchScope({
      directory: root,
      asOf: manifest.sourceScope.asOf,
      strategyIds: [ruleId],
    });
    const active = originalScope.evidence.find(
      (item) => item.id === "finance-controller:active-strategies",
    );
    if (!active) {
      throw new Error("actual active-strategy evidence missing");
    }
    const raw = JSON.stringify({ source: originalScope.source, evidence: active });
    const file = path.join(root, "original-rule-scope.json");
    await fs.writeFile(file, raw);
    const ruleRef = (pointer: string): WorkflowFieldRef => ({
      path: file,
      pointer,
      sha256: createHash("sha256").update(raw).digest("hex"),
    });
    ruleNode = {
      nodeId: "strategy_rule_ledger",
      scope: ruleRef("/source"),
      output: ruleRef("/evidence/text"),
    };
    await rewrite(consumer, (value) => {
      value.portfolioContext = {
        accountId: manifest.sourceScope.accountId,
        venue: manifest.sourceScope.venue,
        validityMinutes: 60,
        conflictPolicy: "block",
        activeStrategyIds: [ruleId],
        requiredInstruments: ["SPY"],
      };
      value.controllerEvidence = originalScope.evidence;
      value.controllerRuleUse = {
        source: originalScope.source,
        accountScope: {
          accountId: manifest.sourceScope.accountId,
          venue: manifest.sourceScope.venue,
          asOf: manifest.sourceScope.asOf,
        },
        evidence: { id: active.id, sha256: createHash("sha256").update(active.text).digest("hex") },
        parentRunId: manifest.sourceScope.runId,
      };
    });
    consumer.inputs.push({
      from: "strategy_rule_ledger",
      value: ref("/controllerEvidence/0/text"),
      scopeBinding: {
        kind: "active_strategy_rule_input",
        receipt: ref("/controllerRuleUse"),
        sourceScope: ref("/controllerRuleUse/source"),
        portfolioContext: ref("/portfolioContext"),
        asOf: ref("/asOf"),
        consumerRunId: ref("/runId"),
        parentRunId: ref("/controllerHandoff/sourceScope/runId"),
      },
    });
    evidence.nodes.push(ruleNode);
  }
  const audit = async () =>
    (await auditWorkflowHandoffs([evidence])).find(
      (row) => row.scenarioId === evidence.scenarioId,
    )!;
  return { evidence, producer, consumer, ruleNode, audit };
}

describe("original-receipt handoff auditor (diagnostic fixtures, not runtime acceptance)", () => {
  it.skipIf(!financeCustodyProofDir)(
    "binds only actual native finance tool custody while retaining body and feedback gaps",
    async () => {
      const proofRoot = financeCustodyProofDir!;
      const originalOutlet = path.join(
        proofRoot,
        "same-attempt-modules-normal-original-outlet.json",
      );
      const originalRaw = path.join(proofRoot, "same-attempt-modules-normal-receipt.json");
      const outputRoot = process.env.LCX_NATIVE_FINANCE_CUSTODY_RESULT_DIR;
      if (outputRoot) {
        await fs.mkdir(outputRoot, { recursive: true });
      }
      const record = (value: unknown) => value as Record<string, unknown>;
      const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
      const results: unknown[] = [];
      for (const fault of [
        "positive",
        "parent",
        "session",
        "hash",
        "native_id",
        "unknown_custody",
        "wrong_role",
      ]) {
        let outletPath = originalOutlet,
          rawPath = originalRaw;
        if (fault !== "positive") {
          const root = await fs.mkdtemp(path.join(outputRoot ?? os.tmpdir(), `custody-${fault}-`));
          if (!outputRoot) {
            roots.push(root);
          }
          outletPath = path.join(root, "outlet.json");
          rawPath = path.join(root, "receipt.json");
          const outlet = record(JSON.parse(await fs.readFile(originalOutlet, "utf8")));
          const raw = record(JSON.parse(await fs.readFile(originalRaw, "utf8")));
          const events = outlet.events as Record<string, unknown>[];
          const event = events.find(
            (entry) => entry.stream === "tool" && record(entry.data).phase === "result",
          )!;
          const details = record(record(record(event.data).result).details);
          if (fault === "parent") {
            event.runId = "foreign-parent";
          } else if (fault === "session") {
            event.sessionKey = "agent:foreign:session";
          } else if (fault === "native_id") {
            record(record(raw.toolInvocation).native).qualityRunId = "foreign-quality";
          } else if (fault === "unknown_custody") {
            record(raw.toolInvocation).status = "not_observed";
          }
          const rawBytes = JSON.stringify(raw, null, 2) + "\n";
          const rawSha = digest(rawBytes);
          const readback = record(outlet.originalReceiptReadback);
          readback.retainedPath = rawPath;
          readback.sha256 = rawSha;
          const modelInput = record(outlet.modelNextInput);
          modelInput.nativeReceiptSha256 = rawSha;
          modelInput.storedToolInvocation = raw.toolInvocation;
          record(modelInput.consumedToolJSON).receiptSha256 = rawSha;
          details.receiptSha256 = fault === "hash" ? "a".repeat(64) : rawSha;
          details.toolInvocation = raw.toolInvocation;
          await fs.writeFile(rawPath, rawBytes);
          await fs.writeFile(outletPath, JSON.stringify(outlet, null, 2) + "\n");
        }
        const outletSha = digest(await fs.readFile(outletPath));
        const rawSha = digest(await fs.readFile(rawPath));
        const ref = (pointer: string): WorkflowFieldRef => ({
          path: outletPath,
          sha256: outletSha,
          pointer,
        });
        const rawRef: WorkflowFieldRef = { path: rawPath, sha256: rawSha, pointer: "" };
        const node = (
          nodeId: WorkflowHandoffEvidence["nodes"][number]["nodeId"],
          scope: string,
          output: string,
        ): WorkflowHandoffEvidence["nodes"][number] => ({
          nodeId,
          scope: ref(scope),
          output: ref(output),
        });
        const P = "/source/receipt",
          Q = "/source/qualityRequests/0",
          A = "/auditCalls/0";
        const evidence: WorkflowHandoffEvidence = {
          scenarioId: "external_finance_research_waterflow",
          environment: "offline_fixture",
          nodes: [
            node("ingress_external_message", "/events/1/runId", "/resolverInput/CommandBody"),
            node("intent_classifier", "/events/1/runId", `${P}/plan/orchestration/selectionTrace`),
            node(
              "local_brain_planner",
              "/events/1/runId",
              `${P}/plan/orchestration/composition/topologicalOrder`,
            ),
            node(
              "source_registry",
              `${P}/batch/correlationId`,
              `${P}/batch/jobs/0/receipt/snapshot`,
            ),
            node("finance_research_modules", "/events/1/runId", `${P}/moduleExecution`),
            node(
              "finance_learning_memory",
              "/events/1/runId",
              `${P}/batch/committeeEvidence/1/text`,
            ),
            node("causal_map", "/events/1/runId", `${P}/batch/committeeEvidence/2/text`),
            node(
              "review_panel",
              `${P}/quality/runId`,
              `${P}/quality/finalArtifact/supportingAnalysis`,
            ),
            node(
              "control_room_summary",
              `${A}/output/auditInvocation/caller/runId`,
              `${A}/output/controlRoomSummary`,
            ),
            node("visible_reply", "/events/3/runId", "/receiver/0/text"),
          ],
        };
        const byId = new Map(evidence.nodes.map((entry) => [entry.nodeId, entry]));
        byId.get("intent_classifier")!.inputs = [
          { from: "ingress_external_message", value: ref("/source/invocation/runnerInput/ask") },
        ];
        byId.get("local_brain_planner")!.outputs = [
          { to: "source_registry", value: ref(`${P}/plan/sourceInspections/0/request`) },
        ];
        const attach = (
          from: WorkflowHandoffEvidence["nodes"][number]["nodeId"],
          to: WorkflowHandoffEvidence["nodes"][number]["nodeId"],
          pointer: string,
        ) => {
          const producer = byId.get(from)!,
            consumer = byId.get(to)!;
          const binding: WorkflowScopeBinding = {
            kind: "native_finance_tool_custody",
            receipt: ref(""),
            rawReceipt: rawRef,
            sourceScope: producer.scope,
          };
          (consumer.inputs ??= []).push({ from, value: ref(pointer), scopeBinding: binding });
        };
        attach("local_brain_planner", "source_registry", "/source/sourceCalls/0/request");
        // These actual ID/control readbacks do not match source bodies or Quality findings.
        attach(
          "source_registry",
          "finance_research_modules",
          `${P}/moduleExecution/nodes/0/inputEvidenceIds`,
        );
        attach("source_registry", "causal_map", `${P}/moduleExecution/nodes/2/inputEvidenceIds`);
        attach("finance_learning_memory", "review_panel", `${Q}/evidence/3/text`);
        attach("causal_map", "review_panel", `${Q}/evidence/4/text`);
        attach(
          "review_panel",
          "control_room_summary",
          `${A}/input/candidateContext/supportingAnalysis`,
        );
        byId.get("visible_reply")!.inputs = [
          { from: "control_room_summary", value: ref("/events/3/data/controlRoomSummary") },
        ];
        if (fault === "wrong_role") {
          byId.get("source_registry")!.scope = ref(`${P}/quality/runId`);
        }
        const audit = (await auditWorkflowHandoffs([evidence])).find(
          (entry) => entry.scenarioId === evidence.scenarioId,
        )!;
        expect(audit.status).toBe("handoff_gap");
        if (fault === "positive") {
          expect(
            audit.gaps.filter((gap) => gap.reason.startsWith("consumer_did_not_receive_output:")),
          ).toHaveLength(4);
          expect(audit.gaps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                node: "model_tool_decision",
                reason: "original_receipt_not_observed",
              }),
            ]),
          );
          expect(audit.gaps.some((gap) => gap.reason.startsWith("finance_custody_"))).toBe(false);
          if (outputRoot) {
            await fs.writeFile(
              path.join(outputRoot, "candidate-row.json"),
              JSON.stringify(evidence, null, 2) + "\n",
            );
          }
        } else {
          expect(audit.gaps.some((gap) => gap.reason.startsWith("finance_custody_"))).toBe(true);
        }
        results.push({ fault, evidence, audit });
      }
      if (outputRoot) {
        await fs.writeFile(
          path.join(outputRoot, "focused-results.json"),
          JSON.stringify(results, null, 2) + "\n",
        );
      }
    },
  );
  it("describes every declared node and feedback owner using existing ontology relations", async () => {
    expect(Object.keys(LCX_ONTOLOGY_REGISTRY.workflowProcesses)).toHaveLength(28);
    for (const flow of FLOW_SCENARIOS) {
      const stages = LCX_ONTOLOGY_REGISTRY.workflowProcesses[flow.id].stages;
      const nodes = new Set<string>(stages.flatMap((stage) => [...stage.nodes]));
      expect(
        [...flow.requiredNodes, ...(flow.feedbackEdges ?? []).flat()].every((node) =>
          nodes.has(node),
        ),
      ).toBe(true);
      expect(validateLcxOntologyEdges(workflowProcessEdges(flow))).toEqual([]);
      for (const stage of stages) {
        expect(
          stage.input.length * stage.output.length * stage.preconditions.length,
        ).toBeGreaterThan(0);
        if (stage.owner.startsWith("host-installed:")) {
          expect(stage.owner).toBe("host-installed:lcx-local-operator-loop.sh");
        } else {
          await expect(fs.stat(path.resolve(stage.owner))).resolves.toBeDefined();
        }
      }
    }
  });
  it.each(["native", "wrong_filter", "wrong_node", "unknown_status"] as const)(
    "recognizes only the original binding failure node/filter contract: %s",
    async (fault) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-binding-handoff-audit-"));
      roots.push(root);
      // The original pure owners consume a failed-probe observation. No real probe is run.
      const summary = buildExternalChannelBindingSummary(
        buildExternalChannelBindingDecision({
          apply: true,
          liveTouched: false,
          externalChannelStatusOk: false,
          userVisibleObserved: true,
          trainingPlan: {
            activeProcesses: [],
            externalChannelBinding: {
              status: "ready_for_apply",
              selectedCleanAdapter: "/fixture/adapter",
              missingProof: ["fresh_real_external_inbound_and_outbound_user_visible_observed"],
            },
          },
        }),
      );
      expect(summary.status).toBe("channel_runtime_probe_failed");
      expect(summary.userVisibleObserved).toBe(false);
      const raw = JSON.stringify({
        scope: { runId: "binding-audit-private", accountId: "offline-fixture" },
        originalOwnerSummary: {
          ...summary,
          ...(fault === "unknown_status" ? { status: "channel_other_failed" } : {}),
        },
      });
      const file = path.join(root, "original-binding-summary.json");
      await fs.writeFile(file, raw);
      const ref = (pointer: string): WorkflowFieldRef => ({
        path: file,
        pointer,
        sha256: createHash("sha256").update(raw).digest("hex"),
      });
      const audit = await auditWorkflowHandoffs([
        {
          scenarioId: "local_to_external_channel_external_waterflow",
          environment: "offline_fixture",
          nodes: [
            {
              nodeId: fault === "wrong_node" ? "channel_restart_probe" : "external_channel_binding",
              scope: ref("/scope"),
              block: {
                filter:
                  fault === "wrong_filter"
                    ? "real_external_inbound_required"
                    : "external_channel_probe_required",
                status: ref("/originalOwnerSummary/status"),
                reason: ref("/originalOwnerSummary/action"),
              },
            },
          ],
        },
      ]);
      const observation = audit.find(
        (entry) => entry.scenarioId === "local_to_external_channel_external_waterflow",
      )!;
      // Missing original change/test consumption still prevents whole-scene acceptance.
      expect(observation.status).toBe("handoff_gap");
      expect(observation.semanticAdoption).toBe("not_proven");
      if (fault === "native") {
        expect(observation.blocked).toEqual(["external_channel_binding"]);
        expect(observation.gaps).not.toContainEqual(
          expect.objectContaining({ reason: "unproven_or_unknown_block" }),
        );
      } else {
        expect(observation.blocked).toEqual([]);
        expect(observation.gaps).toContainEqual(
          expect.objectContaining({ reason: "unproven_or_unknown_block" }),
        );
      }
    },
  );
  it("keeps all 28 unobserved when only structure is supplied", async () => {
    const audit = await auditWorkflowHandoffs();
    expect(audit).toHaveLength(28);
    expect(
      audit.every(
        (item) => item.status === "not_observed" && item.semanticAdoption === "not_proven",
      ),
    ).toBe(true);
  });
  it("verifies original output readback in each consumer without claiming semantic adoption", async () => {
    const observed = await result(await fixture());
    expect(observed).toMatchObject({
      status: "handoffs_verified",
      proofLevel: "receipt_handoff_only",
      evidenceOrigin: "offline_fixture",
      semanticAdoption: "not_proven",
      gaps: [],
    });
  });
  it("checks the actual per-consumer output of a fork while retaining legacy receipts", async () => {
    const evidence = await fixture();
    const [producer, consumer] = evidence.nodes;
    await rewrite(producer, (value) => {
      value.branch = { value: "specific child content" };
    });
    await rewrite(consumer, (value) => {
      (value.inputs as Record<string, unknown>)[producer.nodeId] = {
        value: "specific child content",
      };
    });
    producer.outputs = [
      { to: consumer.nodeId, value: { ...producer.output!, pointer: "/branch" } },
    ];
    expect((await result(evidence)).status).toBe("handoffs_verified");
    delete producer.output;
    expect((await result(evidence)).status).toBe("handoffs_verified");
    producer.outputs[0].value.pointer = "/output";
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: `consumer_did_not_receive_output:${producer.nodeId}` }),
    );
  });
  it("rejects duplicate fork ports and undeclared targets", async () => {
    const evidence = await fixture();
    const [producer, consumer] = evidence.nodes;
    const port = { to: consumer.nodeId, value: producer.output! };
    producer.outputs = [port, port];
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: `duplicate_output:${consumer.nodeId}` }),
    );
    producer.outputs = [{ to: producer.nodeId, value: producer.output! }];
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: "output_target_outside_scenario" }),
    );
  });
  it("rejects a fork output in another receipt and a producer field masquerading as consumption", async () => {
    const evidence = await fixture();
    const [producer, consumer] = evidence.nodes;
    producer.outputs = [{ to: consumer.nodeId, value: consumer.output! }];
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: "output_not_in_producer_receipt" }),
    );
    producer.outputs = [{ to: consumer.nodeId, value: producer.output! }];
    consumer.inputs![0].value = producer.output!;
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: "consumption_not_in_consumer_receipt" }),
    );
  });
  it("declares the recovery sources as forks and joins with feedback to the actual window", () => {
    const recovery = FLOW_SCENARIOS.find(
      (flow) => flow.id === "compressed_context_recovery_waterflow",
    )!;
    for (const node of [
      "operator_latest_state",
      "mind_model",
      "flow_graph",
      "training_plan",
      "change_impact_plan",
    ]) {
      expect(recovery.edges).toContainEqual(["fixed_evidence_recovery", node]);
      expect(recovery.edges).toContainEqual([node, "central_agent_perception"]);
    }
    expect(recovery.feedbackEdges).toEqual([["central_agent_perception", "new_codex_window"]]);
    expect(recovery.end).toBe("central_agent_perception");
  });
  it("recognizes the original ran_failed receipt only at its declared error-receipt gate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-recovery-error-audit-"));
    roots.push(root);
    const file = path.join(root, "original-failed-step.json");
    const raw = JSON.stringify({
      scope: "offline-recovery",
      status: "ran_failed",
      reason: "owner cancelled; cleanup_confirmed",
    });
    await fs.writeFile(file, raw);
    const ref = (pointer: string): WorkflowFieldRef => ({
      path: file,
      pointer,
      sha256: createHash("sha256").update(raw).digest("hex"),
    });
    const recovery: WorkflowHandoffEvidence = {
      scenarioId: "compressed_context_recovery_waterflow",
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "new_codex_window",
          scope: ref("/scope"),
          block: {
            filter: "error_receipt_required",
            status: ref("/status"),
            reason: ref("/reason"),
          },
        },
      ],
    };
    const audit = async () =>
      (await auditWorkflowHandoffs([recovery])).find(
        (row) => row.scenarioId === recovery.scenarioId,
      )!;
    expect((await audit()).status).toBe("normal_block");
    recovery.nodes[0].block!.filter = "fresh_operator_state_required";
    expect((await audit()).status).toBe("handoff_gap");
  });
  it("locates the consumer and original owner when an input is lost", async () => {
    const evidence = await fixture();
    evidence.nodes[1].inputs = [];
    const observed = await result(evidence);
    expect(observed.status).toBe("handoff_gap");
    expect(observed.gaps).toContainEqual(
      expect.objectContaining({
        node: evidence.nodes[1].nodeId,
        owner: expect.any(String),
        reason: `consumer_did_not_receive_output:${evidence.nodes[0].nodeId}`,
      }),
    );
  });
  it("rejects a producer reference used as if it were a consumer readback", async () => {
    const evidence = await fixture();
    evidence.nodes[1].inputs![0].value = evidence.nodes[0].output!;
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: "consumption_not_in_consumer_receipt" }),
    );
  });
  it("rejects stale hashes and missing fields", async () => {
    const evidence = await fixture();
    evidence.nodes[1].output!.sha256 = "0".repeat(64);
    expect((await result(evidence)).status).toBe("handoff_gap");
    const second = await fixture();
    second.nodes[1].output!.pointer = "/missing";
    expect((await result(second)).gaps).toContainEqual(
      expect.objectContaining({ reason: "receipt_field_missing" }),
    );
  });
  it("rejects cross-account or cross-run receipts even if output values match", async () => {
    for (const field of ["accountId", "runId"]) {
      const evidence = await fixture();
      await rewrite(evidence.nodes[1], (value) => {
        (value.scope as Record<string, string>)[field] = "other";
      });
      expect((await result(evidence)).gaps).toContainEqual(
        expect.objectContaining({ reason: "run_or_account_scope_conflict" }),
      );
    }
  });
  it("allows independent finance root observations without pretending missing handoffs are complete", async () => {
    const finance = FLOW_SCENARIOS.find(
      (item) => item.id === "finance_automatic_paper_trading_waterflow",
    )!;
    const evidence = await fixture(finance);
    evidence.nodes = evidence.nodes.filter((node) =>
      ["schedule_gate", "research_run"].includes(node.nodeId),
    );
    const forecast = evidence.nodes.find((node) => node.nodeId === "research_run")!;
    await rewrite(forecast, (value) => {
      value.scope = path.join(path.dirname(forecast.output!.path), "research-samples.jsonl");
    });
    const observed = (await auditWorkflowHandoffs([evidence])).find(
      (row) => row.scenarioId === finance.id,
    )!;
    expect(observed.gaps).not.toContainEqual(
      expect.objectContaining({ reason: "run_or_account_scope_conflict" }),
    );
    expect(observed.status).toBe("handoff_gap");
    expect(observed.gaps).toContainEqual(
      expect.objectContaining({
        node: "night_settlement",
        reason: "handoff_not_observed:research_run",
      }),
    );
    expect(observed.gaps).toContainEqual(
      expect.objectContaining({
        node: "execution_intent",
        reason: "original_receipt_not_observed",
      }),
    );
  });
  it("still rejects a real finance execution edge across accounts when values match", async () => {
    const finance = FLOW_SCENARIOS.find(
      (item) => item.id === "finance_automatic_paper_trading_waterflow",
    )!;
    const evidence = await fixture(finance);
    const authorization = evidence.nodes.find(
      (node) => node.nodeId === "explicit_run_authorization",
    )!;
    await rewrite(authorization, (value) => {
      (value.scope as Record<string, string>).accountId = "foreign-paper-account";
    });
    const observed = (await auditWorkflowHandoffs([evidence])).find(
      (row) => row.scenarioId === finance.id,
    )!;
    expect(observed.status).toBe("handoff_gap");
    expect(observed.gaps).toContainEqual(
      expect.objectContaining({
        node: "explicit_run_authorization",
        reason: "handoff_scope_conflict:execution_intent",
      }),
    );
  });
  it("verifies a pinned scheduled research input while preserving independent parent and checkpoint runs", async () => {
    const { producer, consumer, audit } = await scheduledResearchFixture();
    const before = await Promise.all(
      [producer, consumer].map((entry) => fs.readFile(entry.scope.path)),
    );
    const observed = await audit();
    expect(observed.status).toBe("handoff_gap"); // All unobserved finance/night owners remain required.
    expect(
      observed.gaps.some(
        (gap) => gap.reason.includes("schedule_gate") && gap.node === "finance_research_modules",
      ),
    ).toBe(false);
    expect(
      observed.gaps.some(
        (gap) =>
          gap.reason.includes("scope_conflict") ||
          gap.reason.startsWith("scheduled_research_") ||
          gap.reason.startsWith("scope_binding_"),
      ),
    ).toBe(false);
    expect(observed.semanticAdoption).toBe("not_proven");
    expect(
      await Promise.all([producer, consumer].map((entry) => fs.readFile(entry.scope.path))),
    ).toEqual(before);
  });
  it.each([
    "manifest_hash",
    "pin_hash",
    "pin_path",
    "source_run",
    "child_run",
    "account",
    "venue",
    "asof",
    "input",
    "borrowed_ref",
    "wrong_route",
  ] as const)("rejects an invalid scheduled research input bridge: %s", async (fault) => {
    const { producer, consumer, audit } = await scheduledResearchFixture();
    const binding = consumer.inputs![0].scopeBinding!;
    if (binding.kind !== "scheduled_research_input") {
      throw new Error("fixture binding kind");
    }
    if (fault === "manifest_hash") {
      binding.manifest.sha256 = "0".repeat(64);
    } else if (fault === "borrowed_ref") {
      binding.targetAccount = binding.sourceAccount;
    } else if (fault === "wrong_route") {
      const other = await fixture();
      other.nodes[1].inputs![0].scopeBinding = binding;
      const observed = await result(other);
      expect(
        observed.gaps.some((gap) =>
          gap.reason.startsWith("scheduled_research_binding_owner_conflict"),
        ),
      ).toBe(true);
      return;
    } else {
      await rewrite(consumer, (value) => {
        const handoff = value.controllerHandoff as {
          sourceScope: { runId: string };
          producer: { sha256: string; path: string };
          inputs: { controllerEvidence: { sha256: string } };
        };
        if (fault === "pin_hash") {
          handoff.producer.sha256 = "0".repeat(64);
        }
        if (fault === "pin_path") {
          handoff.producer.path += ".different";
        }
        if (fault === "source_run") {
          handoff.sourceScope.runId = "other-parent";
        }
        if (fault === "child_run") {
          value.otherRunId = "other-child";
          binding.consumerRunId.pointer = "/otherRunId";
        }
        if (fault === "account") {
          value.accountId = "other-account";
        }
        if (fault === "venue") {
          value.venue = "alpaca";
        }
        if (fault === "asof") {
          value.asOf = "2026-10-06T19:30:00.000Z";
        }
        if (fault === "input") {
          handoff.inputs.controllerEvidence.sha256 = "f".repeat(64);
        }
      });
    }
    const observed = await audit();
    expect(observed.status).toBe("handoff_gap");
    expect(
      observed.gaps.some(
        (gap) =>
          gap.reason.startsWith("scheduled_research_") ||
          gap.reason.startsWith("scope_binding_not_in_consumer_receipt"),
      ),
    ).toBe(true);
    expect(producer.scope.pointer).toBe("/runId");
  });
  it("verifies the global active-rule source consumed by the current account without merging native identities", async () => {
    const { consumer, ruleNode, audit } = await scheduledResearchFixture(true);
    if (!ruleNode) {
      throw new Error("fixture rule node missing");
    }
    const before = await Promise.all(
      [consumer, ruleNode].map((node) => fs.readFile(node.scope.path)),
    );
    const observed = await audit();
    expect(observed.status).toBe("handoff_gap"); // Missing night and other owners remain required.
    expect(observed.semanticAdoption).toBe("not_proven");
    expect(
      observed.gaps.some(
        (gap) =>
          gap.node === "finance_research_modules" && gap.reason.endsWith(":strategy_rule_ledger"),
      ),
    ).toBe(false);
    expect(
      observed.gaps.some(
        (gap) =>
          gap.reason.includes("scope_conflict") ||
          gap.reason.startsWith("active_rule_") ||
          gap.reason.startsWith("scope_binding_"),
      ),
    ).toBe(false);
    expect(
      await Promise.all([consumer, ruleNode].map((node) => fs.readFile(node.scope.path))),
    ).toEqual(before);
  });
  it.each(["source_scope", "child", "parent", "borrowed_ref", "wrong_route"] as const)(
    "rejects an invalid global active-rule input binding: %s",
    async (fault) => {
      const { consumer, ruleNode, audit } = await scheduledResearchFixture(true);
      if (!ruleNode) {
        throw new Error("fixture rule node missing");
      }
      const binding = consumer.inputs!.find(
        (input) => input.from === "strategy_rule_ledger",
      )!.scopeBinding!;
      if (binding.kind !== "active_strategy_rule_input") {
        throw new Error("fixture rule binding kind");
      }
      if (fault === "source_scope") {
        await rewrite(ruleNode, (value) => {
          (value.source as Record<string, unknown>).asOf = "2026-10-06T19:30:00.000Z";
        });
      } else if (fault === "borrowed_ref") {
        binding.consumerRunId = ruleNode.scope;
      } else if (fault === "wrong_route") {
        const other = await fixture();
        other.nodes[1].inputs![0].scopeBinding = binding;
        const observed = await result(other);
        expect(
          observed.gaps.some(
            (gap) =>
              gap.reason.includes("binding_owner_conflict") ||
              gap.reason.includes("rule_input_route"),
          ),
        ).toBe(true);
        return;
      } else {
        await rewrite(consumer, (value) => {
          if (fault === "child") {
            value.otherRunId = "different-checkpoint";
            binding.consumerRunId.pointer = "/otherRunId";
          }
          if (fault === "parent") {
            (value.controllerRuleUse as Record<string, unknown>).parentRunId = "different-parent";
          }
        });
      }
      const observed = await audit();
      expect(observed.status).toBe("handoff_gap");
      expect(
        observed.gaps.some(
          (gap) =>
            (gap.reason.startsWith("active_rule_") || gap.reason.startsWith("scope_binding_")) &&
            gap.reason.endsWith(":strategy_rule_ledger"),
        ),
      ).toBe(true);
    },
  );
  it("permits a recorded historical source in a new attempt without rewriting either scope", async () => {
    const evidence = await historicalFixture();
    const scopes = await Promise.all(
      evidence.nodes.slice(0, 2).map((node) => fs.readFile(node.scope.path)),
    );
    expect(await result(evidence)).toMatchObject({
      status: "handoffs_verified",
      gaps: [],
      semanticAdoption: "not_proven",
    });
    expect(
      await Promise.all(evidence.nodes.slice(0, 2).map((node) => fs.readFile(node.scope.path))),
    ).toEqual(scopes);
    delete evidence.nodes[1].inputs![0].scopeBinding;
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: "handoff_scope_conflict:research_case" }),
    );
  });
  it.each([
    "hash",
    "path",
    "scope",
    "account",
    "borrowed_ref",
    "missing_content",
    "unbound_third_run",
  ] as const)("rejects an invalid historical provenance bridge: %s", async (fault) => {
    const evidence = await historicalFixture();
    const [producer, consumer, third] = evidence.nodes;
    const binding = consumer.inputs![0].scopeBinding!;
    if (fault === "borrowed_ref" && binding.kind === "historical_to_attempt") {
      binding.targetAccount = binding.sourceAccount;
    } else if (fault === "unbound_third_run") {
      await rewrite(third, (value) => {
        (value.scope as Record<string, string>).runId = "unbound-run";
      });
    } else {
      await rewrite(consumer, (value) => {
        if (fault === "hash") {
          (value.sourceReceipt as Record<string, unknown>).sha256 = "0".repeat(64);
        }
        if (fault === "path") {
          (value.sourceReceipt as Record<string, unknown>).path = producer.output!.path + ".other";
        }
        if (fault === "scope") {
          (value.sourceScope as Record<string, unknown>).runId = "wrong-source-run";
        }
        if (fault === "account") {
          (value.scope as Record<string, unknown>).accountId = "other-account";
        }
        if (fault === "missing_content") {
          (value.inputs as Record<string, unknown>)[producer.nodeId] = "different content";
        }
      });
    }
    const observed = await result(evidence);
    expect(observed.status).toBe("handoff_gap");
    const reasons = observed.gaps.map((gap) => gap.reason);
    const expected = {
      hash: "scope_binding_source_receipt_mismatch",
      path: "scope_binding_source_receipt_mismatch",
      scope: "scope_binding_source_scope_mismatch",
      account: "scope_binding_account_conflict",
      borrowed_ref: "scope_binding_not_in_consumer_receipt",
      missing_content: "consumer_did_not_receive_output",
      unbound_third_run: "run_or_account_scope_conflict",
    }[fault];
    expect(reasons.some((reason) => reason.startsWith(expected))).toBe(true);
  });
  it("permits only a pinned read-only observer with its own native parent and snapshot", async () => {
    const evidence = await observationFixture();
    expect(await result(evidence)).toMatchObject({
      status: "handoffs_verified",
      gaps: [],
      semanticAdoption: "not_proven",
    });
  });
  it.each([
    "old_snapshot",
    "wrong_parent",
    "write_phase",
    "host_as_child",
    "wrong_candidate",
    "wrong_owner_sibling",
    "arbitrary_child",
  ] as const)("rejects an invalid observation identity: %s", async (fault) => {
    const evidence = await observationFixture();
    const consumer = evidence.nodes[1];
    const binding = consumer.inputs![0].scopeBinding!;
    if (fault === "host_as_child" && binding.kind === "read_only_observation") {
      binding.ownerParentRunId = binding.hostRunId;
    } else {
      await rewrite(consumer, (value) => {
        const child = (value.ownerCommands as Array<{ runReceipt: Record<string, unknown> }>)[0]
          .runReceipt;
        if (fault === "old_snapshot") {
          (child.snapshot as Record<string, unknown>).snapshotId = "old-snapshot";
        }
        if (fault === "wrong_parent") {
          child.parentRunId = "old-observer-run";
        }
        if (fault === "write_phase") {
          child.phase = "write";
        }
        if (fault === "wrong_candidate") {
          (
            value.owners as Record<
              string,
              { latestWrittenReceipt: { receipt: Record<string, unknown> } }
            >
          ).fixtureOwner.latestWrittenReceipt.receipt.sha256 = "f".repeat(64);
        }
        if (fault === "wrong_owner_sibling") {
          child.owner = "otherOwner";
          (value.ownerCommands as Array<Record<string, unknown>>)[0].id = "otherOwner";
        }
        if (fault === "arbitrary_child") {
          value.foo = { id: "fixtureOwner", runReceipt: child };
        }
      });
      if (fault === "arbitrary_child" && binding.kind === "read_only_observation") {
        binding.ownerParentRunId.pointer = "/foo/runReceipt/parentRunId";
        binding.ownerSnapshot.pointer = "/foo/runReceipt/snapshot";
        binding.ownerPhase.pointer = "/foo/runReceipt/phase";
      }
    }
    const observed = await result(evidence);
    expect(observed.status).toBe("handoff_gap");
    expect(
      observed.gaps.some((gap) =>
        gap.reason.startsWith(
          fault === "wrong_candidate"
            ? "scope_binding_source_receipt_mismatch"
            : "scope_binding_observation_identity_conflict",
        ),
      ),
    ).toBe(true);
  });
  it("recognizes a source-gate block from its original status and reason", async () => {
    const evidence = await fixture();
    const first = evidence.nodes[0];
    await rewrite(first, (value) => {
      value.status = "blocked";
      value.reason = "source missing: upstream provider receipt absent";
    });
    first.block = {
      filter: "source_evidence_gate",
      status: { ...first.output!, pointer: "/status" },
      reason: { ...first.output!, pointer: "/reason" },
    };
    delete first.output;
    evidence.nodes = [first];
    expect(await result(evidence)).toMatchObject({ status: "normal_block", gaps: [] });
    first.block.filter = "protected_memory_guard";
    expect((await result(evidence)).status).toBe("handoff_gap");
  });
  it.each([false, true])(
    "keeps ordinary blocked descendants subject to post-block owner review: %s",
    async (includeSuccess) => {
      const evidence = await fixture();
      evidence.nodes = evidence.nodes.slice(0, includeSuccess ? 3 : 2);
      for (const [index, entry] of evidence.nodes.slice(0, 2).entries()) {
        await rewrite(entry, (value) => {
          value.status = "blocked";
          value.reason = `upstream source failure retained by owner ${index}`;
        });
        entry.block = {
          filter: "source_evidence_gate",
          status: { ...entry.output!, pointer: "/status" },
          reason: { ...entry.output!, pointer: "/reason" },
        };
      }
      const observed = await result(evidence);
      expect(observed.status).toBe("handoff_gap");
      expect(observed.blocked).toEqual(evidence.nodes.slice(0, 2).map((entry) => entry.nodeId));
      expect(observed.gaps).toContainEqual(
        expect.objectContaining({
          node: evidence.nodes[1].nodeId,
          reason: "downstream_observed_after_block_requires_owner_review",
        }),
      );
      if (includeSuccess) {
        expect(observed.gaps).toContainEqual(
          expect.objectContaining({
            node: evidence.nodes[2].nodeId,
            reason: "downstream_observed_after_block_requires_owner_review",
          }),
        );
      }
    },
  );
  it.each(["not_run", "execution_failed"] as const)(
    "exempts only the original scheduler non-execution refusal after research blocks: %s",
    async (outcome) => {
      const { evidence, consumer, audit } = await scheduledResearchFixture();
      await rewrite(consumer, (value) => {
        value.status = "quality-failed";
        value.reason = "research quality failed before allocation";
      });
      consumer.block = {
        filter: "research_receipt_required",
        status: { ...consumer.output!, pointer: "/status" },
        reason: { ...consumer.output!, pointer: "/reason" },
      };
      const payload = {
        runId: "native-child-checkpoint-run",
        status: outcome === "not_run" ? "failed" : "execution-failed",
        reason: "research_plan_not_accepted",
        output: { outcome, blockReason: "research_plan_not_accepted" },
      };
      const raw = JSON.stringify(payload);
      const file = path.join(path.dirname(consumer.scope.path), "scheduler-refusal.json");
      await fs.writeFile(file, raw);
      const ref = (pointer: string): WorkflowFieldRef => ({
        path: file,
        pointer,
        sha256: createHash("sha256").update(raw).digest("hex"),
      });
      evidence.nodes.push({
        nodeId: "finance_scheduler",
        scope: ref("/runId"),
        output: ref("/output"),
        block: {
          filter: "research_receipt_required",
          status: ref("/status"),
          reason: ref("/reason"),
        },
      });
      const observed = await audit();
      expect(observed.status).toBe("handoff_gap"); // Unobserved night/rule owners remain gaps.
      expect(observed.blocked).toContain("finance_scheduler");
      expect(
        observed.gaps.some(
          (gap) =>
            gap.node === "finance_scheduler" &&
            gap.reason === "downstream_observed_after_block_requires_owner_review",
        ),
      ).toBe(outcome !== "not_run");
    },
  );
  it("flags downstream receipts after a block for owner review", async () => {
    const evidence = await fixture();
    const first = evidence.nodes[0];
    await rewrite(first, (value) => {
      value.status = "timed_out";
      value.reason = "upstream response deadline";
    });
    first.block = {
      filter: "source_evidence_gate",
      status: { ...first.output!, pointer: "/status" },
      reason: { ...first.output!, pointer: "/reason" },
    };
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: "downstream_observed_after_block_requires_owner_review" }),
    );
  });

  it.each([
    "blocked_receipt",
    "wrong_reason",
    "wrong_filter",
    "missing_block_record",
    "ready_receipt",
    "wrong_handoff",
    "candidate_after_block",
    "observer_repair",
    "child_repair",
    "missing_observer",
    "map_repair",
    "map_wrong_parent",
  ] as const)(
    "distinguishes the self-repair %s from continuing candidate execution",
    async (kind) => {
      // Deliberately synthetic audit rows test the verifier; they are not original execution proof.
      const selected = FLOW_SCENARIOS.find((item) => item.id === "self_repair_hands_waterflow")!;
      const evidence = await fixture(selected, true);
      const snapshot = {
        snapshotId: "diagnostic-snapshot",
        observedAt: "2026-10-12T00:00:00Z",
        sourceCommit: "diagnostic-commit",
        sourceBranch: "diagnostic-branch",
        authorityOwner: "diagnostic-observer",
      };
      for (const entry of evidence.nodes) {
        await rewrite(entry, (value) => {
          value.scope = snapshot;
          if (["governance_autopilot", "owner_coverage_map"].includes(entry.nodeId)) {
            value.snapshot = snapshot;
            value.runId = "diagnostic-observation-run";
            value.runReceipt = {
              owner: "lcx-governance-autopilot",
              runId: value.runId,
              phase:
                (entry.nodeId === "governance_autopilot" && kind === "observer_repair") ||
                (entry.nodeId === "owner_coverage_map" && kind === "map_repair")
                  ? "repair"
                  : "observe",
              snapshot,
            };
            value.liveTouched = false;
            value.providerConfigTouched = false;
            value.protectedMemoryTouched = false;
            value.boundary =
              entry.nodeId === "governance_autopilot"
                ? "local_governance_autopilot_only"
                : "local_owner_control_map_only";
            if (entry.nodeId === "governance_autopilot") {
              value.ownerCommands = [
                {
                  id: "selfRepairHands",
                  runReceipt: {
                    owner: "selfRepairHands",
                    phase: kind === "child_repair" ? "repair" : "observe",
                    parentRunId: value.runId,
                    snapshot,
                  },
                },
              ];
              if (kind === "missing_observer") {
                delete value.ownerCommands;
              }
            } else {
              value.kind = "lcx-owner-control-map";
              if (kind === "map_wrong_parent") {
                (value.runReceipt as Record<string, unknown>).runId = "other-parent-run";
              }
            }
          }
        });
      }
      for (const nodeId of ["memory_write_gate", "self_repair_latest_receipt"] as const) {
        const entry = evidence.nodes.find((node) => node.nodeId === nodeId)!;
        await rewrite(entry, (value) => {
          value.status =
            nodeId === "self_repair_latest_receipt" && kind === "ready_receipt"
              ? "ready"
              : "blocked";
          value.reason =
            nodeId === "self_repair_latest_receipt" && kind === "wrong_reason"
              ? "different_attempt_failure"
              : "source_evidence_unreadable";
        });
        entry.block = {
          filter:
            nodeId === "self_repair_latest_receipt" && kind === "wrong_filter"
              ? "protected_memory_guard"
              : "memory_write_freshness_gate",
          status: { ...entry.output!, pointer: "/status" },
          reason: { ...entry.output!, pointer: "/reason" },
        };
        if (nodeId === "self_repair_latest_receipt" && kind === "missing_block_record") {
          delete entry.block;
        }
        if (nodeId === "self_repair_latest_receipt" && kind === "wrong_handoff") {
          await rewrite(entry, (value) => {
            (value.inputs as Record<string, unknown>).memory_write_gate = "unrelated verdict";
          });
        }
      }
      evidence.nodes = evidence.nodes.filter(
        (node) =>
          !["correction_note", "training_eval_candidate_packet", "review_panel"].includes(
            node.nodeId,
          ) ||
          (node.nodeId === "correction_note" && kind === "candidate_after_block"),
      );
      const observed = (await auditWorkflowHandoffs([evidence])).find(
        (row) => row.scenarioId === selected.id,
      )!;
      if (kind === "blocked_receipt") {
        expect(observed).toMatchObject({ status: "normal_block", gaps: [] });
      } else {
        expect(observed.status).toBe("handoff_gap");
        expect(observed.gaps).toContainEqual(
          expect.objectContaining({
            node:
              kind === "candidate_after_block"
                ? "correction_note"
                : kind === "map_repair" || kind === "map_wrong_parent"
                  ? "owner_coverage_map"
                  : ["observer_repair", "child_repair", "missing_observer"].includes(kind)
                    ? "governance_autopilot"
                    : "self_repair_latest_receipt",
            reason:
              kind === "wrong_handoff"
                ? "consumer_did_not_receive_output:memory_write_gate"
                : "downstream_observed_after_block_requires_owner_review",
          }),
        );
      }
      expect(observed.semanticAdoption).toBe("not_proven");
    },
  );
});

async function financeBookCustodyFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-book-custody-"));
  roots.push(root);
  async function originalFunctions(
    file: string,
    names: string[],
    dependencies: Record<string, unknown>,
  ) {
    const filename = path.resolve(import.meta.dirname, "..", file);
    const raw = await fs.readFile(filename);
    const ast = ts.createSourceFile(filename, raw.toString("utf8"), ts.ScriptTarget.Latest, true);
    const declarations = ast.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
    );
    if (declarations.length !== names.length) {
      throw new Error("original finance custody function unavailable");
    }
    const code = ts.transpileModule(declarations.map((node) => node.getText(ast)).join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    return {
      functions: vm.runInNewContext(`${code}; ({${names.join(",")}});`, {
        require: createRequire(import.meta.url),
        process: { pid: process.pid },
        Buffer,
        ...dependencies,
      }) as Record<string, (...args: unknown[]) => unknown>,
      source: {
        path: filename,
        sha256: createHash("sha256").update(raw).digest("hex"),
        parserSha256: createHash("sha256")
          .update(
            declarations.find((node) => node.name?.text === "parseNightSettlement")?.getText(ast) ??
              "",
          )
          .digest("hex"),
        callerSha256: createHash("sha256")
          .update(
            declarations.find((node) => node.name?.text === "runNightTuning")?.getText(ast) ?? "",
          )
          .digest("hex"),
      },
    };
  }
  const writer = await originalFunctions(
    "scripts/operator/lcx-finance-daily-cycle.ts",
    ["rowText", "scoredOutcomeKey", "appendScoredOutcomes"],
    { createHash },
  );
  const filename = financeResearchScoredPath(root);
  const rows = Array.from({ length: 5 }, (_unused, index) => ({
    instrument: "SPY",
    asOf: `2026-10-0${index + 1}T00:00:00.000Z`,
    direction: "up",
    conviction: 0.7,
    outcome: 1,
  }));
  const scoredFiled = await writer.functions.appendScoredOutcomes(filename, rows);
  const producerPayload = { scoredFiled };
  const rawSnapshot = path.join(root, "retained-scored-raw.bin");
  await fs.copyFile(filename, rawSnapshot);
  const raw = await fs.readFile(rawSnapshot);
  let callerInput: unknown;
  const scheduler = await originalFunctions(
    "scripts/operator/lcx-finance-scheduler.ts",
    ["parseNightSettlement", "runNightTuning"],
    {
      runFinanceTuningLifecycle: (params: Parameters<typeof runFinanceTuningLifecycle>[0]) => {
        callerInput = params;
        return runFinanceTuningLifecycle(params);
      },
    },
  );
  const parsed = scheduler.functions.parseNightSettlement(
    JSON.stringify({ scoredFiled, pending: [], declined: [], issues: [], reflection: null }),
  );
  const tuning = scheduler.functions.runNightTuning({
    directory: root,
    firedAt: "2026-10-06T00:00:00.000Z",
    settlement: parsed,
  });
  const consumerPayload = { parsed, callerInput, callerSource: scheduler.source, tuning };
  async function document(
    nodeId: "outcome_ledger" | "tuning_proposal",
    payload: unknown,
    scopePointer: string,
    outputPointer: string,
  ): Promise<WorkflowHandoffEvidence["nodes"][number] & { output: WorkflowFieldRef }> {
    const file = path.join(root, `${nodeId}.json`);
    const body = JSON.stringify(payload);
    await fs.writeFile(file, body);
    const ref = (pointer: string): WorkflowFieldRef => ({
      path: file,
      pointer,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    return { nodeId, scope: ref(scopePointer), output: ref(outputPointer) };
  }
  const producer = await document(
    "outcome_ledger",
    producerPayload,
    "/scoredFiled/path",
    "/scoredFiled",
  );
  const consumer: WorkflowHandoffEvidence["nodes"][number] = await document(
    "tuning_proposal",
    consumerPayload,
    "/callerInput/directory",
    "/tuning/result/sourceRead",
  );
  const ref = (pointer: string) => ({ ...consumer.output!, pointer });
  const binding: Extract<WorkflowScopeBinding, { kind: "finance_book_custody" }> = {
    kind: "finance_book_custody",
    receipt: ref("/tuning/result/sourceRead"),
    sourceScope: ref("/parsed/scoredFiled/sourceWrite"),
    writer: producer.output,
    callerInput: ref("/callerInput"),
    callerSource: ref("/callerSource"),
    ledgerRaw: {
      path: rawSnapshot,
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.length,
    },
  };
  consumer.inputs = [
    { from: "outcome_ledger", value: ref("/callerInput/expectedSource"), scopeBinding: binding },
  ];
  const evidence: WorkflowHandoffEvidence = {
    scenarioId: "finance_automatic_paper_trading_waterflow",
    environment: "offline_fixture",
    nodes: [producer, consumer],
  };
  return { producer, consumer, binding, evidence, producerPayload, consumerPayload, root };
}

describe("raw finance book custody bridge", () => {
  it("verifies original writer to host projection to actual tuner input without inventing a run or account", async () => {
    const f = await financeBookCustodyFixture();
    const before = await Promise.all(f.evidence.nodes.map((node) => fs.readFile(node.scope.path)));
    const observed = (await auditWorkflowHandoffs([f.evidence])).find(
      (item) => item.scenarioId === f.evidence.scenarioId,
    )!;
    expect(observed.status).toBe("handoff_gap"); // This component does not execute the whole paper scene.
    expect(
      observed.gaps.filter(
        (gap) =>
          gap.node === "tuning_proposal" &&
          (gap.reason.includes("outcome_ledger") || gap.reason.includes("finance_book_custody")),
      ),
    ).toEqual([]);
    expect(observed.gaps.some((gap) => gap.reason.includes("scope_conflict"))).toBe(false);
    expect(observed.semanticAdoption).toBe("not_proven");
    expect(f.consumerPayload.callerInput).toMatchObject({
      directory: f.root,
      expectedSource: JSON.parse(await fs.readFile(f.consumer.scope.path, "utf8")).parsed
        .scoredFiled.sourceWrite,
    });
    expect(f.consumerPayload.tuning).toMatchObject({
      ok: true,
      result: { newlyRecorded: 1, paperExecutionPromotion: { status: "blocked" } },
    });
    expect(f.producerPayload).not.toHaveProperty("accountId");
    expect(f.consumerPayload).not.toHaveProperty("runId");
    expect(await Promise.all(f.evidence.nodes.map((node) => fs.readFile(node.scope.path)))).toEqual(
      before,
    );
  });
  it.each([
    "foreign_scope",
    "caller_missing",
    "foreign_book",
    "input_hash",
    "input_bytes",
    "raw_bytes",
    "borrowed_ref",
    "caller_source",
    "wrong_route",
  ] as const)("rejects finance book custody %s", async (fault) => {
    const f = await financeBookCustodyFixture();
    if (fault === "foreign_scope") {
      await rewrite(f.producer, (value) => {
        value.foreignScope = { runId: "foreign-producer-run", accountId: "foreign-account-A" };
      });
      await rewrite(f.consumer, (value) => {
        value.foreignScope = { runId: "foreign-consumer-run", accountId: "foreign-account-B" };
      });
      f.producer.scope.pointer = "/foreignScope";
      f.consumer.scope.pointer = "/foreignScope";
    } else if (fault === "raw_bytes") {
      await fs.appendFile(f.binding.ledgerRaw.path, Buffer.from([0xff]));
    } else if (fault === "borrowed_ref") {
      f.binding.callerInput = f.producer.output;
    } else if (fault === "wrong_route") {
      f.producer.nodeId = "strategy_rule_ledger";
      f.consumer.nodeId = "finance_research_modules";
      f.consumer.inputs![0].from = "strategy_rule_ledger";
    } else {
      await rewrite(f.consumer, (value) => {
        const caller = value.callerInput as Record<string, unknown>;
        if (fault === "caller_missing") {
          delete value.callerInput;
        } else if (fault === "foreign_book") {
          caller.directory = path.join(f.root, "foreign-book");
        } else if (fault === "caller_source") {
          (value.callerSource as Record<string, unknown>).callerSha256 = "0".repeat(64);
        } else {
          const pin = caller.expectedSource as Record<string, unknown>;
          if (fault === "input_hash") {
            pin.sha256 = "0".repeat(64);
          } else {
            pin.bytes = Number(pin.bytes) + 1;
          }
        }
      });
    }
    const observed = (await auditWorkflowHandoffs([f.evidence])).find(
      (item) => item.scenarioId === f.evidence.scenarioId,
    )!;
    expect(observed.status).toBe("handoff_gap");
    expect(
      observed.gaps.some(
        (gap) =>
          gap.reason.includes("finance_book_custody") ||
          gap.reason.includes("scope_binding_not_in_consumer_receipt") ||
          gap.reason.includes("receipt_field_missing"),
      ),
    ).toBe(true);
  });
});

const failedPlanProofDir = process.env.LCX_FINANCE_FAILED_PLAN_READ_PROOF_DIR;
const failedPlanOldSource = process.env.LCX_FINANCE_FAILED_PLAN_OLD_SOURCE;
describe("retained original portfolio plan failed-reader side custody", () => {
  it
    .skipIf(!failedPlanProofDir || !failedPlanOldSource)
    .each(["matching", "hash", "account", "run", "source_snapshot"])(
    "keeps the original scheduler owner and verifies later failed read: %s",
    async (variant) => {
      const sidePath = path.join(failedPlanProofDir!, "failed-day-reader-replay.json");
      const sideBytes = await fs.readFile(sidePath);
      const side = JSON.parse(sideBytes.toString("utf8")) as {
        originalProof: { path: string; sha256: string };
        result: {
          portfolioPlanInput: {
            read: { sha256: string };
            expected: { accountId: string; parentRunId: string };
          };
        };
      };
      const originalPath = side.originalProof.path;
      const originalBytes = await fs.readFile(originalPath);
      const originalSha = createHash("sha256").update(originalBytes).digest("hex");
      expect(originalSha).toBe(side.originalProof.sha256);
      const original = JSON.parse(originalBytes.toString("utf8")) as {
        cliOutput: {
          portfolioPlanWrite: { path: string; sha256: string };
          receipt: { controllerHandoff: { producer: { path: string; sha256: string } } };
        };
        result: { operatorSourceSha256: string };
      };
      const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "failed-plan-side-"));
      roots.push(privateRoot);
      const modifiedSidePath = path.join(privateRoot, "failed-reader.json");
      if (variant === "hash") {
        side.result.portfolioPlanInput.read.sha256 = "0".repeat(64);
      }
      if (variant === "account") {
        side.result.portfolioPlanInput.expected.accountId = "foreign-account";
      }
      if (variant === "run") {
        side.result.portfolioPlanInput.expected.parentRunId = "foreign-run";
      }
      const modifiedSideBytes = Buffer.from(JSON.stringify(side));
      await fs.writeFile(modifiedSidePath, modifiedSideBytes);
      const sideSha = createHash("sha256").update(modifiedSideBytes).digest("hex");
      const from = (pointer: string): WorkflowFieldRef => ({
        path: originalPath,
        sha256: originalSha,
        pointer,
      });
      const later = (pointer: string): WorkflowFieldRef => ({
        path: modifiedSidePath,
        sha256: sideSha,
        pointer,
      });
      const binding: WorkflowScopeBinding = {
        kind: "portfolio_plan_failed_read",
        plan: from("/cliOutput/receipt/portfolioPlan"),
        writePin: from("/cliOutput/portfolioPlanWrite"),
        sourceReceipt: from("/cliOutput/receipt"),
        rawPlan: { ...original.cliOutput.portfolioPlanWrite, pointer: "" },
        handoffManifest: { ...original.cliOutput.receipt.controllerHandoff.producer, pointer: "" },
        schedulerReceipt: from("/result/nativeScheduler/record"),
        actualOperatorArgv: from("/result/operatorArgv"),
        originalReaderSourcePin: from("/result/operatorSourceSha256"),
        originalReaderSource: {
          path: failedPlanOldSource!,
          sha256:
            variant === "source_snapshot" ? "0".repeat(64) : original.result.operatorSourceSha256,
        },
        receiver: later("/result"),
        receiverSource: later("/source"),
        replayArgv: later("/actualReplayArgv"),
        receipt: later("/result/portfolioPlanInput"),
        sourceScope: later("/result/portfolioPlanInput/parsedScope"),
      };
      const observation: WorkflowHandoffEvidence = {
        scenarioId: "finance_automatic_paper_trading_waterflow",
        environment: "offline_fixture",
        nodes: [
          {
            nodeId: "portfolio_plan",
            scope: from("/cliOutput/receipt/portfolioPlan/provenance/receiptId"),
            output: binding.plan,
          },
          {
            nodeId: "finance_scheduler",
            scope: from("/result/nativeScheduler/record/runId"),
            output: from("/result/nativeScheduler/record/execution"),
            inputs: [
              {
                from: "portfolio_plan",
                value: from(
                  "/result/nativeScheduler/record/researchPlanRefresh/portfolioPlanWrite",
                ),
                scopeBinding: binding,
              },
            ],
            block: {
              filter: "portfolio_plan_required",
              status: from("/result/nativeScheduler/record/status"),
              reason: from("/result/dayReport/error"),
            },
          },
        ],
      };
      const row = (await auditWorkflowHandoffs([observation])).find(
        (entry) => entry.scenarioId === observation.scenarioId,
      )!;
      const bridgeGaps = row.gaps.filter(
        (gap) =>
          gap.node === "finance_scheduler" &&
          (gap.reason.includes("portfolio_plan_failed_read") ||
            gap.reason === "consumer_did_not_receive_output:portfolio_plan" ||
            gap.reason === "handoff_scope_conflict:portfolio_plan"),
      );
      expect(row.status).toBe("handoff_gap"); // Other original owners have not been run by this test.
      expect(row.blocked).toContain("finance_scheduler");
      if (variant === "matching") {
        expect(bridgeGaps, JSON.stringify(row)).toEqual([]);
      } else {
        const expected = {
          hash: "portfolio_plan_failed_read_read_pin_conflict:portfolio_plan",
          account: "portfolio_plan_failed_read_account_scope_conflict:portfolio_plan",
          run: "portfolio_plan_failed_read_parent_run_conflict:portfolio_plan",
          source_snapshot: "portfolio_plan_failed_read_original_source_conflict:portfolio_plan",
        }[variant];
        expect(bridgeGaps).toContainEqual(expect.objectContaining({ reason: expected }));
      }
    },
  );
});

const questionBridgeProofDir = process.env.LCX_QUESTION_BRIDGE_PROOF_DIR;
describe("retained original commercial question typed bridge", () => {
  async function questionInput(variant?: "rawHash" | "askScope" | "projection" | "rolecontext") {
    const root = questionBridgeProofDir!;
    const rawRef = async (file: string, pointer: string): Promise<WorkflowFieldRef> => ({
      path: path.join(root, file),
      pointer,
      sha256: createHash("sha256")
        .update(await fs.readFile(path.join(root, file)))
        .digest("hex"),
    });
    const evidence = JSON.parse(
      await fs.readFile(path.join(root, "blocked-candidate-row.json"), "utf8"),
    ) as WorkflowHandoffEvidence;
    const callerFile =
      variant === "rawHash"
        ? "question-typed-bridge/tampered-raw-packet.json"
        : variant === "askScope"
          ? "question-typed-bridge/tampered-ask-scope.json"
          : "original-caller-ports.json";
    const artifactFile =
      variant === "rolecontext"
        ? "question-typed-bridge/tampered-role-context.json"
        : "original-artifact.json";
    const sideFile =
      variant === "projection"
        ? "question-typed-bridge/tampered-projection.json"
        : "metadata-readback.json";
    const pins = JSON.parse(await fs.readFile(path.join(root, "source-pins.json"), "utf8")) as {
      sources: Array<{ path: string; sha256: string }>;
    };
    const sourcePin = (suffix: string) => pins.sources.find((pin) => pin.path.endsWith(suffix))!;
    const producerPacket = await rawRef(callerFile, "/plannerOutput");
    const binding: WorkflowScopeBinding = {
      kind: "commercial_question_requirements",
      receipt: await rawRef(artifactFile, "/processEvidence/questionRequirements"),
      sourceScope: await rawRef(
        artifactFile,
        "/processEvidence/questionRequirements/actualAskSha256",
      ),
      producerPacket,
      callerProof: await rawRef(callerFile, ""),
      projectionSideproof: await rawRef(sideFile, "/readback"),
      actualModelRequests: await rawRef(callerFile, "/actualModelRequests"),
      helperSource: sourcePin("src/agents/provider-learning-council.ts"),
      plannerSource: sourcePin("scripts/operator/lcx-commercial-answer-pipeline.ts"),
    };
    evidence.nodes.push(
      {
        nodeId: "local_brain_planner",
        scope: await rawRef(callerFile, "/plannerInput/askSha256"),
        output: producerPacket,
      },
      {
        nodeId: "model_council",
        scope: await rawRef(artifactFile, "/messageId"),
        output: await rawRef(artifactFile, ""),
        inputs: [
          {
            from: "local_brain_planner",
            value: await rawRef(
              artifactFile,
              "/processEvidence/questionRequirements/receivedInputSha256",
            ),
            scopeBinding: binding,
          },
        ],
      },
    );
    return evidence;
  }
  it.skipIf(!questionBridgeProofDir)(
    "observes only the actual question bridge and keeps original refusal and other gaps",
    async () => {
      const evidence = await questionInput();
      const actual = (await auditWorkflowHandoffs([evidence])).find(
        (row) => row.scenarioId === evidence.scenarioId,
      )!;
      expect(actual.status).toBe("handoff_gap");
      expect(actual.blocked).toContain("visible_answer_adoption_gate");
      expect(actual.gaps.some((gap) => gap.node === "model_council")).toBe(false);
      expect(actual.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            node: "control_room_summary",
            reason: "downstream_observed_after_block_requires_owner_review",
          }),
          expect.objectContaining({
            node: "ingress_external_message",
            reason: "original_receipt_not_observed",
          }),
        ]),
      );
      if (process.env.LCX_QUESTION_BRIDGE_RESULT_DIR) {
        await fs.mkdir(process.env.LCX_QUESTION_BRIDGE_RESULT_DIR, { recursive: true });
        await fs.writeFile(
          path.join(process.env.LCX_QUESTION_BRIDGE_RESULT_DIR, "positive-result.json"),
          JSON.stringify({ evidence, actual }, null, 2) + "\n",
        );
      }
    },
  );
  const negativeCases = [
    ["rawHash", "question_bridge_raw_packet_hash_conflict"],
    ["askScope", "question_bridge_actual_ask_scope_conflict"],
    ["projection", "question_bridge_projection_builder_conflict"],
    ["rolecontext", "question_bridge_actual_role_context_conflict"],
  ] as const;
  for (const [variant, reason] of negativeCases) {
    it.skipIf(!questionBridgeProofDir)(
      `rejects repinned ${variant} rather than borrowing scope`,
      async () => {
        const evidence = await questionInput(variant);
        const actual = (await auditWorkflowHandoffs([evidence])).find(
          (row) => row.scenarioId === evidence.scenarioId,
        )!;
        expect(actual.status).toBe("handoff_gap");
        expect(actual.blocked).toContain("visible_answer_adoption_gate");
        expect(actual.gaps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              node: "model_council",
              reason: `${reason}:local_brain_planner`,
            }),
            expect.objectContaining({
              node: "model_council",
              reason: "consumer_did_not_receive_output:local_brain_planner",
            }),
          ]),
        );
        if (process.env.LCX_QUESTION_BRIDGE_RESULT_DIR) {
          await fs.mkdir(process.env.LCX_QUESTION_BRIDGE_RESULT_DIR, { recursive: true });
          await fs.writeFile(
            path.join(process.env.LCX_QUESTION_BRIDGE_RESULT_DIR, `${variant}-result.json`),
            JSON.stringify({ evidence, actual }, null, 2) + "\n",
          );
        }
      },
    );
  }
});

describe("retained commercial blocked diagnostic continuation", () => {
  async function diagnosticInput() {
    const root = questionBridgeProofDir!;
    const evidence = JSON.parse(
      await fs.readFile(path.join(root, "question-typed-source/candidate-row.json"), "utf8"),
    ) as WorkflowHandoffEvidence;
    const summary = evidence.nodes.find((node) => node.nodeId === "control_room_summary")!;
    const ref = (pointer: string): WorkflowFieldRef => ({ ...summary.output!, pointer });
    summary.block = {
      filter: "no_internal_runtime_details_visible",
      status: ref("/gateOutput/trace/controlRoomSummary/status"),
      reason: ref("/gateOutput/trace/nativeFailedReasons/0"),
    };
    return evidence;
  }
  async function auditDiagnostic(evidence: WorkflowHandoffEvidence) {
    return (await auditWorkflowHandoffs([evidence])).find(
      (row) => row.scenarioId === evidence.scenarioId,
    )!;
  }
  const outputDir = process.env.LCX_DIAGNOSTIC_CONTINUATION_RESULT_DIR;
  async function retain(
    name: string,
    evidence: WorkflowHandoffEvidence,
    actual: Awaited<ReturnType<typeof auditDiagnostic>>,
  ) {
    if (outputDir) {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(
        path.join(outputDir, `${name}.json`),
        JSON.stringify({ evidence, actual }, null, 2) + "\n",
      );
    }
  }
  it.skipIf(!questionBridgeProofDir)(
    "recognizes actual returned diagnostic but retains independent readback alias gap",
    async () => {
      const evidence = await diagnosticInput(),
        actual = await auditDiagnostic(evidence);
      expect(actual.status).toBe("handoff_gap");
      expect(actual.blocked).toContain("visible_answer_adoption_gate");
      expect(actual.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            node: "control_room_summary",
            reason: "producer_field_cannot_serve_as_consumer_readback:visible_answer_adoption_gate",
          }),
        ]),
      );
      expect(
        actual.gaps.some(
          (gap) =>
            gap.node === "control_room_summary" &&
            gap.reason === "downstream_observed_after_block_requires_owner_review",
        ),
      ).toBe(false);
      await retain("positive", evidence, actual);
    },
  );
  it.skipIf(!questionBridgeProofDir)(
    "rejects repinned non-diagnostic summary boundary",
    async () => {
      const evidence = await diagnosticInput();
      const summary = evidence.nodes.find((node) => node.nodeId === "control_room_summary")!;
      const old = summary.output!;
      const oldPath = old.path;
      const raw = JSON.parse(await fs.readFile(old.path, "utf8")) as {
        gateOutput: { trace: { controlRoomSummary: { authority: string } } };
      };
      raw.gateOutput.trace.controlRoomSummary.authority = "execution_allowed";
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-diagnostic-negative-"));
      roots.push(root);
      const file = path.join(root, "tampered-negative.json"),
        bytes = JSON.stringify(raw);
      await fs.writeFile(file, bytes);
      const sha = createHash("sha256").update(bytes).digest("hex");
      for (const node of evidence.nodes) {
        for (const ref of [
          node.scope,
          node.output,
          ...(node.inputs ?? []).map((input) => input.value),
          ...(node.outputs ?? []).map((output) => output.value),
          ...(node.block ? [node.block.status, node.block.reason] : []),
        ]) {
          if (ref?.path === oldPath) {
            ref.path = file;
            ref.sha256 = sha;
          }
        }
      }
      const actual = await auditDiagnostic(evidence);
      expect(actual.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            node: "control_room_summary",
            reason: "commercial_diagnostic_continuation_diagnostic_boundary_conflict",
          }),
          expect.objectContaining({
            node: "control_room_summary",
            reason: "downstream_observed_after_block_requires_owner_review",
          }),
        ]),
      );
      await retain("wrong-summary", evidence, actual);
    },
  );
  it.skipIf(!questionBridgeProofDir)(
    "rejects different native failed reason on the summary",
    async () => {
      const evidence = await diagnosticInput();
      const summary = evidence.nodes.find((node) => node.nodeId === "control_room_summary")!;
      summary.block!.reason.pointer = "/gateOutput/trace/nativeFailedReasons/1";
      const actual = await auditDiagnostic(evidence);
      expect(actual.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            node: "control_room_summary",
            reason: "commercial_diagnostic_continuation_reason_or_filter_conflict",
          }),
          expect.objectContaining({
            node: "control_room_summary",
            reason: "downstream_observed_after_block_requires_owner_review",
          }),
        ]),
      );
      await retain("wrong-reason", evidence, actual);
    },
  );
  it.skipIf(!questionBridgeProofDir)(
    "does not excuse claimed ordinary downstream execution",
    async () => {
      const evidence = await diagnosticInput();
      const summary = evidence.nodes.find((node) => node.nodeId === "control_room_summary")!;
      evidence.nodes.push({
        nodeId: "reply_flow_audit",
        scope: { ...summary.scope },
        output: { ...summary.output! },
      });
      const actual = await auditDiagnostic(evidence);
      expect(actual.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            node: "reply_flow_audit",
            reason: "downstream_observed_after_block_requires_owner_review",
          }),
        ]),
      );
      await retain("ordinary-descendant", evidence, actual);
    },
  );
});

describe("canonical selected-field digest encoding", () => {
  async function digestFixture() {
    const evidence = await fixture();
    const [producer, consumer] = evidence.nodes;
    const original = JSON.parse(await fs.readFile(producer.output!.path, "utf8")) as {
      output: { nodeId: string; value: string };
    };
    const digest = createHash("sha256").update(JSON.stringify(original.output)).digest("hex");
    await rewrite(consumer, (value) => {
      (value.inputs as Record<string, unknown>)[producer.nodeId] = digest;
    });
    producer.output!.encoding = "canonical_json_sha256";
    return { evidence, producer, consumer };
  }
  it("matches a selected native JSON fingerprint with an independently received digest field", async () => {
    const { evidence } = await digestFixture();
    expect((await result(evidence)).status).toBe("handoffs_verified");
  });
  it("keeps a wrong received fingerprint as an actual consumption gap", async () => {
    const { evidence, producer, consumer } = await digestFixture();
    await rewrite(consumer, (value) => {
      (value.inputs as Record<string, unknown>)[producer.nodeId] = "0".repeat(64);
    });
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: `consumer_did_not_receive_output:${producer.nodeId}` }),
    );
  });
  it("cannot use an encoding difference to disguise the same producer pointer as readback", async () => {
    const evidence = await fixture();
    const [producer, consumer] = evidence.nodes;
    const original = JSON.parse(await fs.readFile(producer.output!.path, "utf8")) as {
      output: unknown;
    };
    await rewrite(consumer, (value) => {
      value.producerOutput = original.output;
    });
    producer.scope = { ...consumer.scope };
    producer.output = { ...consumer.output!, pointer: "/producerOutput" };
    consumer.inputs![0].value = { ...producer.output, encoding: "canonical_json_sha256" };
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({
        reason: `producer_field_cannot_serve_as_consumer_readback:${producer.nodeId}`,
      }),
    );
  });
  it("rejects unknown encodings after the original receipt validations", async () => {
    const evidence = await fixture();
    Object.assign(evidence.nodes[0].output!, { encoding: "unknown" });
    expect((await result(evidence)).gaps).toContainEqual(
      expect.objectContaining({ reason: "invalid_field_encoding" }),
    );
  });
  it("preserves the default original content representation", async () => {
    expect((await result(await fixture())).status).toBe("handoffs_verified");
  });
});
