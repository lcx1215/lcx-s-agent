import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendFinanceBars } from "./finance-bar-ledger.js";
import {
  financeRuleReadinessSection,
  readFinanceRuleReadinessState,
} from "./finance-rule-readiness-state.js";
import type { FinanceStrategyRule } from "./finance-strategy-rule-ledger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-readiness-state-"));
  directories.push(directory);
  return directory;
}

function bar(date: string, open: number, high: number, low: number, close: number) {
  return { date, open, high, low, close, volume: 1000 };
}

const rule: FinanceStrategyRule = {
  ruleId: "source-conflict",
  state: "active",
  form: "cross_asset_trend",
  formVersion: "1",
  displayName: null,
  instruments: ["AAPL"],
  emits: "target_weights",
  schedule: { kind: "monthly" },
  body: {},
  provenance: null,
  declaredAt: "2026-08-01T00:00:00.000Z",
  activatedAt: "2026-08-01T00:00:00.000Z",
  retiredAt: null,
  startObservedAt: "2026-08-01T00:00:00.000Z",
  activeObservedAt: "2026-08-01T00:00:00.000Z",
  transitions: [],
};

describe("finance rule readiness state with source conflicts", () => {
  it("removes conflicting dates from measures and reports a readiness block", async () => {
    const directory = await storeDirectory();
    await appendFinanceBars(directory, {
      instrument: "AAPL",
      derivation: "ohlcv",
      provenance: { origin: "source-a", sourceUrlOrArtifact: "fixture://source-a" },
      observedAt: "2026-08-07T20:00:00.000Z",
      bars: [
        bar("2026-08-05", 100, 105, 95, 100),
        bar("2026-08-06", 100, 104, 99, 102),
        bar("2026-08-07", 102, 106, 101, 104),
      ],
    });
    await appendFinanceBars(directory, {
      instrument: "AAPL",
      derivation: "ohlcv",
      provenance: { origin: "source-b", sourceUrlOrArtifact: "fixture://source-b" },
      observedAt: "2026-08-07T20:00:00.000Z",
      bars: [bar("2026-08-06", 80, 82, 79, 80)],
    });

    const state = await readFinanceRuleReadinessState({
      directory,
      asOf: "2026-09-20T00:00:00.000Z",
      rules: [rule],
    });

    expect(state.readiness.barCount).toBe(2);
    expect(state.readiness.barConflicts).toEqual([{ instrument: "AAPL", at: "2026-08-06" }]);
    expect(state.readiness.rules[0]?.observationCount).toBe(2);
    expect(state.readiness.rules[0]?.ready).toBeNull();
    expect(state.readiness.rules[0]?.readyUnavailableReason).toMatch(/source disagreement/);
    expect(financeRuleReadinessSection(state)).toMatchObject({
      readiness: {
        barConflicts: [{ instrument: "AAPL", at: "2026-08-06" }],
        rules: [
          {
            ruleId: "source-conflict",
            barConflicts: [{ instrument: "AAPL", at: "2026-08-06" }],
            ready: null,
          },
        ],
      },
    });
  });
});
