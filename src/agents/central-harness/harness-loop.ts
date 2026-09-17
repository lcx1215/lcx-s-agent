import { randomUUID } from "node:crypto";
import type { CentralBrain, CentralBrainOutcome } from "./model-brain.js";
import type {
  CentralContextBudgetReport,
  CentralPerception,
  CentralRunReceipt,
  CentralStep,
  CentralToolSpec,
} from "./types.js";

export type HarnessSettle = Readonly<{
  runId: string;
  observedAt: string;
  approved: readonly string[];
  blocked: readonly string[];
}>;

export type HarnessLoopOptions = Readonly<{
  perception: CentralPerception;
  brain: CentralBrain;
  registry: ReadonlyMap<string, CentralToolSpec>;
  /** Max steps per cycle to stay bounded. */
  maxSteps?: number;
  /**
   * Stop after the gate: record the approved plan without dispatching it.
   * The scheduled owner path uses this so the hourly governance pass pays for
   * one brain decision instead of re-spawning every owner the autopilot already
   * runs in parallel.
   */
  planOnly?: boolean;
  runId?: string;
  /** Override the injected-context byte budget (tests / offline). */
  contextBudgetBytes?: number;
  /** Deterministic execute override for tests / offline. */
  execute?: (
    ownerId: string,
    spec: CentralToolSpec,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, unknown>>>;
  settle?: (receipt: CentralRunReceipt) => Promise<HarnessSettle>;
}>;

function makeStepStep(ownerId: string, args: Readonly<Record<string, unknown>>): CentralStep {
  return {
    stepId: randomUUID(),
    ownerId,
    args,
    status: "approved",
    startedAtMs: Date.now(),
  };
}

/**
 * One real iteration of the central harness loop:
 *   perceive (given) -> brain proposes -> TS gate approves/blocks
 *   -> dispatch approved tools -> observe receipts -> settle evidence.
 * After settle, the caller re-runs with the next perception (the returned
 * settle block can carry new state). The loop is bounded by maxSteps and by
 * the abort signal.
 */
export async function runCentralHarnessCycle(
  options: HarnessLoopOptions,
): Promise<CentralRunReceipt> {
  const signal = new AbortController().signal;
  const observer = options.registry;
  const runId = options.runId ?? randomUUID();
  const maxSteps = options.maxSteps ?? 6;

  const steps: CentralStep[] = [];
  let actionsProposed = 0;
  let actionsApproved = 0;
  let actionsBlockedByGate = 0;
  let brainCall: {
    provider: string;
    modelId: string;
    outcome: "completed" | "failed" | "blocked" | "skipped";
    reason?: string;
    note?: string;
  } = {
    provider: "",
    modelId: "",
    outcome: "skipped",
    reason: "brain_disabled",
  };

  // The byte budget is applied here, at the single point where perception reaches
  // the brain, so no caller can hand the model an unbounded snapshot.
  const bounded = boundPerception(options.perception, options.contextBudgetBytes);

  // A brain failure (provider unreachable, output-contract violation, abort) must
  // still settle a receipt. The scheduled harness has to report "the brain failed"
  // honestly rather than crashing and leaving its owner with no parseable output.
  let proposal: CentralBrainOutcome | undefined;
  try {
    proposal = await options.brain.propose(bounded.perception, signal);
  } catch (error) {
    brainCall = {
      provider: "",
      modelId: "",
      outcome: "failed",
      reason: `brain call failed: ${String(error).slice(0, 300)}`,
    };
  }
  if (proposal?.kind === "proposed") {
    brainCall = {
      provider: proposal.provider,
      modelId: proposal.modelId,
      outcome: "completed",
      ...(proposal.plan.note ? { note: proposal.plan.note } : {}),
    };
    for (const action of proposal.plan.actions) {
      if (actionsApproved + actionsBlockedByGate >= maxSteps) {
        break;
      }
      actionsProposed += 1;
      const spec = observer.get(action.ownerId);
      if (!spec) {
        actionsBlockedByGate += 1;
        steps.push({
          stepId: randomUUID(),
          ownerId: action.ownerId,
          args: action.args ?? {},
          status: "blocked_by_gate",
          gateReason: `unknown owner: ${action.ownerId}`,
          boundary: [],
        });
        continue;
      }
      const gate = spec.approve(action.args ?? {});
      if (!gate.ok) {
        actionsBlockedByGate += 1;
        steps.push({
          stepId: randomUUID(),
          ownerId: action.ownerId,
          args: action.args ?? {},
          status: "blocked_by_gate",
          gateReason: gate.reason,
          boundary: spec.boundary,
          startedAtMs: Date.now(),
        });
        continue;
      }
      actionsApproved += 1;
      steps.push(makeStepStep(action.ownerId, action.args ?? {}));
    }
  } else if (proposal !== undefined) {
    brainCall = {
      provider: "",
      modelId: "",
      outcome: "blocked",
      reason: proposal.reason,
    };
  }

  // Dispatch approved steps strictly sequentially (research-only owners, idempotent reads).
  // `planOnly` intentionally stops before this: the decision is already recorded on
  // the steps, and spawning the owners here would double-run the autopilot's own pass.
  for (const step of options.planOnly ? [] : steps) {
    if (step.status !== "approved") {
      continue;
    }
    const spec = observer.get(step.ownerId)!;
    try {
      const observation =
        options.execute !== undefined
          ? // Test/offline override: deterministic execute given the full spec.
            await options.execute(step.ownerId, spec, step.args, signal)
          : await spec.execute(step.args, signal);
      // `ran_ok` means the harness obtained a receipt. The owner's own verdict
      // rides alongside it, so "it ran and reported a red light" never reads as
      // "it did not run" (and vice versa).
      const observed = (observation as { observedOk?: unknown } | undefined)?.observedOk;
      if (observed === true || observed === false) {
        step.observedOk = observed;
      }
      step.status = "ran_ok";
    } catch (error) {
      step.status = "ran_failed";
      step.failureReason = String(error).slice(0, 300);
    }
    step.finishedAtMs = Date.now();
  }

  // The next action is computed here, by TypeScript, and never by the brain: it
  // is a bounded enum the following cycle can trust, not self-authored guidance.
  const nextAction =
    brainCall.outcome === "completed"
      ? actionsBlockedByGate > 0
        ? "review_blocked_proposals"
        : steps.some((step) => step.observedOk === false)
          ? "follow_up_on_owners_reporting_not_ok"
          : "continue"
      : brainCall.outcome === "failed"
        ? "halt_and_report"
        : brainCall.outcome === "blocked"
          ? "restore_brain_provider_then_retry"
          : "continue";

  const receipt: CentralRunReceipt = {
    schemaVersion: "lcx_central_agent_v1",
    runId,
    observedAt: options.perception.observedAt,
    actionsProposed: actionsProposed,
    actionsApproved: actionsApproved,
    actionsBlockedByGate: actionsBlockedByGate,
    steps,
    boundaries: options.perception.boundaries,
    brainCall,
    nextAction,
    contextBudget: bounded.report,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  if (options.settle) {
    await options.settle(receipt);
  }
  return receipt;
}

/**
 * Codex-harness context-compaction + retained-reasoning pattern, applied to the
 * central harness. Instead of feeding the brain the whole raw thread, fold a
 * bounded tail of done cycles into compact backlog entries (who ran, who got
 * gated, which owners reported a red light, and the brain's own one-line note
 * from the prior turn). This keeps the probe small and lets the next decision
 * inherit prior reasoning.
 *
 * `nextAction` is carried through as well: it is the TypeScript-computed next
 * step, so the following cycle sees the harness's own verdict instead of having
 * to re-derive it, and the field cannot become model-authored guidance.
 */
export type CompactBacklogEntry = Readonly<{
  atMs: number;
  brainOutcome: "completed" | "failed" | "blocked" | "skipped";
  note?: string;
  approved: readonly string[];
  blocked: readonly string[];
  /** Owners that ran and whose own receipt reported not-ok. */
  notOk: readonly string[];
  nextAction: string;
}>;

/**
 * Codex-harness terminal-card rule, applied to the central agent's resume window.
 *
 * A cycle whose brain call did not complete (`failed`, `blocked`) produced no
 * decision and no owner verdict. Replaying it would let a transient provider
 * outage read to the next cycle as ordinary precedent, and would inflate the
 * backlog with entries that say nothing about what was decided. Only completed
 * cycles are resumable. The dropped cycles stay on disk as evidence — they are
 * simply not inherited as context, and the caller reports how many were dropped
 * so the omission is visible rather than silent.
 */
export function resumableReceipts(
  receipts: readonly CentralRunReceipt[],
): readonly CentralRunReceipt[] {
  return receipts.filter((receipt) => receipt.brainCall.outcome === "completed");
}

export function compactReceipts(
  receipts: readonly CentralRunReceipt[],
  max: number,
): readonly CompactBacklogEntry[] {
  const bounded = Number.isSafeInteger(max) ? Math.max(1, Math.min(max, 200)) : 20;
  const tail = receipts.slice(-bounded);
  return tail.map((receipt) => ({
    atMs: Date.parse(receipt.observedAt) || 0,
    brainOutcome: receipt.brainCall.outcome,
    ...(receipt.brainCall.note ? { note: receipt.brainCall.note } : {}),
    approved: receipt.steps
      .filter((step) => step.status === "approved" || step.status === "ran_ok")
      .map((step) => step.ownerId),
    blocked: receipt.steps
      .filter((step) => step.status === "blocked_by_gate")
      .map((step) => step.ownerId),
    notOk: receipt.steps.filter((step) => step.observedOk === false).map((step) => step.ownerId),
    nextAction: receipt.nextAction,
  }));
}

/**
 * Total byte budget for the perception injected into the brain prompt, and the
 * per-key cap that stops one oversized section from crowding out the small,
 * decision-relevant ones.
 *
 * Codex bounds injected context in *bytes* (`additionalContextLimit`). Bounding
 * only counts, which is what this harness did, is a different and weaker
 * guarantee: `backlog.slice(0, 10)` says nothing about the bytes those ten entries
 * carry. Measured on the live workspace, the control-room snapshot alone
 * serialized to ~311 KB — 99.7% of a 319 KB prompt — for a decision that only
 * needs the per-owner status lines already carried by `ownerTotals`.
 */
export const CENTRAL_PERCEPTION_BUDGET_BYTES = 12_000;
export const CENTRAL_PERCEPTION_KEY_BUDGET_BYTES = 2_048;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

/**
 * Keep the object keys that fit both the per-key cap and the section budget,
 * preserving declaration order, and report what was left out. A key that does not
 * fit is skipped rather than terminating the scan, so a later small key still
 * gets in.
 */
function boundObjectSection(
  source: Readonly<Record<string, unknown>>,
  sectionBudgetBytes: number,
): {
  value: Record<string, unknown>;
  dropped: readonly Readonly<{ key: string; bytes: number }>[];
} {
  const kept: Record<string, unknown> = {};
  const dropped: { key: string; bytes: number }[] = [];
  let keptBytes = 2; // "{}"
  for (const [key, value] of Object.entries(source)) {
    const bytes = jsonBytes(value);
    const entryBytes = jsonBytes(key) + bytes + 2; // "key":value,
    if (
      bytes > CENTRAL_PERCEPTION_KEY_BUDGET_BYTES ||
      keptBytes + entryBytes > sectionBudgetBytes
    ) {
      dropped.push({ key, bytes });
      continue;
    }
    kept[key] = value;
    keptBytes += entryBytes;
  }
  return { value: kept, dropped };
}

/**
 * Bound the perception handed to the brain to a byte budget.
 *
 * The always-injected sections (owner status, backlog, boundaries) are counted
 * first and never truncated mid-structure — a partially cut JSON fragment would
 * be worse than useless to the model. The flexible section (the control-room
 * snapshot) absorbs the whole reduction, and every key left out is named with its
 * byte size so the omission is visible in the receipt. The full snapshot remains
 * on disk: this bounds the injection, it does not delete evidence.
 *
 * Idempotent: bounding an already-bounded perception returns it unchanged.
 */
export function boundPerception(
  perception: CentralPerception,
  budgetBytes: number = CENTRAL_PERCEPTION_BUDGET_BYTES,
): { perception: CentralPerception; report: CentralContextBudgetReport } {
  const budget =
    Number.isSafeInteger(budgetBytes) && budgetBytes > 0
      ? budgetBytes
      : CENTRAL_PERCEPTION_BUDGET_BYTES;
  const controlRoom = perception.controlRoom ?? {};
  const originalBytes = jsonBytes(controlRoom);
  const fixedBytes = jsonBytes({
    observedAt: perception.observedAt,
    ownerTotals: perception.ownerTotals,
    backlog: perception.backlog,
    boundaries: perception.boundaries,
  });
  const { value, dropped } = boundObjectSection(controlRoom, Math.max(0, budget - fixedBytes));
  const boundedPerception: CentralPerception = { ...perception, controlRoom: value };
  const injectedBytes = jsonBytes(boundedPerception);
  return {
    perception: boundedPerception,
    report: {
      budgetBytes: budget,
      injectedBytes,
      // Honest rather than silently over: if the fixed sections alone blow the
      // budget, say so instead of truncating the state the decision needs.
      overBudget: injectedBytes > budget,
      droppedSections:
        dropped.length > 0
          ? [
              {
                section: "controlRoom",
                originalBytes,
                keptBytes: jsonBytes(value),
                droppedKeys: dropped.toSorted(
                  (left, right) => right.bytes - left.bytes || left.key.localeCompare(right.key),
                ),
              },
            ]
          : [],
    },
  };
}
