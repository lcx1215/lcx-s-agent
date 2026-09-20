/**
 * Bridge: research conclusion -> validated intent -> mandate verdict.
 *
 * This is the wire between the model layer and the execution entry. It does not
 * place orders itself: it resolves a conclusion into an intent the execution
 * entry already knows how to gate and place, so there is exactly one path to a
 * venue and the gate cannot be skipped by calling a different script.
 *
 * The chain it runs:
 *
 *   conclusion JSON -> intake (evidence, sources) -> intent compiler (size, refusals)
 *                   -> mandate (class rules, regime) -> verdict
 *
 * A refusal anywhere stops here and is printed with its reasons. Nothing is
 * printed as an order unless every stage passed.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-conclusion-to-order.ts \
 *     --conclusion-file PATH --reference-price N --as-of ISO \
 *     --equity N --run-authorization ID [--regime normal|risk_off|liquidity_tightening]
 */

import { readFileSync } from "node:fs";
import { parseResearchConclusion } from "../../src/agents/finance-conclusion-intake.js";
import { compileExecutionIntent } from "../../src/agents/finance-intent-compiler.js";
import {
  classifyFinanceStrategy,
  evaluateFinanceMandate,
  type FinanceRegime,
} from "../../src/agents/finance-mandate.js";

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: node --import tsx scripts/operator/lcx-finance-conclusion-to-order.ts " +
        "--conclusion-file PATH --reference-price N --as-of ISO --equity N " +
        "--run-authorization ID [--regime normal|risk_off|liquidity_tightening]\n",
    );
    return;
  }

  const conclusionFile = readArg(args, "--conclusion-file");
  const referencePrice = Number(readArg(args, "--reference-price"));
  const asOf = readArg(args, "--as-of") ?? "";
  const equity = Number(readArg(args, "--equity"));
  const runAuthorizationId = readArg(args, "--run-authorization") ?? "";
  const regime = (readArg(args, "--regime") ?? "normal") as FinanceRegime;

  const fatal: string[] = [];
  if (!conclusionFile) {
    fatal.push("--conclusion-file is required");
  }
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    fatal.push("--reference-price must be a positive number");
  }
  if (!asOf) {
    fatal.push("--as-of is required");
  }
  if (!Number.isFinite(equity) || equity <= 0) {
    fatal.push("--equity must be a positive number");
  }
  if (!runAuthorizationId) {
    fatal.push("--run-authorization is required");
  }
  if (fatal.length > 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, refusals: fatal }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(conclusionFile, "utf8"));
  } catch {
    process.stdout.write(
      `${JSON.stringify({ ok: false, refusals: ["cannot read or parse the conclusion file"] }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const intake = parseResearchConclusion(raw);
  if (!intake.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, stage: "intake", refusals: intake.refusals }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const strategyClass = classifyFinanceStrategy({
    assetClass: intake.conclusion.assetClass,
    ...(intake.conclusion.horizonDays !== undefined
      ? { holdingPeriodDays: intake.conclusion.horizonDays }
      : {}),
  });

  const compiled = compileExecutionIntent({
    conclusion: intake.conclusion,
    market: { referencePrice, referencePriceAt: asOf },
    equity,
    runAuthorizationId,
    ...(strategyClass !== "unknown" ? { strategyClass } : {}),
  });
  if (!compiled.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, stage: "compile", refusals: compiled.refusals }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Risk, not notional. The mandate caps what is lost if the stop is hit, and
  // the compiler already sized the trade on that basis; comparing the notional
  // here would reject every stop-based trade, since notional is many times the
  // risk whenever a stop is close.
  const stopDistance =
    intake.conclusion.invalidationPrice === undefined
      ? referencePrice
      : Math.abs(referencePrice - intake.conclusion.invalidationPrice);
  const riskFractionOfEquity = (compiled.intent.quantity * stopDistance) / equity;

  const mandate = evaluateFinanceMandate({
    strategy: { assetClass: intake.conclusion.assetClass },
    riskFractionOfEquity,
    drawdownFraction: 0,
    stopLossDefined: intake.conclusion.invalidationPrice !== undefined,
    hasSignificantAutocorrelation: true,
    regime,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: mandate.verdict === "pass",
        stage: "mandate",
        strategyClass,
        regime,
        mandate,
        intent: mandate.verdict === "pass" ? compiled.intent : undefined,
        notes: compiled.notes,
      },
      null,
      2,
    )}\n`,
  );
  if (mandate.verdict !== "pass") {
    process.exitCode = 1;
  }
}

await main();
