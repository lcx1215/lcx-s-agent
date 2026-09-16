import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
 * declared HERE so the harness never imports that side-effectful module. Only
 * --json (no --write) owners that never touch provider/external/protected memory
 * are eligible; write-authority owners are deliberately excluded.
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
    id: "universeIndex",
    script: "scripts/operator/lcx-universe-index.ts",
    args: ["--json"],
    boundary: ["local_universe_index_only"],
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

const OWNER_BY_ID = new Map(READ_ONLY_OWNERS.map((owner) => [owner.id, owner]));

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
  for (const [key, value] of Object.entries(args ?? {})) {
    const lowered = key.toLowerCase();
    if (
      ["write", "live", "provider", "sender", "trade", "execute", "protected"].some((token) =>
        lowered.includes(token),
      )
    ) {
      return { ok: false, reason: `arg key escalates authority: ${key}` };
    }
    if (typeof value === "string" && /--(write|live|bootstrap|provider)/iu.test(value)) {
      return { ok: false, reason: `arg value smuggles authority: ${value}` };
    }
  }
  return { ok: true };
}

async function runOwner(
  owner: OwnerCommand,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  signal.throwIfAborted();
  // Only whitelisted boolean/default args are honored; everything else is ignored
  // so the LLM cannot inject arbitrary CLI flags.
  const cliArgs = [...owner.args];
  if (args.showDiagnostics === true) {
    cliArgs.push("--show-diagnostics");
  }
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

/** Build the tool-registry: read-only governance owners exposed as central tools. */
export function createCentralToolRegistry(
  options: { execute?: typeof runOwner } = {},
): ReadonlyMap<string, CentralToolSpec> {
  const executeFn = options.execute ?? runOwner;
  const specs = READ_ONLY_OWNERS.map((owner) => {
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
  return new Map(specs);
}

export { approveOwner, CENTRAL_FORBIDDEN_SIDE_EFFECTS };
