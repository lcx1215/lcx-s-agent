/**
 * Whether an ask that demands a current number actually demands the data gateway.
 *
 * The route is keyword-driven: `resolveNeeds` and `needsFinanceDataGateway` match the ask against
 * bilingual patterns, and a miss does not raise anything -- it simply means the gateway is never
 * required, so a candidate answer stating a price is adopted with no data requirement at all. That
 * is the failure this file exists to catch: not a wrong number, but a missing requirement that
 * makes every later check vacuous.
 *
 * The defect was one-sided. The Chinese patterns caught 股价/最新/持仓, so those asks were routed
 * through the gateway; the English word list had `price|quote|now` but not the ordinary phrasings,
 * so "What is AAPL trading at?" and "How much is Bitcoin worth?" were adopted outright. Same
 * question, two languages, two different evidence standards.
 *
 * The second half of the file is the counterweight. Widening a keyword list is the kind of fix that
 * quietly over-triggers, and over-triggering is its own defect: asking for a market-data snapshot
 * for "how many shares did my post get" makes the pipeline demand evidence that does not exist and
 * refuse an answer it could have given. These tests pin both directions.
 */

import { describe, expect, it } from "vitest";
import { buildPipelineResult } from "../scripts/operator/lcx-commercial-answer-pipeline.js";

/** A candidate that states a number with no source, no timestamp and no figures block. */
const UNSOURCED_NUMBER = "It is 212.44.";

function requiredNeeds(ask: string): string[] {
  return buildPipelineResult(ask, UNSOURCED_NUMBER)
    .needs.filter((need) => need.required)
    .map((need) => need.id);
}

function requiresGateway(ask: string): boolean {
  return requiredNeeds(ask).includes("finance_data_gateway");
}

describe("asks for a current number require the finance data gateway", () => {
  const asks = [
    "What is AAPL trading at?",
    "How much is Bitcoin worth?",
    "How many shares do I own?",
    "What's the quote for MSFT?",
    "Give me the current share price of NVDA.",
    "Is NVDA expensive right now?",
  ];

  for (const ask of asks) {
    it(`routes "${ask}" through the gateway`, () => {
      expect(requiresGateway(ask)).toBe(true);
    });
  }

  it("does not adopt an unsourced number for any of them", () => {
    for (const ask of asks) {
      expect(buildPipelineResult(ask, UNSOURCED_NUMBER).terminalDecision).toBe(
        "return_failed_reason",
      );
    }
  });

  it("keeps the Chinese asks that already worked", () => {
    for (const ask of ["特斯拉股价多少", "苹果最新价格", "我持仓多少"]) {
      expect(requiresGateway(ask)).toBe(true);
    }
  });

  it("still refuses an unsourced number when the gateway keyword is ambiguous", () => {
    // "account balance" is deliberately not treated as a market-data request: it can mean a cloud
    // or bank account. It must still not sail through, and it does not -- the fresh-data need
    // catches it. Recorded here so the ambiguity is a stated choice, not an unnoticed hole.
    const needs = requiredNeeds("What is my account balance?");
    expect(needs).toContain("fresh_or_current_data");
    expect(
      buildPipelineResult("What is my account balance?", UNSOURCED_NUMBER).terminalDecision,
    ).toBe("return_failed_reason");
  });
});

describe("the gateway is not required for asks with no number in them", () => {
  // Over-trigger guard. `\bhow many shares\b` was tried and removed for exactly this reason: it
  // matched "how many shares did my post get". The surviving pattern is `shares? ... own`, which
  // covers the real ask without claiming social-media counters as market data.
  const asks = [
    "How many shares did my post get?",
    "Is this course worth it?",
    "How should I balance risk and reward here?",
    "Explain what a market order is.",
  ];

  for (const ask of asks) {
    it(`does not demand a snapshot for "${ask}"`, () => {
      expect(requiresGateway(ask)).toBe(false);
    });
  }
});
