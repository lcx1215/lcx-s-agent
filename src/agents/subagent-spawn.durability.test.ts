import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import * as harness from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const { write } = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("./subagent-registry.store.js", () => ({
  describeSubagentRegistryLoadStatus: () => "fixture-blocked",
  getSubagentRegistryLoadStatus: () => ({ state: "ok" }),
  loadSubagentRegistryFromDisk: () => new Map(),
  saveSubagentRegistryToDisk: (runs: Map<string, SubagentRunRecord>) => write(runs),
}));

beforeEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  harness.resetSessionsSpawnConfigOverride();
  harness.getCallGatewayMock().mockReset();
  write.mockReset().mockReturnValue(true);
});
afterEach(() => resetSubagentRegistryForTests({ persist: false }));

async function spawn() {
  const tool = await harness.getSessionsSpawnTool({ agentSessionKey: "agent:test:main" });
  return (await tool.execute("durability", { task: "isolated fixture" })).details;
}

describe("sessions_spawn durable dispatch", () => {
  it("does not dispatch or claim acceptance when preparing cannot be persisted", async () => {
    write.mockReturnValue(false);
    const gateway = harness.setupSessionsSpawnGatewayMock({});
    expect(await spawn()).toMatchObject({
      status: "error",
      error: expect.stringContaining("dispatch blocked"),
    });
    expect(gateway.calls.some((call) => call.method === "agent")).toBe(false);
  });

  it("stores preparing state before the agent call and commits its acknowledged run id", async () => {
    let persisted: SubagentRunRecord[] = [];
    write.mockImplementation((runs: Map<string, SubagentRunRecord>) => {
      persisted = structuredClone([...runs.values()]);
      return true;
    });
    harness.setupSessionsSpawnGatewayMock({
      onAgentSubagentSpawn: (params) => {
        const request = params as { idempotencyKey: string };
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({
          runId: request.idempotencyKey,
          dispatchState: "preparing",
        });
        expect(persisted[0].startedAt).toBeUndefined();
      },
    });
    expect(await spawn()).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(
      persisted.some((run) => run.runId === "run-1" && run.dispatchState === "dispatched"),
    ).toBe(true);
  });

  it.each([true, false])(
    "reports acknowledged-but-unpersisted dispatch with cancellation=%s",
    async (cancelled) => {
      write.mockReturnValueOnce(true).mockReturnValue(false);
      const calls: string[] = [];
      harness.getCallGatewayMock().mockImplementation(async (request: { method: string }) => {
        calls.push(request.method);
        if (request.method === "agent") {
          return { runId: "acknowledged" };
        }
        if (request.method === "sessions.delete" && !cancelled) {
          throw new Error("unavailable");
        }
        return {};
      });
      expect(await spawn()).toMatchObject({
        status: "error",
        error: expect.stringContaining(`cancellation ${cancelled ? "confirmed" : "unconfirmed"}`),
      });
      expect(calls.filter((method) => method === "agent")).toHaveLength(1);
      expect(calls).toContain("sessions.delete");
    },
  );

  it.each([true, false])(
    "records the actual cancellation result after dispatch transport failure: %s",
    async (cancelled) => {
      let persisted: SubagentRunRecord[] = [];
      write.mockImplementation((runs: Map<string, SubagentRunRecord>) => {
        persisted = structuredClone([...runs.values()]);
        return true;
      });
      harness.getCallGatewayMock().mockImplementation(async (request: { method: string }) => {
        if (request.method === "agent") {
          throw new Error("acknowledgement lost");
        }
        if (request.method === "sessions.delete" && !cancelled) {
          throw new Error("cancel unavailable");
        }
        return {};
      });
      expect(await spawn()).toMatchObject({
        status: "error",
        error: expect.stringContaining(`cancellation ${cancelled ? "confirmed" : "unconfirmed"}`),
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0].dispatchState).toBe("uncertain");
      expect(Boolean(persisted[0].endedAt)).toBe(cancelled);
    },
  );
});
