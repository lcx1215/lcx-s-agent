import { describe, expect, it } from "vitest";
import {
  applyVisibleAnswerAdoptionGate,
  findVisibleAnswerAdoptionGateFailures,
} from "./visible-answer-adoption-gate.js";

describe("visible answer adoption gate", () => {
  it("replaces retail loss-recovery action frameworks before visible Lark send", () => {
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage:
        "我NVDA追高买在高点，现在亏20%，要不要割肉？还是再加仓摊低成本？我就想快点回本，直接告诉我怎么做。",
      answerText:
        "先说结论：你现在最缺的不是建议，是数据。减亏两条路的本质：均价策略（抄底）和止损策略（砍仓）。",
    });

    expect(decision).toEqual(
      expect.objectContaining({
        status: "replaced",
        failedReasons: expect.arrayContaining(["chinese_action_framework_language"]),
      }),
    );
    expect(decision.text).toContain("这类问题不能直接给交易动作结论");
    expect(decision.text).toContain("研究检查");
    expect(decision.text).not.toContain("均价策略");
    expect(decision.text).not.toContain("止损策略");
    expect(decision.text).not.toContain("抄底");
    expect(decision.text).not.toContain("砍仓");
  });

  it("replaces English action stances for direct retail position asks", () => {
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage:
        "Retail stress: I bought NVDA near the top and I am down 20%. Should I cut the loss or average down? I want to recover quickly.",
      answerText: "Current Stance: wait. Do not cut the loss and do not average down yet.",
    });

    expect(decision.status).toBe("replaced");
    expect(decision.failedReasons).toEqual(
      expect.arrayContaining([
        "action_stance_heading_in_position_risk_reply",
        "english_direct_position_action_language",
      ]),
    );
    expect(decision.text).toContain("I can't give a direct trading action");
    expect(decision.text).toContain("research findings, risk gates, and invalidation points");
    expect(decision.text).not.toContain("Current Stance");
    expect(decision.text).not.toContain("Action Triggers");
  });

  it("replaces options and leverage action language for retail asks", () => {
    const optionDecision = applyVisibleAnswerAdoptionGate({
      userMessage: "财报前 NVDA call 能不能赌一把？我想快点翻本，但不要给交易指令。",
      answerText: "先说结论：可以小仓位赌财报，但不要满仓梭哈。",
    });
    const leverageDecision = applyVisibleAnswerAdoptionGate({
      userMessage: "币圈 10 倍杠杆快爆仓了，我该不该加保证金？",
      answerText: "不建议加保证金，应该先降杠杆。",
    });

    expect(optionDecision.status).toBe("replaced");
    expect(optionDecision.failedReasons).toEqual(
      expect.arrayContaining(["chinese_direct_position_action_language"]),
    );
    expect(optionDecision.text).toContain("杠杆/期权到期风险");
    expect(optionDecision.text).not.toContain("满仓");
    expect(optionDecision.text).not.toContain("梭哈");

    expect(leverageDecision.status).toBe("replaced");
    expect(leverageDecision.text).toContain("不给交易指令");
    expect(leverageDecision.text).not.toContain("加保证金");
  });

  it("adopts research-only answers that ask for missing evidence", () => {
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage: "NVDA 该买多少仓位？",
      answerText:
        "不能直接给比例。需要你的总资产、已有组合占比、成本、风险预算、时间周期，以及最新行情和财报来源；我只能先做 research-only 风险检查。",
    });

    expect(decision).toEqual({
      status: "adopted",
      text: "不能直接给比例。需要你的总资产、已有组合占比、成本、风险预算、时间周期，以及最新行情和财报来源；我只能先做 research-only 风险检查。",
      failedReasons: [],
    });
  });

  it("adopts research-only portfolio risk frameworks for current holdings", () => {
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage:
        "帮我分析一下：如果我现在持有 QQQ、TLT、NVDA，接下来一周应该重点看哪些风险？不要给交易指令，只给研究框架、需要的数据和失效条件。",
      answerText: [
        "先说清楚：研究框架不是交易建议，以下全部是观察点，不是操作指令。",
        "需要补充三个标的各自权重、风险预算、持仓时间窗口、成本价和数据来源时间戳。",
        "重点看 NVDA 财报、QQQ 科技集中度、TLT 对利率预期的敏感性，以及这些风险是否同向放大。",
        "如果美联储突然转鸽或 NVDA 财报指引超预期，上述框架需要重新评估。",
      ].join("\n\n"),
    });

    expect(decision.status).toBe("adopted");
    expect(decision.failedReasons).toEqual([]);
    expect(decision.text).toContain("QQQ 科技集中度");
    expect(decision.text).toContain("TLT 对利率预期");
  });

  it("does not apply retail position filters to generic finance education", () => {
    expect(
      findVisibleAnswerAdoptionGateFailures({
        userMessage: "学习期权基础知识。",
        answerText: "期权学习里会解释买入看涨、卖出看跌这些术语，但这不是交易建议。",
      }),
    ).toEqual([]);
  });
});
