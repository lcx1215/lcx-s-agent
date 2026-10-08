import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { recordAgentArtifact } from "../../src/agents/artifact-result-recording.js";
import {
  boundPerception,
  compactReceipts,
  nextCycleContinuation,
  projectFinancePerceptionEvidence,
  resumableReceipts,
  runCentralHarnessCycle,
} from "../../src/agents/central-harness/harness-loop.js";
import type {
  CentralCycleContinuation,
  CompactBacklogEntry,
} from "../../src/agents/central-harness/harness-loop.js";
import { createCentralBrain } from "../../src/agents/central-harness/model-brain.js";
import type { CentralBrain } from "../../src/agents/central-harness/model-brain.js";
import {
  resolveLatestPointer,
  writeJsonAtomic,
  writeRunSnapshot,
} from "../../src/agents/central-harness/run-store.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import {
  CENTRAL_CAPABILITY_OWNER_IDS,
  CENTRAL_EXCLUDED_WRITE_OWNER_IDS,
  CENTRAL_GOVERNANCE_OWNER_IDS,
} from "../../src/agents/central-harness/tool-registry.js";
import type {
  CentralHostTask,
  CentralPerception,
  CentralRunReceipt,
} from "../../src/agents/central-harness/types.js";
import { buildFinanceAutomaticLifecycleFeedback } from "../../src/agents/finance-automatic-lifecycle-feedback.js";
import { loadConfig } from "../../src/config/io.js";
import { readFileWithinRoot } from "../../src/infra/fs-safe.js";
import {
  backfillOwnerArtifacts,
  type OwnerArtifactBackfillReceipt,
} from "../../src/memory/artifact-owner-backfill.js";
import {
  CENTRAL_AGENT_LATEST_PATH,
  CENTRAL_AGENT_LOG_JSONL_PATH,
  CENTRAL_AGENT_RUNS_DIR,
} from "./lcx-local-paths.ts";

/** Canonical state/log paths live in lcx-local-paths so readers share one contract. */
const STATE_DIR = path.dirname(CENTRAL_AGENT_LATEST_PATH);
const LOG_PATH = CENTRAL_AGENT_LOG_JSONL_PATH;
/** Observable latest snapshot: coverage + the newest receipt, for other readers. */
const LATEST_PATH = CENTRAL_AGENT_LATEST_PATH;
/** One immutable snapshot per cycle, so overlapping runs cannot erase each other. */
const RUNS_DIR = CENTRAL_AGENT_RUNS_DIR;
/** Resume window: how many prior cycles the brain is allowed to see (thread-store tail). */
const RESUME_WINDOW = 40;
const CENTRAL_CAPABILITY_IDS = new Set(CENTRAL_CAPABILITY_OWNER_IDS);

const CLAIMED_BOUNDARIES = [
  "research_only",
  "no_execution_authority",
  "llm_proposes_ts_gate_approves",
];

class ParseError extends Error {}

/** An evidence write that failed. Named, never swallowed, never fatal. */
type EvidenceWriteFailure = Readonly<{ target: string; reason: string }>;

function parseArgs(args: string[]): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {
    durationMinutes: 2,
    dryRun: false,
    planOnly: false,
    maxCycles: 5,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--duration-minutes") {
      out.durationMinutes = Number(args[i + 1]);
      i += 1;
    } else if (arg === "--max-cycles") {
      out.maxCycles = Number(args[i + 1]);
      i += 1;
    } else if (arg === "--governance-input") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new ParseError("--governance-input requires a path");
      }
      out.governanceInput = value;
    } else if (arg === "--objective" || arg === "--focus") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--") || !value.trim()) {
        throw new ParseError(`${arg} requires a value`);
      }
      out[arg === "--objective" ? "objective" : "focus"] = value.trim();
      i += 1;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--plan-only") {
      // Gate and record the decision; never spawn the owners. Used by the
      // Hourly governance owner so the pass stays one brain call wide; owners are
      // recorded-and-not-run (the autopilot runs them in parallel), while
      // capability steps still dispatch because nothing else covers them.
      out.planOnly = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new ParseError(
        "Usage: node --import tsx scripts/operator/lcx-central-agent.ts [--duration-minutes N] [--max-cycles N] [--plan-only] [--dry-run] [--json] [--objective TEXT] [--focus general|finance] [--governance-input PATH]",
      );
    } else {
      throw new ParseError(`unknown argument: ${arg}`);
    }
  }
  if (
    !Number.isFinite(out.durationMinutes) ||
    Number(out.durationMinutes) <= 0 ||
    Number(out.durationMinutes) > 60 ||
    !Number.isSafeInteger(out.maxCycles) ||
    Number(out.maxCycles) < 1 ||
    Number(out.maxCycles) > 100
  ) {
    throw new ParseError("duration must be finite in (0, 60] minutes; max cycles must be 1..100");
  }
  if (out.focus !== undefined && out.focus !== "general" && out.focus !== "finance") {
    throw new ParseError("focus must be general or finance");
  }
  if (out.focus !== undefined && out.objective === undefined) {
    throw new ParseError("focus requires an objective");
  }
  if (typeof out.objective === "string" && Buffer.byteLength(out.objective, "utf8") > 2048) {
    throw new ParseError("objective must be at most 2048 UTF8 bytes");
  }
  return out;
}

