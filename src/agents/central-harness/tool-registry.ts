import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFinanceResearchRunTool } from "../tools/finance-research-run-tool.js";
import type { CentralToolSpec } from "./types.js";
import { CENTRAL_FORBIDDEN_SIDE_EFFECTS } from "./types.js";

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// src/agents/central-harness/ -> repo root is 3 levels up.
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const EXEC_MAX_BUFFER = 48 * 1024 * 1024;

/** A read-only governance owner the LLM brain may propose running. */
type OwnerCommand = Readonly<{
  id: string;
  script: string;
  args: readonly string[];
  boundary: readonly string[];
}>;

/**
 * Read-only governance owners that are safe for the central harness to invoke.
 * These mirror the canonical OWNER_COMMANDS in lcx-governance-autopilot but are
 * declared HERE so the harness never imports that side-effectful module.
 *
 * Coverage contract: every canonical owner whose command is read-only (`--json`,
 * or an explicit `--no-write` variant) must appear here, so the harness really
 * drives the whole owner surface instead of a subset. `selfRepairHands` is the
 * single deliberate exclusion (see CENTRAL_EXCLUDED_WRITE_OWNER_IDS): its
 * command carries write authority, so it stays out of the model-reachable set.
 * `monotonicDataLedger` is registered WITHOUT `--write`, i.e. dry-run only.
 */
const READ_ONLY_OWNERS: readonly OwnerCommand[] = [
  {
    id: "problemRadar",
    script: "scripts/operator/lcx-problem-cluster-radar.ts",
    args: ["--json"],
    boundary: ["research_only", "local_problem_cluster_radar_only"],
  },
  {
    id: "commercialAcceptance",
    script: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    args: ["--json"],
    boundary: ["research_only", "readiness_projection"],
  },
  {
    id: "changeImpact",
    script: "scripts/operator/lcx-change-impact-plan.ts",
    args: ["--json"],
    boundary: ["research_only", "change_impact_plan_only"],
  },
  {
    id: "projectionReaderAudit",
    script: "scripts/operator/lcx-projection-reader-audit.ts",
    args: ["--json"],
    boundary: ["research_only", "projection_reader_audit_only"],
  },
  {
    id: "universeIndex",
    script: "scripts/operator/lcx-universe-index.ts",
    args: ["--json"],
    boundary: ["local_universe_index_only"],
  },
  {
    id: "externalAgentUpgrade",
    script: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
    args: ["--json"],
    boundary: ["research_only", "external_agent_upgrade_radar_only"],
  },
  {
    id: "liveFadeoutAudit",
    script: "scripts/operator/lcx-live-fadeout-audit.ts",
    args: ["--json"],
    boundary: ["research_only", "live_fadeout_audit_only"],
  },
  {
    id: "externalChannelStatus",
    script: "scripts/operator/lcx-external-channel-status.ts",
    args: ["--json"],
    boundary: ["research_only", "local_external_channel_status_only"],
  },
  {
    id: "trainingPlan",
    script: "scripts/operator/local-brain-training-plan.ts",
    args: ["--json"],
    boundary: ["research_only", "local_brain_training_plan_only"],
  },
  {
    id: "skillOptLite",
    script: "scripts/operator/lcx-skillopt-lite.ts",
    args: ["--phase", "candidate-edit", "--no-write", "--json"],
    boundary: ["research_only", "skillopt_candidate_edit_no_write_only"],
  },
  {
    id: "monotonicDataLedger",
    script: "scripts/operator/lcx-monotonic-data-ledger.ts",
    // Dry-run only: the canonical autopilot passes `--write`; the harness never does.
    args: ["--json"],
    boundary: ["local_monotonic_data_ledger_only", "dry_run_no_append"],
  },
  {
    id: "providerCouncilAcceleration",
    script: "scripts/operator/lcx-provider-council-acceleration.ts",
    args: ["--profile", "aggressive", "--no-write", "--json"],
    boundary: ["research_only", "provider_council_dry_run_plan_only"],
  },
  {
    id: "externalChannelBinding",
    script: "scripts/operator/lcx-external-channel-binding.ts",
    args: ["--json"],
    boundary: ["research_only", "local_external_channel_binding_operator_only"],
  },
  {
    id: "mindModel",
    script: "scripts/operator/lcx-mind-model.ts",
    args: ["--json"],
    boundary: ["research_only", "architecture_supervision"],
  },
  {
    id: "flowGraph",
    script: "scripts/operator/lcx-flow-graph.ts",
    args: ["--json"],
    boundary: ["research_only", "waterflow_check"],
  },
  {
    id: "headTail",
    script: "scripts/operator/lcx-head-tail-consistency.ts",
    args: ["--json"],
    boundary: ["research_only", "cross_layer_contract"],
  },
  {
    id: "contextRecovery",
    script: "scripts/operator/lcx-context-recovery-exam.ts",
    args: ["--json"],
    boundary: ["context_recovery_only"],
  },
];

/**
 * Canonical owners deliberately NOT reachable by the LLM brain because their
 * command carries write authority. Kept explicit so the coverage claim stays
 * honest instead of looking like an oversight.
 */
export const CENTRAL_EXCLUDED_WRITE_OWNER_IDS = ["selfRepairHands"] as const;

/** Capability (non-governance) tools registered alongside the owners. */
export const CENTRAL_CAPABILITY_OWNER_IDS = ["finance_research_run"] as const;

export const CENTRAL_GOVERNANCE_OWNER_IDS: readonly string[] = READ_ONLY_OWNERS.map(
  (owner) => owner.id,
);

/** Repo-relative script paths the registry dispatches, for on-disk integrity checks. */
export function centralOwnerScriptPaths(): readonly string[] {
  return READ_ONLY_OWNERS.map((owner) => owner.script);
}

