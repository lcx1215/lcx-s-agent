/**
 * Numeric equality at the grounding gate.
 *
 * The gate compares a declared figure against a snapshot field by rendering both through one
 * normalizer. The bug this file locks is not "the comparison was too strict"; it was that the
 * comparison silently stopped happening below a magnitude threshold. Rendering with `toFixed(9)`
 * fixed nine decimal *places*, so every value under about 5e-10 collapsed to the same string
 * "0.000000000". A snapshot field of 1e-11 -- a wei-denominated amount, a per-share figure on a
 * micro-priced asset, any basis-point-scaled quantity -- therefore compared equal to a declared
 * 0 and to a declared 2e-11, and the gate stamped `verified` on a number the snapshot had never
 * contained.
 *
 * The gate's whole promise is that `verified` means "this number is in the data". A false
 * `verified` breaks that promise in the direction that matters: the receipt certifies a figure
 * nobody can substantiate. So these tests are written from the failure side -- a value the
 * snapshot does not contain must be refused -- with the tolerated cases (float noise, separators,
 * signed zero) kept as counterweights so the fix cannot be made by simply refusing everything.
 */

import { describe, expect, it } from "vitest";
import {
  checkAnswerGrounding,
  collectObservedValues,
} from "../src/agents/finance-answer-grounding-gate.js";
import type { CalculationRecord } from "../src/agents/finance-calculation-ledger.js";
import type {
  FinanceDataGatewaySnapshot,
  FinanceDataProviderRole,
} from "../src/agents/finance-data-gateway.js";

function snapshotWith(values: Array<string | number>): FinanceDataGatewaySnapshot {
  return {
    instrument: "TEST",
    assetClass: "equity",
    asOf: "2026-09-19T00:00:00.000Z",
    qualityStatus: "ready",
    boundary: "research_only",
    normalizedFields: values.map((value, index) => ({
      name: `f${index}`,
      value,
      providerName: "test_provider",
      providerRole: "official_or_issuer_reference" as FinanceDataProviderRole,
      sourceTimestamp: "2026-09-19T00:00:00.000Z",
    })),
    conflicts: [],
    missingEvidence: [],
    freshnessWarnings: [],
  } as unknown as FinanceDataGatewaySnapshot;
}

function answerObserving(value: string | number): string {
  return `The figure is ${String(value)}.\n\n\`\`\`figures\n${JSON.stringify([
    { kind: "observed", name: "f0", value },
  ])}\n\`\`\`\n`;
}

function verdictFor(snapshotValue: string | number, declared: string | number): string {
  return checkAnswerGrounding({
    answerText: answerObserving(declared),
    snapshot: snapshotWith([snapshotValue]),
  }).verdict;
}

describe("grounding gate numeric normalization", () => {
  it("refuses a declared zero for a snapshot field far below the old decimal-place cutoff", () => {
    // The regression itself. 1e-11 rendered as "0.000000000" under the old normalizer, so it
    // matched a declared 0 exactly and the answer was certified.
    expect(verdictFor(1e-11, 0)).toBe("ungrounded");
  });

  it("tells two different sub-cutoff magnitudes apart", () => {
    // 1e-11 and 2e-11 differ by a factor of two -- not a rounding detail -- yet both rendered as
    // "0.000000000" before the fix.
    expect(verdictFor(1e-11, 2e-11)).toBe("ungrounded");
  });

  it("still verifies a sub-cutoff figure that the snapshot really contains", () => {
    // The counterpart: the fix must not turn the gate into a blanket refusal of small numbers.
    expect(verdictFor(1e-11, 1e-11)).toBe("verified");
  });

  it("accepts a sub-cutoff figure written in decimal or exponent notation", () => {
    expect(verdictFor(1e-11, "0.00000000001")).toBe("verified");
    expect(verdictFor(1e-11, "1.0e-11")).toBe("verified");
  });

  it("refuses a declared zero for a wei-scale snapshot field", () => {
    // 1e-18 is one wei expressed in ether. Collapsing it onto zero is the same defect, one order
    // of magnitude further out.
    expect(verdictFor(1e-18, 0)).toBe("ungrounded");
    expect(verdictFor(1e-18, 1e-18)).toBe("verified");
  });

  it("keeps the tolerance that lets representation noise through", () => {
    // The reason a rounded comparison exists at all: 212.44 and 212.4400000001 are the same
    // number carried through different arithmetic.
    expect(verdictFor(212.44, 212.4400000001)).toBe("verified");
  });

  it("keeps thousands separators and underscores transparent", () => {
    expect(verdictFor("1,309,220,500", "1309220500")).toBe("verified");
    expect(verdictFor("1_309_220_500", "1,309,220,500")).toBe("verified");
  });

  it("folds signed zero onto zero", () => {
    expect(verdictFor(-0, 0)).toBe("verified");
    expect(verdictFor(0, -0)).toBe("verified");
  });

  it("still refuses an ordinary wrong number", () => {
    // Control: the gate's primary job, unaffected by the fix, must not be traded away for it.
    expect(verdictFor(212.44, 999.01)).toBe("ungrounded");
  });

  it("keeps non-numeric fields compared as case-insensitive strings", () => {
    expect(verdictFor("AAPL", "aapl")).toBe("verified");
    expect(verdictFor("AAPL", "MSFT")).toBe("ungrounded");
  });

  it("applies the same comparison on the derived path, not only the observed path", () => {
    // Derived figures are checked against the calculation ledger through the same normalizer, so
    // the collapse was reachable there too.
    // Only `output` is scanned for numbers, so the 1e-11 in `inputs` cannot create a match by
    // itself -- which is what makes the "good" case below evidence rather than a tautology.
    const calculations = [
      {
        id: "calc-1",
        action: "sum",
        inputs: { a: 1e-11, b: 0 },
        output: { total: 1e-11 },
        at: "2026-09-19T00:00:00.000Z",
      },
    ] as unknown as CalculationRecord[];
    const answer = (value: number): string =>
      `Total is ${value}.\n\n\`\`\`figures\n${JSON.stringify([
        { kind: "derived", name: "total", value },
      ])}\n\`\`\`\n`;
    const good = checkAnswerGrounding({ answerText: answer(1e-11), calculations });
    expect(good.verdict).toBe("verified");
    const bad = checkAnswerGrounding({ answerText: answer(0), calculations });
    expect(bad.verdict).toBe("ungrounded");
  });
});

describe("collectObservedValues", () => {
  it("keeps sub-cutoff magnitudes as distinct members", () => {
    const observed = collectObservedValues(snapshotWith([1e-11, 2e-11, 0]));
    expect(observed.size).toBe(3);
  });

  it("collapses the same sub-cutoff magnitude written three ways", () => {
    const observed = collectObservedValues(snapshotWith([1e-11, "0.00000000001", "1.0e-11"]));
    expect(observed.size).toBe(1);
  });
});
