import { z } from "zod";
const Text = z.string().trim().min(1).max(4000);
const References = z.array(Text).min(1).max(30);
export const FinanceResearchAssessment = z
  .object({
    causalHypotheses: z
      .array(
        z
          .object({
            id: Text,
            cause: Text,
            effect: Text,
            mechanism: Text,
            evidenceIds: References,
            alternativeExplanations: z.array(Text).min(1),
            disconfirmingTest: Text,
            status: z.literal("hypothesis"),
          })
          .strict(),
      )
      .min(2)
      .max(10),
    scenarios: z
      .array(
        z
          .object({
            id: Text,
            probability: z.number().min(0).max(1),
            condition: Text,
            expectedEffect: Text,
            invalidation: Text,
            evidenceIds: References,
          })
          .strict(),
      )
      .min(3)
      .max(10),
  })
  .strict();

export function requiresFinanceResearchAssessment(ask: string): boolean {
  return /归因|原因|为什么|情景|选举|caus|why|scenario|election/iu.test(ask);
}

/** Independent contract checks are deliberately not a claim of causal identification. */
export function verifyFinanceResearchAssessment(value: unknown, evidenceIds: ReadonlySet<string>) {
  const parsed = FinanceResearchAssessment.safeParse(value);
  if (!parsed.success) {
    return { passed: false, reason: "causal_scenario_assessment_missing_or_invalid" };
  }
  const { causalHypotheses, scenarios } = parsed.data;
  for (const entries of [causalHypotheses, scenarios]) {
    if (new Set(entries.map((e) => e.id)).size !== entries.length) {
      return { passed: false, reason: "duplicate_assessment_id" };
    }
    if (entries.some((e) => e.evidenceIds.some((id) => !evidenceIds.has(id)))) {
      return { passed: false, reason: "unresolved_assessment_evidence" };
    }
  }
  if (Math.abs(scenarios.reduce((sum, scenario) => sum + scenario.probability, 0) - 1) > 1e-6) {
    return { passed: false, reason: "scenario_probabilities_must_sum_to_one" };
  }
  if (new Set(scenarios.map((s) => s.condition.trim().toLowerCase())).size !== scenarios.length) {
    return { passed: false, reason: "scenario_conditions_must_differ" };
  }
  return { passed: true, reason: "causal_scenario_contract_verified_semantics_require_review" };
}
