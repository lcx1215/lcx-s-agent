#!/usr/bin/env node
/**
 * Owner entry for the durable thesis ledger.
 *
 * A thesis is a claim the owner made about an instrument plus the conditions that would prove
 * it wrong. This entry opens one, closes one, and reads the book back. Two properties matter
 * more than convenience here:
 *
 * - **Refusals are reported, not swallowed.** A transition for a thesis that was never opened,
 *   or a second transition for one already closed, is a named error that also leaves the book
 *   untouched. It is not coerced into a state.
 * - **Closing is terminal.** A closed thesis is history; a new belief is a new thesis. There is
 *   no re-open path, because "the thesis changed" and "the owner changed their mind" are
 *   different claims and only the owner can tell them apart — so the ledger stores neither and
 *   leaves the distinction to a new record.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-thesis-ledger.ts [--json] \
 *     [--dir PATH] [--open FILE] [--transition FILE] [--as-of ISO]
 */

import fs from "node:fs/promises";
import {
  financeThesisLedgerPath,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import {
  openFinanceThesis,
  readFinanceThesisLedger,
  transitionFinanceThesis,
} from "../../src/agents/finance-thesis-ledger.js";

type Options = {
  json: boolean;
  directory: string;
  openFile: string;
  transitionFile: string;
  asOf: string;
};

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    json: false,
    directory: "",
    openFile: "",
    transitionFile: "",
    asOf: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dir") {
      options.directory = next ?? "";
      index += 1;
    } else if (arg === "--open") {
      options.openFile = next ?? "";
      index += 1;
    } else if (arg === "--transition") {
      options.transitionFile = next ?? "";
      index += 1;
    } else if (arg === "--as-of") {
      options.asOf = next ?? "";
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-finance-thesis-ledger.ts [--json] " +
          "[--dir PATH] [--open FILE] [--transition FILE] [--as-of ISO]",
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const state = resolveFinanceStateDir(
    options.directory.length > 0 ? { directory: options.directory } : {},
  );
  const database = financeThesisLedgerPath(state.directory);

  const appends: unknown[] = [];
  let error: string | null = null;
  let databaseWritten = false;

  try {
    if (options.openFile.length > 0) {
      const result = await openFinanceThesis(state.directory, await readJsonFile(options.openFile));
      databaseWritten = databaseWritten || result.appended;
      appends.push({ kind: "opened", appended: result.appended, ref: result.record.ref });
    }
    if (options.transitionFile.length > 0) {
      const result = await transitionFinanceThesis(
        state.directory,
        await readJsonFile(options.transitionFile),
      );
      databaseWritten = databaseWritten || result.appended;
      appends.push({
        kind: "transition",
        appended: result.appended,
        ref: result.record.ref,
      });
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const ledger = await readFinanceThesisLedger(state.directory, {
    asOf: options.asOf.length > 0 ? options.asOf : undefined,
  });

  const payload = {
    ok: error === null,
    ledgerDirectory: state.directory,
    directorySource: state.source,
    database,
    databaseWritten,
    /**
     * The one way this entry can act on a book the operator did not name: no `--dir` was given
     * and the workspace default was used. Reading never warns — only writing does.
     */
    directorySourceNotice:
      databaseWritten && state.source !== "explicit"
        ? `wrote to the ${state.source} book at ${state.directory}; pass --dir to name one explicitly`
        : null,
    appends,
    error,
    recordCount: ledger.recordCount,
    headRef: ledger.headRef,
    thesisCount: ledger.theses.length,
    openThesisCount: ledger.theses.filter((item) => item.state === "active").length,
    theses: ledger.theses,
    boundary: "finance_thesis_ledger_research_only",
    notTouched: [
      "trading_execution",
      "order_placement",
      "provider_config",
      "external_channel_sender",
      "protected_memory",
    ],
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`thesis ledger: ${state.directory} (${state.source})`);
    console.log(`records: ${ledger.recordCount}  theses: ${ledger.theses.length}`);
    if (error !== null) {
      console.log(`refused: ${error}`);
    }
    for (const thesis of ledger.theses) {
      const closed = thesis.closedAt === null ? "" : ` closed ${thesis.closedAt}`;
      console.log(
        `  [${thesis.state}] ${thesis.thesisId} ${thesis.instrument}${closed} — ${thesis.claim}`,
      );
      for (const condition of thesis.invalidationConditions) {
        console.log(`      invalidated if: ${condition}`);
      }
    }
    console.log("边界：只读写本地账本；不读凭据、不联网、不下单。");
  }

  if (error !== null) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
