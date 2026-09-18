import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  foundationTemplateForTopic,
  reviewHintsForTopic,
} from "../../hooks/bundled/learning-review/handler.js";
import { writeJsonAtomic } from "../central-harness/run-store.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

export const LEARNING_DISTILL_SCHEMA_VERSION = "lcx_learning_workflow_v1" as const;

/** Filenames the learning-review hook produces: <YYYY-MM-DD>-review-*.md */
const LEARNING_FILE_RE = /^(\d{4}-\d{2}-\d{2})-review-.*\.md$/;
/** Latest pointer written under the workspace state dir; readers share one name. */
export const LEARNING_WORKFLOW_LATEST_FILENAME = "lcx-learning-workflow-latest.json";
/** Immutable per-run snapshots under <state>/learning-workflow/runs. */
export const LEARNING_WORKFLOW_RUNS_RELATIVE_DIR = path.join("learning-workflow", "runs");
/** How many processed entries the latest pointer retains before pruning old ones. */
const PROCESSED_RETAIN_LIMIT = 200;

const LearningDistillSchema = Type.Object({
  memoryDir: Type.Optional(
    Type.String({
      description:
        "Memory directory to scan for pending learning-review notes. Defaults to <workspace>/memory.",
    }),
  ),
  stateDir: Type.Optional(
    Type.String({
      description:
        "State directory for the learning-workflow surface. Defaults to <workspace>/state.",
    }),
  ),
  windowDays: Type.Optional(
    Type.Number({
      description: "Only distill review notes from the last N days. Defaults to 14; max 366.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description:
        "ISO date cutoff: only distill notes dated on or after this date. Optional override of windowDays.",
    }),
  ),
});

/** One deterministically distilled learning card. */
export type LearningDistillCard = {
  /** Filename of the source review note. */
  name: string;
  /** YYYY-MM-DD from the filename. */
  date: string;
  sessionKey: string;
  sessionId: string;
  topic: string;
  corePrinciple: string;
  mistakePattern: string;
  microDrill: string;
  transferHint: string;
  foundationTemplate: string;
  /** Same (sessionKey, topic) observed in >= 2 review notes present in memory. */
  replay: boolean;
  /** The micro-drill the next session should evaluate, from the topic's own hints. */
  nextEval: string;
};

/** A review note that could not be distilled, with the named reason. */
export type LearningDistillGap = Readonly<{
  name: string;
  reason: string;
}>;

/** One processed entry retained on the surface: a folded learning card. */
export type LearningProcessedEntry = Readonly<{
  name: string;
  topic: string;
  distilledAt: string;
}>;

export type LearningWorkflowState = Readonly<{
  schemaVersion: typeof LEARNING_DISTILL_SCHEMA_VERSION;
  updatedAt: string;
  lastDistilledAt: string;
  scanned: number;
  pending: number;
  distilled: number;
  alreadyProcessed: number;
  unparsed: readonly LearningDistillGap[];
  cards: readonly LearningDistillCard[];
  /** Review-note names distilled by this run (the queue worked). */
  queue: readonly string[];
  /** Review-note names already folded into a durable card. */
  done: readonly string[];
  /** Retained processed entries with their provenance; pruned at the retain limit. */
  processed: readonly LearningProcessedEntry[];
  /** Pruned oldest processed entries that no longer fit the retain window, named. */
  processedPruned: number;
  latestRunPath: string;
  summary: Readonly<{
    keep: number;
    replay: number;
    discard: number;
    nextEval: readonly string[];
  }>;
}>;

function parseReviewSnapshot(
  name: string,
  content: string,
):
  | {
      ok: true;
      parsed: Omit<LearningDistillCard, "replay" | "nextEval" | "foundationTemplate">;
    }
  | { ok: false; reason: string } {
  const fileMatch = name.match(LEARNING_FILE_RE);
  if (!fileMatch) {
    return { ok: false, reason: "not_a_learning_review_name" };
  }
  const topic = (content.match(/- \*\*Topic\*\*:\s*([^\n]+)/u)?.[1] ?? "").trim();
  if (!topic) {
    // The learning-review hook always writes a topic; a note without one is an
    // anomaly that must surface by name instead of being silently inferred.
    return { ok: false, reason: "learning_review_topic_missing" };
  }
  const extraction = (pattern: RegExp): string => (content.match(pattern)?.[1] ?? "").trim();
  return {
    ok: true,
    parsed: {
      name,
      date: fileMatch[1],
      sessionKey: extraction(/- \*\*Session Key\*\*:\s*([^\n]+)/u) || "unknown",
      sessionId: extraction(/- \*\*Session ID\*\*:\s*([^\n]+)/u) || "unknown",
      topic,
      mistakePattern:
        extraction(/^- mistake_pattern:\s*(.+)$/mu) || "No recurring mistake captured.",
      corePrinciple: extraction(/^- core_principle:\s*(.+)$/mu) || "No core principle captured.",
      microDrill: extraction(/^- micro_drill:\s*(.+)$/mu) || "No micro-drill captured.",
      transferHint: extraction(/^- transfer_hint:\s*(.+)$/mu) || "No transfer hint captured.",
    },
  };
}

