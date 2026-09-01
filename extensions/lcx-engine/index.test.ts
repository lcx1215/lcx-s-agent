import { describe, expect, it } from "vitest";
import { buildLcxBetaPreflight, LCX_ENGINE_BETA_ADAPTER_ID } from "./index.js";

describe("OpenClaw beta LCX adapter", () => {
  it("keeps finance preflight deterministic and high risk", () => {
    const result = buildLcxBetaPreflight("请审计 NVDA 仓位风险和最新财报证据");

    expect(result.plan).toMatchObject({
      contractVersion: "lcx_engine_v1",
      route: "finance",
      riskTier: "high",
    });
    expect(result.context).toContain(`Host adapter: ${LCX_ENGINE_BETA_ADAPTER_ID}`);
    expect(result.context).toContain("host_result_is_not_learning_proof");
  });

  it("leaves ordinary requests on the general route", () => {
    const result = buildLcxBetaPreflight("整理今天的会议待办");

    expect(result.plan.route).toBe("general");
    expect(result.plan.riskTier).toBe("standard");
    expect(result.context).toContain("Execution host: OpenClaw beta");
  });
});
