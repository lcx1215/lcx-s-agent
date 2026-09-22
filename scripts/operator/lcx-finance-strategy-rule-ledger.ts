/**
 * Operator entry for the strategy rule ledger.
 *
 * The only writer of the book, and deliberately the only place a rule can be *activated*.
 * Declaring a rule here records intent; activating it is a separate, explicit command so that
 * "a rule was written down" can never be confused with "a rule was armed".
 *
 * Nothing here places an order. The ledger confers `executionAuthority: "none"`, and execution
 * still requires a declared execution adapter — of which only `paper` ships.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-strategy-rule-ledger.ts --json \
 *     [--dir PATH] [--declare FILE] [--activate FILE] [--retire FILE] \
 *     [--rule-id ID] [--as-of ISO] [--readiness]
 */

import fs from "node:fs/promises";
import {
  financeRuleReadinessSection,
  readFinanceRuleReadinessState,
} from "../../src/agents/finance-rule-readiness-state.js";
import { resolveFinancePositionLedgerLocation } from "../../src/agents/finance-state-dir.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
  retireFinanceStrategyRule,
  type FinanceStrategyRule,
} from "../../src/agents/finance-strategy-rule-ledger.js";

const USAGE =
  "Usage: node --import tsx scripts/operator/lcx-finance-strategy-rule-ledger.ts [--json] " +
  "[--dir PATH] [--declare FILE] [--activate FILE] [--retire FILE] [--rule-id ID] [--as-of ISO] " +
  "[--readiness]";

type Options = Readonly<{
  json: boolean;
  readiness: boolean;
  directory?: string;
  declare?: string;
  activate?: string;
  retire?: string;
  ruleId?: string;
  asOf?: string;
}>;

function parseArgs(argv: readonly string[]): Options {
  const options: {
    json: boolean;
    readiness: boolean;
    directory?: string;
    declare?: string;
    activate?: string;
    retire?: string;
    ruleId?: string;
    asOf?: string;
  } = { json: false, readiness: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dir") {
      options.directory = next;
      index += 1;
    } else if (arg === "--declare") {
      options.declare = next;
      index += 1;
    } else if (arg === "--activate") {
      options.activate = next;
      index += 1;
    } else if (arg === "--retire") {
      options.retire = next;
      index += 1;
    } else if (arg === "--rule-id") {
      options.ruleId = next;
      index += 1;
    } else if (arg === "--as-of") {
      options.asOf = next;
      index += 1;
    } else if (arg === "--readiness") {
      options.readiness = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    } else {
      throw new Error(`unknown argument: ${arg ?? ""}\n${USAGE}`);
    }
  }
  const writers = [options.declare, options.activate, options.retire].filter(
    (item): item is string => item !== undefined,
  );
  if (writers.length > 1) {
    throw new Error(`only one of --declare, --activate, --retire may be given\n${USAGE}`);
  }
  return options;
}

async function readJsonFile(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, "utf8");
  if (raw.length > 1_048_576) {
    throw new Error(`rule input exceeds 1 MiB: ${file}`);
  }
  return JSON.parse(raw);
}

/** `String(x)` on an unknown yields `[object Object]` for objects; this does not. */
function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Read the declared readiness thresholds from the shared declaration file.
 *
 * An absent file means "nothing declared", which is not an error: every threshold is opt-in and
 * an undeclared one makes its condition unjudgeable rather than passing. An unreadable file is
 * reported instead of thrown, so a broken sidecar cannot make the book unreadable.
 */
async function buildReadinessSection(params: {
  directory: string;
  asOf: string;
  rules: readonly FinanceStrategyRule[];
}): Promise<Record<string, unknown>> {
  return financeRuleReadinessSection(await readFinanceRuleReadinessState(params));
}

