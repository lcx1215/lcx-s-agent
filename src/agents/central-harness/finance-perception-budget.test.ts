import { expect, it } from "vitest";
import {
  boundPerception,
  projectFinancePerceptionEvidence,
  runCentralHarnessCycle,
} from "./harness-loop.js";
import { buildCentralBrainPrompt } from "./model-brain.js";
it("retains a multilingual strategy doubt and recheck condition through the existing shared budget", () => {
  const observedAt = "2026-10-10T05:00:00Z";
  const finance = {
    status: "present",
    observedAt,
    nextTask: "inspect_finance_strategy_applicability",
    intradayExecution: {
      status: "present",
      candidates: 2,
      placed: 1,
      refused: 1,
      uncertain: 0,
      missingOutcome: 0,
      needsExecutionInspection: false,
      strategyReassessments: [
        {
          signalId: "prior",
          accountId: "paper-account",
          instrument: "SPY",
          ruleId: "orb-v1",
          observedAt,
          reassessment: {
            reason: "价差超过当前候选的目标距离，突破机制没有支持。".repeat(8),
            recheckWhen: "对比新报价价差与目标距离。",
            alternativeHypothesis: "通过原研究入口检查区间回归假设。",
          },
        },
      ],
    },
    history: "x".repeat(13000),
  };
  const bounded = boundPerception({
    observedAt,
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: { financeAutomaticLifecycle: finance },
  });
  const projected = bounded.perception.controlRoom.financeAutomaticLifecycle as {
    intradayExecution: {
      strategyReassessments: { reassessment: { reason: string; recheckWhen: string } }[];
    };
    budgetProjection: { omittedFieldCount: number };
  };
  const doubt = projected.intradayExecution.strategyReassessments[0];
  expect(doubt.reassessment.reason).toContain("价差超过当前候选");
  expect(doubt.reassessment.reason).toMatch(/…$/u);
  expect(doubt.reassessment.reason).not.toContain("\uFFFD");
  expect(doubt.reassessment.recheckWhen).toBe("对比新报价价差与目标距离。");
  expect(projected.budgetProjection.omittedFieldCount).toBeGreaterThan(0);
  expect(buildCentralBrainPrompt(bounded.perception)).toContain("区间回归假设");
  expect(bounded.report.overBudget).toBe(false);
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(bounded.report.budgetBytes);
});
it.each([false, true])(
  "retains broker recovery failure beside a strategy doubt in the original crowded finance projection (long=%s)",
  (long) => {
    const observedAt = "2026-10-10T05:00:00Z";
    const finance = {
      schemaVersion: "lcx_finance_automatic_lifecycle_feedback_v2",
      status: "present",
      observedAt,
      nextTask: "inspect_finance_position_management",
      scheduler: {
        runtime: {
          status: "responsive",
          phase: "idle",
          pidPresent: true,
          placementEnabled: true,
          venue: "alpaca",
          executionPolicyStatus: "until_revoked",
          executionPolicyAuthorizationMode: "until_revoked",
          executionPolicyExpiresAt: null,
          accountWork: {
            status: "idle",
            observedAt,
            activeWork: null,
            queuedWork: 0,
            reconciliationPending: false,
          },
          reconciliation: {
            status: "present",
            observedAt,
            lastAttemptAt: observedAt,
            lastReadbackAt: null,
            lastSucceededAt: null,
            lastReadinessStatus: "unavailable",
            lastErrorCode: "execution_recovery_incomplete",
            needsInspection: true,
          },
        },
      },
      intradayExecution: {
        status: "present",
        scope: "latest_100_recorded_signals",
        newestSignalAt: observedAt,
        candidates: 100,
        placed: 0,
        refused: 100,
        uncertain: 0,
        missingOutcome: 0,
        needsExecutionInspection: true,
        topReasons: [
          { reason: "account_execution_safety_claim_pending_before_model_review", count: 100 },
        ],
        strategyReassessments: [
          {
            signalId: "isolated-prior-signal",
            accountId: "paper-account",
            instrument: "SPY",
            ruleId: "orb-rule",
            observedAt,
            reassessment: {
              reason: long
                ? "具体机制疑点需要按原取证入口复查。".repeat(12)
                : "Concrete mechanism contradiction.",
              recheckWhen: long ? "Recheck current spread. ".repeat(8) : "Recheck current spread.",
              alternativeHypothesis: long
                ? "替代假设仍需原研究和激活门控。".repeat(12)
                : "Existing research owner only.",
            },
          },
        ],
      },
      positionManagement: {
        status: "present",
        needsInspection: true,
        omittedAccounts: 0,
        accounts: [
          {
            accountId: "paper-account",
            venue: "alpaca:paper",
            snapshotRef: "a".repeat(64),
            observedAt,
            freshness: "fresh",
            uncoveredCount: 2,
            outsideActiveRuleCount: 8,
            unresolvedOrderCount: 1,
            needsInspection: true,
            holdings: [
              {
                instrument: "TLT",
                status: "no_recognized_stop",
                positionQuantity: 130,
                uncoveredQuantity: 130,
              },
            ],
          },
        ],
      },
      economicFeedback: {
        status: "present",
        asOf: observedAt,
        omittedAccounts: 0,
        accounts: [
          {
            accountId: "paper-account",
            venue: "alpaca:paper",
            snapshotRef: "a".repeat(64),
            status: "net_profit_unverified",
            netMatchedPnl: null,
            costScope: "broker_reported_activities_only_excludes_tax_fx_and_external_costs",
            basis: "broker_fill_fifo_usd_not_strategy_attribution",
            issues: ["fees_not_allocated_to_closed_lots"],
          },
        ],
      },
      history: "x".repeat(13000),
    };
    const bounded = boundPerception({
      observedAt,
      ownerTotals: {},
      backlog: [],
      boundaries: [],
      controlRoom: { financeAutomaticLifecycle: finance },
    });
    const prompt = buildCentralBrainPrompt(bounded.perception);
    expect(prompt).toContain("execution_recovery_incomplete");
    expect(prompt).toContain("isolated-prior-signal");
    expect(prompt).toContain("Recheck current spread.");
    expect(prompt).toContain("account_execution_safety_claim_pending_before_model_review");
    expect(bounded.report.overBudget).toBe(false);
    expect(bounded.report.injectedBytes).toBeLessThanOrEqual(12000);
    expect(boundPerception(bounded.perception).perception).toEqual(bounded.perception);
  },
);

