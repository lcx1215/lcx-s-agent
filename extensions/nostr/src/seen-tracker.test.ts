import { describe, expect, it } from "vitest";
import { createSeenTracker } from "./seen-tracker.js";

/**
 * The three options are consumed by comparisons that a degenerate value silently breaks, and one of
 * them hangs the process. Measured before the guard was added:
 *
 * - `maxEntries: 0` ⇒ `while (entries.size >= maxEntries)` never goes false, and `evictLRU()`
 *   returns without removing anything when the map is empty — a synchronous infinite loop. Negative
 *   values behave the same way.
 * - `maxEntries: NaN` ⇒ the comparison is always false, so nothing is evicted and the map grows
 *   without bound (the exact thing this file exists to prevent).
 * - `ttlMs: 0` or `-1` ⇒ every entry is already expired, so `has()` always reports "new" and the
 *   tracker stops deduplicating.
 * - `ttlMs: NaN` ⇒ nothing ever expires.
 */
describe("createSeenTracker option validation", () => {
  it("works with the documented defaults and with a normal capacity", () => {
    const tracker = createSeenTracker();
    expect(tracker.has("evt-1")).toBe(false);
    expect(tracker.has("evt-1")).toBe(true);
    tracker.stop();

    const bounded = createSeenTracker({ maxEntries: 2 });
    bounded.add("a");
    bounded.add("b");
    bounded.add("c");
    expect(bounded.size()).toBe(2);
    bounded.stop();
  });

  it("refuses a maxEntries that would hang or stop evicting", () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN]) {
      expect(() => createSeenTracker({ maxEntries })).toThrow(
        /maxEntries must be a positive integer/,
      );
    }
  });

  it("refuses a ttlMs that would expire everything or nothing", () => {
    for (const ttlMs of [0, -1, Number.NaN]) {
      expect(() => createSeenTracker({ ttlMs })).toThrow(/ttlMs must be a positive finite number/);
    }
  });

  it("keeps pruneIntervalMs: 0 legal, because that is how the timer is disabled", () => {
    const tracker = createSeenTracker({ pruneIntervalMs: 0 });
    tracker.add("evt-1");
    expect(tracker.peek("evt-1")).toBe(true);
    tracker.stop();
  });
});