type SnapshotReadFailure = "missing" | "read_failed" | "invalid_json" | "invalid_shape";

async function readLatest<T>(
  name: string,
  fallback: T,
  onUnavailable?: (status: SnapshotReadFailure) => void,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(STATE_DIR, name), "utf8");
  } catch (error) {
    const missing = isRecord(error) && error.code === "ENOENT";
    onUnavailable?.(missing ? "missing" : "read_failed");
    return fallback;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    onUnavailable?.("invalid_json");
    return fallback;
  }
  if (!isRecord(value)) {
    onUnavailable?.("invalid_shape");
    return fallback;
  }
  return value as T;
}

/** Accept the original completed-owner handoff, never a fabricated final verdict. */
export async function readCentralGovernanceInput(
  inputPath: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const resolved = path.resolve(inputPath);
    const { buffer } = await readFileWithinRoot({
      rootDir: path.dirname(resolved),
      relativePath: path.basename(resolved),
      maxBytes: 512 * 1024,
    });
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== "lcx_central_governance_input_v1" ||
      value.boundary !== "same_cycle_completed_owners_only" ||
      value.phase !== "before_central_decision" ||
      typeof value.parentRunId !== "string" ||
      !value.parentRunId.trim() ||
      typeof value.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      !isRecord(value.snapshot) ||
      value.snapshot.authorityOwner !== "lcx-governance-autopilot" ||
      typeof value.snapshot.snapshotId !== "string" ||
      !value.snapshot.snapshotId ||
      typeof value.snapshot.observedAt !== "string" ||
      !Number.isFinite(Date.parse(value.snapshot.observedAt)) ||
      typeof value.snapshot.sourceCommit !== "string" ||
      !value.snapshot.sourceCommit ||
      Date.parse(value.checkedAt) < Date.parse(value.snapshot.observedAt) ||
      !isRecord(value.byOwner) ||
      Object.hasOwn(value.byOwner, "centralAgent") ||
      Object.keys(value.byOwner).length === 0 ||
      Object.keys(value.byOwner).length > 64
    ) {
      throw new Error("invalid handoff");
    }
    const owners: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const [id, owner] of Object.entries(value.byOwner)) {
      if (
        !isRecord(owner) ||
        owner.id !== id ||
        !isRecord(owner.compact) ||
        !isRecord(owner.runReceipt) ||
        owner.runReceipt.owner !== id ||
        owner.runReceipt.parentRunId !== value.parentRunId ||
        !isRecord(owner.runReceipt.snapshot) ||
        owner.runReceipt.snapshot.snapshotId !== value.snapshot.snapshotId ||
        owner.runReceipt.snapshot.sourceCommit !== value.snapshot.sourceCommit ||
        owner.runReceipt.snapshot.observedAt !== value.snapshot.observedAt ||
        typeof owner.runReceipt.checkedAt !== "string" ||
        !Number.isFinite(Date.parse(owner.runReceipt.checkedAt))
      ) {
        throw new Error("invalid owner binding");
      }
      owners[id] = owner.compact;
      if (owner.runReceipt.status === "failed" || owner.runReceipt.status === "blocked") {
        failures.push(id);
      }
    }
    return {
      ...value,
      sourceSha256: createHash("sha256").update(buffer).digest("hex"),
      owners,
      summary: { structuralOwnerFailures: failures },
    };
  } catch {
    // Explicit handoff failure must not silently revert to the previous cycle.
    throw new ParseError("central_governance_input_unavailable_or_invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extractOwnerTotals(state: Record<string, unknown>): Record<string, unknown> {
  const byOwner = isRecord(state.byOwner)
    ? state.byOwner
    : Object.fromEntries(
        (Array.isArray(state.ownerCommands) ? state.ownerCommands : [])
          .filter(
            (owner): owner is Record<string, unknown> =>
              isRecord(owner) && typeof owner.id === "string",
          )
          .map((owner) => [String(owner.id), owner]),
      );
  const totals: Record<string, unknown> = {};
  for (const [ownerId, run] of Object.entries(byOwner)) {
    if (!isRecord(run)) {
      continue;
    }
    const compact = isRecord(run.compact)
      ? run.compact
      : isRecord(state.owners) && isRecord(state.owners[ownerId])
        ? state.owners[ownerId]
        : {};
    totals[ownerId] = {
      ok: run.ok,
      status: isRecord(run.runReceipt) ? run.runReceipt.status : undefined,
      ...(compact.ok !== undefined ? { compactOk: compact.ok } : {}),
    };
  }
  return totals;
}

export async function buildPerception(
  backlog: readonly CompactBacklogEntry[],
  task?: CentralHostTask,
  governanceInput?: Readonly<Record<string, unknown>>,
): Promise<CentralPerception> {
  // A failed read is an evidence gap, not an empty/healthy system. Keep only
  // bounded status codes; source contents and filesystem error text stay out.
  const snapshotReadFailures: Record<string, SnapshotReadFailure> = {};
  const onUnavailable = (source: string) => (status: SnapshotReadFailure) => {
    snapshotReadFailures[source] = status;
  };
  const controlRoom = await readLatest<Record<string, unknown>>(
    "lcx-control-room-latest.json",
    {},
    onUnavailable("controlRoom"),
  );
  const governance =
    governanceInput ??
    (await readLatest<Record<string, unknown>>(
      "lcx-governance-autopilot-latest.json",
      {},
      onUnavailable("governance"),
    ));
  const learningWorkflow = await readLatest<Record<string, unknown>>(
    "lcx-learning-workflow-latest.json",
    {},
    onUnavailable("learningWorkflow"),
  );
  const observedAt = new Date().toISOString();
  const financeAutomaticLifecycle =
    task?.focus === "general"
      ? undefined
      : await buildFinanceAutomaticLifecycleFeedback({ observedAt });
  const controlRoomProjection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(controlRoom)) {
    if (key !== "financeAutomaticLifecycle") {
      controlRoomProjection[key] = value;
    }
  }
  const ownerTotals = extractOwnerTotals(governance);
  return {
    observedAt,
    ...(task ? { task } : {}),
    ownerTotals,
    // The learning-workflow and governance surfaces ride in the flexible
    // control-room section so the existing byte budget bounds them like any other
    // control-room key and names whatever does not fit. Both projections are
    // deliberately small (counts + verdicts); the full surfaces stay on disk under
    // the latest pointers.
    controlRoom: {
      // Prioritize finance's actionable state within the bounded control-room section.
      ...(financeAutomaticLifecycle ? { financeAutomaticLifecycle } : {}),
      ...controlRoomProjection,
      runtimeFreshness: {
        ...projectRuntimeFreshness({ controlRoom, governance, learningWorkflow }, observedAt),
        ...(Object.keys(snapshotReadFailures).length > 0 ? { snapshotReadFailures } : {}),
        ...(governanceInput
          ? {
              sourceBoundary: "same_cycle_owners_and_published_other_snapshots",
              governanceInput: {
                parentRunId: governanceInput.parentRunId,
                snapshotId: isRecord(governanceInput.snapshot)
                  ? governanceInput.snapshot.snapshotId
                  : null,
                sourceSha256: governanceInput.sourceSha256,
                phase: governanceInput.phase,
                ownerCount: isRecord(governanceInput.byOwner)
                  ? Object.keys(governanceInput.byOwner).length
                  : 0,
              },
            }
          : {}),
      },
      ...(learningWorkflow && typeof learningWorkflow === "object"
        ? { learningWorkflow: projectLearningWorkflow(learningWorkflow) }
        : {}),
      // Without the digest the hour's own governance verdict (cycle status, next
      // action, release gate, structural owner failures) never reaches the brain:
      // the raw `/governance` section of the control room is 190KB and always gets
      // dropped by name. The digest is the same small-surface pattern as
      // learningWorkflow, so the budget keeps it while naming the raw key.
      ...(isPresentObject(governance)
        ? { governanceDigest: projectGovernanceDigest(governance) }
        : {}),
    },
    backlog,
    boundaries: CLAIMED_BOUNDARIES,
  };
}

