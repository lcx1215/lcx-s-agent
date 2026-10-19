import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowFieldRef,
  WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import {
  compactReceipts,
  runCentralHarnessCycle,
} from "../../src/agents/central-harness/harness-loop.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import type {
  CentralActionPlan,
  CentralPerception,
  CentralRunReceipt,
} from "../../src/agents/central-harness/types.js";

/** Native original owners and files; only the window/model consumer is scripted. */
export async function probeOriginalRecoveryWaterflow(
  directory: string,
  tracePath: string,
  runId: string,
  taskBinding: { path: string; threadId: string },
) {
  const taskRaw = await fs.readFile(taskBinding.path, "utf8");
  const task = JSON.parse(taskRaw) as {
    threadId: string;
    objective: string;
    status: string;
    oneNextAction: string;
  };
  assert.equal(task.threadId, taskBinding.threadId, "caller must bind its own task card");
  assert.ok(task.objective && task.status && task.oneNextAction);
  const boundTask = {
    ...taskBinding,
    sha256: createHash("sha256").update(taskRaw).digest("hex"),
    objective: task.objective,
    status: task.status,
    nextAction: task.oneNextAction,
  };
  const registry = new Map(
    createCentralToolRegistry({
      workspaceDir: directory,
      config: {
        agents: {
          defaults: {
            workspace: directory,
            memorySearch: {
              enabled: true,
              store: { path: path.join(directory, "private-artifacts.sqlite") },
            },
          },
        },
      },
    }),
  );
  for (const id of registry.keys()) {
    if (!new Set(["contextRecovery", "artifact_memory_recall"]).has(id)) {
      registry.delete(id);
    }
  }
  const spec = registry.get("contextRecovery")!;
  const nativeExecute = spec.execute;
  const calls: { args: Record<string, unknown>; returned?: Readonly<Record<string, unknown>> }[] =
    [];
  registry.set("contextRecovery", {
    ...spec,
    execute: async (args, signal) => {
      const call = { args: structuredClone(args) } as (typeof calls)[number];
      calls.push(call);
      const result = await nativeExecute(args, signal);
      call.returned = structuredClone(result);
      return result;
    },
  });
  const receipts: CentralRunReceipt[] = [],
    perceptions: CentralPerception[] = [],
    brainInputs: CentralPerception[] = [],
    plans: CentralActionPlan[] = [];
  const cycle = async (propose: (input: CentralPerception) => CentralActionPlan) => {
    const input: CentralPerception = {
      observedAt: new Date().toISOString(),
      ownerTotals: {},
      controlRoom: { recoveryTask: boundTask },
      backlog: compactReceipts(receipts, 10, new Set(registry.keys())),
      boundaries: [
        "offline_scripted_window",
        "broker_unknown_remains_blocked",
        "no_execution_authority",
      ],
    };
    perceptions.push(structuredClone(input));
    const receipt = await runCentralHarnessCycle({
      runId: `${runId}:${receipts.length}`,
      perception: input,
      registry,
      brain: {
        propose: async (seen) => {
          brainInputs.push(structuredClone(seen));
          const plan = propose(seen);
          plans.push(structuredClone(plan));
          return {
            kind: "proposed",
            provider: "offline-fixture",
            modelId: "scripted-recovery-window",
            plan,
          };
        },
      },
    });
    receipts.push(receipt);
    return receipt;
  };
  const observed = await cycle(() => ({
    actions: [{ ownerId: "contextRecovery", args: {} }],
    note: "Recover each original owner and preserve gaps before judging current state.",
  }));
  const artifact = observed.steps[0].resultArtifact;
  assert.ok(artifact?.id && artifact.sha256);
  const owner = calls[0].returned?.receipt as Record<string, unknown>;
  assert.ok(owner && Array.isArray(owner.checks));
  const checks = owner.checks as { id: string; evidence?: Record<string, unknown> }[];
  const checkIndex = (id: string) => {
    const index = checks.findIndex((check) => check.id === id);
    assert.ok(index >= 0, id);
    return index;
  };
  const events = (await fs.readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const event = (kind: string, script: string) => {
    const value = events.find((row) => row.kind === kind && row.script === script);
    assert.ok(value, `${kind}:${script}`);
    return value;
  };
  const childStart = (script: string) => {
    const request = event("source_request", script);
    const start = events.find(
      (row) => row.kind === "process_start" && row.script === script && row.ppid === request.pid,
    );
    assert.ok(start, `original child not observed:${script}`);
    return start;
  };
  const source = (script: string) =>
    JSON.parse(String(event("source_response", script).stdout)) as Record<string, unknown>;
  const trainingSource = source("local-brain-training-plan.ts");
  const firstDecision = (trainingSource.decisions as { id: string }[])[0].id;
  const trainingIndex = checkIndex("fresh_training_plan_decision_visible_after_recovery");
  const training = checks[trainingIndex].evidence?.currentTrainingPlan as { decisionIds: string[] };
  const selectedDecision = training.decisionIds.indexOf(firstDecision);
  assert.ok(selectedDecision >= 0);
  assert.deepEqual(
    training.decisionIds,
    (trainingSource.decisions as { id: string }[]).map((value) => value.id).toSorted(),
  );
  const fields = [
    `/value/receipt/checks/${checkIndex("local_operator_latest_is_readable")}/evidence/checkedAt`,
    `/value/receipt/checks/${checkIndex("mind_model_recovers_macro_workflow")}/evidence/passed`,
    `/value/receipt/checks/${checkIndex("flow_graph_recovers_task_waterflows")}/evidence/filters`,
    `/value/receipt/checks/${trainingIndex}/evidence/currentTrainingPlan/decisionIds/${selectedDecision}`,
    "/value/receipt/handoffForNewWindow/changeImpact/affectedLanes",
    "/value/receipt/actionableFailures",
  ];
  const read = await cycle(() => ({
    actions: fields.map((field) => ({
      ownerId: "artifact_memory_recall",
      args: { action: "read", id: artifact.id, field },
    })),
    note: "Retrieve the concrete original owner fields, without rerunning sources.",
  }));
  assert.equal(read.steps.length, fields.length);
  for (const step of read.steps) {
    assert.equal(step.outcome?.available, true);
    assert.equal(step.outcome?.sourceSha256, artifact.sha256);
  }
  let gapCount = -1;
  const judgment = await cycle((input) => {
    const delivered = input.backlog
      .flatMap((row) => (row.outcomes ?? []) as { outcome?: Record<string, unknown> }[])
      .map((step) => step.outcome)
      .filter(Boolean);
    for (const field of fields) {
      assert.ok(
        delivered.some((value) => value?.field === field && Object.hasOwn(value, "selectedValue")),
        `content not delivered:${field}`,
      );
    }
    const gaps = delivered.find((value) => value?.field === fields[5])?.selectedValue;
    assert.ok(Array.isArray(gaps));
    gapCount = gaps.length;
    const reason = gapCount
      ? `Recovery is unresolved: ${gaps.join("; ")}. Broker remains blocked.`
      : "Retain the recovered owner scope and application-ready boundaries; broker remains blocked and no execution is authorized.";
    return {
      actions: [],
      note: reason,
      evidenceUse: [
        {
          artifactId: artifact.id!,
          sourceSha256: artifact.sha256!,
          field: fields[5],
          effect: gapCount ? "unresolved" : "retain",
          reason,
        },
      ],
    };
  });
  assert.equal(judgment.steps.length, 0);
  assert.ok(judgment.evidenceUse?.[0].sourceValueSha256);
  const write = async (name: string, value: Record<string, unknown>) => {
    const file = path.join(directory, name + ".json");
    await fs.writeFile(file, JSON.stringify({ scope: runId, ...value }, null, 2) + "\n");
    return file;
  };
  const ref = async (file: string, pointer: string): Promise<WorkflowFieldRef> => ({
    path: file,
    pointer,
    sha256: createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex"),
  });
  const starts = [
    "lcx-mind-model.ts",
    "lcx-flow-graph.ts",
    "local-brain-training-plan.ts",
    "lcx-change-impact-plan.ts",
  ];
  const operatorRead = events.find(
    (row) =>
      row.kind === "file_read" && String(row.path).endsWith("lcx-local-operator-latest.json"),
  );
  assert.ok(operatorRead);
  const operatorRequest = events.find(
    (row) => row.kind === "file_request" && row.path === operatorRead.path,
  );
  assert.ok(operatorRequest);
  const windowFile = await write("native-window-observations", { plans, brainInputs });
  const fixedFile = await write("native-recovery-request-observations", {
    received: calls[0],
    operatorRequest,
    requests: starts.map((script) => event("source_request", script)),
  });
  const operatorFile = await write("native-operator-read-observation", {
    read: operatorRead,
    payload: JSON.parse(String(operatorRead.text)),
  });
  const mindFile = await write("native-mind-observations", {
    start: childStart(starts[0]),
    payload: source(starts[0]),
  });
  const flowFile = await write("native-flow-observations", {
    start: childStart(starts[1]),
    payload: source(starts[1]),
  });
  const trainingFile = await write("native-training-observations", {
    start: childStart(starts[2]),
    payload: trainingSource,
  });
  const impactFile = await write("native-impact-observations", {
    start: childStart(starts[3]),
    payload: source(starts[3]),
  });
  const joinedFile = await write("native-next-perception", { perception: perceptions[2] });
  const inputPointer = (field: string) => {
    for (const [rowIndex, row] of perceptions[2].backlog.entries()) {
      for (const [stepIndex, step] of (
        (row.outcomes ?? []) as { outcome?: Record<string, unknown> }[]
      ).entries()) {
        if (step.outcome?.field === field) {
          return `/perception/backlog/${rowIndex}/outcomes/${stepIndex}/outcome/selectedValue`;
        }
      }
    }
    throw new Error("selected field missing from actual next perception");
  };
  const nativeFieldPairs = [
    [operatorFile, "/payload/checkedAt"],
    [mindFile, "/payload/summary/passed"],
    [flowFile, "/payload/summary/filters"],
    [trainingFile, "/payload/decisions/0/id"],
    [impactFile, "/payload/affectedLanes"],
  ] as const;
  const nodeIds = [
    "operator_latest_state",
    "mind_model",
    "flow_graph",
    "training_plan",
    "change_impact_plan",
  ] as const;
  const nodes: WorkflowHandoffEvidence["nodes"] = [
    {
      nodeId: "new_codex_window",
      scope: await ref(windowFile, "/scope"),
      output: await ref(windowFile, "/plans/0/actions/0/args"),
      inputs: [
        {
          from: "central_agent_perception",
          value: await ref(windowFile, "/brainInputs/2/backlog"),
        },
      ],
    },
    {
      nodeId: "fixed_evidence_recovery",
      scope: await ref(fixedFile, "/scope"),
      inputs: [{ from: "new_codex_window", value: await ref(fixedFile, "/received/args") }],
      outputs: [
        { to: "operator_latest_state", value: await ref(fixedFile, "/operatorRequest/path") },
        ...(await Promise.all(
          nodeIds.slice(1).map(async (to, index) => ({
            to,
            value: await ref(fixedFile, `/requests/${index}/options`),
          })),
        )),
      ],
    },
  ];
  for (const [index, nodeId] of nodeIds.entries()) {
    const [file, output] = nativeFieldPairs[index];
    nodes.push({
      nodeId,
      scope: await ref(file, "/scope"),
      inputs: [
        {
          from: "fixed_evidence_recovery",
          value: await ref(file, index === 0 ? "/read/path" : "/start/options"),
        },
      ],
      output: await ref(file, output),
    });
  }
  nodes.push({
    nodeId: "central_agent_perception",
    scope: await ref(joinedFile, "/scope"),
    inputs: await Promise.all(
      nodeIds.map(async (from, index) => ({
        from,
        value: await ref(joinedFile, inputPointer(fields[index])),
      })),
    ),
    output: await ref(joinedFile, "/perception/backlog"),
  });
  const evidence: WorkflowHandoffEvidence = {
    scenarioId: "compressed_context_recovery_waterflow",
    environment: "offline_fixture",
    nodes,
  };
  return {
    boundTask,
    evidence,
    ownerOk: owner.ok,
    ownerSummary: owner.summary,
    gapCount,
    judgment,
    receipts,
    perceptions,
    nativeSourceTrace: tracePath,
    nativeFieldPairCount: nativeFieldPairs.length,
    additionalTrainingDecisionComparison: true,
    proofBoundary: "native_local_sources_and_tool_loop_with_scripted_window_not_natural_adoption",
    brokerConfirmed: false,
    actionsExecuted: judgment.steps.length,
  };
}
