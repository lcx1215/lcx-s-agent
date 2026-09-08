import { z } from "zod";

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
      const reason =
        !Number.isFinite(due) ||
        !Number.isFinite(Date.parse(params.frozenAt)) ||
        !Number.isFinite(Date.parse(params.observedAt)) ||
        Date.parse(params.frozenAt) >= due
          ? "forecast_not_frozen_before_due"
          : Date.parse(params.observedAt) < due
            ? "checkpoint_not_due"
            : rows.length !== 1
              ? "unique_matching_observation_required"
              : typeof rows[0].value !== "number" || !Number.isFinite(rows[0].value)
                ? "numeric_observation_required"
                : Date.parse(rows[0].sourceTimestamp) !== due
                  ? "exact_checkpoint_timestamp_required"
                  : null;
      if (reason) {
        return { forecastId: forecast.id, status: "unscored" as const, reason };
      }
      const outcome = Number((rows[0].value as number) > forecast.threshold);
      return {
        forecastId: forecast.id,
        status: "scored" as const,
        evidenceId: rows[0].id,
        outcome,
        brierScore: (forecast.probabilityAbove - outcome) ** 2,
        baselineBrierScore: 0.25,
        provenance: "supplied_observation_not_independently_verified" as const,
      };
    });
}
