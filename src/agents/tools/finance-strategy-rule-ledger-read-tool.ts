import { Type } from "@sinclair/typebox";
import {
  financeRuleReadinessSection,
  readFinanceRuleReadinessState,
} from "../finance-rule-readiness-state.js";
import {
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
          ? financeRuleReadinessSection(
              await readFinanceRuleReadinessState({
                directory: state.directory,
                asOf: asOfValue,
                rules: selected,
              }),
            )
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
