import { describe, expect, it, vi } from "vitest";
import type { SpawnAcpResult } from "../acp-spawn.js";
import {
  __testing,
  runCodexCodingHarness,
  type CodingHarnessWorkspaceSnapshot,
} from "./codex-acp.js";

function workspace(
  branch: string,
  statusPorcelain = "",
  changedPaths: string[] = [],
  options: { root?: string; headSha?: string; defaultBranch?: string } = {},
): CodingHarnessWorkspaceSnapshot {
  return {
    root: options.root ?? "/tmp/codex-harness-fixture",
    branch,
    defaultBranch: options.defaultBranch ?? "main",
    headSha: options.headSha,
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
    workspaceScope: "confined",
    note: "accepted",
  };
}

function unconfinedAcceptedSpawn(): SpawnAcpResult {
  return { ...acceptedSpawn(), workspaceScope: "host-unconfined" };
}

describe("runCodexCodingHarness", () => {
  it("attributes only paths newly dirty after the executor starts", () => {
    const before = workspace("feature/coding", " M existing.ts", ["existing.ts"]);
    const after = workspace("feature/coding", " M existing.ts\n M added.ts", [
      "existing.ts",
      "added.ts",
    ]);

    expect(__testing.resolveChangedPathsSince(before, after)).toEqual(["added.ts"]);
  });

  it("proves an actual ACP coding run with a changed path and verification", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const spawnAcp = vi.fn(async () => acceptedSpawn());
    const inspectWorkspace = vi
      .fn<() => Promise<CodingHarnessWorkspaceSnapshot>>()
      .mockResolvedValueOnce(workspace("feature/coding"))
      .mockResolvedValueOnce(workspace("feature/coding", " M src/example.ts", ["src/example.ts"]))
      .mockResolvedValueOnce(
        workspace("feature/coding", " M src/example.ts\n M verifier-output.ts", [
          "src/example.ts",
          "verifier-output.ts",
        ]),
      );
    const result = await runCodexCodingHarness(
      {
        task: "add the feature",
        cwd: "/tmp/codex-harness-fixture",
        verify: ["pnpm", "exec", "vitest", "run", "src/example.test.ts"],
      },
      {
        inspectWorkspace,
        spawnAcp,
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
    expect(result.changedPaths).toEqual(["src/example.ts", "verifier-output.ts"]);
    expect(result.verification.status).toBe("passed");
    expect(result.trajectory.projection.status).toBe("completed");
    expect(result.trajectory.projection.historyObserved).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["agent.wait", "chat.history"]);
    expect(spawnAcp).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/codex-harness-fixture", sandbox: "inherit" }),
      expect.anything(),
    );
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
    expect(result.error).toMatch(/default branch|clean/i);
    expect(spawnAcp).not.toHaveBeenCalled();
  });

  it("protects the repository's actual default branch instead of only main/master", async () => {
    const spawnAcp = vi.fn(async () => acceptedSpawn());
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture" },
      {
        inspectWorkspace: async () => workspace("trunk", "", [], { defaultBranch: "trunk" }),
        spawnAcp,
        createRunId: () => "harness-run-default-branch",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toMatch(/default branch/i);
    expect(spawnAcp).not.toHaveBeenCalled();
  });

  it("rejects a relative cwd before workspace resolution", async () => {
    const inspectWorkspace = vi.fn();
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "relative/worktree" },
      {
        inspectWorkspace,
        createRunId: () => "harness-run-relative-cwd",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.cwd).toBe("relative/worktree");
    expect(inspectWorkspace).not.toHaveBeenCalled();
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

  it("retains safely attributable partial edits on timeout", async () => {
    const inspectWorkspace = vi
      .fn<() => Promise<CodingHarnessWorkspaceSnapshot>>()
      .mockResolvedValueOnce(workspace("feature/coding"))
      .mockResolvedValueOnce(workspace("feature/coding", " M partial.ts", ["partial.ts"]));
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture", timeoutMs: 1_000 },
      {
        inspectWorkspace,
        spawnAcp: vi.fn(async () => acceptedSpawn()),
        callGateway: async <T>(options: { method: string }): Promise<T> => {
          if (options.method === "agent.wait") {
            return { status: "timeout" } as T;
          }
          return { ok: true } as T;
        },
        createRunId: () => "harness-run-timeout-partial",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("timed-out");
    expect(result.changedPaths).toEqual(["partial.ts"]);
  });

  it("cleans up an accepted child when waiting fails", async () => {
    const calls: string[] = [];
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture" },
      {
        inspectWorkspace: async () => workspace("feature/coding"),
        spawnAcp: vi.fn(async () => acceptedSpawn()),
        callGateway: async <T>(options: { method: string }): Promise<T> => {
          calls.push(options.method);
          if (options.method === "agent.wait") {
            throw new Error("gateway disconnected");
          }
          return { ok: true } as T;
        },
        createRunId: () => "harness-run-wait-failure",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("failed");
    expect(result.cleanup).toBe("confirmed");
    expect(calls).toEqual(["agent.wait", "sessions.delete"]);
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

  it("does not certify a host ACP run without a confined workspace proof", async () => {
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture", verify: ["pnpm", "test"] },
      {
        inspectWorkspace: vi
          .fn<() => Promise<CodingHarnessWorkspaceSnapshot>>()
          .mockResolvedValueOnce(workspace("feature/coding"))
          .mockResolvedValueOnce(
            workspace("feature/coding", " M src/example.ts", ["src/example.ts"]),
          )
          .mockResolvedValueOnce(
            workspace("feature/coding", " M src/example.ts", ["src/example.ts"]),
          ),
        spawnAcp: vi.fn(async () => unconfinedAcceptedSpawn()),
        callGateway: async <T>(options: { method: string }): Promise<T> => {
          if (options.method === "agent.wait") {
            return { status: "ok" } as T;
          }
          return { messages: [] } as T;
        },
        runVerification: vi.fn(async () => ({ status: "passed" as const })),
        createRunId: () => "harness-run-unconfined",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("completed-unverified");
    expect(result.workspaceScope).toBe("host-unconfined");
    expect(result.error).toMatch(/confined workspace proof/i);
  });

  it("returns an identity-change receipt before attributing committed paths", async () => {
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture" },
      {
        inspectWorkspace: vi
          .fn<() => Promise<CodingHarnessWorkspaceSnapshot>>()
          .mockResolvedValueOnce(workspace("feature/coding", "", [], { headSha: "before" }))
          .mockResolvedValueOnce(
            workspace("other/coding", "", [], { root: "/tmp/other-repo", headSha: "after" }),
          ),
        spawnAcp: vi.fn(async () => acceptedSpawn()),
        callGateway: async <T>(options: { method: string }): Promise<T> => {
          if (options.method === "agent.wait") {
            return { status: "ok" } as T;
          }
          return { messages: [] } as T;
        },
        createRunId: () => "harness-run-identity-change",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("failed");
    expect(result.changedPaths).toEqual([]);
    expect(result.error).toMatch(/identity changed/i);
  });

  it("fails closed when committed-path ownership cannot be proven", async () => {
    const result = await runCodexCodingHarness(
      { task: "edit code", cwd: "/tmp/codex-harness-fixture" },
      {
        inspectWorkspace: vi
          .fn<() => Promise<CodingHarnessWorkspaceSnapshot>>()
          .mockResolvedValueOnce(workspace("feature/coding", "", [], { headSha: "before" }))
          .mockResolvedValueOnce(workspace("feature/coding", "", [], { headSha: "after" })),
        spawnAcp: vi.fn(async () => acceptedSpawn()),
        callGateway: async <T>(options: { method: string }): Promise<T> => {
          if (options.method === "agent.wait") {
            return { status: "ok" } as T;
          }
          return { messages: [] } as T;
        },
        createRunId: () => "harness-run-unsafe-history",
        now: () => "2026-09-03T00:00:00.000Z",
      },
    );

    expect(result.status).toBe("failed");
    expect(result.changedPaths).toEqual([]);
    expect(result.error).toMatch(/HEAD changed.*committed-path attribution/i);
  });
});
