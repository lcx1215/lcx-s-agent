/**
 * Arithmetic the visible-answer gate performs on numbers the user supplied.
 *
 * This is one of the few places in the answer path that computes a number rather than matching
 * words, so the failure mode is not "the wrong reply shape" but "a wrong number that looks right".
 * Three defects were measured here before this file existed:
 *
 *  1. The base was the leftmost number in the message. "2026年6818一天净增46条" answered
 *     46/2026 = 2.27% and "9月20日6818一天净增46条" answered 46/9 = 511.11%, both instead of
 *     46/6818 = 0.67%. A number that wrong is worse than no number.
 *  2. A decrease could not be expressed at all. The trend list held only increase words, so
 *     "6818一天跌了46条" fell through to the magnitude-only fallback and was reported as +0.67%.
 *  3. English asks were not recognised as arithmetic, so "6818 gained 46 today, what percentage
 *     growth is that?" got no computation while the Chinese equivalent did.
 *
 * The second half of the file guards the other direction. All three fixes widen a pattern, and a
 * widened trend pattern will happily read "lost" and "rate" in an unrelated sentence as an
 * arithmetic question.
 */

import { describe, expect, it } from "vitest";
import { applyVisibleAnswerAdoptionGate } from "../src/agents/visible-answer-adoption-gate.js";

function replyFor(userMessage: string): string {
  const decision = applyVisibleAnswerAdoptionGate({
    userMessage,
    answerText: "不确定。",
    financeDecisionMode: "research_only",
  });
  return decision.text ?? "";
}

function wasReplaced(userMessage: string): boolean {
  return (
    applyVisibleAnswerAdoptionGate({
      userMessage,
      answerText: "不确定。",
      financeDecisionMode: "research_only",
    }).status === "replaced"
  );
}

describe("user-supplied arithmetic uses the right pair of numbers", () => {
  it("computes the ratio the ask was written for", () => {
    expect(replyFor("6818一天净增46条，大概涨了多少比例？")).toContain("46 / 6818 = 0.67%");
  });

  it("does not let a leading year become the base", () => {
    const reply = replyFor("2026年6818一天净增46条，大概涨了多少比例？");
    expect(reply).toContain("46 / 6818 = 0.67%");
    expect(reply).not.toContain("46 / 2026");
  });

  it("does not let a leading date become the base", () => {
    // The worst measured case: the base was taken as 9, producing 511.11%.
    const reply = replyFor("9月20日6818一天净增46条，大概涨了多少比例？");
    expect(reply).toContain("46 / 6818 = 0.67%");
    expect(reply).not.toContain("46 / 9 ");
  });

  it("survives a full date in front of the numbers", () => {
    expect(replyFor("2026年9月20日，6818一天净增46条，大概涨了多少比例？")).toContain(
      "46 / 6818 = 0.67%",
    );
  });

  it("reads a thousands-separated base", () => {
    expect(replyFor("6,818一天净增46条，大概涨了多少比例？")).toContain("46 / 6818 = 0.67%");
  });
});

describe("the sign follows the direction the user stated", () => {
  it("reports a drop as negative", () => {
    expect(replyFor("6818一天跌了46条，大概跌了多少比例？")).toContain("-46 / 6818 = -0.67%");
  });

  it("reports a reduction as negative", () => {
    expect(replyFor("6818一天减少46条，大概降了多少比例？")).toContain("-46 / 6818 = -0.67%");
  });

  it("reads an explicit minus on the delta", () => {
    expect(replyFor("6818一天净增-46条，大概变化了多少比例？")).toContain("-46 / 6818 = -0.67%");
  });

  it("keeps growth positive", () => {
    const reply = replyFor("6818一天涨了46条，大概涨了多少比例？");
    expect(reply).toContain("46 / 6818 = 0.67%");
    expect(reply).not.toContain("-0.67%");
  });
});

describe("the same arithmetic works in English", () => {
  it("computes a gain", () => {
    expect(replyFor("6818 gained 46 today, what percentage growth is that?")).toContain(
      "46 / 6818 = 0.67%",
    );
  });

  it("computes a drop", () => {
    expect(replyFor("6818 dropped 46 today, what percentage is that?")).toContain(
      "-46 / 6818 = -0.67%",
    );
  });
});

describe("unrelated sentences are not read as arithmetic", () => {
  // Over-trigger guard. The trend and ratio vocabularies now contain "lost", "rate", "up", "dropped"
  // and their Chinese counterparts, so these pin that an ordinary sentence is left alone.
  const notArithmetic = [
    "What is up with 6818 today?",
    "I lost my notes, what is the rate limit here?",
    "6818和46是什么关系？",
    "到哪了",
  ];

  for (const ask of notArithmetic) {
    it(`leaves "${ask}" alone`, () => {
      expect(wasReplaced(ask)).toBe(false);
    });
  }
});
