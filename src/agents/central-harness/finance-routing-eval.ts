import {
  parseFinanceModuleSelection,
  planFinanceBrainOrchestration,
  type FinanceBrainModuleId,
} from "../finance-brain-orchestration.js";
import { runCentralHarnessCycle } from "./harness-loop.js";
import type { CentralBrain } from "./model-brain.js";
import { createCentralToolRegistry } from "./tool-registry.js";

export type FinanceRoutingCase = {
  id: string;
  ask: string;
  asOf: string;
  /** Evaluation labels stay outside model perception. They are not market truth. */
  requiredModules: readonly FinanceBrainModuleId[];
  allowedModules: readonly FinanceBrainModuleId[];
};

function scoreRoute(
  modules: readonly string[],
  testCase: FinanceRoutingCase,
  mandatory: readonly string[],
) {
  const allowed = new Set([...testCase.allowedModules, ...testCase.requiredModules, ...mandatory]);
  return {
    modules,
    missing: testCase.requiredModules.filter((id) => !modules.includes(id)),
    unnecessary: modules.filter((id) => !allowed.has(id)),
  };
}

/** Runs one task through the existing Harness. Never changes routing or promotes a model. */
export async function evaluateFinanceRouting(options: {
  testCase: FinanceRoutingCase;
  brain: CentralBrain;
  workspaceDir: string;
  evidenceKind: "fixture" | "model_call";
}) {
  const { testCase } = options;
  if (
    !testCase.ask.trim() ||
    Buffer.byteLength(testCase.ask) > 1_000 ||
    !Number.isFinite(Date.parse(testCase.asOf))
  ) {
    throw new Error("evaluation requires a bounded ask and explicit timestamp");
  }
  for (const ids of [testCase.requiredModules, testCase.allowedModules]) {
    if (ids.length) {
      parseFinanceModuleSelection({ moduleIds: ids, rationale: "evaluation labels" });
    }
  }
  const baselinePlan = planFinanceBrainOrchestration({ text: testCase.ask });
  const baseline = scoreRoute(
    baselinePlan.primaryModules,
    testCase,
    baselinePlan.selectionTrace.requiredModules,
  );
  const registry = createCentralToolRegistry({ workspaceDir: options.workspaceDir });
  const spec = registry.get("finance_research_run")!;
  // Limit evaluation to one planning capability and pin the task, so changing
  // the question or authority cannot improve the candidate's score.
  const scopedRegistry = new Map([
    [
      spec.ownerId,
      {
        ...spec,
        approve: (args: Readonly<Record<string, unknown>>) => {
          if (
            args.ask !== testCase.ask ||
            args.asOf !== testCase.asOf ||
            Object.keys(args).some((key) => !["ask", "asOf", "moduleSelection"].includes(key))
          ) {
            return { ok: false, reason: "evaluation task and planning scope are fixed" };
          }
          return spec.approve(args);
        },
      },
    ],
  ]);
  const started = performance.now();
  const receipt = await runCentralHarnessCycle({
    brain: options.brain,
    registry: scopedRegistry,
    maxSteps: 1,
    perception: {
      observedAt: testCase.asOf,
      ownerTotals: {},
      controlRoom: {
        financeRoutingTask: {
          ask: testCase.ask,
          asOf: testCase.asOf,
          instruction:
            "Propose one finance_research_run planning action for this exact task. Discover modules from the provided catalog; omit moduleSelection if rule routing suffices.",
        },
      },
      backlog: [],
      boundaries: ["planning_only", "no_execution_authority"],
    },
  });
  const elapsedMs = performance.now() - started;
  const step = receipt.steps[0];
  const candidatePlan =
    step?.status === "ran_ok" && receipt.actionsProposed === 1
      ? planFinanceBrainOrchestration({
          text: testCase.ask,
          moduleSelection: parseFinanceModuleSelection(step.args.moduleSelection),
        })
      : undefined;
  const candidate = candidatePlan
    ? scoreRoute(
        candidatePlan.primaryModules,
        testCase,
        baselinePlan.selectionTrace.requiredModules,
      )
    : undefined;
  const missingDelta = candidate ? candidate.missing.length - baseline.missing.length : undefined;
  const unnecessaryDelta = candidate
    ? candidate.unnecessary.length - baseline.unnecessary.length
    : undefined;
  const verdict =
    missingDelta === undefined || unnecessaryDelta === undefined
      ? "not_assessable"
      : missingDelta === 0 && unnecessaryDelta === 0
        ? "equal"
        : missingDelta <= 0 && unnecessaryDelta <= 0
          ? "route_better"
          : missingDelta >= 0 && unnecessaryDelta >= 0
            ? "route_worse"
            : "mixed";
  return {
    caseId: testCase.id,
    evidenceKind: options.evidenceKind,
    scope: "module_selection_only" as const,
    baseline,
    candidate,
    verdict,
    elapsedMs,
    extraActions: Math.max(0, receipt.actionsProposed - 1),
    callerSelectedModules: candidatePlan?.selectionTrace.selectionSource === "caller_proposal",
    receipt,
    promotionApplied: false,
  };
}
