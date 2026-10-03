import { expect, it } from "vitest";
import { boundPerception, projectFinancePerceptionEvidence } from "./harness-loop.js";
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
