import { z } from "zod";

const MAX_CHECKPOINT_OBSERVATION_LAG_MS = 7 * 24 * 60 * 60 * 1_000;

/** Freeze the event definition before its observation window begins. */
export const FinanceForecast = z
  .object({
    id: z.string().trim().min(1),
    field: z.string().trim().min(1),
    unit: z.string().trim().min(1),
    source: z.string().trim().min(1),
    checkpointMonths: z.union([z.literal(3), z.literal(6)]),
    threshold: z.number().finite(),
    probabilityAbove: z.number().min(0).max(1),
  })
  .strict();
export type FinanceForecastContract = z.infer<typeof FinanceForecast>;

function checkpointObservation(
  rows: Array<{ id: string; sourceTimestamp: string; value: string | number }>,
  due: number,
  observedAt: number,
) {
  const dueDate = new Date(due);
  const checkpointStart = Date.UTC(
    dueDate.getUTCFullYear(),
    dueDate.getUTCMonth(),
    dueDate.getUTCDate(),
  );
  const checkpointEnd = checkpointStart + MAX_CHECKPOINT_OBSERVATION_LAG_MS;
  const candidates = rows
    .map((row) => ({ row, timestamp: Date.parse(row.sourceTimestamp) }))
    .filter(
      (entry) =>
        Number.isFinite(entry.timestamp) &&
        entry.timestamp >= checkpointStart &&
        entry.timestamp <= checkpointEnd &&
        entry.timestamp <= observedAt,
    )
    .toSorted((a, b) => a.timestamp - b.timestamp);
  const first = candidates[0];
  if (!first) {
    return undefined;
  }
  const sameTimestamp = candidates.filter((entry) => entry.timestamp === first.timestamp);
  return sameTimestamp.length === 1 ? first.row : undefined;
}

export function calibrateFinanceForecasts(params: {
  forecasts: FinanceForecastContract[];
  checkpointMonths: number;
  dueAt: string;
  frozenAt: string;
  observedAt: string;
  evidence: Array<{
    id: string;
    field: string;
    unit?: string;
    source: string;
    sourceTimestamp: string;
    value: string | number;
  }>;
}) {
  return params.forecasts
    .filter((f) => f.checkpointMonths === params.checkpointMonths)
    .map((forecast) => {
      const due = Date.parse(params.dueAt);
      const rows = params.evidence.filter(
        (e) =>
          e.field === forecast.field && e.unit === forecast.unit && e.source === forecast.source,
      );
      const observedAt = Date.parse(params.observedAt);
      const checkpointRow =
        Number.isFinite(due) && Number.isFinite(observedAt)
          ? checkpointObservation(rows, due, observedAt)
          : undefined;
      const reason =
        !Number.isFinite(due) ||
        !Number.isFinite(Date.parse(params.frozenAt)) ||
        !Number.isFinite(Date.parse(params.observedAt)) ||
        Date.parse(params.frozenAt) >= due
          ? "forecast_not_frozen_before_due"
          : Date.parse(params.observedAt) < due
            ? "checkpoint_not_due"
            : checkpointRow === undefined
              ? "unique_observation_on_or_immediately_after_checkpoint_required"
              : typeof checkpointRow.value !== "number" || !Number.isFinite(checkpointRow.value)
                ? "numeric_observation_required"
                : null;
      if (reason) {
        return { forecastId: forecast.id, status: "unscored" as const, reason };
      }
      const outcome = Number((checkpointRow!.value as number) > forecast.threshold);
      return {
        forecastId: forecast.id,
        status: "scored" as const,
        evidenceId: checkpointRow!.id,
        outcome,
        brierScore: (forecast.probabilityAbove - outcome) ** 2,
        baselineBrierScore: 0.25,
        provenance: "supplied_observation_not_independently_verified" as const,
      };
    });
}
