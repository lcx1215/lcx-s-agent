import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { FinanceResearchRunReceipt } from "../../src/agents/finance-research-runner.ts";
import {
  declareFinanceStrategyRule,
  activateFinanceStrategyRule,
} from "../../src/agents/finance-strategy-rule-ledger.ts";
import { buildFinanceThesisDecisionContext } from "../../src/agents/finance-thesis-decision-context.ts";
import { openFinanceThesis } from "../../src/agents/finance-thesis-ledger.ts";

const calls = vi.hoisted(() => ({ checkpoint: vi.fn() }));
vi.mock("../../scripts/operator/lcx-finance-research-checkpoint-run.ts", () => ({
  runCheckpointedFinanceResearch: calls.checkpoint,
}));
vi.mock("../../src/agents/finance-model-workflow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agents/finance-model-workflow.ts")>()),
  createFinanceModelWorkflow: () => ({ routing: {} }),
}));
vi.mock("../../src/config/config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/config.ts")>()),
  loadConfig: () => ({}),
}));

import { parseArgs, run } from "../../scripts/operator/lcx-finance-research-run.ts";

const AS_OF_MS = Date.now() + 30_000;
const AS_OF = new Date(AS_OF_MS).toISOString();
const SWING_VALID_UNTIL = new Date(AS_OF_MS + 30 * 24 * 60 * 60 * 1_000).toISOString();
const LONG_TERM_VALID_UNTIL = new Date(AS_OF_MS + 90 * 24 * 60 * 60 * 1_000).toISOString();

