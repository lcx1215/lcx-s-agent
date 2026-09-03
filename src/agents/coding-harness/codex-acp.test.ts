import { describe, expect, it, vi } from "vitest";
import type { SpawnAcpResult } from "../acp-spawn.js";
import { runCodexCodingHarness, type CodingHarnessWorkspaceSnapshot } from "./codex-acp.js";

function workspace(
  branch: string,
  statusPorcelain = "",
  changedPaths: string[] = [],
): CodingHarnessWorkspaceSnapshot {
  return {
    root: "/tmp/codex-harness-fixture",
    branch,
    statusPorcelain,
    changedPaths,
  };
}

function acceptedSpawn(): SpawnAcpResult {
  return {
    status: "accepted",
    childSessionKey: "agent:codex:acp:child-1",
    runId: "child-run-1",
    mode: "run",
    note: "accepted",
  };
}

describe("runCodexCodingHarness", () => {
  it("proves an actual ACP coding run with a changed path and verification", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const inspectWorkspace = vi
      .fn<() => Promise<CodingHarnessWorkspaceSnapshot>>()
      .mockResolvedValueOnce(workspace("feature/coding"))
      .mockResolvedValueOnce(workspace("feature/coding", " M src/example.ts", ["src/example.ts"]));
    const result = await runCodexCodingHarness(
      {
        task: "add the feature",
        cwd: "/tmp/codex-harness-fixture",
        verify: ["pnpm", "exec", "vitest", "run", "src/example.test.ts"],
      },
      {
        inspectWorkspace,
        spawnAcp: vi.fn(async () => acceptedSpawn()),
        callGateway: async <T>(options: { method: string; params?: unknown }): Promise<T> => {
          calls.push(options);
          if (options.method === "agent.wait") {
            return { status: "ok" } as T;
          }
          if (options.method === "chat.history") {
            return {
              messages: [
                { role: "assistant", content: [{ type: "text", text: "changed and tested" }] },
              ],
            } as T;
          }
          throw new Error(`unexpected method ${options.method}`);
        },
        runVerification: vi.fn(async () => ({
          status: "passed" as const,
          command: ["pnpm", "test"],
        })),
        createRunId: () => "harness-run-1",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("verified");
    expect(result.actualExecutor).toBe(true);
    expect(result.changedPaths).toEqual(["src/example.ts"]);
    expect(result.verification.status).toBe("passed");
    expect(result.trajectory.projection.status).toBe("completed");
    expect(result.trajectory.projection.historyObserved).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["agent.wait", "chat.history"]);
  });

  it("refuses a dirty or protected worktree before starting Codex", async () => {
    const spawnAcp = vi.fn(async () => acceptedSpawn());
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture" },
      {
        inspectWorkspace: async () => workspace("main", " M existing.ts", ["existing.ts"]),
        spawnAcp,
        createRunId: () => "harness-run-2",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.actualExecutor).toBe(false);
    expect(result.error).toMatch(/non-main|clean/i);
    expect(spawnAcp).not.toHaveBeenCalled();
  });

  it("times out and requests cleanup instead of claiming completion", async () => {
    const calls: string[] = [];
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture", timeoutMs: 1_000 },
      {
        inspectWorkspace: async () => workspace("feature/coding"),
        spawnAcp: vi.fn(async () => acceptedSpawn()),
        callGateway: async <T>(options: { method: string }): Promise<T> => {
          calls.push(options.method);
          if (options.method === "agent.wait") {
            return { status: "timeout" } as T;
          }
          return { ok: true } as T;
        },
        createRunId: () => "harness-run-3",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("timed-out");
    expect(result.actualExecutor).toBe(true);
    expect(result.cleanup).toBe("confirmed");
    expect(calls).toEqual(["agent.wait", "sessions.delete"]);
    expect(result.trajectory.projection.status).toBe("timed-out");
  });

  it("does not call an unrequested verifier or claim a verified change", async () => {
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture" },
      {
        inspectWorkspace: vi
          .fn<() => Promise<CodingHarnessWorkspaceSnapshot>>()
          .mockResolvedValueOnce(workspace("feature/coding"))
          .mockResolvedValueOnce(
            workspace("feature/coding", " M src/example.ts", ["src/example.ts"]),
          ),
        spawnAcp: vi.fn(async () => acceptedSpawn()),
        callGateway: async <T>(options: { method: string }): Promise<T> => {
          if (options.method === "agent.wait") {
            return { status: "ok" } as T;
          }
          return { messages: [] } as T;
        },
        runVerification: vi.fn(),
        createRunId: () => "harness-run-4",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("completed-unverified");
    expect(result.verification.status).toBe("not-requested");
    expect(result.trajectory.projection.status).toBe("completed-unverified");
  });
});