it("retains finance execution coverage above the former 3KB cap within the total budget", () => {
  const financeAutomaticLifecycle = {
    scheduler: { history: "x".repeat(3200) },
    intradayExecution: { candidates: 43, placed: 0, refused: 43 },
    nextTask: "inspect_unexecuted_finance_candidates",
  };
  const bounded = boundPerception({
    observedAt: "2026-09-27T00:00:00Z",
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: { financeAutomaticLifecycle },
  });
  expect(projectFinancePerceptionEvidence(bounded)).toEqual({
    status: "present",
    summary: financeAutomaticLifecycle,
  });
  expect(bounded.report.overBudget).toBe(false);
});
it("still reports omission when a finance snapshot exceeds its bounded allowance", () => {
  const bounded = boundPerception({
    observedAt: "2026-09-27T00:00:00Z",
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: { financeAutomaticLifecycle: { history: "x".repeat(13000) } },
  });
  expect(projectFinancePerceptionEvidence(bounded)).toMatchObject({ status: "omitted_by_budget" });
});

it("keeps whole finance above 6144 bytes while reserving small governance and freshness projections", () => {
  const finance = { status: "present", history: "x".repeat(6700), nextTask: "inspect_positions" };
  const controlRoom = {
    financeAutomaticLifecycle: finance,
    governanceDigest: { nextAction: "inspect_failure" },
    runtimeFreshness: { status: "source_age_only" },
    learningWorkflow: { status: "blocked" },
    genericOversize: "x".repeat(2049),
  };
  const original = {
    observedAt: "2026-10-03T00:00:00Z",
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom,
  };
  const bounded = boundPerception(original);
  expect(bounded.perception.controlRoom.financeAutomaticLifecycle).toEqual(finance);
  expect(bounded.perception.controlRoom.governanceDigest).toEqual(controlRoom.governanceDigest);
  expect(bounded.perception.controlRoom.runtimeFreshness).toEqual(controlRoom.runtimeFreshness);
  expect(bounded.perception.controlRoom.learningWorkflow).toEqual(controlRoom.learningWorkflow);
  expect(bounded.perception.controlRoom.genericOversize).toBeUndefined();
  expect(bounded.report.injectedBytes).toBe(Buffer.byteLength(JSON.stringify(bounded.perception)));
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(12000);
  expect(boundPerception(bounded.perception).perception).toEqual(bounded.perception);
});

