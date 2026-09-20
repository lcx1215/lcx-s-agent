/**
 * Where the finance state plane lives.
 *
 * The position ledger, the equity curve and the outcome ledger all sit under one directory,
 * and two very different kinds of caller have to agree on which one: the operator scripts
 * that *write* it, and the agent tools that *read* it. A disagreement is the worst failure
 * mode available here, because reading the wrong directory does not raise anything — it
 * reports an empty book, which is indistinguishable from a flat account.
 *
 * So the location is resolved in exactly one place, and every caller reports the `source`
 * it resolved from instead of assuming one.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export const FINANCE_STATE_DIR_ENV = "LCX_FINANCE_STATE_DIR";

export type FinanceStateDirSource = "explicit" | "env" | "workspace_default";

export type FinanceStateDir = Readonly<{
  /** Absolute directory holding the finance state plane. */
  directory: string;
  /**
   * How `directory` was chosen. Callers must surface this: an explicit or env path is a
   * statement by the operator, while the workspace default is this repository's own
   * convention and may well be the wrong book.
   */
  source: FinanceStateDirSource;
}>;

function absolutize(candidate: string): string {
  const expanded = candidate.startsWith("~") ? resolveUserPath(candidate) : candidate;
  return path.resolve(expanded);
}

export function resolveFinanceStateDir(
  params: { workspaceDir?: string; directory?: string; env?: NodeJS.ProcessEnv } = {},
): FinanceStateDir {
  const explicit = params.directory?.trim();
  if (explicit) {
    return Object.freeze({ directory: absolutize(explicit), source: "explicit" });
  }
  const fromEnv = (params.env ?? process.env)[FINANCE_STATE_DIR_ENV]?.trim();
  if (fromEnv) {
    return Object.freeze({ directory: absolutize(fromEnv), source: "env" });
  }
  return Object.freeze({
    directory: path.join(resolveWorkspaceRoot(params.workspaceDir), "state", "finance"),
    source: "workspace_default",
  });
}

export type FinancePositionLedgerLocation = Readonly<{
  directory: string;
  source: FinanceStateDirSource;
  /** Absolute path of the ledger database. Its absence means an empty ledger, not an error. */
  database: string;
}>;

/**
 * Schema generation of a ledger file, following the codex convention (`state_5`, `memories_1`,
 * `logs_2`, `queue_1`): an *incompatible* schema change bumps the generation and starts a fresh
 * database, while compatible changes go through the migration ledger inside the file. The two
 * mechanisms answer different questions, so both are kept: the migration ledger records what
 * shape this file is in, the generation records which file is current.
 */
export const FINANCE_POSITION_LEDGER_GENERATION = 1;
export const FINANCE_OUTCOME_LEDGER_GENERATION = 1;

export const FINANCE_POSITION_LEDGER_FILENAME =
  `position-ledger_${FINANCE_POSITION_LEDGER_GENERATION}.sqlite` as const;
export const FINANCE_OUTCOME_LEDGER_FILENAME =
  `outcome-ledger_${FINANCE_OUTCOME_LEDGER_GENERATION}.sqlite` as const;

function generationLedgerPath(params: {
  directory: string;
  filename: string;
  generation: number;
  legacyFilenames: readonly string[];
}): string {
  const versioned = path.join(params.directory, params.filename);
  // A generation bump is a deliberate fresh start. Re-adopting the previous book would make
  // the bump a no-op, so the legacy name is only honoured for generation 1 — the generation
  // that shipped before the suffix existed and whose books must not be stranded.
  if (params.generation > 1 || existsSync(versioned)) {
    return versioned;
  }
  for (const name of params.legacyFilenames) {
    const legacy = path.join(params.directory, name);
    if (existsSync(legacy)) {
      return legacy;
    }
  }
  return versioned;
}

/** Absolute path of the position ledger database inside `directory`. */
export function financePositionLedgerPath(directory: string): string {
  return generationLedgerPath({
    directory,
    filename: FINANCE_POSITION_LEDGER_FILENAME,
    generation: FINANCE_POSITION_LEDGER_GENERATION,
    legacyFilenames: ["position-ledger.sqlite"],
  });
}

/** Absolute path of the outcome ledger database inside `directory`. */
export function financeOutcomeLedgerPath(directory: string): string {
  return generationLedgerPath({
    directory,
    filename: FINANCE_OUTCOME_LEDGER_FILENAME,
    generation: FINANCE_OUTCOME_LEDGER_GENERATION,
    legacyFilenames: ["outcome-ledger.sqlite"],
  });
}

export const FINANCE_THESIS_LEDGER_GENERATION = 1;
export const FINANCE_THESIS_LEDGER_FILENAME =
  `thesis-ledger_${FINANCE_THESIS_LEDGER_GENERATION}.sqlite` as const;

/** Absolute path of the thesis ledger database inside `directory`. */
export function financeThesisLedgerPath(directory: string): string {
  return generationLedgerPath({
    directory,
    filename: FINANCE_THESIS_LEDGER_FILENAME,
    generation: FINANCE_THESIS_LEDGER_GENERATION,
    legacyFilenames: ["thesis-ledger.sqlite"],
  });
}

