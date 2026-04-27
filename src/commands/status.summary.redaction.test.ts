import { describe, expect, it } from "vitest";
import { redactSensitiveStatusSummary } from "./status.summary.js";
import type { StatusSummary } from "./status.types.js";

function createRecentSessionRow() {
  return {
    key: "main",
    kind: "direct" as const,
    sessionId: "sess-1",
    updatedAt: 1,
    age: 2,
    totalTokens: 3,
    totalTokensFresh: true,
    remainingTokens: 4,
    percentUsed: 5,
    model: "gpt-5",
    contextTokens: 200_000,
    flags: ["id:sess-1"],
  };
}

describe("redactSensitiveStatusSummary", () => {
  it("removes sensitive session and path details while preserving summary structure", () => {
    const input: StatusSummary = {
      heartbeat: {
        defaultAgentId: "main",
        agents: [{ agentId: "main", enabled: true, every: "5m", everyMs: 300_000 }],
      },
      channelSummary: ["ok"],
      queuedSystemEvents: ["none"],
      lobsterProtocol: {
        defaultMode: "control_room_main_lane",
        executionSubstrate: {
          kind: "openclaw_embedded_agent",
          defaultModel: "moonshot/kimi-k2.6",
          states: ["configured", "connected"],
        },
        lobsterOperatingLayer: {
          kind: "bundled_operating_layer",
          states: ["adapter_implemented", "connected"],
          note: "active",
        },
        lobsterWorkflowRuntime: {
          kind: "optional_plugin",
          enabledByPolicy: false,
          states: ["adapter_implemented", "disabled"],
          note: "optional",
        },
        sessionBoundaries: {
          dmScopeDefault: "main",
          states: ["configured"],
          note: "main",
        },
        protectedAnchors: [
          { path: "memory/current-research-line.md", present: true, states: ["configured"] },
        ],
      },
      sessions: {
        paths: ["/tmp/openclaw/sessions.json"],
        count: 1,
        defaults: {
          model: "gpt-5",
          contextTokens: 200_000,
          builtInDefaultModel: "minimax/MiniMax-M2.7",
          builtInDefaultReason: "minimax_api_key",
        },
        recent: [createRecentSessionRow()],
        byAgent: [
          {
            agentId: "main",
            path: "/tmp/openclaw/main-sessions.json",
            count: 1,
            recent: [createRecentSessionRow()],
          },
        ],
      },
    };

    const redacted = redactSensitiveStatusSummary(input);
    expect(redacted.sessions.paths).toEqual([]);
    expect(redacted.sessions.defaults).toEqual({
      model: null,
      contextTokens: null,
      builtInDefaultModel: "minimax/MiniMax-M2.7",
      builtInDefaultReason: "minimax_api_key",
    });
    expect(redacted.sessions.recent).toEqual([]);
    expect(redacted.sessions.byAgent[0]?.path).toBe("[redacted]");
    expect(redacted.sessions.byAgent[0]?.recent).toEqual([]);
    expect(redacted.heartbeat).toEqual(input.heartbeat);
    expect(redacted.channelSummary).toEqual(input.channelSummary);
    expect(redacted.lobsterProtocol).toEqual(input.lobsterProtocol);
  });
});
