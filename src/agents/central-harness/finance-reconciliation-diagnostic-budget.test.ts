import { expect, it } from "vitest";
import { boundPerception } from "./harness-loop.js";
import { buildCentralBrainPrompt } from "./model-brain.js";
it("keeps the original bounded idle read cause in the next crowded central judgment input", () => {
  const lastFailure = {
    stage: "broker_reconciliation",
    code: "ECONNRESET",
    elapsedMs: 45000,
    request: { endpoint: "activities", phase: "body", code: "ECONNRESET", elapsedMs: 45000 },
    rawHeaders: "SECRET",
  };
  const finance = {
    status: "present",
    nextTask: "inspect_finance_scheduler_runtime",
    scheduler: {
      runtime: {
        reconciliation: {
          status: "present",
          lastSource: "idle",
          lastErrorCode: "account_read_failed",
          lastFailure,
          needsInspection: true,
        },
      },
    },
    history: "x".repeat(20000),
  };
  const input = {
    observedAt: "2026-10-15T00:00:00Z",
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: { financeAutomaticLifecycle: finance },
  };
  const bounded = boundPerception(input);
  const prompt = buildCentralBrainPrompt(bounded.perception);
  expect(prompt).toContain("ECONNRESET");
  expect(prompt).toContain("broker_reconciliation");
  expect(prompt).toContain("activities");
  expect(prompt).toContain("body");
  expect(prompt).toContain("idle");
  expect(prompt).not.toContain("SECRET");
  expect(bounded.report.overBudget).toBe(false);
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(12000);
  expect(boundPerception(bounded.perception).perception).toEqual(bounded.perception);
  expect(input.controlRoom.financeAutomaticLifecycle).toBe(finance);
});
