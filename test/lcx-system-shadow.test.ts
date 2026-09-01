import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNeutralPrompt, scoreRawContract } from "../scripts/operator/lcx-system-shadow.js";
import {
  GENERALIZATION_CASE_SCHEMA_VERSION,
  GENERALIZATION_GENERATOR_ID,
  GENERALIZATION_GENERATOR_VERSION,
  generateCases,
} from "../scripts/operator/local-brain-generalization-generator.js";

const ROOT = path.resolve(__dirname, "..");

function makeFakePython(directory: string, output: string): { path: string; log: string } {
  const fakePath = path.join(directory, "python");
  const logPath = path.join(directory, "args.jsonl");
  writeFileSync(
    fakePath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const log = ${JSON.stringify(logPath)};`,
      "fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');",
      `process.stdout.write(${JSON.stringify(output)});`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return { path: fakePath, log: logPath };
}

const validPlan = JSON.stringify({
  task_family: "portfolio_research_preflight",
  primary_modules: ["macro_rates_inflation", "credit_liquidity", "etf_regime"],
  supporting_modules: [],
  required_tools: [],
  missing_data: [],
  risk_boundaries: ["research_only"],
  next_step: "route_to_review",
  rejected_context: ["old_lark_conversation_history"],
});

describe("lcx-system-shadow", () => {
  it("builds the neutral prompt without scorer-side target labels", () => {
    const prompt = buildNeutralPrompt("学习原油。");

    expect(prompt).toContain("Blind neutral raw-contract eval");
    expect(prompt).toContain("user_or_task: 学习原油。");
    expect(prompt).not.toContain("source_summary:");
    expect(prompt).not.toContain("source_url_or_local_source_path");
    expect(prompt).not.toContain("commodity_framework_not_trade_signal");
  });

  it("scores only raw contract fields and does not normalize aliases", () => {
    const target = {
      id: "contract-test",
      userAsk: "test",
      requiredModules: ["etf_regime"],
      minModuleMatches: 1,
      requiredMissingData: ["fresh_market_data_snapshot"],
      requiredRiskBoundaries: ["no_trade_advice"],
      caseSource: "fixed_registry" as const,
    };
    const score = scoreRawContract(
      {
        task_family: "test",
        primary_modules: ["finance_framework_etf_regime_producer"],
        supporting_modules: [],
        required_tools: [],
        missing_data: ["fresh-market-data-snapshot"],
        risk_boundaries: ["research_only", "no_trade_advice"],
        next_step: "review",
        rejected_context: ["old_lark_conversation_history"],
      },
      target,
    );

    expect(score.ok).toBe(false);
    expect(score.missingModules).toEqual(["etf_regime"]);
    expect(score.missingRequiredData).toEqual([]);
  });

  it("rejects non-string scalar fields and mixed contract arrays", () => {
    const target = {
      id: "contract-types",
      userAsk: "test",
      requiredModules: [],
      minModuleMatches: 0,
      caseSource: "fixed_registry" as const,
    };
    const score = scoreRawContract(
      {
        task_family: ["not-a-string"],
        primary_modules: ["review_panel", 7],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: ["research_only"],
        next_step: "",
        rejected_context: ["old_lark_conversation_history"],
      },
      target,
    );

    expect(score.ok).toBe(false);
    expect(score.invalidFieldTypes).toEqual(["primary_modules", "task_family", "next_step"]);
  });

  it("runs bounded N raw attempts, selects only a raw-ready candidate, and keeps raw outputs in the receipt", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lcx-system-shadow-test-"));
    const receipt = path.join(directory, "receipt.json");
    const fake = makeFakePython(directory, validPlan);
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/lcx-system-shadow.ts",
          "--python",
          fake.path,
          "--no-adapter",
          "--case-id",
          "portfolio_mixed_q_t_nvda",
          "--n",
          "2",
          "--temperature",
          "0.4",
          "--seed",
          "17",
          "--receipt",
          receipt,
          "--json",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        requested: { n: number; temperature: number; seed: number };
        summary: { sampleCount: number; rawPassCount: number; promotionReady: boolean };
        proof: Record<string, unknown>;
        cases: Array<{
          selectedSampleId: string | null;
          rawReadyCandidateIds: string[];
          samples: Array<{
            seed: number;
            contractReady: boolean;
            parseRecovered: boolean;
            rawOutputTruncated: boolean;
          }>;
        }>;
      };
      expect(payload.summary).toMatchObject({
        sampleCount: 2,
        rawPassCount: 2,
        promotionReady: false,
      });
      expect(payload.requested).toMatchObject({ n: 2, temperature: 0.4, seed: 17 });
      expect(payload.proof).toMatchObject({
        systemLevelOnly: true,
        verifierBackfillsMissingFields: false,
        verifierUsesHardening: false,
        verifierUsesRetry: false,
        modelWeightAbsorbed: false,
        promotionReady: false,
      });
      expect(payload.cases[0]).toMatchObject({
        selectedSampleId: "portfolio_mixed_q_t_nvda#1",
        rawReadyCandidateIds: ["portfolio_mixed_q_t_nvda#1", "portfolio_mixed_q_t_nvda#2"],
      });
      expect(payload.cases[0]?.samples.map((sample) => sample.seed)).toEqual([17, 18]);
      expect(payload.cases[0]?.samples.every((sample) => !sample.parseRecovered)).toBe(true);
      expect(payload.cases[0]?.samples.every((sample) => !sample.rawOutputTruncated)).toBe(true);

      const receiptPayload = JSON.parse(readFileSync(receipt, "utf8")) as {
        scorer: string;
        cases: Array<{
          featureSignature: string | null;
          scorerTarget: { requiredModules: string[]; minModuleMatches: number };
          samples: Array<{ rawOutput: string }>;
        }>;
      };
      expect(receiptPayload.scorer).toBe("lcx-system-shadow-raw-contract-v1");
      expect(receiptPayload.cases[0]).toMatchObject({
        featureSignature: null,
        scorerTarget: { requiredModules: expect.any(Array), minModuleMatches: 3 },
      });
      expect(receiptPayload.cases[0]?.samples).toHaveLength(2);
      expect(receiptPayload.cases[0]?.samples[0]?.rawOutput).toBe(validPlan);

      const args = readFileSync(fake.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(args).toHaveLength(2);
      expect(args.every((entry) => !entry.includes("--prefill-response"))).toBe(true);
      expect(args[0]).toContain("--seed");
      expect(args[0]).toContain("17");
      expect(args[1]).toContain("18");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records malformed raw output as parse_error without retry or recovery", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lcx-system-shadow-parse-"));
    const fake = makeFakePython(directory, '{"task_family":"partial');
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/lcx-system-shadow.ts",
          "--python",
          fake.path,
          "--no-adapter",
          "--case-id",
          "portfolio_mixed_q_t_nvda",
          "--n",
          "2",
          "--json",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        summary: { parseErrorCount: number; rawPassCount: number };
        cases: Array<{
          samples: Array<{ status: string; parseRecovered: boolean; error?: string }>;
        }>;
      };
      expect(payload.summary).toMatchObject({ parseErrorCount: 2, rawPassCount: 0 });
      expect(payload.cases[0]?.samples).toEqual([
        expect.objectContaining({ status: "parse_error", parseRecovered: false }),
        expect.objectContaining({ status: "parse_error", parseRecovered: false }),
      ]);
      expect(payload.cases[0]?.samples[0]?.error).toContain("raw output");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a receipt when stdout is summary-only", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/lcx-system-shadow.ts",
        "--no-adapter",
        "--case-id",
        "portfolio_mixed_q_t_nvda",
        "--summary-only",
        "--json",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--summary-only requires --receipt");
  });

  it("retains partial raw output when the generator exits non-zero", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lcx-system-shadow-exit-"));
    const receipt = path.join(directory, "receipt.json");
    const fakePath = path.join(directory, "python");
    writeFileSync(
      fakePath,
      [
        "#!/usr/bin/env node",
        'process.stdout.write(\'{\\"task_family\\":\\"partial\');',
        "process.exit(3);",
      ].join("\n"),
      { mode: 0o755 },
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/lcx-system-shadow.ts",
          "--python",
          fakePath,
          "--no-adapter",
          "--case-id",
          "portfolio_mixed_q_t_nvda",
          "--receipt",
          receipt,
          "--json",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        summary: { generationErrorCount: number; rawPassCount: number };
        cases: Array<{ samples: Array<{ status: string; rawOutput: string }> }>;
      };
      expect(payload.summary).toMatchObject({ generationErrorCount: 1, rawPassCount: 0 });
      expect(payload.cases[0]?.samples[0]).toMatchObject({
        status: "generation_error",
        rawOutput: '{"task_family":"partial',
      });
      const receiptPayload = JSON.parse(readFileSync(receipt, "utf8")) as {
        cases: Array<{ samples: Array<{ rawOutput: string }> }>;
      };
      expect(receiptPayload.cases[0]?.samples[0]?.rawOutput).toBe('{"task_family":"partial');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a generated holdout row while keeping its target outside the prompt", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lcx-system-shadow-holdout-"));
    const holdoutPath = path.join(directory, "holdout.jsonl");
    const receipt = path.join(directory, "receipt.json");
    const fake = makeFakePython(directory, validPlan);
    const generated = generateCases(1, {
      seed: 20260831,
      split: "holdout",
      holdoutFraction: 0.2,
    })[0];
    if (!generated) {
      throw new Error("expected one generated holdout case");
    }
    writeFileSync(
      holdoutPath,
      `${JSON.stringify({
        id: generated.id,
        userAsk: generated.userAsk,
        featureSignature: generated.featureSignature,
        provenance: {
          schemaVersion: GENERALIZATION_CASE_SCHEMA_VERSION,
          generator: GENERALIZATION_GENERATOR_ID,
          generatorVersion: GENERALIZATION_GENERATOR_VERSION,
          split: "holdout",
          seed: 20260831,
          holdoutFraction: 0.2,
        },
        target: {
          requiredModules: [],
          forbiddenModules: [],
          minModuleMatches: 0,
          requiredMissingData: [],
          requiredRiskBoundaries: [],
        },
      })}\n`,
      "utf8",
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/lcx-system-shadow.ts",
          "--python",
          fake.path,
          "--no-adapter",
          "--case-id",
          "portfolio_mixed_q_t_nvda",
          "--case-file",
          holdoutPath,
          "--n",
          "1",
          "--temperature",
          "0",
          "--seed",
          "7",
          "--receipt",
          receipt,
          "--json",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        requested: { caseFile: string; caseIds: string[] };
        cases: Array<{ caseId: string; caseSource: string; selectedSampleId: string | null }>;
      };
      expect(payload.requested.caseFile).toBe(holdoutPath);
      expect(payload.requested.caseIds).toEqual(["portfolio_mixed_q_t_nvda", generated.id]);
      expect(payload.cases[0]).toMatchObject({
        caseId: "portfolio_mixed_q_t_nvda",
        caseSource: "fixed_registry",
      });
      expect(payload.cases[1]).toMatchObject({
        caseId: generated.id,
        caseSource: "generated_holdout_file",
        selectedSampleId: `${generated.id}#1`,
      });
      const receiptPayload = JSON.parse(readFileSync(receipt, "utf8")) as {
        cases: Array<{
          scorerTarget: { requiredModules: string[] };
        }>;
      };
      expect(receiptPayload.cases[1]?.scorerTarget.requiredModules).toEqual([]);
      const args = readFileSync(fake.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const promptArgs = args.find((entry) =>
        entry.some((value) => value.includes(`user_or_task: ${generated.userAsk}`)),
      );
      const prompt = promptArgs?.[promptArgs.indexOf("--prompt") + 1] ?? "";
      expect(prompt).toContain(`user_or_task: ${generated.userAsk}`);
      expect(prompt).not.toContain("source_summary:");
      expect(prompt).not.toContain(JSON.stringify(generated.requiredModules));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
