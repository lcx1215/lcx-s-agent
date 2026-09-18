import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  boundPerception,
  compactReceipts,
  resumableReceipts,
  runCentralHarnessCycle,
} from "../../src/agents/central-harness/harness-loop.js";
import type { CompactBacklogEntry } from "../../src/agents/central-harness/harness-loop.js";
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
  CentralPerception,
  CentralRunReceipt,
} from "../../src/agents/central-harness/types.js";
import { loadConfig } from "../../src/config/io.js";
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

const CLAIMED_BOUNDARIES = [
  "research_only",
  "no_execution_authority",
  "llm_proposes_ts_gate_approves",
];

class ParseError extends Error {}

/** An evidence write that failed. Named, never swallowed, never fatal. */
type EvidenceWriteFailure = Readonly<{ target: string; reason: string }>;

function parseArgs(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {
    durationMinutes: 2,
    dryRun: false,
    planOnly: false,
    maxCycles: Number.POSITIVE_INFINITY,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--duration-minutes") {
      out.durationMinutes = Number(args[i + 1]);
      i += 1;
    } else if (arg === "--max-cycles") {
      out.maxCycles = Number(args[i + 1]);
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
        "Usage: node --import tsx scripts/operator/lcx-central-agent.ts [--duration-minutes N] [--max-cycles N] [--plan-only] [--dry-run] [--json]",
      );
    }
  }
  return out;
}

