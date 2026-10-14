/** Original research intake, gateway, composition, terminal review and tool-loop feedback. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildPipelineResult } from "../../scripts/operator/lcx-commercial-answer-pipeline.js";
import type {
  WorkflowHandoffEvidence,
  WorkflowFieldRef,
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
import {
  composeFinanceAnswer,
  type FinanceModelCaller,
} from "../../src/agents/finance-answer-composer.js";
import type {
  FinanceDataGatewayInput,
  FinanceDataGatewaySnapshot,
} from "../../src/agents/finance-data-gateway.js";
import {
  runFinanceRealtimeRefresh,
  type FinanceRealtimeRefreshReceipt,
  type FinanceRealtimeSourceRequest,
} from "../../src/agents/finance-realtime-source-registry.js";
import { probeOriginalCaseflow } from "./lcx-waterflow-caseflow-probe.js";

export async function probeOriginalGatewayWhole(
  directory: string,
  fault?: "missing_source" | "timeout" | "unchanged",
) {
  await fs.mkdir(directory, { recursive: true });
  const scope = `offline-gateway-${path.basename(directory)}`;
  const research = await probeOriginalCaseflow({
    directory: path.join(directory, "research"),
    caseId: scope,
    fault: fault === "missing_source" || fault === "timeout" ? fault : "conflicting_source",
  });
  assert.ok(research.receipt.batch);
  const job = research.receipt.batch.jobs.find((value) => value.kind === "realtime")!;
  assert.ok(job.receipt && job.kind === "realtime");
  const sourceReceipt = job.receipt as FinanceRealtimeRefreshReceipt;
  const registry = new Map(
    [
      ...createCentralToolRegistry({
        workspaceDir: directory,
        config: {
          agents: {
            defaults: {
              workspace: directory,
              memorySearch: {
                enabled: true,
                store: { path: path.join(directory, "private.sqlite") },
              },
            },
          },
        },
      }),
    ].filter(([id]) => ["finance_data_gateway_snapshot", "artifact_memory_recall"].includes(id)),
  );
  const receipts: CentralRunReceipt[] = [],
    inputs: CentralPerception[] = [],
    plans: CentralActionPlan[] = [];
  const executions: {
    args: Readonly<Record<string, unknown>>;
    result?: Readonly<Record<string, unknown>>;
  }[] = [];
  const spec = registry.get("finance_data_gateway_snapshot")!;
  registry.set(spec.ownerId, {
    ...spec,
    execute: async (args, signal) => {
      const call: (typeof executions)[number] = { args: structuredClone(args) };
      executions.push(call);
      const result = await spec.execute(args, signal);
      call.result = structuredClone(result);
      return result;
    },
  });
  const cycle = async (
    review: Record<string, unknown>,
    decide: (seen: CentralPerception) => CentralActionPlan | Promise<CentralActionPlan>,
  ) => {
    const receipt = await runCentralHarnessCycle({
      registry,
      capabilityOwnerIds: new Set(registry.keys()),
      perception: {
        observedAt: new Date().toISOString(),
        ownerTotals: {},
        controlRoom: { gatewayReview: review },
        backlog: compactReceipts(receipts, 10, new Set(registry.keys())),
        boundaries: [
          "offline_scripted",
          "broker_unknown_remains_blocked",
          "no_execution_authority",
        ],
      },
      brain: {
        propose: async (seen) => {
          inputs.push(structuredClone(seen));
          const plan = await decide(seen);
          plans.push(structuredClone(plan));
          return {
            kind: "proposed",
            provider: "offline-fixture",
            modelId: "scripted-terminal-consumer",
            plan,
          };
        },
      },
    });
    receipts.push(receipt);
    return receipt;
  };
  const file = path.join(directory, "original-gateway-handoffs.json");
  const trace: Record<string, unknown> = {
    scope,
    research,
    sourceReceipt,
    executions,
    receipts,
    inputs,
    plans,
  };
  const ref = async (pointer: string): Promise<WorkflowFieldRef> => ({
    path: file,
    pointer,
    sha256: createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex"),
  });
  if (fault && fault !== "unchanged") {
    assert.equal(sourceReceipt.status, "blocked");
    assert.ok(sourceReceipt.sourceAttempts.every((attempt) => attempt.status === "failed"));
    const gaps = sourceReceipt.sourceAttempts.map((attempt) => attempt.error);
    await cycle({ sourceStatus: sourceReceipt.status, gaps }, (seen) => {
      assert.deepEqual((seen.controlRoom.gatewayReview as Record<string, unknown>).gaps, gaps);
      return {
        actions: [],
        note: `Unresolved ${fault}: ${gaps.join("; ")}; broker remains blocked.`,
      };
    });
    assert.equal(receipts[0].steps.length, 0);
    if (fault === "timeout") {
      assert.ok(research.sourceCalls.every((call) => call.aborted));
    }
    await fs.writeFile(file, JSON.stringify(trace, null, 2) + "\n");
    const evidence: WorkflowHandoffEvidence = {
      scenarioId: "finance_data_gateway_waterflow",
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "finance_research_modules",
          scope: await ref("/scope"),
          output: await ref("/sourceReceipt/request/instrument"),
        },
      ],
    };
    for (const [index, id] of [
      "primary_market_data_provider",
      "cross_check_market_data_provider",
      "official_reference_data_provider",
    ].entries()) {
      evidence.nodes.push({
        nodeId: id as WorkflowHandoffEvidence["nodes"][number]["nodeId"],
        scope: await ref("/scope"),
        block: {
          filter: "source_evidence_gate",
          status: await ref(`/sourceReceipt/sourceAttempts/${index}/status`),
          reason: await ref(`/sourceReceipt/sourceAttempts/${index}/error`),
        },
      });
    }
    return {
      evidence,
      tracePath: file,
      fault,
      sourceReceipt,
      executions,
      receipts,
      inputs,
      modelCalls: 0,
      final: "unresolved",
      brokerConfirmed: false,
    };
  }
  const sourceInput: FinanceDataGatewayInput = {
    ...sourceReceipt.request,
    asOfMode: "historical",
    observations: research.sourceCalls.flatMap((call) => (call.response ? [call.response] : [])),
  };
  assert.equal(sourceInput.observations.length, 3);
  await cycle({}, () => ({
    actions: [{ ownerId: spec.ownerId, args: sourceInput }],
    note: "Validate actual observations returned by the original research intake.",
  }));
  const first = executions[0].result as unknown as FinanceDataGatewaySnapshot;
  assert.equal(first.qualityStatus, "needs_review");
  const compose = async (snapshot: FinanceDataGatewaySnapshot) => {
    const modelInputs: Parameters<FinanceModelCaller>[0][] = [];
    const composerInput = { ask: "分析一下比特币最近的风险", model: "offline-fixture", snapshot };
    const composed = await composeFinanceAnswer({
      ...composerInput,
      callModel: async (request) => {
        modelInputs.push(structuredClone(request));
        return {
          text: '比特币研究要点:市场报价 100 USD,来源与时间戳见网关证据。结构叙事:流动性驱动。论点与反论点:需求强但估值高;利率上行或需求转弱则证伪。催化剂:政策变化。风险与失效路径:关注流动性和监管。组合影响:仅作研究,不构成加减仓建议。下一步:补齐证据并核对数据快照再定量。\n```figures\n[{"kind":"observed","name":"last_price","value":100,"unit":"USD"}]\n```',
        };
      },
    });
    const modelGrounding = modelInputs[0].systemContext.slice(
      modelInputs[0].systemContext.indexOf("Finance data gateway snapshot"),
    );
    assert.equal(modelGrounding, composed.groundingContext);
    const reviewInput = {
      ask: composerInput.ask,
      candidateAnswer: composed.candidateAnswer,
      snapshot,
      requireGrounding: true,
    };
    const audited = buildPipelineResult(reviewInput.ask, reviewInput.candidateAnswer, reviewInput);
    return { composerInput, modelInputs, modelGrounding, composed, reviewInput, audited };
  };
  const before = await compose(first);
  assert.equal(before.audited.terminalDecision, "return_failed_reason");
  trace.before = before;
  const review = {
    terminalDecision: before.audited.terminalDecision,
    failedReasons: before.audited.failedReasons,
    grounding: before.audited.answerGrounding,
    conflicts: first.conflicts,
    artifact: receipts[0].steps[0].resultArtifact,
  };
  trace.review = review;
  await cycle(review, async (seen) => {
    const actual = seen.controlRoom.gatewayReview as typeof review;
    assert.equal(actual.terminalDecision, "return_failed_reason");
    assert.ok(actual.conflicts.some((gap) => gap.fieldName === "last_price"));
    assert.ok(actual.failedReasons.length);
    const correctionCalls: FinanceRealtimeSourceRequest[] = [];
    const returned = structuredClone(sourceInput.observations[1]);
    if (fault !== "unchanged") {
      returned.fields[0].value = 100;
      returned.fields[0].sourceUrlOrArtifact =
        "fixture://cross_check_market_data/corrected/BTCUSDT";
    }
    const correctionReceipt = await runFinanceRealtimeRefresh({
      request: sourceReceipt.request,
      timeoutMs: 1_000,
      adapters: [
        {
          id: "offline-corrected-cross-check",
          providerName: returned.providerName,
          providerRole: returned.providerRole,
          priority: 1,
          supports: () => true,
          collect: async (request) => {
            correctionCalls.push(structuredClone(request));
            return returned;
          },
        },
      ],
    });
    assert.equal(correctionCalls.length, 1);
    assert.equal(correctionCalls[0].instrument, sourceInput.instrument);
    const correctedInput = structuredClone(sourceInput);
    correctedInput.observations[1] = returned;
    trace.correction = { calls: correctionCalls, returned, receipt: correctionReceipt };
    assert.equal(correctedInput.observations[1].fields[0].value, fault === "unchanged" ? 110 : 100);
    return {
      actions: [{ ownerId: spec.ownerId, args: correctedInput }],
      note: "Terminal review refused conflicting last_price 100/110. Revalidate newly returned offline source observations for that field; no preferred-price override.",
    };
  });
  assert.deepEqual(executions[1].args, plans[1].actions[0].args);
  const second = executions[1].result as unknown as FinanceDataGatewaySnapshot;
  assert.equal(second.qualityStatus, fault === "unchanged" ? "needs_review" : "ready");
  const after = await compose(second);
  trace.after = after;
  await cycle(
    {
      terminalDecision: after.audited.terminalDecision,
      qualityStatus: second.qualityStatus,
      failedReasons: after.audited.failedReasons,
    },
    (seen) => {
      const result = seen.controlRoom.gatewayReview as Record<string, unknown>;
      assert.equal(
        result.terminalDecision,
        fault === "unchanged" ? "return_failed_reason" : "adopt_visible_answer",
      );
      return {
        actions: [],
        note:
          fault === "unchanged"
            ? "Unresolved: repeated last_price 100/110 observations still conflict; retain refusal and broker block."
            : "Retain the research answer after corrected source and terminal grounding checks. Upstream truth, profitability and broker confirmation remain unproven.",
      };
    },
  );
  assert.equal(receipts[2].steps.length, 0);
  await fs.writeFile(file, JSON.stringify(trace, null, 2) + "\n");
  const nodes: WorkflowHandoffEvidence["nodes"] = [];
  const node = async (
    nodeId: WorkflowHandoffEvidence["nodes"][number]["nodeId"],
    outputs: [string, string][],
    ins: [string, string][] = [],
  ) => {
    nodes.push({
      nodeId,
      scope: await ref("/scope"),
      outputs: await Promise.all(
        outputs.map(async ([to, pointer]) => ({
          to: to as typeof nodeId,
          value: await ref(pointer),
        })),
      ),
      inputs: await Promise.all(
        ins.map(async ([from, pointer]) => ({
          from: from as typeof nodeId,
          value: await ref(pointer),
        })),
      ),
    });
  };
  await node("finance_research_modules", [
    ["finance_data_gateway", "/sourceReceipt/request/instrument"],
  ]);
  for (const [index, id] of [
    "primary_market_data_provider",
    "cross_check_market_data_provider",
    "official_reference_data_provider",
  ].entries()) {
    await node(id as WorkflowHandoffEvidence["nodes"][number]["nodeId"], [
      ["finance_data_gateway", `/research/sourceCalls/${index}/response`],
    ]);
  }
  await node(
    "finance_data_gateway",
    [
      ["normalized_data_snapshot", "/executions/0/result"],
      ["data_provenance_quality_review", "/executions/0/result"],
    ],
    [
      ["finance_research_modules", "/executions/0/args/instrument"],
      ["primary_market_data_provider", "/executions/0/args/observations/0"],
      ["cross_check_market_data_provider", "/executions/0/args/observations/1"],
      ["official_reference_data_provider", "/executions/0/args/observations/2"],
      ["review_panel", "/executions/1/args"],
    ],
  );
  await node(
    "normalized_data_snapshot",
    [["causal_map", "/before/composed/groundingContext"]],
    [["finance_data_gateway", "/before/composerInput/snapshot"]],
  );
  await node(
    "data_provenance_quality_review",
    [["review_panel", "/before/composerInput/snapshot"]],
    [["finance_data_gateway", "/before/composerInput/snapshot"]],
  );
  await node(
    "causal_map",
    [["review_panel", "/before/composed/candidateAnswer"]],
    [["normalized_data_snapshot", "/before/modelGrounding"]],
  );
  await node(
    "review_panel",
    [
      ["control_room_summary", "/before/audited/terminalDecision"],
      ["finance_data_gateway", "/plans/1/actions/0/args"],
    ],
    [
      ["data_provenance_quality_review", "/before/reviewInput/snapshot"],
      ["causal_map", "/before/reviewInput/candidateAnswer"],
    ],
  );
  nodes.push({
    nodeId: "control_room_summary",
    scope: await ref("/scope"),
    output: await ref("/receipts/1/brainCall/note"),
    inputs: [
      {
        from: "review_panel",
        value: await ref("/inputs/1/controlRoom/gatewayReview/terminalDecision"),
      },
    ],
  });
  return {
    evidence: {
      scenarioId: "finance_data_gateway_waterflow",
      environment: "offline_fixture",
      nodes,
    } as WorkflowHandoffEvidence,
    tracePath: file,
    before,
    after,
    executions,
    receipts,
    inputs,
    sourceReceipt,
    modelCalls: before.modelInputs.length + after.modelInputs.length,
    final: fault === "unchanged" ? "unresolved" : "research_answer_adopted",
    brokerConfirmed: false,
  };
}
