import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { financeBarLedgerExists, readFinanceBarLedger } from "../finance-bar-ledger.js";
import { readFinancePositionLedger } from "../finance-position-ledger.js";
import {
  buildFinanceRuleReadiness,
  parseFinanceReadinessThresholds,
  type FinanceReadinessBar,
  type FinanceReadinessThresholds,
} from "../finance-rule-readiness.js";
import {
  financeReadinessThresholdsPath,
  financeStrategyRuleLedgerPath,
  resolveFinanceStateDir,
  type FinanceStateDirSource,
} from "../finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "../finance-strategy-rule-ledger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

export const FINANCE_STRATEGY_RULE_LEDGER_READ_SCHEMA_VERSION =
  "lcx_finance_strategy_rule_ledger_read_v1" as const;

const NOT_TOUCHED = [
  "no order is placed",
  "no venue is contacted",
  "no credential is read",
  "no rule is declared, activated or retired",
] as const;

const FinanceStrategyRuleLedgerReadSchema = Type.Object({
  directory: Type.Optional(
    Type.String({ description: "Finance state directory holding the strategy rule ledger." }),
  ),
  ruleId: Type.Optional(Type.String({ description: "Return only the rule with this id." })),
  asOf: Type.Optional(
    Type.String({
      description: "Replay the ledger as of this ISO instant (rules observed at or before it).",
    }),
  ),
  includeBodies: Type.Optional(
    Type.Boolean({
      description:
        "Include each rule's opaque body. Off by default: bodies are per-form payloads and can be large.",
    }),
  ),
  includeReadiness: Type.Optional(
    Type.Boolean({
      description:
        "Include whether each rule has been exposed to adverse market conditions long enough. " +
        "Reads the declared readiness thresholds; without a declaration it reports measured " +
        "numbers and no verdict.",
    }),
  ),
});

/**
 * Build the readiness section of a rule read.
 *
 * A declaration that exists but does not parse is **reported, not thrown**: the rules are the
 * answer to the question that was asked, so letting a sidecar file make the book unreadable
 * would turn a missing extra into a lost main answer.
 *
 * Adversity is read from the position ledger's marks and, when a bar book exists, from the bar
 * ledger — never from any equity curve. Bars win where they can answer the question, because a
 * close series cannot see an intraday fall; a `point_derived` bar is declined rather than read as
 * if it carried a range. If neither book exists there is nothing to measure, which makes every
 * regime unjudgeable — reported as such, never as "nothing adverse happened".
 */
