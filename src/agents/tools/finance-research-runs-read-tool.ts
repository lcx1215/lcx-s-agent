import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

/**
 * Read-only recall over stored finance research runs.
 *
 * Runs are written by two callers — the operator script and the in-agent research tool — into
 * the same git-ignored directory under the workspace. Until this tool existed that directory
 * had writers and no reader, so an agent could run research but never read back what an
 * earlier run concluded. This is the read side; it never runs a model and never touches the
 * network.
 *
 * A missing directory is an empty history, not an error: the payload reports `available:false`
 * so a caller can tell "no runs yet" apart from "the read itself failed".
 */

export const FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION =
  "lcx_finance_research_runs_read_v1" as const;

const RUNS_REL_DIR = "state/finance-research-runs";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_HIT_LIMIT = 10;
const MAX_HIT_LIMIT = 50;
const MAX_SNIPPET_CHARS = 400;
const MAX_FILE_CHARS = 8_000;
const MAX_SCAN_DEPTH = 3;

const ACTIONS = ["list", "read", "search"] as const;

const FinanceResearchRunsReadSchema = Type.Object({
  workspaceDir: Type.Optional(
    Type.String({
      description:
        "Workspace root whose stored research runs are read. Defaults to the process working directory.",
    }),
  ),
  action: Type.Optional(
    Type.Union(
      ACTIONS.map((action) => Type.Literal(action)),
      {
        description:
          "list: index the stored runs. read: open one run. search: find runs whose stored text mentions a term. Defaults to list.",
      },
    ),
  ),
  run: Type.Optional(
    Type.String({
      description:
        "Run id as reported by `list` (a path relative to the runs directory, e.g. `legacy-20260910-0911/20260911-full-workflow-closure`). Required for `read`.",
    }),
  ),
  file: Type.Optional(
    Type.String({
      description:
        "Optional file name inside the run for `read` (e.g. `runtime.json` or `response-01.json`). Omit for the run index.",
    }),
  ),
  query: Type.Optional(
    Type.String({ description: "Case-insensitive term to look for. Required for `search`." }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum entries to report (default ${DEFAULT_LIST_LIMIT} for list, ${DEFAULT_HIT_LIMIT} for search).`,
    }),
  ),
});

type RunEntry = {
  id: string;
  files: number;
  bytes: number;
  modifiedAt?: string;
  revision?: string;
  models?: string[];
};

/** Resolve the runs directory for a workspace, or `null` when it does not exist. */
async function resolveRunsDir(workspaceDir?: string): Promise<string | null> {
  const root = resolveWorkspaceRoot(workspaceDir);
  const dir = path.join(root, RUNS_REL_DIR);
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * A run is the directory that actually holds the receipts. Both writers nest runs one or two
 * levels below the root (`<date>/` for the operator, `<archive>/<date>-<slug>/` for the
 * restored legacy runs), so the scan walks a bounded depth instead of assuming one shape.
 */
async function collectRuns(dir: string): Promise<string[]> {
  const runs: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    const jsonHere = entries.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (jsonHere) {
      runs.push(path.relative(dir, current));
    }
    if (depth <= 0) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), depth - 1);
      }
    }
  }
  await walk(dir, MAX_SCAN_DEPTH);
  return runs.toSorted();
}

async function describeRun(dir: string, id: string): Promise<RunEntry> {
  const abs = path.join(dir, id);
  let names: string[] = [];
  let bytes = 0;
  let modifiedAt: string | undefined;
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      names.push(entry.name);
      const stat = await fs.stat(path.join(abs, entry.name)).catch(() => null);
      if (!stat) {
        continue;
      }
      bytes += stat.size;
      const iso = stat.mtime.toISOString();
      if (modifiedAt === undefined || iso > modifiedAt) {
        modifiedAt = iso;
      }
    }
  } catch {
    /* An unreadable run is still listed, with what could be measured. */
  }
  const entry: RunEntry = { id, files: names.length, bytes, modifiedAt };
  const manifestRoot = asRecord(asRecord(await readJson(path.join(abs, "runtime.json")))?.manifest);
  const revision = asString(manifestRoot?.revision);
  if (revision !== undefined) {
    entry.revision = revision;
  }
  const models = asStringArray(manifestRoot?.models);
  if (models) {
    entry.models = models;
  }
  return entry;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return asRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(raw), max);
}

export function createFinanceResearchRunsReadTool(): AnyAgentTool {
  return {
    name: "finance_research_runs_read",
    label: "Finance research runs",
    description:
      "Read-only recall over finance research runs stored under the workspace: list the runs, open one run's manifest or a single response, or search the stored text. Never runs a model and never calls the network. A workspace with no stored runs reports available:false.",
    parameters: FinanceResearchRunsReadSchema,
    execute: async (_toolCallId, params) => {
      const workspaceDir = readStringParam(params, "workspaceDir");
      const action = readStringParam(params, "action") ?? "list";
      const dir = await resolveRunsDir(workspaceDir);
      if (!dir) {
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
          available: false,
          reason: "no research runs directory",
          note: "No runs have been stored for this workspace yet.",
          inspectedFrom: { workspaceDir: resolveWorkspaceRoot(workspaceDir) },
          runs: [],
        });
      }

      const runs = await collectRuns(dir);

      if (action === "read") {
        const run = readStringParam(params, "run");
        if (!run || run.includes("..") || path.isAbsolute(run)) {
          return jsonResult({
            ok: false,
            schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
            available: true,
            error: "`run` is required and must be a relative path as reported by `list`.",
          });
        }
        if (!runs.includes(run)) {
          return jsonResult({
            ok: false,
            schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
            available: true,
            error: `unknown run: ${run}`,
            runs: runs.slice(0, DEFAULT_LIST_LIMIT),
          });
        }
        const file = readStringParam(params, "file");
        const target = file
          ? path.join(dir, run, path.basename(file))
          : path.join(dir, run, "runtime.json");
        const parsed = await readJson(target);
        if (!parsed && !file) {
          // No manifest: report the run's index instead of failing, since the index is the
          // answer a caller usually wants when a run has no runtime.json.
          const index = await describeRun(dir, run);
          return jsonResult({
            ok: true,
            schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
            available: true,
            run: index,
            files: await fs
              .readdir(path.join(dir, run))
              .then((names) => names.filter((name) => name.endsWith(".json")).toSorted())
              .catch(() => [] as string[]),
            note: "This run has no runtime.json; the file list is reported instead.",
          });
        }
        const raw = await fs.readFile(target, "utf8").catch(() => null);
        if (raw === null) {
          return jsonResult({
            ok: false,
            schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
            available: true,
            error: `unreadable file: ${file ?? "runtime.json"}`,
          });
        }
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
          available: true,
          run,
          file: file ?? "runtime.json",
          truncated: raw.length > MAX_FILE_CHARS,
          json: parsed ?? undefined,
          text: parsed ? undefined : truncate(raw, MAX_FILE_CHARS),
        });
      }

      if (action === "search") {
        const query = readStringParam(params, "query");
        if (!query) {
          return jsonResult({
            ok: false,
            schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
            available: true,
            error: "`query` is required for search.",
          });
        }
        const limit = clampLimit(
          readNumberParam(params, "limit"),
          DEFAULT_HIT_LIMIT,
          MAX_HIT_LIMIT,
        );
        const needle = query.toLowerCase();
        const hits: Array<{
          run: string;
          file: string;
          stage?: string;
          model?: string;
          snippet: string;
        }> = [];
        for (const run of runs) {
          const names = await fs
            .readdir(path.join(dir, run))
            .then((all) => all.filter((name) => name.endsWith(".json")).toSorted())
            .catch(() => [] as string[]);
          for (const name of names) {
            const raw = await fs.readFile(path.join(dir, run, name), "utf8").catch(() => null);
            if (!raw) {
              continue;
            }
            const at = raw.toLowerCase().indexOf(needle);
            if (at < 0) {
              continue;
            }
            const parsed = await readJson(path.join(dir, run, name));
            hits.push({
              run,
              file: name,
              stage: asString(parsed?.stage),
              model: asString(parsed?.model),
              snippet: truncate(
                raw.slice(Math.max(0, at - 80), at + MAX_SNIPPET_CHARS),
                MAX_SNIPPET_CHARS,
              ),
            });
            if (hits.length >= limit) {
              break;
            }
          }
          if (hits.length >= limit) {
            break;
          }
        }
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
          available: true,
          query,
          truncated: hits.length >= limit,
          hits,
        });
      }

      const limit = clampLimit(
        readNumberParam(params, "limit"),
        DEFAULT_LIST_LIMIT,
        MAX_LIST_LIMIT,
      );
      const listed = await Promise.all(runs.slice(0, limit).map((run) => describeRun(dir, run)));
      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
        available: true,
        inspectedFrom: { workspaceDir: resolveWorkspaceRoot(workspaceDir) },
        totalRuns: runs.length,
        truncated: runs.length > limit,
        runs: listed,
      });
    },
  };
}
