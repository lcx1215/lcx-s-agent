import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  FINANCE_STRATEGY_RULE_STATES,
  readFinanceStrategyRuleLedger,
  retireFinanceStrategyRule,
  type FinanceStrategyRule,
} from "./finance-strategy-rule-ledger.js";

const directories: string[] = [];

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-rule-"));
  directories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

/** Safely in the past, so the ledger's future-observation guard is never what a test measures. */
const PAST = "2026-09-17T00:00:00Z";

function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "declared",
    ruleId: "daily-momentum",
    form: "expression",
    instruments: ["AAA", "BBB"],
    emits: "target_weights",
    schedule: { kind: "daily", at: "21:30", timezone: "America/New_York" },
    body: { expression: "close > sma(close, 20)" },
    observedAt: PAST,
    ...overrides,
  };
}

function onlyRule(rules: readonly FinanceStrategyRule[]): FinanceStrategyRule {
  const rule = rules[0];
  if (rule === undefined) {
    throw new Error("expected exactly one rule");
  }
  return rule;
}

describe("finance-strategy-rule-ledger", () => {
  it("starts empty and names the absence instead of returning a zeroed rule", async () => {
    const directory = await storeDirectory();
    const read = await readFinanceStrategyRuleLedger(directory);
    expect(read.databasePresent).toBe(false);
    expect(read.recordCount).toBe(0);
    expect(read.ledger.rules).toEqual([]);
  });

  it("declares a rule into draft, not into active", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration());
    const read = await readFinanceStrategyRuleLedger(directory);
    const rule = onlyRule(read.ledger.rules);
    expect(rule.state).toBe("draft");
    expect(rule.activatedAt).toBeNull();
    expect(rule.retiredAt).toBeNull();
    // The whole point: writing a rule down must never arm it.
    expect(rule.state).not.toBe("active");
  });

  it("requires an explicit activation before a rule is active", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration());
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "daily-momentum",
      reason: "paper run reviewed",
      observedAt: "2026-09-17T06:00:00Z",
    });
    const read = await readFinanceStrategyRuleLedger(directory);
    const rule = onlyRule(read.ledger.rules);
    expect(rule.state).toBe("active");
    expect(rule.activatedAt).not.toBeNull();
  });

  it("retires as a terminal state with no way back", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration());
    await retireFinanceStrategyRule(directory, {
      kind: "retired",
      ruleId: "daily-momentum",
      observedAt: "2026-09-17T06:00:00Z",
    });
    const read = await readFinanceStrategyRuleLedger(directory);
    const rule = onlyRule(read.ledger.rules);
    expect(rule.state).toBe("retired");
    expect(rule.retiredAt).not.toBeNull();

    await expect(
      activateFinanceStrategyRule(directory, {
        kind: "activated",
        ruleId: "daily-momentum",
        observedAt: "2026-09-17T07:00:00Z",
      }),
    ).rejects.toThrow(/already retired|is history/);

    await expect(
      retireFinanceStrategyRule(directory, {
        kind: "retired",
        ruleId: "daily-momentum",
        observedAt: "2026-09-17T08:00:00Z",
      }),
    ).rejects.toThrow(/already retired/);
  });

  it("refuses a lifecycle event for a rule that was never declared", async () => {
    const directory = await storeDirectory();
    await expect(
      activateFinanceStrategyRule(directory, {
        kind: "activated",
        ruleId: "never-declared",
        observedAt: PAST,
      }),
    ).rejects.toThrow(/no declaration record/);
    await expect(
      retireFinanceStrategyRule(directory, {
        kind: "retired",
        ruleId: "never-declared",
        observedAt: PAST,
      }),
    ).rejects.toThrow(/no declaration record/);
  });

  it("refuses a second declaration of the same id, and a second activation", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration());
    await expect(
      declareFinanceStrategyRule(directory, declaration({ form: "python" })),
    ).rejects.toThrow(/already declared/);

    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "daily-momentum",
      observedAt: "2026-09-17T06:00:00Z",
    });
    await expect(
      activateFinanceStrategyRule(directory, {
        kind: "activated",
        ruleId: "daily-momentum",
        observedAt: "2026-09-17T07:00:00Z",
      }),
    ).rejects.toThrow(/already active/);
  });

  it("is idempotent: replaying the identical declaration does not append", async () => {
    const directory = await storeDirectory();
    const first = await declareFinanceStrategyRule(directory, declaration());
    expect(first.appended).toBe(true);
    const second = await declareFinanceStrategyRule(directory, declaration());
    expect(second.appended).toBe(false);
    const read = await readFinanceStrategyRuleLedger(directory);
    expect(read.recordCount).toBe(1);
  });

  it("refuses the same id re-declared with different content", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration());
    await expect(
      declareFinanceStrategyRule(directory, declaration({ form: "pine" })),
    ).rejects.toThrow(/already declared/);
  });

  describe("form agnosticism (the compatibility requirement)", () => {
    it("accepts arbitrary forms with opaque bodies, without knowing any of them", async () => {
      const directory = await storeDirectory();
      const forms = [
        {
          ruleId: "pine-breakout",
          form: "pine",
          body: { script: "//@version=5\nstrategy(...)", symbol: "AAA" },
          emits: "orders",
        },
        {
          ruleId: "py-mean-reversion",
          form: "python",
          formVersion: "2",
          body: { entrypoint: "rules.mr:signal", params: { window: 20, z: 2 } },
          emits: "signal",
        },
        {
          ruleId: "webhook-signal",
          form: "external_webhook_signal",
          body: { url: "https://example.invalid/hook", secretRef: "env:HOOK_SECRET" },
          emits: "target_weights",
        },
        {
          ruleId: "hand-checklist",
          form: "manual_checklist",
          body: { steps: ["check trend", "size 2%", "place limit"] },
          emits: "orders",
        },
      ];
      for (const item of forms) {
        await declareFinanceStrategyRule(
          directory,
          declaration({
            ruleId: item.ruleId,
            form: item.form,
            formVersion: item.form === "python" ? "2" : undefined,
            body: item.body,
            emits: item.emits,
          }),
        );
      }
      const read = await readFinanceStrategyRuleLedger(directory);
      expect(read.ledger.rules).toHaveLength(4);
      const byId = new Map(read.ledger.rules.map((rule) => [rule.ruleId, rule]));
      // Each body survived intact and untouched — the ledger never looked inside.
      expect(byId.get("pine-breakout")?.body).toEqual({
        script: "//@version=5\nstrategy(...)",
        symbol: "AAA",
      });
      expect(byId.get("py-mean-reversion")?.body).toEqual({
        entrypoint: "rules.mr:signal",
        params: { window: 20, z: 2 },
      });
      expect(byId.get("webhook-signal")?.form).toBe("external_webhook_signal");
      expect(byId.get("py-mean-reversion")?.formVersion).toBe("2");
      expect(byId.get("hand-checklist")?.form).toBe("manual_checklist");
    });

    it("carries provenance so an imported idea keeps its origin", async () => {
      const directory = await storeDirectory();
      await declareFinanceStrategyRule(
        directory,
        declaration({
          provenance: {
            origin: "https://github.com/example/quant",
            revision: "abc123",
            license: "MIT",
            readScope: "public repository, read-only",
          },
        }),
      );
      const read = await readFinanceStrategyRuleLedger(directory);
      const provenance = onlyRule(read.ledger.rules).provenance;
      expect(provenance?.origin).toBe("https://github.com/example/quant");
      expect(provenance?.license).toBe("MIT");
    });

    it("keeps unknown schedule keys rather than stripping them", async () => {
      const directory = await storeDirectory();
      await declareFinanceStrategyRule(
        directory,
        declaration({ schedule: { kind: "weekly", weekday: "MO", at: "09:30" } }),
      );
      const read = await readFinanceStrategyRuleLedger(directory);
      expect(onlyRule(read.ledger.rules).schedule).toMatchObject({ kind: "weekly", weekday: "MO" });
    });
  });

  it("rejects an empty body: a name with no payload is not a rule", async () => {
    const directory = await storeDirectory();
    await expect(
      declareFinanceStrategyRule(directory, declaration({ body: {} })),
    ).rejects.toThrow();
    await expect(
      declareFinanceStrategyRule(directory, declaration({ body: "not an object" })),
    ).rejects.toThrow();
    await expect(
      declareFinanceStrategyRule(directory, declaration({ body: [] })),
    ).rejects.toThrow();
  });

  it("allows an empty instrument list to be declared, following the fail-closed allowlist idiom", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration({ instruments: [] }));
    const read = await readFinanceStrategyRuleLedger(directory);
    // Declared, because a draft is not an authorisation; the empty list still admits nothing
    // whenever anything tries to scope against it.
    expect(onlyRule(read.ledger.rules).instruments).toEqual([]);
  });

  it("replays state as of an earlier instant", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration());
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "daily-momentum",
      observedAt: "2026-09-17T06:00:00Z",
    });
    const later = await readFinanceStrategyRuleLedger(directory);
    expect(onlyRule(later.ledger.rules).state).toBe("active");

    const earlier = await readFinanceStrategyRuleLedger(directory, {
      asOf: "2026-09-17T03:00:00Z",
    });
    expect(onlyRule(earlier.ledger.rules).state).toBe("draft");
  });

  it("includes the activation instant in the as-of window (at-or-before, not before)", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration());
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "daily-momentum",
      observedAt: "2026-09-17T06:00:00Z",
    });
    const atBoundary = await readFinanceStrategyRuleLedger(directory, {
      asOf: "2026-09-17T06:00:00Z",
    });
    expect(onlyRule(atBoundary.ledger.rules).state).toBe("active");
  });

  it("confers no execution authority on any record", async () => {
    const directory = await storeDirectory();
    await declareFinanceStrategyRule(directory, declaration());
    const read = await readFinanceStrategyRuleLedger(directory);
    for (const transition of onlyRule(read.ledger.rules).transitions) {
      expect(transition.executionAuthority).toBe("none");
    }
  });

  it("projects deterministically and keeps declaration order stable", async () => {
    const directory = await storeDirectory();
    for (const ruleId of ["a-rule", "b-rule", "c-rule"]) {
      await declareFinanceStrategyRule(directory, declaration({ ruleId }));
    }
    const first = await readFinanceStrategyRuleLedger(directory);
    const second = await readFinanceStrategyRuleLedger(directory);
    expect(second.ledger.rules.map((rule) => rule.ruleId)).toEqual(
      first.ledger.rules.map((rule) => rule.ruleId),
    );
    expect(first.ledger.rules.map((rule) => rule.ruleId)).toEqual(["a-rule", "b-rule", "c-rule"]);
  });

  it("exposes the state vocabulary it can produce", () => {
    expect([...FINANCE_STRATEGY_RULE_STATES]).toEqual(["draft", "active", "retired"]);
  });
});
