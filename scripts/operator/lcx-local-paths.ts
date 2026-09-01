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
export const LOCAL_OPERATOR_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-local-operator-latest.json",
);
export const GOVERNANCE_AUTOPILOT_LATEST_PATH = path.join(
  DEFAULT_WORKSPACE_DIR,
  "state",
  "lcx-governance-autopilot-latest.json",
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