async function readLatest<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(STATE_DIR, name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function extractOwnerTotals(state: Record<string, unknown>): Record<string, unknown> {
  const byOwner = state.byOwner as Record<string, unknown> | undefined;
  if (byOwner && typeof byOwner === "object") {
    const totals: Record<string, unknown> = {};
    for (const [ownerId, run] of Object.entries(byOwner)) {
      const r = run as Record<string, unknown>;
      const compact = r?.compact as Record<string, unknown> | undefined;
      totals[ownerId] = {
        ok: r?.ok,
        status: (r?.runReceipt as Record<string, unknown> | undefined)?.status,
        ...(compact?.ok !== undefined ? { compactOk: compact.ok } : {}),
      };
    }
    return totals;
  }
  return {};
}

async function buildPerception(
  backlog: readonly CompactBacklogEntry[],
): Promise<CentralPerception> {
  const controlRoom = await readLatest<Record<string, unknown>>("lcx-control-room-latest.json", {});
  const governance = await readLatest<Record<string, unknown>>(
    "lcx-governance-autopilot-latest.json",
    {},
  );
  const learningWorkflow = await readLatest<Record<string, unknown>>(
    "lcx-learning-workflow-latest.json",
    {},
  );
  const ownerTotals = extractOwnerTotals(governance);
  const observedAt = new Date().toISOString();
  return {
    observedAt,
    ownerTotals,
    // The learning-workflow surface rides in the flexible control-room section so
    // the existing byte budget bounds it like any other control-room key and names
    // whatever does not fit. The projection is deliberately small (counts + last
    // summary); the full surface stays on disk under the latest pointer.
    controlRoom: {
      ...controlRoom,
      ...(learningWorkflow && typeof learningWorkflow === "object"
        ? { learningWorkflow: projectLearningWorkflow(learningWorkflow) }
        : {}),
    },
    backlog,
    boundaries: CLAIMED_BOUNDARIES,
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
async function loadPersistedReceipts(): Promise<CentralRunReceipt[]> {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf8");
    const out: CentralRunReceipt[] = [];
    for (const line of raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-RESUME_WINDOW)) {
      try {
        out.push(JSON.parse(line) as CentralRunReceipt);
      } catch {
        /* Skip malformed tail; keep going on the well-formed part. */
      }
    }
    return out;
  } catch {
    return [];
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
): CentralRunReceipt {
  return {
    schemaVersion: "lcx_central_agent_v1",
    runId: `central-${index}-${Date.now()}-failed`,
    observedAt: perception.observedAt,
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
    contextBudget: boundPerception(perception).report,
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
    evidenceWriteFailures: readonly EvidenceWriteFailure[];
    capabilityDrain: readonly string[];
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
    /** Byte budget actually applied to the brain's perception this cycle. */
    contextBudget: receipt?.contextBudget ?? null,
    /** Evidence-write honesty: a completed cycle whose record could not be persisted. */
    evidenceComplete: meta.evidenceWriteFailures.length === 0,
    evidenceWriteFailures: meta.evidenceWriteFailures,
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
  const durationMinutes = Number(options.durationMinutes);
  const dryRun = options.dryRun === true;
  const planOnly = options.planOnly === true;
  const maxCycles = Number(options.maxCycles);
  const registry = createCentralToolRegistry();
  const brain: CentralBrain = dryRun
    ? {
        propose: async () => ({ kind: "blocked_no_provider" as const, reason: "dry_run_no_llm" }),
      }
    : createCentralBrain(loadConfig());

  const deadline = Date.now() + durationMinutes * 60_000;
  let runs = 0;
  let lastReceipt: CentralRunReceipt | undefined;
  let lastRunSnapshotPath: string | undefined;
  let droppedNonDecisionCycles = 0;
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
  // thread-store resume: recover prior cycles so the brain inherits context.
  let history = await loadPersistedReceipts();
  while (Date.now() < deadline && runs < maxCycles) {
    // context compaction: only the compacted tail reaches the brain, never raw history.
    // Terminal cycles are dropped first: a cycle whose brain call did not complete
    // carries no decision, so inheriting it would let an outage read as precedent.
    const resumable = resumableReceipts(history);
    droppedNonDecisionCycles = history.length - resumable.length;
    const perception = await buildPerception(compactReceipts(resumable, 10));
    let receipt: CentralRunReceipt;
    try {
      receipt = await runCentralHarnessCycle({
        perception,
        brain,
        registry,
        planOnly,
        // In the hourly (plan-only) pass the autopilot already runs the owners in
        // parallel, so only capability steps dispatch: they have no autopilot
        // equivalent and would otherwise never drain (learning workflow, ledger
        // reads, research plans).
        capabilityOwnerIds: new Set(CENTRAL_CAPABILITY_OWNER_IDS),
        runId: `central-${runs}-${Date.now()}`,
      });
    } catch (error) {
      // Never exit without a receipt: the owner surface stays parseable even when
      // perception or dispatch fails mid-cycle.
      receipt = failedCycleReceipt(perception, runs, error);
    }
    try {
      await settle(receipt);
    } catch (error) {
      recordEvidenceFailure("jsonl", error);
    }
    try {
      lastRunSnapshotPath = await writeRunSnapshot(RUNS_DIR, receipt);
    } catch (error) {
      // The per-cycle snapshot is an extra copy of a receipt that is already in the
      // jsonl. Losing it must not cost the invocation its summary, so this stays
      // best-effort and the pointer simply records no run path.
      recordEvidenceFailure("run_snapshot", error);
      lastRunSnapshotPath = undefined;
    }
    lastReceipt = receipt;
    history = history.concat(receipt).slice(-200);
    runs += 1;
    if (dryRun || runs >= maxCycles) {
      break;
    }
    // Bounded pacing: at least a short pause between cycles to stay idle-friendly.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  // Always publish the observable snapshot, even on a zero-cycle run, so readers
  // never see a stale or absent central-agent surface.
  try {
    await writeLatest(lastReceipt, runs, {
      dryRun,
      planOnly,
      ...(lastRunSnapshotPath !== undefined ? { runSnapshotPath: lastRunSnapshotPath } : {}),
      droppedNonDecisionCycles,
      evidenceWriteFailures,
      capabilityDrain: dispatchedCapabilities(lastReceipt, new Set(CENTRAL_CAPABILITY_OWNER_IDS)),
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
    /** The brain's own one-line rationale, so readers see *why*, not just *what*. */
    brainNote: lastReceipt?.brainCall.note ?? null,
    /** Where this invocation's own cycle receipt was written, for direct reading. */
    latestRunPath: lastRunSnapshotPath ?? null,
    runsDir: RUNS_DIR,
    /** Resume-window honesty: cycles dropped because they produced no decision. */
    resumeDroppedNonDecisionCycles: droppedNonDecisionCycles,
    /** Byte budget applied to the brain's perception, with every dropped key named. */
    contextBudget: lastReceipt?.contextBudget ?? null,
    /** False when a cycle's evidence could not be persisted; the run still succeeded. */
    evidenceComplete: evidenceWriteFailures.length === 0,
    evidenceWriteFailures,
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
