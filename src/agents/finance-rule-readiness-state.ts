import fs from "node:fs/promises";
import { financeBarLedgerExists, readFinanceBarLedger } from "./finance-bar-ledger.js";
import { readFinancePositionLedger } from "./finance-position-ledger.js";
import {
  buildFinanceRuleReadiness,
  parseFinanceReadinessThresholds,
  type FinanceRuleReadiness,
  type FinanceReadinessBar,
  type FinanceReadinessThresholds,
} from "./finance-rule-readiness.js";
import { financeReadinessThresholdsPath } from "./finance-state-dir.js";
import type { FinanceStrategyRule } from "./finance-strategy-rule-ledger.js";

export type FinanceRuleReadinessState = Readonly<{
  readiness: FinanceRuleReadiness;
  thresholdsFile: string;
  thresholdsDeclared: boolean;
  thresholdsError: string | null;
  markSource: "finance_position_ledger" | null;
  barSource: "finance_bar_ledger" | null;
}>;

/**
 * Read the canonical local evidence used to decide whether strategy rules are paper-ready.
 *
 * This is the sole I/O adapter for readiness. The projection remains pure in
 * `finance-rule-readiness.ts`; operator, tool and scheduler callers share this adapter so a bar
 * book cannot be considered by one entry point and silently ignored by another.
 */
export async function readFinanceRuleReadinessState(params: {
  directory: string;
  asOf: string;
  rules: readonly FinanceStrategyRule[];
}): Promise<FinanceRuleReadinessState> {
  const thresholdsFile = financeReadinessThresholdsPath(params.directory);
  let thresholds: FinanceReadinessThresholds | null = null;
  let thresholdsError: string | null = null;
  let thresholdsDeclared = false;
  try {
    const raw = await fs.readFile(thresholdsFile, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      thresholdsError = `${thresholdsFile} is not valid JSON`;
    }
    if (thresholdsError === null) {
      const parsed = parseFinanceReadinessThresholds(value, thresholdsFile);
      if (parsed.ok) {
        thresholds = parsed.thresholds;
        thresholdsDeclared = true;
      } else {
        thresholdsError = parsed.error;
      }
    }
  } catch {
    // An absent declaration is not an I/O failure. It leaves readiness unjudgeable.
  }

  let marks: Awaited<ReturnType<typeof readFinancePositionLedger>>["marks"] = [];
  let markSource: FinanceRuleReadinessState["markSource"] = null;
  try {
    const positions = await readFinancePositionLedger(params.directory, { asOf: params.asOf });
    marks = positions.marks;
    markSource = "finance_position_ledger";
  } catch {
    // Missing or unreadable evidence is represented as unavailable, never as a passing zero.
  }

  let bars: readonly FinanceReadinessBar[] = [];
  let barSource: FinanceRuleReadinessState["barSource"] = null;
  try {
    if (await financeBarLedgerExists(params.directory)) {
      const ledger = await readFinanceBarLedger(params.directory, { asOf: params.asOf });
      bars = ledger.bars.map((bar) => ({
        instrument: bar.instrument,
        at: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        sampleCount: bar.sampleCount,
      }));
      barSource = "finance_bar_ledger";
    }
  } catch {
    // See marks above: evidence failure must not be reinterpreted as calm market evidence.
  }

  return Object.freeze({
    readiness: buildFinanceRuleReadiness({
      rules: params.rules,
      marks,
      bars,
      asOf: params.asOf,
      ...(thresholds === null ? {} : { thresholds }),
    }),
    thresholdsFile,
    thresholdsDeclared,
    thresholdsError,
    markSource,
    barSource,
  });
}

/** Stable JSON projection shared by operator and Agent tool surfaces. */
export function financeRuleReadinessSection(
  state: FinanceRuleReadinessState,
): Record<string, unknown> {
  const { readiness } = state;
  return {
    readiness: {
      asOf: readiness.asOf,
      ruleCount: readiness.ruleCount,
      markCount: readiness.markCount,
      markSource: state.markSource,
      barCount: readiness.barCount,
      barSource: state.barSource,
      thresholdsFile: state.thresholdsFile,
      thresholdsDeclared: state.thresholdsDeclared,
      thresholdsError: state.thresholdsError,
      declaredThresholds: readiness.declaredThresholds,
      requiredAdversity: [...readiness.requiredAdversity],
      rules: readiness.rules.map((entry) => ({
        ruleId: entry.ruleId,
        state: entry.state,
        since: entry.since,
        elapsedDays: entry.elapsedDays,
        observationCount: entry.observationCount,
        ...(entry.barWindowNote === null ? {} : { barWindowNote: entry.barWindowNote }),
        covered: [...entry.covered],
        uncovered: [...entry.uncovered],
        durationMet: entry.durationMet,
        ready: entry.ready,
        readyUnavailableReason: entry.readyUnavailableReason,
        adversity: entry.adversity.map((item) => ({
          kind: item.kind,
          observed: item.observed,
          basis: item.basis,
          detail: { ...item.detail },
          unavailableReason: item.unavailableReason,
        })),
      })),
      interpretationBoundary: readiness.interpretationBoundary,
      advice: readiness.advice,
    },
  };
}
