import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFinanceIntradayBars } from "./finance-intraday-ledger.js";
import { runFinanceIntradayMonitorTick } from "./finance-intraday-monitor.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

async function seed(directory: string): Promise<void> {
  const closes = [100, 100.5, 100.2, 100.4, 100.1, 100.3, 101];
  const start = Date.parse("2026-09-18T13:30:00Z");
  await appendFinanceIntradayBars(directory, {
    instrument: "SPY",
    intervalSeconds: 300,
    observedAt: "2026-09-18T15:00:00.000Z",
    provenance: { origin: "monitor fixture" },
    bars: closes.map((close, index) => {
      const open = index === 0 ? close : closes[index - 1];
      return {
        startAt: new Date(start + index * 300_000).toISOString(),
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 100,
      };
    }),
  });
}

describe("resident intraday monitor tick", () => {
  it("records one durable buy decision and does not repeat it after restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-"));
    temporary.push(directory);
    await seed(directory);
    const sync = vi.fn(async () => ({}) as never);
    const options = {
      directory,
      instrument: "SPY",
      intervalSeconds: 300 as const,
      feed: "iex" as const,
      openingRangeBars: 6,
      rewardRisk: 2,
      now: new Date("2026-09-18T15:00:00.000Z"),
      sync,
    };
    expect(await runFinanceIntradayMonitorTick(options)).toMatchObject({
      status: "decision_recorded",
      signal: { action: "buy", reason: "opening_range_breakout" },
      executionAuthority: "none",
    });
    expect(await runFinanceIntradayMonitorTick(options)).toMatchObject({
      status: "decision_pending_execution",
      decision: { input: { signalId: expect.stringMatching(/^intraday-/) } },
    });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("does not touch the data source outside the cash session", async () => {
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory: "/not-used",
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      now: new Date("2026-09-19T15:00:00.000Z"),
      sync,
    });
    expect(result.status).toBe("outside_cash_session");
    expect(sync).not.toHaveBeenCalled();
  });
});
