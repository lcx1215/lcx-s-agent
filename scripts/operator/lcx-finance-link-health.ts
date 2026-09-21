/**
 * Is the finance plane wired end to end? Command line form of `readFinanceLinkHealth`.
 *
 * Read-only, and exit 1 when a check fails, so it can be run by something that acts on the
 * answer. The checks themselves live in `src/agents/finance-link-health.ts` because the daily
 * cycle reports them too: an operator who has to remember to run this is an operator who finds
 * out late.
 */

import { readFinanceLinkHealth } from "../../src/agents/finance-link-health.js";

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const health = await readFinanceLinkHealth({ directory: argValue(args, "--dir") });

  if (json) {
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  } else {
    for (const check of health.checks) {
      const mark =
        check.severity === "error" ? "FAIL" : check.severity === "warn" ? "warn" : " ok ";
      process.stdout.write(`${mark}  ${check.id.padEnd(25)}${check.summary}\n`);
    }
    process.stdout.write(`\n${health.nextAction}\n`);
  }

  if (!health.ok) {
    process.exitCode = 1;
  }
}

await main();
