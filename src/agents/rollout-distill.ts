import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  ROLLOUT_INDEX_REL_PATH,
  ROLLOUT_RAW_REL_PATH,
  ROLLOUT_SUMMARY_REL_DIR,
} from "./rollout-summary.js";

/**
 * Distillation: turns the per-session rollout summaries into two durable,
 * indexable files that a new session can read in one shot.
 *
 * - `memory/rollout-index.md`   — chronological index (one line per session)
 * - `memory/rollout-raw-memories.md` — concatenated bodies, newest first
 *
 * This is mechanical (no model call) so it is deterministic, offline, and
 * cheap enough to run unattended. It never touches the protected `MEMORY.md`.
 */

const MAX_INDEX_ENTRIES = 500;
const MAX_RAW_ENTRIES = 200;
const MAX_RAW_CHARS = 400_000;
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MIN_SUMMARIES = 1;

export type DistillResult =
  | { ok: true; index: string; raw: string; count: number }
  | { ok: false; reason: string };

type ParsedSummary = {
  fileName: string;
  sessionId: string;
  updatedAt: string;
  outcome: string;
  cwd: string;
  branch: string;
  taskLine: string;
  body: string;
};

function parseFrontMatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return out;
  }
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function parseSummary(fileName: string, raw: string): ParsedSummary {
  const meta = parseFrontMatter(raw);
  const bodyStart = raw.indexOf("\n---\n");
  const body = bodyStart >= 0 ? raw.slice(bodyStart + 5) : raw;
  const heading = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));
  return {
    fileName,
    sessionId: meta.session_id ?? "",
    updatedAt: meta.updated_at ?? "",
    outcome: meta.outcome ?? "",
    cwd: meta.cwd ?? "",
    branch: meta.git_branch ?? "",
    taskLine: heading ? heading.replace(/^#\s+/, "") : fileName,
    body: body.trim(),
  };
}

async function readSummaries(dir: string): Promise<ParsedSummary[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((name) => name.endsWith(".md")).toSorted();
  const parsed: ParsedSummary[] = [];
  for (const name of files) {
    try {
      const raw = await fsp.readFile(path.join(dir, name), "utf8");
      parsed.push(parseSummary(name, raw));
    } catch {
      // Unreadable summary is skipped, not fatal.
    }
  }
  parsed.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return parsed;
}

function buildIndex(summaries: ParsedSummary[]): string {
  const lines: string[] = [];
  lines.push("# Rollout summary index");
  lines.push("");
  lines.push(`Sessions recorded: ${summaries.length}`);
  lines.push("");
  lines.push("Newest first. Each entry links to the full per-session digest.");
  lines.push("");
  for (const s of summaries.slice(0, MAX_INDEX_ENTRIES)) {
    const stamp = s.updatedAt ? s.updatedAt.slice(0, 16).replace("T", " ") : "unknown";
    const sid = s.sessionId ? s.sessionId.slice(0, 8) : "--------";
    lines.push(`- ${stamp} \`${sid}\` [${s.outcome || "?"}] ${s.taskLine}`);
    lines.push(`  - digest: ${ROLLOUT_SUMMARY_REL_DIR}/${s.fileName}`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildRaw(summaries: ParsedSummary[]): string {
  const lines: string[] = [];
  lines.push("# Raw rollout memories");
  lines.push("");
  lines.push(
    `Concatenated digests, newest first (max ${MAX_RAW_ENTRIES} sessions). Generated mechanically from per-session summaries.`,
  );
  lines.push("");
  let chars = lines.join("\n").length;
  for (const s of summaries.slice(0, MAX_RAW_ENTRIES)) {
    const block = [
      `## ${s.updatedAt || "unknown"} ${s.sessionId || ""}`,
      "",
      `outcome: ${s.outcome || "unknown"}`,
      s.branch ? `branch: ${s.branch}` : "",
      s.cwd ? `cwd: ${s.cwd}` : "",
      "",
      s.body,
      "",
    ]
      .filter(Boolean)
      .join("\n");
    if (chars + block.length > MAX_RAW_CHARS) {
      lines.push("(truncated: raw memory budget reached)");
      lines.push("");
      break;
    }
    lines.push(block);
    chars += block.length;
  }
  return lines.join("\n");
}

export async function distillRolloutSummaries(workspaceDir: string): Promise<DistillResult> {
  try {
    const dir = path.join(workspaceDir, ROLLOUT_SUMMARY_REL_DIR);
    const summaries = await readSummaries(dir);
    if (summaries.length === 0) {
      return { ok: false, reason: "no summaries" };
    }
    const index = buildIndex(summaries);
    const raw = buildRaw(summaries);

    const indexAbs = path.join(workspaceDir, ROLLOUT_INDEX_REL_PATH);
    const rawAbs = path.join(workspaceDir, ROLLOUT_RAW_REL_PATH);
    await fsp.mkdir(path.dirname(indexAbs), { recursive: true });

    for (const [abs, content] of [
      [indexAbs, index],
      [rawAbs, raw],
    ] as const) {
      const tmp = `${abs}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, content, "utf8");
      await fsp.rename(tmp, abs);
    }

    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, ".last-distill"), String(Date.now()), "utf8");

    return { ok: true, index: indexAbs, raw: rawAbs, count: summaries.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs distillation only when it is due, so every session end stays cheap.
 * Best-effort and fire-and-forget: never throws.
 */
export function maybeDistillRolloutSummaries(params: {
  workspaceDir: string;
  minIntervalMs?: number;
  minSummaries?: number;
}): void {
  const interval = params.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const minSummaries = params.minSummaries ?? DEFAULT_MIN_SUMMARIES;
  void (async () => {
    try {
      const dir = path.join(params.workspaceDir, ROLLOUT_SUMMARY_REL_DIR);
      let count = 0;
      try {
        count = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).length;
      } catch {
        return;
      }
      if (count < minSummaries) {
        return;
      }
      const marker = path.join(dir, ".last-distill");
      let last = 0;
      try {
        last = Number(fs.readFileSync(marker, "utf8").trim());
      } catch {
        last = 0;
      }
      if (last && Date.now() - last < interval) {
        return;
      }
      await distillRolloutSummaries(params.workspaceDir);
    } catch {
      // Distillation is optional; silence is the correct failure mode.
    }
  })();
}
