#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { syncAlpacaIntradayBars } from "../../src/agents/finance-alpaca-intraday.js";
import { readFinanceIntradayLedger } from "../../src/agents/finance-intraday-ledger.js";
import { runFinanceIntradayPaperReplay } from "../../src/agents/finance-intraday-paper.js";
import { resolveFinanceStateDir } from "../../src/agents/finance-state-dir.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: readonly string[], flag: string): string {
  const value = valueAfter(args, flag)?.trim();
  if (!value) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function numberAfter(args: readonly string[], flag: string): number {
  const value = Number(required(args, flag));
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} must be finite`);
  }
  return value;
}

export async function buildFinanceIntradayPaperPayload(args: readonly string[]) {
  const instrument = required(args, "--instrument").toUpperCase();
  const from = required(args, "--from");
  const to = required(args, "--to");
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from >= to) {
    throw new Error("--from and --to must be ordered ISO timestamps");
  }
  const location = resolveFinanceStateDir({ directory: valueAfter(args, "--ledger-dir") });
  const intervalSeconds = Number(valueAfter(args, "--interval-seconds") ?? 300);
  if (![60, 300, 900].includes(intervalSeconds)) {
    throw new Error("--interval-seconds must be 60, 300, or 900");
  }
  const feed = valueAfter(args, "--feed") ?? "iex";
  if (feed !== "iex" && feed !== "sip") {
    throw new Error("--feed must be iex or sip");
  }
  const sync = args.includes("--sync-alpaca")
    ? await syncAlpacaIntradayBars({
        directory: location.directory,
        instrument,
        start: from,
        end: to,
        intervalSeconds: intervalSeconds as 60 | 300 | 900,
        feed,
      })
    : null;
  // Historical bars collected after the requested window are still valid replay inputs; their
  // later collection timestamp remains in the ledger and must not be rewritten as if known then.
  const ledger = await readFinanceIntradayLedger(location.directory, { instrument });
  const bars = ledger.bars.filter((bar) => bar.startAt >= from && bar.endAt <= to);
  const receipt = runFinanceIntradayPaperReplay({
    bars,
    ledgerHeadRef: ledger.headRef,
    config: {
      openingRangeBars: Number(valueAfter(args, "--opening-range-bars") ?? 6),
      capital: numberAfter(args, "--capital"),
      maxAllocationFraction: numberAfter(args, "--max-allocation"),
      feeBpsPerSide: numberAfter(args, "--fee-bps-per-side"),
      spreadBps: numberAfter(args, "--spread-bps"),
      slippageBpsPerSide: numberAfter(args, "--slippage-bps-per-side"),
      rewardRisk: Number(valueAfter(args, "--reward-risk") ?? 2),
    },
  });
  return Object.freeze({
    waterflow: "finance_intraday_paper_waterflow",
    boundary: "local_research_and_paper_replay_only",
    source: {
      directory: location.directory,
      directorySource: location.source,
      ledgerHeadRef: ledger.headRef,
      ledgerRecordCount: ledger.recordCount,
      selectedBars: bars.length,
      from,
      to,
      sync,
    },
    receipt,
    claims: {
      networkTouched: sync !== null,
      credentialsRead: sync !== null,
      orderPlaced: false,
      alphaProven: false,
    },
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: lcx-finance-intraday-paper --instrument SPY --from ISO --to ISO --capital N " +
        "--max-allocation FRACTION --fee-bps-per-side N --spread-bps N " +
        "--slippage-bps-per-side N [--opening-range-bars N] [--ledger-dir DIR] " +
        "[--reward-risk N] [--sync-alpaca --interval-seconds 60|300|900 --feed iex|sip] [--json]\n",
    );
    return;
  }
  const payload = await buildFinanceIntradayPaperPayload(args);
  process.stdout.write(`${JSON.stringify(payload, null, args.includes("--json") ? 2 : 0)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
