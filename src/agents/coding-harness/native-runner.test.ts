import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPiToolsSandboxContext } from "../test-helpers/pi-tools-sandbox-context.js";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  register: vi.fn(),
  confirm: vi.fn(),
  complete: vi.fn(),
  failure: vi.fn(),
}));
vi.mock("../pi-embedded-runner/run.js", () => ({ runEmbeddedPiAgent: mocks.run }));
vi.mock("../subagent-registry.js", () => ({
  registerSubagentRun: mocks.register,
  confirmSubagentDispatch: mocks.confirm,
  completeLocalSubagentRun: mocks.complete,
  recordSubagentDispatchFailure: mocks.failure,
}));
import { runNativeCodingAgent } from "./native-runner.js";
import { issueNativeCodingBinding, revokeNativeCodingBinding } from "./native-types.js";
function input() {
  const binding = issueNativeCodingBinding({
    taskId: "fixture",
    runId: "run-fixture",
    sessionId: "session-fixture",
    sessionKey: "agent:main:subagent:fixture",
    workspaceDir: "/fixture",
    sessionFile: "/receipt/fixture.jsonl",
    agentDir: "/auth",
    sandbox: createPiToolsSandboxContext({ workspaceDir: "/fixture" }),
    config: {},
    maxRuntimeMs: 1000,
  });
  return {
    binding,
    task: "fixture",
    requesterSessionKey: "agent:main:main",
    signal: new AbortController().signal,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.register.mockReset();
  mocks.confirm.mockReturnValue(true);
  mocks.complete.mockReturnValue(true);
  mocks.run.mockResolvedValue({
    meta: { durationMs: 1, promptCompleted: true, stopReason: "stop" },
  });
});
describe("native coding runner orchestration", () => {
  it("persists before dispatch, clamps timeout, and records terminal evidence", async () => {
    mocks.run.mockImplementation(async (params) => {
      expect(mocks.register).toHaveBeenCalledWith(
        expect.objectContaining({ dispatchState: "preparing", completionSource: "local" }),
      );
      expect(mocks.confirm).toHaveBeenCalled();
      expect(params.timeoutMs).toBe(1000);
      return { meta: { durationMs: 1, promptCompleted: true, stopReason: "stop" } };
    });
    expect(await runNativeCodingAgent({ ...input(), timeoutMs: 99999 })).toMatchObject({
      status: "completed",
      executionStarted: true,
    });
    expect(mocks.complete).toHaveBeenCalledWith("run-fixture", { status: "ok" });
  });
  it("blocks forged and revoked bindings without registration or execution", async () => {
    const request = input();
    revokeNativeCodingBinding(request.binding);
    expect(await runNativeCodingAgent(request)).toMatchObject({
      status: "blocked",
      executionStarted: false,
    });
    expect(
      await runNativeCodingAgent({ ...input(), binding: { kind: "native-coding-run" } }),
    ).toMatchObject({ status: "blocked" });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("blocks preparing and confirmation persistence failures before execution", async () => {
    mocks.register.mockImplementationOnce(() => {
      throw new Error("blocked persistence");
    });
    expect(await runNativeCodingAgent(input())).toMatchObject({
      status: "blocked",
      executionStarted: false,
    });
    mocks.confirm.mockReturnValue(false);
    expect(await runNativeCodingAgent(input())).toMatchObject({
      status: "blocked",
      executionStarted: false,
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("cannot reuse a dispatch capability, and cannot claim completion after receipt failure", async () => {
    const request = input();
    mocks.complete.mockReturnValue(false);
    expect(await runNativeCodingAgent(request)).toMatchObject({ status: "interrupted" });
    expect(await runNativeCodingAgent(request)).toMatchObject({ status: "blocked" });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("reports context limits without fallback dispatch", async () => {
    mocks.run.mockRejectedValueOnce(new Error("native-context-limit"));
    expect(await runNativeCodingAgent(input())).toMatchObject({ status: "context-limit" });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});

it.each(["toolUse", "tool_calls", "error", "aborted", "length"])(
  "does not claim completed for unfinished stop reason %s",
  async (stopReason) => {
    mocks.run.mockResolvedValueOnce({ meta: { durationMs: 1, promptCompleted: true, stopReason } });
    expect(await runNativeCodingAgent(input())).toMatchObject({ status: "failed" });
  },
);
it("rejects pending tools even when the stop reason says stop", async () => {
  mocks.run.mockResolvedValueOnce({
    meta: {
      durationMs: 1,
      promptCompleted: true,
      stopReason: "stop",
      pendingToolCalls: [{ id: "pending", name: "exec", arguments: "{}" }],
    },
  });
  expect(await runNativeCodingAgent(input())).toMatchObject({ status: "failed" });
});
