import { describe, expect, it } from "vitest";
import { defaultEvidenceWindow } from "./finance-evidence-window.js";
import {
  NEWS_SENTIMENT_MAX_CONFIDENCE,
  newsSentimentSignal,
  scoreHeadline,
} from "./finance-news-sentiment-signal.js";

const policy = defaultEvidenceWindow({ horizonDays: 30 });
const cohort = (score: number, count = 6, ageDays = 1) =>
  Array.from({ length: count }, () => ({ ageDays, score }));

describe("news sentiment signal", () => {
  it("turns a positive cohort into a buy", () => {
    const signal = newsSentimentSignal({
      sourceId: "alpha-vantage-news-sentiment",
      items: cohort(0.6),
      observedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(signal).toMatchObject({ kind: "news_tone", direction: "buy" });
    expect(signal?.confidence).toBe(NEWS_SENTIMENT_MAX_CONFIDENCE);
  });

  it("turns a negative cohort into a sell", () => {
    const signal = newsSentimentSignal({
      sourceId: "alpha-vantage-news-sentiment",
      items: cohort(-0.6),
      observedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(signal).toMatchObject({ direction: "sell" });
  });

  it("says nothing when the cohort is inside the neutral band", () => {
    // Noise given a direction is how a source starts overclaiming.
    expect(
      newsSentimentSignal({
        sourceId: "alpha-vantage-news-sentiment",
        items: cohort(0.02),
        observedAt: "2026-09-21T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("says nothing on a thin cohort, because a handful of articles is not a reading", () => {
    expect(
      newsSentimentSignal({
        sourceId: "alpha-vantage-news-sentiment",
        items: cohort(0.9, 2),
        observedAt: "2026-09-21T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("says nothing when every article is outside the window", () => {
    expect(
      newsSentimentSignal({
        sourceId: "alpha-vantage-news-sentiment",
        items: cohort(0.9, 6, policy.lookbackDays + 1),
        observedAt: "2026-09-21T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("lets a recent reversal outweigh older agreement", () => {
    // Recency is weighted, not flat: the same mean with a different age profile is a
    // different reading, and that is the whole point of the window.
    const stalePositive = Array.from({ length: 4 }, () => ({ ageDays: 60, score: 0.5 }));
    const freshNegative = [
      { ageDays: 0.5, score: -0.9 },
      { ageDays: 1, score: -0.9 },
    ];
    const signal = newsSentimentSignal({
      sourceId: "alpha-vantage-news-sentiment",
      items: [...stalePositive, ...freshNegative],
      observedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(signal?.direction).toBe("sell");
  });

  it("reports the numbers behind the reading so it can be argued with", () => {
    const signal = newsSentimentSignal({
      sourceId: "alpha-vantage-news-sentiment",
      items: cohort(0.6),
      observedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(signal?.ref).toMatch(/weightedMean=/u);
    expect(signal?.ref).toMatch(/used=6/u);
  });
});

describe("scoreHeadline", () => {
  it("scores an upgrade positively and a downgrade negatively", () => {
    expect(scoreHeadline("Analysts upgrade the stock")).toBeGreaterThan(0);
    expect(scoreHeadline("Analysts downgrade the stock")).toBeLessThan(0);
  });

  it("returns no opinion for a headline it does not understand", () => {
    // Neutral would silently drag every cohort toward the middle; absent means absent.
    expect(scoreHeadline("Company releases its scheduled agenda")).toBeUndefined();
    expect(scoreHeadline("")).toBeUndefined();
  });

  it("stays inside -1..1", () => {
    const value = scoreHeadline("beats beats beats record surge rally upgrade approval");
    expect(value).toBeDefined();
    expect(Math.abs(value ?? 0)).toBeLessThanOrEqual(1);
  });
});
