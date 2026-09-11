import { describe, expect, it } from "vitest";
import type { FetchImpl } from "./finance-live-market-source.js";
import { createNwsCurrentWeatherAdapter } from "./geospatial-official-source-adapters.js";
import {
  createGeospatialSourceRegistry,
  createNominatimGeocodingAdapter,
  createOpenMeteoWeatherAdapter,
  createUsGSEarthquakeAdapter,
  runGeospatialRefresh,
} from "./geospatial-source-registry.js";

const AS_OF = "2026-09-07T10:45:00.000Z";

describe("geospatial source registry", () => {
  it("cross-checks Open-Meteo and Nominatim geocoding with actual response shapes", async () => {
    const fetchImpl: FetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes("open-meteo")
          ? JSON.stringify({
              results: [
                {
                  id: 1796236,
                  name: "Shanghai",
                  latitude: 31.22222,
                  longitude: 121.45806,
                  timezone: "Asia/Shanghai",
                  country_code: "CN",
                },
              ],
            })
          : JSON.stringify([
              {
                lat: "31.2312707",
                lon: "121.4700152",
                display_name: "Shanghai, China",
                osm_id: 913067,
              },
            ]),
    });
    const adapters = createGeospatialSourceRegistry({ fetchImpl, nominatimMinIntervalMs: 0 });
    const receipt = await runGeospatialRefresh({
      request: { kind: "geocode", query: "Shanghai", asOf: AS_OF },
      adapters,
    });
    expect(receipt.status).toBe("needs_review");
    expect(receipt.sourceAttempts).toHaveLength(2);
    expect(receipt.conflicts.map((conflict) => conflict.fieldName)).toEqual([
      "latitude",
      "longitude",
    ]);
  });

  it("normalizes weather current fields and respects coordinate bounds", async () => {
    const fetchImpl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          current: {
            time: "2026-09-07T10:30",
            temperature_2m: 26.7,
            relative_humidity_2m: 65,
            pressure_msl: 1008.7,
            wind_speed_10m: 12.9,
          },
        }),
    });
    const adapter = createOpenMeteoWeatherAdapter({ fetchImpl });
    const observation = await adapter.collect(
      { kind: "weather", query: "31.23,121.47", asOf: AS_OF },
      new AbortController().signal,
    );
    expect(observation.sourceFamily).toBe("weather_environmental");
    expect(observation.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "temperature_2m", value: 26.7 })]),
    );
    await expect(
      adapter.collect(
        { kind: "weather", query: "91,121.47", asOf: AS_OF },
        new AbortController().signal,
      ),
    ).rejects.toThrow("outside WGS84 bounds");
  });

  it("normalizes the official USGS GeoJSON feed into event fields", async () => {
    const fetchImpl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          metadata: { generated: 1788777690000 },
          features: [
            { properties: { mag: 2.1, time: 1788777600000, title: "M 2.1 - test" } },
            { properties: { mag: 1.1, time: 1788777500000, title: "M 1.1 - older" } },
          ],
        }),
    });
    const observation = await createUsGSEarthquakeAdapter({ fetchImpl }).collect(
      { kind: "earthquake", query: "all_day", asOf: AS_OF },
      new AbortController().signal,
    );
    expect(observation.providerRole).toBe("official_reference");
    expect(observation.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "earthquake_count", value: 2 }),
        expect.objectContaining({ name: "max_magnitude", value: 2.1 }),
      ]),
    );
  });

  it("keeps Nominatim as an explicit cross-check adapter", () => {
    const adapter = createNominatimGeocodingAdapter({ minIntervalMs: 0 });
    expect(adapter.providerRole).toBe("cross_check_reference");
    expect(adapter.sourceFamily).toBe("geospatial_reference");
  });

  it("selects fresh official fields when a preferred feed is stale", async () => {
    const fetchImpl: FetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () => {
        if (url.includes("open-meteo.com")) {
          return JSON.stringify({
            current: {
              time: "2026-09-07T10:00",
              temperature_2m: 18,
              relative_humidity_2m: 50,
              pressure_msl: 1000,
              wind_speed_10m: 4,
            },
          });
        }
        if (url.includes("/points/")) {
          return JSON.stringify({
            properties: { observationStations: "https://api.weather.gov/stations" },
          });
        }
        if (url.endsWith("/stations")) {
          return JSON.stringify({ features: [{ properties: { stationIdentifier: "KTEST" } }] });
        }
        return JSON.stringify({
          properties: {
            timestamp: "2026-09-07T11:59:00Z",
            temperature: { value: 20 },
            relativeHumidity: { value: 60 },
            barometricPressure: { value: 101500 },
            windSpeed: { value: 10 },
            textDescription: "Clear",
          },
        });
      },
    });
    const receipt = await runGeospatialRefresh({
      request: {
        kind: "weather",
        query: "40.7128,-74.0060",
        asOf: "2026-09-07T12:00:00.000Z",
        freshnessMaxMinutes: 60,
      },
      adapters: [
        createOpenMeteoWeatherAdapter({ fetchImpl }),
        createNwsCurrentWeatherAdapter({ fetchImpl }),
      ],
      maxSources: 2,
      retry: { attempts: 1 },
    });

    expect(receipt.status).toBe("ready");
    expect(receipt.freshnessWarnings).toEqual([]);
    expect(receipt.staleSourceWarnings).toEqual(
      expect.arrayContaining(["temperature_2m from open-meteo-weather is 120m old"]),
    );
    expect(receipt.normalizedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "temperature_2m", value: 20 }),
        expect.objectContaining({ name: "pressure_msl", value: 1015 }),
      ]),
    );
    expect(receipt.conflicts).toEqual([]);
  });

  it("excludes future-dated fields from a historical asOf and raises a warning", async () => {
    const fetchImpl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          current: { time: "2026-09-07T13:00", temperature_2m: 18 },
        }),
    });
    const receipt = await runGeospatialRefresh({
      request: {
        kind: "weather",
        query: "31,121",
        asOf: "2026-09-07T12:00:00.000Z",
        freshnessMaxMinutes: 60,
      },
      adapters: [createOpenMeteoWeatherAdapter({ fetchImpl })],
      retry: { attempts: 1 },
    });

    expect(receipt.status).toBe("needs_review");
    expect(receipt.normalizedFields).toEqual([]);
    expect(receipt.freshnessWarnings).toContain(
      "temperature_2m from open-meteo-weather is newer than requested asOf 2026-09-07T12:00:00.000Z",
    );
    expect(receipt.requiredNextSteps).toContain("review_future_dated_observations");
  });
});

