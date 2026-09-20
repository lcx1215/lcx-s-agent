/**
 * Whether `strategy_candidate` actually forbids a direct asset action.
 *
 * That mode's contract is that a strategy candidate is an allocation view, not a trade instruction,
 * so `ASSET_ACTION_PATTERN` decides one thing: is an action verb bound to an asset. The measured
 * hole is the ordinary wording: 建仓 / 加码 (open or add to a position) were absent from the Chinese
 * side and `accumulate` / `build a position in` from the English side, so "配置：建仓 NVDA，权重 10%。"
 * -- a direct position instruction -- was admitted in the one mode that forbids a direct position
 * instruction, while the synonymous "买入 NVDA" was caught.
 *
 * The second half is the over-trigger guard, and it is why two things are built the way they are:
 * `build` is bound to "a position in" (a bare `build` would refuse "build the allocation", which is
 * what a strategy candidate is *for*), and a bare negator immediately before the verb counts as a
 * negation -- `ACTION_NEGATION_PATTERN` lists only multi-character forms, so "不建仓" was read as
 * opening the position it declines to open.
 */

import { describe, expect, it } from "vitest";
import { evaluateFinanceDecisionPolicy } from "../src/agents/finance-decision-policy.js";

const ask = "给一个组合配置方案";

function refusedAsAssetAction(answer: string): boolean {
  return evaluateFinanceDecisionPolicy({
    mode: "strategy_candidate",
    ask,
    answer,
  }).failedReasons.includes("strategy_candidate_must_not_be_asset_action");
}

describe("strategy_candidate refuses a direct asset action", () => {
  const actions = [
    "配置：买入 NVDA，权重 10%。",
    "配置：加仓 NVDA，权重 10%。",
    // The measured hole: the ordinary wording for opening / adding to a position.
    "配置：建仓 NVDA，权重 10%。",
    "配置：逐步建仓 NVDA，权重 10%。",
    "配置：加码 NVDA，权重 10%。",
    "Allocation: accumulate NVDA, weight 10%.",
    "Allocation: build a position in NVDA, weight 10%.",
    "Allocation: buy more NVDA, weight 10%.",
    "Allocation: go long NVDA, weight 10%.",
    // The shared tail accepts a measure word between the verb and the ticker, because the measure
    // word is part of the object phrase, and a bare amount.
    "配置：建仓一只 NVDA，权重 10%。",
    "配置：减仓 100 股 NVDA。",
    "配置：卖出股票，权重 10%。",
  ];

  for (const answer of actions) {
    it(`refuses "${answer}"`, () => {
      expect(refusedAsAssetAction(answer)).toBe(true);
    });
  }
});

describe("strategy_candidate does not refuse allocation prose", () => {
  const prose = [
    "配置：股票 60%，债券 40%，每季度再平衡。",
    "Allocation: equities 60%, bonds 40%, rebalance quarterly.",
    // `build` bound to "a position in": these are what a candidate is for.
    "We should build the allocation gradually over two quarters.",
    "First build a model of the drawdown, then size it.",
    // Past tense, so a description of what happened is not an instruction.
    "reduced NVDA exposure last week.",
    "The bid-ask spread widened today.",
    // A bare negator in front of the verb. "在缺乏时间戳证据前不建仓" declines to open a position;
    // refusing it would be refusing it for the thing it refuses to do.
    "在缺乏时间戳证据前不建仓，先给框架。",
    // The verb as a noun compound: the sentence *names* the action as a rule field, it does not
    // instruct anyone. The loose tail ("verb + any Chinese character") refused all five of these,
    // because 减仓/加仓/清仓/平仓 were followed by 理由 / 资格 / 条件.
    "配置：仓位上限 20%，减仓理由必须写清，触发条件为回撤 8%。",
    "策略：加仓资格取决于 thesis，不因亏损幅度决定。",
    "方案：清仓理由与失效条件需同时记录。",
    "组合：平仓条件写在规则里，人工确认后才执行。",
    "策略：减仓理由、触发条件、失效条件都要写。",
    // Deliberate trade-off of the shared tail: a measure word may sit between the verb and the
    // ticker (see below), but no other Chinese may, so a verb followed by unrelated Chinese and
    // then an uppercase token is not read as an instruction.
    "配置：建仓时用 AI 选股，权重 10%。",
    "减仓与 AI 无关，主题是估值。",
  ];

  for (const answer of prose) {
    it(`allows "${answer}"`, () => {
      expect(refusedAsAssetAction(answer)).toBe(false);
    });
  }
});