export const FINANCE_STRATEGY_RULE_LEDGER_GENERATION = 1;
export const FINANCE_STRATEGY_RULE_LEDGER_FILENAME =
  `strategy-rule-ledger_${FINANCE_STRATEGY_RULE_LEDGER_GENERATION}.sqlite` as const;

/** Absolute path of the strategy rule ledger database inside `directory`. */
export function financeStrategyRuleLedgerPath(directory: string): string {
  return generationLedgerPath({
    directory,
    filename: FINANCE_STRATEGY_RULE_LEDGER_FILENAME,
    generation: FINANCE_STRATEGY_RULE_LEDGER_GENERATION,
    legacyFilenames: ["strategy-rule-ledger.sqlite"],
  });
}

export const FINANCE_BAR_LEDGER_GENERATION = 1;
export const FINANCE_BAR_LEDGER_FILENAME =
  `bar-ledger_${FINANCE_BAR_LEDGER_GENERATION}.sqlite` as const;

/** Resolve the bar book path for a finance state directory. */
export function financeBarLedgerPath(directory: string): string {
  return path.join(directory, FINANCE_BAR_LEDGER_FILENAME);
}

export const FINANCE_BEHAVIOUR_THRESHOLDS_FILENAME = "behaviour-thresholds.json" as const;

export const FINANCE_READINESS_THRESHOLDS_FILENAME = "readiness-thresholds.json" as const;

/**
 * Absolute path of the declared behaviour thresholds inside `directory`.
 *
 * Deliberately **not** generation-suffixed, unlike the ledgers. A ledger accumulates records, so
 * an incompatible shape needs a fresh file; this holds a *declaration*, and a changed declaration
 * replaces the previous one in place. Re-adopting an older generation would resurrect a boundary
 * the owner already moved past, which is the opposite of what a declared threshold means.
 *
 * It sits beside the ledger because it constrains a projection of that ledger, and it is resolved
 * here so the operator entry and the agent read tool cannot disagree about which declaration is
 * in force. Its absence is not an error: a book with no declaration reports the measured numbers
 * and no labels.
 */
export function financeBehaviourThresholdsPath(directory: string): string {
  return path.join(directory, FINANCE_BEHAVIOUR_THRESHOLDS_FILENAME);
}

/**
 * Absolute path of the declared readiness thresholds inside `directory`.
 *
 * Same reasoning as the behaviour thresholds, and same reason for living here: the rule ledger
 * and the position ledger are read together to judge readiness, so the declaration that gates
 * that judgement belongs beside them and is resolved once.
 */
export function financeReadinessThresholdsPath(directory: string): string {
  return path.join(directory, FINANCE_READINESS_THRESHOLDS_FILENAME);
}

/**
 * Non-ledger members of the finance plane: collection receipts, quota bookkeeping and the
 * finance credential store.
 *
 * These used to live under the *general* state directory (`<stateDir>/finance-caseflow/...`)
 * while the ledgers lived here, which split one plane across two roots: the ledgers followed
 * this resolver and the rest followed a different default. A split here is silent, because a
 * missing quota file and a missing receipt both read as "nothing happened yet". They are
 * therefore resolved from the same root as the ledgers, and the historical
 * `finance-caseflow/` level is dropped rather than re-created one directory deeper.
 */

/** Directory holding collection receipts that back source-health evidence. */
export function financeReceiptsDir(directory: string): string {
  return path.join(directory, "receipts");
}

/** Directory holding cross-process quota state files. */
export function financeQuotaStateDir(directory: string): string {
  return path.join(directory, "quota-state");
}

/** Directory holding raw quota measurements, imported into the budget on next read. */
export function financeQuotaProbesDir(directory: string): string {
  return path.join(directory, "quota-probes");
}

/** Path of the dedicated finance credential store. */
export function financeCredentialsPath(directory: string): string {
  return path.join(directory, "credentials.env");
}

export function resolveFinancePositionLedgerLocation(
  params: { workspaceDir?: string; directory?: string; env?: NodeJS.ProcessEnv } = {},
): FinancePositionLedgerLocation {
  const state = resolveFinanceStateDir(params);
  return Object.freeze({
    directory: state.directory,
    source: state.source,
    database: financePositionLedgerPath(state.directory),
  });
}

export type FinanceBarLedgerLocation = Readonly<{
  directory: string;
  source: FinanceStateDirSource;
  /** Absolute path of the bar database. Its absence means no bars were ever recorded. */
  database: string;
}>;

export function resolveFinanceBarLedgerLocation(
  params: { workspaceDir?: string; directory?: string; env?: NodeJS.ProcessEnv } = {},
): FinanceBarLedgerLocation {
  const state = resolveFinanceStateDir(params);
  return Object.freeze({
    directory: state.directory,
    source: state.source,
    database: financeBarLedgerPath(state.directory),
  });
}
