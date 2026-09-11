import { describe, expect, it } from "vitest";
import { STRATEGY_METHOD_IDS } from "./finance-strategy-method-catalog.js";
import {
  buildFinanceStrategyMethodKit,
  FINANCE_STRATEGY_METHOD_KIT_SCHEMA_VERSION,
} from "./finance-strategy-method-kit.js";

describe("finance strategy method kit", () => {
  it("exposes the frozen M01/M02/M12 contract used by model requests", () => {
    const kit = buildFinanceStrategyMethodKit("回测三年美股表现");
    expect(kit.schemaVersion).toBe(FINANCE_STRATEGY_METHOD_KIT_SCHEMA_VERSION);
    expect(kit.selectedModules).toEqual(["M01", "M02", "M12"]);
    expect(kit.rules.M02?.join(" ")).toContain("200-session");
    expect(kit.rules.M01?.join(" ")).toContain("point-in-time");
    expect(kit.rules.M12?.join(" ")).toContain("common factor");
    expect(kit.prompt).toContain("executionAuthority=none");
    expect(kit.catalog.methods).toHaveLength(12);
    expect(kit.catalog.directions).toHaveLength(28);
    expect(Object.keys(kit.catalog.operationalContracts)).toEqual([...STRATEGY_METHOD_IDS]);
    expect(kit.prompt).toContain("M11 波动率相对价值");
    expect(kit.prompt).toContain("D28 融资拥挤与流动性压力");
    expect(Object.isFrozen(kit)).toBe(true);
  });
  it("does not turn a factual request into a trend backtest", () => {
    const kit = buildFinanceStrategyMethodKit("核对 SPY 昨日收盘价和来源时间");
    expect(kit.selectedModules).toEqual(["M01"]);
    expect(kit.prompt).not.toContain("200-session");
    expect(kit.requiredOutputChecks).not.toContain("net-cost result versus a simple baseline");
    expect(kit.taskScope).toBe("research");
    expect(kit.rules.M02).toBeUndefined();
    expect(kit.rules.M12).toBeUndefined();
  });
  it("selects exposure without inventing a trend method", () => {
    const kit = buildFinanceStrategyMethodKit("检查组合的共同暴露和回撤");
    expect(kit.selectedModules).toEqual(["M01", "M12"]);
    expect(kit.prompt).not.toContain("200-session");
    expect(Object.isFrozen(kit.selectedModules)).toBe(true);
  });
  it("selects the macro contract for a macro pricing question", () => {
    const kit = buildFinanceStrategyMethodKit("比较通胀和收益率曲线对资产定价的影响");
    expect(kit.selectedModules).toEqual(["M01", "M03"]);
    expect(kit.rules.M03?.join(" ")).toContain("发布日期与 vintage");
    expect(kit.rules.M03?.join(" ")).toContain("官方首发值/修订/发布日期");
    expect(kit.prompt).toContain("M03 宏观变化与市场定价差");
  });
  it("selects both option protection and volatility contracts for an option volatility question", () => {
    const kit = buildFinanceStrategyMethodKit("评估期权波动率曲面和尾部保护成本");
    expect(kit.selectedModules).toEqual(["M01", "M10", "M11"]);
    expect(kit.rules.M10?.join(" ")).toContain("组合压力损失");
    expect(kit.rules.M11?.join(" ")).toContain("完整同步曲面");
    expect(kit.prompt).toContain("M10 尾部保护与保险预算");
    expect(kit.prompt).toContain("M11 波动率相对价值");
  });
});