describe("geospatial API transport governance", () => {
  it("propagates cancellation to an active built-in weather HTTP request", async () => {
    const controller = new AbortController();
    let httpSignal: AbortSignal | undefined;
    const fetchImpl: FetchImpl = async (_url, init) => {
      httpSignal = init?.signal;
      controller.abort("private-reason");
      return new Promise(() => {});
    };
    const receipt = await runGeospatialRefresh({
      request: { kind: "weather", query: "31,121", asOf: AS_OF },
      adapters: [createOpenMeteoWeatherAdapter({ fetchImpl })],
      signal: controller.signal,
    });
    expect(httpSignal?.aborted).toBe(true);
    expect(receipt.status).toBe("blocked");
    expect(receipt.sourceAttempts[0].apiCalls).toEqual([
      expect.objectContaining({ operation: "http_get", status: "cancelled" }),
      expect.objectContaining({ operation: "collect", status: "cancelled" }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain("private-reason");
  });

  it("aborts an in-flight weather request at the registry timeout", async () => {
    let httpSignal: AbortSignal | undefined;
    const fetchImpl: FetchImpl = async (_url, init) => {
      httpSignal = init?.signal;
      return new Promise(() => {});
    };
    const receipt = await runGeospatialRefresh({
      request: { kind: "weather", query: "31,121", asOf: AS_OF },
      adapters: [createOpenMeteoWeatherAdapter({ fetchImpl })],
      timeoutMs: 10,
    });
    expect(httpSignal?.aborted).toBe(true);
    expect(receipt.sourceAttempts[0].apiCalls?.every((r) => r.status === "timed_out")).toBe(true);
  });

  it("labels public source calls and preserves a per-adapter idempotency key", async () => {
    const fetchImpl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ current: { time: "2026-09-07T10:30", temperature_2m: 26.7 } }),
    });
    const receipt = await runGeospatialRefresh({
      request: { kind: "weather", query: "31,121", asOf: AS_OF },
      adapters: [createOpenMeteoWeatherAdapter({ fetchImpl })],
      correlationId: "geospatial-test",
    });
    expect(receipt.sourceAttempts[0].apiCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authScopeLabel: "public",
          idempotencyKey: "geospatial-test:open_meteo_current_weather",
        }),
      ]),
    );
  });
});