function isPresentObject(state: Readonly<Record<string, unknown>>): boolean {
  return state !== null && typeof state === "object" && Object.keys(state).length > 0;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.slice(0, maxLength) : null;
}

/**
 * The hour's governance verdict, bounded to a couple of hundred bytes so the
 * brain can act on it without paying for the 190KB raw section. Every verdict
 * here is a projection of the *stored* latest state; a missing surface reports
 * itself by name instead of pretending the system passed.
 */
export function projectGovernanceDigest(
  state: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isPresentObject(state)) {
    return { status: "unavailable", reason: "governance_state_missing" };
  }
  const receipt =
    state.runReceipt !== null && typeof state.runReceipt === "object"
      ? (state.runReceipt as Record<string, unknown>)
      : {};
  const summary =
    state.summary !== null && typeof state.summary === "object"
      ? (state.summary as Record<string, unknown>)
      : {};
  const shadow =
    state.multiAgentPatternShadow !== null && typeof state.multiAgentPatternShadow === "object"
      ? (state.multiAgentPatternShadow as Record<string, unknown>)
      : {};
  const reader =
    state.globalEvidenceProjectionReader !== null &&
    typeof state.globalEvidenceProjectionReader === "object"
      ? (state.globalEvidenceProjectionReader as Record<string, unknown>)
      : {};
  const listSlice = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.slice(0, 80))
          .slice(0, 6)
      : [];
  const beforeDecision = state.phase === "before_central_decision";
  const digest: Record<string, unknown> = {
    status: beforeDecision ? "pre_decision" : "present",
    ok: state.ok === true,
    checkedAt: boundedString(state.checkedAt, 40),
    cycleStatus: boundedString(receipt.status, 40),
    nextAction: boundedString(receipt.nextAction, 180),
    releaseBlocked: summary.releaseBlocked === true,
    ownerFailures: listSlice(summary.structuralOwnerFailures),
    failedGates: listSlice(summary.failedGates),
    blockedGates: listSlice(summary.blockedGates),
    shadow: {
      experimentId: boundedString(shadow.experimentId, 60),
      trialDecision: boundedString(shadow.trialDecision, 60),
      completion: boundedString(shadow.completedAt, 40),
    },
    projectionReader: {
      adapterId: boundedString(reader.adapterId, 60),
      readStatus: boundedString(reader.readStatus, 40),
      blocked: reader.blocked === true,
    },
  };
  if (beforeDecision) {
    delete digest.ok;
    delete digest.releaseBlocked;
    digest.cycleStatus = "pending_central_decision";
    digest.nextAction = "decide_from_completed_owner_observations";
    digest.complete = false;
    digest.pendingOwners = ["centralAgent"];
    digest.parentRunId = boundedString(state.parentRunId, 160);
    digest.sourceSha256 = boundedString(state.sourceSha256, 64);
    digest.sourceBoundary = "same_cycle_completed_owners_only";
  }
  const owners = isPresentObject(state.owners as Record<string, unknown>)
    ? (state.owners as Record<string, unknown>)
    : {};
  const failures = new Set(listSlice(summary.structuralOwnerFailures));
  const entries = Object.entries(owners).toSorted(
    ([a], [b]) => Number(failures.has(b)) - Number(failures.has(a)),
  );
  const results: Record<string, unknown>[] = [];
  let candidates = 0;
  for (const [ownerId, value] of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value) || ownerId.length > 80) {
      continue;
    }
    const owner = value as Record<string, unknown>;
    const evidence = owner.artifactEvidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      continue;
    }
    const ref = evidence as Record<string, unknown>;
    if (!["registered", "unchanged", "unavailable"].includes(String(ref.status))) {
      continue;
    }
    candidates += 1;
    const result: Record<string, unknown> = {
      ownerId,
      status: ref.status,
      sourceObservedAt: boundedString(owner.sourceObservedAt, 40),
      sourceTimeBasis: boundedString(ref.sourceTimeBasis, 40),
    };
    if (
      ref.status !== "unavailable" &&
      typeof ref.id === "string" &&
      /^artifact-[a-f0-9]{64}$/u.test(ref.id) &&
      typeof ref.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(ref.sha256)
    ) {
      result.artifactId = ref.id;
      result.sourceSha256 = ref.sha256;
    } else {
      result.status = "unavailable";
      result.reason = boundedString(ref.reason, 100) ?? "owner_artifact_binding_missing";
    }
    const candidate = {
      ...digest,
      ownerResults: [...results, result],
      ownerResultsOmitted: entries.length,
    };
    if (results.length < 4 && Buffer.byteLength(JSON.stringify(candidate)) <= 2048) {
      results.push(result);
    }
  }
  if (candidates > 0) {
    digest.ownerResults = results;
    digest.ownerResultsOmitted = candidates - results.length;
  }
  return digest;
}

