import { z } from "zod";

const Run = z.object({
  runId: z.string().min(1).max(120),
  mode: z.literal("day"),
  firedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  outputTruncated: z.literal(false),
  stdout: z.string(),
  execution: z.object({ placementEnabled: z.literal(true), venue: z.literal("alpaca") }),
});
const Report = z.object({
  mode: z.literal("day"),
  asOf: z.string().datetime(),
  positionBook: z.object({ source: z.literal("controller_account"), accountId: z.string() }),
  ruleIds: z.array(z.string()),
  tradeDecisionReview: z.object({
    status: z.enum(["completed", "failed"]),
    candidateInputs: z.array(
      z.object({
        candidateId: z.string().max(240),
        instrument: z.string(),
        side: z.enum(["buy", "sell"]),
        targetWeight: z.number().finite(),
        currentWeight: z.number().finite(),
        notional: z.number().finite().positive(),
      }),
    ),
    decisions: z
      .array(
        z.object({
          candidateId: z.string(),
          decision: z.enum(["approve", "veto"]),
          rationale: z.string(),
        }),
      )
      .optional(),
  }),
  placed: z.array(
    z.object({
      instrument: z.string(),
      quantity: z.number().finite().positive(),
      notional: z.number().finite().positive(),
    }),
  ),
  refusals: z.array(z.string()),
});
export function parseFinanceDailyDecisionRun(value: unknown) {
  const parsed = Run.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const run = parsed.data;
  if (Date.parse(run.completedAt) < Date.parse(run.firedAt)) {
    return null;
  }
  try {
    const report = Report.safeParse(JSON.parse(run.stdout));
    if (!report.success || report.data.asOf !== run.firedAt) {
      return null;
    }
    return { run, report: report.data };
  } catch {
    return null;
  }
}
