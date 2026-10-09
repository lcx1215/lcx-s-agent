import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { sameFileIdentity } from "../../infra/file-identity.js";
import { readFileWithinRoot, SafeOpenError } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

export const FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION =
  "lcx_finance_research_runs_read_v1" as const;
const RUNS_REL_DIR = "state/finance-research-runs";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Final pretty-printed tool evidence budget; independent of model output-token capacity. */
const MAX_PAYLOAD_BYTES = 8_000;
const MAX_SCAN_DEPTH = 3;
const MAX_KEYS = 40;
function optionalString(description: string, maxLength?: number) {
  return Type.Optional(
    Type.String({ description, ...(maxLength === undefined ? {} : { maxLength }) }),
  );
}
const FinanceResearchRunsReadSchema = Type.Object({
  workspaceDir: optionalString("Workspace root; defaults to working directory."),
  action: Type.Optional(
    Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("search")], {
      description: "Defaults to list.",
    }),
  ),
  run: optionalString("Run from list; required for read."),
  file: optionalString("File name; defaults to runtime.json or its index."),
  field: optionalString(
    "RFC6901 JSON Pointer; max16 segments. Empty selects root. Large selections return bounded preview and usable keys.",
    1024,
  ),
  query: optionalString("Case-insensitive search term."),
  limit: Type.Optional(
    Type.Number({ description: "List default20/max100; search default10/max50; bounded output." }),
  ),
});
type Gap = { path: string; reason: string };
type Context = { root: string; dir: string; signal?: AbortSignal; gaps: Gap[] };
class ReadGap extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReadGap";
  }
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ReadGap("finance_research_read_cancelled");
  }
}
function reason(error: unknown): string {
  return error instanceof ReadGap
    ? error.code
    : error instanceof SafeOpenError
      ? `finance_research_read_${error.code.replaceAll("-", "_")}`
      : "finance_research_read_unavailable";
}
function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2));
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function excerpt(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString("utf8");
}
/** Bound all actions by the actual jsonResult text, including metadata and escaped keys. */
function respond(payload: Record<string, unknown>) {
  if (typeof payload.text === "string" && size(payload) > MAX_PAYLOAD_BYTES) {
    const text = payload.text;
    let low = 0;
    let high = Buffer.byteLength(text);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      payload.text = excerpt(text, mid);
      if (size(payload) <= MAX_PAYLOAD_BYTES) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    payload.text = excerpt(text, low);
    payload.truncated = true;
  }
  for (const name of ["gaps", "hits", "runs", "files", "keys"]) {
    const items = payload[name];
    if (!Array.isArray(items)) {
      continue;
    }
    let omitted = Number(payload[`${name}Omitted`] ?? 0);
    while (items.length && size(payload) > MAX_PAYLOAD_BYTES) {
      items.pop();
      omitted++;
      payload.truncated = true;
    }
    if (omitted) {
      payload[`${name}Omitted`] = omitted;
    }
  }
  if (size(payload) > MAX_PAYLOAD_BYTES) {
    return jsonResult({
      ok: false,
      available: true,
      schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
      gap: "finance_research_response_budget_exceeded",
    });
  }
  return jsonResult(payload);
}
async function checkedPath(root: string, absolute: string): Promise<void> {
  if (!isPathInside(root, absolute)) {
    throw new ReadGap("finance_research_path_blocked");
  }
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new ReadGap("finance_research_symlink_blocked");
    }
  }
  if (!isPathInside(root, await fs.realpath(absolute))) {
    throw new ReadGap("finance_research_path_blocked");
  }
}
async function resolveRunsDir(
  workspaceDir?: string,
): Promise<{ root: string; dir: string } | null> {
  try {
    const root = await fs.realpath(resolveWorkspaceRoot(workspaceDir));
    const dir = path.join(root, RUNS_REL_DIR);
    await checkedPath(root, dir);
    return (await fs.stat(dir)).isDirectory() ? { root, dir } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function entries(context: Context, dir: string) {
  cancelled(context.signal);
  await checkedPath(context.root, dir);
  const found = await fs.readdir(dir, { withFileTypes: true });
  await checkedPath(context.root, dir);
  cancelled(context.signal);
  return found;
}
async function jsonFiles(context: Context, dir: string): Promise<string[]> {
  return (await entries(context, dir))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .toSorted();
}
async function collectRuns(context: Context): Promise<string[]> {
  const runs: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    const found = await entries(context, dir);
    if (
      found.some(
        (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".json"),
      )
    ) {
      runs.push(path.relative(context.dir, dir) || ".");
    }
    for (const entry of found) {
      if (entry.isSymbolicLink()) {
        context.gaps.push({
          path: path.relative(context.root, path.join(dir, entry.name)),
          reason: "finance_research_symlink_blocked",
        });
      } else if (depth > 0 && entry.isDirectory()) {
        await walk(path.join(dir, entry.name), depth - 1);
      }
    }
  }
  await walk(context.dir, MAX_SCAN_DEPTH);
  return runs.toSorted();
}
async function readOriginal(context: Context, target: string) {
  cancelled(context.signal);
  await checkedPath(context.root, target);
  const original = await readFileWithinRoot({
    rootDir: context.root,
    relativePath: path.relative(context.root, target),
    maxBytes: MAX_FILE_BYTES,
  });
  cancelled(context.signal);
  await checkedPath(context.root, target);
  const after = await fs.lstat(target);
  if (
    !sameFileIdentity(original.stat, after) ||
    original.stat.size !== after.size ||
    original.stat.mtimeMs !== after.mtimeMs ||
    original.stat.ctimeMs !== after.ctimeMs ||
    original.buffer.length !== after.size ||
    after.nlink > 1
  ) {
    throw new ReadGap("finance_research_read_changed");
  }
  if (original.buffer.length > MAX_FILE_BYTES) {
    throw new ReadGap("finance_research_read_too_large");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(original.buffer);
  } catch {
    throw new ReadGap("finance_research_read_invalid_utf8");
  }
  let json: unknown;
  let parsed = false;
  try {
    json = JSON.parse(text);
    parsed = true;
  } catch {
    /* Preserve malformed original as bounded text. */
  }
  return {
    text,
    json,
    parsed,
    source: {
      sourceRef: path.relative(context.root, target),
      sourceSha256: createHash("sha256").update(original.buffer).digest("hex"),
      sourceBytes: original.buffer.length,
      sourceModifiedAt: original.stat.mtime.toISOString(),
    },
  };
}
function addGap(context: Context, target: string, error: unknown): void {
  cancelled(context.signal);
  context.gaps.push({ path: path.relative(context.root, target), reason: reason(error) });
}
async function describeRun(context: Context, id: string, includeManifest = true) {
  const dir = path.join(context.dir, id);
  const names = await jsonFiles(context, dir);
  let bytes = 0;
  let modifiedAt: string | undefined;
  for (const name of names) {
    const target = path.join(dir, name);
    await checkedPath(context.root, target);
    const stat = await fs.lstat(target);
    if (stat.nlink > 1) {
      context.gaps.push({
        path: path.relative(context.root, target),
        reason: "finance_research_read_invalid_path",
      });
      continue;
    }
    bytes += stat.size;
    const at = stat.mtime.toISOString();
    if (!modifiedAt || at > modifiedAt) {
      modifiedAt = at;
    }
  }
  const manifest = includeManifest ? await readRunManifest(context, id, names) : undefined;
  return {
    id,
    files: names.length,
    bytes,
    modifiedAt,
    revision: asString(manifest?.revision),
    models: asStringArray(manifest?.models),
  };
}
async function readRunManifest(context: Context, id: string, knownNames?: string[]) {
  const dir = path.join(context.dir, id);
  const names = knownNames ?? (await jsonFiles(context, dir));
  if (names.includes("runtime.json")) {
    try {
      return asRecord(
        asRecord((await readOriginal(context, path.join(dir, "runtime.json"))).json)?.manifest,
      );
    } catch (error) {
      addGap(context, path.join(dir, "runtime.json"), error);
    }
  }
  return undefined;
}
function selectField(value: unknown, field: string): unknown {
  if (field.length > 1024 || (field && !field.startsWith("/")) || /~(?![01])/u.test(field)) {
    throw new ReadGap("finance_research_field_invalid");
  }
  const parts = field === "" ? [] : field.slice(1).split("/");
  if (parts.length > 16) {
    throw new ReadGap("finance_research_field_invalid");
  }
  let selected = value;
  for (const raw of parts) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      selected === null ||
      typeof selected !== "object" ||
      (Array.isArray(selected) && !/^(?:0|[1-9]\d*)$/u.test(key)) ||
      !Object.hasOwn(selected, key)
    ) {
      throw new ReadGap("finance_research_field_missing");
    }
    selected = (selected as Record<string, unknown>)[key];
  }
  return selected;
}
function readPayload(base: Record<string, unknown>, value: unknown, raw: string, field?: string) {
  const complete = {
    ok: true,
    schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
    available: true,
    ...(field === undefined
      ? { json: value }
      : { field, selectedValue: value, selectionComplete: true }),
    ...base,
    truncated: false,
  };
  if (size(complete) <= MAX_PAYLOAD_BYTES) {
    return complete;
  }
  const keys = value !== null && typeof value === "object" ? Object.keys(value) : [];
  const usable = keys
    .filter((key) => Buffer.byteLength(JSON.stringify(key)) <= 128)
    .slice(0, MAX_KEYS);
  return {
    ok: true,
    schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION,
    available: true,
    ...(field === undefined ? {} : { field, selectionComplete: false }),
    ...base,
    truncated: true,
    keys: usable,
    keysOmitted: keys.length - usable.length,
    note: "Bounded preview only; omitted values are not complete JSON. Use field with an exact JSON Pointer to read a smaller value.",
    text: excerpt(raw, MAX_PAYLOAD_BYTES),
  };
}
function validFile(file?: string): boolean {
  return (
    file === undefined ||
    (file !== "" &&
      file === path.basename(file) &&
      !file.includes("\\") &&
      file !== "." &&
      file !== "..")
  );
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function validRun(run: string): boolean {
  return (
    run === "." ||
    (run.length <= 1024 &&
      !path.isAbsolute(run) &&
      !run.includes("\\") &&
      run.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
  );
}
function limit(raw: number | undefined, fallback: number, max: number): number {
  return raw === undefined || !Number.isFinite(raw) || raw <= 0
    ? fallback
    : Math.min(Math.floor(raw), max);
}

export function createFinanceResearchRunsReadTool(): AnyAgentTool {
  return {
    name: "finance_research_runs_read",
    label: "Finance research runs",
    parameters: FinanceResearchRunsReadSchema,
    description:
      "Read-only stored finance research: list most recently modified runs first, bounded search, or read a file/JSON Pointer field. Modified time is storage recency, not evidence validity. Full original SHA and time are retained; large results return explicit preview and omitted keys. Never calls models or network; no runs reports available:false.",
    execute: async (_toolCallId, params, signal) => {
      let context: Context | undefined;
      let readSource: Record<string, unknown> | undefined;
      const base = { schemaVersion: FINANCE_RESEARCH_RUNS_READ_SCHEMA_VERSION, available: true };
      try {
        cancelled(signal);
        const workspaceDir = readStringParam(params, "workspaceDir");
        const action = readStringParam(params, "action") ?? "list";
        const resolved = await resolveRunsDir(workspaceDir);
        cancelled(signal);
        if (!resolved) {
          return respond({
            ...base,
            ok: true,
            available: false,
            reason: "no research runs directory",
            runs: [],
          });
        }
        context = { ...resolved, signal, gaps: [] };
        const runs = await collectRuns(context);
        if (action === "read") {
          const run = readStringParam(params, "run");
          const file = readStringParam(params, "file");
          const field = readStringParam(params, "field", { trim: false, allowEmpty: true });
          if (Object.hasOwn(params, "field") && typeof params.field !== "string") {
            throw new ReadGap("finance_research_field_invalid");
          }
          if (!run || !validRun(run) || !validFile(file)) {
            throw new ReadGap("finance_research_path_blocked");
          }
          if (!runs.includes(run)) {
            throw new ReadGap("finance_research_run_missing");
          }
          const target = path.join(context.dir, run, file ?? "runtime.json");
          let original: Awaited<ReturnType<typeof readOriginal>>;
          try {
            original = await readOriginal(context, target);
          } catch (error) {
            if (
              file === undefined &&
              field === undefined &&
              ((error instanceof SafeOpenError && error.code === "not-found") ||
                (error as NodeJS.ErrnoException).code === "ENOENT")
            ) {
              const names = await jsonFiles(context, path.join(context.dir, run));
              return respond({
                ...base,
                ok: true,
                run: await describeRun(context, run),
                files: names,
                note: "This run has no runtime.json; the file list is reported instead.",
                gaps: context.gaps,
              });
            }
            throw error;
          }
          readSource = original.source;
          const metadata = { ...readSource, run, file: file ?? "runtime.json" };
          if (field !== undefined && !original.parsed) {
            throw new ReadGap("finance_research_field_unavailable_invalid_json");
          }
          if (!original.parsed) {
            return respond({
              ...base,
              ok: true,
              ...metadata,
              truncated: Buffer.byteLength(original.text) > MAX_PAYLOAD_BYTES,
              text: excerpt(original.text, MAX_PAYLOAD_BYTES),
            });
          }
          const selected = field === undefined ? original.json : selectField(original.json, field);
          return respond(
            readPayload(
              metadata,
              selected,
              field === undefined ? original.text : JSON.stringify(selected),
              field,
            ),
          );
        }
        if (action === "search") {
          const query = readStringParam(params, "query");
          if (!query || query.length > 1024) {
            throw new ReadGap("finance_research_query_invalid");
          }
          const maximum = limit(readNumberParam(params, "limit"), 10, 50);
          const hits: Record<string, unknown>[] = [];
          for (const run of runs) {
            const names = await jsonFiles(context, path.join(context.dir, run));
            for (const name of names) {
              const target = path.join(context.dir, run, name);
              try {
                const original = await readOriginal(context, target);
                const at = original.text.toLowerCase().indexOf(query.toLowerCase());
                if (at < 0) {
                  continue;
                }
                const parsed = asRecord(original.json);
                hits.push({
                  run,
                  file: name,
                  stage: asString(parsed?.stage),
                  model: asString(parsed?.model),
                  source: original.source,
                  snippet: excerpt(original.text.slice(Math.max(0, at - 80)), 400),
                });
              } catch (error) {
                addGap(context, target, error);
              }
              if (hits.length >= maximum) {
                break;
              }
            }
            if (hits.length >= maximum) {
              break;
            }
          }
          cancelled(signal);
          return respond({
            ...base,
            ok: true,
            query,
            truncated: hits.length >= maximum,
            hits,
            gaps: context.gaps,
          });
        }
        if (action !== "list") {
          throw new ReadGap("finance_research_action_invalid");
        }
        const maximum = limit(readNumberParam(params, "limit"), 20, 100);
        // Rank metadata before limiting; old directories must not hide current results.
        // Only selected runs need their manifest bodies read.
        const described = [];
        for (const run of runs) {
          described.push(await describeRun(context, run, false));
        }
        described.sort(
          (a, b) =>
            (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "") || a.id.localeCompare(b.id),
        );
        const listed = [];
        for (const run of described.slice(0, maximum)) {
          const manifest = await readRunManifest(context, run.id);
          listed.push({
            ...run,
            revision: asString(manifest?.revision),
            models: asStringArray(manifest?.models),
          });
        }
        cancelled(signal);
        return respond({
          ...base,
          ok: true,
          inspectedFrom: { workspaceDir: context.root },
          totalRuns: runs.length,
          truncated: runs.length > maximum,
          runs: listed,
          gaps: context.gaps,
        });
      } catch (error) {
        return respond({
          ...base,
          ok: false,
          gap: reason(error),
          error: reason(error),
          ...readSource,
        });
      }
    },
  };
}
