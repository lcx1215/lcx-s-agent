import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.js";
import { createConfiguredFinanceModelAdapter } from "../configured-finance-model-adapter.js";
import { financeBrainModuleCatalog } from "../finance-brain-orchestration.js";
import {
  type CentralActionPlan,
  type CentralPerception,
  type CentralProposedAction,
} from "./types.js";

export type CentralBrainOutcome =
  | { kind: "proposed"; plan: CentralActionPlan; provider: string; modelId: string }
  | { kind: "blocked_no_provider"; reason: string };

export type CentralBrain = Readonly<{
  propose: (perception: CentralPerception, signal: AbortSignal) => Promise<CentralBrainOutcome>;
}>;

export const CENTRAL_BRAIN_PROMPT_CACHE_PREFIX = [
  "You are the LCX Agent central harness brain.",
  "You perceive current system state and propose the next bounded batches of owner/capability actions.",
  "You ONLY propose. A deterministic TypeScript gate approves or blocks every proposal.",
  "You have research-only authority and zero execution authority.",
  "Never propose changing provider/API configuration, sending external messages, writing protected memory, or any trading action.",
  "Return one single-line JSON object only. No prose, no markdown, no thinking blocks.",
].join("\n");

/** Trusted, source-derived capability context; separate from volatile perception. */
export const CENTRAL_FINANCE_CATALOG_BUDGET_BYTES = 8_192;

export function buildCentralFinanceCatalog(): string {
  const catalog = [
    "Finance capability: finance_research_run (planning only).",
    'Use the exact action ownerId "finance_research_run". "finance" is not a registered owner; never abbreviate or invent tool names.',
    'Action shape: {"ownerId":"finance_research_run","args":{"ask":"<copy the task question>","asOf":"<copy the task timestamp>","moduleSelection":{"moduleIds":["<registered module ID>"],"rationale":"<task-specific reason>","composition":{"nodes":[{"id":"<node>","moduleId":"<registered module ID>","dependsOn":["<node>"]}],"maxReplans":0}}},"reasoning":"<why this planning action>"}.',

    "Required args: ask (research question), asOf (explicit ISO timestamp).",
    "Optional moduleSelection: {moduleIds: [registered IDs in preferred order], rationale: nonempty string, composition?: {nodes: [{id, moduleId, dependsOn}], maxReplans?: 0..2}}. The composition is a finite DAG: max 24 nodes, max 48 edges, max depth 8, max 24 dependencies per node, no cycles, and it must include every selected module. Required memory, causal, math, and risk lanes are hard and are inserted by the controller; selected analytical lanes are soft and may be revised only within the bounded replan budget. No authority-changing fields or duplicate IDs.",
    "Omit moduleSelection to use rule-based routing. Propose a composition when the question or prior evidence warrants it; do not select everything by default.",
    "Omit live: central tools cannot call providers or place orders. Selection does not change source targets or bypass risk/evidence/review gates.",
    "Modules are analytical lenses, not proof of tool execution. Inspect prior composition/status/missingEvidence feedback before revising or stopping.",
    "When composition feedback is replan_soft, revise only the soft analytical nodes within remainingSoftReplans. When it is blocked_hard or soft_replan_budget_exhausted with nextAction stop, do not retry by changing hard lanes or pretending the run completed.",
    "Registered modules (ID and role):",
    JSON.stringify(financeBrainModuleCatalog().map(({ id, role }) => ({ id, role }))),
  ].join("\n");
  // Fail closed on catalog growth instead of silently dropping valid module IDs.
  if (Buffer.byteLength(catalog) > CENTRAL_FINANCE_CATALOG_BUDGET_BYTES) {
    throw new Error("central finance discovery catalog exceeds its context budget");
  }
  return catalog;
}

export function buildCentralBrainPrompt(perception: CentralPerception): string {
  return [
    CENTRAL_BRAIN_PROMPT_CACHE_PREFIX,
    "",
    buildCentralFinanceCatalog(),
    "",
    "Perceived state:",
    `observed_at: ${perception.observedAt}`,
    `boundaries: ${perception.boundaries.join(", ")}`,
    `owner_totals: ${JSON.stringify(perception.ownerTotals)}`,
    `control_room_summary: ${JSON.stringify(perception.controlRoom)}`,
    ...(perception.backlog.length > 0
      ? [`backlog: ${JSON.stringify(perception.backlog.slice(0, 10))}`]
      : ["backlog: none"]),
    "",
    'Respond with exactly: {"actions":[{"ownerId":"<owner id>","args":{},"reasoning":"<short why>"}],"note":"<one-line plan>"}',
    "If no action is warranted, respond with actions: [] and a note explaining why.",
  ].join("\n");
}

