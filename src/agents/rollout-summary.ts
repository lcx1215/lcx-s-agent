import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Rollout summaries: durable per-session digests written at the end of every
 * agent run, so a later session can recall earlier work without anyone having to
 * ask for it.
 *
 * Contract (mirrors the Codex `~/.codex/memories/rollout_summaries/` layout):
 * - one file per session; re-running the same session rewrites the same file
 * - front matter carries the provenance needed to jump back to the raw record
 * - the body is structured: task / outcome / key steps / final answer excerpt
 *
 * Everything here is best-effort. A failure to write a summary degrades the
 * system; it never fails the run that produced it.
 */

/** Directory under the agent workspace where summaries live (indexable by memory search). */
export const ROLLOUT_SUMMARY_REL_DIR = "memory/rollout-summaries";

/** Distilled index of all summaries, written by `distillRolloutSummaries`. */
export const ROLLOUT_INDEX_REL_PATH = "memory/rollout-index.md";
export const ROLLOUT_RAW_REL_PATH = "memory/rollout-raw-memories.md";

const MAX_TASK_CHARS = 600;
const MAX_ANSWER_CHARS = 1200;
const MAX_KEY_STEPS = 20;

export type RolloutSummaryOutcome = "success" | "aborted" | "error";

export type WriteRolloutSummaryParams = {
  workspaceDir: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  outcome: RolloutSummaryOutcome;
  error?: string;
  durationMs?: number;
  messages: readonly unknown[];
};

export type WriteRolloutSummaryResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; reason: string };

type ContentBlock = { type?: unknown; text?: unknown; name?: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function blockText(block: ContentBlock): string {
  if (typeof block.text === "string") {
    return block.text;
  }
  return "";
}

/** Extract plain text from a message whose `content` may be a string or blocks. */
function messageText(message: unknown): string {
  const rec = asRecord(message);
  if (!rec) {
    return "";
  }
  const content = rec.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const raw of content) {
    const block = asRecord(raw) as ContentBlock | undefined;
    if (!block || block.type !== "text") {
      continue;
    }
    const text = blockText(block).trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

function messageRole(message: unknown): string {
  const rec = asRecord(message);
  return typeof rec?.role === "string" ? rec.role : "";
}

/** Tool names in call order, de-duplicated, so the digest shows what was actually done. */
function collectToolNames(messages: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const message of messages) {
    const rec = asRecord(message);
    const content = rec?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const raw of content) {
      const block = asRecord(raw) as ContentBlock | undefined;
      if (!block || block.type !== "toolCall") {
        continue;
      }
      const name = typeof block.name === "string" ? block.name : "";
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
      if (names.length >= MAX_KEY_STEPS) {
        return names;
      }
    }
  }
  return names;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/** Timestamp shape used in file names: sortable and filesystem safe. */
function stampParts(now: Date): { date: string; time: string } {
  const iso = now.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19).replace(/:/g, "-") };
}

export function resolveRolloutSummaryDir(workspaceDir: string): string {
  return path.join(workspaceDir, ROLLOUT_SUMMARY_REL_DIR);
}

function gitBranch(workspaceDir: string): string | undefined {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspaceDir,
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const branch = String(out).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function pickTask(messages: readonly unknown[]): string {
  for (const message of messages) {
    if (messageRole(message) !== "user") {
      continue;
    }
    const text = messageText(message).trim();
    if (text) {
      return truncate(text, MAX_TASK_CHARS);
    }
  }
  return "(no user message captured)";
}

function pickAnswer(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messageRole(messages[i]) !== "assistant") {
      continue;
    }
    const text = messageText(messages[i]).trim();
    if (text) {
      return truncate(text, MAX_ANSWER_CHARS);
    }
  }
  return "(no assistant message captured)";
}

