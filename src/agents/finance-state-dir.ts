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
