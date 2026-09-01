import {
  buildGroundingContext,
  composeFinanceAnswer,
  type FinanceComposeRequest,
  type FinanceComposeResult,
} from "../agents/finance-answer-composer.js";
import {
  planFinanceBrainOrchestration,
  type FinanceBrainOrchestrationPlan,
} from "../agents/finance-brain-orchestration.js";
import { applySkillAutoCueToBody, resolveSkillAutoCue } from "../auto-reply/reply/skill-autocue.js";
import {
  buildGlobalEvidenceProjection,
  validateGlobalEvidenceProjection,
} from "../shared/global-evidence-projection.js";
import {
  LCX_ENGINE_CONTRACT_VERSION,
  type LcxEngine,
  type LcxEngineHost,
  type LcxEnginePlan,
  type LcxEngineRequest,
  type LcxEngineRunResult,
} from "./types.js";

const BASE_BOUNDARIES = [
  "deterministic_preflight_only",
  "host_result_is_not_learning_proof",
  "external_delivery_requires_independent_proof",
] as const;

/** The single LCX control-plane registry for existing product capabilities. */
export const LCX_ENGINE_SERVICES = {
  finance: {
    plan: planFinanceBrainOrchestration,
    compose: composeFinanceAnswer,
    buildGroundingContext,
  },
  evidence: {
    buildProjection: buildGlobalEvidenceProjection,
    validateProjection: validateGlobalEvidenceProjection,
  },
  skills: {
    resolveAutoCue: resolveSkillAutoCue,
    applyAutoCueToBody: applySkillAutoCueToBody,
  },
} as const;

export type LcxEngineServices = typeof LCX_ENGINE_SERVICES;
export type { FinanceBrainOrchestrationPlan, FinanceComposeRequest, FinanceComposeResult };

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function isFinancePlan(plan: FinanceBrainOrchestrationPlan): boolean {
  return plan.primaryModules.length > 0 || plan.supportingModules.length > 0;
}

function renderFinanceSystemContext(
  plan: LcxEnginePlan & { financePlan: FinanceBrainOrchestrationPlan },
): string {
  const finance = plan.financePlan;
  return [
    "[LCX Engine preflight - deterministic]",
    `Contract: ${plan.contractVersion}`,
    `Route: ${plan.route}`,
    `Risk tier: ${plan.riskTier}`,
    `Primary modules: ${finance.primaryModules.join(", ") || "none"}`,
    `Supporting modules: ${finance.supportingModules.join(", ") || "none"}`,
    `Required tools: ${finance.requiredTools.join(", ") || "none"}`,
    `Review tools: ${finance.reviewTools.join(", ") || "none"}`,
    `Boundaries: ${plan.boundaries.join(", ")}`,
    "This is a routing plan only. Do not claim a tool ran, data is fresh, learning happened, or an external user saw the answer without independent evidence.",
  ].join("\n");
}

export function planLcxEngineRequest(request: LcxEngineRequest): LcxEnginePlan {
  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new Error("prompt required");
  }

  const financePlan = LCX_ENGINE_SERVICES.finance.plan({
    text: prompt,
    ...(request.hasHoldingsOrPortfolioContext !== undefined
      ? { hasHoldingsOrPortfolioContext: request.hasHoldingsOrPortfolioContext }
      : {}),
    ...(request.hasLocalMathInputs !== undefined
      ? { hasLocalMathInputs: request.hasLocalMathInputs }
      : {}),
    ...(request.highStakesConclusion !== undefined
      ? { highStakesConclusion: request.highStakesConclusion }
      : {}),
    ...(request.writesDurableMemory !== undefined
      ? { writesDurableMemory: request.writesDurableMemory }
      : {}),
  });
  const finance = isFinancePlan(financePlan);
  const skillCue =
    request.availableSkillNames && request.availableSkillNames.length > 0
      ? LCX_ENGINE_SERVICES.skills.resolveAutoCue({
          body: prompt,
          availableSkillNames: [...request.availableSkillNames],
        })
      : null;
  const riskTier: LcxEnginePlan["riskTier"] =
    request.highStakesConclusion === true ||
    request.writesDurableMemory === true ||
    request.hasHoldingsOrPortfolioContext === true ||
    request.hasLocalMathInputs === true ||
    financePlan.primaryModules.includes("portfolio_risk_gates") ||
    financePlan.primaryModules.includes("quant_math")
      ? "high"
      : "standard";
  const route: LcxEnginePlan["route"] = finance ? "finance" : "general";
  const boundaries = unique([...BASE_BOUNDARIES, ...(finance ? financePlan.boundaries : [])]);
  const requiredCapabilities = unique([
    "language_intake",
    "host_execution",
    ...(finance ? ["finance_orchestration", "evidence_gates", "review_before_conclusion"] : []),
    ...(skillCue ? ["skill_preflight"] : []),
  ]);
  const basePlan: LcxEnginePlan = {
    contractVersion: LCX_ENGINE_CONTRACT_VERSION,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    route,
    riskTier,
    ...(finance ? { financePlan } : {}),
    ...(skillCue ? { skillCue } : {}),
    requiredCapabilities,
    boundaries,
  };
  return finance
    ? {
        ...basePlan,
        systemContext: renderFinanceSystemContext({
          ...basePlan,
          financePlan,
        }),
      }
    : basePlan;
}

export async function runLcxEngine<HostResult>(
  request: LcxEngineRequest,
  host: LcxEngineHost<HostResult>,
  options: { now?: () => Date; plan?: LcxEnginePlan } = {},
): Promise<LcxEngineRunResult<HostResult>> {
  const plan = options.plan ?? planLcxEngineRequest(request);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const hostResult = await host.run({
    request,
    plan,
    systemContext: plan.systemContext,
  });
  const completedAt = now().toISOString();
  return {
    hostResult,
    plan,
    receipt: {
      contractVersion: LCX_ENGINE_CONTRACT_VERSION,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      hostId: host.id,
      route: plan.route,
      riskTier: plan.riskTier,
      outcome: "completed",
      startedAt,
      completedAt,
      boundaries: plan.boundaries,
    },
  };
}

export function createLcxEngine<HostResult>(
  host: LcxEngineHost<HostResult>,
  options: { now?: () => Date } = {},
): LcxEngine<HostResult> {
  return {
    plan: planLcxEngineRequest,
    run: (request) => runLcxEngine(request, host, options),
  };
}