export function buildRolloutSummaryDocument(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  outcome: RolloutSummaryOutcome;
  error?: string;
  durationMs?: number;
  cwd: string;
  branch?: string;
  transcriptPath?: string;
  now: Date;
  messages: readonly unknown[];
}): string {
  const { date, time } = stampParts(params.now);
  const task = pickTask(params.messages);
  const answer = pickAnswer(params.messages);
  const tools = collectToolNames(params.messages);

  const frontMatter: string[] = [
    "---",
    `session_id: ${params.sessionId}`,
    `updated_at: ${params.now.toISOString()}`,
    `run_id: ${params.runId ?? ""}`,
    `agent_id: ${params.agentId ?? ""}`,
    `session_key: ${params.sessionKey ?? ""}`,
    `cwd: ${params.cwd}`,
    `git_branch: ${params.branch ?? ""}`,
    `transcript_path: ${params.transcriptPath ?? ""}`,
    `outcome: ${params.outcome}`,
    `duration_ms: ${params.durationMs ?? ""}`,
    `message_count: ${params.messages.length}`,
    "---",
    "",
  ];

  const lines: string[] = [];
  lines.push(`# ${date} ${time.replace(/-/g, ":")} ${params.sessionId.slice(0, 8)}`);
  lines.push("");
  lines.push("## Task");
  lines.push("");
  lines.push(task);
  lines.push("");
  lines.push("## Outcome");
  lines.push("");
  lines.push(
    params.outcome === "success"
      ? "Completed."
      : `${params.outcome === "aborted" ? "Aborted" : "Failed"}${
          params.error ? `: ${params.error}` : "."
        }`,
  );
  lines.push("");
  lines.push("## Key steps");
  lines.push("");
  if (tools.length === 0) {
    lines.push("- (no tool calls recorded)");
  } else {
    for (const name of tools) {
      lines.push(`- ${name}`);
    }
  }
  lines.push("");
  lines.push("## Final answer");
  lines.push("");
  lines.push(answer);
  lines.push("");

  return `${frontMatter.join("\n")}${lines.join("\n")}`;
}

export async function writeRolloutSummary(
  params: WriteRolloutSummaryParams,
): Promise<WriteRolloutSummaryResult> {
  try {
    if (!params.workspaceDir) {
      return { ok: false, reason: "workspaceDir missing" };
    }
    const sessionId = params.sessionId?.trim();
    if (!sessionId) {
      return { ok: false, reason: "sessionId missing" };
    }
    if (params.messages.length === 0) {
      return { ok: false, reason: "no messages" };
    }

    const dir = resolveRolloutSummaryDir(params.workspaceDir);
    await fsp.mkdir(dir, { recursive: true });

    const now = new Date();
    // One digest per session: re-running the same session rewrites the same
    // file instead of accumulating a new artifact per turn.
    const fileName = `${sessionId}.md`;
    const target = path.join(dir, fileName);

    const document = buildRolloutSummaryDocument({
      sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      runId: params.runId,
      outcome: params.outcome,
      error: params.error,
      durationMs: params.durationMs,
      cwd: params.workspaceDir,
      branch: gitBranch(params.workspaceDir),
      transcriptPath: path.join(params.workspaceDir, "..", "sessions", `${sessionId}.jsonl`),
      now,
      messages: params.messages,
    });

    const tmp = `${target}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, document, "utf8");
    await fsp.rename(tmp, target);
    return { ok: true, path: target, bytes: Buffer.byteLength(document, "utf8") };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fire-and-forget wrapper for the run-loop call site. Never throws, never
 * rejects: a missing summary is a stated limitation, not a run failure.
 */
export function scheduleRolloutSummary(params: WriteRolloutSummaryParams): void {
  void writeRolloutSummary(params).catch((err: unknown) => {
    // Intentionally silent: the run already completed.
    void err;
  });
}

/** Read the newest summary mtime, used to decide when to re-distill. */
export function readLastDistillMarker(workspaceDir: string): number | undefined {
  try {
    const marker = path.join(resolveRolloutSummaryDir(workspaceDir), ".last-distill");
    return fs.statSync(marker).mtimeMs;
  } catch {
    return undefined;
  }
}
