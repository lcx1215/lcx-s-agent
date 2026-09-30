import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  parseControllerResearchScope,
  compactFinanceResearchSummary,
  buildControllerNightResearchTargets,
  run,
} from "../../scripts/operator/lcx-finance-research-run.ts";
import {
  FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
  FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
  FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
} from "../../src/agents/finance-night-review-context.ts";

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

  it("accepts an explicit state directory for bounded source snapshots without thesis writes", () => {
    const options = parseArgs([
      "--live",
      "--workflow-models",
      "--write",
      "--finance-state-dir",
      "./state/finance",
    ]);
    expect(options.financeStateDir).toBe(path.resolve("./state/finance"));
    expect(options.persistTheses).toBe(false);
  });
});

describe("controller-owned night research scope", () => {
  it("requires explicit evidence, exact finance root, and research-only mode", () => {
    expect(() => parseArgs(["--controller-research-scope"])).toThrow(
      /requires --controller-evidence/,
    );
    expect(() =>
      parseArgs([
        "--controller-research-scope",
        "--controller-evidence",
        "/tmp/night.json",
        "--live",
        "--workflow-models",
        "--write",
      ]),
    ).toThrow(/requires --finance-state-dir/);
    expect(() =>
      parseArgs([
        "--controller-research-scope",
        "--controller-evidence",
        "/tmp/night.json",
        "--finance-state-dir",
        "/tmp/finance",
        "--decision-mode",
        "strategy_candidate",
        "--live",
        "--workflow-models",
        "--write",
      ]),
    ).toThrow(/requires --decision-mode research_only/);
    const options = parseArgs([
      "--controller-research-scope",
      "--controller-evidence",
      "/tmp/night.json",
      "--finance-state-dir",
      "/tmp/finance",
      "--live",
      "--workflow-models",
      "--write",
    ]);
    expect(options.controllerResearchScope).toBe(true);
    expect(options.decisionMode).toBe("research_only");
  });

  it("builds exact typed targets without converting BTC/USD into equity or substituting from the ask", () => {
    const targets = buildControllerNightResearchTargets({
      ask: "Night review portfolio risk; do not infer instruments from this text.",
      asOf: "2026-09-29T00:00:00.000Z",
      horizonMonths: 6,
      instruments: [
        { instrument: "SPY", assetClass: "us_equity", reasons: ["held_position"] },
        { instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] },
      ],
    });
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instrument: "SPY", assetClass: "us_equity" }),
        expect.objectContaining({ instrument: "BTC/USD", assetClass: "crypto" }),
      ]),
    );
    expect(
      targets.some((target) => target.instrument === "BTC/USD" && target.assetClass !== "crypto"),
    ).toBe(false);
    expect(targets.some((target) => target.instrument === "QQQ")).toBe(false);
  });

  it("accepts only one well-formed scope at the exact run asOf", () => {
    const asOf = "2026-09-29T00:00:00.000Z";
    const evidence = {
      id: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
      source: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
      timestamp: asOf,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
        asOf,
        activeStrategyIds: ["daily-trend"],
        instruments: [{ instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] }],
      }),
    };
    const parsed = parseControllerResearchScope([evidence], asOf);
    expect(parsed.instruments).toEqual([
      { instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] },
    ]);
    expect(() => parseControllerResearchScope([evidence], "2026-09-29T00:01:00.000Z")).toThrow(
      /does not match --as-of/,
    );
    expect(() =>
      parseControllerResearchScope([{ ...evidence, timestamp: "2026-09-28T23:59:00.000Z" }], asOf),
    ).toThrow(/evidence timestamp does not match --as-of/);
    expect(() => parseControllerResearchScope([evidence, evidence], asOf)).toThrow(
      /exactly one canonical night scope item/,
    );
    const invalid = {
      ...evidence,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
        asOf,
        activeStrategyIds: [],
        instruments: [
          { instrument: "BTC/USD", assetClass: "us_equity", reasons: ["held_position"] },
        ],
      }),
    };
    const invalidScope = parseControllerResearchScope([invalid], asOf);
    expect(() =>
      buildControllerNightResearchTargets({
        ask: "night review",
        asOf,
        horizonMonths: 6,
        instruments: invalidScope.instruments,
      }),
    ).toThrow(/unsupported us_equity instrument/);
  });

  it("fails closed for conflicting, invalid, duplicate, or oversized typed scope", () => {
    const build = (
      instruments: readonly { instrument: string; assetClass: "us_equity" | "crypto" }[],
    ) =>
      buildControllerNightResearchTargets({
        ask: "portfolio",
        asOf: "2026-09-29T00:00:00.000Z",
        horizonMonths: 6,
        instruments: instruments.map((item) => ({ ...item, reasons: ["active_strategy"] })),
      });
    expect(() =>
      build([
        { instrument: "SPY", assetClass: "us_equity" },
        { instrument: "SPY", assetClass: "crypto" },
      ]),
    ).toThrow(/unsupported crypto instrument/);
    expect(() =>
      build([
        { instrument: "SPY", assetClass: "us_equity" },
        { instrument: "SPY", assetClass: "us_equity" },
      ]),
    ).toThrow(/duplicate instrument/);
    expect(() => build([{ instrument: "BTC/USD", assetClass: "us_equity" }])).toThrow(
      /unsupported us_equity instrument/,
    );
    expect(() =>
      build(
        Array.from({ length: 15 }, (_, index) => ({
          instrument: `A${String.fromCharCode(65 + index)}`,
          assetClass: "us_equity" as const,
        })),
      ),
    ).toThrow(/must contain 1-14 instruments/);
  });
});

