#!/usr/bin/env node
/**
 * Which finance data sources are actually powered, and which are only *wired*.
 *
 * The defect this exists for: a source can be implemented, imported and called, and still contribute
 * nothing at runtime, because the credential it needs is nowhere to be found -- and the code is
 * silent about it on purpose. `finance-macro-signal.ts` is the measured case: `defaultMacroFor`
 * returns `undefined` when `FRED_API_KEY` is absent, the sampler's `if (params.macroFor !== undefined
 * && route !== undefined)` then skips the whole leg, and the comment there says the absence "is not
 * a failure". So an instrument keeps one fewer source and nothing anywhere says so.
 *
 * Worse, the credential can be present in a process while being described by no file at all: FMP and
 * Alpha Vantage were answering (rate-limited / budget-exhausted, not unauthorised) on 2026-09-21,
 * while `~/.openclaw/.env` has every key commented out and `openclaw.json`'s `env.vars` holds only
 * `LCX_FINANCE_STATE_DIR`. Those keys lived in the environment a long-running process inherited at
 * launch. That is the documented shape "当时好、隔天坏、重启即好": a restart takes every source dark,
 * silently.
 *
 * So this audit answers one question per source: **at this moment, from the layers this process
 * actually reads, does this source have a credential?**
 *
 * Precedence, copied from the comment at the top of `~/.openclaw/.env`:
 *   process environment > ./.env > ~/.openclaw/.env > openclaw.json's env block
 *
 * What is a failure, and what is only information:
 *
 *   - `declared_empty` is a **failure**: a layer declares the key with an empty value. That is not
 *     the same as not declaring it -- an empty value shadows nothing useful and makes the source
 *     look configured while it is not.
 *   - `absent` / `template_only` are **information** by default. Not having a provider's key is a
 *     legitimate choice, and shouting about it every run is how a check gets ignored. Use
 *     `--require FRED_API_KEY` to make a specific one fail.
 *   - a key the *code* reads but this list has never heard of is a **failure**: the list would rot
 *     silently, which is the same defect in a different place. This is why `--require` is opt-in but
 *     the drift check is not.
 *
 * Usage:
 *   tsx scripts/operator/lcx-finance-source-power-audit.ts
 *   tsx scripts/operator/lcx-finance-source-power-audit.ts --json
 *   tsx scripts/operator/lcx-finance-source-power-audit.ts --require FRED_API_KEY,FMP_API_KEY
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import { resolveFinanceStateDir } from "../../src/agents/finance-state-dir.js";

/**
 * The credentials the finance pipeline reads. Kept in step with the code by the drift check below,
 * which reads `env.<KEY>` / `keyFrom(env, "<KEY>")` out of `src/agents` and fails on anything here
 * that it does not recognise -- and on anything there that is missing from this list.
 */
const WATCHED_KEYS: readonly string[] = [
  "FMP_API_KEY",
  "FRED_API_KEY",
  "ALPHA_VANTAGE_API_KEY",
  "FINNHUB_API_KEY",
  "MASSIVE_API_KEY",
  "TWELVE_DATA_API_KEY",
  "COINGECKO_API_KEY",
  "COINCAP_API_KEY",
  "ALPACA_API_KEY_ID",
  "ALPACA_API_SECRET_KEY",
];

/**
 * Where a credential can come from, highest precedence first.
 *
 * `template` holds the keys that appear only behind a `#`: present in the file, absent from the
 * environment. That distinction is the whole point -- a file that mentions a key is not a file that
 * sets it.
 */
export type Layer = Readonly<{
  name: string;
  values: ReadonlyMap<string, string>;
  template: ReadonlySet<string>;
}>;

export type KeyStatus = Readonly<{
  key: string;
  /** Whether anything this process reads actually supplies a non-empty value. */
  powered: boolean;
  /** Which layer supplies it, when one does. */
  from: string | null;
  /** Layers that name the key but do not supply a usable value. */
  declaredEmpty: readonly string[];
  templateOnly: readonly string[];
}>;