function renderText(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("Strategy rule ledger");
  const directory = payload["ledgerDirectory"];
  if (typeof directory === "string") {
    lines.push(`  目录: ${directory}`);
  }
  const status = payload["status"];
  if (status !== undefined) {
    lines.push(`  状态: ${text(status)}`);
  }
  const rules = payload["rules"];
  if (Array.isArray(rules)) {
    lines.push(`  规则数: ${rules.length}`);
    for (const rule of rules) {
      if (typeof rule !== "object" || rule === null) {
        continue;
      }
      const row = rule as Record<string, unknown>;
      const instruments = Array.isArray(row["instruments"]) ? row["instruments"].join(",") : "";
      lines.push(
        `    - ${String(row["ruleId"])}  ${String(row["state"])}  form=${String(row["form"])}` +
          `  emits=${String(row["emits"])}  instruments=${instruments}`,
      );
    }
  }
  const readiness = payload["readiness"];
  if (typeof readiness === "object" && readiness !== null) {
    const section = readiness as Record<string, unknown>;
    lines.push(`  就绪度: 阈值已声明=${String(section["thresholdsDeclared"])}`);
    const required = Array.isArray(section["requiredAdversity"])
      ? (section["requiredAdversity"] as unknown[]).join(",")
      : "";
    lines.push(`    需要的行情: ${required}`);
    const entries = section["rules"];
    if (Array.isArray(entries)) {
      for (const item of entries) {
        if (typeof item !== "object" || item === null) {
          continue;
        }
        const row = item as Record<string, unknown>;
        const verdict =
          row["ready"] === true
            ? "ready"
            : row["ready"] === null
              ? `unjudgeable (${String(row["readyUnavailableReason"])})`
              : `not ready (missing ${String(row["uncovered"])})`;
        lines.push(
          `    - ${String(row["ruleId"])}  ${verdict}  观测=${String(row["observationCount"])}` +
            `  已覆盖=${String(row["covered"])}`,
        );
      }
    }
    if (section["thresholdsError"] !== null) {
      lines.push(`    阈值声明错误: ${text(section["thresholdsError"])}`);
    }
  }
  const error = payload["error"];
  if (error !== undefined) {
    lines.push(`  错误: ${text(error)}`);
  }
  lines.push("边界：只读写本地 SQLite 账本；不读凭据、不联网、不下单。");
  return lines.join("\n");
}

export async function runStrategyRuleLedger(
  argv: readonly string[] = process.argv.slice(2),
): Promise<Record<string, unknown>> {
  const options = parseArgs(argv);
  const location = resolveFinancePositionLedgerLocation({
    directory: options.directory,
  });
  const base = {
    ledgerDirectory: location.directory,
    resolvedFrom: location.source,
  };

  try {
    if (options.declare !== undefined) {
      const append = await declareFinanceStrategyRule(
        location.directory,
        await readJsonFile(options.declare),
      );
      const payload = {
        ...base,
        ok: true,
        appended: append.appended,
        recordCount: append.recordCount,
        headRef: append.headRef,
        rule: summarize(append.record.body),
      };
      if (!options.json) {
        process.stdout.write(`${renderText({ ...payload, status: "declared" })}\n`);
      }
      return payload;
    }
    if (options.activate !== undefined) {
      const append = await activateFinanceStrategyRule(
        location.directory,
        await readJsonFile(options.activate),
      );
      const payload = {
        ...base,
        ok: true,
        appended: append.appended,
        recordCount: append.recordCount,
        headRef: append.headRef,
        rule: summarize(append.record.body),
      };
      if (!options.json) {
        process.stdout.write(`${renderText({ ...payload, status: "activated" })}\n`);
      }
      return payload;
    }
    if (options.retire !== undefined) {
      const append = await retireFinanceStrategyRule(
        location.directory,
        await readJsonFile(options.retire),
      );
      const payload = {
        ...base,
        ok: true,
        appended: append.appended,
        recordCount: append.recordCount,
        headRef: append.headRef,
        rule: summarize(append.record.body),
      };
      if (!options.json) {
        process.stdout.write(`${renderText({ ...payload, status: "retired" })}\n`);
      }
      return payload;
    }

    const read = await readFinanceStrategyRuleLedger(
      location.directory,
      options.asOf === undefined || options.asOf.length === 0 ? {} : { asOf: options.asOf },
    );
    const selected =
      options.ruleId === undefined || options.ruleId.length === 0
        ? read.ledger.rules
        : read.ledger.rules.filter((rule) => rule.ruleId === options.ruleId);
    const payload = {
      ...base,
      ok: true,
      status: read.databasePresent ? "ready" : "absent",
      databasePresent: read.databasePresent,
      asOf: options.asOf ?? null,
      recordCount: read.recordCount,
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
        provenance: rule.provenance === null ? null : { ...rule.provenance },
        declaredAt: rule.declaredAt,
        activatedAt: rule.activatedAt,
        retiredAt: rule.retiredAt,
        startObservedAt: rule.startObservedAt,
        activeObservedAt: rule.activeObservedAt,
      })),
      ...(options.readiness
        ? await buildReadinessSection({
            directory: location.directory,
            asOf: options.asOf ?? new Date().toISOString(),
            rules: selected,
          })
        : {}),
    };
    if (!options.json) {
      process.stdout.write(`${renderText(payload)}\n`);
    }
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = { ...base, ok: false, error: message };
    if (!options.json) {
      process.stdout.write(`${renderText(payload)}\n`);
    }
    return payload;
  }
}

function summarize(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const row = body as Record<string, unknown>;
  return {
    kind: row["kind"],
    ruleId: row["ruleId"],
    form: row["form"] ?? null,
    observedAt: row["observedAt"] ?? null,
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes("--json");
  const payload = await runStrategyRuleLedger(argv);
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  if (payload["ok"] === false) {
    process.exitCode = 1;
  }
}
