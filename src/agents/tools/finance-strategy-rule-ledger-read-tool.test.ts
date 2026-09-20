import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appendFinancePositionMark } from "../finance-position-ledger.js";
import { financeReadinessThresholdsPath } from "../finance-state-dir.js";
import { declareFinanceStrategyRule } from "../finance-strategy-rule-ledger.js";
import { createFinanceStrategyRuleLedgerReadTool } from "./finance-strategy-rule-ledger-read-tool.js";

const directories: string[] = [];

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-rule-tool-"));
  directories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const PAST = "2026-09-17T00:00:00Z";

/**
 * A fixed instant inside the seeded window. Readiness is a replay over recorded marks, so
 * letting it default to wall-clock time would make the assertions depend on the day they run.
 */
const AS_OF = "2026-09-19T12:00:00Z";

async function read(
  params: Record<string, unknown>,
): Promise<Record<string, unknown> & { rules?: Array<Record<string, unknown>> }> {
  const result = await createFinanceStrategyRuleLedgerReadTool().execute("call", params);
  return result.details as Record<string, unknown> & {
    rules?: Array<Record<string, unknown>>;
  };
}

describe("finance_strategy_rule_ledger_read", () => {
  it("names an absent book instead of reporting zero rules", async () => {
    const directory = await storeDirectory();
    const payload = await read({ directory });
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("finance_strategy_rule_ledger_absent");
    expect(payload.action).toContain("not evidence that no rule is intended");
  });

  it("reports a declared rule as draft, not as authorised", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "daily-momentum",
      form: "expression",
      instruments: ["AAA"],
      emits: "target_weights",
      schedule: { kind: "daily", at: "21:30" },
      body: { expression: "close > sma(close,20)" },
      observedAt: PAST,
    });
    const payload = await read({ directory });
    expect(payload.ok).toBe(true);
    expect(payload.ruleCount).toBe(1);
    expect(payload.draftRuleCount).toBe(1);
    expect(payload.activeRuleCount).toBe(0);
    expect(payload.rules?.[0]?.state).toBe("draft");
  });

  it("withholds bodies by default and returns them on request", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "r1",
      form: "python",
      instruments: ["AAA"],
      emits: "signal",
      schedule: { kind: "daily" },
      body: { entrypoint: "rules.mr:signal", params: { window: 20 } },
      observedAt: PAST,
    });
    const summary = await read({ directory });
    expect(summary.rules?.[0]?.body).toBeUndefined();
    expect(summary.rules?.[0]?.bodyKeyCount).toBe(2);

    const full = await read({ directory, includeBodies: true });
    expect(full.rules?.[0]?.body).toEqual({
      entrypoint: "rules.mr:signal",
      params: { window: 20 },
    });
  });

  it("names an unknown rule id and lists the known ones", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "known-rule",
      form: "manual",
      instruments: ["AAA"],
      emits: "orders",
      schedule: { kind: "manual" },
      body: { steps: ["a"] },
      observedAt: PAST,
    });
    const payload = await read({ directory, ruleId: "nope" });
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("finance_strategy_rule_ledger_rule_id_unknown");
    expect(payload.knownRuleIds).toEqual(["known-rule"]);
  });

  it("states that no record in the book confers execution authority", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "r1",
      form: "manual",
      instruments: ["AAA"],
      emits: "orders",
      schedule: { kind: "manual" },
      body: { steps: ["a"] },
      observedAt: PAST,
    });
    const payload = await read({ directory });
    expect(payload.authorityNote).toContain("executionAuthority 'none'");
    expect(payload.notTouched).toContain("no order is placed");
  });

  it("omits readiness unless it is asked for", async () => {
    const directory = await storeDirectory();
    await declareRule(directory);
    const payload = await read({ directory });
    expect(payload.readiness).toBeUndefined();
  });

  it("reports measured adversity but no verdict when thresholds are undeclared", async () => {
    const directory = await storeDirectory();
    await declareRule(directory);
    await seedMarks(directory);

    const payload = await read({ directory, includeReadiness: true, asOf: AS_OF });
    expect(payload.ok).toBe(true);
    const readiness = payload.readiness as Record<string, unknown>;
    expect(readiness.thresholdsDeclared).toBe(false);
    const entry = (readiness.rules as Array<Record<string, unknown>>)[0];
    // An undeclared threshold makes the condition unjudgeable, which is never "it passed".
    expect(entry.ready).toBeNull();
    expect(entry.readyUnavailableReason).toContain("minPaperDays was not declared");
    expect(entry.covered).toEqual([]);
  });

  it("returns a verdict once the owner declares thresholds and the rule has lived through them", async () => {
    const directory = await storeDirectory();
    await declareRule(directory);
    await seedMarks(directory);
    await fs.writeFile(
      financeReadinessThresholdsPath(directory),
      JSON.stringify({
        minPaperDays: 2,
        minObservations: 3,
        reversalDrawdownPercent: 10,
        chopMinFlips: 2,
        gapMovePercent: 3,
      }),
    );

    const payload = await read({ directory, includeReadiness: true, asOf: AS_OF });
    const readiness = payload.readiness as Record<string, unknown>;
    expect(readiness.thresholdsDeclared).toBe(true);
    expect(readiness.thresholdsError).toBeNull();
    expect(readiness.markCount).toBe(ADVERSE_MARKS.length);

    const entry = (readiness.rules as Array<Record<string, unknown>>)[0];
    expect(entry.observationCount).toBe(ADVERSE_MARKS.length);
    expect(entry.durationMet).toBe(true);
    expect(entry.covered).toEqual(["chop", "reversal", "gap"]);
    expect(entry.uncovered).toEqual([]);
    expect(entry.ready).toBe(true);
    expect(readiness.advice).toBe(false);
  });

  it("still answers the question when the readiness declaration is unreadable", async () => {
    const directory = await storeDirectory();
    await declareRule(directory);
    await fs.writeFile(financeReadinessThresholdsPath(directory), "{ not json");

    const payload = await read({ directory, includeReadiness: true, asOf: AS_OF });
    // The rules are the answer that was asked for; a broken sidecar must not lose them.
    expect(payload.ok).toBe(true);
    expect(payload.ruleCount).toBe(1);
    const readiness = payload.readiness as Record<string, unknown>;
    expect(readiness.thresholdsDeclared).toBe(false);
    expect(readiness.thresholdsError).toContain("is not valid JSON");
  });
});

/** A window that has seen a jump, several direction changes, and a deep peak-to-trough fall. */
const ADVERSE_MARKS: ReadonlyArray<readonly [number, string]> = [
  [100, "2026-09-17T01:00:00Z"],
  [104, "2026-09-17T02:00:00Z"],
  [98, "2026-09-17T03:00:00Z"],
  [101, "2026-09-17T04:00:00Z"],
  [96, "2026-09-18T00:00:00Z"],
  [80, "2026-09-18T01:00:00Z"],
  [88, "2026-09-18T02:00:00Z"],
  [92, "2026-09-19T00:00:00Z"],
];

async function declareRule(directory: string): Promise<void> {
  await declareFinanceStrategyRule(directory, {
    kind: "declared",
    ruleId: "daily-momentum",
    form: "expression",
    instruments: ["AAA"],
    emits: "target_weights",
    schedule: { kind: "daily", at: "21:30" },
    body: { expression: "close > sma(close,20)" },
    observedAt: PAST,
  });
}

async function seedMarks(directory: string): Promise<void> {
  for (const [price, at] of ADVERSE_MARKS) {
    await appendFinancePositionMark(directory, { instrument: "AAA", price, at });
  }
}
