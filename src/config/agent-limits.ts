import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
// Depth 1 used to mean "every sub-agent is a leaf" — nesting was opt-in via config.
// That made orchestration unreachable unless you knew about the setting, so the
// default is now 2: a depth-1 sub-agent may spawn and inspect its own children.
// Depth stays bounded (and `maxChildrenPerAgent` / `maxConcurrent` cap fan-out),
// so this opens orchestration without allowing unbounded recursion.
// Set `agents.defaults.subagents.maxSpawnDepth: 1` to restore leaf-only behaviour.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 2;

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}
