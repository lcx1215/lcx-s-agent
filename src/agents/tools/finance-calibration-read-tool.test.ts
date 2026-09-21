import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FINANCE_STATE_DIR_ENV } from "../finance-state-dir.js";
import { createFinanceCalibrationReadTool } from "./finance-calibration-read-tool.js";

let directory: string;
let savedEnv: string | undefined;

function writeSamples(directory: string, rows: unknown[]): void {
  fs.writeFileSync(
    path.join(directory, "research-samples.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function writeScored(directory: string, rows: unknown[]): void {
  fs.writeFileSync(
    path.join(directory, "research-scored.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-calibration-read-"));
  savedEnv = process.env[FINANCE_STATE_DIR_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[FINANCE_STATE_DIR_ENV];
  } else {
    process.env[FINANCE_STATE_DIR_ENV] = savedEnv;
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("finance_calibration_read", () => {
  it("reads the finance state directory it was given", async () => {
    writeSamples(directory, [
      { instrument: "SPY", direction: "buy", lastPrice: 100, at: "2026-09-01T00:00:00Z" },
      { instrument: "QQQ", direction: "sell", lastPrice: 200, at: "2026-09-01T00:00:00Z" },
    ]);
    writeScored(directory, [{ conviction: 0.7, outcome: 1 }]);
    const tool = createFinanceCalibrationReadTool();
    const result = (await tool.execute("c1", { directory })).details as Record<string, unknown>;
    const inspected = result.inspectedFrom as { samplesFile: string; resolvedFrom: string };
    expect(inspected.samplesFile).toBe(path.join(directory, "research-samples.jsonl"));
    expect(inspected.resolvedFrom).toBe("explicit");
    expect((result.counts as { total: number }).total).toBe(2);
    expect(result.hitRate).toBe(1);
  });

  it("defaults to the configured finance root, not to the workspace's own copy", async () => {
    // The regression this pins: the cycle writes samples into the finance state root, so a read
    // that resolves `<workspace>/state/finance/...` reports "no outcomes" while the record
    // exists one directory away.
    process.env[FINANCE_STATE_DIR_ENV] = directory;
    writeSamples(directory, [
      { instrument: "SPY", direction: "buy", lastPrice: 100, at: "2026-09-01T00:00:00Z" },
    ]);
    const tool = createFinanceCalibrationReadTool();
    const result = (await tool.execute("c2", {})).details as Record<string, unknown>;
    const inspected = result.inspectedFrom as {
      financeStateDirectory: string;
      resolvedFrom: string;
    };
    expect(inspected.financeStateDirectory).toBe(directory);
    expect(inspected.resolvedFrom).toBe("env");
    expect((result.counts as { total: number }).total).toBe(1);
  });

  it("reports zeros instead of inventing numbers when the book is empty", async () => {
    const tool = createFinanceCalibrationReadTool();
    const result = (await tool.execute("c3", { directory })).details as Record<string, unknown>;
    expect((result.counts as { total: number }).total).toBe(0);
    expect(result.hitRate).toBeNull();
    // No floor, said as a refusal rather than as a number: a floor derived from nothing is worse
    // than no floor, because it looks usable.
    const floor = result.floor as { value: number | null; basis: string; samplesUsed: number };
    expect(floor.value).toBeNull();
    expect(floor.samplesUsed).toBe(0);
    expect(floor.basis).toMatch(/refusing to invent a floor/);
    expect(String(result.note)).toMatch(/No scored outcomes yet/);
  });
});
