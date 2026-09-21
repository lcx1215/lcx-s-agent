import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import "./test-helpers/fast-core-tools.js";
import * as harness from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
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
        error: expect.stringContaining(
          `cancellation ${cancelled ? "requested" : "not requested"}; completion unconfirmed`,
        ),
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
        error: expect.stringContaining(
          `cancellation ${cancelled ? "requested" : "not requested"}; completion unconfirmed`,
        ),
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0].dispatchState).toBe("uncertain");
      expect(persisted[0].endedAt).toBeUndefined();
      expect(persisted[0].cleanupCompletedAt).toBeUndefined();
    },
  );

  it.each(["transport", "persistence"])(
    "preserves delayed pre-run work after successful delete on %s failure",
    async (failure) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-delayed-"));
      try {
        harness.setSessionsSpawnConfigOverride({
          agents: { defaults: { workspace } },
          tools: { sessions_spawn: { attachments: { enabled: true } } },
        });
        let preparing: SubagentRunRecord | undefined;
        let dispatched = false;
        let deleteAcknowledged = false;
        let runId = "";
        write.mockImplementation((records: Map<string, SubagentRunRecord>) => {
          preparing ??= structuredClone([...records.values()][0]);
          return !(failure === "persistence" && dispatched);
        });
        harness
          .getCallGatewayMock()
          .mockImplementation(
            async (request: { method: string; params?: { idempotencyKey?: string } }) => {
              if (request.method === "agent") {
                dispatched = true;
                runId = request.params?.idempotencyKey ?? "";
                if (failure === "transport") {
                  throw new Error("acknowledgement lost during setup");
                }
                return { runId };
              }
              if (request.method === "sessions.delete") {
                deleteAcknowledged = true;
              }
              return {};
            },
          );
        const tool = await harness.getSessionsSpawnTool({ agentSessionKey: "agent:main:main" });
        const response = await tool.execute("delayed", {
          task: "fixture",
          attachments: [{ name: "input.txt", content: "preserve me" }],
        });
        expect(response.details).toMatchObject({
          status: "error",
          error: expect.stringContaining("cancellation requested; completion unconfirmed"),
        });
        expect(deleteAcknowledged).toBe(true);
        expect(preparing?.dispatchState).toBe("preparing");
        expect(preparing?.attachmentsDir?.startsWith(workspace)).toBe(true);
        const attachment = path.join(preparing!.attachmentsDir!, "input.txt");
        expect(await fs.readFile(attachment, "utf8")).toBe("preserve me");
        // Async setup finishes after delete acknowledged: a real start is still possible.
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: Date.now() },
        });
        await Promise.resolve();
        const record = listSubagentRunsForRequester("agent:main:main").find(
          (entry) => entry.runId === runId,
        );
        expect(record).toMatchObject({ dispatchState: "uncertain" });
        expect(record?.endedAt).toBeUndefined();
        expect(record?.cleanupCompletedAt).toBeUndefined();
        expect(await fs.readFile(attachment, "utf8")).toBe("preserve me");
      } finally {
        resetSubagentRegistryForTests({ persist: false });
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
