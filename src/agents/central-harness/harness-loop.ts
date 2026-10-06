import { createHash, randomUUID } from "node:crypto";
import type { CentralBrain, CentralBrainOutcome } from "./model-brain.js";
import type {
  CentralBrainCallEvidence,
  CentralContextBudgetReport,
  CentralFinancePerceptionEvidence,
  CentralPerception,
  CentralRunReceipt,
  CentralStep,
  CentralToolSpec,
} from "./types.js";

// Only the host registry can associate an enriched object with its business result.
// JSON fields with these names never establish provenance.
const hostArtifactBusinessOutcomes = new WeakMap<object, Readonly<Record<string, unknown>>>();
export function markCentralArtifactOutcome(
  enriched: Readonly<Record<string, unknown>>,
  business: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  hostArtifactBusinessOutcomes.set(enriched, business);
  return enriched;
}

export type HarnessSettle = Readonly<{
  runId: string;
  observedAt: string;
  approved: readonly string[];
  blocked: readonly string[];
}>;

export type HarnessLoopOptions = Readonly<{
  perception: CentralPerception;
  signal?: AbortSignal;
  /** Absolute cycle deadline; defaults to two minutes from cycle start. */
  deadlineMs?: number;
  brain: CentralBrain;
  registry: ReadonlyMap<string, CentralToolSpec>;
  /** Max steps per cycle to stay bounded. */
  maxSteps?: number;
  /**
   * Stop after the gate for non-capability owners: record the approved plan
   * without dispatching it. The scheduled owner path uses this so the hourly
   * governance pass pays for one brain decision instead of re-spawning every
   * owner the autopilot already runs in parallel. Capability steps are still
   * dispatched in plan-only mode — see `capabilityOwnerIds`.
   */
  planOnly?: boolean;
  /**
   * Owners that are capabilities (not governance owners). In plan-only mode the
   * autopilot already covers the governance owners, so only these steps run —
   * a capability has no autopilot equivalent, and leaving it unrun would starve
   * the surface it maintains (e.g. the learning workflow). The gate still
   * approves each step; this changes dispatch, never authority.
   */
  capabilityOwnerIds?: ReadonlySet<string>;
  runId?: string;
  /** Override the injected-context byte budget (tests / offline). */
  contextBudgetBytes?: number;
  /** Time spent building the perception before entering the harness cycle. */
  perceptionBuildDurationMs?: number;
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
  const controller = new AbortController();
  const remainingMs = (options.deadlineMs ?? Date.now() + 120_000) - Date.now();
  const expire = () => controller.abort(new Error("central cycle deadline exceeded"));
  const timer = remainingMs > 0 ? setTimeout(expire, remainingMs) : undefined;
  if (remainingMs <= 0) {
    expire();
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    return await runCycle(options, signal);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Allow bounded cleanup before recording cancellation; unknown adapters must not imply shutdown. */
async function observeUntilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      cleanupTimer = setTimeout(
        () =>
          reject(
            new Error(`${String(signal.reason ?? "central cycle cancelled")}; cleanup_unconfirmed`),
          ),
        2_000,
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then((value) => {
        if (signal.aborted) {
          reject(signal.reason);
        } else {
          resolve(value);
        }
      }, reject)
      .finally(() => {
        if (cleanupTimer) {
          clearTimeout(cleanupTimer);
        }
        signal.removeEventListener("abort", abort);
      });
  });
}

