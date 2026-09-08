import { describe, expect, it } from "vitest";
import { runFinanceResearchCli } from "./lcx-finance-research.ts";

const input = ["--ask", "过去六个月加密货币和美股市场情绪", "--as-of", "2026-09-08T00:00:00Z"];

describe("finance research operator", () => {
  it("returns a fixed-date plan without model or source execution", async () => {
    const receipt = await runFinanceResearchCli(input);
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
});