async function readReadinessSection(params: {
  directory: string;
  asOf: string;
  rules: Awaited<ReturnType<typeof readFinanceStrategyRuleLedger>>["ledger"]["rules"];
}): Promise<Record<string, unknown>> {
  const thresholdsFile = financeReadinessThresholdsPath(params.directory);
  let declared: FinanceReadinessThresholds | null = null;
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
        declared = parsed.thresholds;
        thresholdsDeclared = true;
      } else {
        thresholdsError = parsed.error;
      }
    }
  } catch {
    thresholdsError = null;
  }

  let marks: readonly { instrument: string; price: number; at: string }[] = [];
  let markSource: string | null = null;
  try {
    const positions = await readFinancePositionLedger(params.directory, { asOf: params.asOf });
    marks = positions.marks;
    markSource = "finance_position_ledger";
  } catch {
    markSource = null;
  }

  // Bars are the only supply that can answer a range question, so they are read here rather than
  // left to the caller: a readiness that only ever saw closes would answer "not adverse" for a
  // rule that lived through a 10% intraday fall and closed flat.
  let bars: readonly FinanceReadinessBar[] = [];
  let barSource: string | null = null;
  try {
    // An absent bar book reads as an empty one without raising, so "no bars" and "no book" are
    // indistinguishable from the result alone. Claiming the source anyway would let a reader
    // conclude the supply exists and happened to be empty, which is the opposite of the truth.
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
    barSource = null;
  }

  const readiness = buildFinanceRuleReadiness({
    rules: params.rules,
    marks,
    bars,
    asOf: params.asOf,
    ...(declared === null ? {} : { thresholds: declared }),
  });

  return {
    readiness: {
      asOf: readiness.asOf,
      ruleCount: readiness.ruleCount,
      markCount: readiness.markCount,
      markSource,
      barCount: readiness.barCount,
      barSource,
      thresholdsFile,
      thresholdsDeclared,
      thresholdsError,
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

export function createFinanceStrategyRuleLedgerReadTool(): AnyAgentTool {
  return {
    label: "Strategy rule ledger",
    name: "finance_strategy_rule_ledger_read",
    description:
      "Read the declared strategy rules: what each rule is, which form it uses, which instruments it is scoped to, what it emits, when it is scheduled, and whether the owner has activated it. " +
      "A rule in `draft` is declared but NOT authorised to run — activation is a separate owner act. " +
      "Use this before answering anything about how trading is intended to work. " +
      "Read-only: it never declares, activates, retires, or executes a rule.",
    parameters: FinanceStrategyRuleLedgerReadSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const directory = readStringParam(params, "directory");
      const ruleId = readStringParam(params, "ruleId");
      const asOf = readStringParam(params, "asOf");
      const includeBodies = params.includeBodies === true;
      const includeReadiness = params.includeReadiness === true;
      const asOfValue = asOf ?? new Date().toISOString();

      const state = resolveFinanceStateDir(directory === undefined ? {} : { directory });
      const resolvedFrom: FinanceStateDirSource = state.source;
      const databasePath = financeStrategyRuleLedgerPath(state.directory);
      const read = await readFinanceStrategyRuleLedger(
        state.directory,
        asOf === undefined ? {} : { asOf },
      );

      if (!read.databasePresent) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_STRATEGY_RULE_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_strategy_rule_ledger_read_only",
          status: "absent",
          reason: "finance_strategy_rule_ledger_absent",
          ledgerDirectory: state.directory,
          resolvedFrom,
          databasePath,
          action:
            "No strategy rule book exists at this path, so this is not evidence that no rule is intended. " +
            "The operator entry is the only writer; a book is created on the first declaration.",
          notTouched: NOT_TOUCHED,
        });
      }

      const selected =
        ruleId === undefined
          ? read.ledger.rules
          : read.ledger.rules.filter((rule) => rule.ruleId === ruleId);

      if (ruleId !== undefined && selected.length === 0) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_STRATEGY_RULE_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_strategy_rule_ledger_read_only",
          status: "absent",
          reason: "finance_strategy_rule_ledger_rule_id_unknown",
          ledgerDirectory: state.directory,
          resolvedFrom,
          databasePath,
          ruleId,
          knownRuleIds: read.ledger.rules.map((rule) => rule.ruleId),
          action:
            "No rule in this book has that id, so this is not evidence that it was never intended. " +
            "Omit ruleId to list the known ids.",
          notTouched: NOT_TOUCHED,
        });
      }

      const status = read.recordCount === 0 ? "empty" : "ready";

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_STRATEGY_RULE_LEDGER_READ_SCHEMA_VERSION,
        boundary: "finance_strategy_rule_ledger_read_only",
        status,
        ledgerDirectory: state.directory,
        resolvedFrom,
        databasePath,
        asOf: asOf ?? null,
        recordCount: read.recordCount,
        ruleCount: selected.length,
        activeRuleCount: selected.filter((rule) => rule.state === "active").length,
        draftRuleCount: selected.filter((rule) => rule.state === "draft").length,
        retiredRuleCount: selected.filter((rule) => rule.state === "retired").length,
        rules: selected.map((rule) => ({
          ruleId: rule.ruleId,
          state: rule.state,
          form: rule.form,
          formVersion: rule.formVersion,
          displayName: rule.displayName,
          instruments: [...rule.instruments],
          emits: rule.emits,
          schedule: { ...rule.schedule },
          bodyKeyCount: Object.keys(rule.body).length,
          ...(includeBodies ? { body: { ...rule.body } } : {}),
          provenance: rule.provenance === null ? null : { ...rule.provenance },
          declaredAt: rule.declaredAt,
          activatedAt: rule.activatedAt,
          retiredAt: rule.retiredAt,
        })),
        ...(includeReadiness
          ? await readReadinessSection({
              directory: state.directory,
              asOf: asOfValue,
              rules: selected,
            })
          : {}),
        authorityNote:
          "Every record in this book carries executionAuthority 'none'. Declaring a rule records " +
          "intent; activating it is a separate owner act; executing it requires a declared " +
          "execution adapter, of which only paper ships.",
        notTouched: NOT_TOUCHED,
      });
    },
  } as unknown as AnyAgentTool;
}