function researchReceipt(options: {
  gatesPassed: boolean;
  runId: string;
  proposalSet: "buy_exit" | "failed_gate";
}) {
  const targets = ["SPY", "AAPL", "MSFT"];
  const evidence = targets.map((instrument) => ({
    id: `finance-model:${instrument}`,
    source: "finance-research-fixture",
    timestamp: AS_OF,
    text: `${instrument} has a source-bound observation for this research window.`,
  }));
  const claims = [
    {
      id: "spy-buy",
      text: "SPY is a conditional long-term buy candidate while earnings breadth holds.",
      status: "supported",
      evidenceIds: ["finance-model:SPY"],
      epistemicClass: "hypothesis",
      basis: "The hypothesis is limited to the cited observation and stated horizon.",
      evidenceRelations: [{ evidenceId: "finance-model:SPY", relation: "supports" }],
    },
    {
      id: "aapl-exit",
      text: "Reduce the existing AAPL holding if cash conversion continues to weaken.",
      status: "supported",
      evidenceIds: ["finance-model:AAPL"],
      epistemicClass: "hypothesis",
      basis: "The exit thesis follows the cited company-specific observation.",
      evidenceRelations: [{ evidenceId: "finance-model:AAPL", relation: "supports" }],
    },
    {
      id: "msft-failed-gate",
      text: "MSFT is a candidate only if the quality gate passes.",
      status: "supported",
      evidenceIds: ["finance-model:MSFT"],
      epistemicClass: "hypothesis",
      basis: "This fixture is withheld when the quality gate fails.",
      evidenceRelations: [{ evidenceId: "finance-model:MSFT", relation: "supports" }],
    },
  ];
  return {
    status: "candidate",
    answerDecision: "candidate_for_review",
    plan: { asOf: AS_OF, targets: targets.map((instrument) => ({ instrument })) },
    batch: { committeeEvidence: evidence },
    quality: {
      status: "verified",
      runId: options.runId,
      quality: { passed: true },
      finalArtifact: {
        answer: "Source-bound research candidates.",
        claims,
        supportingAnalysis: {
          financeThesisProposals:
            options.proposalSet === "failed_gate"
              ? [
                  {
                    claimId: "msft-failed-gate",
                    instrument: "MSFT",
                    applicability: {
                      horizon: "swing",
                      validUntil: SWING_VALID_UNTIL,
                    },
                    invalidationConditions: ["Quality gate passes on a fresh run."],
                  },
                ]
              : [
                  {
                    claimId: "spy-buy",
                    instrument: "SPY",
                    applicability: {
                      horizon: "long_term",
                      validUntil: LONG_TERM_VALID_UNTIL,
                    },
                    invalidationConditions: ["Earnings breadth reverses."],
                  },
                  {
                    claimId: "aapl-exit",
                    instrument: "AAPL",
                    applicability: {
                      horizon: "swing",
                      validUntil: SWING_VALID_UNTIL,
                    },
                    invalidationConditions: ["Cash conversion stabilizes."],
                  },
                ],
        },
      },
    },
    gates: [{ passed: options.gatesPassed }],
  } as unknown as FinanceResearchRunReceipt;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it("persists grounded buy and holding-exit research for Paper context and filters stale or ineligible theses", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-thesis-consumption-"));
  const financeStateDir = path.join(root, "finance-state");
  await fs.mkdir(financeStateDir, { recursive: true });
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", root);
  calls.checkpoint
    .mockResolvedValueOnce(
      researchReceipt({ gatesPassed: true, runId: "eligible-run", proposalSet: "buy_exit" }),
    )
    .mockResolvedValueOnce(
      researchReceipt({ gatesPassed: false, runId: "failed-gate-run", proposalSet: "failed_gate" }),
    );

  try {
    const eligible = await run(
      parseArgs([
        "--live",
        "--workflow-models",
        "--write",
        "--persist-theses",
        "--finance-state-dir",
        financeStateDir,
        "--as-of",
        AS_OF,
      ]),
    );
    expect(eligible.thesisLearning).toMatchObject({ status: "persisted", recordCount: 2 });

    const failedGate = await run(
      parseArgs([
        "--live",
        "--workflow-models",
        "--write",
        "--persist-theses",
        "--finance-state-dir",
        financeStateDir,
        "--as-of",
        new Date(AS_OF_MS + 60_000).toISOString(),
      ]),
    );
    expect(failedGate.thesisLearning).toMatchObject({ status: "not_eligible" });

    await openFinanceThesis(financeStateDir, {
      thesisId: "expired-spy",
      instrument: "SPY",
      claim: "Expired thesis must not reach Paper review.",
      applicability: { horizon: "swing", validUntil: new Date(AS_OF_MS - 60_000).toISOString() },
      evidence: [{ id: "expired-source", source: "fixture", reference: "fixture://expired" }],
      invalidationConditions: ["It is expired."],
      observedAt: new Date(AS_OF_MS - 120_000).toISOString(),
    });
    await openFinanceThesis(financeStateDir, {
      thesisId: "wrong-instrument",
      instrument: "QQQ",
      claim: "A different instrument thesis must not reach this intraday review.",
      applicability: {
        horizon: "intraday",
        validUntil: new Date(AS_OF_MS + 8 * 60 * 60 * 1_000).toISOString(),
      },
      evidence: [{ id: "other-source", source: "fixture", reference: "fixture://other" }],
      invalidationConditions: ["QQQ evidence no longer holds."],
      observedAt: new Date().toISOString(),
    });

    const longTermBuy = await buildFinanceThesisDecisionContext({
      directory: financeStateDir,
      asOf: AS_OF,
      instruments: ["SPY"],
      horizon: "long_term",
    });
    expect(longTermBuy.theses).toHaveLength(1);
    expect(longTermBuy.theses[0]).toMatchObject({
      instrument: "SPY",
      claim: "SPY is a conditional long-term buy candidate while earnings breadth holds.",
      applicability: { horizon: "long_term", validUntil: LONG_TERM_VALID_UNTIL },
      invalidationConditions: ["Earnings breadth reverses."],
      evidence: [
        expect.objectContaining({
          id: "eligible-run:finance-model:SPY",
          relation: "supports",
          reference: expect.stringContaining("finance-research-run.json#evidence="),
        }),
      ],
    });

    const swingExit = await buildFinanceThesisDecisionContext({
      directory: financeStateDir,
      asOf: AS_OF,
      instruments: ["AAPL"],
      horizon: "swing",
    });
    expect(swingExit.theses).toHaveLength(1);
    expect(swingExit.theses[0]).toMatchObject({
      instrument: "AAPL",
      claim: "Reduce the existing AAPL holding if cash conversion continues to weaken.",
      applicability: { horizon: "swing", validUntil: SWING_VALID_UNTIL },
      evidence: [expect.objectContaining({ relation: "supports" })],
    });

    const intraday = await buildFinanceThesisDecisionContext({
      directory: financeStateDir,
      asOf: AS_OF,
      instruments: ["SPY"],
      horizon: "intraday",
    });
    expect(intraday.theses).toEqual([]);
    expect(intraday.theses.map((thesis) => thesis.instrument)).not.toContain("QQQ");

    const daily = await buildFinanceThesisDecisionContext({
      directory: financeStateDir,
      asOf: new Date(AS_OF_MS + 120_000).toISOString(),
      instruments: ["SPY", "AAPL", "MSFT"],
    });
    expect(daily.theses.map((thesis) => thesis.claim)).not.toContain(
      "Expired thesis must not reach Paper review.",
    );
    expect(daily.theses.map((thesis) => thesis.instrument)).not.toContain("MSFT");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("stores independently verified theses on portfolio abstention without emitting an execution plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-abstention-consumption-"));
  const financeStateDir = path.join(root, "finance-state");
  const planPath = path.join(root, "old-portfolio-plan.json");
  await fs.mkdir(financeStateDir, { recursive: true });
  await fs.writeFile(planPath, "old-plan");
  const contextPath = path.join(root, "portfolio-context.json");
  await fs.writeFile(
    contextPath,
    JSON.stringify({
      accountId: "paper-account",
      venue: "alpaca",
      validityMinutes: 60,
      conflictPolicy: "block",
      activeStrategyIds: ["trend"],
    }),
  );
  await declareFinanceStrategyRule(financeStateDir, {
    kind: "declared",
    ruleId: "trend",
    form: "trend",
    instruments: ["SPY"],
    emits: "weights",
    schedule: { kind: "monthly" },
    body: { test: true },
    observedAt: new Date(AS_OF_MS - 60_000).toISOString(),
  });
  await activateFinanceStrategyRule(financeStateDir, {
    kind: "activated",
    ruleId: "trend",
    reason: "isolated test",
    observedAt: new Date(AS_OF_MS - 30_000).toISOString(),
  });
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", root);
  calls.checkpoint.mockResolvedValueOnce({
    ...researchReceipt({ gatesPassed: true, runId: "abstention-run", proposalSet: "buy_exit" }),
    portfolioAbstention: {
      reason: "No active strategy has a validated positive budget.",
      evidenceIds: ["finance-model:SPY"],
    },
  });
  try {
    const result = await run(
      parseArgs([
        "--live",
        "--workflow-models",
        "--write",
        "--persist-theses",
        "--finance-state-dir",
        financeStateDir,
        "--as-of",
        AS_OF,
        "--decision-mode",
        "strategy_candidate",
        "--portfolio-context",
        contextPath,
        "--portfolio-plan-out",
        planPath,
      ]),
    );
    expect(result.receipt.portfolioAbstention).toBeDefined();
    expect(result.portfolioPlanWritten).toBeUndefined();
    expect(result.thesisLearning).toMatchObject({ status: "persisted", recordCount: 2 });
    expect(await fs.readFile(planPath, "utf8")).toBe("old-plan");
    const consumer = await buildFinanceThesisDecisionContext({
      directory: financeStateDir,
      asOf: AS_OF,
      instruments: ["SPY"],
      horizon: "long_term",
    });
    expect(consumer.theses).toHaveLength(1);
    expect(consumer.theses[0].instrument).toBe("SPY");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
