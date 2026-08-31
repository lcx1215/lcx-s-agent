#!/usr/bin/env node
/**
 * Bounded, read-only system shadow for the local-brain JSON contract.
 *
 * This owner deliberately does not import local-brain-distill-eval.ts: that
 * file is an executable evaluator with adapter/promotion side effects at
 * module load.  The scorer below mirrors its neutral seven-condition contract
 * without normalization, hardening, retries, recovery, or label disclosure.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GENERALIZATION_CASE_SCHEMA_VERSION,
  GENERALIZATION_GENERATOR_ID,
  GENERALIZATION_GENERATOR_VERSION,
  isFeatureSignatureHeldOut,
} from "./local-brain-generalization-generator.js";
import {
  LOCAL_BRAIN_MODULE_TAXONOMY,
  LOCAL_BRAIN_RISK_BOUNDARIES,
} from "./local-brain-taxonomy.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_CWD = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_PYTHON = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  ".venv",
  "bin",
  "python",
);
const MAX_CASES = 20;
const MAX_SAMPLES = 16;
const MAX_TOTAL_SAMPLES = 80;
const MAX_RAW_OUTPUT_CHARS = 1_000_000;
const REQUIRED_KEYS = [
  "task_family",
  "primary_modules",
  "supporting_modules",
  "required_tools",
  "missing_data",
  "risk_boundaries",
  "next_step",
  "rejected_context",
] as const;

export type ShadowCase = {
  id: string;
  userAsk: string;
  requiredModules: string[];
  forbiddenModules?: string[];
  minModuleMatches: number;
  requiredMissingData?: string[];
  requiredRiskBoundaries?: string[];
  featureSignature?: string;
  caseSource: "fixed_registry" | "generated_holdout_file";
};

type Score = {
  ok: boolean;
  missingKeys: string[];
  invalidFieldTypes: string[];
  matchedModules: string[];
  missingModules: string[];
  forbiddenModuleMatches: string[];
  missingRequiredData: string[];
  missingRequiredRiskBoundaries: string[];
  boundaryOk: boolean;
  oldContextRejected: boolean;
};

export type CliOptions = {
  model: string;
  adapterPath?: string;
  noAdapter: boolean;
  pythonBin: string;
  caseIds: string[];
  caseFile?: string;
  samples: number;
  temperature: number;
  seed: number;
  timeoutMs: number;
  receiptPath?: string;
  json: boolean;
  summaryOnly: boolean;
};

type GeneratedCaseRow = {
  id?: unknown;
  userAsk?: unknown;
  featureSignature?: unknown;
  provenance?: unknown;
  target?: unknown;
};

type RawSample = {
  sampleId: string;
  seed: number;
  status: "passed" | "failed" | "parse_error" | "generation_error" | "timeout";
  rawOutput: string;
  rawOutputSha256: string | null;
  outputChars: number;
  rawOutputTruncated: boolean;
  parseRecovered: false;
  contractReady: boolean;
  score?: Score;
  error?: string;
  stderr?: string;
};

const FIXED_CASES: Record<string, ShadowCase> = {
  portfolio_mixed_q_t_nvda: {
    id: "portfolio_mixed_q_t_nvda",
    userAsk:
      "我持有QQQ、TLT和少量NVDA，未来两周担心利率、AI capex、美元流动性。请先规划内部模块，不要给交易建议。",
    requiredModules: [
      "macro_rates_inflation",
      "credit_liquidity",
      "etf_regime",
      "company_fundamentals_value",
      "portfolio_risk_gates",
    ],
    minModuleMatches: 3,
    caseSource: "fixed_registry",
  },
  index_concentration_mag7_portfolio_risk: {
    id: "index_concentration_mag7_portfolio_risk",
    userAsk:
      "纳指和标普如果越来越集中在 Mag7，我持有 QQQ 和 NVDA 时，怎么拆指数权重、市场宽度、估值、组合暴露和反方论证？",
    requiredModules: [
      "us_equity_market_structure",
      "global_index_regime",
      "company_fundamentals_value",
      "quant_math",
      "portfolio_risk_gates",
      "causal_map",
      "review_panel",
    ],
    minModuleMatches: 6,
    requiredMissingData: [
      "fresh_market_data_snapshot",
      "us_equity_breadth_earnings_and_valuation_inputs",
      "index_constituents_weights_and_technical_regime_inputs",
      "portfolio_weights_and_risk_limits",
    ],
    caseSource: "fixed_registry",
  },
  short_lark_commodity_scope_01: {
    id: "short_lark_commodity_scope_01",
    userAsk: "学习原油。",
    requiredModules: [
      "finance_learning_memory",
      "source_registry",
      "macro_rates_inflation",
      "commodities_oil_gold",
      "portfolio_risk_gates",
      "review_panel",
    ],
    minModuleMatches: 5,
    requiredMissingData: [
      "source_url_or_local_source_path",
      "actual_reading_scope_receipt",
      "commodity_curve_roll_yield_and_inventory_inputs",
    ],
    requiredRiskBoundaries: ["commodity_framework_not_trade_signal", "no_trade_advice"],
    caseSource: "fixed_registry",
  },
  short_lark_commodity_scope_04: {
    id: "short_lark_commodity_scope_04",
    userAsk: "大宗商品这块补一下本地大脑。",
    requiredModules: [
      "finance_learning_memory",
      "source_registry",
      "macro_rates_inflation",
      "commodities_oil_gold",
      "portfolio_risk_gates",
      "review_panel",
    ],
    minModuleMatches: 5,
    requiredMissingData: [
      "source_url_or_local_source_path",
      "actual_reading_scope_receipt",
      "commodity_curve_roll_yield_and_inventory_inputs",
    ],
    requiredRiskBoundaries: ["commodity_framework_not_trade_signal", "no_trade_advice"],
    caseSource: "fixed_registry",
  },
  adversarial_scenario_no_guess_02: {
    id: "adversarial_scenario_no_guess_02",
    userAsk: "没有数据也给个大概概率吧。",
    requiredModules: [
      "macro_rates_inflation",
      "credit_liquidity",
      "quant_math",
      "portfolio_risk_gates",
      "review_panel",
    ],
    minModuleMatches: 4,
    requiredMissingData: [
      "position_weights_and_return_series",
      "portfolio_weights_and_risk_limits",
      "current_rates_and_inflation_inputs",
    ],
    requiredRiskBoundaries: ["no_model_math_guessing", "no_trade_advice"],
    caseSource: "fixed_registry",
  },
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-system-shadow.ts (--adapter PATH | --no-adapter) --case-id ID[,ID...] [options]",
      "       ... --case-file HOLDOUT.jsonl [--case-id FIXED_ID[,FIXED_ID...]]",
      "Options: --model MODEL --n N --temperature T --seed N --timeout-ms N --python BIN --receipt PATH --json --summary-only",
      "When --case-file is supplied with --case-id, all validated holdout rows are included alongside the named fixed cases.",
      "The owner is neutral/raw only: no prefill, hardening, retry, backfill, promotion, provider, Lark, or protected-memory authority.",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function positiveInteger(value: string, name: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be an integer in [1, ${max}]`);
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    model: "Qwen/Qwen3-0.6B",
    noAdapter: false,
    pythonBin: DEFAULT_PYTHON,
    caseIds: [],
    samples: 1,
    temperature: 0,
    seed: 1,
    timeoutMs: 180_000,
    json: false,
    summaryOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      options.model = readValue(args, index);
      index += 1;
    } else if (arg === "--adapter") {
      const adapter = readValue(args, index);
      if (adapter === "latest-passing" || adapter === "current") {
        throw new Error("adapter selectors are forbidden; pass an explicit adapter path");
      }
      options.adapterPath = path.resolve(adapter);
      index += 1;
    } else if (arg === "--no-adapter") {
      options.noAdapter = true;
    } else if (arg === "--python") {
      options.pythonBin = readValue(args, index);
      index += 1;
    } else if (arg === "--case-id") {
      options.caseIds.push(
        ...readValue(args, index)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      index += 1;
    } else if (arg === "--case-file") {
      options.caseFile = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--n" || arg === "--samples") {
      options.samples = positiveInteger(readValue(args, index), "--n", MAX_SAMPLES);
      index += 1;
    } else if (arg === "--temperature" || arg === "--temp") {
      const parsed = Number(readValue(args, index));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
        throw new Error("--temperature must be a finite number in [0, 2]");
      }
      options.temperature = parsed;
      index += 1;
    } else if (arg === "--seed") {
      const parsed = Number(readValue(args, index));
      if (!Number.isSafeInteger(parsed)) {
        throw new Error("--seed must be a safe integer");
      }
      options.seed = parsed;
      index += 1;
    } else if (arg === "--timeout-ms") {
      const parsed = Number(readValue(args, index));
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 600_000) {
        throw new Error("--timeout-ms must be an integer in [1, 600000]");
      }
      options.timeoutMs = parsed;
      index += 1;
    } else if (arg === "--receipt") {
      options.receiptPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--summary-only") {
      options.summaryOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (options.adapterPath && options.noAdapter) {
    throw new Error("choose exactly one of --adapter or --no-adapter");
  }
  if (!options.adapterPath && !options.noAdapter) {
    options.noAdapter = true;
  }
  if (options.caseIds.length === 0 && !options.caseFile) {
    throw new Error("at least one --case-id or --case-file is required");
  }
  options.caseIds = [...new Set(options.caseIds)];
  if (options.caseIds.length > MAX_CASES) {
    throw new Error(`at most ${MAX_CASES} case ids are allowed`);
  }
  if (options.caseIds.length * options.samples > MAX_TOTAL_SAMPLES) {
    throw new Error(`case count x N must be <= ${MAX_TOTAL_SAMPLES}`);
  }
  if (options.summaryOnly && !options.receiptPath) {
    throw new Error("--summary-only requires --receipt so raw outputs remain saved");
  }
  if (!Number.isSafeInteger(options.seed + options.samples - 1)) {
    throw new Error("seed plus N-1 must remain a safe integer");
  }
  return options;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function canonicalToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function containsCanonical(values: string[], expected: string): boolean {
  const target = canonicalToken(expected);
  return values.some((value) => canonicalToken(value) === target);
}

export function scoreRawContract(output: Record<string, unknown>, target: ShadowCase): Score {
  const missingKeys = REQUIRED_KEYS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(output, key),
  );
  const arrayFields = [
    "primary_modules",
    "supporting_modules",
    "required_tools",
    "missing_data",
    "risk_boundaries",
    "rejected_context",
  ] as const;
  const stringFields = ["task_family", "next_step"] as const;
  const invalidFieldTypes = [
    ...arrayFields.filter((field) => !isNonEmptyStringArray(output[field])),
    ...stringFields.filter((field) => typeof output[field] !== "string" || !output[field].trim()),
  ];
  const modules = new Set([
    ...stringArray(output.primary_modules),
    ...stringArray(output.supporting_modules),
    ...stringArray(output.required_tools),
  ]);
  const matchedModules = target.requiredModules.filter((entry) => modules.has(entry));
  const missingModules = target.requiredModules.filter((entry) => !modules.has(entry));
  const forbiddenModuleMatches = (target.forbiddenModules ?? []).filter((entry) =>
    modules.has(entry),
  );
  const missingData = stringArray(output.missing_data);
  const missingRequiredData = (target.requiredMissingData ?? []).filter(
    (entry) => !containsCanonical(missingData, entry),
  );
  const riskBoundaries = stringArray(output.risk_boundaries);
  const missingRequiredRiskBoundaries = (target.requiredRiskBoundaries ?? []).filter(
    (entry) => !containsCanonical(riskBoundaries, entry),
  );
  const rejectedContext = stringArray(output.rejected_context);
  const boundaryOk =
    riskBoundaries.includes("research_only") || riskBoundaries.includes("no_execution_authority");
  const oldContextRejected = containsCanonical(rejectedContext, "old_lark_conversation_history");
  return {
    ok:
      missingKeys.length === 0 &&
      invalidFieldTypes.length === 0 &&
      boundaryOk &&
      oldContextRejected &&
      matchedModules.length >= target.minModuleMatches &&
      forbiddenModuleMatches.length === 0 &&
      missingRequiredData.length === 0 &&
      missingRequiredRiskBoundaries.length === 0,
    missingKeys: [...missingKeys],
    invalidFieldTypes: [...invalidFieldTypes],
    matchedModules,
    missingModules,
    forbiddenModuleMatches,
    missingRequiredData,
    missingRequiredRiskBoundaries,
    boundaryOk,
    oldContextRejected,
  };
}

function strictJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("raw output must be exactly one JSON object with no surrounding text");
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("raw output JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildNeutralPrompt(userAsk: string): string {
  return [
    "You are the LCX Agent local auxiliary thought-flow model.",
    "Blind neutral raw-contract eval: infer the contract from only the user/task.",
    "/no_think",
    "No prose, no markdown, no <think>, no explanations, no nested objects.",
    '{"task_family":"snake_case","primary_modules":[],"supporting_modules":[],"required_tools":[],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"snake_case_action","rejected_context":["old_lark_conversation_history"]}',
    "Return one single-line JSON object only; close the final brace and do not echo an answer template.",
    `Allowed module ids (choose only those justified by the task): ${LOCAL_BRAIN_MODULE_TAXONOMY.join(", ")}.`,
    `Allowed risk_boundary ids (choose only those justified by the task): ${LOCAL_BRAIN_RISK_BOUNDARIES.join(", ")}.`,
    "Infer missing_data ids yourself from the task; no case-specific checklist or expected id is provided.",
    "Do not invent current or timestamped market data, execution approval, probabilities, or durable memory writes.",
    "For scenario probabilities with missing samples, weights, returns, or macro inputs, do not guess; route to data-gated research preflight.",
    `user_or_task: ${userAsk}`,
  ].join("\n");
}

type GenerationResult = {
  raw: string;
  stderr: string;
  timedOut: boolean;
  rawOutputTruncated: boolean;
  exitCode: number | null;
  error?: string;
};

function runGeneration(
  options: CliOptions,
  prompt: string,
  seed: number,
): Promise<GenerationResult> {
  return new Promise((resolve) => {
    const args = [
      "-m",
      "mlx_lm",
      "generate",
      "--model",
      options.model,
      "--prompt",
      prompt,
      "--max-tokens",
      "360",
      "--temp",
      String(options.temperature),
      "--seed",
      String(seed),
      "--verbose",
      "false",
      "--chat-template-config",
      '{"enable_thinking":false}',
    ];
    if (options.adapterPath) {
      args.push("--adapter-path", options.adapterPath);
    }
    const child = spawn(options.pythonBin, args, {
      cwd: WORKTREE_CWD,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let raw = "";
    let stderr = "";
    let timedOut = false;
    let rawOutputTruncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 250).unref();
    }, options.timeoutMs);
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        raw,
        stderr,
        timedOut,
        rawOutputTruncated,
        exitCode: null,
        error: error?.message,
      });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (raw.length < MAX_RAW_OUTPUT_CHARS) {
        const remaining = MAX_RAW_OUTPUT_CHARS - raw.length;
        const accepted = chunk.slice(0, remaining);
        raw += accepted;
        rawOutputTruncated ||= accepted.length < chunk.length;
      } else {
        rawOutputTruncated = true;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_000) {
        stderr += chunk.slice(0, 4_000 - stderr.length);
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        raw,
        stderr,
        timedOut,
        rawOutputTruncated,
        exitCode: code,
        error: !timedOut && code !== 0 ? `mlx_lm generate exited ${code ?? "unknown"}` : undefined,
      });
    });
  });
}

function parseStringArray(record: Record<string, unknown>, field: string, label: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} has invalid ${field}`);
  }
  return value.map((entry) => (entry as string).trim());
}

function readHoldoutFile(filePath: string): ShadowCase[] {
  if (!existsSync(filePath)) {
    throw new Error(`holdout file does not exist: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length === 0 || lines.length > MAX_CASES) {
    throw new Error(`holdout file must contain 1-${MAX_CASES} rows`);
  }
  const seen = new Set<string>();
  let provenanceKey: string | undefined;
  const cases: ShadowCase[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: GeneratedCaseRow;
    try {
      parsed = JSON.parse(line) as GeneratedCaseRow;
    } catch (error) {
      throw new Error(`invalid holdout JSON at line ${index + 1}: ${String(error)}`, {
        cause: error,
      });
    }
    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    const userAsk = typeof parsed.userAsk === "string" ? parsed.userAsk.trim() : "";
    const signature =
      typeof parsed.featureSignature === "string" ? parsed.featureSignature.trim() : "";
    const provenance =
      parsed.provenance &&
      typeof parsed.provenance === "object" &&
      !Array.isArray(parsed.provenance)
        ? (parsed.provenance as Record<string, unknown>)
        : undefined;
    const target =
      parsed.target && typeof parsed.target === "object" && !Array.isArray(parsed.target)
        ? (parsed.target as Record<string, unknown>)
        : undefined;
    if (!id || !userAsk || !signature || !provenance || !target) {
      throw new Error(
        `holdout row ${index + 1} must include id/userAsk/featureSignature/provenance/target`,
      );
    }
    const typedProvenance = {
      schemaVersion: provenance.schemaVersion,
      generator: provenance.generator,
      generatorVersion: provenance.generatorVersion,
      split: provenance.split,
      seed: provenance.seed,
      holdoutFraction: provenance.holdoutFraction,
    };
    const validProvenance =
      typedProvenance.schemaVersion === GENERALIZATION_CASE_SCHEMA_VERSION &&
      typedProvenance.generator === GENERALIZATION_GENERATOR_ID &&
      typedProvenance.generatorVersion === GENERALIZATION_GENERATOR_VERSION &&
      typedProvenance.split === "holdout" &&
      Number.isSafeInteger(typedProvenance.seed) &&
      typeof typedProvenance.holdoutFraction === "number" &&
      typedProvenance.holdoutFraction > 0 &&
      typedProvenance.holdoutFraction < 1 &&
      isFeatureSignatureHeldOut(signature, typedProvenance.holdoutFraction);
    if (!validProvenance) {
      throw new Error(`holdout row ${id} has invalid holdout provenance`);
    }
    const nextProvenanceKey = JSON.stringify(typedProvenance);
    if (provenanceKey && provenanceKey !== nextProvenanceKey) {
      throw new Error("holdout file mixes provenance metadata");
    }
    provenanceKey ??= nextProvenanceKey;
    if (seen.has(id) || FIXED_CASES[id]) {
      throw new Error(`duplicate or reserved holdout id: ${id}`);
    }
    const requiredModules = parseStringArray(target, "requiredModules", id);
    const forbiddenModules = parseStringArray(target, "forbiddenModules", id);
    const requiredMissingData = parseStringArray(target, "requiredMissingData", id);
    const requiredRiskBoundaries = parseStringArray(target, "requiredRiskBoundaries", id);
    const minModuleMatches =
      typeof target.minModuleMatches === "number" ? target.minModuleMatches : Number.NaN;
    if (
      !Number.isSafeInteger(minModuleMatches) ||
      minModuleMatches < 0 ||
      minModuleMatches > requiredModules.length
    ) {
      throw new Error(`holdout row ${id} has invalid minModuleMatches`);
    }
    const unknownModules = [...requiredModules, ...forbiddenModules].filter(
      (entry) => !LOCAL_BRAIN_MODULE_TAXONOMY.includes(entry as never),
    );
    if (unknownModules.length > 0) {
      throw new Error(`holdout row ${id} has unknown module ids: ${unknownModules.join(",")}`);
    }
    seen.add(id);
    cases.push({
      id,
      userAsk,
      requiredModules,
      forbiddenModules,
      minModuleMatches,
      requiredMissingData,
      requiredRiskBoundaries,
      featureSignature: signature,
      caseSource: "generated_holdout_file",
    });
  }
  return cases;
}

function resolveCases(options: CliOptions): ShadowCase[] {
  const fileCases = options.caseFile ? readHoldoutFile(options.caseFile) : [];
  if (options.caseIds.length === 0) {
    return fileCases;
  }
  const fileById = new Map(fileCases.map((entry) => [entry.id, entry]));
  const selected = options.caseIds.map((id) => {
    const fixed = FIXED_CASES[id];
    const fromFile = fileById.get(id);
    if (!fixed && !fromFile) {
      throw new Error(`unknown shadow case id: ${id}`);
    }
    return fixed ?? fromFile!;
  });
  const selectedIds = new Set(selected.map((entry) => entry.id));
  return [...selected, ...fileCases.filter((entry) => !selectedIds.has(entry.id))];
}

function compactError(error: unknown): string {
  return String(error).replace(/\s+/gu, " ").slice(0, 240);
}

function runCase(options: CliOptions, evalCase: ShadowCase): Promise<RawSample[]> {
  const samples: RawSample[] = [];
  const run = async (): Promise<void> => {
    for (let index = 0; index < options.samples; index += 1) {
      const seed = options.seed + index;
      const sampleId = `${evalCase.id}#${index + 1}`;
      try {
        const generated = await runGeneration(options, buildNeutralPrompt(evalCase.userAsk), seed);
        const raw = generated.raw;
        if (generated.timedOut) {
          samples.push({
            sampleId,
            seed,
            status: "timeout",
            rawOutput: raw,
            rawOutputSha256: raw ? hashText(raw) : null,
            outputChars: raw.length,
            rawOutputTruncated: generated.rawOutputTruncated,
            parseRecovered: false,
            contractReady: false,
            error: `generation timed out after ${options.timeoutMs}ms`,
            stderr: generated.stderr || undefined,
          });
          continue;
        }
        if (generated.exitCode !== 0) {
          samples.push({
            sampleId,
            seed,
            status: "generation_error",
            rawOutput: raw,
            rawOutputSha256: raw ? hashText(raw) : null,
            outputChars: raw.length,
            rawOutputTruncated: generated.rawOutputTruncated,
            parseRecovered: false,
            contractReady: false,
            error: generated.error ?? `mlx_lm generate exited ${generated.exitCode ?? "unknown"}`,
            stderr: generated.stderr || undefined,
          });
          continue;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = strictJson(raw);
        } catch (error) {
          samples.push({
            sampleId,
            seed,
            status: "parse_error",
            rawOutput: raw,
            rawOutputSha256: raw ? hashText(raw) : null,
            outputChars: raw.length,
            rawOutputTruncated: generated.rawOutputTruncated,
            parseRecovered: false,
            contractReady: false,
            error: compactError(error),
            stderr: generated.stderr || undefined,
          });
          continue;
        }
        const score = scoreRawContract(parsed, evalCase);
        samples.push({
          sampleId,
          seed,
          status: score.ok ? "passed" : "failed",
          rawOutput: raw,
          rawOutputSha256: hashText(raw),
          outputChars: raw.length,
          rawOutputTruncated: generated.rawOutputTruncated,
          parseRecovered: false,
          contractReady: score.ok,
          score,
          stderr: generated.stderr || undefined,
        });
      } catch (error) {
        samples.push({
          sampleId,
          seed,
          status: "generation_error",
          rawOutput: "",
          rawOutputSha256: null,
          outputChars: 0,
          rawOutputTruncated: false,
          parseRecovered: false,
          contractReady: false,
          error: compactError(error),
        });
      }
    }
  };
  return run().then(() => samples);
}

export async function runShadow(options: CliOptions): Promise<Record<string, unknown>> {
  const cases = resolveCases(options);
  if (cases.length * options.samples > MAX_TOTAL_SAMPLES) {
    throw new Error(`case count x N must be <= ${MAX_TOTAL_SAMPLES}`);
  }
  const perCase = [] as Array<Record<string, unknown>>;
  for (const evalCase of cases) {
    const samples = await runCase(options, evalCase);
    const ready = samples.filter((sample) => sample.contractReady);
    perCase.push({
      caseId: evalCase.id,
      caseSource: evalCase.caseSource,
      featureSignature: evalCase.featureSignature ?? null,
      scorerTarget: {
        requiredModules: [...evalCase.requiredModules],
        forbiddenModules: [...(evalCase.forbiddenModules ?? [])],
        minModuleMatches: evalCase.minModuleMatches,
        requiredMissingData: [...(evalCase.requiredMissingData ?? [])],
        requiredRiskBoundaries: [...(evalCase.requiredRiskBoundaries ?? [])],
      },
      candidateCount: samples.length,
      samples,
      rawReadyCandidateIds: ready.map((sample) => sample.sampleId),
      selectedSampleId: ready[0]?.sampleId ?? null,
      selectionStatus:
        ready.length > 0 ? "raw_contract_candidate_selected" : "no_raw_contract_candidate",
      selectionRule:
        "raw_contract_ready_only; first ready sample; no hardening; no field backfill; no retry; no promotion",
    });
  }
  const allSamples = perCase.flatMap((entry) => entry.samples as RawSample[]);
  const passedCount = allSamples.filter((sample) => sample.status === "passed").length;
  const rawReadyCaseCount = perCase.filter(
    (entry) => (entry.rawReadyCandidateIds as string[]).length > 0,
  ).length;
  return {
    schemaVersion: "lcx_system_shadow_receipt_v1",
    boundary: "dev_system_level_shadow_only",
    scorer: "lcx-system-shadow-raw-contract-v1",
    generatedAt: new Date().toISOString(),
    requested: {
      model: options.model,
      adapter: options.adapterPath ?? null,
      noAdapter: options.noAdapter,
      caseIds: cases.map((entry) => entry.id),
      caseFile: options.caseFile ?? null,
      n: options.samples,
      samples: options.samples,
      temperature: options.temperature,
      seed: options.seed,
      timeoutMs: options.timeoutMs,
      promptMode: "neutral",
      responsePrefill: null,
      modelSelfStartMode: "unassisted",
    },
    summary: {
      caseCount: cases.length,
      sampleCount: allSamples.length,
      rawPassCount: passedCount,
      rawReadyCaseCount,
      selectedCaseCount: rawReadyCaseCount,
      parseErrorCount: allSamples.filter((sample) => sample.status === "parse_error").length,
      timeoutCount: allSamples.filter((sample) => sample.status === "timeout").length,
      generationErrorCount: allSamples.filter((sample) => sample.status === "generation_error")
        .length,
      promotionReady: false,
    },
    proof: {
      systemLevelOnly: true,
      verifierBackfillsMissingFields: false,
      verifierUsesHardening: false,
      verifierUsesRetry: false,
      verifierUsesLabelDisclosure: false,
      modelWeightAbsorbed: false,
      promotionReady: false,
      selectedCandidateIsRuntimeAuthority: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
      externalChannelApplied: false,
      liveTouched: false,
      learningClaim: "not_proven_by_system_shadow",
    },
    cases: perCase,
    receiptPath: options.receiptPath ?? null,
  };
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
    const result = await runShadow(options);
    if (options.receiptPath) {
      mkdirSync(path.dirname(options.receiptPath), { recursive: true });
      writeFileSync(options.receiptPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    const displayResult = options.summaryOnly
      ? {
          ...result,
          cases: (result.cases as Array<Record<string, unknown>>).map(
            ({ samples: _samples, ...entry }) => entry,
          ),
        }
      : result;
    process.stdout.write(`${JSON.stringify(displayResult, null, options.json ? 2 : 0)}\n`);
  } catch (error) {
    process.stderr.write(`${compactError(error)}\n`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
