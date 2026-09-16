import { randomUUID } from "node:crypto";
import type { CentralBrain } from "./model-brain.js";
import type {
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
  runId?: string;
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

  const proposal = await options.brain.propose(options.perception, signal);
  if (proposal.kind === "proposed") {
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
  } else {
    brainCall = {
      provider: "",
      modelId: "",
      outcome: "blocked",
      reason: proposal.reason,
    };
  }

  // Dispatch approved steps strictly sequentially (research-only owners, idempotent reads).
  for (const step of steps) {
    if (step.status !== "approved") {
      continue;
    }
    const spec = observer.get(step.ownerId)!;
    try {
      if (options.execute) {
        // Test/offline override: deterministic execute given the full spec.
        await options.execute(step.ownerId, spec, step.args, signal);
      } else {
        await spec.execute(step.args, signal);
      }
      step.status = "ran_ok";
    } catch {
      step.status = "ran_failed";
    }
    step.finishedAtMs = Date.now();
  }

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
    nextAction: "continue",
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
 * gated, and the brain's own one-line note from the prior turn). This keeps
 * the probe small and lets the next decision inherit prior reasoning.
 */
export type CompactBacklogEntry = Readonly<{
  atMs: number;
  brainOutcome: "completed" | "failed" | "blocked" | "skipped";
  note?: string;
  approved: readonly string[];
  blocked: readonly string[];
}>;

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
  }));
}
