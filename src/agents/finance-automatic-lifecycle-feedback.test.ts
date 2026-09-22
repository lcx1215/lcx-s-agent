import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildFinanceAutomaticLifecycleFeedback } from "./finance-automatic-lifecycle-feedback.js";
import { financeResearchScoredPath } from "./finance-state-dir.js";
import { runFinanceTuningLifecycle } from "./finance-tuning-lifecycle.js";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-lifecycle-feedback-"));
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it("projects promoted finance lifecycle state for automatic harness perception", async () => {
  fs.writeFileSync(
    financeResearchScoredPath(directory),
    Array.from({ length: 5 }, () => JSON.stringify({ conviction: 0.75, outcome: 1 })).join("\n") +
      "\n",
  );
  runFinanceTuningLifecycle({
    directory,
    generatedAt: "2026-09-23T00:00:00.000Z",
  });

  await expect(
    buildFinanceAutomaticLifecycleFeedback({
      directory,
      observedAt: "2026-09-23T00:01:00.000Z",
    }),
  ).resolves.toMatchObject({
    status: "present",
    scoredOutcomeCount: 5,
    tuning: {
      proposalCount: 1,
      promotionCount: 1,
      latestPromotion: { promoted: 0.75, authority: "paper_only" },
    },
    nextTask: "monitor_promoted_paper_calibration",
    boundary: expect.arrayContaining(["no_execution_authority"]),
  });
});
