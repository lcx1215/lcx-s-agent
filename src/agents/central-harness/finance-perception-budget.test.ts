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
    controlRoom: { financeAutomaticLifecycle: { history: "x".repeat(7000) } },
  });
  expect(projectFinancePerceptionEvidence(bounded)).toMatchObject({ status: "omitted_by_budget" });
});
