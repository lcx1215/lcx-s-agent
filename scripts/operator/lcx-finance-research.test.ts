import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFinanceCaseRun, saveFinanceCaseRun } from "../../src/agents/finance-caseflow.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";
import { runFinanceResearchCli } from "./lcx-finance-research.ts";

const input = ["--ask", "过去六个月加密货币和美股市场情绪", "--as-of", "2026-09-08T00:00:00Z"];

describe("finance research operator", () => {
  it("returns a fixed-date plan without model or source execution", async () => {
    const receipt = await runFinanceResearchCli(input);
    if (!("plan" in receipt)) {
      throw new Error("expected research receipt");
    }
    expect(receipt.status).toBe("planned");
    expect(receipt.batch).toBeUndefined();
    expect(receipt.committee).toBeUndefined();
    expect(receipt.plan.asOf).toBe("2026-09-08T00:00:00Z");
  });
  it("rejects unconfigured live execution before collection", async () => {
    await expect(runFinanceResearchCli([...input, "--live"])).rejects.toThrow("explicit --model");
  });
  it("rejects an invalid API budget", async () => {
    await expect(runFinanceResearchCli([...input, "--max-api-calls", "0"])).rejects.toThrow(
      "positive integer",
    );
  });
  it("persists and reads a case through the existing operator", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "caseflow-cli-"));
    try {
      const result = await runFinanceResearchCli([
        ...input,
        "--case-dir",
        directory,
        "--case-id",
        "market-case",
      ]);
      expect("savedCaseRun" in result).toBe(true);
      if (!("savedCaseRun" in result) || !result.savedCaseRun) {
        throw new Error("missing saved run");
      }
      const frozen = await runFinanceResearchCli([
        "--case-dir",
        directory,
        "--read-run",
        result.savedCaseRun.ref,
      ]);
      expect("case" in frozen && frozen.case.id).toBe("market-case");
      const diff = await runFinanceResearchCli([
        "--case-dir",
        directory,
        "--read-run",
        result.savedCaseRun.ref,
        "--compare-run",
        result.savedCaseRun.ref,
      ]);
      expect("definitionChanged" in diff && diff.definitionChanged).toBe(false);
      await expect(
        runFinanceResearchCli([
          "--case-dir",
          directory,
          "--read-run",
          result.savedCaseRun.ref,
          "--live",
        ]),
      ).rejects.toThrow("cannot execute");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects checkpoint mutation in planning mode", async () => {
    await expect(runFinanceResearchCli([...input, "--checkpoint-run", "resume-1"])).rejects.toThrow(
      "requires live case research",
    );
  });
  it("rejects an invalid inference budget before execution", async () => {
    await expect(runFinanceResearchCli([...input, "--max-model-calls", "0"])).rejects.toThrow(
      "positive integer",
    );
  });
  it("records and lists an outcome without invoking research", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "outcome-cli-"));
    try {
      const receipt = await runFinanceResearchRun({
        input: { ask: "Fixture claim", asOf: "2025-01-01T00:00:00Z" },
      });
      const run = buildFinanceCaseRun({
        caseId: "fixture",
        execution: {},
        budget: { maxApiCalls: 1 },
        receipt: {
          ...receipt,
          quarterlyOutput: {
            ...receipt.quarterlyOutput,
            candidateClaims: [
              {
                id: "c1",
                text: "Original fixture hypothesis",
                status: "uncertain",
                evidenceIds: [],
              },
            ],
          },
        },
      });
      const saved = await saveFinanceCaseRun(directory, run);
      const inputFile = path.join(directory, "observation.json");
      await fs.writeFile(
        inputFile,
        JSON.stringify({
          recordId: "review-1",
          checkpointMonths: 3,
          observedAt: "2025-04-01T00:00:00Z",
          evidence: [
            {
              id: "e1",
              source: "fixture://source",
              sourceTimestamp: "2025-04-01T00:00:00Z",
              field: "close",
              value: 10,
            },
          ],
          assessments: [
            {
              claimId: "c1",
              finding: "inconclusive",
              evidenceIds: ["e1"],
              deviation: "Not numerically specified",
              invalidationConditions: ["Needs more evidence"],
            },
          ],
        }),
      );
      const args = ["--case-dir", directory, "--packet-ref", saved.ref];
      const recorded = await runFinanceResearchCli([...args, "--outcome-file", inputFile]);
      expect("status" in recorded && recorded.status).toBe("recorded_for_review");
      expect(await runFinanceResearchCli([...args, "--list-outcomes"])).toEqual([recorded]);
      await expect(runFinanceResearchCli([...args, "--list-outcomes", "--live"])).rejects.toThrow(
        "cannot run simultaneously",
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

it("exposes complete source planning and prevents collection flags on read operations", async () => {
  const result = await runFinanceResearchCli([...input, "--all-sources"]);
  expect("plan" in result && result.plan.sourceInventory?.unplannedAdapterIds).toEqual([]);
  await expect(runFinanceResearchCli([...input, "--sources-only"])).rejects.toThrow(
    "requires --live",
  );
  await expect(runFinanceResearchCli(["--list-cases", "--all-sources"])).rejects.toThrow(
    "research mode",
  );
});
