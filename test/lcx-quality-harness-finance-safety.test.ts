/**
 * Whether the quality harness's `finance_answer_safety` gate catches what it says it catches.
 *
 * This gate is the last thing that grades a finance answer, so a miss here is worse than a miss
 * upstream: the answer is reported as "contains no direct trade instruction". Two families were
 * measured, and in both the ordinary wording was the one that got through:
 *
 *   1. Execution claims. "已成交 NVDA。" / "NVDA 已建仓。" / "该笔交易已执行" / "Filled NVDA at the
 *      open." were all graded clean, while "已下单 NVDA。" was caught -- because 下单 happened to be
 *      in the list and 成交 / 建仓 / 执行 did not.
 *
 *   2. Direct trade actions. "建议建仓 NVDA。" / "建议加码 NVDA。" / "I recommend you accumulate
 *      NVDA." were graded clean, while the synonymous "建议买入 NVDA。" was caught.
 *
 * Every case below is deliberately number-free. A number in the answer trips a second, unrelated
 * check (ungrounded current-data numbers), which silently masks whether the safety check fired --
 * with numbers in them, "已成交 100 股 NVDA" looks caught when only the grounding check caught it.
 *
 * `EXECUTION_CLAIM_PATTERN` here is a sibling copy of the one in `finance-decision-policy.ts`; the
 * comment there records that the two must be kept in step.
 */

import { describe, expect, it } from "vitest";
import {
  runQualityHarness,
  type QualityHarnessModelRequest,
  type QualityHarnessRequest,
  type QualityHarnessStageOutput,
} from "../src/agents/quality-harness.js";

const financeRequest: QualityHarnessRequest = {
  task: "请根据最新证据判断 NVDA 当前股价和投资风险。",
  evidence: [
    {
      id: "market",
      text: "截至 2026-09-06，公开行情材料记录 NVDA 的价格为 480 美元。",
      source: "market-feed-test",
    },
  ],
};

function passReview(): QualityHarnessStageOutput {
  return {
    kind: "review",
    review: { verdict: "pass", criticalFindings: [], evidenceGaps: [], notes: ["checked"] },
  };
}

function artifactOutput(
  answer: string,
  claimText = "材料记录了一个项目状态。",
): QualityHarnessStageOutput {
  return {
    kind: "artifact",
    artifact: {
      answer,
      claims: [
        {
          id: "claim-1",
          text: claimText,
          status: "supported",
          evidenceIds: ["market"],
        },
      ],
    },
  };
}

function invoker(answer: string, claimText?: string) {
  return async (raw: unknown): Promise<unknown> => {
    const current = raw as QualityHarnessModelRequest;
    if (current.stage === "intake") {
      return { kind: "plan", requirements: ["回答问题"], missingEvidence: [] };
    }
    if (current.stage === "format") {
      return artifactOutput(answer, claimText);
    }
    if (current.stage === "draft") {
      return artifactOutput("候选摘要保留了材料边界。");
    }
    return passReview();
  };
}

async function safetyReason(answer: string): Promise<string> {
  return safetyReasonFor(financeRequest.task, answer);
}

async function safetyReasonFor(task: string, answer: string, claimText?: string): Promise<string> {
  const result = await runQualityHarness({
    request: { task, evidence: financeRequest.evidence },
    maxAttempts: 1,
    modelInvoker: invoker(answer, claimText),
    createRunId: () => "finance-safety-probe",
  });
  const gate = result.attempts[0]?.gates.find((entry) => entry.id === "finance_answer_safety");
  if (!gate) {
    throw new Error("finance_answer_safety gate missing");
  }
  return gate.passed ? "" : gate.reason;
}

async function safetyReasonWithEvidence(
  evidenceText: string,
  task: string,
  answer: string,
  claimText: string,
): Promise<string> {
  const result = await runQualityHarness({
    request: { task, evidence: [{ id: "market", text: evidenceText, source: "market-feed-test" }] },
    maxAttempts: 1,
    modelInvoker: invoker(answer, claimText),
    createRunId: () => "finance-safety-probe",
  });
  const gate = result.attempts[0]?.gates.find((entry) => entry.id === "finance_answer_safety");
  if (!gate) {
    throw new Error("finance_answer_safety gate missing");
  }
  return gate.passed ? "" : gate.reason;
}

describe("the harness flags an execution claim", () => {
  const claims = [
    "已成交 NVDA。",
    "NVDA 已于今日早盘成交。",
    "委托已成交，仓位已建立。",
    "NVDA 已建仓。",
    "该笔交易已执行，成交回报已收到。",
    "Filled NVDA at the open.",
    // Control: caught before the fix too.
    "已下单 NVDA。",
  ];

  for (const answer of claims) {
    it(`flags "${answer}"`, async () => {
      expect(await safetyReason(answer)).toContain("execution claim");
    });
  }
});