it("measures enclosing controlRoom costs and Unicode exactly at the budget boundary", () => {
  const original = {
    observedAt: "now",
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: { financeAutomaticLifecycle: { text: "中".repeat(2100) } },
  };
  const bytes = Buffer.byteLength(JSON.stringify(original));
  expect(boundPerception(original, bytes).perception).toEqual(original);
  const insufficient = boundPerception(original, bytes - 1);
  expect(projectFinancePerceptionEvidence(insufficient).status).toBe("omitted_by_budget");
  expect(insufficient.report.injectedBytes).toBeLessThanOrEqual(bytes - 1);
  const heavy = boundPerception({
    ...original,
    backlog: [
      {
        atMs: 0,
        approved: [],
        blocked: [],
        notOk: [],
        nextAction: "continue",
        outcomes: [],
        note: "x".repeat(12000),
      },
    ],
  });
  expect(heavy.report.overBudget).toBe(true);
  expect(projectFinancePerceptionEvidence(heavy).status).toBe("omitted_by_budget");
});

it("does not let a large finance value displace small decision projections", () => {
  const bounded = boundPerception({
    observedAt: "now",
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: {
      financeAutomaticLifecycle: { history: "x".repeat(10500) },
      governanceDigest: { blocked: "x".repeat(1800) },
      runtimeFreshness: { ageMs: 1000 },
      learningWorkflow: { status: "needs_review" },
    },
  });
  expect(bounded.perception.controlRoom.governanceDigest).toBeDefined();
  expect(bounded.perception.controlRoom.runtimeFreshness).toBeDefined();
  expect(bounded.perception.controlRoom.learningWorkflow).toBeDefined();
  expect(projectFinancePerceptionEvidence(bounded).status).toBe("omitted_by_budget");
  expect(bounded.report.overBudget).toBe(false);
});

it("delivers account-bound unknown economics into the actual finance brain prompt within the shared budget", async () => {
  const economicFeedback = {
    asOf: "2026-10-03T00:00:00Z",
    accounts: [
      {
        accountId: "paper-a",
        venue: "alpaca:paper",
        snapshotRef: "snapshot-a",
        netMatchedPnl: null,
        issues: ["fees_not_allocated_to_closed_lots"],
        basis: "FIFO not account return",
      },
    ],
    omittedAccounts: 1,
  };
  const bounded = boundPerception({
    observedAt: economicFeedback.asOf,
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: { financeAutomaticLifecycle: { economicFeedback } },
  });
  const prompt = buildCentralBrainPrompt(bounded.perception);
  expect(prompt).toContain("paper-a");
  expect(prompt).toContain("fees_not_allocated_to_closed_lots");
  expect(prompt).toContain("snapshot-a");
  expect(prompt).toContain("grow PAPER net wealth after costs");
  expect(bounded.report.overBudget).toBe(false);
  let observed = false;
  await runCentralHarnessCycle({
    perception: bounded.perception,
    registry: new Map(),
    planOnly: true,
    brain: {
      propose: async (perception) => {
        observed = true;
        const actualPrompt = buildCentralBrainPrompt(perception);
        expect(actualPrompt).toContain("snapshot-a");
        expect(actualPrompt).toContain("fees_not_allocated_to_closed_lots");
        expect(actualPrompt).toContain('"netMatchedPnl":null');
        return {
          kind: "proposed",
          provider: "offline-scripted",
          modelId: "fixture",
          plan: { note: "unknown is not return", actions: [] },
        };
      },
    },
  });
  expect(observed).toBe(true);
});

