import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  foundationTemplateForTopic,
  reviewHintsForTopic,
} from "../../hooks/bundled/learning-review/handler.js";
import { resolveBoundaryPath } from "../../infra/boundary-path.js";
import { readFileWithinRoot, writeFileWithinRoot } from "../../infra/fs-safe.js";
import { assertNoPathAliasEscape } from "../../infra/path-alias-guards.js";
import { isPathInside } from "../../infra/path-guards.js";
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
/** Reader and writer must agree on the maximum durable surface size. */
const WORKFLOW_STATE_MAX_BYTES = 4 * 1024 * 1024;

const LearningDistillSchema = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("distill"), Type.Literal("read")], {
      description: "Default distill; read returns one retained card without any write.",
    }),
  ),
  cardName: Type.Optional(
    Type.String({
      maxLength: 240,
      description: "Exact learning-review filename required for action=read; not a path.",
    }),
  ),
  field: Type.Optional(
    Type.Union(
      [Type.Literal("corePrinciple"), Type.Literal("problem"), Type.Literal("workingAnswer")],
      {
        description:
          "Exact retained field to read, default corePrinciple. Returned excerpts have a named UTF-8 truncation bound.",
      },
    ),
  ),
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
  /** Literal source-session sections, retained evidence rather than validated skills. */
  problem?: string;
  workingAnswer?: string;
  sourceNoteSha256?: string;
  sourceSectionsTruncated?: readonly string[];
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
  /** Bounded durable cards, separate from this run's pending cards. */
  retainedCards?: readonly LearningDistillCard[];
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