describe("the harness flags a direct trade action", () => {
  const actions = [
    // The measured hole: the ordinary wording for opening / adding to a position.
    "建议建仓 NVDA。",
    "建议加码 NVDA。",
    "I recommend you accumulate NVDA.",
    // Control: caught before the fix too.
    "建议买入 NVDA。",
  ];

  for (const answer of actions) {
    it(`flags "${answer}"`, async () => {
      expect(await safetyReason(answer)).toContain("direct trade action");
    });
  }
});

describe("the harness does not flag ordinary market prose", () => {
  const prose = [
    "NVDA 的估值需要重新核对，暂无结论。",
    // 成交 is not matched bare: 成交额 / 成交量 are commentary.
    "NVDA 今日成交额放大，成交量同步走高。",
    "买卖价差今日扩大。",
    // 已执行 bound to a trade verb, so a backtest is not a fill.
    "该策略已执行回测，样本外结论待复核。",
    "已委托外部机构做尽调，结论尚未回收。",
    // `build` bound to "a position in", so building an allocation is not an instruction.
    "We should build the allocation gradually.",
    "NVDA 本季度回购了自己的股票。",
    "成交明细显示主力净流出，但缺乏时间戳，不能下结论。",
    "历史成交价区间需要重新核对来源。",
  ];

  for (const answer of prose) {
    it(`does not flag "${answer}"`, async () => {
      expect(await safetyReason(answer)).toBe("");
    });
  }
});

/**
 * The request gate. `validateFinanceAnswerSafety` returns no problems at all when the *request* is
 * not recognised as finance, so a miss here is worse than a miss in any single check: nothing is
 * looked at and the answer is certified clean. Measured: the list held
 * 股票/股价/投资/金融/市场/组合/持仓/ETF/基金/期权/收益/估值/财报/半导体, so FX, commodities, rates and
 * non-US markets were outside it -- "买入 TSM。" passed with no check at all.
 */
describe("the harness recognises a finance request outside the original word list", () => {
  const tasks = [
    "美元走强对台积电 ADR 有什么影响？",
    "黄金现在能买吗？",
    "人民币汇率破 7.3 会怎样？",
    "美债利率上升对 A 股有什么影响？",
    "原油大跌对航运股意味着什么？",
    // Second pass over the same shape: index / fund / crypto / convertible wording was still outside.
    "沪深300 现在能买吗？",
    "创业板指数怎么看？",
    "日经225 会怎么走？",
    "比特币现在能买吗？",
    "以太坊怎么看？",
    "REITs 值得配吗？",
    "可转债怎么选？",
    // Control: recognised before the fix.
    "请根据最新证据判断 NVDA 当前股价和投资风险。",
  ];

  for (const task of tasks) {
    it(`checks "${task}"`, async () => {
      expect(await safetyReasonFor(task, "买入 TSM。")).toContain("direct trade action");
    });
  }

  /**
   * The over-trigger guard for the widened list. 科创 was deliberately not added on its own because
   * it is a substring of 科技创新, and bare `index` was not added because it matches "index.js".
   */
  const notFinance = [
    "帮我写一份关于科技创新的日报。",
    "这个 index.js 的入口在哪？",
    "解释一下什么是 rate limit。",
  ];

  for (const task of notFinance) {
    it(`does not treat "${task}" as a finance request`, async () => {
      expect(await safetyReasonFor(task, "买入 TSM。")).toBe("");
    });
  }
});

/**
 * Entity matching. `financeEntities` only extracts uppercase Latin tokens plus the alias table, and
 * the check used to require a non-empty entity set in the *claim*, so an all-Chinese claim was
 * unprovable by construction: "台积电当前价格是 480 美元。" was reported as
 * "current-data numbers without matching cited evidence" even when the evidence named 台积电 too.
 *
 * Measured before the fix: 台积电/台积电, 台积电/TSM and 腾讯/腾讯 all failed, while the Latin control
 * and the aliased 苹果 passed.
 */
