import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { buildFinanceNightReviewEvidence } from "./finance-night-review-context.js";

describe("finance night review context", () => {
  it("projects settlement and durable intraday refusals into bounded evidence", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-night-context-"));
    try {
      const decision = await appendFinanceIntradayDecision(directory, {
        signalId: "signal-1",
        instrument: "SPY",
        sessionDate: "2026-09-22",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-22T15:00:00.000Z",
        stopPrice: 495,
        targetPrice: 510,
        datasetHeadRef: "a".repeat(64),
        strategyRule: "opening_range_breakout_long_next_bar_v1",
      });
      await appendFinanceIntradayOutcome(directory, {
        signalId: decision.record.input.signalId,
        status: "refused",
        reasons: ["risk_gate_blocked"],
      });
      const evidence = await buildFinanceNightReviewEvidence({
        directory,
        asOf: "2026-09-22T22:00:00.000Z",
        etDate: "2026-09-22",
        settlement: {
          scoredFiled: { appended: 1, skipped: 0 },
          reflection: { lesson: "retain uncertainty" },
          pending: [],
          declined: [],
          issues: [],
        },
      });
      expect(evidence.map((item) => item.source)).toEqual([
        "finance-night-settlement",
        "finance-position-ledger",
        "finance-strategy-rule-ledger",
        "finance-intraday-control-ledger",
      ]);
      expect(evidence[3].text).toContain("risk_gate_blocked");
      expect(evidence[0].text).toContain('"appended":1');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
