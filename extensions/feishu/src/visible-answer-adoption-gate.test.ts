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
    expect(decision.text).toContain("这是研究框架，不是交易指令");
    expect(decision.text).toContain("仓位占总资产");
    expect(decision.text).not.toContain("均价策略");
    expect(decision.text).not.toContain("止损策略");
    expect(decision.text).not.toContain("抄底");
    expect(decision.text).not.toContain("砍仓");
  });

  it("uses a single-stock rescue frame for NVDA loss asks instead of portfolio tickers", () => {
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage:
        "批量探针A3：我买了 NVDA 在高位，现在亏 20%，到底该砍掉、继续拿着，还是补一点摊低成本？请直接一点，但不要给交易指令，只给风险检查框架。",
      answerText: "我上一条已经给出了完整框架。先说结论：不要割，也不要再加，等待更合适。",
    });

    expect(decision.status).toBe("replaced");
    expect(decision.failedReasons).toEqual(
      expect.arrayContaining([
        "stale_prior_answer_deferral_for_standalone_finance_ask",
        "chinese_direct_position_action_language",
      ]),
    );
    expect(decision.text).toContain("NVDA：");
    expect(decision.text).toContain("仓位占总资产");
    expect(decision.text).toContain("失效条件");
    expect(decision.text).not.toContain("QQQ：");
    expect(decision.text).not.toContain("TLT：");
    expect(decision.text).not.toContain("继续拿着");
    expect(decision.text).not.toContain("补一点");
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
    expect(decision.text).toContain("Research-only frame, not a trading instruction");
    expect(decision.text).toContain("position size versus total portfolio");
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

  it("replaces stale prior-answer deferrals for standalone portfolio risk asks", () => {
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage:
        "批量探针A1：我现在持有 QQQ、TLT、NVDA，接下来一周应该重点看哪些风险？不要给交易指令，只给研究框架、需要的数据和失效条件。",
      answerText:
        "我上一条已经给出了 QQQ+TLT+NVDA 的一周风险监测框架。如果你想让我继续深化，可以告诉我补充权重数据。想往哪个方向深？分发状态：只发控制室摘要.",
    });

    expect(decision.status).toBe("replaced");
    expect(decision.failedReasons).toEqual(
      expect.arrayContaining(["stale_prior_answer_deferral_for_standalone_finance_ask"]),
    );
    expect(decision.text).toContain("这是研究框架，不是交易指令");
    expect(decision.text).toContain("QQQ：");
    expect(decision.text).toContain("TLT：");
    expect(decision.text).toContain("NVDA：");
    expect(decision.text).not.toContain("上一条");
    expect(decision.text).not.toContain("分发状态");
  });

  it("replaces generic control-room capability replies for provider disagreement asks", () => {
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage:
        "批量探针A5：Kimi、MiniMax、DeepSeek 三个模型意见不一致时，你应该怎么裁决？只说证据排序、本地 gate 和不能直接采信谁，不要暴露内部 JSON、message id、receipt path。",
      answerText:
        "我是 LCX Agent / OpenClaw 的 Lark 控制室入口。当前可用能力: 可以把自然语言请求分到 control_room、learning_command、technical_daily 等工作面。",
    });

    expect(decision.status).toBe("replaced");
    expect(decision.failedReasons).toEqual(
      expect.arrayContaining(["provider_council_arbitration_answer_missing"]),
    );
    expect(decision.text).toContain("证据排序");
    expect(decision.text).toContain("本地 gate");
    expect(decision.text).toContain("不直接采信任何一个模型");
    expect(decision.text).not.toContain("control_room");
    expect(decision.text).not.toContain("message id");
    expect(decision.text).not.toContain("receipt path");
  });

  it("strips internal distribution tails from otherwise valid visible answers", () => {
    const decision = applyVisibleAnswerAdoptionGate({
      userMessage: "最近市场风险怎么样？没有实时数据就只说边界。",
      answerText:
        "本次回答无实时数据，只能做低可信度框架参考，不构成任何交易建议。\n\n分发状态：只发控制室摘要.",
    });

    expect(decision.status).toBe("adopted");
    expect(decision.text).toBe("本次回答无实时数据，只能做低可信度框架参考，不构成任何交易建议。");
    expect(decision.text).not.toContain("分发状态");
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