async function runCycle(
  options: HarnessLoopOptions,
  signal: AbortSignal,
): Promise<CentralRunReceipt> {
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
    modelCall?: CentralBrainCallEvidence;
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
  const brainProposalStartedAt = performance.now();
  if (bounded.report.overBudget) {
    brainCall = {
      provider: "",
      modelId: "",
      outcome: "blocked",
      reason: "context_budget_exceeded",
    };
  } else {
    try {
      proposal = await observeUntilAborted(signal, () =>
        options.brain.propose(bounded.perception, signal),
      );
    } catch (error) {
      brainCall = {
        provider: "",
        modelId: "",
        outcome: "failed",
        reason: `brain call failed: ${String(error).slice(0, 300)}`,
      };
    }
  }
  const brainProposalMs = Math.max(0, Math.round(performance.now() - brainProposalStartedAt));
  const gateStartedAt = performance.now();
  const approvedActions = new Set<string>();
  if (proposal?.kind === "proposed") {
    brainCall = {
      provider: proposal.provider,
      modelId: proposal.modelId,
      outcome: "completed",
      ...(proposal.modelCall ? { modelCall: proposal.modelCall } : {}),
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
      const identity = JSON.stringify([
        action.ownerId,
        canonicalContinuationValue(action.args ?? {}),
      ]);
      if (approvedActions.has(identity)) {
        actionsBlockedByGate += 1;
        steps.push({
          stepId: randomUUID(),
          ownerId: action.ownerId,
          args: action.args ?? {},
          status: "blocked_by_gate",
          gateReason: "duplicate_action",
          boundary: spec.boundary,
          startedAtMs: Date.now(),
        });
        continue;
      }
      approvedActions.add(identity);
      actionsApproved += 1;
      steps.push(makeStepStep(action.ownerId, action.args ?? {}));
    }
  } else if (proposal?.kind === "failed") {
    brainCall = {
      provider: proposal.provider,
      modelId: proposal.modelId,
      outcome: "failed",
      reason: `model call failed: ${proposal.reason}`,
      modelCall: proposal.modelCall,
    };
  } else if (proposal !== undefined) {
    brainCall = {
      provider: "",
      modelId: "",
      outcome: "blocked",
      reason: proposal.reason,
    };
  }
  const deterministicGateMs = Math.max(0, Math.round(performance.now() - gateStartedAt));

  // Dispatch approved steps strictly sequentially (research-only owners, idempotent reads).
  // `planOnly` stops owner steps before dispatch: the decision is already recorded
  // on the steps, and spawning the owners here would double-run the autopilot's own
  // pass. Capability steps are NOT stopped: no autopilot covers them, and a plan
  // that never drains its capability surface would starve the learning workflow.
  const actionDispatchStartedAt = performance.now();
  for (const step of steps) {
    if (step.status !== "approved") {
      continue;
    }
    if (options.planOnly === true && !(options.capabilityOwnerIds?.has(step.ownerId) ?? false)) {
      continue;
    }
    const spec = observer.get(step.ownerId)!;
    try {
      const observation = await observeUntilAborted(signal, () =>
        options.execute !== undefined
          ? // Test/offline override: deterministic execute given the full spec.
            options.execute(step.ownerId, spec, step.args, signal)
          : spec.execute(step.args, signal),
      );
      // `ran_ok` means the harness obtained a receipt. The owner's own verdict
      // rides alongside it, so "it ran and reported a red light" never reads as
      // "it did not run" (and vice versa).
      const observed = (observation as { observedOk?: unknown } | undefined)?.observedOk;
      if (observed === true || observed === false) {
        step.observedOk = observed;
      }
      // Feed the tool result forward, bounded. Reading only `observedOk` and
      // discarding the rest is what left the brain unable to see what an owner
      // reported: the Codex loop's whole point is that the next decision is made
      // on the previous tool's output, not on the fact that a tool ran.
      //
      // Digest the owner's *parsed receipt* rather than the harness envelope. The
      // envelope's `output` key is the whole raw stdout, which any byte budget
      // drops first — digesting it would carry `{exitCode, observedOk}` and
      // nothing the owner actually said.
      const digestSource = isPlainRecord(observation.receipt)
        ? observation.receipt
        : isPlainRecord(observation)
          ? observation
          : undefined;
      if (digestSource !== undefined) {
        const business = isPlainRecord(observation)
          ? hostArtifactBusinessOutcomes.get(observation)
          : undefined;
        if (business !== undefined) {
          const businessDigest = isPlainRecord(business.receipt) ? business.receipt : business;
          step.semanticOutcomeSha256 = createHash("sha256")
            .update(JSON.stringify(canonicalContinuationValue(businessDigest)))
            .digest("hex");
        }
        const decisionDigest = compactCentralStepOutcome(step.ownerId, digestSource);
        const outcomeBudget =
          step.ownerId === "finance_bar_ledger" ||
          (step.ownerId === "finance_position_ledger_read" &&
            ["receipt", "order", "fill", "fee"].includes(String(step.args.historyKind)))
            ? CENTRAL_READ_PAGE_OUTCOME_BUDGET_BYTES
            : CENTRAL_STEP_OUTCOME_BUDGET_BYTES;
        const boundedOutcome = boundObjectSection(
          decisionDigest,
          outcomeBudget,
          // The digest is the whole budget for one step: no single key may take
          // more of it than the digest itself.
          outcomeBudget,
        );
        step.outcome = boundedOutcome.value;
        if (boundedOutcome.dropped.length > 0) {
          step.outcomeDroppedKeys = boundedOutcome.dropped.map((entry) => entry.key);
        }
      }
      step.status = "ran_ok";
    } catch (error) {
      step.status = "ran_failed";
      step.failureReason = String(error).slice(0, 300);
    }
    step.finishedAtMs = Date.now();
  }
  const actionDispatchMs = Math.max(0, Math.round(performance.now() - actionDispatchStartedAt));

  // The next action is computed here, by TypeScript, and never by the brain: it
  // is a bounded enum the following cycle can trust, not self-authored guidance.
  const nextAction =
    signal.aborted || bounded.report.overBudget
      ? "halt_and_report"
      : brainCall.outcome === "completed"
        ? steps.some((step) => step.status === "ran_failed")
          ? "follow_up_on_failed_dispatch"
          : actionsBlockedByGate > 0
            ? "review_blocked_proposals"
            : steps.some((step) => step.observedOk === false)
              ? "follow_up_on_owners_reporting_not_ok"
              : steps.some(
                    (step) =>
                      step.status === "ran_ok" &&
                      step.outcome !== undefined &&
                      options.capabilityOwnerIds?.has(step.ownerId),
                  )
                ? "follow_up_on_capability_results"
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
    ...(bounded.perception.task ? { task: bounded.perception.task } : {}),
    actionsProposed: actionsProposed,
    actionsApproved: actionsApproved,
    actionsBlockedByGate: actionsBlockedByGate,
    steps,
    boundaries: options.perception.boundaries,
    brainCall,
    nextAction,
    contextBudget: bounded.report,
    ...(bounded.perception.task?.focus === "general"
      ? {}
      : { financePerception: projectFinancePerceptionEvidence(bounded) }),
    ...(isPlainRecord(bounded.perception.controlRoom.runtimeFreshness)
      ? { runtimeFreshness: bounded.perception.controlRoom.runtimeFreshness }
      : {}),
    stageDurationsMs: {
      perceptionBuildMs:
        options.perceptionBuildDurationMs === undefined
          ? null
          : Math.max(0, Math.round(options.perceptionBuildDurationMs)),
      brainProposalMs,
      deterministicGateMs,
      actionDispatchMs,
    },
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
  /**
   * The *why* behind the ids above, for the steps that did not come back
   * cleanly green.
   *
   * `approved`/`blocked`/`notOk` answer *who*. Without this the next decision can
   * only guess *why* — the harness recorded `gateReason`, `failureReason` and the
   * owner's own receipt on the step and then dropped all three here, so a cycle
   * gated for a fixable reason looked identical to one gated on principle, and an
   * owner that returned a red light arrived as a bare id. A real receipt shows
   * the shape of the gap: `commercialAcceptance` ran and reported not-ok, and the
   * next cycle saw only its name.
   *
   * The newest attempt for each exact owner/argument scope retains its bounded
   * digest. Superseded and omitted evidence is named, never a passing result.
   */
  outcomes: readonly Readonly<{
    ownerId: string;
    status: CentralStep["status"];
    reason?: string;
    outcome?: Readonly<Record<string, unknown>>;
    outcomeDroppedKeys?: readonly string[];
    /** Original observation time; carrying a result does not refresh its evidence. */
    sourceObservedAt?: string;
    /** Whole argument values that fit; the digest identifies the full original scope. */
    args?: Readonly<Record<string, unknown>>;
    argsSha256?: string;
    argsDroppedKeys?: readonly string[];
  }>[];
  /** Steps that had a reason worth carrying but did not fit the cap. */
  outcomesOmitted?: number;
  /** Older cycles omitted to keep the always-injected backlog within its byte ceiling. */
  backlogEntriesOmitted?: number;
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

/** TypeScript-authored loop verdict: continue only when this receipt names work. */
export type CentralCycleContinuation =
  | {
      run: true;
      because:
        | "dispatch_failed"
        | "proposals_blocked_by_gate"
        | "owners_reported_not_ok"
        | "capability_results";
    }
  | {
      run: false;
      because:
        | "max_cycles_reached"
        | "brain_made_no_decision"
        | "nothing_left_to_follow_up"
        | "unchanged_failure"
        | "unchanged_result";
    };

const FOLLOW_UP_VERDICTS: Readonly<
  Record<
    string,
    | "dispatch_failed"
    | "proposals_blocked_by_gate"
    | "owners_reported_not_ok"
    | "capability_results"
  >
> = {
  follow_up_on_capability_results: "capability_results",
  follow_up_on_failed_dispatch: "dispatch_failed",
  review_blocked_proposals: "proposals_blocked_by_gate",
  follow_up_on_owners_reporting_not_ok: "owners_reported_not_ok",
};

/**
 * Decide whether another bounded cycle can make progress, using the receipt's
 * verdict rather than re-deriving model intent or repeating an unchanged failure.
 */
export function nextCycleContinuation(
  receipt: CentralRunReceipt,
  cyclesRun: number,
  maxCycles: number,
  previous?: CentralRunReceipt,
): CentralCycleContinuation {
  if (receipt.brainCall.outcome !== "completed") {
    return { run: false, because: "brain_made_no_decision" };
  }
  const because = FOLLOW_UP_VERDICTS[receipt.nextAction];
  if (!because) {
    return { run: false, because: "nothing_left_to_follow_up" };
  }
  if (cyclesRun >= maxCycles) {
    return { run: false, because: "max_cycles_reached" };
  }
  // Ignore model prose and wall-clock timings: they do not resolve a blocked action.
  const signature = (value: CentralRunReceipt, peer: CentralRunReceipt) =>
    JSON.stringify(
      value.steps.map((step, index) => ({
        ownerId: step.ownerId,
        args: canonicalContinuationValue(step.args),
        status: step.status,
        observedOk: step.observedOk,
        reason: step.gateReason ?? step.failureReason,
        outcome:
          typeof step.semanticOutcomeSha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(step.semanticOutcomeSha256) &&
          typeof peer.steps[index]?.semanticOutcomeSha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(peer.steps[index].semanticOutcomeSha256)
            ? { semanticOutcomeSha256: step.semanticOutcomeSha256 }
            : canonicalContinuationValue(step.outcome),
        outcomeDroppedKeys: step.outcomeDroppedKeys,
      })),
    );
  if (
    previous &&
    receipt.steps.length > 0 &&
    previous.nextAction === receipt.nextAction &&
    signature(previous, receipt) === signature(receipt, previous)
  ) {
    return {
      run: false,
      because:
        receipt.nextAction === "follow_up_on_capability_results"
          ? "unchanged_result"
          : "unchanged_failure",
    };
  }
  return { run: true, because };
}

function canonicalContinuationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalContinuationValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalContinuationValue(item)]),
    );
  }
  return value;
}

