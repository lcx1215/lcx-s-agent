import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFinanceIntradayPaperPayload } from "../../scripts/operator/lcx-finance-intraday-paper.js";
import { appendFinanceIntradayBars } from "../../src/agents/finance-intraday-ledger.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function sourceReplay(lastClose = 104) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-economics-handoff-"));
  roots.push(root);
  const prices = [100, 101, 100, 102, 103, ...Array.from({ length: 73 }, () => lastClose)];
  await appendFinanceIntradayBars(root, {
    instrument: "SPY",
    intervalSeconds: 300,
    observedAt: "2026-01-05T22:00:00.000Z",
    provenance: { origin: "offline_fixture", feed: "iex" },
    bars: prices.map((close, index) => {
      const open = index ? prices[index - 1] : close;
      return {
        startAt: new Date(Date.parse("2026-01-05T14:30:00Z") + index * 300_000).toISOString(),
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 1000,
      };
    }),
  });
  const payload = await buildFinanceIntradayPaperPayload([
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
    root,
  ]);
  const policyFile = path.join(root, "policy.json");
  await fs.writeFile(
    policyFile,
    JSON.stringify({
      frozenAt: "2026-01-01T00:00:00.000Z",
      assumedRoundTripCostFraction: 0.001,
      estimator: {
        minObservations: 2,
        priorWins: 1,
        priorLosses: 1,
        kellyFraction: 0.2,
        maxAllocationFraction: 0.5,
        maxLossBudgetFraction: 0.1,
        uncertaintyPenalty: 1,
      },
    }),
  );
  return { root, payload, policyFile };
}
async function evaluate(source: Awaited<ReturnType<typeof sourceReplay>>, payload: unknown) {
  const replayFile = path.join(source.root, "replay.json");
  const outputFile = path.join(source.root, "economics.json");
  await fs.writeFile(replayFile, JSON.stringify(payload));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/operator/lcx-finance-trade-economics-eval.ts",
      "--replay",
      replayFile,
      "--policy",
      source.policyFile,
      "--output",
      outputFile,
    ],
    { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 20_000 },
  );
  return { result, outputFile };
}

describe("original replay receipt consumed by native economics reader", () => {
  it("retains the native replay identity and changes the score when actual source bars change", async () => {
    const first = await sourceReplay();
    const changed = await sourceReplay(105);
    const outputs = [];
    for (const source of [first, changed]) {
      const { result, outputFile } = await evaluate(source, source.payload);
      expect(result.status).toBe(0);
      const output = JSON.parse(await fs.readFile(outputFile, "utf8"));
      expect(output).toMatchObject({
        executionAuthority: "none",
        sourceReplayReceiptRef: source.payload.receipt.receiptRef,
        datasetRef: source.payload.receipt.datasetRef,
        strategyRule: source.payload.receipt.strategyRule,
      });
      expect(output.scenarios).toHaveLength(3);
      outputs.push(output);
    }
    expect(outputs[0].sourceReplayReceiptRef).not.toBe(outputs[1].sourceReplayReceiptRef);
    expect(outputs[0].scenarios[0].netEconomics.allOpportunities.meanNetReturn).not.toBe(
      outputs[1].scenarios[0].netEconomics.allOpportunities.meanNetReturn,
    );
    expect(outputs[0].scenarios[0].fixedAllocationReturn).not.toBe(
      outputs[1].scenarios[0].fixedAllocationReturn,
    );
  });

  it.each(["trade", "dataset", "missing_ref"] as const)(
    "rejects %s drift before producing a downstream score or changing the replay source",
    async (fault) => {
      const source = await sourceReplay();
      const payload = {
        ...source.payload,
        receipt: {
          ...source.payload.receipt,
          ...(fault === "trade"
            ? {
                trades: source.payload.receipt.trades.map((trade) => ({
                  ...trade,
                  grossReturn: 0.9,
                })),
              }
            : {}),
          ...(fault === "dataset" ? { datasetRef: "other-dataset" } : {}),
          ...(fault === "missing_ref" ? { receiptRef: undefined } : {}),
        },
      };
      const { result, outputFile } = await evaluate(source, payload);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("intraday replay receipt fingerprint mismatch");
      await expect(fs.stat(outputFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await fs.readFile(path.join(source.root, "replay.json"), "utf8"))).toEqual(
        JSON.parse(JSON.stringify(payload)),
      );
      expect(source.payload.receipt.trades[0].grossReturn).not.toBe(0.9);
    },
  );
});
