import { resolveFinanceFetch, type FetchImpl } from "./finance-live-market-source.js";
import { createNwsCurrentWeatherAdapter } from "./geospatial-official-source-adapters.js";

export const GEOSPATIAL_SOURCE_KINDS = ["geocode", "weather", "earthquake"] as const;
export type GeospatialSourceKind = (typeof GEOSPATIAL_SOURCE_KINDS)[number];

type GeospatialSourceRole = "primary_reference" | "cross_check_reference" | "official_reference";

type GeospatialSourceFamily =
  | "geospatial_reference"
  | "weather_environmental"
  | "seismic_event_feed";

export type GeospatialSourceRequest = Readonly<{
  kind: GeospatialSourceKind;
  query: string;
  asOf: string;
  freshnessMaxMinutes?: number;
}>;

export type GeospatialSourceField = Readonly<{
  name: string;
  value: string | number;
  unit?: string;
  sourceTimestamp: string;
  fieldDefinition: string;
  sourceUrlOrArtifact: string;
}>;

export type GeospatialSourceObservation = Readonly<{
  providerName: string;
  providerRole: GeospatialSourceRole;
  sourceFamily: GeospatialSourceFamily;
  observedAt: string;
  timezone: string;
  fields: readonly GeospatialSourceField[];
}>;

export type GeospatialSourceAdapter = Readonly<{
  id: string;
  providerName: string;
  providerRole: GeospatialSourceRole;
  sourceFamily: GeospatialSourceFamily;
  priority: number;
  supports: (request: GeospatialSourceRequest) => boolean;
  collect: (
    request: GeospatialSourceRequest,
    signal: AbortSignal,
  ) => Promise<GeospatialSourceObservation>;
}>;

export type GeospatialSourceAttempt = Readonly<{
  adapterId: string;
  providerName: string;
  providerRole: GeospatialSourceRole;
  status: "succeeded" | "failed";
  latencyMs: number;
  error?: string;
}>;

export type GeospatialRefreshReceipt = Readonly<{
  schemaVersion: "lcx_geospatial_refresh_v1";
  boundary: "geospatial_refresh_research_only";
  request: GeospatialSourceRequest;
  status: "ready" | "needs_review" | "blocked";
  sourceAttempts: readonly GeospatialSourceAttempt[];
  selectedSourceIds: readonly string[];
  observations: readonly GeospatialSourceObservation[];
  normalizedFields: readonly GeospatialSourceField[];
  conflicts: readonly Readonly<{
    fieldName: string;
    providerValues: readonly Readonly<{
      providerName: string;
      value: string | number;
      sourceTimestamp: string;
    }>[];
  }>[];
  freshnessWarnings: readonly string[];
  missingEvidence: readonly string[];
  requiredNextSteps: readonly string[];
  notTouched: readonly string[];
}>;

class GeospatialSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeospatialSourceError";
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new GeospatialSourceError(`${label} required`);
  }
  return normalized;
}

function assertIsoTimestamp(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new GeospatialSourceError(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function parseFiniteNumber(value: unknown, label: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new GeospatialSourceError(`${label} must be a finite number`);
  }
  return parsed;
}

async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let response: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new GeospatialSourceError(
      `source request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new GeospatialSourceError(`source http status ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new GeospatialSourceError("source returned an empty body");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new GeospatialSourceError("source returned invalid JSON");
  }
}

function normalizeRequest(request: GeospatialSourceRequest): GeospatialSourceRequest {
  if (!GEOSPATIAL_SOURCE_KINDS.includes(request.kind)) {
    throw new GeospatialSourceError(`unsupported geospatial source kind: ${request.kind}`);
  }
  return {
    kind: request.kind,
    query: requiredText(request.query, "query"),
    asOf: assertIsoTimestamp(request.asOf, "asOf"),
    freshnessMaxMinutes: request.freshnessMaxMinutes,
  };
}

function parseCoordinates(query: string): Readonly<{ latitude: number; longitude: number }> {
  const parts = query.split(",").map((part) => part.trim());
  if (parts.length !== 2) {
    throw new GeospatialSourceError("weather query must be latitude,longitude");
  }
  const latitude = parseFiniteNumber(parts[0], "latitude");
  const longitude = parseFiniteNumber(parts[1], "longitude");
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new GeospatialSourceError("coordinates are outside WGS84 bounds");
  }
  return { latitude, longitude };
}

