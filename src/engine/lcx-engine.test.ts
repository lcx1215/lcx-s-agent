import { describe, expect, it } from "vitest";
import { planFinanceBrainOrchestration } from "../agents/finance-brain-orchestration.js";
import {
  createLcxEngine,
  createOpenClawHarnessBridge,
  LCX_ENGINE_SERVICES,
  LCX_OPENCLAW_AGENT_HARNESS_ID,
  LCX_OPENCLAW_AGENT_HARNESS_SEAM,
  planLcxEngineRequest,
  runLcxEngine,
} from "./index.js";

describe("LCX Engine", () => {
  it("keeps a general request host-compatible without injecting finance instructions", async () => {
    const calls: Array<{ systemContext?: string }> = [];
    const engine = createLcxEngine<{ ok: true }>({
      id: "test.general-host",
      run: async (context) => {
        calls.push({ systemContext: context.systemContext });
        return { ok: true };
      },
    });

    const result = await engine.run({
      requestId: "general-1",
      prompt: "整理今天的 marketing meeting 标题和待办。",
    });

    expect(result.hostResult).toEqual({ ok: true });
    expect(result.plan.route).toBe("general");
    expect(result.plan.financePlan).toBeUndefined();
    expect(result.plan.systemContext).toBeUndefined();
    expect(calls).toEqual([{}]);
    expect(result.receipt).toMatchObject({
      requestId: "general-1",
      hostId: "test.general-host",
      route: "general",
      outcome: "completed",
    });
  });

  it("routes finance work through deterministic modules, evidence, and review boundaries", async () => {
    let observedRoute: string | undefined;
    const result = await runLcxEngine(
      {
        requestId: "finance-1",
        prompt: "当前 NVDA 和 TLT 组合的基本面、利率、风险预算怎么拆？",
        hasHoldingsOrPortfolioContext: true,
        highStakesConclusion: true,
        adapterId: "test-adapter",
      },
      {
        id: "test.finance-host",
        run: async ({ plan, systemContext }) => {
          observedRoute = plan.route;
          expect(systemContext).toContain("[LCX Engine preflight - deterministic]");
          expect(systemContext).toContain("finance_data_gateway_snapshot");
          expect(systemContext).toContain("no_execution_authority");
          expect(systemContext).toContain("Do not claim a tool ran");
          return "host-result";
        },
      },
    );

    expect(observedRoute).toBe("finance");
    expect(result.hostResult).toBe("host-result");
    expect(result.plan.riskTier).toBe("high");
    expect(result.plan.financePlan?.primaryModules).toEqual(
      expect.arrayContaining(["company_fundamentals_value", "portfolio_risk_gates"]),
    );
    expect(result.plan.requiredCapabilities).toEqual(
      expect.arrayContaining([
        "finance_orchestration",
        "evidence_gates",
        "review_before_conclusion",
      ]),
    );
    expect(result.receipt.boundaries).toEqual(
      expect.arrayContaining([
        "host_result_is_not_learning_proof",
        "external_delivery_requires_independent_proof",
      ]),
    );
  });

  it("uses the same finance planner through the single engine service registry", () => {
    expect(LCX_ENGINE_SERVICES.finance.plan).toBe(planFinanceBrainOrchestration);
    const plan = planLcxEngineRequest({
      prompt: "研究 ETF 轮动和利率传导，不做交易。",
      availableSkillNames: ["finance-learning-researcher"],
    });
    expect(plan.route).toBe("finance");
    expect(plan.skillCue?.skillName).toBe("finance-learning-researcher");
    expect(plan.requiredCapabilities).toContain("skill_preflight");
  });

  it("propagates host failures instead of turning them into an engine success", async () => {
    await expect(
      runLcxEngine(
        { prompt: "run a normal task" },
        {
          id: "test.failing-host",
          run: async () => {
            throw new Error("host failed");
          },
        },
      ),
    ).rejects.toThrow("host failed");
  });

  it("keeps the latest OpenClaw harness boundary explicit-only and forwards the engine context", async () => {
    const bridge = createOpenClawHarnessBridge({
      id: "test.openclaw-host",
      run: async ({ plan }) => plan.route,
    });
    expect(bridge.seam).toBe(LCX_OPENCLAW_AGENT_HARNESS_SEAM);
    expect(bridge.harness.id).toBe(LCX_OPENCLAW_AGENT_HARNESS_ID);
    expect(bridge.harness.supports({ provider: "openai" })).toMatchObject({
      supported: false,
      fallbackRuntime: "openclaw",
    });
    expect(
      bridge.harness.supports({
        provider: "openai",
        requestedRuntime: LCX_OPENCLAW_AGENT_HARNESS_ID,
      }),
    ).toMatchObject({ supported: true });

    const result = await bridge.harness.runAttempt({
      request: { prompt: "研究 ETF 轮动，不做交易。" },
      plan: planLcxEngineRequest({ prompt: "研究 ETF 轮动，不做交易。" }),
    });
    expect(result).toBe("finance");
  });
});