/**
 * Reports the age of persisted runtime snapshots at perception time. This is
 * evidence only: no TTL is configured here, and in-flight owner state is not read.
 */
export function projectRuntimeFreshness(
  snapshots: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  measuredAt: string,
): Readonly<Record<string, unknown>> {
  const measuredAtMs = Date.parse(measuredAt);
  const sources = Object.fromEntries(
    Object.entries(snapshots).map(([name, snapshot]) => {
      if (!snapshot || Object.keys(snapshot).length === 0) {
        return [name, { status: "snapshot_missing", sourceObservedAt: null, ageMs: null }];
      }
      const timestamp = ["checkedAt", "generatedAt", "updatedAt", "observedAt"]
        .map((key) => snapshot[key])
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (!timestamp) {
        return [name, { status: "timestamp_missing", sourceObservedAt: null, ageMs: null }];
      }
      const sourceObservedAtMs = Date.parse(timestamp);
      if (!Number.isFinite(sourceObservedAtMs)) {
        return [name, { status: "timestamp_invalid", sourceObservedAt: timestamp, ageMs: null }];
      }
      if (!Number.isFinite(measuredAtMs)) {
        return [
          name,
          { status: "measurement_time_invalid", sourceObservedAt: timestamp, ageMs: null },
        ];
      }
      const ageMs = measuredAtMs - sourceObservedAtMs;
      return [
        name,
        {
          status: ageMs < 0 ? "clock_skew" : "measured_age",
          sourceObservedAt: timestamp,
          ageMs,
        },
      ];
    }),
  );
  return {
    measuredAt,
    sourceBoundary: "published_latest_snapshots_only",
    freshnessPolicy: "age_reported_no_cutoff",
    sources,
  };
}

/**
 * The brain only needs to know whether the learning workflow has work and how
 * much; the cards themselves stay on disk. When the surface is absent the
 * projection says so by name instead of pretending the queue is empty.
 */
function projectLearningWorkflow(
  state: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (state.schemaVersion !== "lcx_learning_workflow_v1") {
    return { status: "unavailable", reason: "learning_workflow_unknown_schema" };
  }
  const summary =
    state.summary !== null && typeof state.summary === "object"
      ? (state.summary as Record<string, unknown>)
      : {};
  const processed = Array.isArray(state.processed)
    ? {
        count: state.processed.length,
        // Processed entries are name-sorted, so the tail is the newest note.
        latestName: String(state.processed[state.processed.length - 1]?.name ?? ""),
      }
    : { count: 0 };
  return {
    status: "present",
    lastDistilledAt: state.lastDistilledAt ?? null,
    scanned: state.scanned ?? null,
    pending: state.pending ?? null,
    // Bounded first five names so a long queue cannot spend the vote alone.
    queue: Array.isArray(state.queue) ? state.queue.slice(0, 5) : [],
    summary,
    processed,
    latestRunPath: typeof state.latestRunPath === "string" ? state.latestRunPath : null,
  };
}