function utf8Excerpt(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) {
    return { value, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function sourceSections(content: string) {
  const sections: {
    problem?: string;
    workingAnswer?: string;
    sourceSectionsTruncated?: string[];
    sourceNoteSha256: string;
  } = { sourceNoteSha256: createHash("sha256").update(content).digest("hex") };
  const truncated: string[] = [];
  for (const [title, key] of [
    ["Problem", "problem"],
    ["Working Answer", "workingAnswer"],
  ] as const) {
    const raw = content
      .match(new RegExp(`^## ${title}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"))?.[1]
      ?.trim();
    if (!raw) {
      continue;
    }
    const excerpt = utf8Excerpt(raw, 1024);
    sections[key] = excerpt.value;
    if (excerpt.truncated) {
      truncated.push(key);
    }
  }
  if (truncated.length > 0) {
    sections.sourceSectionsTruncated = truncated;
  }
  return sections;
}

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
      ...sourceSections(content),
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

function isCard(value: unknown): value is LearningDistillCard {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const card = value as Record<string, unknown>;
  return (
    [
      "name",
      "date",
      "sessionKey",
      "sessionId",
      "topic",
      "corePrinciple",
      "mistakePattern",
      "microDrill",
      "transferHint",
      "foundationTemplate",
      "nextEval",
    ].every((key) => typeof card[key] === "string" && card[key].length <= 16384) &&
    typeof card.replay === "boolean" &&
    typeof card.name === "string" &&
    validCardName(card.name) &&
    card.date === card.name.slice(0, 10) &&
    ["problem", "workingAnswer"].every(
      (key) =>
        card[key] === undefined ||
        (typeof card[key] === "string" && Buffer.byteLength(card[key]) <= 1024),
    ) &&
    (card.sourceNoteSha256 === undefined ||
      (typeof card.sourceNoteSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(card.sourceNoteSha256))) &&
    (card.sourceSectionsTruncated === undefined ||
      (Array.isArray(card.sourceSectionsTruncated) &&
        card.sourceSectionsTruncated.every((key) => key === "problem" || key === "workingAnswer")))
  );
}

function validCardName(name: string): boolean {
  return (
    name.length <= 240 &&
    LEARNING_FILE_RE.test(name) &&
    !/[\\/]/u.test(name) &&
    !name.includes(String.fromCharCode(0)) &&
    path.basename(name) === name
  );
}

async function readPriorState(
  stateDir: string,
): Promise<{ state?: LearningWorkflowState; sourceSha256?: string; gap?: LearningDistillGap }> {
  try {
    const { buffer } = await readFileWithinRoot({
      rootDir: stateDir,
      relativePath: LEARNING_WORKFLOW_LATEST_FILENAME,
      maxBytes: WORKFLOW_STATE_MAX_BYTES,
    });
    const parsed = JSON.parse(buffer.toString("utf8")) as Partial<LearningWorkflowState>;
    if (
      parsed === null ||
      parsed.schemaVersion !== LEARNING_DISTILL_SCHEMA_VERSION ||
      typeof parsed.updatedAt !== "string" ||
      parsed.updatedAt.length > 32 ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      !Array.isArray(parsed.processed) ||
      parsed.processed.length > PROCESSED_RETAIN_LIMIT ||
      !parsed.processed.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.name === "string" &&
          validCardName(entry.name) &&
          typeof entry.topic === "string" &&
          typeof entry.distilledAt === "string",
      ) ||
      !Array.isArray(parsed.cards) ||
      !parsed.cards.every(isCard) ||
      (parsed.retainedCards !== undefined &&
        (!Array.isArray(parsed.retainedCards) ||
          parsed.retainedCards.length > PROCESSED_RETAIN_LIMIT ||
          !parsed.retainedCards.every(isCard)))
    ) {
      return {
        gap: { name: LEARNING_WORKFLOW_LATEST_FILENAME, reason: "learning_workflow_state_invalid" },
      };
    }
    return {
      state: parsed as LearningWorkflowState,
      sourceSha256: createHash("sha256").update(buffer).digest("hex"),
    };
  } catch (error) {
    if (["ENOENT", "not-found"].includes((error as NodeJS.ErrnoException).code ?? "")) {
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

/** Resolve aliases under the trusted workspace and keep reads/writes in separate trees. */
async function resolveLearningPath(workspace: string, tree: "memory" | "state", target: string) {
  const root = path.join(workspace, tree);
  if (!isPathInside(root, target)) {
    throw new Error(`learning_distill path must stay inside workspace ${tree}`);
  }
  const resolved = await resolveBoundaryPath({
    rootPath: workspace,
    rootCanonicalPath: workspace,
    absolutePath: target,
    boundaryLabel: `learning_distill ${tree}`,
  });
  if (!isPathInside(root, resolved.canonicalPath)) {
    throw new Error(`learning_distill alias escapes workspace ${tree}`);
  }
  await assertNoPathAliasEscape({
    absolutePath: resolved.canonicalPath,
    rootPath: workspace,
    boundaryLabel: `learning_distill ${tree}`,
  });
  return resolved.canonicalPath;
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
      "Distill pending learning-review notes (written by the learning-review hook) into durable keep cards: topic, core principle, mistake pattern, micro-drill, transfer hint, foundation template, replay flag, and the next-eval drill. Use action=read and an exact cardName (latestRetainedCardName discovers the latest) to read one retained lesson without writes. Choose field=problem or field=workingAnswer for the original session question or method; the default field=corePrinciple is a topic template, not the source-session method. Excerpts report sourceNoteSha256 and named truncation; retention alone is not validation or skill promotion. Read-only over the workspace memory directory; it writes only its own local workflow state under <workspace>/state (learning-workflow). It never edits a review note, never invents a verdict, and reports an absent memory tree as a named failure rather than an empty queue.",
    parameters: LearningDistillSchema,
    execute: async (_toolCallId, args, callerSignal) => {
      callerSignal?.throwIfAborted();
      const params = args as Record<string, unknown>;
      const canonicalWorkspace = await fs.realpath(workspace);
      const resolveDirectory = (tree: "memory" | "state", value: string | undefined) => {
        const candidate = value ? path.resolve(workspace, value) : path.join(workspace, tree);
        // Canonicalize the trusted workspace alias, not model-supplied path aliases.
        const relative = path.relative(workspace, candidate);
        return resolveLearningPath(
          canonicalWorkspace,
          tree,
          path.resolve(canonicalWorkspace, relative),
        );
      };
      const action = readStringParam(params, "action") ?? "distill";
      if (action !== "distill" && action !== "read") {
        return jsonResult({ ok: false, reason: "learning_distill_action_invalid" });
      }
      const stateDir = await resolveDirectory("state", readStringParam(params, "stateDir"));
      const latestPath = path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME);
      if (action === "read") {
        const cardName = readStringParam(params, "cardName");
        if (!cardName || !validCardName(cardName)) {
          return jsonResult({ ok: false, status: "unknown", reason: "learning_card_name_invalid" });
        }
        await resolveLearningPath(canonicalWorkspace, "state", latestPath);
        callerSignal?.throwIfAborted();
        const prior = await readPriorState(stateDir);
        callerSignal?.throwIfAborted();
        if (!prior.state) {
          return jsonResult({
            ok: false,
            status: "unknown",
            cardName,
            reason: prior.gap?.reason ?? "learning_workflow_state_absent",
          });
        }
        const processed = prior.state.processed.some((entry) => entry.name === cardName);
        const card = processed
          ? [...(prior.state.retainedCards ?? []), ...prior.state.cards].find(
              (entry) => entry.name === cardName,
            )
          : undefined;
        if (!card) {
          return jsonResult({
            ok: false,
            status: "unknown",
            cardName,
            reason: "learning_card_not_retained",
            sourceSha256: prior.sourceSha256,
            updatedAt: prior.state.updatedAt,
          });
        }
        const field = readStringParam(params, "field") ?? "corePrinciple";
        if (field !== "corePrinciple" && field !== "problem" && field !== "workingAnswer") {
          return jsonResult({
            ok: false,
            status: "unknown",
            reason: "learning_card_field_invalid",
          });
        }
        const raw = card[field];
        if (raw === undefined) {
          return jsonResult({
            ok: false,
            status: "unknown",
            reason: "learning_card_field_not_retained",
            sourceSha256: prior.sourceSha256,
            updatedAt: prior.state.updatedAt,
          });
        }
        const excerpt = utf8Excerpt(raw, 160);
        return jsonResult({
          ok: true,
          status: "read",
          [field]: excerpt.value,
          cardDate: card.date,
          ...(card.sourceNoteSha256 ? { sourceNoteSha256: card.sourceNoteSha256 } : {}),
          sourceSha256: prior.sourceSha256,
          updatedAt: prior.state.updatedAt,
          truncated: excerpt.truncated || (card.sourceSectionsTruncated?.includes(field) ?? false),
          retained_source_not_validated_skill: true,
        });
      }
      const memoryDir = await resolveDirectory("memory", readStringParam(params, "memoryDir"));
      // Check every output branch before creating either file or its directories.
      await resolveLearningPath(canonicalWorkspace, "state", latestPath);
      await resolveLearningPath(
        canonicalWorkspace,
        "state",
        path.join(stateDir, LEARNING_WORKFLOW_RUNS_RELATIVE_DIR),
      );
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
              content: (
                await readFileWithinRoot({
                  rootDir: memoryDir,
                  relativePath: dirent.name,
                })
              ).buffer.toString("utf8"),
            })),
        );
        // Only learning-review notes participate; other memory notes are ignored.
        const reviewEntries = entries.filter((entry) => LEARNING_FILE_RE.test(entry.name));
        scanned = reviewEntries.length;
        for (const entry of reviewEntries) {
          callerSignal?.throwIfAborted();
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
          const card: LearningDistillCard = {
            ...result.parsed,
            foundationTemplate,
            replay: false,
            nextEval: hints.drill,
          };
          if (!isCard(card)) {
            unparsed.push({ name: entry.name, reason: "learning_distill_card_invalid" });
            continue;
          }
          parsedCards.push(card);
        }
      } catch {
        callerSignal?.throwIfAborted();
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

      // Keep prior cards exactly as distilled; do not re-interpret changed source notes.
      const cardsByName = new Map<string, LearningDistillCard>();
      for (const card of [
        ...(prior.state?.retainedCards ?? []),
        ...(prior.state?.cards ?? []),
        ...pending,
      ]) {
        if (!cardsByName.has(card.name)) {
          cardsByName.set(card.name, card);
        }
      }
      const retainedCards = processedRetained.flatMap((entry) => {
        const card = cardsByName.get(entry.name);
        return card ? [card] : [];
      });

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
        retainedCards,
        queue: pending.map((card) => card.name),
        done: processedRetained.map((entry) => entry.name),
        processed: processedRetained,
        processedPruned,
        latestRunPath: runPath,
        summary,
      };
      // Both copies of the surface are atomic; the per-run file is written before
      // the pointer, so a crashed run leaves the prior pointer untouched.
      const data = `${JSON.stringify(state, null, 2)}\n`;
      if (Buffer.byteLength(data) > WORKFLOW_STATE_MAX_BYTES) {
        callerSignal?.throwIfAborted();
        return jsonResult({
          ok: false,
          status: "not_written",
          reason: "learning_workflow_state_too_large",
          unparsed: [
            ...unparsed,
            {
              name: LEARNING_WORKFLOW_LATEST_FILENAME,
              reason: "learning_workflow_state_too_large",
            },
          ],
          maxBytes: WORKFLOW_STATE_MAX_BYTES,
          serializedBytes: Buffer.byteLength(data),
        });
      }
      for (const target of [runPath, latestPath]) {
        callerSignal?.throwIfAborted();
        const destination = await resolveLearningPath(canonicalWorkspace, "state", target);
        callerSignal?.throwIfAborted();
        await writeFileWithinRoot({
          rootDir: canonicalWorkspace,
          relativePath: path.relative(canonicalWorkspace, destination),
          data,
        });
      }

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
        retainedCardCount: retainedCards.length,
        latestRetainedCardName: retainedCards.at(-1)?.name,
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
