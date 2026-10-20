import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsGSEarthquakeAdapter, runGeospatialRefresh } from "./geospatial-source-registry.js";

const AS_OF = "2026-09-07T10:45:00.000Z";
const FETCHED_AT = "2026-10-19T12:00:00.000Z";
const request = { kind: "earthquake", query: "all_day", asOf: AS_OF } as const;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FETCHED_AT));
});
afterEach(() => vi.useRealTimers());
function fixture(payload: () => unknown) {
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload()),
  }));
  const adapter = createUsGSEarthquakeAdapter({ fetchImpl: fetch });
  return {
    fetch,
    run: () => runGeospatialRefresh({ request, adapters: [adapter], retry: { attempts: 1 } }),
  };
}

describe("USGS source snapshot provenance", () => {
  it.each([{}, { features: null }, { features: [{}], metadata: { generated: Date.parse(AS_OF) } }])(
    "does not certify a malformed collection as an official earthquake count: %j",
    async (payload) => {
      const { fetch, run } = fixture(() => payload);
      const receipt = await run();
      expect(receipt.status).toBe("blocked");
      expect(receipt.normalizedFields).toEqual([]);
      expect(receipt.sourceAttempts).toMatchObject([{ status: "failed" }]);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, "unobserved", 1e20])(
    "retains the snapshot without borrowing a historical cutoff when generation time is %s",
    async (generated) => {
      const { run } = fixture(() => ({ metadata: { generated }, features: [] }));
      const receipt = await run();
      expect(receipt.status).toBe("needs_review");
      expect(receipt.normalizedFields).toEqual([]);
      expect(receipt.observations).toMatchObject([
        {
          observedAt: FETCHED_AT,
          fields: [
            {
              name: "earthquake_count",
              value: 0,
              sourceTimestamp: FETCHED_AT,
              fieldDefinition: expect.stringContaining("retrieval time"),
            },
          ],
        },
      ]);
      expect(receipt.requiredNextSteps).toContain("review_future_dated_observations");
    },
  );

  it("keeps a valid empty feed as explicit zero with its actual generation time", async () => {
    const { run } = fixture(() => ({ metadata: { generated: Date.parse(AS_OF) }, features: [] }));
    const receipt = await run();
    expect(receipt.status).toBe("ready");
    expect(receipt.normalizedFields).toMatchObject([
      { name: "earthquake_count", value: 0, sourceTimestamp: AS_OF },
    ]);
  });

  it("recovers through the same adapter when a later response has a valid collection", async () => {
    let first = true;
    const { fetch, run } = fixture(() => {
      if (first) {
        first = false;
        return {};
      }
      return { metadata: { generated: Date.parse(AS_OF) }, features: [] };
    });
    expect((await run()).status).toBe("blocked");
    expect((await run()).status).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
