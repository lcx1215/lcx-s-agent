import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
