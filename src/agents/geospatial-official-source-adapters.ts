import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import type {
  GeospatialSourceAdapter,
  GeospatialSourceField,
  GeospatialSourceObservation,
  GeospatialSourceRequest,
} from "./geospatial-source-registry.js";

class OfficialGeospatialSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficialGeospatialSourceError";
  }
}

function parseCoordinates(query: string): Readonly<{ latitude: number; longitude: number }> {
  const parts = query.split(",").map((part) => part.trim());
  if (parts.length !== 2) {
    throw new OfficialGeospatialSourceError("weather query must be latitude,longitude");
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new OfficialGeospatialSourceError("coordinates are outside WGS84 bounds");
  }
  return { latitude, longitude };
}

function parseFiniteNumber(value: unknown, label: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new OfficialGeospatialSourceError(`${label} must be a finite number`);
  }
  return parsed;
}

function parseTimestamp(value: unknown, fallback: string, label: string): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (Number.isFinite(Date.parse(fallback))) {
    return fallback;
  }
  throw new OfficialGeospatialSourceError(`${label} must be a valid timestamp`);
}

async function fetchJson(fetchImpl: FetchImpl, url: string): Promise<unknown> {
  let response: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/geo+json, application/ld+json, application/json",
        "User-Agent": "LCX-Agent/1.0 research-only weather reference",
      },
    });
  } catch (error) {
    throw new OfficialGeospatialSourceError(
      `source request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new OfficialGeospatialSourceError(`source http status ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new OfficialGeospatialSourceError("source returned an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new OfficialGeospatialSourceError("source returned invalid JSON");
  }
}

function field(
  name: string,
  value: string | number,
  unit: string | undefined,
  sourceTimestamp: string,
  sourceUrlOrArtifact: string,
  fieldDefinition: string,
): GeospatialSourceField {
  return {
    name,
    value,
    ...(unit ? { unit } : {}),
    sourceTimestamp,
    fieldDefinition,
    sourceUrlOrArtifact,
  };
}

export function createNwsCurrentWeatherAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): GeospatialSourceAdapter {
  return {
    id: "nws_official_current_weather",
    providerName: "noaa-national-weather-service",
    providerRole: "official_reference",
    sourceFamily: "weather_environmental",
    priority: 15,
    supports: (request: GeospatialSourceRequest) => request.kind === "weather",
    collect: async (request: GeospatialSourceRequest): Promise<GeospatialSourceObservation> => {
      const { latitude, longitude } = parseCoordinates(request.query);
      const fetchImpl = resolveFinanceFetch(options.fetchImpl);
      const pointsUrl = `https://api.weather.gov/points/${latitude},${longitude}`;
      const points = (await fetchJson(fetchImpl, pointsUrl)) as {
        properties?: { observationStations?: unknown };
      };
      const stationsUrl = points.properties?.observationStations;
      if (typeof stationsUrl !== "string" || !stationsUrl) {
        throw new OfficialGeospatialSourceError("NWS returned no observation station index");
      }
      const stations = (await fetchJson(fetchImpl, stationsUrl)) as {
        features?: Array<{ properties?: { stationIdentifier?: unknown } }>;
      };
      const stationId = stations.features?.find(
        (candidate) => typeof candidate.properties?.stationIdentifier === "string",
      )?.properties?.stationIdentifier;
      if (typeof stationId !== "string" || !stationId) {
        throw new OfficialGeospatialSourceError("NWS returned no observation station");
      }
      const observationsUrl = `https://api.weather.gov/stations/${encodeURIComponent(stationId)}/observations/latest`;
      const latest = (await fetchJson(fetchImpl, observationsUrl)) as {
        properties?: {
          timestamp?: unknown;
          temperature?: { value?: unknown };
          relativeHumidity?: { value?: unknown };
          barometricPressure?: { value?: unknown };
          windSpeed?: { value?: unknown };
          textDescription?: unknown;
        };
      };
      const properties = latest.properties;
      if (!properties?.timestamp) {
        throw new OfficialGeospatialSourceError("NWS returned no latest observation timestamp");
      }
      const sourceTimestamp = parseTimestamp(
        properties.timestamp,
        request.asOf,
        "NWS observation timestamp",
      );
      const fields: GeospatialSourceField[] = [];
      if (properties.temperature?.value !== null && properties.temperature?.value !== undefined) {
        fields.push(
          field(
            "temperature_2m",
            parseFiniteNumber(properties.temperature.value, "NWS temperature"),
            "°C",
            sourceTimestamp,
            observationsUrl,
            "NWS official station air temperature; station height varies by location",
          ),
        );
      }
      if (
        properties.relativeHumidity?.value !== null &&
        properties.relativeHumidity?.value !== undefined
      ) {
        fields.push(
          field(
            "relative_humidity_2m",
            parseFiniteNumber(properties.relativeHumidity.value, "NWS relative humidity"),
            "%",
            sourceTimestamp,
            observationsUrl,
            "NWS official station relative humidity",
          ),
        );
      }
      if (
        properties.barometricPressure?.value !== null &&
        properties.barometricPressure?.value !== undefined
      ) {
        fields.push(
          field(
            "pressure_msl",
            parseFiniteNumber(properties.barometricPressure.value, "NWS pressure") / 100,
            "hPa",
            sourceTimestamp,
            observationsUrl,
            "NWS official station barometric pressure converted from Pa to hPa",
          ),
        );
      }
      if (properties.windSpeed?.value !== null && properties.windSpeed?.value !== undefined) {
        fields.push(
          field(
            "wind_speed_10m",
            parseFiniteNumber(properties.windSpeed.value, "NWS wind speed"),
            "km/h",
            sourceTimestamp,
            observationsUrl,
            "NWS official station wind speed; station height varies by location",
          ),
        );
      }
      if (typeof properties.textDescription === "string" && properties.textDescription) {
        fields.push(
          field(
            "weather_description",
            properties.textDescription,
            undefined,
            sourceTimestamp,
            observationsUrl,
            "NWS official station text weather description",
          ),
        );
      }
      if (fields.length === 0) {
        throw new OfficialGeospatialSourceError("NWS returned no usable current weather fields");
      }
      return {
        providerName: "noaa-national-weather-service",
        providerRole: "official_reference",
        sourceFamily: "weather_environmental",
        observedAt: request.asOf,
        timezone: "UTC",
        fields,
      };
    },
  };
}
