import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFinanceBarLedgerTool } from "./finance-bar-ledger-tool.js";

let directory: string;

function batch(overrides: Record<string, unknown> = {}) {
  return {
    instrument: "600519.SH",
    derivation: "ohlcv",
    provenance: { origin: "test-source", sourceUrlOrArtifact: "https://example.test/bars" },
    observedAt: new Date().toISOString(),
    bars: [
      { date: "2026-07-01", open: 100, high: 102, low: 99, close: 101, volume: 1000 },
      { date: "2026-07-02", open: 101, high: 104, low: 100.5, close: 103, volume: 1200 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-bar-ledger-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("finance_bar_ledger", () => {
  it("appends a batch and reads it back — the agent can see its own book", async () => {
    const tool = createFinanceBarLedgerTool();
    const appended = (await tool.execute("c1", { action: "append", directory, batch: batch() }))
      .details as Record<string, unknown>;
    expect(appended.ok).toBe(true);
    expect(appended.status).toBe("recorded");
    expect(appended.barCount).toBe(2);
    expect(appended.appended).toBe(true);
    expect(appended.range).toBe("2026-07-01..2026-07-02");

    const read = (await tool.execute("c2", { action: "read", directory })).details as {
      status: string;
      bars: Array<{ instrument: string; date: string; close: number; sampleCount: number | null }>;
      totalBarCount: number;
      resolvedFrom: string;
      ledgerDirectory: string;
    };
    expect(read.status).toBe("ready");
    expect(read.totalBarCount).toBe(2);
    expect(read.bars[0]).toMatchObject({
      instrument: "600519.SH",
      date: "2026-07-01",
      close: 101,
      // Exchange-aggregated bars carry a null sample count, which is what lets a range measure
      // know the high/low really are the period's extremes.
      sampleCount: null,
    });
    // Reading the wrong directory is silent, so the path has to be part of the answer.
    expect(read.ledgerDirectory).toBe(directory);
  });

  it("does not record the identical batch twice", async () => {
    const tool = createFinanceBarLedgerTool();
    const first = batch();
    await tool.execute("c1", { action: "append", directory, batch: first });
    const second = (await tool.execute("c2", { action: "append", directory, batch: first }))
      .details as { appended: boolean; recordCount: number };
    expect(second.appended).toBe(false);
    expect(second.recordCount).toBe(1);
  });

  it("distinguishes an absent book from a book with nothing for this instrument", async () => {
    const tool = createFinanceBarLedgerTool();
    const absent = (await tool.execute("c1", { action: "read", directory })).details as {
      status: string;
      statusMeaning: string;
    };
    expect(absent.status).toBe("absent");
    expect(absent.statusMeaning).toContain("no bars have ever been recorded");

    await tool.execute("c2", { action: "append", directory, batch: batch() });
    const filtered = (
      await tool.execute("c3", {
        action: "read",
        directory,
        instrument: "000001.SZ",
      })
    ).details as { status: string; statusMeaning: string };
    expect(filtered.status).toBe("empty_for_filter");
    expect(filtered.statusMeaning).toContain("none match the supplied instrument");
  });

  it("rejects a bad batch by naming the offending field, and does not write it", async () => {
    const tool = createFinanceBarLedgerTool();
    const result = (
      await tool.execute("c1", {
        action: "append",
        directory,
        batch: batch({ bars: [{ date: "2026-07-01", open: 100, high: 90, low: 99, close: 101 }] }),
      })
    ).details as { ok: boolean; reason: string; error: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("finance_bar_ledger_append_rejected");
    // The ledger names the field path; a bare "invalid input" would leave twenty fields to guess.
    expect(result.error).toMatch(/impossible prices|invalid bar append/u);

    const after = (await tool.execute("c2", { action: "read", directory })).details as {
      recordCount: number;
    };
    expect(after.recordCount).toBe(0);
  });

  it("emits chartBars shaped for finance_chart_analysis when every bar is exchange-aggregated", async () => {
    const tool = createFinanceBarLedgerTool();
    await tool.execute("c1", { action: "append", directory, batch: batch() });
    const read = (await tool.execute("c2", { action: "read", directory })).details as {
      chartBars: Array<Record<string, unknown>> | null;
      chartBarsUnavailableReason: string | null;
      nextTool?: string;
    };
    expect(read.chartBars).not.toBeNull();
    expect(read.chartBarsUnavailableReason).toBeNull();
    // The chart tool's bar schema is a closed object, so the ledger's own fields must not ride
    // along: instrument and sampleCount would both be rejected.
    expect(Object.keys(read.chartBars?.[0] ?? {}).toSorted()).toEqual(
      ["close", "date", "high", "low", "open", "volume"].toSorted(),
    );
    expect(read.nextTool).toBe("finance_chart_analysis with bars=chartBars");
  });

  it("refuses to produce chart input when a bar's range was only observed, not traded", async () => {
    const tool = createFinanceBarLedgerTool();
    await tool.execute("c1", {
      action: "append",
      directory,
      batch: {
        instrument: "600519.SH",
        derivation: "point_derived",
        provenance: { origin: "test-points" },
        observedAt: new Date().toISOString(),
        // One observation per day: high === low, so the range is unknown rather than zero.
        points: [
          { date: "2026-07-01", price: 100, at: "2026-07-01T01:30:00.000Z" },
          { date: "2026-07-02", price: 101, at: "2026-07-02T01:30:00.000Z" },
        ],
      },
    });
    const read = (await tool.execute("c2", { action: "read", directory })).details as {
      chartBars: unknown[] | null;
      chartBarsUnavailableReason: string | null;
      bars: Array<{ sampleCount: number | null }>;
    };
    expect(read.bars[0]?.sampleCount).toBe(1);
    expect(read.chartBars).toBeNull();
    expect(read.chartBarsUnavailableReason).toContain("point_derived");
    expect(read.chartBarsUnavailableReason).toContain("understated");
  });

  it("requires a batch for append instead of writing an empty record", async () => {
    const tool = createFinanceBarLedgerTool();
    const result = (await tool.execute("c1", { action: "append", directory })).details as {
      ok: boolean;
      reason: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("finance_bar_ledger_batch_required");
  });
});
