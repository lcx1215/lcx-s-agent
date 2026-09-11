import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../cron/types.js";
import {
  bindFinanceCaseFollowups,
  type FinanceFollowupScheduler,
} from "./finance-caseflow-followups.js";
import { buildFinanceCaseRun, saveFinanceCaseRun } from "./finance-caseflow.js";
import { runFinanceResearchRun } from "./finance-research-runner.js";
it("binds two jobs, reads state, preserves completed jobs and prevents duplicate registration", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "followup-test-"));
  try {
    const receipt = await runFinanceResearchRun({
      input: { ask: "Quarterly review", asOf: new Date().toISOString() },
    });
    const packet = await saveFinanceCaseRun(
      directory,
      buildFinanceCaseRun({ caseId: "test", receipt, execution: {}, budget: { maxApiCalls: 1 } }),
    );
    const jobs: CronJob[] = [];
    const scheduler: FinanceFollowupScheduler = {
      list: async () => [...jobs],
      add: async (input) => {
        const job: CronJob = {
          ...input,
          id: String(jobs.length),
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          state: {},
        };
        jobs.push(job);
        return job;
      },
    };
    const params = { directory, packetRef: packet.ref, scheduler, register: true };
    await Promise.all([bindFinanceCaseFollowups(params), bindFinanceCaseFollowups(params)]);
    const bound = await bindFinanceCaseFollowups(params);
    expect(jobs).toHaveLength(2);
    expect(bound.bindings.every((b) => b.status === "scheduled")).toBe(true);
    expect(jobs.every((j) => j.delivery?.mode === "none")).toBe(true);
    jobs[0].wakeMode = "next-heartbeat";
    expect((await bindFinanceCaseFollowups(params)).bindings[0].status).toBe("binding_drift");
    jobs[0].wakeMode = "now";
    jobs[0].deleteAfterRun = true;
    expect((await bindFinanceCaseFollowups(params)).bindings[0].status).toBe("binding_drift");
    jobs[0].deleteAfterRun = false;
    jobs[0].enabled = false;
    expect((await bindFinanceCaseFollowups(params)).bindings[0].status).toBe(
      "disabled_or_finished",
    );
    jobs.splice(0, 1);
    expect((await bindFinanceCaseFollowups(params)).bindings[0].status).toBe(
      "binding_outcome_unknown_or_removed",
    );
    expect(jobs).toHaveLength(1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