function geocodeObservation(options: {
  providerName: string;
  providerRole: GeospatialSourceRole;
  observedAt: string;
  sourceUrlOrArtifact: string;
  fields: readonly GeospatialSourceField[];
}): GeospatialSourceObservation {
  return {
    providerName: options.providerName,
    providerRole: options.providerRole,
    sourceFamily: "geospatial_reference",
    observedAt: options.observedAt,
    timezone: "UTC",
    fields: options.fields,
  };
}

export function createOpenMeteoGeocodingAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): GeospatialSourceAdapter {
  return {
    id: "open_meteo_geocoding",
    providerName: "open-meteo-geocoding",
    providerRole: "primary_reference",
    sourceFamily: "geospatial_reference",
    priority: 10,
    supports: (request) => request.kind === "geocode",
    collect: async (request) => {
      const sourceUrlOrArtifact = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(request.query)}&count=1&language=en&format=json`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
      )) as {
        results?: Array<{
          id?: number;
          name?: string;
          latitude?: number;
          longitude?: number;
          elevation?: number;
          timezone?: string;
          country_code?: string;
          country?: string;
          admin1?: string;
        }>;
      };
      const result = payload.results?.[0];
      if (!result?.name || result.latitude === undefined || result.longitude === undefined) {
        throw new GeospatialSourceError("Open-Meteo returned no geocoding result");
      }
      const sourceTimestamp = request.asOf;
      const fields: GeospatialSourceField[] = [
        {
          name: "latitude",
          value: parseFiniteNumber(result.latitude, "Open-Meteo latitude"),
          unit: "degrees",
          sourceTimestamp,
          fieldDefinition: "Open-Meteo geocoding WGS84 latitude",
          sourceUrlOrArtifact,
        },
        {
          name: "longitude",
          value: parseFiniteNumber(result.longitude, "Open-Meteo longitude"),
          unit: "degrees",
          sourceTimestamp,
          fieldDefinition: "Open-Meteo geocoding WGS84 longitude",
          sourceUrlOrArtifact,
        },
        {
          name: "resolved_name",
          value: result.name,
          sourceTimestamp,
          fieldDefinition: "Open-Meteo resolved place name",
          sourceUrlOrArtifact,
        },
      ];
      for (const [name, value, definition] of [
        ["elevation_m", result.elevation, "Open-Meteo terrain elevation"],
        ["location_id", result.id, "Open-Meteo GeoNames-compatible location identifier"],
      ] as const) {
        if (value !== undefined) {
          fields.push({
            name,
            value: parseFiniteNumber(value, definition),
            unit: name === "elevation_m" ? "m" : undefined,
            sourceTimestamp,
            fieldDefinition: definition,
            sourceUrlOrArtifact,
          });
        }
      }
      for (const [name, value, definition] of [
        ["timezone", result.timezone, "Open-Meteo IANA timezone"],
        ["country_code", result.country_code, "Open-Meteo ISO country code"],
        ["country", result.country, "Open-Meteo country name"],
        ["admin1", result.admin1, "Open-Meteo first-level administrative area"],
      ] as const) {
        if (value) {
          fields.push({
            name,
            value,
            sourceTimestamp,
            fieldDefinition: definition,
            sourceUrlOrArtifact,
          });
        }
      }
      return geocodeObservation({
        providerName: "open-meteo-geocoding",
        providerRole: "primary_reference",
        observedAt: request.asOf,
        sourceUrlOrArtifact,
        fields,
      });
    },
  };
}

export function createNominatimGeocodingAdapter(
  options: { fetchImpl?: FetchImpl; minIntervalMs?: number } = {},
): GeospatialSourceAdapter {
  let lastRequestAt = 0;
  const minIntervalMs = options.minIntervalMs ?? 1_100;
  return {
    id: "nominatim_osm_geocoding",
    providerName: "nominatim-openstreetmap",
    providerRole: "cross_check_reference",
    sourceFamily: "geospatial_reference",
    priority: 15,
    supports: (request) => request.kind === "geocode",
    collect: async (request) => {
      const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRequestAt));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      lastRequestAt = Date.now();
      const sourceUrlOrArtifact = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(request.query)}&format=jsonv2&limit=1&addressdetails=1`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
        { "User-Agent": "LCX Agent research-only geocoder/1.0" },
      )) as Array<{
        lat?: string;
        lon?: string;
        display_name?: string;
        osm_id?: number;
        address?: Record<string, string>;
      }>;
      const result = payload[0];
      if (!result?.lat || !result.lon || !result.display_name) {
        throw new GeospatialSourceError("Nominatim returned no geocoding result");
      }
      const sourceTimestamp = request.asOf;
      const fields: GeospatialSourceField[] = [
        {
          name: "latitude",
          value: parseFiniteNumber(result.lat, "Nominatim latitude"),
          unit: "degrees",
          sourceTimestamp,
          fieldDefinition: "Nominatim OpenStreetMap WGS84 latitude",
          sourceUrlOrArtifact,
        },
        {
          name: "longitude",
          value: parseFiniteNumber(result.lon, "Nominatim longitude"),
          unit: "degrees",
          sourceTimestamp,
          fieldDefinition: "Nominatim OpenStreetMap WGS84 longitude",
          sourceUrlOrArtifact,
        },
        {
          name: "display_name",
          value: result.display_name,
          sourceTimestamp,
          fieldDefinition: "Nominatim OpenStreetMap display name",
          sourceUrlOrArtifact,
        },
      ];
      if (result.osm_id !== undefined) {
        fields.push({
          name: "osm_id",
          value: result.osm_id,
          sourceTimestamp,
          fieldDefinition: "OpenStreetMap object identifier",
          sourceUrlOrArtifact,
        });
      }
      return geocodeObservation({
        providerName: "nominatim-openstreetmap",
        providerRole: "cross_check_reference",
        observedAt: request.asOf,
        sourceUrlOrArtifact,
        fields,
      });
    },
  };
}

export function createOpenMeteoWeatherAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): GeospatialSourceAdapter {
  return {
    id: "open_meteo_current_weather",
    providerName: "open-meteo-weather",
    providerRole: "primary_reference",
    sourceFamily: "weather_environmental",
    priority: 10,
    supports: (request) => request.kind === "weather",
    collect: async (request) => {
      const { latitude, longitude } = parseCoordinates(request.query);
      const sourceUrlOrArtifact = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m&timezone=UTC`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
      )) as {
        current?: {
          time?: string;
          temperature_2m?: number;
          relative_humidity_2m?: number;
          pressure_msl?: number;
          wind_speed_10m?: number;
        };
      };
      const current = payload.current;
      if (!current?.time) {
        throw new GeospatialSourceError("Open-Meteo returned no current weather block");
      }
      const sourceTimestamp = assertIsoTimestamp(
        new Date(current.time).toISOString(),
        "Open-Meteo current time",
      );
      const fields: GeospatialSourceField[] = [];
      for (const [name, value, unit, definition] of [
        ["temperature_2m", current.temperature_2m, "°C", "Open-Meteo current 2m temperature"],
        [
          "relative_humidity_2m",
          current.relative_humidity_2m,
          "%",
          "Open-Meteo current 2m relative humidity",
        ],
        ["pressure_msl", current.pressure_msl, "hPa", "Open-Meteo current mean sea-level pressure"],
        ["wind_speed_10m", current.wind_speed_10m, "km/h", "Open-Meteo current 10m wind speed"],
      ] as const) {
        if (value !== undefined) {
          fields.push({
            name,
            value: parseFiniteNumber(value, definition),
            unit,
            sourceTimestamp,
            fieldDefinition: definition,
            sourceUrlOrArtifact,
          });
        }
      }
      if (fields.length === 0) {
        throw new GeospatialSourceError("Open-Meteo returned no current weather fields");
      }
      return {
        providerName: "open-meteo-weather",
        providerRole: "primary_reference",
        sourceFamily: "weather_environmental",
        observedAt: request.asOf,
        timezone: "UTC",
        fields,
      };
    },
  };
}

function timestampFromMilliseconds(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = new Date(value).toISOString();
    if (Number.isFinite(Date.parse(timestamp))) {
      return timestamp;
    }
  }
  return fallback;
}

export function createUsGSEarthquakeAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): GeospatialSourceAdapter {
  return {
    id: "usgs_realtime_earthquake_feed",
    providerName: "usgs-earthquake-feed",
    providerRole: "official_reference",
    sourceFamily: "seismic_event_feed",
    priority: 10,
    supports: (request) => request.kind === "earthquake",
    collect: async (request) => {
      const window = request.query.trim() || "all_day";
      if (!("all_hour" === window || "all_day" === window || "all_week" === window)) {
        throw new GeospatialSourceError("earthquake query must be all_hour, all_day, or all_week");
      }
      const sourceUrlOrArtifact = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${window}.geojson`;
      const payload = (await fetchJson(
        resolveFinanceFetch(options.fetchImpl),
        sourceUrlOrArtifact,
      )) as {
        metadata?: { generated?: number };
        features?: Array<{
          properties?: { mag?: number; time?: number; title?: string };
        }>;
      };
      const features = payload.features ?? [];
      const generatedAt = timestampFromMilliseconds(payload.metadata?.generated, request.asOf);
      const latest = features
        .filter((feature) => typeof feature.properties?.time === "number")
        .toSorted((left, right) => (right.properties?.time ?? 0) - (left.properties?.time ?? 0))[0];
      const magnitudes = features
        .map((feature) => feature.properties?.mag)
        .filter(
          (magnitude): magnitude is number =>
            typeof magnitude === "number" && Number.isFinite(magnitude),
        );
      const fields: GeospatialSourceField[] = [
        {
          name: "earthquake_count",
          value: features.length,
          sourceTimestamp: generatedAt,
          fieldDefinition: `USGS count of earthquake features in the ${window} feed`,
          sourceUrlOrArtifact,
        },
      ];
      if (magnitudes.length > 0) {
        fields.push({
          name: "max_magnitude",
          value: Math.max(...magnitudes),
          sourceTimestamp: generatedAt,
          fieldDefinition: `USGS maximum reported magnitude in the ${window} feed`,
          sourceUrlOrArtifact,
        });
      }
      if (latest?.properties?.title) {
        fields.push({
          name: "latest_event_title",
          value: latest.properties.title,
          sourceTimestamp: timestampFromMilliseconds(latest.properties.time, generatedAt),
          fieldDefinition: "USGS latest event title in the selected feed",
          sourceUrlOrArtifact,
        });
      }
      return {
        providerName: "usgs-earthquake-feed",
        providerRole: "official_reference",
        sourceFamily: "seismic_event_feed",
        observedAt: request.asOf,
        timezone: "UTC",
        fields,
      };
    },
  };
}