async function readPriorState(
  stateDir: string,
): Promise<{ state?: LearningWorkflowState; gap?: LearningDistillGap }> {
  try {
    const raw = await fs.readFile(path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<LearningWorkflowState>;
    if (typeof parsed.schemaVersion !== "string") {
      return {
        gap: { name: LEARNING_WORKFLOW_LATEST_FILENAME, reason: "learning_workflow_state_invalid" },
      };
    }
    return { state: parsed as LearningWorkflowState };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // First run: no prior surface is a normal start, not a failure.
      return {};
    }
    return {
      gap: {
        name: LEARNING_WORKFLOW_LATEST_FILENAME,
        reason: "learning_workflow_state_unreadable",
      },
    };
  }
}

/**
 * Deterministic learning-workflow capability for the central harness.
 *
 * The learning-review hook already captures a review note per study-heavy session,
 * but nobody folds those notes into a durable surface the agent can read back:
 * they sit in memory/ as text and every later consumer re-parses them ad hoc. This
 * tool closes that loop at the existing seam — it reuses the hook's own
 * deterministic topic → hints → foundation mappings, so the distillation can never
 * drift from what the hook wrote, and it writes ONLY its own workflow state under
 * <workspace>/state. It never edits a review note, never invents a verdict
 * (discard is a named zero: evidence is retained, not deleted), and an absent
 * memory tree is a named failure, not an empty queue.
 */