/** A dotenv file, split into the lines that set a value and the lines that only mention one. */
export function parseDotenv(text: string): {
  values: ReadonlyMap<string, string>;
  template: ReadonlySet<string>;
} {
  const values = new Map<string, string>();
  const template = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("#")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
      if (match) {
        values.set(match[1], stripQuotes(match[2].trim()));
      }
      continue;
    }
    // A commented `KEY=value`: the file names the key but does not set it.
    const match = /^#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (match) {
      template.add(match[1]);
    }
  }
  return { values, template };
}

function stripQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/u, "$2");
}

/**
 * The `env.vars` block of a config file. The file is JSON5 in this project, so the block is matched
 * rather than parsed -- and matched *whole*: reading only a slice of it is how "this config sets one
 * variable" gets concluded from a file that sets twenty.
 */
export function parseConfigEnvVars(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const start = text.search(/"env"\s*:\s*\{/u);
  if (start < 0) {
    return values;
  }
  const varsStart = text.indexOf("vars", start);
  if (varsStart < 0) {
    return values;
  }
  // Take up to the matching brace depth of the `env` object, not a fixed character budget.
  let depth = 0;
  let end = text.length;
  for (let index = text.indexOf("{", start); index >= 0 && index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const block = text.slice(varsStart, end);
  for (const match of block.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/gu)) {
    values.set(match[1], match[2]);
  }
  return values;
}

/**
 * One key's status, from the layers in precedence order.
 *
 * A layer that declares the key with an empty value is recorded separately: it is not "absent", and
 * it is not "powered", and collapsing it into either is how a source ends up looking configured
 * while it is not.
 */
export function auditKey(key: string, layers: readonly Layer[]): KeyStatus {
  const declaredEmpty: string[] = [];
  const templateOnly: string[] = [];
  for (const layer of layers) {
    if (layer.values.has(key)) {
      // The first layer that *declares* the key wins, even when it declares it empty: a higher layer
      // shadows a lower one rather than falling through to it. An empty value therefore does not
      // reach the next layer -- it reaches the source as "configured", which is the failure this
      // audit exists to name.
      const value = layer.values.get(key) ?? "";
      if (value.trim() !== "") {
        return { key, powered: true, from: layer.name, declaredEmpty, templateOnly };
      }
      declaredEmpty.push(layer.name);
      return { key, powered: false, from: null, declaredEmpty, templateOnly };
    }
    if (layer.template.has(key)) {
      templateOnly.push(layer.name);
    }
  }
  return { key, powered: false, from: null, declaredEmpty, templateOnly };
}

/**
 * The keys the code in `src/agents` reads out of the environment.
 *
 * Only the finance-shaped ones are compared, because the same directory reads model-provider keys
 * that have nothing to do with this audit.
 */
export function keysReadByCode(source: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/keyFrom\(\s*env\s*,\s*"([A-Z0-9_]+)"\s*\)/gu)) {
    found.add(match[1]);
  }
  for (const match of source.matchAll(/env\.([A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)/gu)) {
    found.add(match[1]);
  }
  return found;
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function layersFromDisk(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { layers: Layer[]; home: string } {
  const home = env.LCX_USER_HOME?.trim() || env.HOME?.trim() || os.homedir();
  const layers: Layer[] = [
    {
      name: "process",
      values: new Map(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      template: new Set(),
    },
  ];

  const cwdDotenv = readIfPresent(path.join(cwd, ".env"));
  if (cwdDotenv !== null) {
    const parsed = parseDotenv(cwdDotenv);
    layers.push({ name: "./.env", values: parsed.values, template: parsed.template });
  }

  const homeDotenv = readIfPresent(path.join(home, ".openclaw", ".env"));
  if (homeDotenv !== null) {
    const parsed = parseDotenv(homeDotenv);
    layers.push({ name: "~/.openclaw/.env", values: parsed.values, template: parsed.template });
  }

  const config = readIfPresent(path.join(home, ".openclaw", "openclaw.json"));
  if (config !== null) {
    layers.push({
      name: "openclaw.json env.vars",
      values: parseConfigEnvVars(config),
      template: new Set(),
    });
  }
  // Resolve the same effective environment first, then let the runtime credential
  // resolver supply only missing keys. Explicit empty values still disable a key.
  const effectiveEnv: NodeJS.ProcessEnv = {};
  for (const layer of layers) {
    for (const [key, value] of layer.values) {
      if (effectiveEnv[key] === undefined) {
        effectiveEnv[key] = value;
      }
    }
  }
  const resolved = resolveFinanceCredentialEnv(effectiveEnv);
  const state = resolveFinanceStateDir({ env: effectiveEnv });
  layers.push({
    name: `finance credentials.env (${state.source})`,
    values: new Map(
      Object.entries(resolved).filter(
        (entry): entry is [string, string] =>
          effectiveEnv[entry[0]] === undefined && typeof entry[1] === "string",
      ),
    ),
    template: new Set(),
  });
  return { layers, home };
}

function drift(): { untracked: string[]; stale: string[] } {
  const agents = path.join(process.cwd(), "src", "agents");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(agents);
  } catch {
    return { untracked: [], stale: [] };
  }
  const code = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".ts") || !/finance|market|source|collection/u.test(entry)) {
      continue;
    }
    const text = readIfPresent(path.join(agents, entry));
    if (text === null) {
      continue;
    }
    for (const key of keysReadByCode(text)) {
      code.add(key);
    }
  }
  const watched = new Set(WATCHED_KEYS);
  return {
    untracked: [...code].filter((key) => !watched.has(key)).toSorted(),
    stale: WATCHED_KEYS.filter((key) => !code.has(key)),
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const requireIndex = args.indexOf("--require");
  const required =
    requireIndex >= 0
      ? (args[requireIndex + 1] ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];

  const { layers, home } = layersFromDisk();
  const statuses = WATCHED_KEYS.map((key) => auditKey(key, layers));
  const { untracked, stale } = drift();

  const failures: string[] = [];
  for (const status of statuses) {
    if (status.declaredEmpty.length > 0) {
      failures.push(
        `${status.key} is declared with an empty value by ${status.declaredEmpty.join(", ")}` +
          " -- it looks configured and is not",
      );
    }
  }
  for (const key of untracked) {
    failures.push(`${key} is read by src/agents but is not in this audit's list`);
  }
  for (const key of required) {
    const status = statuses.find((entry) => entry.key === key);
    if (status === undefined) {
      failures.push(`--require names ${key}, which this audit does not watch`);
    } else if (!status.powered) {
      failures.push(`${key} is required and no layer supplies it`);
    }
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          home,
          layers: layers.map((layer) => layer.name),
          statuses,
          drift: { untracked, stale },
          failures,
        },
        null,
        2,
      )}\n`,
    );
    return failures.length > 0 ? 1 : 0;
  }

  process.stdout.write("finance source power audit\n");
  process.stdout.write(`home: ${home}\n`);
  process.stdout.write(`layers: ${layers.map((layer) => layer.name).join(" > ")}\n\n`);
  for (const status of statuses) {
    const state = status.powered
      ? `powered   (from ${status.from})`
      : status.templateOnly.length > 0
        ? `template  (named, not set, by ${status.templateOnly.join(", ")})`
        : "absent";
    process.stdout.write(`  ${status.key.padEnd(24)} ${state}\n`);
  }
  if (stale.length > 0) {
    process.stdout.write(`\nwatched but no longer read by code: ${stale.join(", ")}\n`);
  }
  process.stdout.write(
    failures.length > 0
      ? `\nFAIL (${failures.length}):\n${failures.map((line) => `  - ${line}`).join("\n")}\n`
      : "\nOK: no source is declared-but-empty, and the list matches the code\n",
  );
  return failures.length > 0 ? 1 : 0;
}

if (process.argv[1]?.includes("lcx-finance-source-power-audit")) {
  process.exit(main());
}
