import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOriginalFinanceSchedulerPlan } from "./fixtures/lcx-waterflow-finance-scheduler-plan-probe.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { force: true, recursive: true });
  }
  vi.unstubAllGlobals();
});
async function probe(
  name: string,
  options: Omit<Parameters<typeof probeOriginalFinanceSchedulerPlan>[0], "directory"> = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-native-scheduler-plan-"));
  directories.push(directory);
  const network = vi.fn(() => {
    throw new Error("network forbidden in native scheduler sample");
  });
  vi.stubGlobal("fetch", network);
  const result = await probeOriginalFinanceSchedulerPlan({ directory, ...options });
  const retained = process.env.LCX_FINANCE_SCHEDULER_PLAN_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
    await fs.cp(directory, path.join(retained, name), { recursive: true });
    await fs.writeFile(
      path.join(retained, name, "network-count.json"),
      JSON.stringify({
        fetchCalls: network.mock.calls.length,
        configuredProvidersAllowed: false,
        actualChildSpawn: false,
      }) + "\n",
    );
  }
  expect(network).not.toHaveBeenCalled();
  return result;
}

describe("original scheduler native same-cycle plan consumption", () => {
  it("accepts the native summary and sends its exact scoped file to the day child without claiming day execution", async () => {
    const result = await probe("normal");
    expect(result.originalSummary).toEqual(result.deliveredSummary);
    expect(result.record.firedAt).toBe(result.nativeProducer.receipt!.plan.asOf);
    expect(result.record.researchPlanRefresh).toMatchObject({
      ok: true,
      planPath: result.planPath,
    });
    expect(result.children.map((child) => child.kind)).toEqual(["research", "day"]);
    const day = result.children[1].argv;
    expect(day[day.indexOf("--portfolio-plan") + 1]).toBe(result.planPath);
    expect(day[day.indexOf("--portfolio-plan-sha256") + 1]).toBe(
      result.originalSummary!.portfolioPlanWrite!.sha256,
    );
    expect(day[day.indexOf("--portfolio-plan-parent-run") + 1]).toBe(result.record.runId);
    expect(day[day.indexOf("--dir") + 1]).toBe(result.nativeProducer.book);
    expect(result.planReadback).toEqual(result.nativeProducer.receipt!.portfolioPlan);
    expect(result.frozenContextReadback).toEqual(
      result.nativeProducer.executeInput!.portfolioContext,
    );
    expect(result.planReadback!.accountId).toBe(
      result.nativeProducer.executeInput!.portfolioContext!.accountId,
    );
    expect(result.accepted).toBe(false);
    expect(result.dayResult!.stderr).toContain("deliberately not run");
    expect(result.record.ok).toBe(false);
    expect(result.kills).toEqual([]);
  });
  it.each([
    "as_of_conflict",
    "gate_conflict",
    "missing_gate",
    "path_conflict",
    "missing_pin",
    "foreign_scope",
  ] as const)("rejects the %s transport conflict before a day dispatch", async (fault) => {
    const result = await probe(fault, { fault });
    expect(result.nativeProducer.receipt!.status).toBe("candidate");
    expect(result.originalSummary!.status).toBe("candidate");
    expect(result.children.map((child) => child.kind)).toEqual(["research"]);
    expect(result.record.researchPlanRefresh.ok).toBe(false);
    expect(result.record.execution).toMatchObject({
      outcome: "not_run",
      blockReason: "research_plan_not_accepted",
    });
    expect(result.dayResult).toBeUndefined();
    expect(result.accepted).toBe(false);
  });
  it.each(["research_timeout", "research_cancel"] as const)(
    "keeps %s terminal despite a late original candidate body and exit zero",
    async (fault) => {
      const result = await probe(fault, { fault });
      expect(result.kills).toHaveLength(1);
      expect(result.children).toHaveLength(1);
      expect(result.children[0].stdout).toBe(result.originalSummaryBytes);
      expect(result.children[0].closeCode).toBe(0);
      expect(result.record.researchPlanRefresh.processResult).toMatchObject({
        ok: false,
        status: fault === "research_timeout" ? "timed_out" : "cancelled",
        exitCode: 0,
      });
      expect(result.record.execution).toMatchObject({
        outcome: "not_run",
        blockReason: "research_plan_not_accepted",
      });
      expect(result.record.researchPlanRefresh.ok).toBe(false);
      expect(result.dayResult).toBeUndefined();
    },
  );
});
