/**
 * Whether a claim that an execution happened is actually caught.
 *
 * Outside `live_execution` the policy forbids it outright: only the declared execution adapter can
 * produce a fill, so an answer asserting one is asserting a side effect nobody performed.
 *
 * The measured hole is that the ordinary wording was missing from the pattern. 已成交 / 已建仓 /
 * 已执行 -- the standard Chinese way to say a trade completed -- were absent, as was
 * "Filled 100 NVDA at 180." (the English side needed the literal word "order"). So a claim of a
 * fill written the normal way was admitted in every mode that forbids execution claims, while the
 * contrived phrasings the author happened to list were the only ones refused.
 *
 * The second half is the over-trigger guard, and it is the reason 成交 is not matched bare:
 * "成交额" (turnover) and "成交量" (volume) are market commentary, and "已委托外部机构做尽调"
 * commissions a firm, not an order.
 */

import { describe, expect, it } from "vitest";
import { evaluateFinanceDecisionPolicy } from "../src/agents/finance-decision-policy.js";

function claimsExecution(answer: string): boolean {
  return evaluateFinanceDecisionPolicy({
    mode: "conditional_trade_candidate",
    ask: "给一个 NVDA 的条件交易候选",
    answer,
  }).failedReasons.includes("finance_execution_claim_forbidden");
}

describe("a claim that a trade executed is refused", () => {
  const claims = [
    "已下单 NVDA 100 股。",
    "已经买入 NVDA 100 股。",
    "已成交 100 股 NVDA，均价 180。",
    "NVDA 已于 09:20 成交，成交均价 180.2。",
    "委托已成交，仓位已建立。",
    "NVDA 已建仓，成本 180。",
    "已平仓 TLT。",
    "Filled 100 NVDA at 180.",
    "NVDA position opened at 180.",
    "该笔交易已执行，成交回报已收到。",
  ];

  for (const answer of claims) {
    it(`refuses "${answer}"`, () => {
      expect(claimsExecution(answer)).toBe(true);
    });
  }

  it("refuses it in research_only too, where no execution is possible at all", () => {
    const result = evaluateFinanceDecisionPolicy({
      mode: "research_only",
      ask: "NVDA 现在怎么样",
      answer: "已成交 100 股 NVDA，均价 180。",
    });
    expect(result.allowed).toBe(false);
    expect(result.failedReasons).toContain("finance_execution_claim_forbidden");
  });
});

describe("market commentary is not read as an execution claim", () => {
  const prose = [
    "NVDA 今日成交额 120 亿美元，盘中放量。",
    "成交量较昨日放大 20%。",
    // 已执行 bound to a trade verb, so a backtest is not a fill.
    "该策略已执行回测，样本外结论待复核。",
    // 已委托 bound to a trade verb, so commissioning a firm is not an order.
    "已委托外部机构做尽调，结论尚未回收。",
    "NVDA 本季度回购了 1000 万股。",
    "历史成交价区间为 120–180，需重新核对来源。",
    "成交明细显示主力净流出，但缺乏时间戳，不能下结论。",
  ];

  for (const answer of prose) {
    it(`does not refuse "${answer}"`, () => {
      expect(claimsExecution(answer)).toBe(false);
    });
  }
});