export function createGeospatialSourceRegistry(
  options: {
    fetchImpl?: FetchImpl;
    nominatimMinIntervalMs?: number;
  } = {},
): readonly GeospatialSourceAdapter[] {
  return [
    createOpenMeteoGeocodingAdapter({ fetchImpl: options.fetchImpl }),
    createNominatimGeocodingAdapter({
      fetchImpl: options.fetchImpl,
      minIntervalMs: options.nominatimMinIntervalMs,
    }),
    createOpenMeteoWeatherAdapter({ fetchImpl: options.fetchImpl }),
    createNwsCurrentWeatherAdapter({ fetchImpl: options.fetchImpl }),
    createUsGSEarthquakeAdapter({ fetchImpl: options.fetchImpl }),
  ];
}

export function inspectGeospatialSourceRegistry(
  request: GeospatialSourceRequest,
  adapters: readonly GeospatialSourceAdapter[],
) {
  const normalizedRequest = normalizeRequest(request);
  return {
    schemaVersion: "lcx_geospatial_refresh_v1" as const,
    boundary: "geospatial_source_registry_local_only" as const,
    request: normalizedRequest,
    candidateAdapters: adapters
      .filter((adapter) => adapter.supports(normalizedRequest))
      .toSorted((left, right) => left.priority - right.priority)
      .map((adapter) => ({
        id: adapter.id,
        providerName: adapter.providerName,
        providerRole: adapter.providerRole,
        sourceFamily: adapter.sourceFamily,
        priority: adapter.priority,
      })),
    noNetworkCalled: true as const,
  };
}

