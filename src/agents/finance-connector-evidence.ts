/**
 * Bridge from raw connector payloads to gateway-shaped evidence.
 *
 * A connector call returns whatever the vendor returns. The gateway will not accept a number
 * without a timestamp, a definition, and a source, so something has to attach that metadata —
 * doing it by hand each time is how wrong numbers reach an answer.
 *
 * Mappings exist only for payloads whose shape has been observed against the live endpoint.
 * Anything else is reported as unmapped rather than guessed at.
 */

import { findFinanceDataConnector } from "./finance-data-connectors.js";
import type {
  FinanceDataGatewayFieldInput,
  FinanceDataGatewayObservationInput,
} from "./finance-data-gateway.js";

type Row = Record<string, unknown>;

const obj = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export type ConnectorObservationMapping = Readonly<{
  connectorId: string;
  observation?: FinanceDataGatewayObservationInput;
  unmappedReason?: string;
}>;

function field(params: {
  name: string;
  value: string | number;
  sourceTimestamp: string;
  fieldDefinition: string;
  sourceUrlOrArtifact: string;
}): FinanceDataGatewayFieldInput {
  return {
    name: params.name,
    value: params.value,
    sourceTimestamp: params.sourceTimestamp,
    fieldDefinition: params.fieldDefinition,
    sourceUrlOrArtifact: params.sourceUrlOrArtifact,
  };
}

/**
 * SEC submissions feed. Shape verified live: `filings.recent.{form,filingDate}` are parallel
 * arrays, newest first.
 */
function mapSecEdgarSubmissions(params: {
  payload: unknown;
  sourceUrlOrArtifact: string;
  observedAt: string;
  timezone: string;
}): FinanceDataGatewayObservationInput {
  const row = obj(params.payload);
  const recent = obj(obj(row.filings).recent);
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const dates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const latestDate = str(dates[0]);
  const latestForm = str(forms[0]);
  const entityName = str(row.name);
  // The feed carries no "as of" of its own; the newest filing date is the most defensible
  // timestamp in it, and anything without one falls back to the collection instant.
  const evidenceTimestamp = latestDate ?? params.observedAt;

  const fields: FinanceDataGatewayFieldInput[] = [
    field({
      name: "recent_filing_count",
      value: forms.length,
      sourceTimestamp: evidenceTimestamp,
      fieldDefinition: "Number of filings present in the SEC submissions recent feed for this CIK",
      sourceUrlOrArtifact: params.sourceUrlOrArtifact,
    }),
  ];
  if (latestForm) {
    fields.push(
      field({
        name: "latest_filing_form",
        value: latestForm,
        sourceTimestamp: evidenceTimestamp,
        fieldDefinition: "Form type of the most recent filing in the SEC submissions recent feed",
        sourceUrlOrArtifact: params.sourceUrlOrArtifact,
      }),
    );
  }
  if (latestDate) {
    fields.push(
      field({
        name: "latest_filing_date",
        value: latestDate,
        sourceTimestamp: evidenceTimestamp,
        fieldDefinition: "Filing date of the most recent filing in the SEC submissions recent feed",
        sourceUrlOrArtifact: params.sourceUrlOrArtifact,
      }),
    );
  }
  if (entityName) {
    fields.push(
      field({
        name: "registrant_name",
        value: entityName,
        sourceTimestamp: evidenceTimestamp,
        fieldDefinition: "Registrant name as reported in the SEC submissions record",
        sourceUrlOrArtifact: params.sourceUrlOrArtifact,
      }),
    );
  }

  return {
    providerName: "sec_edgar",
    providerRole: "official_or_issuer_reference",
    sourceFamily: "official_filing",
    observedAt: params.observedAt,
    timezone: params.timezone,
    delayStatus: "end_of_day",
    fields,
  };
}

const MAPPERS: Record<
  string,
  (params: {
    payload: unknown;
    sourceUrlOrArtifact: string;
    observedAt: string;
    timezone: string;
  }) => FinanceDataGatewayObservationInput
> = {
  sec_edgar_rest: mapSecEdgarSubmissions,
};

export function mapConnectorPayloadToObservation(params: {
  connectorId: string;
  payload: unknown;
  sourceUrlOrArtifact: string;
  observedAt?: string;
  timezone?: string;
}): ConnectorObservationMapping {
  const mapper = MAPPERS[params.connectorId];
  if (!mapper) {
    return {
      connectorId: params.connectorId,
      unmappedReason: "no_field_mapping_declared_for_this_connector",
    };
  }
  const connector = findFinanceDataConnector(params.connectorId);
  const observedAt = params.observedAt ?? new Date().toISOString();
  const observation = mapper({
    payload: params.payload,
    sourceUrlOrArtifact: params.sourceUrlOrArtifact,
    observedAt,
    timezone: params.timezone ?? "UTC",
  });
  // Keep provider identity from the registry so a mapping can never contradict the declaration.
  return {
    connectorId: params.connectorId,
    observation: connector
      ? {
          ...observation,
          providerName: connector.provider,
          providerRole: connector.providerRole,
          sourceFamily: connector.sourceFamily,
        }
      : observation,
  };
}
