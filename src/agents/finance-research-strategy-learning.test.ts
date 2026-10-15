import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildFinanceAutomaticLifecycleFeedback } from "./finance-automatic-lifecycle-feedback.js";
import { resolveFinanceIntradayActiveRuleContract } from "./finance-intraday-paper.js";
import { persistFinanceResearchStrategyLearning } from "./finance-research-strategy-learning.js";
import {
  activateImplementedFinanceStrategyRule,
  validateFinanceStrategyImplementation,
} from "./finance-strategy-implementation.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
async function input() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "method-learning-"));
  roots.push(directory);
  return {
    directory,
    eligible: true,
    asOf: "2026-09-10T12:00:00.000Z",
    observedAt: "2026-09-10T12:01:00.000Z",
    receiptReference: "receipt://original/research",
    runId: "quality-original",
    instruments: ["SPY"],
    evidence: [
      {
        id: "finance-model:SPY",
        source: "finance-research-batch-runner",
        timestamp: "2026-09-10T11:50:00.000Z",
        text: "SPY supports a bounded timing hypothesis; costs and expected return remain unknown.",
      },
    ],
    claims: [
      {
        id: "mechanism",
        text: "SPY timing warrants a competing conditional method.",
        status: "supported" as const,
        epistemicClass: "hypothesis" as const,
        basis: "Source-bound hypothesis, not achieved profitability.",
        evidenceIds: ["finance-model:SPY"],
        evidenceRelations: [{ evidenceId: "finance-model:SPY", relation: "supports" as const }],
      },
    ],
    value: [
      {
        claimId: "mechanism",
        form: "intraday_opening_range_breakout",
        formVersion: "2",
        instruments: ["SPY"],
        emits: "paper_signal",
        schedule: { kind: "intraday", timezone: "America/New_York" },
        body: {
          frozenRule: { openingRangeBars: 6, rewardRisk: 2 },
          data: { intervalSeconds: 300, feed: "iex" },
          paperExecutionEligibility: "paper_contract_only",
        },
        invalidationConditions: [
          "The supported timing mechanism is contradicted by current evidence.",
        ],
      },
    ],
  };
}
it("passes an original reviewed method into a durable draft and existing downstream lifecycle", async () => {
  const params = await input();
  const result = await persistFinanceResearchStrategyLearning(params);
  expect(result).toMatchObject({
    status: "persisted",
    executionAuthority: "none",
    results: [{ action: "declared", state: "draft" }],
  });
  const read = await readFinanceStrategyRuleLedger(params.directory);
  const rule = read.ledger.rules[0];
  expect(rule.provenance).toMatchObject({
    origin: "verified_finance_research",
    researchReceiptReference: params.receiptReference,
    evidence: [{ id: "finance-model:SPY", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
  });
  expect(() => resolveFinanceIntradayActiveRuleContract(rule)).toThrow("incompatible contract");
  expect(
    await buildFinanceAutomaticLifecycleFeedback({
      directory: params.directory,
      observedAt: "2026-09-10T12:02:00.000Z",
    }),
  ).toMatchObject({
    methodDevelopment: [
      { ruleId: rule.ruleId, declarationRef: expect.any(String), executionAuthority: "none" },
    ],
  });
  expect(
    (
      await persistFinanceResearchStrategyLearning({
        ...params,
        runId: "later-quality",
        observedAt: "2026-09-10T12:03:00.000Z",
      })
    ).results[0],
  ).toMatchObject({ action: "unchanged", state: "draft" });
  expect((await readFinanceStrategyRuleLedger(params.directory)).recordCount).toBe(1);
});
it("binds a separately activated original implementation under a new method identity", async () => {
  const params = await input();
  const result = await persistFinanceResearchStrategyLearning(params);
  const ruleId = result.results[0].ruleId;
  expect(
    validateFinanceStrategyImplementation(
      (await readFinanceStrategyRuleLedger(params.directory)).ledger.rules[0],
    ),
  ).toMatchObject({ owner: "finance-intraday-paper" });
  await activateImplementedFinanceStrategyRule(params.directory, {
    kind: "activated",
    ruleId,
    reason: "explicit original operator activation after scoped validation",
    observedAt: "2026-09-10T12:02:00.000Z",
  });
  const rule = (await readFinanceStrategyRuleLedger(params.directory)).ledger.rules[0];
  expect(resolveFinanceIntradayActiveRuleContract(rule)).toMatchObject({
    ruleId,
    formVersion: "2",
    preCloseExitEnabled: true,
    openingRangeBars: 6,
    declarationRef: result.results[0].declarationRef,
    activationRef: expect.any(String),
  });
  expect((await persistFinanceResearchStrategyLearning(params)).results[0]).toMatchObject({
    action: "unchanged",
    state: "active",
  });
});
it("retains a novel form without substituting an existing algorithm or granting activation", async () => {
  const params = await input();
  params.value[0].form = "future_composed_mechanism";
  await persistFinanceResearchStrategyLearning(params);
  const rule = (await readFinanceStrategyRuleLedger(params.directory)).ledger.rules[0];
  expect(rule).toMatchObject({ form: "future_composed_mechanism", state: "draft" });
  await expect(
    activateImplementedFinanceStrategyRule(params.directory, {
      kind: "activated",
      ruleId: rule.ruleId,
      observedAt: "2026-09-10T12:02:00.000Z",
    }),
  ).rejects.toThrow("implementation missing");
  expect((await readFinanceStrategyRuleLedger(params.directory)).ledger.activatedRecordCount).toBe(
    0,
  );
  expect(() => validateFinanceStrategyImplementation(rule)).toThrow("implementation missing");
});
it.each(["failed_quality", "foreign", "future", "unsupported_claim"])(
  "refuses unqualified method source %s before any declaration",
  async (mode) => {
    const params = await input();
    if (mode === "failed_quality") {
      params.eligible = false;
    }
    if (mode === "foreign") {
      params.value[0].instruments = ["QQQ"];
    }
    if (mode === "future") {
      params.evidence[0].timestamp = "2026-09-11T12:00:00.000Z";
    }
    if (mode === "unsupported_claim") {
      params.value[0].claimId = "missing";
    }
    if (mode === "failed_quality") {
      expect(await persistFinanceResearchStrategyLearning(params)).toMatchObject({
        status: "not_eligible",
      });
    } else {
      await expect(persistFinanceResearchStrategyLearning(params)).rejects.toThrow();
    }
    expect((await readFinanceStrategyRuleLedger(params.directory)).recordCount).toBe(0);
  },
);

it("rejects conflicting original evidence identities before creating a method", async () => {
  const params = await input();
  params.evidence.push({
    ...params.evidence[0],
    text: "Contradictory bytes under the same original identity",
  });
  await expect(persistFinanceResearchStrategyLearning(params)).rejects.toThrow(
    "ambiguous method source",
  );
  expect((await readFinanceStrategyRuleLedger(params.directory)).recordCount).toBe(0);
});

it("refuses an implemented form with invalid native parameters before activation", async () => {
  const params = await input();
  params.value[0].body.frozenRule.openingRangeBars = 99;
  const learned = await persistFinanceResearchStrategyLearning(params);
  await expect(
    activateImplementedFinanceStrategyRule(params.directory, {
      kind: "activated",
      ruleId: learned.results[0].ruleId,
      observedAt: "2026-09-10T12:02:00.000Z",
    }),
  ).rejects.toThrow("unsupported rule parameter");
  expect((await readFinanceStrategyRuleLedger(params.directory)).ledger.activatedRecordCount).toBe(
    0,
  );
});