const OWNER_BY_ID = new Map(READ_ONLY_OWNERS.map((owner) => [owner.id, owner]));

/**
 * Arg keys that would let a proposal reach authority the harness must never hand
 * over. Kept aligned with CENTRAL_FORBIDDEN_SIDE_EFFECTS so the gate vocabulary
 * and the declared boundary cannot drift apart:
 *   provider_call          -> provider, apikey, credential, secret, bootstrap
 *   external_message       -> send, sender, external, message, notify, deliver, webhook
 *   trading_action         -> trade, trading, order, execute, live
 *   protected_memory_write -> protected
 * plus write/apply, the generic local-mutation authority. Over-blocking here is
 * harmless by construction: the registry never forwards proposal args to a CLI,
 * so a refused arg costs nothing while an accepted escalation would be recorded
 * as approved authority.
 */
const AUTHORITY_KEY_TOKENS = [
  "write",
  "apply",
  "live",
  "provider",
  "apikey",
  "credential",
  "secret",
  "bootstrap",
  "send",
  "sender",
  "external",
  "message",
  "notify",
  "deliver",
  "webhook",
  "trade",
  "trading",
  "order",
  "execute",
  "protected",
] as const;
/** Values that smuggle a CLI authority flag through an otherwise benign arg. */
const AUTHORITY_VALUE_PATTERN = /--(write|live|bootstrap|provider|send|trade|execute)/iu;

/** Deterministic escalation check shared by owner and capability gates. */
function escalationReason(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const [key, value] of Object.entries(args ?? {})) {
    const lowered = key.toLowerCase();
    if (AUTHORITY_KEY_TOKENS.some((token) => lowered.includes(token))) {
      return `arg key escalates authority: ${key}`;
    }
    if (typeof value === "string" && AUTHORITY_VALUE_PATTERN.test(value)) {
      return `arg value smuggles authority: ${value}`;
    }
  }
  return undefined;
}

/** Deterministic gate. Rejects unknown owners, --write flags, and any arg key
 * that smells like an authority escalation, even if suggested by the LLM. */
function approveOwner(
  ownerId: string,
  args: Readonly<Record<string, unknown>>,
): {
  ok: boolean;
  reason?: string;
} {
  const owner = OWNER_BY_ID.get(ownerId);
  if (!owner) {
    return { ok: false, reason: `unknown or write-authority owner: ${ownerId}` };
  }
  const escalation = escalationReason(args);
  return escalation ? { ok: false, reason: escalation } : { ok: true };
}

async function runOwner(
  owner: OwnerCommand,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  signal.throwIfAborted();
  // The declared arg vector IS the CLI surface. Nothing from the proposal is
  // appended: no owner script accepts an extra flag, so forwarding one would
  // fail closed as `ran_failed` instead of doing anything useful.
  const cliArgs = [...owner.args];
  void args;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", owner.script, ...cliArgs],
    {
      cwd: REPO_ROOT,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );
  signal.throwIfAborted();
  return { output: stdout } as Readonly<Record<string, unknown>>;
}

/**
 * Capability tools: existing agent capabilities exposed to the central loop with
 * the same gate discipline as owners. `finance_research_run` is planning-only
 * here — the gate refuses any `live` argument, because a live run would reach
 * `provider_call`, which CENTRAL_FORBIDDEN_SIDE_EFFECTS rules out for the brain.
 */
function createCapabilityTools(): readonly CentralToolSpec[] {
  const financeResearch = createFinanceResearchRunTool();
  return [
    {
      ownerId: "finance_research_run",
      name: financeResearch.name,
      label: financeResearch.label,
      description: `${financeResearch.description} Central-harness scope: planning only; live provider calls are gated off.`,
      allowedSideEffects: ["local_read", "local_compute", "local_output"],
      boundary: [
        "research_only",
        "planning_only",
        "no_provider_call_from_central_harness",
        "no_execution_authority",
      ],
      approve: (args) => {
        const escalation = escalationReason(args);
        return escalation ? { ok: false, reason: `capability gate: ${escalation}` } : { ok: true };
      },
      execute: async (args, signal) => {
        const result = await financeResearch.execute(
          `central-capability-${randomUUID()}`,
          args,
          signal,
        );
        const details = (result as { details?: unknown } | undefined)?.details;
        return details !== null && typeof details === "object" && !Array.isArray(details)
          ? (details as Record<string, unknown>)
          : { financeResearchRun: true };
      },
    },
  ];
}

/**
 * Build the tool-registry: the full read-only governance owner surface plus the
 * bounded capability layer, so the central loop drives the whole system rather
 * than one slice of it.
 */
export function createCentralToolRegistry(
  options: { execute?: typeof runOwner } = {},
): ReadonlyMap<string, CentralToolSpec> {
  const executeFn = options.execute ?? runOwner;
  const ownerSpecs = READ_ONLY_OWNERS.map((owner) => {
    const spec: CentralToolSpec = {
      ownerId: owner.id,
      name: owner.id,
      label: `Governance owner: ${owner.id}`,
      description: `Run the read-only governance owner '${owner.id}' and surface its JSON receipt. Research-only; no execution or write authority.`,
      allowedSideEffects: ["local_read", "local_compute", "local_output"],
      boundary: owner.boundary,
      approve: (args) => approveOwner(owner.id, args),
      execute: (args, signal) => executeFn(owner, args, signal),
    };
    return [owner.id, spec] as const;
  });
  const capabilitySpecs = createCapabilityTools().map((spec) => [spec.ownerId, spec] as const);
  return new Map([...ownerSpecs, ...capabilitySpecs]);
}

export { approveOwner, escalationReason, CENTRAL_FORBIDDEN_SIDE_EFFECTS };