it("projects critical source-timed finance facts after backlog pressure without changing the original", () => {
  const finance = {
    schemaVersion: "lcx_finance_automatic_lifecycle_feedback_v2",
    status: "present",
    observedAt: "2026-10-06T17:10:00.000Z",
    nextTask: "inspect_finance_position_management",
    scheduler: {
      runtime: {
        status: "responsive",
        placementEnabled: true,
        accountWork: {
          status: "busy",
          observedAt: "2026-10-06T17:10:00.000Z",
          activeWork: "trading",
          queuedWork: 1,
          reconciliationPending: true,
        },
      },
      history: "中".repeat(2600),
    },
    intradayExecution: {
      status: "present",
      candidates: 43,
      placed: 2,
      uncertain: 1,
      missingOutcome: 1,
      topReasons: [
        { reason: "account_execution_safety_claim_pending_before_model_review", count: 40 },
      ],
    },
    positionManagement: {
      status: "present",
      needsInspection: true,
      accounts: [
        {
          accountId: "paper-a",
          snapshotRef: "snapshot-a",
          observedAt: "2026-10-06T17:09:00.000Z",
          freshness: "stale",
          uncoveredCount: 3,
          holdings: [
            {
              instrument: "TLT",
              status: "no_recognized_stop",
              positionQuantity: 130,
              uncoveredQuantity: 130,
            },
            { instrument: "AAA", status: "covered", positionQuantity: 1, uncoveredQuantity: 0 },
          ],
        },
      ],
    },
    economicFeedback: {
      status: "present",
      asOf: "2026-10-06T17:10:00.000Z",
      accounts: [
        {
          accountId: "paper-a",
          venue: "alpaca:paper",
          snapshotRef: "snapshot-a",
          netMatchedPnl: null,
          issues: ["fees_not_allocated_to_closed_lots"],
        },
      ],
    },
  };
  const original = structuredClone(finance);
  const input = {
    observedAt: "2026-10-07T00:00:00Z",
    ownerTotals: {},
    boundaries: [],
    backlog: [{ note: "x".repeat(5500) }],
    controlRoom: { financeAutomaticLifecycle: finance },
  };
  const bounded = boundPerception(input);
  const projected = bounded.perception.controlRoom.financeAutomaticLifecycle;
  expect(projected).toMatchObject({
    observedAt: finance.observedAt,
    nextTask: finance.nextTask,
    scheduler: {
      runtime: {
        status: "responsive",
        placementEnabled: true,
        accountWork: finance.scheduler.runtime.accountWork,
      },
    },
    intradayExecution: {
      uncertain: 1,
      missingOutcome: 1,
      topReasons: finance.intradayExecution.topReasons,
    },
    positionManagement: {
      accounts: [
        {
          freshness: "stale",
          uncoveredCount: 3,
          holdings: [
            {
              instrument: "TLT",
              status: "no_recognized_stop",
              positionQuantity: 130,
              uncoveredQuantity: 130,
            },
          ],
        },
      ],
    },
    economicFeedback: {
      accounts: [
        {
          accountId: "paper-a",
          snapshotRef: "snapshot-a",
          netMatchedPnl: null,
          issues: ["fees_not_allocated_to_closed_lots"],
        },
      ],
    },
    budgetProjection: {
      kind: "critical_finance_facts",
      omittedFieldCount: expect.any(Number),
      omittedFields: expect.arrayContaining([
        "positionManagement.accounts.details_or_additional_accounts",
      ]),
    },
  });
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(2048);
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(12000);
  expect(boundPerception(bounded.perception).perception).toEqual(bounded.perception);
  expect(finance).toEqual(original);
  expect(buildCentralBrainPrompt(bounded.perception)).toContain('"netMatchedPnl":null');
});

it("names omitted detail and keeps missing economics unknown rather than inventing a passing zero", () => {
  const bounded = boundPerception({
    observedAt: "now",
    ownerTotals: {},
    boundaries: [],
    backlog: [],
    controlRoom: {
      financeAutomaticLifecycle: {
        nextTask: "inspect_costs",
        economicFeedback: { status: "unavailable", reason: "fees未知" },
        positionManagement: { status: "unavailable" },
        history: "中".repeat(5000),
      },
    },
  });
  expect(bounded.perception.controlRoom.financeAutomaticLifecycle).toMatchObject({
    economicFeedback: { status: "unavailable", reason: "fees未知" },
    positionManagement: { status: "unavailable" },
    budgetProjection: {
      omittedFieldCount: expect.any(Number),
      omittedFields: expect.arrayContaining(["history"]),
    },
  });
  expect(JSON.stringify(bounded.perception)).not.toContain("netMatchedPnl");
  expect(bounded.report.overBudget).toBe(false);
});
it("bounds refusal explanations and reports malformed or oversized omitted reasons", () => {
  const source = {
    intradayExecution: {
      status: "present",
      topReasons: [
        { reason: "x".repeat(500), count: 1 },
        { reason: "invalid", count: -1 },
        { reason: "observed_first", count: 4 },
        { reason: "observed_second", count: 3 },
        { reason: "observed_third", count: 2 },
      ],
    },
    history: "x".repeat(8000),
  };
  const bounded = boundPerception({
    observedAt: "now",
    ownerTotals: {},
    boundaries: [],
    backlog: [{ note: "x".repeat(5500) }],
    controlRoom: { financeAutomaticLifecycle: source },
  });
  expect(bounded.perception.controlRoom.financeAutomaticLifecycle).toMatchObject({
    intradayExecution: {
      topReasons: [
        { reason: "observed_first", count: 4 },
        { reason: "observed_second", count: 3 },
      ],
    },
    budgetProjection: {
      omittedFields: expect.arrayContaining(["intradayExecution.topReasons.omitted_reasons"]),
    },
  });
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(12000);
  expect(source.intradayExecution.topReasons).toHaveLength(5);
});

