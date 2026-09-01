export const FINANCE_DATA_PROVIDER_ROLES = [
  "primary_market_data",
  "cross_check_market_data",
  "official_or_issuer_reference",
] as const;

export const FINANCE_DATA_SOURCE_FAMILIES = [
  "market_data_api",
  "fundamentals_api",
  "official_filing",
  "official_macro_data",
  "etf_issuer",
  "manual_snapshot",
  "local_research_artifact",
] as const;

export const FINANCE_DATA_DELAY_STATUSES = [
  "realtime",
  "delayed",
  "end_of_day",
  "official_lagged",
  "manual_or_unknown",
] as const;

export const FINANCE_DATA_QUALITY_STATUSES = ["ready", "needs_review", "blocked"] as const;

export type FinanceDataProviderRole = (typeof FINANCE_DATA_PROVIDER_ROLES)[number];
export type FinanceDataSourceFamily = (typeof FINANCE_DATA_SOURCE_FAMILIES)[number];
export type FinanceDataDelayStatus = (typeof FINANCE_DATA_DELAY_STATUSES)[number];
export type FinanceDataQualityStatus = (typeof FINANCE_DATA_QUALITY_STATUSES)[number];

export type FinanceDataGatewayFieldInput = {
  name: string;
  value: string | number;
  unit?: string;
  currency?: string;
  adjusted?: boolean;
  fieldDefinition: string;
  sourceTimestamp: string;
  sourceUrlOrArtifact: string;
};

export type FinanceDataGatewayObservationInput = {
  providerName: string;
  providerRole: FinanceDataProviderRole;
  sourceFamily: FinanceDataSourceFamily;
  legId?: string;
  observedAt: string;
  timezone: string;
  delayStatus: FinanceDataDelayStatus;
  fields: FinanceDataGatewayFieldInput[];
};

export type FinanceDataGatewayLegInput = {
  legId: string;
  instrument: string;
  venue: string;
  currency: string;
};

export type FinanceDataGatewayInput = {
  instrument: string;
  assetClass: string;
  useCase: string;
  asOf: string;
  freshnessMaxMinutes?: number;
  requireOfficialReference?: boolean;
  legs?: FinanceDataGatewayLegInput[];
  observations: FinanceDataGatewayObservationInput[];
};

export type FinanceDataGatewayNormalizedField = {
  name: string;
  value: string | number;
  unit?: string;
  currency?: string;
  adjusted?: boolean;
  providerName: string;
  providerRole: FinanceDataProviderRole;
  sourceFamily: FinanceDataSourceFamily;
  observedAt: string;
  timezone: string;
  delayStatus: FinanceDataDelayStatus;
  sourceTimestamp: string;
  fieldDefinition: string;
  sourceUrlOrArtifact: string;
};

export type FinanceDataGatewayConflict = {
  fieldName: string;
  providerValues: Array<{
    providerName: string;
    providerRole: FinanceDataProviderRole;
    value: string | number;
    unit?: string;
    currency?: string;
    adjusted?: boolean;
    sourceTimestamp: string;
  }>;
};

export type FinanceDataGatewaySnapshot = {
  ok: boolean;
  boundary: "finance_data_gateway_research_only";
  instrument: string;
  assetClass: string;
  useCase: string;
  asOf: string;
  legs: FinanceDataGatewayLegInput[];
  qualityStatus: FinanceDataQualityStatus;
  providerRolesPresent: FinanceDataProviderRole[];
  sourceFamiliesPresent: FinanceDataSourceFamily[];
  normalizedFields: FinanceDataGatewayNormalizedField[];
  conflicts: FinanceDataGatewayConflict[];
  freshnessWarnings: string[];
  missingEvidence: string[];
  requiredNextSteps: string[];
  evidenceContract: {
    requiredFieldMetadata: string[];
    providerRolePolicy: string;
    conflictPolicy: string;
    visibleAnswerPolicy: string;
    asyncReceiptPolicy: string;
  };
  riskBoundaries: string[];
  notTouched: string[];
};

function trimRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  return normalized;
}

