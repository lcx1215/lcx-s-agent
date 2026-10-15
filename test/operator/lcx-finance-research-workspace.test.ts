import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { FinanceResearchRunReceipt } from "../../src/agents/finance-research-runner.ts";
import { buildFinanceThesisDecisionContext } from "../../src/agents/finance-thesis-decision-context.ts";

const calls = vi.hoisted(() => ({ run: vi.fn(), checkpoint: vi.fn() }));
vi.mock("../../src/agents/finance-research-runner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agents/finance-research-runner.ts")>()),
  runFinanceResearchRun: calls.run,
}));
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it.each([false, true])(
  "keeps module workspace aligned with CLI receipts (live=%s)",
  async (live) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-cli-workspace-"));
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", root);
    const execute = live ? calls.checkpoint : calls.run;
    execute.mockRejectedValue(new Error("stop before provider dispatch"));
    try {
      await expect(
        run(parseArgs(live ? ["--live", "--workflow-models", "--write", "--execute-modules"] : [])),
      ).rejects.toThrow("stop before provider dispatch");
      expect(execute.mock.calls[0]?.[0]).toMatchObject({ workspaceDir: root });
      if (live) {
        expect(execute.mock.calls[0]?.[1]).toMatchObject({
          directory: path.join(root, "state", "finance-research-checkpoints"),
        });
        expect(
          (await fs.stat(path.join(root, "state", "finance-research-runs"))).isDirectory(),
        ).toBe(true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("persists a thesis citing evidence inside the quality packet limit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-cli-thesis-boundary-"));
  const financeStateDir = path.join(root, "finance-state");
  const asOf = "2099-09-28T12:00:00.000Z";
  await fs.mkdir(financeStateDir, { recursive: true });
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", root);

  const committeeEvidence = Array.from({ length: 49 }, (_, index) => {
    const number = index + 1;
    return {
      id: number === 49 ? "finance-model:SPY" : `source:${number}`,
      source: "finance-research-fixture",
      timestamp: new Date().toISOString(),
      text: number === 49 ? "SPY has a bounded source observation." : `Observation ${number}.`,
    };
  });
  const receipt = {
    status: "candidate",
    answerDecision: "candidate_for_review",
    plan: { asOf, targets: [{ instrument: "SPY" }] },
    batch: { committeeEvidence },
    quality: {
      status: "verified",
      runId: "finance-thesis-evidence-49",
      quality: { passed: true },
      finalArtifact: {
        answer: "A bounded SPY observation.",
        claims: [
          {
            id: "spy-claim",
            text: "SPY has the stated bounded source observation.",
            status: "supported",
            evidenceIds: ["finance-model:SPY"],
            epistemicClass: "source_observation",
            evidenceRelations: [{ evidenceId: "finance-model:SPY", relation: "supports" }],
          },
        ],
        supportingAnalysis: {
          financeThesisProposals: [
            {
              claimId: "spy-claim",
              instrument: "SPY",
              invalidationConditions: ["The stated observation no longer holds."],
            },
          ],
        },
      },
    },
    gates: [{ passed: true }],
  } as unknown as FinanceResearchRunReceipt;

  calls.checkpoint.mockResolvedValue(receipt);
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
        asOf,
      ]),
    );

    expect(result.thesisLearning?.status).toBe("persisted");
    const context = await buildFinanceThesisDecisionContext({
      directory: financeStateDir,
      asOf,
      instruments: ["SPY"],
    });
    expect(context.activeThesisCount).toBe(1);
    expect(context.theses[0]?.claim).toBe("SPY has the stated bounded source observation.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
