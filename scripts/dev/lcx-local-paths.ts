import path from "node:path";

export const LCX_USER_HOME = process.env.LCX_USER_HOME ?? "/Users/liuchengxu";
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
