/**
 * Whether `research_only` actually refuses a trade instruction.
 *
 * That mode has exactly one job in this file: an answer that tells the reader to buy, sell, add or
 * reduce must not pass. It was checked by a single pattern that needed *two* keywords, and the
 * second one had to be an exact word -- so "I recommend buying NVDA here" never matched (`buying`
 * is not `\bbuy\b`), and the Chinese side needed a hedge word (建议|应该|可以) before the verb, so a
 * bare "买入 NVDA。" never matched either. The most direct form of the instruction -- the imperative
 * -- was the one that got through, while "Sell all of your TLT position today." was caught only
 * because it happened to contain the word "position".
 *
 * The fix adds a pattern for a verb bound to an asset. The second half of this file pins what that
 * must NOT catch, because the obvious way to write it (`/buy|sell/i`) would refuse any research
 * sentence that mentions buying or selling at all.
 */

import { describe, expect, it } from "vitest";
import { evaluateFinanceDecisionPolicy } from "../src/agents/finance-decision-policy.js";

function refusedInResearchOnly(answer: string): boolean {
  return !evaluateFinanceDecisionPolicy({
    mode: "research_only",
    ask: "NVDA 能买吗",
    answer,
  }).allowed;
}

describe("research_only refuses a trade instruction", () => {
  const instructions = [
    "买入 NVDA。",
    "卖出全部 QQ。",
    "加仓到 20%。",
    "减仓一半。",
    "清仓 NVDA。",
    "Buy NVDA now.",
    "buy NVDA now.",
    "Sell all of your TLT position today.",
    "Go long QQQ into earnings.",
  ];

  for (const answer of instructions) {
    it(`refuses "${answer}"`, () => {
      expect(refusedInResearchOnly(answer)).toBe(true);
    });
  }

  it("refuses the gerund form that the two-keyword pattern missed", () => {
    // The measured hole: `buying` never matched `\bbuy\b`, so the most natural English phrasing
    // of a recommendation was allowed through in the mode that forbids recommendations.
    expect(refusedInResearchOnly("I recommend buying NVDA here.")).toBe(true);
  });

  it("keeps refusing the hedged forms it already caught", () => {
    expect(refusedInResearchOnly("建议买入 NVDA。")).toBe(true);
    expect(refusedInResearchOnly("应该减仓一半。")).toBe(true);
  });

  it("reports why, rather than refusing silently", () => {
    const result = evaluateFinanceDecisionPolicy({
      mode: "research_only",
      ask: "NVDA 能买吗",
      answer: "Buy NVDA now.",
    });
    expect(result.failedReasons).toContain("direct_trade_or_position_action_language");
  });
});

describe("research_only allows risk-triage prose that names an action as a gate", () => {
  // The regression this pins. `DIRECT_ASSET_ACTION_PATTERN` first wrote its Chinese tail as
  // "verb + any Chinese character", which degenerates to "the verb appears somewhere". The
  // pipeline's own quality fuzzer caught it: the positive case for single-stock loss recovery --
  // "风险结论：NVDA 亏 20% 本身不是补仓理由。默认风险门：补仓资格=未通过…" -- was refused with
  // `direct_trade_or_position_action_language`, i.e. a risk gate that *denies* top-up eligibility
  // was read as an instruction to top up. It matched on 补仓 + 资格.
  const riskGateProse = [
    "默认风险门：补仓资格=未通过，直到你把 thesis、仓位占比和强制风险补齐。",
    "亏 20% 本身不是补仓理由。",
    "说不清买入 thesis、仓位对账户太重时，目标先变成账户风险控制。",
    "减仓理由必须写清，否则只能给研究框架。",
    "加仓资格取决于仓位占比和最大可承受回撤，不是亏损幅度。",
  ];

  for (const answer of riskGateProse) {
    it(`allows "${answer}"`, () => {
      expect(refusedInResearchOnly(answer)).toBe(false);
    });
  }
});

describe("research_only does not refuse research prose", () => {
  // Over-trigger guard. These all mention buying, selling or a ticker; none of them instruct anyone
  // to do anything.
  const prose = [
    "NVDA 的估值需要重新核对，暂无结论。",
    "买卖价差今天扩大了。",
    "The bid-ask spread widened today.",
    "I would not buy here without earnings data.",
    "reduced NVDA exposure last week.",
    // Naming an action in order to refuse it. This is the case that broke the pipeline's own
    // scenario suite: a research answer saying "不能给加仓、减仓或期权方向" was refused for the
    // thing it declined to do, so negation has to be read before the verb is.
    "缺这些数据时只能给研究框架，不能给加仓、减仓或期权方向。",
    "I would not buy NVDA without earnings data.",
  ];

  for (const answer of prose) {
    it(`allows "${answer}"`, () => {
      expect(refusedInResearchOnly(answer)).toBe(false);
    });
  }
});
