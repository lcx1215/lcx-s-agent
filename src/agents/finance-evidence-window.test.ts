import { describe, expect, it } from "vitest";
import {
  defaultEvidenceWindow,
  parseAvPublishedAgeDays,
  summarizeNewsCohort,
  type NewsItem,
} from "./finance-evidence-window.js";

const policy = defaultEvidenceWindow({ horizonDays: 30 });
const article = (ageDays: number, score = 0.2): NewsItem => ({ ageDays, score });

describe("defaultEvidenceWindow", () => {
  it("scales the lookback with the horizon", () => {
    const short = defaultEvidenceWindow({ horizonDays: 10 });
    const long = defaultEvidenceWindow({ horizonDays: 60 });
    expect(long.lookbackDays).toBeGreaterThan(short.lookbackDays);
  });

  it("lets an index look further back than a single stock", () => {
    const stock = defaultEvidenceWindow({ horizonDays: 30, assetType: "equity" });
    const index = defaultEvidenceWindow({ horizonDays: 30, assetType: "index" });
    expect(index.lookbackDays).toBeGreaterThan(stock.lookbackDays);
  });

  it("treats crypto news as the fastest to go stale", () => {
    const crypto = defaultEvidenceWindow({ horizonDays: 30, assetType: "crypto" });
    const stock = defaultEvidenceWindow({ horizonDays: 30, assetType: "equity" });
    expect(crypto.newsHalfLifeDays).toBeLessThan(stock.newsHalfLifeDays);
  });
});

describe("summarizeNewsCohort", () => {
  it("refuses a cohort that falls outside the window entirely", () => {
    // The actual bug: fifty old articles are still fifty articles.
    const stale = Array.from({ length: 50 }, (_unused, i) => article(200 + i, 0.9));
    const summary = summarizeNewsCohort(stale, policy);
    expect(summary.usable).toBe(false);
    expect(summary.refusals.join()).toMatch(/no article is inside/);
  });

  it("refuses a thin cohort instead of inflating it into a reading", () => {
    const summary = summarizeNewsCohort([article(1, 0.8), article(2, 0.8)], policy);
    expect(summary.usable).toBe(false);
    expect(summary.refusals.join()).toMatch(/thin cohort/);
  });

  it("weights recent articles more than old ones", () => {
    // One very recent negative against several older positives: recency wins.
    const summary = summarizeNewsCohort(
      [article(0, -1), article(30, 0.5), article(30, 0.5), article(30, 0.5), article(30, 0.5)],
      policy,
    );
    expect(summary.usable).toBe(true);
    if (summary.weightedMean !== null) {
      expect(summary.weightedMean).toBeLessThan(0);
    }
  });

  it("reports the span so a stretched cohort is visible", () => {
    const summary = summarizeNewsCohort(
      [article(0, 0.1), article(5, 0.1), article(10, 0.1), article(20, 0.1), article(100, 0.1)],
      policy,
    );
    // The 100-day-old article is outside the 120-day window here, so it stays;
    // span is reported either way.
    expect(summary.used).toBe(5);
    expect(summary.spanDays).toBe(100);
  });

  it("drops articles older than the window", () => {
    const summary = summarizeNewsCohort(
      [article(1, 0.5), article(2, 0.5), article(3, 0.5), article(4, 0.5), article(500, 0.5)],
      policy,
    );
    expect(summary.used).toBe(4);
  });

  it("rejects negative or non-finite ages rather than treating them as fresh", () => {
    const summary = summarizeNewsCohort(
      [
        article(-5, 0.9),
        article(Number.NaN, 0.9),
        article(1, 0.1),
        article(2, 0.1),
        article(3, 0.1),
        article(4, 0.1),
        article(5, 0.1),
      ],
      policy,
    );
    expect(summary.used).toBe(5);
  });
});

describe("parseAvPublishedAgeDays", () => {
  const asOf = Date.UTC(2026, 8, 20, 12, 0, 0);

  it("parses Alpha Vantage's compact timestamp", () => {
    const age = parseAvPublishedAgeDays("20260910T120000", asOf);
    expect(age).toBeCloseTo(10, 6);
  });

  it("returns null for garbage rather than defaulting to fresh", () => {
    // Defaulting to fresh is exactly how stale news gets counted.
    for (const bad of ["", "not-a-date", "2026-09-10", 12345, null, undefined]) {
      expect(parseAvPublishedAgeDays(bad, asOf)).toBeNull();
    }
  });
});
