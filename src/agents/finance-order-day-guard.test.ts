import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNotPlacedToday,
  markPlaced,
  placedToday,
  readPlaced,
} from "./finance-order-day-guard.js";

/**
 * The guard exists because two schedulers cannot see each other's orders. Its
 * tests are therefore about the cases where it must refuse, and about the cases
 * where refusing would be wrong - a guard that blocks everything is as broken
 * as one that blocks nothing.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcx-guard-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("finance order day guard", () => {
  it("allows the first order for an instrument on a day", async () => {
    expect(
      await assertNotPlacedToday({ instrument: "SPY", day: "2026-09-21", workspaceDir: dir }),
    ).toEqual({ ok: true });
  });

  it("refuses a second order for the same instrument and day", async () => {
    await markPlaced({
      instrument: "SPY",
      day: "2026-09-21",
      receiptId: "exec-1",
      venue: "paper",
      route: "route-a",
      workspaceDir: dir,
    });
    const second = await assertNotPlacedToday({
      instrument: "SPY",
      day: "2026-09-21",
      workspaceDir: dir,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // The refusal must name what it found: "no" is not actionable, "already
      // placed by route-a with receipt exec-1" is.
      expect(second.existing.route).toBe("route-a");
      expect(second.existing.receiptId).toBe("exec-1");
    }
  });

  it("refuses regardless of which route asks", async () => {
    await markPlaced({
      instrument: "SPY",
      day: "2026-09-21",
      receiptId: "exec-1",
      venue: "paper",
      route: "route-a",
      workspaceDir: dir,
    });
    const fromOtherRoute = await assertNotPlacedToday({
      instrument: "SPY",
      day: "2026-09-21",
      workspaceDir: dir,
    });
    expect(fromOtherRoute.ok).toBe(false);
  });

  it("does not block a different instrument on the same day", async () => {
    await markPlaced({
      instrument: "SPY",
      day: "2026-09-21",
      receiptId: "exec-1",
      venue: "paper",
      route: "route-a",
      workspaceDir: dir,
    });
    expect(
      await assertNotPlacedToday({ instrument: "QQQ", day: "2026-09-21", workspaceDir: dir }),
    ).toEqual({ ok: true });
  });

  it("does not block the same instrument on a different day", async () => {
    await markPlaced({
      instrument: "SPY",
      day: "2026-09-21",
      receiptId: "exec-1",
      venue: "paper",
      route: "route-a",
      workspaceDir: dir,
    });
    expect(
      await assertNotPlacedToday({ instrument: "SPY", day: "2026-09-22", workspaceDir: dir }),
    ).toEqual({ ok: true });
  });

  it("treats a missing ledger as empty rather than as an error", async () => {
    expect(await readPlaced(dir)).toEqual([]);
    expect(await placedToday("SPY", "2026-09-21", dir)).toBeNull();
  });

  it("normalises the instrument so case cannot slip past it", async () => {
    await markPlaced({
      instrument: "spy",
      day: "2026-09-21",
      receiptId: "exec-1",
      venue: "paper",
      route: "route-a",
      workspaceDir: dir,
    });
    expect(
      await assertNotPlacedToday({ instrument: "SPY", day: "2026-09-21", workspaceDir: dir }),
    ).toMatchObject({ ok: false });
  });
});
