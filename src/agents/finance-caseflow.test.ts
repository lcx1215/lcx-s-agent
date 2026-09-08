import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFinanceCaseRun,
  saveFinanceCaseRun,
  readFinanceCaseRun,
  compareFinanceCaseRuns,
} from "./finance-caseflow.js";
import { runFinanceResearchRun } from "./finance-research-runner.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caseflow-test-"));
  directories.push(dir);
  return dir;
}
async function fixture(asOf = "2026-08-31T12:00:00Z") {
  const receipt = await runFinanceResearchRun({
    input: { ask: "Review six months of US equity sentiment", asOf },
  });
  return buildFinanceCaseRun({
    caseId: "market-sentiment",
    receipt,
    execution: { model: "none" },
    budget: { maxApiCalls: 64 },
  });
}
describe("finance caseflow persistence", () => {
  it("freezes a self-contained run and reads it without research execution", async () => {
    const run = await fixture();
    const dir = await directory();
    const saved = await saveFinanceCaseRun(dir, run);
    expect(await readFinanceCaseRun(dir, saved.ref)).toEqual(run);
    expect(run.packet.status).toBe("planned");
    expect(run.packet.adopted).toBe(false);
    expect(run.packet.followups.map((item) => item.dueAt)).toEqual([
      "2026-11-30T12:00:00.000Z",
      "2027-02-28T12:00:00.000Z",
    ]);
    expect(run.packet.followups.every((item) => item.status === "not_scheduled")).toBe(true);
  });
  it("supports concurrent idempotent publication without partial artifacts", async () => {
    const run = await fixture();
    const dir = await directory();
    const saved = await Promise.all(Array.from({ length: 6 }, () => saveFinanceCaseRun(dir, run)));
    expect(new Set(saved.map((item) => item.ref)).size).toBe(1);
    expect(await fs.readdir(dir)).toEqual([`${saved[0].ref}.json`]);
  });
  it("rejects tampering and traversal references", async () => {
    const run = await fixture();
    const dir = await directory();
    const saved = await saveFinanceCaseRun(dir, run);
    await fs.writeFile(
      saved.path,
      JSON.stringify({ ...run, packet: { ...run.packet, adopted: true } }),
    );
    await expect(readFinanceCaseRun(dir, saved.ref)).rejects.toThrow("integrity mismatch");
    await expect(readFinanceCaseRun(dir, "../../secret")).rejects.toThrow();
    await expect(saveFinanceCaseRun(dir, run)).rejects.toThrow("existing artifact mismatch");
  });
  it("separates case revisions, executions, and exact evidence snapshots", async () => {
    const before = await fixture();
    const rerun = await fixture();
    expect(before.run.id).not.toBe(rerun.run.id);
    expect(before.case.revision).toBe(rerun.case.revision);
    expect(compareFinanceCaseRuns(before, rerun).definitionChanged).toBe(false);
    const next = await fixture("2026-09-08T12:00:00Z");
    expect(next.case.id).toBe(before.case.id);
    expect(compareFinanceCaseRuns(before, next).definitionChanged).toBe(true);
    expect(() =>
      compareFinanceCaseRuns(before, { ...next, case: { ...next.case, id: "other" } }),
    ).toThrow("different research cases");
  });
  it("rejects changes to a frozen snapshot before publishing", async () => {
    const run = await fixture();
    run.run.snapshot.status = "candidate";
    await expect(saveFinanceCaseRun(await directory(), run)).rejects.toThrow(
      "fingerprint mismatch",
    );
  });
  it("retains model claims as candidates and rejects unresolved references", async () => {
    const receipt = await runFinanceResearchRun({
      input: { ask: "Review evidence", asOf: "2026-09-08T00:00:00Z" },
    });
    const run = buildFinanceCaseRun({
      caseId: "claim-case",
      budget: { maxApiCalls: 2 },
      execution: {},
      receipt: {
        ...receipt,
        quarterlyOutput: {
          ...receipt.quarterlyOutput,
          adopted: true,
          candidateClaims: [
            {
              id: "c1",
              text: "unverified model view",
              status: "supported",
              evidenceIds: ["invented"],
            },
          ],
        },
      },
    });
    expect(run.packet.status).toBe("needs_review");
    expect(run.packet.adopted).toBe(false);
    expect(run.packet.claims[0].kind).toBe("inference_candidate");
    expect(run.run.evidence).toEqual([]);
    expect(run.packet.executionAuthority).toBe("none");
  });
});
