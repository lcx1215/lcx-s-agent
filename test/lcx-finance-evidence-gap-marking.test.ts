/**
 * Whether "the answer marked its evidence gap" means anything.
 *
 * The pipeline refuses a finance number that comes with no source unless the answer marks the gap.
 * The loose test for "marked the gap" matches bare evidence nouns -- 数据, 来源, 时间戳, as of, data,
 * source -- and those words have to appear in any sentence about evidence, so matching them proves
 * nothing. Measured end to end before this file existed:
 *
 *   "现在是 212.44 元数据已核验，风险可控。"        -> adopted, zero failed reasons
 *   "现在是 212.44。数据缺失，不能下结论。"        -> NOT adopted
 *
 * The first one passed because 元数据 contains the substring 数据. The second, the honest one, was
 * refused for an unrelated check. So the gate adopted a fabricated number and refused the answer
 * that said its data was missing -- the inversion a gate exists to prevent.
 *
 * The fix is `candidateMarksRealEvidenceGap`, which requires a gap construction rather than a noun.
 * It is wired behind `requireRealEvidenceMarking`, default off, for the same reason `requireGrounding`
 * is opt-in: tightening the predicate flips candidates that were passing on the bare word, and that
 * has to be a deliberate switch rather than a side effect of adding a check.
 *
 * These tests therefore pin three things: the strict predicate does what it claims, it does not
 * reject an answer that genuinely marks a gap, and the switch is genuinely opt-in -- the default
 * still behaves the loose way, so flipping it stays a decision someone has to make on purpose.
 */

import { describe, expect, it } from "vitest";
import { buildPipelineResult } from "../scripts/operator/lcx-commercial-answer-pipeline.js";

const ZH_ASK = "特斯拉现在多少钱";
const EN_ASK = "Give me the current share price of NVDA.";

/** Numbers with no source behind them; the only thing added is filler that happens to say 数据/risk. */
const FABRICATED = [
  { ask: ZH_ASK, candidate: "现在是 212.44 元数据已核验，风险可控。" },
  { ask: ZH_ASK, candidate: "现在是 212.44，数据来自内部估算，边界清楚。" },
  { ask: EN_ASK, candidate: "It is 212.44. Data and risk look fine." },
];

/** Answers that actually say what is missing. */
const HONEST_GAP = [
  { ask: ZH_ASK, candidate: "现在是 212.44。数据缺失，不能下结论。" },
  { ask: ZH_ASK, candidate: "没有来源时间戳，无法判断，需要先补齐数据。" },
  {
    ask: EN_ASK,
    candidate: "It is 212.44. No source timestamp is available, so this cannot be concluded.",
  },
];

function evidenceCheck(ask: string, candidate: string, strict: boolean) {
  const result = buildPipelineResult(
    ask,
    candidate,
    strict ? { requireRealEvidenceMarking: true } : {},
  );
  return result.checks.find((check) => check.id === "fresh_data_gap_or_timestamp_required");
}

describe("strict evidence-gap marking", () => {
  it("exists whenever a fresh-data or gateway need is present", () => {
    expect(evidenceCheck(ZH_ASK, FABRICATED[0].candidate, false)).toBeDefined();
  });

  for (const { ask, candidate } of FABRICATED) {
    it(`refuses a number whose only evidence is the word itself: ${candidate}`, () => {
      const check = evidenceCheck(ask, candidate, true);
      expect(check?.ok).toBe(false);
      // The specific reason, not the generic one: the number is there, no gateway evidence backs
      // it, and no real gap was marked -- so it is reported as a number without a snapshot.
      expect(check?.failedReason).toBe("finance_data_gateway_snapshot_missing_for_number");
    });
  }

  for (const { ask, candidate } of HONEST_GAP) {
    it(`accepts an answer that really marks the gap: ${candidate}`, () => {
      expect(evidenceCheck(ask, candidate, true)?.ok).toBe(true);
    });
  }

  it("stops adopting the fabricated answer", () => {
    // The end-to-end consequence, not just the flag on one check: before the strict predicate the
    // same input came back `adopt_visible_answer` with no failed reasons at all.
    for (const { ask, candidate } of FABRICATED) {
      const result = buildPipelineResult(ask, candidate, { requireRealEvidenceMarking: true });
      expect(result.terminalDecision).toBe("return_failed_reason");
    }
  });
});

describe("the switch is opt-in", () => {
  // Deliberately characterising the loose default rather than hiding it. If someone flips the
  // default, these fail loudly -- which is the point: the author's own note says turning a
  // whole-suite flip on has to be a deliberate switch, not a side effect.
  for (const { ask, candidate } of FABRICATED) {
    it(`default still passes on the bare noun: ${candidate}`, () => {
      expect(evidenceCheck(ask, candidate, false)?.ok).toBe(true);
    });
  }

  it("does not change the honest answer's verdict either way", () => {
    for (const { ask, candidate } of HONEST_GAP) {
      expect(evidenceCheck(ask, candidate, false)?.ok).toBe(true);
      expect(evidenceCheck(ask, candidate, true)?.ok).toBe(true);
    }
  });
});