/** Thread-store: read the persisted JSONL tail so a restart resumes prior decisions. */
/** A different explicit objective is a different decision context, not inherited evidence. */
export function receiptsForHostTask(
  receipts: readonly CentralRunReceipt[],
  task?: CentralHostTask,
): CentralRunReceipt[] {
  return receipts.filter((receipt) =>
    task
      ? receipt.task?.objective === task.objective && receipt.task?.focus === task.focus
      : receipt.task === undefined,
  );
}

type CentralResumeRead = Readonly<{
  receipts: readonly CentralRunReceipt[];
  scannedRows: number;
  invalidRows: number;
  droppedNonDecisionCycles: number;
  skippedOtherTaskCycles: number;
}>;

function isResumeReceipt(value: unknown): value is CentralRunReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "lcx_central_agent_v1" ||
    typeof value.runId !== "string" ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.nextAction !== "string" ||
    !isRecord(value.brainCall) ||
    typeof value.brainCall.outcome !== "string" ||
    !["completed", "failed", "blocked", "skipped"].includes(value.brainCall.outcome) ||
    !Array.isArray(value.steps)
  ) {
    return false;
  }
  if (
    value.task !== undefined &&
    (!isRecord(value.task) ||
      typeof value.task.objective !== "string" ||
      typeof value.task.focus !== "string" ||
      !["general", "finance"].includes(value.task.focus))
  ) {
    return false;
  }
  return value.steps.every(
    (step: unknown) =>
      isRecord(step) &&
      typeof step.ownerId === "string" &&
      isRecord(step.args) &&
      typeof step.status === "string" &&
      ["approved", "blocked_by_gate", "ran_ok", "ran_failed", "skipped"].includes(step.status) &&
      (step.outcome === undefined || isRecord(step.outcome)) &&
      (step.gateReason === undefined || typeof step.gateReason === "string") &&
      (step.failureReason === undefined || typeof step.failureReason === "string") &&
      (step.outcomeDroppedKeys === undefined ||
        (Array.isArray(step.outcomeDroppedKeys) &&
          step.outcomeDroppedKeys.every((key: unknown) => typeof key === "string"))),
  );
}

/** Failures and other tasks remain audit evidence but cannot spend this task's resume window. */
export function selectPersistedReceipts(raw: string, task?: CentralHostTask): CentralResumeRead {
  const receipts: CentralRunReceipt[] = [];
  let scannedRows = 0;
  let invalidRows = 0;
  let droppedNonDecisionCycles = 0;
  let skippedOtherTaskCycles = 0;
  for (const line of raw.split("\n").toReversed()) {
    if (!line.trim()) {
      continue;
    }
    scannedRows += 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidRows += 1;
      continue;
    }
    if (!isResumeReceipt(value)) {
      invalidRows += 1;
      continue;
    }
    if (value.brainCall.outcome !== "completed") {
      droppedNonDecisionCycles += 1;
      continue;
    }
    if (receiptsForHostTask([value], task).length === 0) {
      skippedOtherTaskCycles += 1;
      continue;
    }
    receipts.push(value);
    if (receipts.length === RESUME_WINDOW) {
      break;
    }
  }
  return {
    receipts: receipts.toReversed(),
    scannedRows,
    invalidRows,
    droppedNonDecisionCycles,
    skippedOtherTaskCycles,
  };
}

async function loadPersistedReceipts(task?: CentralHostTask): Promise<CentralResumeRead> {
  try {
    return selectPersistedReceipts(await fs.readFile(LOG_PATH, "utf8"), task);
  } catch {
    return selectPersistedReceipts("", task);
  }
}

/** Declared reach: what the harness can actually drive, so "whole system" is checkable. */
function centralCoverage() {
  return {
    governanceOwners: CENTRAL_GOVERNANCE_OWNER_IDS.length,
    capabilities: CENTRAL_CAPABILITY_OWNER_IDS.length,
    excludedWriteOwners: [...CENTRAL_EXCLUDED_WRITE_OWNER_IDS],
    boundary: "read_only_owners_plus_planning_only_capabilities",
  };
}

/** Capabilities this invocation actually dispatched (ran and returned a receipt). */
function dispatchedCapabilities(
  receipt: CentralRunReceipt | undefined,
  capabilityIds: ReadonlySet<string>,
): string[] {
  if (!receipt) {
    return [];
  }
  return receipt.steps
    .filter((step) => step.status === "ran_ok" && capabilityIds.has(step.ownerId))
    .map((step) => step.ownerId);
}

/**
 * Honest fallback receipt for a cycle that threw before it could settle. The
 * owner surface must stay parseable, so a failure is reported as a receipt
 * rather than as a crashed process with no output.
 */
