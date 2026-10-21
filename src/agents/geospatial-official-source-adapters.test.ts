import { describe, expect, it } from "vitest";
import { createNwsCurrentWeatherAdapter } from "./geospatial-official-source-adapters.js";
import {
  createOpenMeteoWeatherAdapter,
  runGeospatialRefresh,
} from "./geospatial-source-registry.js";

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
        expect.objectContaining({ name: "barometric_pressure", value: 1013.25, unit: "hPa" }),
      ]),
    );
  });

  it("keeps NWS barometric measurements separate from actual mean-sea-level pressure", async () => {
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.includes("open-meteo")
            ? { current: { time: "2026-09-07T11:59:00", pressure_msl: 1015 } }
            : url.includes("/points/")
              ? { properties: { observationStations: "https://api.weather.gov/stations" } }
              : url.endsWith("/stations")
                ? { features: [{ properties: { stationIdentifier: "KTEST" } }] }
                : {
                    properties: {
                      timestamp: "2026-09-07T11:59:00Z",
                      barometricPressure: { value: 90000 },
                    },
                  },
        ),
    });
    const receipt = await runGeospatialRefresh({
      request: { kind: "weather", query: "38.8977,-77.0365", asOf: "2026-09-07T12:00:00.000Z" },
      adapters: [
        createOpenMeteoWeatherAdapter({ fetchImpl }),
        createNwsCurrentWeatherAdapter({ fetchImpl }),
      ],
    });
    expect(receipt.sourceAttempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
    expect(receipt.conflicts).toEqual([]);
    expect(receipt.normalizedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "pressure_msl", value: 1015, unit: "hPa" }),
        expect.objectContaining({
          name: "barometric_pressure",
          value: 900,
          unit: "hPa",
          sourceTimestamp: "2026-09-07T11:59:00.000Z",
          fieldDefinition: expect.stringContaining("barometric"),
          sourceUrlOrArtifact: "https://api.weather.gov/stations/KTEST/observations/latest",
        }),
      ]),
    );
    const nws = receipt.observations.find(
      (observation) => observation.providerName === "noaa-national-weather-service",
    );
    expect(nws).toBeDefined();
    expect(nws?.fields.some((field) => field.name === "pressure_msl")).toBe(false);
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
