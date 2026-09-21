import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

// Resolve the owner's real home independently of a temporary HOME used by
// isolated checks; callers can still override it explicitly for a sandbox.
export const LCX_USER_HOME = process.env.LCX_USER_HOME?.trim() || os.userInfo().homedir;
export const DEFAULT_LAUNCH_AGENTS_DIR = path.join(LCX_USER_HOME, "Library", "LaunchAgents");
export const DEFAULT_OPENCLAW_LOG_DIR = path.join(LCX_USER_HOME, ".openclaw", "logs");
export const DEFAULT_LAUNCH_AGENT_PATH = [
  path.join(LCX_USER_HOME, ".local", "bin"),
  path.join(LCX_USER_HOME, ".npm-global", "bin"),
  path.join(LCX_USER_HOME, "Library", "pnpm"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(path.delimiter);
export const DEFAULT_WORKSPACE_DIR = path.join(LCX_USER_HOME, ".openclaw", "workspace");
export const DEFAULT_WORKSPACE_LOG_DIR = path.join(DEFAULT_WORKSPACE_DIR, "logs");
export const DEFAULT_GUARD_LOG_PATH = path.join(
  DEFAULT_WORKSPACE_LOG_DIR,
  "minimax-brain-training-guard-medium.jsonl",
);
export const LOCAL_OPERATOR_LATEST_BASENAME = "lcx-local-operator-latest.json";
export const LOCAL_OPERATOR_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  LOCAL_OPERATOR_LATEST_BASENAME,
);

/**
 * This snapshot describes ONE checkout's workflow surface, so it cannot live in
 * a single global path: two worktrees of this repo share that path, overwrite
 * each other's evidence, and then every window is judged against the OTHER
 * checkout's flow graph - a mismatch neither side can ever fix. Each workspace
 * keeps its own copy in its own gitignored `state/` dir instead.
 */
export function localOperatorLatestPathForWorkspace(workspaceDir: string): string {
  return path.join(workspaceDir, "state", LOCAL_OPERATOR_LATEST_BASENAME);
}

/**
 * Prefer the workspace's own snapshot. The shared global path is only a legacy
 * fallback for checkouts whose operator loop still writes there.
 */
export function resolveLocalOperatorLatestPath(workspaceDir: string): string {
  const scoped = localOperatorLatestPathForWorkspace(workspaceDir);
  return fsSync.existsSync(scoped) ? scoped : LOCAL_OPERATOR_LATEST_PATH;
}
export const GOVERNANCE_AUTOPILOT_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-governance-autopilot-latest.json",
);
export const CONTROL_ROOM_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-control-room-latest.json",
);
// Central agent harness surfaces. Declared here so the writer (the harness CLI)
// and every reader (the governance autopilot control-room projection) share one
// canonical path instead of two drifting string literals.
export const CENTRAL_AGENT_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-central-agent-latest.json",
);
export const CENTRAL_AGENT_LOG_JSONL_PATH = path.join(
  DEFAULT_WORKSPACE_LOG_DIR,
  "lcx-central-agent-log-latest.jsonl",
);
// Learning-workflow surface written by the learning_distill capability. Declared
// here (mirroring the capability's own defaults) so the writer and every reader —
// the central-agent perception and the control-room projection — share one name.
export const LEARNING_WORKFLOW_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-learning-workflow-latest.json",
);
export const LEARNING_WORKFLOW_RUNS_DIR = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "learning-workflow",
  "runs",
);
// One immutable snapshot per cycle. The single `latest` file is a pointer, so an
// overlapping run (hourly owner plus a manual invocation) must not be able to
// overwrite another run's evidence.
export const CENTRAL_AGENT_RUNS_DIR = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-central-agent-runs",
);
export const EVOLUTION_PROMOTION_DIGEST_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-evolution-promotion-digest-latest.json",
);
export const MONOTONIC_DATA_LEDGER_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-monotonic-data-ledger-latest.json",
);
export const MONOTONIC_DATA_LEDGER_JSONL_PATH = path.join(
  DEFAULT_WORKSPACE_LOG_DIR,
  "lcx-monotonic-data-ledger.jsonl",
);
export const LOCAL_FAILURE_TRACE_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-local-failure-trace-latest.json",
);
export const LOCAL_FAILURE_TRACE_JSONL_PATH = path.join(
  DEFAULT_WORKSPACE_LOG_DIR,
  "lcx-local-failure-trace.jsonl",
);
export const SELF_REPAIR_HANDS_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-self-repair-hands-latest.json",
);
export const SELF_REPAIR_HANDS_JSONL_PATH = path.join(
  DEFAULT_WORKSPACE_LOG_DIR,
  "lcx-self-repair-hands.jsonl",
);
export const SELF_REPAIR_HANDS_MARKDOWN_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-self-repair-hands-latest.md",
);
export const OWNER_BRIEF_LATEST_JSON_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-owner-brief-latest.json",
);
export const OWNER_BRIEF_LATEST_MARKDOWN_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-owner-brief-latest.md",
);
export const OWNER_CONTROL_MAP_LATEST_JSON_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-owner-control-map-latest.json",
);
export const OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-owner-control-map-latest.md",
);
export const REAL_COST_LEDGER_LATEST_JSON_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-real-cost-ledger-latest.json",
);
export const REAL_COST_LEDGER_LATEST_MARKDOWN_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-real-cost-ledger-latest.md",
);
export const CONTEXT_RECOVERY_HANDOFF_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-context-recovery-handoff-latest.md",
);
export const UNIVERSE_INDEX_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-universe-index-latest.json",
);
export const MULTI_AGENT_PATTERN_SHADOW_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-multi-agent-pattern-shadow-latest.json",
);
export const MULTI_AGENT_PATTERN_SHADOW_JSONL_PATH = path.join(
  DEFAULT_WORKSPACE_LOG_DIR,
  "lcx-multi-agent-pattern-shadow.jsonl",
);
export const MULTI_AGENT_PATTERN_SHADOW_EXPERIMENTS_DIR = path.join(
  DEFAULT_WORKSPACE_DIR,
  "experiments",
  "multi-agent-pattern-shadow",
);
export const MULTI_AGENT_PATTERN_SHADOW_LOCK_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-multi-agent-pattern-shadow.lock",
);