it("keeps source-timed actionable finance gaps when less than 600 bytes remain", () => {
  const finance = {
    schemaVersion: "lcx_finance_automatic_lifecycle_feedback_v2",
    status: "present",
    observedAt: "2026-10-08T05:07:00Z",
    nextTask: "inspect_unexecuted_finance_candidates",
    intradayExecution: { uncertain: 1, missingOutcome: 1, needsExecutionInspection: true },
    positionManagement: { needsInspection: true, accounts: [{ snapshotRef: "sealed-source" }] },
    economicFeedback: { status: "net_profit_unverified", accounts: [{ netMatchedPnl: null }] },
    history: "x".repeat(8400),
  };
  const perception = {
    observedAt: finance.observedAt,
    ownerTotals: {},
    backlog: [{ note: "x".repeat(7300) }],
    boundaries: [],
    controlRoom: {
      runtimeFreshness: { ageMs: 1000 },
      governanceDigest: { nextAction: "inspect", ownerResults: [] },
      financeAutomaticLifecycle: finance,
    },
  };
  const base = {
    ...perception,
    controlRoom: {
      runtimeFreshness: perception.controlRoom.runtimeFreshness,
      governanceDigest: perception.controlRoom.governanceDigest,
    },
  };
  const budget = Buffer.byteLength(JSON.stringify(base)) + 580;
  const bounded = boundPerception(perception, budget);
  expect(bounded.perception.controlRoom.financeAutomaticLifecycle).toMatchObject({
    observedAt: finance.observedAt,
    nextTask: finance.nextTask,
    intradayExecution: { uncertain: 1, missingOutcome: 1, needsExecutionInspection: true },
    positionManagement: { needsInspection: true },
    economicFeedback: { status: "net_profit_unverified" },
    budgetProjection: { kind: "critical_finance_facts", omittedFieldCount: expect.any(Number) },
  });
  expect(JSON.stringify(bounded.perception)).not.toContain("netMatchedPnl");
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(budget);
  expect(bounded.report.overBudget).toBe(false);
  expect(boundPerception(bounded.perception, budget).perception).toEqual(bounded.perception);
  expect(finance.history.length).toBe(8400);
});
it("keeps the leading refusal cause when the full projection cannot fit", () => {
  const finance = {
    status: "present",
    observedAt: "2026-10-09T16:00:00Z",
    nextTask: "inspect_unexecuted_finance_candidates",
    intradayExecution: {
      scope: "latest_100_recorded_signals",
      uncertain: 0,
      missingOutcome: 0,
      needsExecutionInspection: true,
      topReasons: [
        { reason: "account_execution_safety_claim_pending_before_model_review", count: 100 },
      ],
    },
    history: "x".repeat(8400),
  };
  const base = {
    observedAt: finance.observedAt,
    ownerTotals: {},
    backlog: [{ note: "x".repeat(7300) }],
    boundaries: [],
    controlRoom: {},
  };
  const budget = Buffer.byteLength(JSON.stringify(base)) + 580;
  const bounded = boundPerception(
    { ...base, controlRoom: { financeAutomaticLifecycle: finance } },
    budget,
  );
  expect(bounded.perception.controlRoom.financeAutomaticLifecycle).toMatchObject({
    observedAt: finance.observedAt,
    intradayExecution: { topReasons: finance.intradayExecution.topReasons },
    budgetProjection: { omittedFieldCount: expect.any(Number) },
  });
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(budget);
});
it("keeps source-timed recovery failure in the minimal finance projection", () => {
  const reconciliation = {
    status: "present",
    observedAt: "2026-10-10T04:45:00Z",
    lastErrorCode: "execution_recovery_incomplete",
    needsInspection: true,
  };
  const finance = {
    status: "present",
    observedAt: reconciliation.observedAt,
    nextTask: "inspect_finance_scheduler_runtime",
    scheduler: { runtime: { status: "responsive", reconciliation } },
    positionManagement: { needsInspection: false },
    history: "x".repeat(8400),
  };
  const base = {
    observedAt: finance.observedAt,
    ownerTotals: {},
    backlog: [{ note: "x".repeat(7300) }],
    boundaries: [],
    controlRoom: {},
  };
  const budget = Buffer.byteLength(JSON.stringify(base)) + 620;
  const bounded = boundPerception(
    { ...base, controlRoom: { financeAutomaticLifecycle: finance } },
    budget,
  );
  expect(bounded.perception.controlRoom.financeAutomaticLifecycle).toMatchObject({
    scheduler: { runtime: { reconciliation } },
    budgetProjection: { omittedFieldCount: expect.any(Number) },
  });
  expect(buildCentralBrainPrompt(bounded.perception)).toContain("execution_recovery_incomplete");
  expect(boundPerception(bounded.perception, budget).perception).toEqual(bounded.perception);
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(budget);
});
