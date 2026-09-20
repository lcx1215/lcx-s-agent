/**
 * Whether `conditional_trade_candidate` requires the fields it claims to require.
 *
 * This mode admits a candidate by six text-level checks plus two structured ones. The text-level
 * ones are keyword-presence checks, so the failure mode is not "too strict" but "satisfied by a
 * word that does not carry the meaning". Two families were measured:
 *
 *   1. A bare noun standing in for a whole field. 数据 or 来源 alone satisfied
 *      `source_and_timestamped_evidence`, so an answer padded with six filler words
 *      ("策略：如果数据变化就买入 NVDA，风险可控，周期一周，仅候选。") passed, while a genuine packet
 *      naming CPI, a drawdown limit and an invalidation was refused for missing evidence.
 *
 *   2. An English keyword matching inside an unrelated longer word. `term` matched inside
 *      "determine", `if` inside "identify"/"notify"/"specific", `thesis` inside "hypothesis", and
 *      当 inside "当前". The clearest case is the worst direction: a candidate whose horizon is
 *      explicitly *undecided* ("后续再 determine") was the one that passed `time_horizon`.
 *
 * The second half pins what must still pass, because tightening every keyword to a word boundary
 * would otherwise refuse ordinary legitimate phrasing ("long term", "two weeks", "if CPI cools").
 */

import { describe, expect, it } from "vitest";
import { evaluateFinanceDecisionPolicy } from "../src/agents/finance-decision-policy.js";

const mode = "conditional_trade_candidate" as const;
const ask = "给一个 NVDA 的条件交易候选";

/**
 * A machine-shaped structured packet. Its content is whatever the caller writes, so it is what
 * lets a text-level hole reach `allowed` instead of stopping at `requiredEvidence`.
 */
const packet = {
  evidence: [{ id: "e1", text: "CPI print" }],
  claims: [{ status: "supported" as const, evidenceIds: ["e1"] }],
  supportingAnalysis: { scenarios: [{ evidenceIds: ["e1"], invalidation: "跌破 100 日线" }] },
};

function requiredFor(answer: string, withPacket = false): readonly string[] {
  return evaluateFinanceDecisionPolicy({
    mode,
    ask,
    answer,
    ...(withPacket ? { candidateContext: packet } : {}),
  }).requiredEvidence;
}

describe("a filler word does not stand in for a contract field", () => {
  const padded: Array<{ label: string; answer: string; missing: string }> = [
    {
      label: "数据 alone",
      answer: "策略：如果数据变化就买入 NVDA，风险可控，周期一周，仅候选。",
      missing: "source_and_timestamped_evidence",
    },
    {
      label: "来源 alone",
      answer: "策略：如果来源变化就买入 NVDA，风险可控，周期一周，仅候选。",
      missing: "source_and_timestamped_evidence",
    },
    {
      label: "当前 is not a trigger",
      answer: "策略：截至 2026-09-07 当前估值下买入 NVDA，风险可控，持有期一周，仅候选。",
      missing: "conditional_trigger_or_scenario",
    },
    {
      label: "determine is not a horizon",
      answer: "策略：截至 2026-09-07 若 CPI 回落则买入 NVDA，风险可控，后续再 determine，仅候选。",
      missing: "time_horizon",
    },
    {
      label: "identify is not a trigger",
      answer:
        "策略：截至 2026-09-07 买入 NVDA，风险可控，持有期一周，仅候选。We will identify the entry.",
      missing: "conditional_trigger_or_scenario",
    },
    {
      label: "hypothesis is not a thesis",
      // No 策略/候选 anywhere: the only thesis-shaped word in this answer is inside "hypothesis".
      answer:
        "截至 2026-09-07 若 CPI 回落则买入 NVDA，最大回撤 8%，跌破 100 日线失效，持有期一周，不自动下单。Our hypothesis is multiple compression.",
      missing: "strategy_or_candidate_thesis",
    },
  ];

  for (const c of padded) {
    it(`still requires ${c.missing} for "${c.label}"`, () => {
      expect(requiredFor(c.answer)).toContain(c.missing);
    });
  }

  it("refuses a packet whose two substantive fields are absent, rather than certifying it", () => {
    // The end-to-end form: with a structured packet attached, the padded answer is the one that
    // used to be admitted as contract-complete while saying its horizon was not decided yet.
    const result = evaluateFinanceDecisionPolicy({
      mode,
      ask,
      answer: "策略：截至 2026-09-07 当前估值下买入 NVDA，风险可控，后续再 determine，仅候选。",
      candidateContext: packet,
    });
    expect(result.allowed).toBe(false);
    expect(result.requiredEvidence).toEqual(["conditional_trigger_or_scenario", "time_horizon"]);
  });
});

describe("ordinary phrasing still satisfies the field it means", () => {
  const genuine: Array<{ label: string; answer: string; satisfied: string }> = [
    {
      label: "截至 + 财报/报价数据",
      answer:
        "策略：截至 2026-09-07 的财报和报价数据显示，若 CPI 回落则买入 NVDA，最大回撤 8%，跌破 100 日线失效，持有期一周，仅候选不自动下单。",
      satisfied: "source_and_timestamped_evidence",
    },
    {
      label: "long term",
      answer: "Strategy candidate over the long term.",
      satisfied: "time_horizon",
    },
    { label: "two weeks", answer: "Strategy candidate for two weeks.", satisfied: "time_horizon" },
    {
      label: "if CPI cools",
      answer: "Candidate: buy NVDA if CPI cools.",
      satisfied: "conditional_trigger_or_scenario",
    },
    {
      label: "candidate thesis",
      answer: "Candidate thesis: multiples compress.",
      satisfied: "strategy_or_candidate_thesis",
    },
  ];

  for (const g of genuine) {
    it(`does not require ${g.satisfied} for "${g.label}"`, () => {
      expect(requiredFor(g.answer)).not.toContain(g.satisfied);
    });
  }

  it("admits a genuine packet that carries every field", () => {
    const result = evaluateFinanceDecisionPolicy({
      mode,
      ask,
      answer:
        "策略：截至 2026-09-07 若 CPI 回落至 3% 以下则买入 NVDA，最大回撤 8%，跌破 100 日线失效，持有期一周，仅候选不自动下单。",
      candidateContext: packet,
    });
    expect(result.allowed).toBe(true);
    expect(result.requiredEvidence).toEqual([]);
  });
});