/** Parse + validate the brain's raw output into a CentralActionPlan. */
export function validateCentralActionPlan(raw: unknown): CentralActionPlan {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("central brain output must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.actions)) {
    throw new Error("central brain output requires an actions array");
  }
  const actions: CentralProposedAction[] = [];
  for (const entry of record.actions) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("central brain action must be an object");
    }
    const action = entry as Record<string, unknown>;
    if (typeof action.ownerId !== "string" || action.ownerId.trim().length === 0) {
      throw new Error("central brain action requires a valid ownerId");
    }
    if (
      action.args !== undefined &&
      (typeof action.args !== "object" || action.args === null || Array.isArray(action.args))
    ) {
      throw new Error("central brain action args must be an object");
    }
    actions.push({
      ownerId: action.ownerId.trim(),
      ...(action.args ? { args: action.args as Record<string, unknown> } : {}),
      ...(typeof action.reasoning === "string"
        ? { reasoning: action.reasoning.slice(0, 400) }
        : {}),
    });
  }
  return {
    actions,
    note: typeof record.note === "string" ? record.note.slice(0, 400) : "no note",
  };
}

/**
 * Build the central decision brain. If a configurable finance model exists in
 * config, it is used for real reasoning via the configured adapter; the model
 * can only be called for the brain's own decision (never by tools). If no
 * provider/model is configured, the brain honestly reports blocked_no_provider
 * instead of fabricating inference.
 */
export function createCentralBrain(
  cfg: OpenClawConfig,
  options: {
    maxTokens?: number;
    timeoutMs?: number;
    maxCalls?: number;
    /** Force a specific model reference (provider/model). Optional. */
    modelRef?: string;
    /** Inject a model ref to disable provider use (e.g. tests/offline). */
    adapterDisabled?: boolean;
  } = {},
): CentralBrain {
  let invoke: ((payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
  let provider = "";
  let modelId = "";
  /**
   * Why the configured adapter could not be built, kept verbatim.
   *
   * The bare `catch` that used to stand here discarded the error and then
   * reported "no configurable finance provider/model available for brain
   * inference" — a claim about configuration that nothing had checked, and the
   * only remaining explanation for a cycle that decided nothing. Measured: 9 of
   * 14 recorded cycles reported exactly that string, while the same resolution
   * succeeds 40/40 in both the interactive shell and the hourly loop's minimal
   * environment, so the discarded error was the sole evidence of the real cause
   * and it was thrown away. Naming it costs one string and makes the next idle
   * cycle explain itself.
   */
  let adapterError: string | undefined;
  if (!options.adapterDisabled) {
    try {
      const adapter = createConfiguredFinanceModelAdapter(cfg, {
        maxTokens: options.maxTokens ?? 4_096,
        timeoutMs: options.timeoutMs ?? 120_000,
        maxCalls: options.maxCalls ?? 12,
        modelRef: options.modelRef,
        buildPrompt: (payload: unknown) => buildCentralBrainPrompt(payload as CentralPerception),
      });
      provider = adapter.provider;
      modelId = adapter.modelId;
      invoke = (payload, signal) => {
        // adapter.invoke expects { callId, correlationId, taskId, role, attempt, provider, modelId, payload }.
        const request = {
          callId: `central-brain-${randomUUID()}`,
          correlationId: `central-${randomUUID()}`,
          taskId: "central-harness",
          role: "final_precheck",
          attempt: 1,
          provider: adapter.provider,
          modelId: adapter.modelId,
          payload,
        } as Parameters<typeof adapter.invoke>[0];
        return adapter.invoke(request, signal);
      };
    } catch (error) {
      provider = "";
      modelId = "";
      invoke = undefined;
      adapterError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    }
  }
  const callable = provider !== "" && modelId !== "" && invoke !== undefined;
  return {
    propose: async (perception, signal) => {
      if (!callable) {
        return {
          kind: "blocked_no_provider",
          reason: adapterError
            ? `central brain has no usable finance model: ${adapterError}`
            : "no configurable finance provider/model available for brain inference",
        };
      }
      // callable already proved invoke is set; assert to satisfy TS across the closure.
      const raw = await invoke!(perception, signal);
      const plan = validateCentralActionPlan(raw);
      return { kind: "proposed", plan, provider, modelId };
    },
  };
}
