import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_OVERRIDE_TTL_MS,
  clearScopedOverride,
  listScopedOverrides,
  resolveScopedOverride,
  setScopedOverride,
} from "./finance-scoped-override.js";

/**
 * An override is the one place a bound can be moved, so its tests are mostly
 * about the ways it must refuse, and about the revert being *verified* rather
 * than assumed. A revert that is believed but not checked leaves the system
 * permanently loosened while reporting that it is back to normal.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lcx-override-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("finance scoped override", () => {
  it("falls back to the default when nothing is set", async () => {
    const resolved = await resolveScopedOverride({
      knob: "maxOrdersPerRun",
      fallback: 8,
      workspaceDir: dir,
    });
    expect(resolved).toMatchObject({ value: 8, overridden: false, expired: false });
  });

  it("applies a set override", async () => {
    const set = await setScopedOverride({
      knob: "maxOrdersPerRun",
      value: 3,
      reason: "narrowing for this run because provider limits are tight",
      ttlMs: 60_000,
      workspaceDir: dir,
    });
    expect(set.ok).toBe(true);
    const resolved = await resolveScopedOverride({
      knob: "maxOrdersPerRun",
      fallback: 8,
      workspaceDir: dir,
    });
    expect(resolved).toMatchObject({ value: 3, overridden: true });
  });

  it("refuses a value outside the declared bounds", async () => {
    const set = await setScopedOverride({
      knob: "maxOrdersPerRun",
      value: 99,
      reason: "widening well beyond anything declared",
      workspaceDir: dir,
    });
    expect(set.ok).toBe(false);
    if (!set.ok) {
      expect(set.refusals.join(" ")).toContain("outside bounds");
    }
  });

  it("refuses a non-integer value", async () => {
    const set = await setScopedOverride({
      knob: "maxOrdersPerRun",
      value: 2.5,
      reason: "a fractional order count is not a count",
      workspaceDir: dir,
    });
    expect(set.ok).toBe(false);
  });

  it("refuses a reason too short to be a reason", async () => {
    const set = await setScopedOverride({
      knob: "maxOrdersPerRun",
      value: 3,
      reason: "ok",
      workspaceDir: dir,
    });
    expect(set.ok).toBe(false);
    if (!set.ok) {
      expect(set.refusals.join(" ")).toContain("reason is required");
    }
  });

  it("refuses a ttl beyond the hard maximum", async () => {
    const set = await setScopedOverride({
      knob: "maxOrdersPerRun",
      value: 3,
      reason: "asking for an override that outlives any sane run",
      ttlMs: MAX_OVERRIDE_TTL_MS + 1,
      workspaceDir: dir,
    });
    expect(set.ok).toBe(false);
  });

  it("expires back to the default and reports the revert as verified", async () => {
    await setScopedOverride({
      knob: "maxOrdersPerRun",
      value: 3,
      reason: "short lived override for the expiry path",
      ttlMs: 1,
      workspaceDir: dir,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const resolved = await resolveScopedOverride({
      knob: "maxOrdersPerRun",
      fallback: 8,
      workspaceDir: dir,
    });
    expect(resolved).toMatchObject({
      value: 8,
      overridden: false,
      expired: true,
      revertVerified: true,
    });
    // And it is really gone, not merely reported as gone.
    expect(await listScopedOverrides(dir)).toEqual([]);
  });

  it("reports a clear as verified and leaves nothing behind", async () => {
    await setScopedOverride({
      knob: "maxOrdersPerRun",
      value: 3,
      reason: "set so that clear has something to remove",
      ttlMs: 60_000,
      workspaceDir: dir,
    });
    const cleared = await clearScopedOverride("maxOrdersPerRun", dir);
    expect(cleared).toMatchObject({ reverted: true, verified: true });
    expect(await listScopedOverrides(dir)).toEqual([]);
  });

  it("treats clearing an unset override as a successful no-op", async () => {
    const cleared = await clearScopedOverride("maxOrdersPerRun", dir);
    expect(cleared).toMatchObject({ reverted: true, verified: true });
  });
});
