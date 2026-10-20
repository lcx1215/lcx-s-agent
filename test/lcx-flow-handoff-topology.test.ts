import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  auditWorkflowHandoffs,
  readProcessOwnerSource,
  FLOW_SCENARIOS,
  type WorkflowFieldRef,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";
import { LCX_ONTOLOGY_REGISTRY } from "../src/shared/lcx-ontology.js";
import type { LcxWorkflowProcessContract } from "../src/shared/lcx-workflow-process-contracts.js";

const find = (id: string) => FLOW_SCENARIOS.find((scenario) => scenario.id === id)!;
describe("exact fields in encoded receipt transports", () => {
  it.each(["valid", "invalid_json", "missing_marker", "same_field", "hash_conflict"] as const)(
    "keeps original hash and independent consumer checks for %s",
    async (fault) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-embedded-fields-"));
      try {
        // Synthetic parser fixtures only; these rows do not assert a real pool executed.
        const scene = find("logical_agent_pool_waterflow");
        const nodes: WorkflowHandoffEvidence["nodes"] = [];
        for (const nodeId of scene.requiredNodes) {
          const raw = JSON.stringify({
            scope: "encoded-field-test",
            output: JSON.stringify({ value: `value:${nodeId}` }),
            inputs: Object.fromEntries(
              scene.edges
                .filter(([, to]) => to === nodeId)
                .map(([from]) => [
                  from,
                  JSON.stringify({
                    queryText: `Question\nContext: ${JSON.stringify({ value: `value:${from}` })}`,
                  }),
                ]),
            ),
          });
          const file = path.join(root, `${nodeId}.json`);
          await fs.writeFile(file, raw);
          const ref = (pointer: string): WorkflowFieldRef => ({
            path: file,
            pointer,
            sha256: createHash("sha256").update(raw).digest("hex"),
          });
          nodes.push({
            nodeId,
            scope: ref("/scope"),
            output: { ...ref("/output"), json: [{ pointer: "/value" }] },
            inputs: scene.edges
              .filter(([, to]) => to === nodeId)
              .map(([from]) => ({
                from,
                value: {
                  ...ref(`/inputs/${from}`),
                  json: [{ pointer: "/queryText" }, { pointer: "/value", after: "\nContext: " }],
                },
              })),
          });
        }
        const consumer = nodes.find((node) => node.inputs?.length)!;
        const input = consumer.inputs![0];
        if (fault === "missing_marker") {
          input.value.json![1].after = "\nAbsent: ";
        }
        if (fault === "same_field") {
          const producer = nodes.find((node) => node.nodeId === input.from)!;
          producer.output = input.value;
          producer.scope = consumer.scope;
        }
        if (fault === "invalid_json") {
          const value = JSON.parse(await fs.readFile(input.value.path, "utf8"));
          value.inputs[input.from] = "unfinished {";
          const raw = JSON.stringify(value);
          await fs.writeFile(input.value.path, raw);
          const sha256 = createHash("sha256").update(raw).digest("hex");
          consumer.scope.sha256 = sha256;
          consumer.output!.sha256 = sha256;
          for (const item of consumer.inputs!) {
            item.value.sha256 = sha256;
          }
        }
        if (fault === "hash_conflict") {
          input.value.sha256 = "0".repeat(64);
        }
        const audit = (
          await auditWorkflowHandoffs([
            {
              scenarioId: scene.id,
              environment: "offline_fixture",
              nodes,
            },
          ])
        ).find((row) => row.scenarioId === scene.id)!;
        if (fault === "valid") {
          expect(audit.status).toBe("handoffs_verified");
        } else {
          expect(audit.status).toBe("handoff_gap");
          expect(audit.gaps.length).toBeGreaterThan(0);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
async function functionBody(file: string, name: string) {
  const source = await fs.readFile(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  expect(node?.body).toBeDefined();
  return node!.body!.getText(ast);
}

async function originalFinanceSourceAudit(overrides: Record<string, string> = {}) {
  const filename = "scripts/operator/lcx-flow-graph.ts";
  const source = await fs.readFile(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "financeAutomaticLifecycleAudit",
  );
  expect(declaration).toBeDefined();
  const code = ts.transpileModule(
    `${declaration!.getText(ast)}\nfinanceAutomaticLifecycleAudit()`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    },
  ).outputText;
  return runInNewContext(
    code,
    {
      path,
      ts,
      repoRoot: ".",
      fs: {
        readFile: (file: string) => {
          const relative = path.normalize(file);
          return overrides[relative] === undefined
            ? fs.readFile(file, "utf8")
            : Promise.resolve(overrides[relative]);
        },
      },
    },
    { timeout: 1000 },
  ) as Promise<{
    complete: boolean;
    proofLevel: string;
    handoffs: Record<string, boolean>;
    missingHandoffs: string[];
  }>;
}

function removeCalls(source: string, callee: string) {
  const ast = ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true);
  const calls: Array<{ start: number; end: number }> = [];
  const matchesCallee = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) {
      return expression.text === callee;
    }
    if (ts.isParenthesizedExpression(expression)) {
      return matchesCallee(expression.expression);
    }
    return (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      (matchesCallee(expression.left) || matchesCallee(expression.right))
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && matchesCallee(node.expression)) {
      calls.push({ start: node.getStart(ast), end: node.end });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(calls.length).toBeGreaterThan(0);
  let altered = source;
  for (const call of calls.toSorted((a, b) => b.start - a.start)) {
    altered = altered.slice(0, call.start) + "undefined" + altered.slice(call.end);
  }
  return altered;
}

describe("factory topology describes original source without inventing consumers", () => {
  it("keeps self-repair construction branches before the original writer join without inventing ranking", async () => {
    const file = "scripts/operator/lcx-self-repair-hands.ts";
    const build = await functionBody(file, "buildSelfRepairHandsReceipt");
    expect(build).toContain("buildCorrectionMarkdown(input, correctionId)");
    expect(build).toContain("buildTrainingCandidate(input, candidateId)");
    expect(build).not.toContain("verifySelfRepairSourceContent(");
    const write = await functionBody(file, "writeSelfRepairHandsReceipt");
    const review = write.indexOf("verifySelfRepairSourceContent({");
    const blocked = write.indexOf('receipt.sourceReview.status === "blocked"', review);
    // These fields also occur in the earlier allowlist audit; inspect the later guarded writes.
    const note = write.indexOf('"/hands/memoryCleaner/correctionMarkdown"', blocked);
    const packet = write.indexOf('"/hands/trainingCaseBuilder/candidate"', blocked);
    expect(review).toBeGreaterThanOrEqual(0);
    expect(blocked).toBeGreaterThan(review);
    expect(note).toBeGreaterThan(blocked);
    expect(packet).toBeGreaterThan(blocked);
    expect(write).toContain("receipt.hands.memoryCleaner.correctionMarkdown");
    expect(write).toContain("receipt.hands.trainingCaseBuilder.candidate");
    const scene = find("self_repair_hands_waterflow");
    expect(scene.requiredNodes).toHaveLength(12);
    expect(scene.requiredFilters).toHaveLength(9);
    for (const branch of ["self_repair_memory_cleaner", "self_repair_training_case_builder"]) {
      expect(scene.edges).toContainEqual(["self_repair_hands", branch]);
      expect(scene.edges).toContainEqual([branch, "memory_write_gate"]);
    }
    expect(scene.edges).toContainEqual(["source_conflict_review", "memory_write_gate"]);
    expect(scene.edges).toContainEqual(["memory_write_gate", "correction_note"]);
    expect(scene.edges).toContainEqual(["memory_write_gate", "training_eval_candidate_packet"]);
    expect(scene.edges).toContainEqual(["memory_write_gate", "self_repair_latest_receipt"]);
    expect(scene.edges).toContainEqual(["self_repair_memory_cleaner", "stale_memory_downrank"]);
    expect(scene.edges).toContainEqual(["correction_note", "self_repair_latest_receipt"]);
    expect(scene.edges).not.toContainEqual(["source_conflict_review", "self_repair_hands"]);
    expect(scene.edges).not.toContainEqual(["memory_write_gate", "self_repair_memory_cleaner"]);
    expect(scene.edges).not.toContainEqual(["correction_note", "stale_memory_downrank"]);
    expect(scene.feedbackEdges).toContainEqual(["owner_coverage_map", "self_repair_hands"]);
    expect(scene.feedbackEdges).toContainEqual(["training_eval_candidate_packet", "review_panel"]);
    const stages = LCX_ONTOLOGY_REGISTRY.workflowProcesses.self_repair_hands_waterflow.stages;
    const stage = (node: string) =>
      stages.find((item) => (item.nodes as readonly string[]).includes(node))!;
    expect(stage("stale_memory_downrank").preconditions).toContain(
      "not an executed ranking change",
    );
    expect(stage("memory_write_gate").preconditions).toContain("constructed before source review");
    expect(stage("training_eval_candidate_packet").preconditions).toContain("not applied training");
    const audit = (await auditWorkflowHandoffs([])).find((row) => row.scenarioId === scene.id);
    expect(audit?.status).toBe("not_observed");
  });

  it("keeps default ingress and commercial branch obligations distinct without dropping the language gaps", async () => {
    const contract: LcxWorkflowProcessContract =
      LCX_ONTOLOGY_REGISTRY.workflowProcesses.external_visible_language_waterflow;
    const stage = (node: string) =>
      contract.stages.find((item) => (item.nodes as readonly string[]).includes(node))!;
    expect(contract.entrypoint).toBe("extensions/external/src/monitor.ts");
    expect(stage("ingress_external_message").owner).toBe(contract.entrypoint);
    expect(stage("visible_reply").owner).toBe(contract.entrypoint);
    expect(stage("local_brain_planner").implementationStatus).toBe("existing_source");
    expect(stage("language_router").implementationStatus).toBe("existing_source");
    expect(stage("language_router").preconditions).toContain("script matching does not establish");
    expect(stage("answer_audit_budget").implementationStatus).toBe("existing_source");
    expect(stage("readability_review")).toBe(stage("visible_answer_adoption_gate"));
    expect(stage("reply_flow_audit").owner).toBe("src/auto-reply/reply/agent-runner.ts");
    expect(stage("reply_flow_audit").implementationStatus).toBe("existing_source");
    expect(stage("reply_flow_audit").preconditions).toContain(
      "success does not send summary text to the user",
    );
    const replyOwner = await fs.readFile("src/auto-reply/reply/agent-runner.ts", "utf8");
    expect(replyOwner).toContain("if (commercial.trace && councilGateRunId)");
    expect(replyOwner).toContain(
      'data: { phase: "commercial_answer_terminal_gate", surface, ...commercial.trace }',
    );
    const commercialGate = await fs.readFile("src/agents/commercial-answer-reply-gate.ts", "utf8");
    expect(commercialGate).toContain("controlRoomSummary: receipt.controlRoomSummary");
    const monitor = await functionBody(
      "extensions/external/src/monitor.ts",
      "processExternalMessage",
    );
    expect(monitor).toContain("dispatchReplyWithBufferedBlockDispatcher");
    expect(monitor).toContain("sendExternalMessage");
    expect(monitor).not.toContain("buildPipelineResult");
    const dispatcher = await fs.readFile("src/auto-reply/reply/dispatch-from-config.ts", "utf8");
    expect(dispatcher).toContain("getReplyFromConfig");
    const scene = find("external_visible_language_waterflow");
    expect(scene.requiredNodes).toHaveLength(11);
    expect(scene.requiredFilters).toHaveLength(5);
    expect(scene.edges).toHaveLength(14);
    expect(scene.edges).toEqual(
      expect.arrayContaining([
        ["ingress_external_message", "intent_classifier"],
        ["ingress_external_message", "language_router"],
        ["ingress_external_message", "display_text_normalizer"],
        ["intent_classifier", "local_brain_planner"],
        ["local_brain_planner", "answer_audit_budget"],
        ["local_brain_planner", "control_room_summary"],
        ["answer_audit_budget", "control_room_summary"],
        ["language_router", "control_room_summary"],
        ["display_text_normalizer", "readability_review"],
        ["readability_review", "visible_answer_adoption_gate"],
        ["visible_answer_adoption_gate", "control_room_summary"],
        ["control_room_summary", "reply_flow_audit"],
        ["visible_answer_adoption_gate", "reply_flow_audit"],
        ["reply_flow_audit", "visible_reply"],
      ]),
    );
    for (const falseSerial of [
      ["intent_classifier", "language_router"],
      ["control_room_summary", "answer_audit_budget"],
      ["language_router", "local_brain_planner"],
    ]) {
      expect(scene.edges).not.toContainEqual(falseSerial);
    }
    // The retained feedback still needs an actual later purification caller.
    expect(scene.feedbackEdges).toEqual([["readability_review", "display_text_normalizer"]]);
    expect(scene.receipts).not.toContain("normalizeExternalDisplayText");
    const audit = (await auditWorkflowHandoffs([])).find((item) => item.scenarioId === scene.id);
    expect(audit?.status).toBe("not_observed");
  });

  it.each([
    [
      "scripts/operator/lcx-finance-scheduler.ts",
      "runFinanceIntradayMonitorTick",
      "intradayRunsUnderFinanceScheduler",
      "scheduler_to_intraday_monitor",
    ],
    [
      "scripts/operator/lcx-finance-scheduler.ts",
      "parseNightSettlement",
      "schedulerOwnsNightSettlement",
      "scheduler_to_night_settlement",
    ],
    [
      "scripts/operator/lcx-finance-scheduler.ts",
      "runDayResearchPreflight",
      "scheduledResearchFeedsPortfolioPlan",
      "scheduled_research_to_portfolio_plan",
    ],
    [
      "scripts/operator/lcx-finance-research-run.ts",
      "writeVerifiedPortfolioPlan",
      "researchCanProducePortfolioCandidate",
      "configured_research_to_written_portfolio_candidate",
    ],
    [
      "scripts/operator/lcx-central-agent.ts",
      "buildFinanceAutomaticLifecycleFeedback",
      "centralHarnessHasAutomaticFinanceTaskFeed",
      "central_harness_automatic_finance_task_feed",
    ],
    [
      "scripts/operator/lcx-central-agent.ts",
      "buildFinanceAutomaticLifecycleFeedback",
      "centralHarnessUsesReadOnlyFinanceSnapshots",
      "central_harness_to_read_only_finance_ledgers",
    ],
    [
      "src/agents/finance-research-runner.ts",
      "executeFinanceModuleComposition",
      "scheduledResearchExecutesModuleDag",
      "scheduled_research_to_finance_module_dag",
    ],
    [
      "src/agents/finance-account-trading-book.ts",
      "reconcileFinanceBrokerHistory",
      "brokerHistoryFeesReachTradeEconomics",
      "broker_fee_history_to_trade_economics_diagnostic",
    ],
  ])(
    "refuses false source completion when %s loses actual %s calls",
    async (file, callee, flag, gap) => {
      const original = await fs.readFile(file, "utf8");
      const result = await originalFinanceSourceAudit({ [file]: removeCalls(original, callee) });
      expect(result.proofLevel).toBe("source_structure_only");
      expect(result.complete).toBe(false);
      expect(result.handoffs[flag]).toBe(false);
      expect(result.missingHandoffs).toContain(gap);
    },
  );

  it("uses the actual configured research producer without requiring the unrelated legacy turn", async () => {
    const result = await originalFinanceSourceAudit({
      "scripts/operator/lcx-finance-research-turn.ts": "",
    });
    expect(result.complete).toBe(true);
    expect(result.handoffs.researchCanProducePortfolioCandidate).toBe(true);
  });

  it("keeps configured day research on its original scheduler caller, not central planning", async () => {
    const scheduler = "scripts/operator/lcx-finance-scheduler.ts";
    const fire = await functionBody(scheduler, "fire");
    const preflight = await functionBody(scheduler, "runDayResearchPreflight");
    expect(fire).toContain("context.options.researchPlan");
    expect(fire).toContain("await runDayResearchPreflight({");
    expect(preflight).toMatch(/runScheduledCycleProcess\(params\.context,\s*"research_preflight"/u);
    expect(preflight).toContain("RESEARCH_SCRIPT");
    expect(preflight).toContain('"--execute-modules"');
    expect(fire).not.toContain("runCentralHarnessCycle");
    expect(preflight).not.toContain("central_agent_gate");
    expect(fire).toContain('payload.status !== "candidate"');
    expect(fire).toContain("payload.plan?.asOf !== attempt.firedAt");
    expect(fire).toContain('["source", "committee", "quality", "module_execution"]');
    expect(fire).toContain("researchPayload.portfolioPlanWritten === portfolioPlanPath");
    const registry = await fs.readFile("src/agents/central-harness/tool-registry.ts", "utf8");
    expect(registry).toContain("no_provider_call_from_central_harness");
    const research = await functionBody(
      "src/agents/finance-research-runner.ts",
      "runFinanceResearchRun",
    );
    expect(research).toContain('status: "planned"');
    const scene = find("finance_automatic_paper_trading_waterflow");
    expect(scene.edges).toContainEqual(["schedule_gate", "finance_research_modules"]);
    for (const node of [
      "central_agent_perception",
      "central_agent_brain_proposal",
      "central_agent_gate",
    ]) {
      expect(scene.requiredNodes).not.toContain(node);
      expect(scene.edges.flat()).not.toContain(node);
    }
    const stages =
      LCX_ONTOLOGY_REGISTRY.workflowProcesses.finance_automatic_paper_trading_waterflow.stages;
    const owner = (node: string) =>
      stages.find((stage) => (stage.nodes as readonly string[]).includes(node))?.owner;
    expect(owner("portfolio_plan")).toBe("scripts/operator/lcx-finance-research-run.ts");
    expect(owner("execution_intent")).toBe("src/agents/finance-execution-adapter.ts");
    expect(owner("order_placement")).toBe("src/agents/finance-execution-safety.ts");
    expect(owner("position_ledger")).toBe("src/agents/finance-position-ledger.ts");
  });

  it("records the original direct module-to-Quality input without waiving gateway coverage", async () => {
    const research = await functionBody(
      "src/agents/finance-research-runner.ts",
      "runFinanceResearchQualityReview",
    );
    expect(research).toContain("financeModuleExecution: moduleExecution");
    expect(research).toContain("await runQualityHarness({");
    expect(research).toContain("request: qualityRequest");
    const scene = find("finance_automatic_paper_trading_waterflow");
    expect(scene.edges).toContainEqual(["finance_research_modules", "review_panel"]);
    expect(scene.requiredNodes).toContain("finance_data_gateway");
    expect(scene.edges).toContainEqual(["finance_research_modules", "finance_data_gateway"]);
    expect(scene.edges).toContainEqual(["finance_data_gateway", "review_panel"]);
    expect(scene.edges).toContainEqual(["schedule_gate", "night_settlement"]);
  });

  it("keeps rule-body research feedback separate from independent central supervision", async () => {
    const source = await fs.readFile("scripts/operator/lcx-finance-research-run.ts", "utf8");
    expect(source).toContain("await readFinanceActiveStrategyResearchScope({");
    expect(source).toContain("strategyIds: portfolioContext.activeStrategyIds");
    expect(source).toContain("requiredInstruments: strategyScope.instruments");
    expect(source).toContain(
      "controllerEvidence: [...(strategyScope?.evidence ?? []), ...suppliedControllerEvidence]",
    );
    const evidence = await functionBody(
      "src/agents/finance-night-review-context.ts",
      "readFinanceActiveStrategyResearchEvidenceAndSource",
    );
    expect(evidence).toContain(
      "readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf })",
    );
    expect(evidence).toContain("body: rule.body");
    const perception = await functionBody(
      "scripts/operator/lcx-central-agent.ts",
      "buildPerception",
    );
    expect(perception).toContain("buildFinanceAutomaticLifecycleFeedback({ observedAt })");
    const scene = find("finance_automatic_paper_trading_waterflow");
    expect(scene.feedbackEdges).toContainEqual([
      "strategy_rule_ledger",
      "finance_research_modules",
    ]);
    expect(scene.feedbackEdges).toContainEqual([
      "strategy_rule_ledger",
      "central_agent_perception",
    ]);
    expect(scene.edges).not.toContainEqual([
      "central_agent_perception",
      "finance_research_modules",
    ]);
  });

  it("ends directional night calibration at its actual refusal, without invented rule activation", async () => {
    const nightTuning = await functionBody(
      "scripts/operator/lcx-finance-scheduler.ts",
      "runNightTuning",
    );
    expect(nightTuning).toContain("settlement.scoredFiled.appended === 0");
    expect(nightTuning).toContain("runFinanceTuningLifecycle({");
    const tuning = await functionBody(
      "src/agents/finance-tuning-lifecycle.ts",
      "runFinanceTuningLifecycle",
    );
    expect(tuning).toContain("promotions: Object.freeze([])");
    expect(tuning).toContain('status: "blocked"');
    expect(tuning).toContain("FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON");
    expect(tuning).not.toContain("declareFinanceStrategyRule");
    expect(tuning).not.toContain("activateFinanceStrategyRule");
    const batch = await functionBody("src/agents/finance-research-batch.ts", "runResearchBatch");
    expect(batch).toContain("appendFileSync(recordPath,");
    const daily = await functionBody(
      "scripts/operator/lcx-finance-daily-cycle.ts",
      "runFinanceDailyCycleOperator",
    );
    expect(daily).toContain("const samplePath = join(directory, SAMPLES_FILE)");
    expect(daily).toMatch(/await readFile\(samplePath(?:,\s*"utf8")?\)/u);
    expect(daily).toContain("await backfillOutcomes({");
    expect(daily).toContain("await appendScoredOutcomes(");
    const feedback = await fs.readFile(
      "src/agents/finance-automatic-lifecycle-feedback.ts",
      "utf8",
    );
    expect(feedback).toContain("readFinanceTuningProposals(state.directory)");
    const scene = find("finance_automatic_paper_trading_waterflow");
    expect(scene.end).toBe("deterministic_promotion_gate");
    expect(scene.edges).not.toContainEqual([
      "deterministic_promotion_gate",
      "strategy_rule_ledger",
    ]);
    expect(scene.edges).not.toContainEqual(["position_ledger", "night_settlement"]);
    expect(scene.edges).toContainEqual(["research_run", "night_settlement"]);
    expect(scene.edges).toContainEqual(["schedule_gate", "night_settlement"]);
    expect(scene.feedbackEdges).toContainEqual(["tuning_proposal", "central_agent_perception"]);
    expect(scene.feedbackEdges).toContainEqual(["position_ledger", "finance_research_modules"]);
    const stages =
      LCX_ONTOLOGY_REGISTRY.workflowProcesses.finance_automatic_paper_trading_waterflow.stages;
    const owner = (node: string) =>
      stages.find((stage) => (stage.nodes as readonly string[]).includes(node))?.owner;
    expect(owner("night_settlement")).toBe("scripts/operator/lcx-finance-daily-cycle.ts");
    expect(owner("strategy_rule_ledger")).toBe("src/agents/finance-strategy-rule-ledger.ts");
    expect(owner("research_run")).toBe("src/agents/finance-research-batch.ts");
  });

  it("models acceptance sibling checks followed by their original gate join", async () => {
    const file = "scripts/operator/lcx-commercial-acceptance-harness.ts";
    const collector = await functionBody(file, "collectOwnerSnapshots");
    expect(collector).toContain("Promise.all([");
    expect(collector).toContain("collectSharedOwnerSnapshots(options,");
    expect(collector).toContain("collectCommercialAcceptanceExclusiveSnapshots(options,");
    expect(collector).toContain("combineCommercialAcceptanceSnapshots(shared, exclusive)");
    const shared = await functionBody(file, "collectSharedOwnerSnapshots");
    expect(shared).toContain("Promise.all([");
    const edges = find("commercial_acceptance_harness_waterflow").edges;
    for (const node of ["system_doctor", "training_plan", "mind_model", "flow_graph"] as const) {
      expect(edges).toContainEqual(["local_operator_loop", node]);
      expect(edges).toContainEqual([node, "commercial_acceptance_harness"]);
    }
    expect(edges).not.toContainEqual(["system_doctor", "training_plan"]);
    expect(edges).not.toContainEqual(["training_plan", "mind_model"]);
    expect(edges).not.toContainEqual(["mind_model", "flow_graph"]);
    expect(edges).not.toContainEqual(["commercial_acceptance_harness", "external_channel_binding"]);
    const stages =
      LCX_ONTOLOGY_REGISTRY.workflowProcesses.commercial_acceptance_harness_waterflow.stages;
    expect(
      stages.find((stage) => (stage.nodes as readonly string[]).includes("training_plan"))?.owner,
    ).toBe("scripts/operator/local-brain-training-plan.ts");
    expect(find("commercial_acceptance_harness_waterflow").requiredNodes).toContain(
      "user_visible_observed",
    );
    expect(find("commercial_acceptance_harness_waterflow").feedbackEdges).toContainEqual([
      "acceptance_eval",
      "commercial_acceptance_harness",
    ]);
  });

  it("models inventory feeding coverage and impact joining separately in original main", async () => {
    const source = await fs.readFile("scripts/operator/lcx-universe-index.ts", "utf8");
    expect(source).toMatch(/changeImpactCoverage\(gitStatus\.changedFiles,\s*deadline\)/u);
    expect(source).toMatch(/ownerCoverage:\s*\{\s*changeImpact,/u);
    const body = await functionBody(
      "scripts/operator/lcx-universe-index.ts",
      "changeImpactCoverage",
    );
    expect(body).toContain('"--files"');
    expect(body).toContain("...files");
    const scene = find("universe_index_total_coverage_waterflow");
    expect(scene.edges).toContainEqual(["repo_inventory", "change_impact_plan"]);
    const main = await functionBody("scripts/operator/lcx-universe-index.ts", "main");
    expect(main).toMatch(
      /buildRepoGovernanceCoverage\(\s*repoComponentFiles,\s*governanceInventoryAreas,/u,
    );
    expect(main).toContain("governanceCoverage.routeOwnerValidation =");
    expect(main).toContain("governanceCoverage.status =");
    expect(scene.edges).toContainEqual(["repo_inventory", "owner_coverage_map"]);
    expect(scene.edges).toContainEqual(["artifact_inventory", "owner_coverage_map"]);
    expect(scene.edges).toContainEqual(["change_impact_plan", "universe_index"]);
    expect(scene.edges).not.toContainEqual(["change_impact_plan", "owner_coverage_map"]);
    expect(scene.edges).toContainEqual(["owner_coverage_map", "universe_index"]);
    expect(scene.edges).not.toContainEqual(["owner_coverage_map", "change_impact_plan"]);
    expect(scene.edges).not.toContainEqual(["change_impact_plan", "mind_model"]);
    expect(scene.edges).not.toContainEqual(["mind_model", "flow_graph"]);
    expect(scene.requiredNodes).toContain("cleanup_candidate_review");
    expect(scene.feedbackEdges).toContainEqual(["cleanup_candidate_review", "change_impact_plan"]);
  });

  it("checks installed host writer source when present; absent source remains unverified", async (context) => {
    const host = await readProcessOwnerSource("host-installed:lcx-local-operator-loop.sh");
    if (!host) {
      context.skip();
      return;
    }
    expect(host).toContain(
      "const governanceAutopilot = readJson(process.env.NODE_GOVERNANCE_FILE)",
    );
    expect(host).toContain(
      "const contextRecovery = readJson(process.env.NODE_CONTEXT_RECOVERY_FILE)",
    );
    expect(host).not.toContain("readJson(process.env.NODE_FAILURE_TRACE_FILE)");
    expect(host).toContain("Boolean(trainingSupervisor.ok)");
    expect(host).toContain("const exam = readJson(process.env.NODE_EXAM_FILE)");
  });

  it("keeps loop siblings feeding the host writer and missing digest consumer explicit", () => {
    const scene = find("local_automation_digest_waterflow");
    const nodes = [
      "automation_cleanup",
      "governance_autopilot",
      "system_doctor",
      "training_plan",
      "mind_model",
      "flow_graph",
      "fixed_evidence_recovery",
      "operator_training_supervisor",
      "operator_agent_exam",
    ] as const;
    for (const node of nodes) {
      expect(scene.edges).toContainEqual(["local_operator_loop", node]);
      expect(scene.edges).toContainEqual([node, "operator_latest_receipt"]);
    }
    expect(scene.edges).toContainEqual(["governance_autopilot", "local_failure_trace"]);
    expect(scene.edges).not.toContainEqual(["system_doctor", "training_plan"]);
    expect(scene.edges).not.toContainEqual(["local_failure_trace", "operator_latest_receipt"]);
    const contract: import("../src/shared/lcx-workflow-process-contracts.js").LcxWorkflowProcessContract =
      LCX_ONTOLOGY_REGISTRY.workflowProcesses.local_automation_digest_waterflow;
    expect(contract.entrypoint).toBe("host-installed:lcx-local-operator-loop.sh");
    const digest = contract.stages.find((stage) =>
      (stage.nodes as readonly string[]).includes("operator_digest"),
    );
    expect(digest?.implementationStatus).toBe("existing_source");
    expect(digest?.owner).toBe("scripts/operator/lcx-owner-brief.ts");
    expect(digest?.preconditions).toContain("does not prove natural invocation");
    expect(scene.edges).toContainEqual(["operator_latest_receipt", "operator_digest"]);
  });

  it("reads host owner source without executing it and rejects traversing or absent owners", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-host-source-only-"));
    try {
      const dir = path.join(home, ".openclaw", "bin");
      await fs.mkdir(dir, { recursive: true });
      const marker = path.join(home, "executed");
      const source = `#!/bin/sh\ntouch ${marker}\n`;
      await fs.writeFile(path.join(dir, "owner.sh"), source);
      expect(await readProcessOwnerSource("host-installed:owner.sh", home)).toBe(source);
      expect(
        await fs
          .access(marker)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      expect(await readProcessOwnerSource("host-installed:missing.sh", home)).toBe("");
      expect(await readProcessOwnerSource("host-installed:../owner.sh", home)).toBe("");
      expect(await readProcessOwnerSource("host-installed:/tmp/owner.sh", home)).toBe("");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("describes original healthy training eval and promotion before final cooldown", async () => {
    const file = "scripts/operator/minimax-brain-training-guard.ts";
    const source = await fs.readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const run = ast.statements.find(
      (node): node is ts.TryStatement =>
        ts.isTryStatement(node) &&
        node.tryBlock.getText(ast).includes("const trained = await runTrain("),
    );
    expect(run).toBeDefined();
    const main = run!.tryBlock.getText(ast);
    const train = main.indexOf("const trained = await runTrain(");
    const evalAt = main.indexOf("const candidateEval = await runJsonStep(", train);
    const promotion = main.indexOf('event: "adapter_promoted_for_guard_session"', evalAt);
    const cooldown = main.lastIndexOf("await runEvolutionCooldown(");
    expect(train).toBeGreaterThanOrEqual(0);
    expect(evalAt).toBeGreaterThan(train);
    expect(promotion).toBeGreaterThan(evalAt);
    expect(cooldown).toBeGreaterThan(promotion);
    const scene = find("senior_trader_failure_focus_waterflow");
    expect(scene.edges).toContainEqual(["qwen_training", "hardened_eval"]);
    expect(scene.edges).toContainEqual(["hardened_eval", "promotion_gate"]);
    expect(scene.edges).toContainEqual(["promotion_gate", "evolution_cooldown"]);
    expect(scene.edges).not.toContainEqual(["evolution_cooldown", "hardened_eval"]);
    const stages =
      LCX_ONTOLOGY_REGISTRY.workflowProcesses.senior_trader_failure_focus_waterflow.stages;
    const owner = (node: string) =>
      stages.find((stage) => (stage.nodes as readonly string[]).includes(node))?.owner;
    expect(owner("hardened_eval")).toBe("scripts/operator/local-brain-distill-eval.ts");
    expect(owner("promotion_gate")).toBe("scripts/operator/minimax-brain-training-guard.ts");
    expect(owner("failure_curriculum")).toBe(
      "scripts/operator/minimax-brain-failure-curriculum.ts",
    );
    expect(owner("dataset_builder")).toBe("scripts/operator/local-brain-distill-dataset.ts");
  });

  it("refuses a hash-valid diagnostic table without the original cleanup review verdict", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-absent-reviewer-"));
    try {
      const scene = find("universe_index_total_coverage_waterflow");
      // These are deliberately fabricated diagnostic rows, not execution receipts.
      // All identity/field handoffs match so the actual review verdict must also exist; matching strings are insufficient.
      const edges = [...scene.edges, ...(scene.feedbackEdges ?? [])];
      const nodes: WorkflowHandoffEvidence["nodes"] = [];
      for (const nodeId of scene.requiredNodes) {
        const raw = JSON.stringify({
          scope: { runId: "diagnostic-only", accountId: "no-account" },
          output: `value:${nodeId}`,
          inputs: Object.fromEntries(
            edges.filter(([, to]) => to === nodeId).map(([from]) => [from, `value:${from}`]),
          ),
        });
        const file = path.join(root, `${nodeId}.json`);
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
      const evidence = { scenarioId: scene.id, environment: "offline_fixture" as const, nodes };
      const audit = (await auditWorkflowHandoffs([evidence])).find(
        (row) => row.scenarioId === scene.id,
      )!;
      expect(audit.status).toBe("handoff_gap");
      expect(audit.gaps).toContainEqual({
        node: "cleanup_candidate_review",
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        reason: "original_cleanup_review_verdict_missing",
      });
      expect(audit.gaps.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