function failedCycleReceipt(
  perception: CentralPerception,
  index: number,
  error: unknown,
  perceptionBuildMs: number,
): CentralRunReceipt {
  const bounded = boundPerception(perception);
  return {
    schemaVersion: "lcx_central_agent_v1",
    runId: `central-${index}-${Date.now()}-failed`,
    observedAt: perception.observedAt,
    ...(perception.task ? { task: perception.task } : {}),
    actionsProposed: 0,
    actionsApproved: 0,
    actionsBlockedByGate: 0,
    steps: [],
    boundaries: perception.boundaries,
    brainCall: {
      provider: "",
      modelId: "",
      outcome: "failed",
      reason: `cycle failed: ${String(error).slice(0, 300)}`,
    },
    nextAction: "halt_and_report",
    // The cycle threw, so nothing reached the brain; this records the budget that
    // was in force rather than claiming an injection happened. The receipt's own
    // brainCall.outcome is what tells a reader no injection occurred.
    contextBudget: bounded.report,
    ...(perception.task?.focus === "general"
      ? {}
      : { financePerception: projectFinancePerceptionEvidence(bounded) }),
    stageDurationsMs: {
      perceptionBuildMs,
      brainProposalMs: null,
      deterministicGateMs: null,
      actionDispatchMs: null,
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

/** Latest observable snapshot: coverage plus the newest cycle receipt. */
async function writeLatest(
  receipt: CentralRunReceipt | undefined,
  runs: number,
  meta: {
    dryRun: boolean;
    planOnly: boolean;
    runSnapshotPath?: string;
    droppedNonDecisionCycles: number;
    resumeScan: Readonly<Record<string, unknown>>;
    evidenceWriteFailures: readonly EvidenceWriteFailure[];
    capabilityDrain: readonly string[];
    receiptPersistenceDurationMs: number | null;
    continuation?: CentralCycleContinuation;
    artifactBackfill?: OwnerArtifactBackfillReceipt;
    artifactBackfillDeferredReason: string | null;
  },
): Promise<void> {
  // The pointer is resolved against what is already on disk, so a run that observed
  // earlier than the snapshot it finds does not move the pointer backwards.
  const previous = await readLatest<{
    latestReceipt?: unknown;
    latestRunPath?: unknown;
  }>(path.basename(LATEST_PATH), {});
  const pointer = resolveLatestPointer(previous, receipt, meta.runSnapshotPath);
  await writeJsonAtomic(LATEST_PATH, {
    schemaVersion: "lcx_central_agent_latest_v1",
    boundary: "local_central_agent_observe_only",
    updatedAt: new Date().toISOString(),
    runs,
    dryRun: meta.dryRun,
    planOnly: meta.planOnly,
    dispatchMode: meta.planOnly
      ? "gate_record_owners_plus_dispatch_capabilities"
      : "gate_record_and_dispatch",
    /** Capabilities that actually ran this invocation (nothing else covers them). */
    capabilityDrain: meta.capabilityDrain,
    coverage: centralCoverage(),
    latestReceipt: pointer.heldReceipt,
    /** How to walk back from the pointer to any individual cycle's full receipt. */
    latestRunId: pointer.heldRunId,
    latestRunPath: pointer.heldRunPath,
    runsDir: RUNS_DIR,
    /** Set when a concurrent run that observed later already owns the pointer. */
    supersededThisRun: pointer.superseded && receipt ? receipt.runId : null,
    /** Resume-window honesty: cycles dropped because they produced no decision. */
    resumeDroppedNonDecisionCycles: meta.droppedNonDecisionCycles,
    resumeScan: meta.resumeScan,
    /** Why this invocation stopped, from the TypeScript-authored receipt verdict. */
    continuation: meta.continuation ?? null,
    /** Byte budget actually applied to the brain's perception this cycle. */
    contextBudget: receipt?.contextBudget ?? null,
    /** JSONL append plus immutable per-cycle snapshot; excludes this latest pointer write. */
    lastReceiptPersistenceDurationMs: meta.receiptPersistenceDurationMs,
    /** Evidence-write honesty: a completed cycle whose record could not be persisted. */
    evidenceComplete: meta.evidenceWriteFailures.length === 0,
    evidenceWriteFailures: meta.evidenceWriteFailures,
    artifactBackfill: meta.artifactBackfill,
    artifactBackfillDeferredReason: meta.artifactBackfillDeferredReason,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  });
}

async function settle(receipt: unknown): Promise<void> {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  const handle = await fs.open(LOG_PATH, "a");
  try {
    await handle.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const task: CentralHostTask | undefined =
    typeof options.objective === "string"
      ? {
          objective: options.objective,
          focus: options.focus === "finance" ? "finance" : "general",
        }
      : undefined;
  const durationMinutes = Number(options.durationMinutes);
  const dryRun = options.dryRun === true;
  const planOnly = options.planOnly === true;
  const maxCycles = Number(options.maxCycles);
  const governanceInput =
    typeof options.governanceInput === "string"
      ? await readCentralGovernanceInput(options.governanceInput)
      : undefined;
  const config = loadConfig();
  const workspaceDir = path.dirname(STATE_DIR);
  const registry = createCentralToolRegistry({ config, workspaceDir });
  const brain: CentralBrain = dryRun
    ? {
        propose: async () => ({ kind: "blocked_no_provider" as const, reason: "dry_run_no_llm" }),
      }
    : createCentralBrain(config, { tools: [...registry.values()], maxTokens: 8_192 });

  const deadline = Date.now() + durationMinutes * 60_000;
  let runs = 0;
  let lastReceipt: CentralRunReceipt | undefined;
  let lastRunSnapshotPath: string | undefined;
  let lastReceiptPersistenceDurationMs: number | null = null;
  let droppedNonDecisionCycles = 0;
  let lastContinuation: CentralCycleContinuation | undefined;
  /**
   * Evidence writes are fail-open, the same way the codex harness treats its audit
   * trail: an unwritable log must not turn a completed cycle into an unparseable
   * failure. Verified by fault injection before this guard existed — with the jsonl
   * path unwritable the process exited 1 with 0 bytes on stdout, so the owner saw
   * `ran_failed` and the whole cycle's receipt was gone. Every failure is named in
   * the summary instead, so the loss stays visible.
   */
  const evidenceWriteFailures: EvidenceWriteFailure[] = [];
  const recordEvidenceFailure = (target: string, error: unknown): void => {
    evidenceWriteFailures.push({ target, reason: String(error).slice(0, 300) });
  };
  // Recovery indexing must not consume the first decision's time budget.
  let artifactBackfill: OwnerArtifactBackfillReceipt | undefined;
  let artifactBackfillDeferredReason: string | null = dryRun
    ? "dry_run_no_recovery"
    : "no_persisted_cycle";
  // thread-store resume: recover prior cycles so the brain inherits context.
  const loadedResume = await loadPersistedReceipts(task);
  droppedNonDecisionCycles = loadedResume.droppedNonDecisionCycles;
  const resumeScan = {
    scope: "physical_log_suffix_until_40_matching_completed_receipts",
    window: RESUME_WINDOW,
    scannedRows: loadedResume.scannedRows,
    invalidRows: loadedResume.invalidRows,
    skippedOtherTaskCycles: loadedResume.skippedOtherTaskCycles,
  };
  let history = [...loadedResume.receipts];
  while (Date.now() < deadline && runs < maxCycles) {
    // context compaction: only the compacted tail reaches the brain, never raw history.
    // Terminal cycles are dropped first: a cycle whose brain call did not complete
    // carries no decision, so inheriting it would let an outage read as precedent.
    const completed = resumableReceipts(history);
    droppedNonDecisionCycles =
      loadedResume.droppedNonDecisionCycles + history.length - completed.length;
    const resumable = receiptsForHostTask(completed, task);
    const perceptionBuildStartedAt = performance.now();
    const perception = await buildPerception(
      compactReceipts(resumable, 10, CENTRAL_CAPABILITY_IDS),
      task,
      governanceInput,
    );
    const perceptionBuildMs = Math.max(0, Math.round(performance.now() - perceptionBuildStartedAt));
    let receipt: CentralRunReceipt;
    try {
      receipt = await runCentralHarnessCycle({
        perception,
        deadlineMs: deadline,
        brain,
        registry,
        planOnly,
        // In the hourly (plan-only) pass the autopilot already runs the owners in
        // parallel, so only capability steps dispatch: they have no autopilot
        // equivalent and would otherwise never drain (learning workflow, ledger
        // reads, research plans).
        capabilityOwnerIds: CENTRAL_CAPABILITY_IDS,
        perceptionBuildDurationMs: perceptionBuildMs,
        runId: `central-${runs}-${Date.now()}`,
      });
    } catch (error) {
      // Never exit without a receipt: the owner surface stays parseable even when
      // perception or dispatch fails mid-cycle.
      receipt = failedCycleReceipt(perception, runs, error, perceptionBuildMs);
    }
    const receiptPersistenceStartedAt = performance.now();
    let cyclePersisted = false;
    try {
      await settle(receipt);
      cyclePersisted = true;
    } catch (error) {
      recordEvidenceFailure("jsonl", error);
    }
    try {
      lastRunSnapshotPath = await writeRunSnapshot(RUNS_DIR, receipt);
      const indexed = await recordAgentArtifact({
        config,
        agentId: "main",
        workspaceDir,
        owner: "central_harness",
        runId: receipt.runId,
        observedAt: receipt.observedAt,
        value: receipt,
        sourceReceiptRefs: [lastRunSnapshotPath],
      });
      if (indexed.status === "unavailable") {
        recordEvidenceFailure("artifact_index", new Error(indexed.reason));
      }
    } catch (error) {
      // The per-cycle snapshot is an extra copy of a receipt that is already in the
      // jsonl. Losing it must not cost the invocation its summary, so this stays
      // best-effort and the pointer simply records no run path.
      recordEvidenceFailure("run_snapshot", error);
      lastRunSnapshotPath = undefined;
    }
    lastReceiptPersistenceDurationMs = Math.max(
      0,
      Math.round(performance.now() - receiptPersistenceStartedAt),
    );
    lastReceipt = receipt;
    history = history.concat(receipt).slice(-200);
    runs += 1;
    lastContinuation = nextCycleContinuation(receipt, runs, maxCycles, resumable.at(-1));
    if (!artifactBackfill && cyclePersisted && !dryRun && Date.now() >= deadline) {
      artifactBackfillDeferredReason = "run_deadline_exhausted";
    }
    if (!artifactBackfill && cyclePersisted && !dryRun && Date.now() < deadline) {
      artifactBackfillDeferredReason = null;
      artifactBackfill = await backfillOwnerArtifacts({
        config,
        agentId: "main",
        workspaceDir,
        deadlineMs: deadline,
      });
      if (artifactBackfill.status !== "complete") {
        recordEvidenceFailure(
          "artifact_backfill",
          new Error(
            `status=${artifactBackfill.status}; gaps=${artifactBackfill.gapCount}; truncated=${artifactBackfill.truncated}`,
          ),
        );
      }
    }
    if (dryRun || !lastContinuation.run) {
      break;
    }
    // Bounded pacing: at least a short pause between cycles to stay idle-friendly.
    const pauseMs = Math.min(5000, deadline - Date.now());
    if (pauseMs <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  // Always publish the observable snapshot, even on a zero-cycle run, so readers
  // never see a stale or absent central-agent surface.
  try {
    await writeLatest(lastReceipt, runs, {
      dryRun,
      planOnly,
      ...(lastRunSnapshotPath !== undefined ? { runSnapshotPath: lastRunSnapshotPath } : {}),
      droppedNonDecisionCycles,
      resumeScan,
      evidenceWriteFailures,
      artifactBackfill,
      artifactBackfillDeferredReason,
      capabilityDrain: dispatchedCapabilities(lastReceipt, CENTRAL_CAPABILITY_IDS),
      receiptPersistenceDurationMs: lastReceiptPersistenceDurationMs,
      ...(lastContinuation ? { continuation: lastContinuation } : {}),
    });
  } catch (error) {
    // stdout is the last surface standing: the summary below still has to print.
    recordEvidenceFailure("latest_pointer", error);
  }
  const brainOutcome = lastReceipt?.brainCall.outcome ?? null;
  const summary = {
    ok: runs > 0,
    boundary: "local_central_agent_observe_only",
    runs,
    dryRun,
    planOnly,
    dispatchMode: planOnly
      ? "gate_record_owners_plus_dispatch_capabilities"
      : "gate_record_and_dispatch",
    /** Capabilities that actually ran this invocation (nothing else covers them). */
    capabilityDrain: dispatchedCapabilities(lastReceipt, new Set(CENTRAL_CAPABILITY_OWNER_IDS)),
    maxCycles: Number.isFinite(maxCycles) ? maxCycles : null,
    latestPath: LATEST_PATH,
    registryTools: registry.size,
    coverage: centralCoverage(),
    brainOutcome,
    brainAvailable: brainOutcome === "completed",
    brainReason: lastReceipt?.brainCall.reason ?? null,
    actionsProposed: lastReceipt?.actionsProposed ?? 0,
    actionsApproved: lastReceipt?.actionsApproved ?? 0,
    actionsBlockedByGate: lastReceipt?.actionsBlockedByGate ?? 0,
    approvedOwners:
      lastReceipt?.steps
        .filter((step) => step.status === "approved" || step.status === "ran_ok")
        .map((step) => step.ownerId) ?? [],
    /** Owners that ran and whose own receipt reported not-ok (a real red light). */
    ownersReportingNotOk:
      lastReceipt?.steps.filter((step) => step.observedOk === false).map((step) => step.ownerId) ??
      [],
    /** Owners the harness could not run at all, with the reason it recorded. */
    failedSteps:
      lastReceipt?.steps
        .filter((step) => step.status === "ran_failed")
        .map((step) => ({
          ownerId: step.ownerId,
          reason: step.failureReason ?? "no failure reason recorded",
        })) ?? [],
    /** TypeScript-computed next step; never model-authored. */
    nextAction: lastReceipt?.nextAction ?? null,
    /** Why the loop stopped; null when the invocation completed zero cycles. */
    continuation: lastContinuation ?? null,
    /** The brain's own one-line rationale, so readers see *why*, not just *what*. */
    brainNote: lastReceipt?.brainCall.note ?? null,
    /** Where this invocation's own cycle receipt was written, for direct reading. */
    latestRunPath: lastRunSnapshotPath ?? null,
    runsDir: RUNS_DIR,
    /** Resume-window honesty: cycles dropped because they produced no decision. */
    resumeDroppedNonDecisionCycles: droppedNonDecisionCycles,
    resumeScan,
    /** Byte budget applied to the brain's perception, with every dropped key named. */
    contextBudget: lastReceipt?.contextBudget ?? null,
    stageDurationsMs: lastReceipt?.stageDurationsMs ?? null,
    receiptPersistenceDurationMs: lastReceiptPersistenceDurationMs,
    /** False when a cycle's evidence could not be persisted; the run still succeeded. */
    evidenceComplete: evidenceWriteFailures.length === 0,
    evidenceWriteFailures,
    artifactBackfill,
    artifactBackfillDeferredReason,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(
      `central agent ran ${runs} cycle(s) over ${durationMinutes} min(s); brain=${brainOutcome}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    if (error instanceof ParseError) {
      process.stdout.write(`${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`central agent failed: ${String(error)}\n`);
      process.exitCode = 1;
    }
  });
}
