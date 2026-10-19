import { expect, it } from "vitest";
import { financeStrategyCapitalBudget } from "./finance-portfolio-composition.js";

it.each([
  { fraction: 0, committed: 0, available: 0 },
  { fraction: 0.1, committed: 2500, available: 7500 },
  { fraction: 0.1, committed: 15000, available: 0 },
])(
  "consumes allocation without renormalizing unused capital $fraction $committed",
  ({ fraction, committed, available }) => {
    const budget = financeStrategyCapitalBudget({
      plan: {
        asOf: "2026-10-14T18:00:00Z",
        validUntil: "2026-10-14T20:00:00Z",
        venue: "alpaca",
        accountId: "paper",
        conflictPolicy: "block",
        allocations: [{ strategyId: "orb", budgetFraction: fraction }],
        candidates: [],
      },
      asOf: "2026-10-14T19:00:00Z",
      accountId: "paper",
      venue: "alpaca",
      strategyId: "orb",
      equity: 100000,
      committedNotional: committed,
    });
    expect(budget.availableNotional).toBe(available);
  },
);
