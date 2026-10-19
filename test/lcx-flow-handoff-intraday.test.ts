import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFinanceIntradayPaperPayload } from "../scripts/operator/lcx-finance-intraday-paper.js";
import {
  auditWorkflowHandoffs,
  type WorkflowFieldRef,
} from "../scripts/operator/lcx-flow-graph.js";
import {
  appendFinanceIntradayBars,
  readFinanceIntradayLedger,
} from "../src/agents/finance-intraday-ledger.js";
import { FinanceIntradayReplayInputError } from "../src/agents/finance-intraday-paper.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function setup(missingIndex?: number, lastClose = 104) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-intraday-waterflow-"));
  roots.push(directory);
  const prices = [100, 101, 100, 102, 103, lastClose, ...Array<number>(72).fill(lastClose)];
  const bars = prices
    .map((close, index) => {
      const open = index ? prices[index - 1] : close;
      return {
        startAt: new Date(Date.parse("2026-01-05T14:30:00Z") + index * 300_000).toISOString(),
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 1000,
      };
    })
    .filter((_, index) => index !== missingIndex);
  await appendFinanceIntradayBars(directory, {
    instrument: "SPY",
    intervalSeconds: 300,
    observedAt: "2026-01-05T21:01:00.000Z",
    provenance: { origin: "offline_fixture", feed: "iex" },
    bars,
  });
  const args = [
    "--instrument",
    "SPY",
    "--from",
    "2026-01-05T14:30:00.000Z",
    "--to",
    "2026-01-05T21:00:00.000Z",
    "--capital",
    "10000",
    "--max-allocation",
    "0.5",
    "--fee-bps-per-side",
    "1",
    "--spread-bps",
    "4",
    "--slippage-bps-per-side",
    "2",
    "--opening-range-bars",
    "3",
    "--ledger-dir",
    directory,
  ];
  return { directory, args };
}

describe("original intraday ledger -> replay input and native block", () => {
  it("consumes actual source bars in next-interval fills and identical-cost diagnostics", async () => {
    const { directory, args } = await setup();
    const ledger = await readFinanceIntradayLedger(directory, { instrument: "SPY", feed: "iex" });
    const result = await buildFinanceIntradayPaperPayload(args);
    const trade = result.receipt.trades[0];
    expect(result.source.ledgerHeadRef).toBe(ledger.headRef);
    expect(result.source.selectedBars).toBe(ledger.bars.length);
    expect(trade.entryAt).toBe(trade.signalAt);
    expect(trade.entryReferencePrice).toBe(ledger.bars[4].open);
    expect(trade.costFraction).toBeCloseTo(0.001, 12);
    expect(result.receipt.retailOpenToCloseBaseline.totalReturn).toBeCloseTo(
      (Math.floor(5000 / ledger.bars[3].open) *
        (104 - ledger.bars[3].open - ledger.bars[3].open * trade.costFraction)) /
        10000,
      12,
    );
    expect(result.receipt.executionAuthority).toBe("none");
    expect(result.claims).toEqual({
      networkTouched: false,
      credentialsRead: false,
      orderPlaced: false,
      alphaProven: false,
    });
    expect(result.receipt.excludedSessions).toEqual([]);
    // Historical replay is allowed; it must not imply the collector knew these bars at the cutoff.
    expect(
      (await readFinanceIntradayLedger(directory, { asOf: "2026-01-05T15:00:00.000Z" })).bars,
    ).toEqual([]);
    const changed = await setup(undefined, 105);
    const newResult = await buildFinanceIntradayPaperPayload(changed.args);
    expect(newResult.receipt.datasetRef).not.toBe(result.receipt.datasetRef);
    expect(newResult.receipt.strategy.totalReturn).not.toBe(result.receipt.strategy.totalReturn);
  });

  it("refuses a real ledger gap before issuing a passing replay and preserves source records", async () => {
    const { directory, args } = await setup(4);
    const before = await readFinanceIntradayLedger(directory);
    await expect(buildFinanceIntradayPaperPayload(args)).rejects.toMatchObject({
      gap: {
        reason: "bar_sequence_gap_or_overlap",
        instrument: "SPY",
        expectedAt: "2026-01-05T14:50:00.000Z",
        actualAt: "2026-01-05T14:55:00.000Z",
      },
    });
    await expect(buildFinanceIntradayPaperPayload(args)).rejects.toBeInstanceOf(
      FinanceIntradayReplayInputError,
    );
    expect(await readFinanceIntradayLedger(directory)).toEqual(before);
  });

  it("prints a reviewable native CLI block with a failing exit code for source gaps", async () => {
    const { directory, args } = await setup(4);
    const cli = await new Promise<{ exitCode: number | undefined; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", "tsx", "scripts/operator/lcx-finance-intraday-paper.ts", ...args, "--json"],
        { cwd: process.cwd(), timeout: 20_000 },
        (error, stdout) => {
          resolve({
            exitCode: error && typeof error.code === "number" ? error.code : undefined,
            stdout,
          });
        },
      );
    });
    expect(cli.exitCode).toBe(1);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      status: "blocked",
      executionAuthority: "none",
      owner: "src/agents/finance-intraday-ledger.ts",
      gaps: [{ reason: "bar_sequence_gap_or_overlap" }],
      claims: { orderPlaced: false, alphaProven: false },
    });
    expect(JSON.parse(cli.stdout)).not.toHaveProperty("receipt.checks.nextBarEntry");
    const sourcePath = path.join(directory, "observed-native-ledger.json");
    const blockPath = path.join(directory, "native-cli-block.json");
    await fs.writeFile(sourcePath, JSON.stringify(await readFinanceIntradayLedger(directory)));
    await fs.writeFile(blockPath, cli.stdout);
    const ref = async (file: string, pointer: string): Promise<WorkflowFieldRef> => ({
      path: file,
      pointer,
      sha256: createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    });
    const rows = await auditWorkflowHandoffs([
      {
        scenarioId: "finance_intraday_paper_waterflow",
        environment: "offline_fixture",
        nodes: [
          {
            nodeId: "intraday_point_in_time_ledger",
            scope: await ref(sourcePath, "/headRef"),
            output: await ref(sourcePath, "/headRef"),
          },
          {
            nodeId: "frozen_intraday_signal",
            scope: await ref(blockPath, "/source/ledgerHeadRef"),
            inputs: [
              {
                from: "intraday_point_in_time_ledger",
                value: await ref(blockPath, "/source/ledgerHeadRef"),
              },
            ],
            block: {
              filter: "next_bar_fill_required",
              status: await ref(blockPath, "/status"),
              reason: await ref(blockPath, "/gaps/0/reason"),
            },
          },
        ],
      },
    ]);
    expect(rows.find((row) => row.scenarioId === "finance_intraday_paper_waterflow")).toMatchObject(
      { status: "normal_block", blocked: ["frozen_intraday_signal"], gaps: [] },
    );
  });
});
