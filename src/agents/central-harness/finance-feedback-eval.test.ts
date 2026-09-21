import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateFinanceFeedback, financeFeedbackRuleBrain } from "./finance-feedback-eval.js";
import type { CentralBrain } from "./model-brain.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function run(brain: CentralBrain) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-feedback-"));
  roots.push(root);
  return evaluateFinanceFeedback({
    brain,
    workspaceDir: path.join(root, "run"),
    evidenceKind: "fixture",
  });
}
describe("finance feedback evaluation", () => {
  it("runs two real ledger reads and derives the exact answer through the rule baseline", async () => {
    const result = await run(financeFeedbackRuleBrain);
    expect(result.passed).toBe(true);
    expect(result.toolCalls).toBe(2);
    expect(result.answer).toMatchObject({ quantity: 10, unrealizedPnl: 200 });
    expect(result.receipts).toHaveLength(3);
  });
  it("does not reward a correct guessed answer without tool evidence", async () => {
    const result = await run({
      propose: async () => ({
        kind: "proposed",
        provider: "fixture",
        modelId: "guess",
        plan: {
          actions: [],
          note: JSON.stringify({
            status: "ready",
            quantity: 10,
            unrealizedPnl: 200,
            basis: "synthetic",
          }),
        },
      }),
    });
    expect(result.answerCorrect).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.feedbackFollowed).toBe(false);
  });
  it("counts repeated reads and stops after three cycles", async () => {
    const result = await run({
      propose: async (perception, signal) =>
        financeFeedbackRuleBrain.propose(
          {
            ...perception,
            controlRoom: { financeFeedbackTask: perception.controlRoom.financeFeedbackTask },
          },
          signal,
        ),
    });
    expect(result.toolCalls).toBe(3);
    expect(result.duplicateCalls).toBe(2);
    expect(result.passed).toBe(false);
  });
  it("blocks paths outside the synthetic workspace", async () => {
    const result = await run({
      propose: async () => ({
        kind: "proposed",
        provider: "fixture",
        modelId: "wrong-path",
        plan: {
          actions: [
            { ownerId: "finance_position_ledger_read", args: { directory: "/not-authorized" } },
          ],
          note: "read",
        },
      }),
    });
    expect(result.invalidProposals).toBe(3);
    expect(result.toolCalls).toBe(0);
    expect(result.passed).toBe(false);
  });
});