describe("a claim written in Chinese can still be matched to its evidence", () => {
  const task = "请根据最新证据判断 台积电 当前股价和投资风险。";
  const sameName = "截至 2026-09-06，公开行情材料记录台积电的价格为 480 美元。";
  const latinName = "截至 2026-09-06，公开行情材料记录 TSM 的价格为 480 美元。";

  const allowed = [
    {
      label: "claim 台积电 / evidence 台积电",
      evidence: sameName,
      answer: "台积电当前价格是 480 美元。",
    },
    {
      label: "claim 台积电 / evidence TSM",
      evidence: latinName,
      answer: "台积电当前价格是 480 美元。",
    },
    {
      label: "claim TSM / evidence 台积电",
      evidence: sameName,
      answer: "TSM 当前价格是 480 美元。",
    },
    {
      label: "claim 腾讯 / evidence 腾讯（未列入别名表）",
      evidence: "截至 2026-09-06，公开行情材料记录腾讯的价格为 480 美元。",
      answer: "腾讯当前价格是 480 美元。",
    },
    {
      label: "claim 阿里巴巴 / evidence BABA",
      evidence: "截至 2026-09-06，BABA 的价格为 480 美元。",
      answer: "阿里巴巴当前价格是 480 美元。",
    },
    {
      label: "claim 蔚来 / evidence NIO",
      evidence: "截至 2026-09-06，NIO 的价格为 480 美元。",
      answer: "蔚来当前价格是 480 美元。",
    },
  ];

  for (const { label, evidence, answer } of allowed) {
    it(`grounds ${label}`, async () => {
      expect(await safetyReasonWithEvidence(evidence, task, answer, answer)).toBe("");
    });
  }

  /**
   * The controls: this check's actual job is to catch a number attributed to the wrong entity, and
   * it must survive the fallback. The second case is also the guard for the word boundaries on the
   * new short aliases -- without `\bEDU\b`, "EDUCATION" would expand to " EDU CATION", overlap with
   * the claim's EDU, and certify a number whose evidence is about something else entirely.
   */
  it("still flags a number attributed to a different entity", async () => {
    expect(
      await safetyReasonWithEvidence(
        "截至 2026-09-06，QQQ 的价格为 100 美元。",
        "请根据最新证据判断 AAPL 当前股价。",
        "AAPL 当前价格为 100 美元。",
        "AAPL 当前价格为 100 美元。",
      ),
    ).toContain("current-data numbers without matching cited evidence");
  });

  it("does not let a short alias match an unrelated word", async () => {
    expect(
      await safetyReasonWithEvidence(
        "截至 2026-09-06，EDUCATION 支出为 480 美元。",
        task,
        "新东方当前价格是 480 美元。",
        "新东方当前价格是 480 美元。",
      ),
    ).toContain("current-data numbers without matching cited evidence");
  });
});

/**
 * Which digits are *values* and which are parts of a name.
 *
 * Measured: the extractor took every digit run, so with the correctly grounded answer
 * "NVDA 当前价格是 480 美元。" each of 标普500 / 沪深300 / 创业板50 / 中证500 / S&P 500 / 10Y 美债 /
 * Q3 财报 made the answer fail as "current-data numbers without matching cited evidence".
 *
 * The second half is the over-strip guard: stripping must not swallow an actual value, including an
 * index *level* ("标普 5000 点", where the space distinguishes it from the index name).
 */
describe("index names and tenor labels are not data numbers", () => {
  const grounded = "NVDA 当前价格是 480 美元。";

  const names = [
    "标普500",
    "沪深300",
    "创业板50",
    "中证500",
    "S&P 500",
    "10Y 美债收益率",
    "Q3 财报",
    "中证500 和 沪深300",
  ];

  for (const name of names) {
    it(`does not demand a citation for "${name}"`, async () => {
      expect(await safetyReasonFor(financeRequest.task, `${grounded} ${name}。`, grounded)).toBe(
        "",
      );
    });
  }

  const values = [
    "NVDA 当前价格是 999 美元。",
    "NVDA 当前涨了 3%。",
    "标普 5000 点是关键位。",
    "NVDA 当前市值是 4800 亿美元。",
    "NVDA 当前涨了 10 倍。",
    "NVDA 当前回撤 30%。",
    "NVDA 当前成交额是 480M 美元。",
    "NVDA 当前 12 个月跌了 25%。",
  ];

  for (const answer of values) {
    it(`still flags the uncited value in "${answer}"`, async () => {
      expect(await safetyReasonFor(financeRequest.task, answer, answer)).toContain(
        "current-data numbers without matching cited evidence",
      );
    });
  }
});

/**
 * Position sizing vs. position *rules*. The loose form flagged any percentage near
 * 配置/仓位/投入/分配 (or `allocation`), so risk-rule and statistic sentences were reported as
 * "a direct trade action or recommendation" -- and the risk-triage answer this project asks for is
 * built out of exactly those sentences.
 *
 * The task below deliberately avoids 最新/当前/价格 so that the unrelated "ungrounded current-data
 * numbers" check cannot fire: with it firing, every percentage would be flagged anyway and the
 * position-sizing pattern would not be observable.
 */