async function collectWithTimeout(
  adapter: GeospatialSourceAdapter,
  request: GeospatialSourceRequest,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<GeospatialSourceObservation> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      adapter.collect(request, controller.signal),
      new Promise<GeospatialSourceObservation>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(new GeospatialSourceError(`adapter ${adapter.id} timed out or was cancelled`)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runGeospatialRefresh(options: {
  request: GeospatialSourceRequest;
  adapters: readonly GeospatialSourceAdapter[];
  maxSources?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GeospatialRefreshReceipt> {
  const request = normalizeRequest(options.request);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GeospatialSourceError("timeoutMs must be a positive number");
  }
  const candidates = options.adapters
    .filter((adapter) => adapter.supports(request))
    .toSorted((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const maxSources = options.maxSources ?? candidates.length;
  if (!Number.isInteger(maxSources) || maxSources <= 0) {
    throw new GeospatialSourceError("maxSources must be a positive integer");
  }
  const selected = candidates.slice(0, maxSources);
  const sourceAttempts: GeospatialSourceAttempt[] = [];
  const observations: GeospatialSourceObservation[] = [];
  for (const adapter of selected) {
    const startedAt = Date.now();
    try {
      observations.push(await collectWithTimeout(adapter, request, timeoutMs, options.signal));
      sourceAttempts.push({
        adapterId: adapter.id,
        providerName: adapter.providerName,
        providerRole: adapter.providerRole,
        status: "succeeded",
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      sourceAttempts.push({
        adapterId: adapter.id,
        providerName: adapter.providerName,
        providerRole: adapter.providerRole,
        status: "failed",
        latencyMs: Math.max(0, Date.now() - startedAt),
        error: errorText(error),
      });
    }
  }

  const fieldNames = unique(
    observations.flatMap((observation) => observation.fields.map((field) => field.name)),
  ).toSorted();
  const normalizedFields = fieldNames.flatMap((fieldName) => {
    const candidatesForField = observations.flatMap((observation) =>
      observation.fields
        .filter((field) => field.name === fieldName)
        .map((field) => ({ field, observation })),
    );
    const selectedField =
      candidatesForField.find(
        ({ observation }) => observation.providerRole === "primary_reference",
      ) ?? candidatesForField[0];
    return selectedField ? [selectedField.field] : [];
  });
  const conflicts = fieldNames.flatMap((fieldName) => {
    const candidatesForField = observations.flatMap((observation) =>
      observation.fields
        .filter((field) => field.name === fieldName)
        .map((field) => ({ field, observation })),
    );
    const identities = unique(candidatesForField.map(({ field }) => JSON.stringify(field.value)));
    if (identities.length <= 1) {
      return [];
    }
    return [
      {
        fieldName,
        providerValues: candidatesForField.map(({ field, observation }) => ({
          providerName: observation.providerName,
          value: field.value,
          sourceTimestamp: field.sourceTimestamp,
        })),
      },
    ];
  });
  const asOfMs = Date.parse(request.asOf);
  const freshnessMaxMinutes = request.freshnessMaxMinutes ?? 60 * 24;
  const freshnessWarnings = observations.flatMap((observation) =>
    observation.fields.flatMap((field) => {
      const ageMinutes = Math.max(0, (asOfMs - Date.parse(field.sourceTimestamp)) / 60_000);
      return ageMinutes > freshnessMaxMinutes
        ? [`${field.name} from ${observation.providerName} is ${Math.round(ageMinutes)}m old`]
        : [];
    }),
  );
  const missingEvidence = observations.length === 0 ? ["successful_geospatial_observation"] : [];
  const requiredNextSteps: string[] = [];
  if (missingEvidence.length > 0) {
    requiredNextSteps.push("inspect_source_attempt_failures", "retry_with_healthy_adapter");
  }
  if (conflicts.length > 0) {
    requiredNextSteps.push("run_geospatial_provenance_review");
  }
  if (freshnessWarnings.length > 0) {
    requiredNextSteps.push("refresh_or_label_stale_fields");
  }
  return {
    schemaVersion: "lcx_geospatial_refresh_v1",
    boundary: "geospatial_refresh_research_only",
    request,
    status:
      missingEvidence.length > 0
        ? "blocked"
        : conflicts.length > 0 || freshnessWarnings.length > 0
          ? "needs_review"
          : "ready",
    sourceAttempts,
    selectedSourceIds: selected.map((adapter) => adapter.id),
    observations,
    normalizedFields,
    conflicts,
    freshnessWarnings,
    missingEvidence,
    requiredNextSteps: unique(requiredNextSteps),
    notTouched: [
      "provider_config",
      "external_channel_sender",
      "protected_memory",
      "trading_execution",
      "wallet_or_order_authority",
    ],
  };
}
