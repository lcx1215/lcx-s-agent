/**
 * Tests for the output-side grounding gate.
 *
 * The gate's value is not that it accepts good answers; it is that it refuses to certify answers
 * it cannot check. A gate that quietly passed an unverifiable answer would be worse than no gate,
 * because the receipt would then claim a check happened.
 */

import { describe, expect, it } from "vitest";
import {
  checkAnswerGrounding,
  collectObservedValues,
  extractFigureDeclarations,
} from "./finance-answer-grounding-gate.js";
import type { CalculationRecord } from "./finance-calculation-ledger.js";
import type {
  FinanceDataGatewaySnapshot,
  FinanceDataProviderRole,
} from "./finance-data-gateway.js";

function snapshotWith(values: Array<string | number>): FinanceDataGatewaySnapshot {
  return {
    instrument: "AAPL",
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

/**
 * The default prose deliberately carries no value-shaped number: the gate now requires every
 * value-shaped number in the prose to be declared, so a fixture that wrote `212.44` while declaring
 * something else was exercising the under-declaration failure instead of its own subject.
 */
function answerWithFigures(
  figures: unknown,
  prose = "Apple traded in the regular session.",
): string {
  return `${prose}\n\n\`\`\`figures\n${JSON.stringify(figures)}\n\`\`\`\n`;
}

describe("extractFigureDeclarations", () => {
  it("parses a declared figures block", () => {
    const parsed = extractFigureDeclarations(
      answerWithFigures([{ kind: "observed", name: "last_price", value: 212.44, unit: "USD" }]),
    );
    expect(parsed).toEqual([{ kind: "observed", name: "last_price", value: 212.44, unit: "USD" }]);
  });

  it("returns undefined for a block whose JSON is broken, so it cannot be mistaken for empty", () => {
    expect(extractFigureDeclarations("text\n```figures\n{not json\n```\n")).toBeUndefined();
  });

  it("returns undefined when a row carries an unknown kind", () => {
    expect(
      extractFigureDeclarations(answerWithFigures([{ kind: "guessed", value: 1 }])),
    ).toBeUndefined();
  });
});

describe("checkAnswerGrounding", () => {
  it("accepts an observed figure that is in the snapshot", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([{ kind: "observed", name: "last_price", value: 212.44 }]),
      snapshot: snapshotWith([212.44]),
    });
    expect(result.verdict).toBe("verified");
    expect(result.grounded).toHaveLength(1);
    expect(result.ungrounded).toHaveLength(0);
  });

  it("flags an observed figure the snapshot never contained", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([{ kind: "observed", name: "last_price", value: 999.01 }]),
      snapshot: snapshotWith([212.44]),
    });
    expect(result.verdict).toBe("ungrounded");
    expect(result.ungrounded).toHaveLength(1);
    expect(result.reasons.join(" ")).toMatch(/999\.01/);
  });

  it("does not report an unverifiable answer as verified", () => {
    const result = checkAnswerGrounding({
      answerText: "Apple last traded near 212.44. No declarations here.",
      snapshot: snapshotWith([212.44]),
    });
    expect(result.verdict).toBe("not_verifiable");
    expect(result.reasons.join(" ")).toMatch(/cannot be checked/);
  });

  it("fails closed when observations are declared but there is no snapshot", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([{ kind: "observed", name: "last_price", value: 212.44 }]),
    });
    expect(result.verdict).toBe("no_snapshot");
    expect(result.ungrounded).toHaveLength(1);
  });

  it("does not require non-observations to appear in the snapshot", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([
        { kind: "observed", name: "last_price", value: 212.44 },
        { kind: "derived", name: "pe_ratio", value: 31.7 },
        { kind: "proposed", name: "target", value: 240 },
      ]),
      snapshot: snapshotWith([212.44]),
    });
    expect(result.verdict).toBe("verified");
    expect(result.ungrounded).toHaveLength(0);
    expect(result.reasons.join(" ")).toMatch(/not observations/);
  });

  it("treats a thousands separator as the same observation", () => {
    // Observed failure mode elsewhere: `1,309.22` split on the comma so `1` was compared instead.
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([{ kind: "observed", name: "last_price", value: "1,309.22" }]),
      snapshot: snapshotWith([1309.22]),
    });
    expect(result.verdict).toBe("verified");
  });

  it("accepts a float that differs only by representation noise", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([{ kind: "observed", value: 212.4400000001 }]),
      snapshot: snapshotWith([212.44]),
    });
    expect(result.verdict).toBe("verified");
  });
});