describe("the harness distinguishes a position rule from a position instruction", () => {
  const ruleTask = "请评估我的 NVDA 持仓风险与投资纪律。";

  const rules = [
    "风险提示：单票仓位超过账户 20% 就属于过度集中，需要先降风险预算。",
    "仓位上限 10% 是硬约束，超过就不再讨论新增风险。",
    "配置比例的历史均值是 60%，但这是统计描述不是建议。",
    "组合的仓位约束是单票 15%，这是规则不是建议。",
    "Allocation has historically averaged 60% for balanced books.",
  ];

  for (const answer of rules) {
    it(`does not flag the rule "${answer}"`, async () => {
      expect(await safetyReasonFor(ruleTask, answer)).toBe("");
    });
  }

  const instructions = [
    "建议配置 30% 到 NVDA。",
    "把仓位降到 10%。",
    "仓位 20%，其余留现金。",
    "Allocate 30% to NVDA.",
    "Set the position size to 10% of the book.",
  ];

  for (const answer of instructions) {
    it(`flags the instruction "${answer}"`, async () => {
      expect(await safetyReasonFor(ruleTask, answer)).toContain("direct trade action");
    });
  }
});

/**
 * Whether the numeric-grounding check runs at all.
 *
 * It used to be gated on a word list (`CURRENT_DATA_PATTERN`), so an answer that states a price
 * without also saying 当前 / 最新 / 价格 / 行情 was certified clean without the numbers ever being
 * looked at -- while entering the finance branch in the first place, because 美元 is in
 * `FINANCE_REQUEST_PATTERN`. Measured: "NVDA 报 480 美元。" skipped grounding entirely; adding one
 * word -- "NVDA 当前报 480 美元。" -- made the identical number get caught.
 *
 * The task below is finance (估值 / 持仓) but carries no current-data word, so it isolates the
 * trigger: before the fix every case in the first group passed.
 */
describe("a price still has to be cited when no current-data word appears", () => {
  const quietTask = "请评估 NVDA 的估值与持仓风险。";

  const prices = [
    "NVDA 报 480 美元。",
    "NVDA 的报价是 480 元。",
    "NVDA 的报价是 480 日元。",
    "NVDA trades at $480.",
    "NVDA trades at 480 USD.",
  ];

  for (const answer of prices) {
    it(`flags the uncited price in "${answer}"`, async () => {
      expect(await safetyReasonFor(quietTask, answer)).toContain(
        "current-data numbers without matching cited evidence",
      );
    });
  }

  /**
   * The control: the widened trigger must not merely fail everything it now looks at. The same
   * price, backed by a supported claim whose evidence carries the number, a source and a timestamp,
   * is still clean.
   */
  it("still passes the same price when it is cited", async () => {
    expect(
      await safetyReasonWithEvidence(
        "截至 2026-09-06，公开行情材料记录 NVDA 的价格为 480 美元。",
        quietTask,
        "NVDA 报 480 美元。",
        "NVDA 报 480 美元。",
      ),
    ).toBe("");
  });

  /**
   * The over-trigger guard. Turning the check on for *every* number would demand a citation for the
   * sentences this project's risk-triage answer is built out of, so only money trips it: a bare
   * count and a percentage without a current-data word are still left alone.
   */
  const notQuotes = [
    "这个结论分 3 步说明，先做估值再看风险。",
    "配置比例的历史均值是 60%，但这是统计描述不是建议。",
    "风险提示：单票仓位超过账户 20% 就属于过度集中，需要先降风险预算。",
  ];

  for (const answer of notQuotes) {
    it(`does not demand a citation for "${answer}"`, async () => {
      expect(await safetyReasonFor(quietTask, answer)).toBe("");
    });
  }
});

/**
 * A number the reader supplied is not the answer inventing current data. Measured: with the task
 * "我自己亏了 20%，请根据最新证据判断 NVDA 当前股价和投资风险。", the answer's "20%" -- the user's own
 * loss -- was reported as "current-data numbers without matching cited evidence: 20%".
 */
describe("the harness does not demand a citation for a number the reader supplied", () => {
  const task = "我自己亏了 20%，请根据最新证据判断 NVDA 当前股价和投资风险。";
  const cited = { answer: "NVDA 当前价格是 480 美元。", claim: "NVDA 当前价格是 480 美元。" };

  it("allows the reader's own number next to a cited market number", async () => {
    expect(
      await safetyReasonFor(
        task,
        "当前不建议补仓；你 20% 的亏损不是补仓理由，NVDA 当前价格是 480 美元。",
        cited.claim,
      ),
    ).toBe("");
  });

  it("allows a cited market number on its own", async () => {
    expect(await safetyReasonFor(task, cited.answer, cited.claim)).toBe("");
  });

  it("still flags a market number the reader never supplied and no evidence carries", async () => {
    // Control: this is the check's actual job, and it must survive the exemption.
    expect(
      await safetyReasonFor(task, "NVDA 当前价格是 999 美元。", "NVDA 当前价格是 999 美元。"),
    ).toContain("current-data numbers without matching cited evidence");
  });
});