/**
 * Steps whose outcome the next decision actually needs: red lights plus the
 * successful capability results the caller elected to carry forward.
 *
 * A green governance check needs no repeated digest: the control room carries
 * its status. A green capability read is different; its returned data is the
 * evidence the next decision needs, even though the owner itself reported ok.
 * `ran_ok` with no verdict is also included because the next decision is blind
 * without that receipt.
 */
function stepsToCarry(
  receipt: CentralRunReceipt,
  carrySuccessfulOutcomeOwnerIds: ReadonlySet<string>,
): readonly CentralStep[] {
  return receipt.steps.filter(
    (step) =>
      step.status === "blocked_by_gate" ||
      step.status === "ran_failed" ||
      (step.status === "ran_ok" &&
        (step.observedOk !== true || carrySuccessfulOutcomeOwnerIds.has(step.ownerId))),
  );
}

export function compactReceipts(
  receipts: readonly CentralRunReceipt[],
  max: number,
  carrySuccessfulOutcomeOwnerIds: ReadonlySet<string> = new Set(),
): readonly CompactBacklogEntry[] {
  const bounded = Number.isSafeInteger(max) ? Math.max(1, Math.min(max, 200)) : 20;
  const tail = receipts.slice(-bounded);
  const isLargeReadPage = (step: CentralStep): boolean =>
    step.ownerId === "finance_bar_ledger" ||
    (step.ownerId === "finance_position_ledger_read" && isPlainRecord(step.outcome?.history));
  const argumentIdentity = (step: CentralStep) =>
    JSON.stringify([step.ownerId, canonicalContinuationValue(step.args)]);
  const latestAttempts = new Map<string, CentralStep>();
  for (const receipt of tail) {
    for (const step of receipt.steps) {
      // A rejected proposal did not read the source and cannot replace its evidence.
      // A green governance check can supersede a failure without carrying a digest.
      if (step.status === "ran_ok" || step.status === "ran_failed") {
        latestAttempts.set(argumentIdentity(step), step);
      }
    }
  }
  const isCurrentHistoryPage = (step: CentralStep): boolean =>
    isLargeReadPage(step) && latestAttempts.get(argumentIdentity(step)) === step;
  const newestHistoryReceiptIndex = tail.findLastIndex((receipt) =>
    receipt.steps.some(isCurrentHistoryPage),
  );
  const newestHistoryStep = tail[newestHistoryReceiptIndex]?.steps
    .filter(isCurrentHistoryPage)
    .at(-1);
  const mapped: CompactBacklogEntry[] = tail.map((receipt, index) => {
    // An unrelated action or a no-op does not consume another tool's evidence.
    // Keep only its newest attempt, with the original scope and observation clock.
    const carriesHistory = index === newestHistoryReceiptIndex;
    const interesting = stepsToCarry(receipt, carrySuccessfulOutcomeOwnerIds);
    const relevant = interesting.filter(
      (step) =>
        step.status === "blocked_by_gate" ||
        (latestAttempts.get(argumentIdentity(step)) === step &&
          (!isLargeReadPage(step) || (carriesHistory && step === newestHistoryStep))),
    );
    // Prefer current evidence over obsolete markers when a receipt exceeds the cap.
    const selected = new Set(
      [...relevant, ...interesting.filter((step) => !relevant.includes(step))].slice(
        0,
        CENTRAL_BACKLOG_MAX_OUTCOMES,
      ),
    );
    const kept = interesting.filter((step) => selected.has(step));
    return {
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
      outcomes: kept.map((step) => {
        const reason = step.gateReason ?? step.failureReason;
        const carriesDigest = relevant.includes(step);
        const scopedArgs = boundObjectSection(step.args, 256, 256);
        const supersededKey = isLargeReadPage(step)
          ? "read_page_superseded_in_backlog"
          : "outcome_superseded_in_backlog";
        const outcomeDroppedKeys = carriesDigest
          ? (step.outcomeDroppedKeys ?? [])
          : [...(step.outcomeDroppedKeys ?? []), supersededKey];
        return {
          ownerId: step.ownerId,
          status: step.status,
          sourceObservedAt: receipt.observedAt,
          args: scopedArgs.value,
          argsSha256: createHash("sha256")
            .update(JSON.stringify(canonicalContinuationValue(step.args)))
            .digest("hex"),
          ...(scopedArgs.dropped.length > 0
            ? { argsDroppedKeys: scopedArgs.dropped.map(({ key }) => key) }
            : {}),
          ...(reason ? { reason: reason.slice(0, CENTRAL_STEP_REASON_CHARS) } : {}),
          ...(step.outcome && carriesDigest ? { outcome: step.outcome } : {}),
          ...(outcomeDroppedKeys.length > 0 ? { outcomeDroppedKeys } : {}),
        };
      }),
      ...(interesting.length > kept.length
        ? { outcomesOmitted: interesting.length - kept.length }
        : {}),
    };
  });
  const byteLimit = 8_500;
  let omitted = 0;
  const isFocusPage = (outcome: CompactBacklogEntry["outcomes"][number]): boolean =>
    Boolean(
      outcome.outcome &&
      (outcome.ownerId === "finance_bar_ledger" ||
        (outcome.ownerId === "finance_position_ledger_read" &&
          isPlainRecord(outcome.outcome.history))),
    );
  const carriesFocusPage = (entry: CompactBacklogEntry): boolean =>
    entry.outcomes.some(isFocusPage);
  while (mapped.length > 1 && jsonBytes(mapped) + (omitted > 0 ? 60 : 0) > byteLimit) {
    const removeIndex = mapped.findIndex((entry) => !carriesFocusPage(entry));
    if (removeIndex < 0) {
      break;
    }
    mapped.splice(removeIndex, 1);
    omitted += 1;
  }
  if (omitted > 0 && mapped.length > 0) {
    mapped[0] = { ...mapped[0], backlogEntriesOmitted: omitted };
  }
  // A single multi-step receipt can also overflow. Remove whole outcomes, keeping
  // the focused page and its scope intact when possible; count every omitted item.
  while (mapped.length > 0 && jsonBytes(mapped) > byteLimit) {
    const index = mapped.findIndex((entry) => entry.outcomes.length > 0);
    if (index < 0) {
      // Exceptional oversized headers stay explicit instead of bypassing the cap.
      const newest = mapped.at(-1)!;
      return [
        {
          atMs: newest.atMs,
          brainOutcome: newest.brainOutcome,
          approved: [],
          blocked: [],
          notOk: [],
          nextAction: "recover_omitted_backlog",
          outcomes: [],
          backlogEntriesOmitted: omitted + mapped.length,
        },
      ];
    }
    const entry = mapped[index];
    const removeIndex = entry.outcomes.findLastIndex((outcome) => !isFocusPage(outcome));
    const removed = removeIndex >= 0 ? removeIndex : entry.outcomes.length - 1;
    mapped[index] = {
      ...entry,
      outcomes: entry.outcomes.filter((_, outcomeIndex) => outcomeIndex !== removed),
      outcomesOmitted: (entry.outcomesOmitted ?? 0) + 1,
    };
  }
  return mapped;
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
// Compatibility export for the former finance key allowance; finance now uses
// the remaining total budget after small decision projections are reserved.
export const CENTRAL_FINANCE_PERCEPTION_KEY_BUDGET_BYTES = 6_144;
/**
 * Caps on the tool-result digest carried back to the next decision, and on how
 * much of a step's reason survives compaction.
 *
 * These are ceilings, not typical sizes, and there are three of them because the
 * backlog is an always-injected section: `boundPerception` counts it before the
 * control room and never truncates it, so an unbounded enrichment would spend the
 * shared budget on history and leave the control room with nothing. What is left
 * out is named (`outcomeDroppedKeys`, `outcomesOmitted`) rather than silently
 * missing, and the full receipt stays on disk either way.
 */
export const CENTRAL_STEP_OUTCOME_BUDGET_BYTES = 512;
export const CENTRAL_READ_PAGE_OUTCOME_BUDGET_BYTES = 4096;
export const CENTRAL_BACKLOG_MAX_OUTCOMES = 6;
export const CENTRAL_STEP_REASON_CHARS = 240;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactCentralStepOutcome(
  ownerId: string,
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (ownerId === "finance_position_ledger_read" && isPlainRecord(source.history)) {
    return {
      schemaVersion: source.schemaVersion,
      status: source.status,
      historyKind: source.historyKind,
      history: source.history,
      ...(source.historyDroppedKeys ? { historyDroppedKeys: source.historyDroppedKeys } : {}),
    };
  }
  if (
    ownerId !== "finance_strategy_rule_ledger_read" ||
    source.schemaVersion !== "lcx_finance_strategy_rule_ledger_read_v1"
  ) {
    return source;
  }

  const safePart = (value: unknown): string | undefined => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return undefined;
    }
    const text = String(value)
      .replace(/[^a-zA-Z0-9 _.,:/=+@-]/gu, "_")
      .replace(/\s+/gu, " ");
    return text.length > 0 ? text : undefined;
  };
  const listParts = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map(safePart).filter((part): part is string => part !== undefined)
      : [];
  const clip = (text: string, limit: number): string =>
    Buffer.byteLength(text) <= limit
      ? text
      : `${Buffer.from(text)
          .subarray(0, limit - 3)
          .toString("utf8")}...`;

  const rules = Array.isArray(source.rules) ? source.rules.filter(isPlainRecord) : [];
  const ruleSummary = rules
    .map((rule) => {
      const instruments = listParts(rule.instruments);
      const parts = [
        safePart(rule.ruleId),
        safePart(rule.state),
        safePart(rule.form),
        safePart(rule.formVersion),
        safePart(rule.emits),
        isPlainRecord(rule.schedule) ? safePart(rule.schedule.kind) : undefined,
        instruments.length > 0 ? `instruments=${instruments.join(",")}` : undefined,
        isPlainRecord(rule.body)
          ? Object.entries(rule.body)
              .filter(
                (entry): entry is [string, number | boolean] =>
                  typeof entry[1] === "number" || typeof entry[1] === "boolean",
              )
              .slice(0, 3)
              .map(([key, value]) => `${safePart(key) ?? "param"}=${value}`)
              .join(",") || undefined
          : undefined,
      ].filter((part): part is string => part !== undefined);
      return parts.join(" ");
    })
    .join("; ");
  const readiness = isPlainRecord(source.readiness) ? source.readiness : undefined;
  const readinessRules = Array.isArray(readiness?.rules)
    ? readiness.rules.filter(isPlainRecord)
    : [];
  const readinessSummary = readiness
    ? readinessRules
        .map((entry) => {
          const readinessValue = (value: unknown): string =>
            value === null ? "null" : (safePart(value) ?? "unknown");
          const parts = [
            safePart(entry.ruleId),
            `ready=${readinessValue(entry.ready)}`,
            `duration=${readinessValue(entry.durationMet)}`,
            `elapsedDays=${safePart(entry.elapsedDays) ?? "unknown"}`,
            `observations=${safePart(entry.observationCount) ?? "unknown"}`,
            `covered=${listParts(entry.covered).join(",") || "none"}`,
            `uncovered=${listParts(entry.uncovered).join(",") || "none"}`,
            `conflicts=${Array.isArray(entry.barConflicts) ? entry.barConflicts.length : "unknown"}`,
          ];
          const reason = safePart(entry.readyUnavailableReason);
          if (reason) {
            parts.push(`reason=${reason}`);
          }
          return parts.join(" ");
        })
        .join("; ") ||
      `readiness has no per-rule entries; thresholdsDeclared=${safePart(readiness.thresholdsDeclared) ?? "unknown"}`
    : "not_requested";

  return {
    ...(typeof source.ok === "boolean" ? { ok: source.ok } : {}),
    ...(typeof source.status === "string" ? { status: source.status } : {}),
    ...(typeof source.ruleCount === "number" ? { ruleCount: source.ruleCount } : {}),
    ...(typeof source.activeRuleCount === "number"
      ? { activeRuleCount: source.activeRuleCount }
      : {}),
    ruleSummary: clip(`rules=${rules.length}: ${ruleSummary || "details unavailable"}`, 150),
    readinessSummary: clip(`readiness=${readinessSummary}`, 190),
  };
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
  keyBudgetBytes: number = CENTRAL_PERCEPTION_KEY_BUDGET_BYTES,
  keyBudgetOverrides: Readonly<Record<string, number>> = {},
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
    const keyLimitBytes = keyBudgetOverrides[key] ?? keyBudgetBytes;
    if (bytes > keyLimitBytes || keptBytes + entryBytes > sectionBudgetBytes) {
      dropped.push({ key, bytes });
      continue;
    }
    kept[key] = value;
    keptBytes += entryBytes;
  }
  return { value: kept, dropped };
}

