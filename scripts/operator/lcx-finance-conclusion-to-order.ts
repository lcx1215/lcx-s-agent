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
import { evaluateConclusionToMandate } from "../../src/agents/finance-conclusion-to-mandate.js";
import type { FinanceRegime } from "../../src/agents/finance-mandate.js";

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
  // The `!conclusionFile` clause is redundant at runtime — that case already pushed into `fatal`
  // — but a check on `fatal.length` does not narrow the argument, so without it the file read
  // below sees `string | undefined`. Restating it here is what lets the typechecker follow.
  if (fatal.length > 0 || !conclusionFile) {
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

  // The shared back half. One implementation, so this path and the research turn
  // cannot drift apart again - they already had, on whether a regime reaches the
  // mandate.
  const decision = evaluateConclusionToMandate({
    raw,
    referencePrice,
    referencePriceAt: asOf,
    equity,
    runAuthorizationId,
    ...(regime === undefined ? {} : { regime }),
  });

  if (!decision.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, stage: decision.stage, refusals: decision.refusals }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: decision.passed,
        stage: "mandate",
        strategyClass: decision.strategyClass,
        regime: decision.regime,
        mandate: decision.mandate,
        intent: decision.intent,
        notes: decision.notes,
      },
      null,
      2,
    )}\n`,
  );
  if (!decision.passed) {
    process.exitCode = 1;
  }
}

await main();
