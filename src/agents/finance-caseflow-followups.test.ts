import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import { validateScheduleTimestamp } from "../cron/validate-timestamp.js";
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

it("records an overdue checkpoint and still binds the later future checkpoint without reserving the old one", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "followup-overdue-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
  try {
    const receipt = await runFinanceResearchRun({
      input: { ask: "Quarterly review", asOf: "2026-01-01T00:00:00Z" },
    });
    const packet = await saveFinanceCaseRun(
      directory,
      buildFinanceCaseRun({
        caseId: "overdue",
        receipt,
        execution: {},
        budget: { maxApiCalls: 1 },
      }),
    );
    const jobs: CronJob[] = [];
    const add = vi.fn<FinanceFollowupScheduler["add"]>(async (input) => {
      const valid = validateScheduleTimestamp(input.schedule);
      if (!valid.ok) {
        throw new Error(valid.message);
      }
      const job: CronJob = {
        ...input,
        id: String(jobs.length),
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        state: {},
      };
      jobs.push(job);
      return job;
    });
    const params = {
      directory,
      packetRef: packet.ref,
      scheduler: { list: async () => [...jobs], add },
      register: true,
    };
    const result = await bindFinanceCaseFollowups(params);
    expect(result.bindings.map((entry) => entry.status)).toEqual(["overdue_unbound", "scheduled"]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(jobs[0].schedule).toEqual({ kind: "at", at: "2026-07-01T00:00:00.000Z" });
    expect((await bindFinanceCaseFollowups(params)).bindings.map((entry) => entry.status)).toEqual([
      "overdue_unbound",
      "scheduled",
    ]);
    expect(add).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
