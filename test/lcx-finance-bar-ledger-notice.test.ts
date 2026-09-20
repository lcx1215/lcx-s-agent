import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBarLedger } from "../scripts/operator/lcx-finance-bar-ledger.js";
import { appendFinancePositionMark } from "../src/agents/finance-position-ledger.js";

/**
 * Writing bars into a book nobody named is how a ledger fills up in the wrong place, and a
 * wrong-but-existing book reads as an empty one — the same failure an unreadable memory source
 * produces. The position ledger already warned about it; these cases keep the bar ledger honest.
 */
describe("bar ledger writes to a named location", () => {
  let dir = "";
  let previousEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bar-notice-"));
    previousEnv = process.env.LCX_FINANCE_STATE_DIR;
  });

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env.LCX_FINANCE_STATE_DIR;
    } else {
      process.env.LCX_FINANCE_STATE_DIR = previousEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seedMarks = async () => {
    const seeds: ReadonlyArray<readonly [number, string]> = [
      [100, "2026-08-05T14:00:00Z"],
      [104, "2026-08-05T20:00:00Z"],
    ];
    for (const [price, at] of seeds) {
      await appendFinancePositionMark(dir, { instrument: "AAA", price, at });
    }
  };

  it("warns when it writes to the env location", async () => {
    await seedMarks();
    process.env.LCX_FINANCE_STATE_DIR = dir;
    const payload = await runBarLedger(["--from-marks", "--instrument", "AAA"]);
    expect(payload["resolvedFrom"]).toBe("env");
    expect(payload["directorySourceNotice"]).toContain("wrote to the env location");
  });

  it("stays quiet when the directory was named with --dir", async () => {
    await seedMarks();
    const payload = await runBarLedger(["--dir", dir, "--from-marks", "--instrument", "AAA"]);
    expect(payload["resolvedFrom"]).toBe("explicit");
    expect(payload["directorySourceNotice"]).toBeNull();
  });

  it("stays quiet on a read, even from a defaulted location", async () => {
    await seedMarks();
    process.env.LCX_FINANCE_STATE_DIR = dir;
    const payload = await runBarLedger([]);
    expect(payload["resolvedFrom"]).toBe("env");
    expect(payload["directorySourceNotice"]).toBeNull();
  });
});