it("keeps the scheduler protocol parseable while full evidence stays in the receipt", () => {
  const summary = {
    schemaVersion: "lcx_finance_research_operator_v1",
    boundary: "local_finance_research_run_only",
    status: "candidate" as const,
    answerDecision: "candidate_for_review" as const,
    gates: [],
    plan: { asOf: "2026-09-29T00:00:00Z" },
    written: { datedPath: "/synthetic/research.json", latestPath: "/synthetic/latest.json" },
    portfolioPlanWritten: "/synthetic/plan.json",
    unusedEvidence: "x".repeat(100000),
  };
  const compact = compactFinanceResearchSummary(summary);
  expect(JSON.stringify(compact).length).toBeLessThan(65536);
  expect(compact).toMatchObject({
    status: "candidate",
    plan: summary.plan,
    written: summary.written,
    portfolioPlanWritten: summary.portfolioPlanWritten,
  });
  expect(compact).not.toHaveProperty("unusedEvidence");
  expect(parseArgs(["--scheduler-summary"]).json).toBe(true);
});

it("rejects a portfolio context whose strategy id is not active before research starts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-research-context-"));
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", path.join(directory, "workspace"));
  try {
    const contextPath = path.join(directory, "portfolio-context.json");
    await fs.writeFile(
      contextPath,
      JSON.stringify({
        accountId: "paper-account",
        venue: "alpaca",
        validityMinutes: 60,
        conflictPolicy: "block",
        activeStrategyIds: ["missing-rule"],
      }),
    );
    const options = parseArgs([
      "--ask",
      "Review the active portfolio allocation",
      "--as-of",
      "2026-09-29T00:00:00.000Z",
      "--decision-mode",
      "strategy_candidate",
      "--portfolio-context",
      contextPath,
      "--finance-state-dir",
      directory,
      "--live",
      "--workflow-models",
      "--persist-theses",
      "--write",
    ]);
    await expect(run(options)).rejects.toThrow("not active in the controller ledger");
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("preserves reviewed portfolio abstention in the scheduler protocol without a plan path", () => {
  const portfolioAbstention = {
    reason: "No strategy has evidence for a positive allocation.",
    evidenceIds: ["rule-evidence"],
  };
  const compact = compactFinanceResearchSummary({
    schemaVersion: "lcx_finance_research_operator_v1",
    boundary: "local_finance_research_run_only",
    status: "candidate",
    answerDecision: "candidate_for_review",
    plan: { asOf: "2026-09-29T19:00:00.000Z" },
    gates: [{ id: "quality", passed: true, reason: "verified" }],
    portfolioAbstention,
  });
  expect(compact.portfolioAbstention).toEqual(portfolioAbstention);
  expect(compact.portfolioPlanWritten).toBeUndefined();
});