export function createLearningDistillTool(options?: { workspaceDir?: string }): AnyAgentTool {
  const workspace = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    name: "learning_distill",
    label: "Learning Distill",
    description:
      "Distill pending learning-review notes (written by the learning-review hook) into durable keep cards: topic, core principle, mistake pattern, micro-drill, transfer hint, foundation template, replay flag, and the next-eval drill. Read-only over the workspace memory directory; it writes only its own local workflow state under <workspace>/state (learning-workflow). It never edits a review note, never invents a verdict, and reports an absent memory tree as a named failure rather than an empty queue.",
    parameters: LearningDistillSchema,
    execute: async (_toolCallId, args, callerSignal) => {
      callerSignal?.throwIfAborted();
      const params = args as Record<string, unknown>;
      const memoryDir = readStringParam(params, "memoryDir") ?? path.join(workspace, "memory");
      const stateDir = readStringParam(params, "stateDir") ?? path.join(workspace, "state");
      const windowDays = Math.min(
        Math.max(readNumberParam(params, "windowDays", { integer: true }) ?? 14, 1),
        366,
      );
      const since = readStringParam(params, "since");
      if (since !== undefined && !Number.isFinite(Date.parse(since))) {
        return jsonResult({
          ok: false,
          reason: "learning_distill_since_invalid",
          since,
          action: "Pass since as an ISO datetime, or omit it for the default window.",
        });
      }

      const memoryPresent = await fs
        .access(memoryDir)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return false;
          }
          throw error;
        });
      if (!memoryPresent) {
        return jsonResult({
          ok: false,
          status: "absent",
          reason: "learning_distill_memory_absent",
          memoryDir,
          action: "Point memoryDir at a directory containing *-review-*.md notes.",
        });
      }

      callerSignal?.throwIfAborted();
      const nowIso = new Date().toISOString();
      const cutoffDate = since ? since.slice(0, 10) : truncateDateByDays(nowIso, windowDays);
      const prior = await readPriorState(stateDir);
      const unparsed: LearningDistillGap[] = prior.gap ? [prior.gap] : [];

      let scanned = 0;
      let parsedCards: LearningDistillCard[] = [];
      try {
        const dirents = await fs.readdir(memoryDir, { withFileTypes: true });
        const entries = await Promise.all(
          dirents
            .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".md"))
            .map(async (dirent) => ({
              name: dirent.name,
              content: await fs.readFile(path.join(memoryDir, dirent.name), "utf8"),
            })),
        );
        // Only learning-review notes participate; other memory notes are ignored.
        const reviewEntries = entries.filter((entry) => LEARNING_FILE_RE.test(entry.name));
        scanned = reviewEntries.length;
        for (const entry of reviewEntries) {
          const result = parseReviewSnapshot(entry.name, entry.content);
          if (!result.ok) {
            unparsed.push({ name: entry.name, reason: result.reason });
            continue;
          }
          // Derived fields are deterministic functions of the note's own topic, so
          // a note authored later can never change how an older note distills.
          const hints = reviewHintsForTopic(result.parsed.topic);
          const foundationTemplate =
            (entry.content.match(/^- foundation_template:\s*(.+)$/mu)?.[1] ?? "").trim() ||
            foundationTemplateForTopic(result.parsed.topic);
          parsedCards.push({
            ...result.parsed,
            foundationTemplate,
            replay: false,
            nextEval: hints.drill,
          });
        }
      } catch {
        return jsonResult({
          ok: false,
          status: "unreadable",
          reason: "learning_distill_memory_unreadable",
          memoryDir,
          action: "Make the memory tree readable, then retry.",
        });
      }

      // Replay = the same (sessionKey, topic) lesson observed more than once in the
      // notes that are actually present, so a repeated lesson is flagged for a
      // repeat of its drill rather than treated as a fresh capture.
      const repeatCounts = new Map<string, number>();
      for (const card of parsedCards) {
        const key = `${card.sessionKey}\u0000${card.topic}`;
        repeatCounts.set(key, (repeatCounts.get(key) ?? 0) + 1);
      }
      for (const card of parsedCards) {
        if ((repeatCounts.get(`${card.sessionKey}\u0000${card.topic}`) ?? 0) >= 2) {
          card.replay = true;
        }
      }

      const priorProcessed = new Map(
        (prior.state?.processed ?? []).map((entry) => [entry.name, entry] as const),
      );
      const pending = parsedCards.filter(
        (card) => card.date >= cutoffDate && !priorProcessed.has(card.name),
      );
      const distilled = pending.length;
      const alreadyProcessed = parsedCards.length - distilled;
      const replay = pending.filter((card) => card.replay).length;
      const summary = {
        keep: distilled,
        replay,
        discard: 0,
        nextEval: [...new Set(pending.map((card) => card.nextEval))],
      };

      const retained = new Map<string, LearningProcessedEntry>(priorProcessed);
      for (const card of pending) {
        retained.set(card.name, { name: card.name, topic: card.topic, distilledAt: nowIso });
      }
      const processed = [...retained.values()].toSorted((a, b) => a.name.localeCompare(b.name));
      const processedPruned = Math.max(0, processed.length - PROCESSED_RETAIN_LIMIT);
      const processedRetained = processed.slice(-PROCESSED_RETAIN_LIMIT);

      const runId = `learning-distill-${Date.now()}-${randomUUID().slice(0, 4)}`;
      const runsDir = path.join(stateDir, LEARNING_WORKFLOW_RUNS_RELATIVE_DIR);
      const runPath = path.join(runsDir, `${runId}.json`);
      const state: LearningWorkflowState = {
        schemaVersion: LEARNING_DISTILL_SCHEMA_VERSION,
        updatedAt: nowIso,
        lastDistilledAt: nowIso,
        scanned,
        pending: distilled,
        distilled,
        alreadyProcessed,
        unparsed,
        cards: pending,
        queue: pending.map((card) => card.name),
        done: processedRetained.map((entry) => entry.name),
        processed: processedRetained,
        processedPruned,
        latestRunPath: runPath,
        summary,
      };
      // Both copies of the surface are atomic; the per-run file is written before
      // the pointer, so a crashed run leaves the prior pointer untouched.
      await writeJsonAtomic(runPath, state);
      await writeJsonAtomic(path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME), state);

      callerSignal?.throwIfAborted();
      return jsonResult({
        ok: true,
        status: distilled > 0 ? "distilled" : "no_pending_learning_items",
        reason: "ok",
        memoryDir,
        stateDir,
        scanned,
        pending: distilled,
        alreadyProcessed,
        unparsed,
        cards: pending,
        replayCount: replay,
        lastDistilledAt: nowIso,
        latestPath: path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME),
        latestRunPath: runPath,
        summary,
        boundary: "research_only-local_learning_distill_only-no_execution_authority",
      });
    },
  };
}

function truncateDateByDays(nowIso: string, days: number): string {
  const at = new Date(nowIso);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}