function assertIsoDate(value: string, label: string): string {
  const normalized = trimRequired(value, label);
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizeFieldIdentity(field: FinanceDataGatewayFieldInput): string {
  return JSON.stringify({
    value: field.value,
    unit: field.unit?.trim() || "",
    currency: field.currency?.trim() || "",
    adjusted: field.adjusted ?? null,
  });
}

function selectPrimaryField(
  fieldName: string,
  observations: readonly FinanceDataGatewayObservationInput[],
): FinanceDataGatewayNormalizedField | undefined {
  const candidates = observations.flatMap((observation) =>
    observation.fields
      .filter((field) => field.name.trim() === fieldName)
      .map((field) => ({ field, observation })),
  );
  const selected =
    candidates.find((candidate) => candidate.observation.providerRole === "primary_market_data") ??
    candidates[0];
  if (!selected) {
    return undefined;
  }
  return {
    name: selected.field.name.trim(),
    value: selected.field.value,
    unit: selected.field.unit?.trim() || undefined,
    currency: selected.field.currency?.trim() || undefined,
    adjusted: selected.field.adjusted,
    providerName: selected.observation.providerName.trim(),
    providerRole: selected.observation.providerRole,
    sourceFamily: selected.observation.sourceFamily,
    observedAt: selected.observation.observedAt.trim(),
    timezone: selected.observation.timezone.trim(),
    delayStatus: selected.observation.delayStatus,
    sourceTimestamp: selected.field.sourceTimestamp.trim(),
    fieldDefinition: selected.field.fieldDefinition.trim(),
    sourceUrlOrArtifact: selected.field.sourceUrlOrArtifact.trim(),
  };
}

function buildConflicts(
  fieldNames: readonly string[],
  observations: readonly FinanceDataGatewayObservationInput[],
): FinanceDataGatewayConflict[] {
  return fieldNames.flatMap((fieldName) => {
    const candidates = observations.flatMap((observation) =>
      observation.fields
        .filter((field) => field.name.trim() === fieldName)
        .map((field) => ({ field, observation })),
    );
    const identities = unique(
      candidates.map((candidate) => normalizeFieldIdentity(candidate.field)),
    );
    if (identities.length <= 1) {
      return [];
    }
    return [
      {
        fieldName,
        providerValues: candidates.map((candidate) => ({
          providerName: candidate.observation.providerName.trim(),
          providerRole: candidate.observation.providerRole,
          value: candidate.field.value,
          unit: candidate.field.unit?.trim() || undefined,
          currency: candidate.field.currency?.trim() || undefined,
          adjusted: candidate.field.adjusted,
          sourceTimestamp: candidate.field.sourceTimestamp.trim(),
        })),
      },
    ];
  });
}

export function buildFinanceDataGatewaySnapshot(
  input: FinanceDataGatewayInput,
): FinanceDataGatewaySnapshot {
  const instrument = trimRequired(input.instrument, "instrument");
  const assetClass = trimRequired(input.assetClass, "assetClass");
  const useCase = trimRequired(input.useCase, "useCase");
  const asOf = assertIsoDate(input.asOf, "asOf");
  if (input.observations.length === 0) {
    throw new Error("observations required");
  }

  const missingEvidence: string[] = [];
  const freshnessWarnings: string[] = [];
  const asOfMs = Date.parse(asOf);
  const freshnessMaxMinutes = input.freshnessMaxMinutes ?? 60 * 24;
  const isArbitrageResearch = /arbitrage|套利|relative.?value|cross.?venue|basis|carry/iu.test(
    useCase,
  );
  const legs = (input.legs ?? []).map((leg, legIndex) => ({
    legId: trimRequired(leg.legId, `legs[${legIndex}].legId`),
    instrument: trimRequired(leg.instrument, `legs[${legIndex}].instrument`),
    venue: trimRequired(leg.venue, `legs[${legIndex}].venue`),
    currency: trimRequired(leg.currency, `legs[${legIndex}].currency`),
  }));
  if (isArbitrageResearch) {
    if (legs.length < 2) {
      missingEvidence.push("multi_leg_instrument_and_venue_identity");
    } else {
      const legIds = new Set(legs.map((leg) => leg.legId));
      if (legIds.size !== legs.length) {
        missingEvidence.push("unique_leg_identity");
      }
      const observedLegIds = new Set(
        input.observations.map((observation) => observation.legId).filter(Boolean),
      );
      for (const leg of legs) {
        if (!observedLegIds.has(leg.legId)) {
          missingEvidence.push(`synchronized_observation_missing:${leg.legId}`);
        }
      }
    }
  }

  for (const [observationIndex, observation] of input.observations.entries()) {
    trimRequired(observation.providerName, `observations[${observationIndex}].providerName`);
    assertIsoDate(observation.observedAt, `observations[${observationIndex}].observedAt`);
    trimRequired(observation.timezone, `observations[${observationIndex}].timezone`);
    if (observation.fields.length === 0) {
      missingEvidence.push(`observations[${observationIndex}].fields`);
    }
    for (const [fieldIndex, field] of observation.fields.entries()) {
      trimRequired(field.name, `observations[${observationIndex}].fields[${fieldIndex}].name`);
      trimRequired(
        field.fieldDefinition,
        `observations[${observationIndex}].fields[${fieldIndex}].fieldDefinition`,
      );
      const sourceTimestamp = assertIsoDate(
        field.sourceTimestamp,
        `observations[${observationIndex}].fields[${fieldIndex}].sourceTimestamp`,
      );
      trimRequired(
        field.sourceUrlOrArtifact,
        `observations[${observationIndex}].fields[${fieldIndex}].sourceUrlOrArtifact`,
      );
      const ageMinutes = Math.max(0, (asOfMs - Date.parse(sourceTimestamp)) / 60_000);
      if (ageMinutes > freshnessMaxMinutes) {
        freshnessWarnings.push(
          `${field.name.trim()} from ${observation.providerName.trim()} is ${Math.round(ageMinutes)}m old`,
        );
      }
    }
  }

  const providerRolesPresent = unique(
    input.observations.map((observation) => observation.providerRole),
  );
  const sourceFamiliesPresent = unique(
    input.observations.map((observation) => observation.sourceFamily),
  );
  const fieldNames = unique(
    input.observations.flatMap((observation) =>
      observation.fields.map((field) => field.name.trim()).filter(Boolean),
    ),
  ).toSorted();
  const normalizedFields = fieldNames
    .map((fieldName) => selectPrimaryField(fieldName, input.observations))
    .filter((field): field is FinanceDataGatewayNormalizedField => Boolean(field));
  const conflicts = buildConflicts(fieldNames, input.observations);

  if (!providerRolesPresent.includes("primary_market_data")) {
    missingEvidence.push("primary_market_data_provider");
  }
  if (!providerRolesPresent.includes("cross_check_market_data")) {
    missingEvidence.push("cross_check_market_data_provider");
  }
  if (
    input.requireOfficialReference !== false &&
    !providerRolesPresent.includes("official_or_issuer_reference")
  ) {
    missingEvidence.push("official_or_issuer_reference_provider");
  }

  const requiredNextSteps: string[] = [];
  if (missingEvidence.length > 0) {
    requiredNextSteps.push("collect_missing_provider_evidence");
  }
  if (conflicts.length > 0) {
    requiredNextSteps.push("run_data_provenance_quality_review");
  }
  if (freshnessWarnings.length > 0) {
    requiredNextSteps.push("refresh_or_label_stale_fields");
  }

  const qualityStatus: FinanceDataQualityStatus =
    missingEvidence.length > 0
      ? "blocked"
      : conflicts.length > 0 || freshnessWarnings.length > 0
        ? "needs_review"
        : "ready";

  return {
    ok: qualityStatus !== "blocked",
    boundary: "finance_data_gateway_research_only",
    instrument,
    assetClass,
    useCase,
    asOf,
    legs,
    qualityStatus,
    providerRolesPresent,
    sourceFamiliesPresent,
    normalizedFields,
    conflicts,
    freshnessWarnings,
    missingEvidence: unique(missingEvidence).toSorted(),
    requiredNextSteps: unique(requiredNextSteps),
    evidenceContract: {
      requiredFieldMetadata: [
        "sourceTimestamp",
        "fieldDefinition",
        "unit_or_currency_when_applicable",
        "adjusted_status_when_applicable",
        "sourceUrlOrArtifact",
        "legId_and_venue_when_arbitrage_research",
      ],
      providerRolePolicy:
        "Use primary_market_data only with cross_check_market_data; add official_or_issuer_reference unless explicitly disabled for the use case.",
      conflictPolicy:
        "Conflicted values are not resolved by model preference; route them to data_provenance_quality_review before visible use.",
      visibleAnswerPolicy:
        "Every current numeric finance answer must show source/time/definition boundaries or mark the number as unverified.",
      asyncReceiptPolicy:
        "If data collection runs after the foreground reply, send a queued/completion/failure receipt boundary instead of claiming the number is ready.",
    },
    riskBoundaries: [
      "research_only",
      "no_trade_advice",
      "no_execution_authority",
      "cite_every_number_or_mark_unsourced",
      "do_not_use_conflicted_fields_without_review",
    ],
    notTouched: [
      "provider_config",
      "external_channel_sender",
      "protected_memory",
      "trading_execution",
    ],
  };
}