/** A fallback for known lifecycle fields, never a replacement for the original feedback. */
function projectFinanceBudgetFacts(
  source: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    !isPlainRecord(source.scheduler) &&
    !isPlainRecord(source.intradayExecution) &&
    !isPlainRecord(source.positionManagement) &&
    !isPlainRecord(source.economicFeedback) &&
    typeof source.nextTask !== "string"
  ) {
    return undefined;
  }
  const omitted = new Set<string>();
  const pick = (value: unknown, keys: readonly string[], prefix: string) => {
    const result: Record<string, unknown> = {};
    if (!isPlainRecord(value)) {
      return result;
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        keys.includes(key) &&
        (item === null ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)) ||
          (typeof item === "string" && jsonBytes(item) <= 240))
      ) {
        result[key] = item;
      } else {
        omitted.add(`${prefix}${key}`);
      }
    }
    return result;
  };
  const result = pick(source, ["schemaVersion", "status", "observedAt", "nextTask", "reason"], "");
  const sections: readonly [string, readonly string[]][] = [
    [
      "intradayExecution",
      [
        "status",
        "scope",
        "newestSignalAt",
        "candidates",
        "placed",
        "refused",
        "uncertain",
        "missingOutcome",
        "needsExecutionInspection",
      ],
    ],
    ["positionManagement", ["status", "needsInspection", "omittedAccounts", "reason"]],
    ["economicFeedback", ["status", "asOf", "omittedAccounts", "reason"]],
  ];
  if (isPlainRecord(source.scheduler)) {
    result.scheduler = {
      runtime: pick(
        source.scheduler.runtime,
        [
          "status",
          "phase",
          "pidPresent",
          "placementEnabled",
          "venue",
          "executionPolicyStatus",
          "executionPolicyAuthorizationMode",
          "executionPolicyExpiresAt",
        ],
        "scheduler.runtime.",
      ),
    };
    for (const key of Object.keys(source.scheduler)) {
      if (key !== "runtime") {
        omitted.add(`scheduler.${key}`);
      }
    }
  }
  for (const [section, keys] of sections) {
    const original = source[section];
    if (!isPlainRecord(original)) {
      continue;
    }
    const projected = pick(original, keys, `${section}.`);
    if (Array.isArray(original.accounts)) {
      const accountKeys =
        section === "positionManagement"
          ? [
              "accountId",
              "venue",
              "snapshotRef",
              "observedAt",
              "freshness",
              "uncoveredCount",
              "outsideActiveRuleCount",
              "unresolvedOrderCount",
              "needsInspection",
            ]
          : ["accountId", "venue", "snapshotRef", "status", "netMatchedPnl", "costScope", "basis"];
      projected.accounts = original.accounts.slice(0, 1).map((account) => {
        const selected = pick(account, accountKeys, `${section}.accounts.`);
        if (isPlainRecord(account) && Array.isArray(account.issues)) {
          selected.issues = account.issues
            .filter(
              (issue): issue is string => typeof issue === "string" && jsonBytes(issue) <= 160,
            )
            .slice(0, 2);
        }
        return selected;
      });
      omitted.add(`${section}.accounts.details_or_additional_accounts`);
    }
    result[section] = projected;
  }
  for (const key of Object.keys(result)) {
    omitted.delete(key);
  }
  const annotate = () => {
    result.budgetProjection = {
      kind: "critical_finance_facts",
      originalBytes: jsonBytes(source),
      omittedFieldCount: omitted.size,
      omittedFields: [...omitted].toSorted().slice(0, 6),
      detailReaders: ["finance_position_ledger_read", "finance_strategy_rule_ledger_read"],
      boundary: "partial_observation_not_execution_readiness; omitted_costs_remain_unknown",
    };
  };
  annotate();
  // Account details are optional; never coerce absent measurements into zero or passing verdicts.
  for (const section of [
    "economicFeedback",
    "positionManagement",
    "scheduler",
    "intradayExecution",
  ]) {
    if (jsonBytes(result) <= 2048) {
      break;
    }
    const details = result[section];
    if (isPlainRecord(details) && Object.hasOwn(details, "accounts")) {
      result[section] = Object.fromEntries(
        Object.entries(details).filter(([key]) => key !== "accounts"),
      );
      omitted.add(`${section}.accounts`);
    } else {
      delete result[section];
      omitted.add(section);
    }
    annotate();
  }
  return jsonBytes(result) <= 2048 ? result : undefined;
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
  const value: Record<string, unknown> = {};
  const dropped: { key: string; bytes: number }[] = [];
  // Small decision projections are reserved before finance uses the remaining
  // flexible budget. Keep whole values, including UTF-8 and enclosing JSON costs.
  const priorityKeys = [
    "runtimeFreshness",
    "governanceDigest",
    "learningWorkflow",
    "financeAutomaticLifecycle",
  ];
  const entries = [
    ...priorityKeys
      .filter((key) => Object.hasOwn(controlRoom, key))
      .map((key) => [key, controlRoom[key]] as const),
    ...Object.entries(controlRoom).filter(([key]) => !priorityKeys.includes(key)),
  ];
  for (const [key, originalItem] of entries) {
    let item = originalItem;
    // Result pointers are optional. Reserve the existing decision facts before
    // adding them so an expanded governance digest cannot hide finance risks.
    if (key === "governanceDigest" && isPlainRecord(item) && Array.isArray(item.ownerResults)) {
      const ownerResults = [...item.ownerResults];
      const digest = item;
      let omitted = typeof item.ownerResultsOmitted === "number" ? item.ownerResultsOmitted : 0;
      const finance = controlRoom.financeAutomaticLifecycle;
      const projection = isPlainRecord(finance) ? projectFinanceBudgetFacts(finance) : undefined;
      const facts = projection && jsonBytes(projection) < jsonBytes(finance) ? projection : finance;
      const learning = controlRoom.learningWorkflow;
      const reserved = {
        ...(learning !== undefined && jsonBytes(learning) <= CENTRAL_PERCEPTION_KEY_BUDGET_BYTES
          ? { learningWorkflow: learning }
          : {}),
        ...(facts ? { financeAutomaticLifecycle: facts } : {}),
      };
      while (
        ownerResults.length > 0 &&
        jsonBytes({ ...perception, controlRoom: { ...value, [key]: item, ...reserved } }) > budget
      ) {
        ownerResults.pop();
        omitted += 1;
        item = { ...digest, ownerResults: [...ownerResults], ownerResultsOmitted: omitted };
      }
      if (
        ownerResults.length === 0 &&
        jsonBytes({ ...perception, controlRoom: { ...value, [key]: item, ...reserved } }) > budget
      ) {
        item = Object.fromEntries(
          Object.entries(digest).filter(
            ([field]) => !["ownerResults", "ownerResultsOmitted"].includes(field),
          ),
        );
        dropped.push({
          key: "governanceDigest.ownerResults",
          bytes: jsonBytes(digest.ownerResults),
        });
      }
    }
    const bytes = jsonBytes(item);
    const candidate = { ...value, [key]: item };
    if (
      (key !== "financeAutomaticLifecycle" && bytes > CENTRAL_PERCEPTION_KEY_BUDGET_BYTES) ||
      jsonBytes({ ...perception, controlRoom: candidate }) > budget
    ) {
      const financeFacts =
        key === "financeAutomaticLifecycle" && isPlainRecord(item)
          ? projectFinanceBudgetFacts(item)
          : undefined;
      if (
        financeFacts &&
        jsonBytes({ ...perception, controlRoom: { ...value, [key]: financeFacts } }) <= budget
      ) {
        value[key] = financeFacts;
      } else {
        dropped.push({ key, bytes });
      }
    } else {
      value[key] = item;
    }
  }
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

/** Preserve exactly what the bounded perception carried about Finance. */
export function projectFinancePerceptionEvidence(
  bounded: ReturnType<typeof boundPerception>,
): CentralFinancePerceptionEvidence {
  const summary = bounded.perception.controlRoom.financeAutomaticLifecycle;
  if (isPlainRecord(summary)) {
    return { status: "present", summary };
  }

  const omitted = bounded.report.droppedSections
    .flatMap((section) => section.droppedKeys)
    .find((entry) => entry.key === "financeAutomaticLifecycle");
  return omitted
    ? { status: "omitted_by_budget", omittedBytes: omitted.bytes }
    : { status: "unavailable" };
}
