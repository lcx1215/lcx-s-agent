/** LCX Central Agent Harness types.
 *
 * The central harness is a single agentic main loop that perceives system
 * state, asks a configurable LLM brain to propose actions, gates those actions
 * with deterministic TypeScript boundary rules, dispatches them to existing
 * owners/capabilities as tools, observes receipts, and settles evidence into
 * the Ledger + control-room snapshot. The LLM only *proposes*; TS gates
 * *approve*. The model never touches provider config, external senders,
 * protected memory, or trading.
 */

/** Authority the central harness will never let the LLM brain or any tool reach. */
export const CENTRAL_FORBIDDEN_SIDE_EFFECTS = [
  "external_message",
  "protected_memory_write",
  "trading_action",
  "provider_call",
] as const;
export type CentralForbiddenSideEffect = (typeof CENTRAL_FORBIDDEN_SIDE_EFFECTS)[number];

export const CENTRAL_ALLOWED_SIDE_EFFECTS = [
  "local_read",
  "local_compute",
  "local_output",
] as const;
export type CentralAllowedSideEffect = (typeof CENTRAL_ALLOWED_SIDE_EFFECTS)[number];

/** An action the LLM brain proposed. Carries ownerId + args + author reasoning.
 * A proposal is NOT yet approved; the harness gate decides. */
export type CentralProposedAction = Readonly<{
  ownerId: string;
  args?: Readonly<Record<string, unknown>>;
  reasoning?: string;
}>;

/** An action after the TS gate approved it, mid-execution.
 * `status`/`finishedAtMs` are mutable because the harness mutates a step as it
 * dispatches and observes it; everything else stays immutable. */
export type CentralStep = {
  stepId: string;
  ownerId: string;
  args: Readonly<Record<string, unknown>>;
  status: "approved" | "blocked_by_gate" | "ran_ok" | "ran_failed" | "skipped";
  boundary?: readonly string[];
  gateReason?: string;
  /**
   * The owner's OWN verdict when it produced a parseable receipt. `ran_ok` means
   * the harness got a receipt; `observedOk: false` means that receipt reported a
   * red light. Kept separate so "we could not run it" never hides behind "it ran
   * and reported not-ok", and vice versa.
   */
  observedOk?: boolean;
  /** Why the harness could not run the owner at all (crash, unparseable output). */
  failureReason?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
};

/** Tool registry entry: wraps an existing owner or capability as a bounded tool. */
export type CentralToolSpec = Readonly<{
  ownerId: string;
  name: string;
  label: string;
  description: string;
  /** Allowed side effects; anything else (esp. forbidden) stays blocked by the gate. */
  allowedSideEffects: readonly CentralAllowedSideEffect[];
  /** Static boundary labels surfaced in receipts (e.g. research_only, no_execution_authority). */
  boundary: readonly string[];
  /** Deterministic gate: given raw args, is this proposal safe to run? */
  approve: (args: Readonly<Record<string, unknown>>) => {
    ok: boolean;
    reason?: string;
  };
  execute: (
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, unknown>>>;
}>;

/** Perceived snapshot fed to the LLM brain so it can decide what to run next. */
export type CentralPerception = Readonly<{
  observedAt: string;
  ownerTotals: Readonly<Record<string, unknown>>;
  controlRoom: Readonly<Record<string, unknown>>;
  backlog: readonly Readonly<Record<string, unknown>>[];
  boundaries: readonly string[];
}>;

/** One perception section that had to be bounded before injection. */
export type CentralContextDroppedSection = Readonly<{
  section: string;
  originalBytes: number;
  keptBytes: number;
  /** Keys left out of the injected context, with the bytes each one cost. */
  droppedKeys: readonly Readonly<{ key: string; bytes: number }>[];
}>;

/**
 * Byte budget applied to the perception handed to the brain. Counts are not a
 * byte guarantee: bounding the backlog to 10 entries says nothing about how many
 * bytes those entries carry. The budget, the injected size, and every dropped key
 * are reported on the receipt so a bounded injection is visible evidence rather
 * than a silent omission — the full snapshot stays on disk either way.
 */
export type CentralContextBudgetReport = Readonly<{
  budgetBytes: number;
  injectedBytes: number;
  /** True when the always-injected sections alone already exceed the budget. */
  overBudget: boolean;
  droppedSections: readonly CentralContextDroppedSection[];
}>;

/** The bounded action batch the brain returns (validated by an output contract). */
export type CentralActionPlan = Readonly<{
  actions: readonly CentralProposedAction[];
  note: string;
}>;

export type CentralRunReceipt = Readonly<{
  schemaVersion: "lcx_central_agent_v1";
  runId: string;
  observedAt: string;
  actionsProposed: number;
  actionsApproved: number;
  actionsBlockedByGate: number;
  steps: readonly CentralStep[];
  boundaries: readonly string[];
  /** Model-call evidence (ModelCallReceipt condensed) — provenance for the brain call. */
  brainCall: Readonly<{
    provider: string;
    modelId: string;
    outcome: "completed" | "failed" | "blocked" | "skipped";
    reason?: string;
    /** Brain's one-line plan note, retained across turns (codex retained-reasoning pattern). */
    note?: string;
  }>;
  nextAction: string;
  /**
   * Byte budget actually applied to the brain's perception this cycle. Present so
   * a reader can tell a bounded injection from an unbounded one without having to
   * re-derive it, and so the dropped keys are named rather than silently missing.
   */
  contextBudget: CentralContextBudgetReport;
  liveTouched: false;
  providerConfigTouched: false;
  protectedMemoryTouched: false;
}>;
