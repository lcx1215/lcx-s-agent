import { describe, expect, it } from "vitest";
import { backfillOutcomes, type Bar, type ResearchSample } from "./finance-outcome-backfill.js";

const SERIES: readonly Bar[] = [
  { date: "2026-01-02", close: 100 },
  { date: "2026-01-20", close: 110 },
  { date: "2026-02-02", close: 120 },
  { date: "2026-03-02", close: 60 },
];

const seriesFor = async () => SERIES;

const sample = (overrides: Partial<ResearchSample> = {}): ResearchSample => ({
  asOf: "2026-01-02T14:00:00.000Z",
  instrument: "SPY",
  direction: "buy",
  conviction: 0.6,
  lastPrice: 100,
  horizonDays: 30,
  ...overrides,
});

describe("backfillOutcomes", () => {
  it("settles a matured buy and reports the signed move", async () => {
    const result = await backfillOutcomes({
      samples: [sample()],
      asOf: "2026-03-10T00:00:00.000Z",
      seriesFor,
    });
    expect(result.scored).toHaveLength(1);
    // dueAt = 2026-02-01, first bar at/after is 2026-02-02 @ 120 -> +20%
    expect(result.scored[0].movePct).toBeCloseTo(20, 4);
    expect(result.scored[0].outcome).toBe(1);
  });

  it("flips the sign for a sell", async () => {
    const result = await backfillOutcomes({
      samples: [sample({ direction: "sell" })],
      asOf: "2026-03-10T00:00:00.000Z",
      seriesFor,
    });
    expect(result.scored[0].movePct).toBeCloseTo(-20, 4);
    expect(result.scored[0].outcome).toBe(0);
  });

  it("never scores a refused call as a loss", async () => {
    // The gate declined to bet. Counting that as wrong would drag the hit rate down
    // for a reason unrelated to judgement.
    const result = await backfillOutcomes({
      samples: [sample({ direction: "none", conviction: 0 })],
      asOf: "2026-03-10T00:00:00.000Z",
      seriesFor,
    });
    expect(result.scored).toHaveLength(0);
    expect(result.declined).toHaveLength(1);
    expect(result.declined[0].instrument).toBe("SPY");
  });

  it("keeps unmatured calls pending instead of settling them early", async () => {
    const result = await backfillOutcomes({
      samples: [sample({ asOf: "2026-03-01T14:00:00.000Z" })],
      asOf: "2026-03-10T00:00:00.000Z",
      seriesFor,
    });
    expect(result.scored).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
  });

  it("treats a horizon beyond the data as pending, not as a settled loss", async () => {
    const result = await backfillOutcomes({
      samples: [sample({ horizonDays: 900 })],
      asOf: "2026-03-10T00:00:00.000Z",
      seriesFor,
    });
    expect(result.scored).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
  });

  it("reports an unusable entry price instead of guessing", async () => {
    const result = await backfillOutcomes({
      samples: [sample({ lastPrice: 0 })],
      asOf: "2026-03-10T00:00:00.000Z",
      seriesFor,
    });
    expect(result.scored).toHaveLength(0);
    expect(result.issues.join(" ")).toContain("lastPrice");
  });

  it("survives an unreadable price source", async () => {
    const result = await backfillOutcomes({
      samples: [sample()],
      asOf: "2026-03-10T00:00:00.000Z",
      seriesFor: async () => {
        throw new Error("source down");
      },
    });
    expect(result.scored).toHaveLength(0);
    expect(result.issues.join(" ")).toContain("source down");
  });

  it("rejects an unparseable asOf rather than silently settling nothing", async () => {
    const result = await backfillOutcomes({
      samples: [sample()],
      asOf: "not-a-date",
      seriesFor,
    });
    expect(result.issues.join(" ")).toContain("asOf");
  });
});
