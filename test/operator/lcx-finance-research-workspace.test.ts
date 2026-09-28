import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

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
