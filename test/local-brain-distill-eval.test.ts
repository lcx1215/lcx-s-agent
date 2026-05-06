import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local-brain-distill-eval", () => {
  it("runs simple prerequisite cases before complex commodity evals", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--contract-only",
        "--case-id",
        "commodity_fx_inflation_inventory_portfolio_loop",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean };
      hierarchy: {
        requestedCaseIds: string[];
        autoIncludedPrerequisiteCaseIds: string[];
      };
      cases: Array<{ id: string; acceptance: { ok: boolean } }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toMatchObject({ passed: 2, total: 2, promotionReady: true });
    expect(payload.hierarchy).toEqual({
      requestedCaseIds: ["commodity_fx_inflation_inventory_portfolio_loop"],
      autoIncludedPrerequisiteCaseIds: ["short_lark_commodity_learning_intake"],
    });
    expect(payload.cases.map((entry) => entry.id)).toEqual([
      "short_lark_commodity_learning_intake",
      "commodity_fx_inflation_inventory_portfolio_loop",
    ]);
    expect(payload.cases.every((entry) => entry.acceptance.ok)).toBe(true);
  });

  it("does not let hardened diagnostic fallback pass an empty generation", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lcx-local-brain-eval-"));
    const fakePython = path.join(tempDir, "python");
    writeFileSync(fakePython, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--no-adapter",
        "--python",
        fakePython,
        "--hardened",
        "--case-id",
        "paper_learning_internalization_absorption",
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; promotionReady: boolean; failedCaseIds: string[] };
      cases: Array<{
        id: string;
        parsed: unknown;
        diagnosticFallbackParsed?: unknown;
        parseError?: string;
        acceptance: { ok: boolean };
      }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.summary).toEqual({
      passed: 0,
      total: 1,
      passRate: 0,
      failedCaseIds: ["paper_learning_internalization_absorption"],
      promotionReady: false,
    });
    expect(payload.cases[0]?.acceptance.ok).toBe(false);
    expect(payload.cases[0]?.parsed).toBeNull();
    expect(payload.cases[0]?.diagnosticFallbackParsed).toBeTruthy();
    expect(payload.cases[0]?.parseError).toContain("no JSON object found");
  });
});
