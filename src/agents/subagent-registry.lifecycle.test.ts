import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const { gateway, save, load, events } = vi.hoisted(() => ({
  gateway: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  events: {
    handler: undefined as
      | undefined
      | ((event: { stream: string; runId: string; data: Record<string, unknown> }) => void),
  },
}));
vi.mock("../gateway/call.js", () => ({ callGateway: gateway }));
vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: (handler: typeof events.handler) => {
    events.handler = handler;
    return () => {};
  },
}));
vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } } }),
}));
vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => new Proxy({}, { get: () => ({ sessionId: "fixture" }) }),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/fixture/sessions",
  resolveMainSessionKey: () => "agent:main:main",
  updateSessionStore: vi.fn(),
}));
vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: load,
  saveSubagentRegistryToDisk: save,
  describeSubagentRegistryLoadStatus: () => "fixture-blocked",
}));
vi.mock("./subagent-announce.js", () => ({ runSubagentAnnounceFlow: async () => true }));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
import {
  addSubagentRunForTests,
  confirmSubagentDispatch,
  completeLocalSubagentRun,
  markSubagentRunTerminated,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

const makeRun = (id = "fixture") =>
  ({
    runId: id,
    childSessionKey: `agent:main:subagent:${id}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "fixture",
    cleanup: "keep",
    createdAt: 1,
  }) satisfies SubagentRunRecord;
const runs = () => listSubagentRunsForRequester("agent:main:main");
beforeEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  gateway.mockReset().mockResolvedValue({ status: "pending" });
  save.mockReset().mockReturnValue(true);
  load.mockReset().mockReturnValue(new Map());
});
afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  vi.useRealTimers();
});

describe("subagent lifecycle boundaries", () => {
  it("keeps active children beyond retention and starts retention at terminal completion", async () => {
    registerSubagentRun(makeRun());
    await vi.advanceTimersByTimeAsync(120000);
    expect(runs()[0]?.archiveAtMs).toBeUndefined();
    expect(gateway.mock.calls.some(([request]) => request.method === "sessions.delete")).toBe(
      false,
    );
    events.handler?.({
      stream: "lifecycle",
      runId: "fixture",
      data: { phase: "end", endedAt: Date.now() },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runs()[0]?.archiveAtMs).toBe(181000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(gateway.mock.calls.some(([request]) => request.method === "sessions.delete")).toBe(true);
  });

  it("does not sweep old terminal records with unfinished cleanup or pending descendants", async () => {
    const parent: SubagentRunRecord = { ...makeRun(), endedAt: 1, archiveAtMs: 2 };
    load.mockReturnValue(new Map([[parent.runId, parent]]));
    // Avoid triggering announce on restore by marking it handled but unfinished.
    parent.cleanupHandled = true;
    initSubagentRegistry();
    await vi.advanceTimersByTimeAsync(120000);
    expect(runs()).toHaveLength(1);
    parent.cleanupCompletedAt = 3;
    addSubagentRunForTests({ ...makeRun("child"), requesterSessionKey: parent.childSessionKey });
    await vi.advanceTimersByTimeAsync(60000);
    expect(runs()).toHaveLength(1);
    expect(gateway.mock.calls.some(([request]) => request.method === "sessions.delete")).toBe(
      false,
    );
  });

  it("re-polls a nonterminal timeout, and only completes on a terminal response", async () => {
    gateway
      .mockResolvedValueOnce({ status: "timeout" })
      .mockResolvedValueOnce({ status: "ok", endedAt: 2100 });
    registerSubagentRun(makeRun());
    await vi.advanceTimersByTimeAsync(1);
    expect(runs()[0]?.endedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(gateway.mock.calls.filter(([request]) => request.method === "agent.wait")).toHaveLength(
      2,
    );
    expect(runs()[0]?.outcome?.status).toBe("ok");
  });

  it("clears polling retries on cancellation/reset", async () => {
    gateway.mockResolvedValue({ status: "timeout" });
    registerSubagentRun(makeRun());
    await vi.advanceTimersByTimeAsync(1);
    resetSubagentRegistryForTests({ persist: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("preserves a preparing receipt after restart without replaying dispatch or pruning it", () => {
    const preparing = { ...makeRun(), dispatchState: "preparing" as const };
    load.mockReturnValue(new Map([[preparing.runId, preparing]]));
    initSubagentRegistry();
    expect(runs()[0]?.dispatchState).toBe("preparing");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("does not reset early completion when the dispatch acknowledgement arrives", () => {
    registerSubagentRun({ ...makeRun(), dispatchState: "preparing" });
    events.handler?.({
      stream: "lifecycle",
      runId: "fixture",
      data: { phase: "end", endedAt: 2000 },
    });
    expect(confirmSubagentDispatch("fixture", "fixture")).toBe(true);
    expect(runs()[0]?.endedAt).toBe(2000);
  });
});

describe("local subagent lifecycle", () => {
  it("persists preparing and completion without gateway waits, delivery, or deletion", async () => {
    registerSubagentRun({ ...makeRun(), completionSource: "local", dispatchState: "preparing" });
    expect(save).toHaveBeenCalled();
    expect(confirmSubagentDispatch("fixture", "fixture")).toBe(true);
    expect(completeLocalSubagentRun("fixture", { status: "ok" })).toBe(true);
    expect(runs()[0]).toMatchObject({
      completionSource: "local",
      outcome: { status: "ok" },
      cleanupHandled: true,
    });
    await vi.advanceTimersByTimeAsync(180000);
    expect(gateway).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(1);
  });
  it("restores unfinished local runs as uncertain without replay or orphan deletion", () => {
    load.mockReturnValue(
      new Map([
        ["fixture", { ...makeRun(), completionSource: "local", dispatchState: "dispatched" }],
      ]),
    );
    initSubagentRegistry();
    expect(runs()[0]).toMatchObject({
      dispatchState: "uncertain",
      dispatchError: expect.stringContaining("interrupted"),
    });
    expect(runs()[0]?.endedAt).toBeUndefined();
    expect(gateway).not.toHaveBeenCalled();
  });
  it("reports failed local completion persistence explicitly", () => {
    registerSubagentRun({ ...makeRun(), completionSource: "local", dispatchState: "preparing" });
    confirmSubagentDispatch("fixture", "fixture");
    save.mockReturnValue(false);
    expect(completeLocalSubagentRun("fixture", { status: "ok" })).toBe(false);
    expect(runs()[0]?.dispatchState).toBe("uncertain");
  });
});

it("preserves unrelated disk records without starting their gateway lifecycle", async () => {
  load.mockReturnValue(
    new Map([["old", { ...makeRun("old"), endedAt: 1, cleanupCompletedAt: 1, archiveAtMs: 2 }]]),
  );
  registerSubagentRun({ ...makeRun(), completionSource: "local", dispatchState: "preparing" });
  expect(runs()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(180000);
  expect(runs()).toHaveLength(2);
  expect(gateway).not.toHaveBeenCalled();
});
it("does not infer local completion from an unrelated termination request", () => {
  registerSubagentRun({ ...makeRun(), completionSource: "local", dispatchState: "preparing" });
  confirmSubagentDispatch("fixture", "fixture");
  markSubagentRunTerminated({ runId: "fixture" });
  expect(runs()[0]).toMatchObject({ dispatchState: "uncertain" });
  expect(runs()[0]?.endedAt).toBeUndefined();
});