describe("derived figures", () => {
  const recorded: CalculationRecord = {
    id: "calc-1",
    action: "min_variance",
    inputs: {
      cov: [
        [0.04, 0.012],
        [0.012, 0.09],
      ],
    },
    output: { weights: [0.78, 0.22], volatility: 0.1855 },
    at: "2026-09-20T00:00:00.000Z",
  };

  it("accepts a derived figure that a recorded calculation actually produced", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([{ kind: "derived", name: "portfolio_vol", value: 0.1855 }]),
      calculations: [recorded],
    });
    expect(result.verdict).toBe("verified");
    expect(result.ungrounded).toHaveLength(0);
  });

  it("rejects a derived figure no calculation produced", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([{ kind: "derived", name: "portfolio_vol", value: 0.9999 }]),
      calculations: [recorded],
    });
    expect(result.verdict).toBe("ungrounded");
    expect(result.reasons.join(" ")).toMatch(/does not match any recorded calculation/);
  });

  it("leaves derived figures unverified rather than failing them when no ledger exists", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures([{ kind: "derived", name: "portfolio_vol", value: 0.9999 }]),
    });
    expect(result.verdict).toBe("verified");
    expect(result.reasons.join(" ")).toMatch(/recorded, not verified/);
  });
});

/**
 * Under-declaration.
 *
 * The module contract is that the model declares the kind of *every* figure it used, but only the
 * declarations were checked against the snapshot -- the prose was never cross-checked against them.
 * Measured against a snapshot holding 212.44, each of these was reported as `verified`:
 *
 *   prose "Apple last traded near 999.01." + block declaring 212.44
 *   prose "…212.44, and the market cap is 3.2 trillion." + block declaring only 212.44
 *   a second figures block declaring a fabricated 999.01
 *
 * Under-declaring is the shape a model takes when it wants to write a number it was not given, so it
 * has to fail closed. The last two cases are the over-trigger guards: structural integers, index
 * names, tenor labels and dates must not be demanded a declaration, and neither must a number the
 * reader supplied.
 */
describe("undeclared prose figures", () => {
  const snapshot = snapshotWith([212.44]);

  it("flags a prose value the block never declared", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures(
        [{ kind: "observed", name: "last_price", value: 212.44 }],
        "Apple last traded near 999.01.",
      ),
      snapshot,
    });
    expect(result.verdict).toBe("undeclared_figures");
    expect(result.undeclared.join(" ")).toContain("999.01");
  });

  it("flags the second of two prose values when only one is declared", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures(
        [{ kind: "observed", name: "last_price", value: 212.44 }],
        "Apple last traded near 212.44 and the market cap is 3.2 trillion.",
      ),
      snapshot,
    });
    expect(result.verdict).toBe("undeclared_figures");
  });

  it("fails closed on a second declaration block instead of reading only the first", () => {
    const result = checkAnswerGrounding({
      answerText: `${answerWithFigures([{ kind: "observed", name: "last_price", value: 212.44 }])}\n${answerWithFigures([{ kind: "observed", name: "last_price", value: 999.01 }])}`,
      snapshot,
    });
    expect(result.verdict).toBe("not_verifiable");
    expect(result.reasons.join(" ")).toMatch(/multiple figures declaration blocks/);
  });

  it("reports an ungrounded declaration ahead of an undeclared prose value", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures(
        [{ kind: "observed", name: "last_price", value: 999.01 }],
        "Apple last traded near 999.01.",
      ),
      snapshot,
    });
    expect(result.verdict).toBe("ungrounded");
  });

  it("exempts a number the reader supplied", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures(
        [{ kind: "observed", name: "last_price", value: 212.44 }],
        "You said you are down 20%, and Apple last traded near 212.44.",
      ),
      snapshot,
      askText: "I am down 20% on Apple, what now?",
    });
    expect(result.verdict).toBe("verified");
  });

  it("does not demand a declaration for structure, index names, tenors or dates", () => {
    const result = checkAnswerGrounding({
      answerText: answerWithFigures(
        [{ kind: "observed", name: "last_price", value: 212.44 }],
        "Step 1 of 3, as of 2026-09-19: the S&P 500 and the 10Y yield are context, and the book holds 2 names.",
      ),
      snapshot,
    });
    expect(result.verdict).toBe("verified");
  });
});

describe("collectObservedValues", () => {
  it("normalizes so numeric and string forms of one observation compare equal", () => {
    const values = collectObservedValues(snapshotWith([212.44, "212.44"]));
    expect(values.size).toBe(1);
  });
});
