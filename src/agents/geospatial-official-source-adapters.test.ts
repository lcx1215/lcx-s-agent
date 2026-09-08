import { describe, expect, it } from "vitest";
import { createNwsCurrentWeatherAdapter } from "./geospatial-official-source-adapters.js";

describe("official geospatial source adapters", () => {
  it("normalizes NOAA/NWS as an official weather cross-check", async () => {
    const adapter = createNwsCurrentWeatherAdapter({
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        text: async () =>
          url.includes("/points/")
            ? JSON.stringify({
                properties: { observationStations: "https://api.weather.gov/gridpoints/TEST/1,1" },
              })
            : url.includes("gridpoints")
              ? JSON.stringify({
                  features: [{ properties: { stationIdentifier: "KTEST" } }],
                })
              : JSON.stringify({
                  properties: {
                    timestamp: "2026-09-07T11:59:00Z",
                    temperature: { value: 22.5 },
                    relativeHumidity: { value: 55 },
                    barometricPressure: { value: 101325 },
                    windSpeed: { value: 12 },
                    textDescription: "Clear",
                  },
                }),
      }),
    });
    expect(adapter.providerRole).toBe("official_reference");
    expect(adapter.sourceFamily).toBe("weather_environmental");
    const observation = await adapter.collect(
      { kind: "weather", query: "38.8977,-77.0365", asOf: "2026-09-07T12:00:00.000Z" },
      new AbortController().signal,
    );
    expect(observation.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "temperature_2m", value: 22.5 }),
        expect.objectContaining({ name: "pressure_msl", value: 1013.25 }),
      ]),
    );
  });

  it("converts NWS wind speeds reported in metres per second", async () => {
    const adapter = createNwsCurrentWeatherAdapter({
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        text: async () =>
          url.includes("/points/")
            ? JSON.stringify({
                properties: { observationStations: "https://api.weather.gov/stations" },
              })
            : url.endsWith("/stations")
              ? JSON.stringify({ features: [{ properties: { stationIdentifier: "KTEST" } }] })
              : JSON.stringify({
                  properties: {
                    timestamp: "2026-09-07T11:59:00Z",
                    windSpeed: { value: 5, unitCode: "wmoUnit:m_s-1" },
                  },
                }),
      }),
    });
    const observation = await adapter.collect(
      { kind: "weather", query: "38.8977,-77.0365", asOf: "2026-09-07T12:00:00.000Z" },
      new AbortController().signal,
    );
    expect(observation.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "wind_speed_10m", value: 18, unit: "km/h" }),
      ]),
    );
  });
});
