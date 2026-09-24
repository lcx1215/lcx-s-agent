import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/operator/lcx-finance-research-run.ts";

describe("finance research thesis persistence option", () => {
  it("requires a live, quality-verified workflow and an explicit state root", () => {
    expect(() => parseArgs(["--persist-theses"])).toThrow(
      /requires --live --workflow-models --write/,
    );
    expect(() => parseArgs(["--persist-theses", "--live", "--workflow-models", "--write"])).toThrow(
      /requires an exact --finance-state-dir/,
    );
    expect(() =>
      parseArgs([
        "--persist-theses",
        "--live",
        "--workflow-models",
        "--write",
        "--skip-quality",
        "--finance-state-dir",
        "/tmp/finance-state",
      ]),
    ).toThrow(/with quality enabled/);
  });

  it("accepts an explicitly named finance state directory", () => {
    const options = parseArgs([
      "--persist-theses",
      "--live",
      "--workflow-models",
      "--write",
      "--finance-state-dir",
      "./state/finance",
    ]);
    expect(options.financeStateDir).toBe(path.resolve("./state/finance"));
    expect(options.persistTheses).toBe(true);
  });
});
