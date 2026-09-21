import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueNativeCodingBinding } from "./coding-harness/native-types.js";
import { createNativeSandboxCodingTools } from "./pi-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "./test-helpers/pi-tools-sandbox-context.js";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  defaults: vi.fn(),
  hook: vi.fn(),
  general: vi.fn(),
}));
vi.mock("./bash-tools.js", () => ({
  createExecTool: (defaults: unknown) => {
    mocks.defaults(defaults);
    return {
      name: "exec",
      label: "exec",
      description: "exec",
      parameters: { type: "object", properties: {} },
      execute: mocks.execute,
    };
  },
  createProcessTool: () => {
    throw new Error("process tool forbidden");
  },
}));
vi.mock("./openclaw-tools.js", () => ({ createOpenClawTools: mocks.general }));
vi.mock("./pi-tools.before-tool-call.js", () => ({ wrapToolWithBeforeToolCallHook: mocks.hook }));
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "native-tools-"));
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ content: [], details: { status: "completed" } });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function tools() {
  const binding = issueNativeCodingBinding({
    taskId: "fixture",
    runId: "run",
    sessionId: "session",
    sessionKey: "agent:main:subagent:fixture",
    workspaceDir: root,
    sessionFile: `${root}-receipt`,
    agentDir: `${root}-auth`,
    config: {},
    maxRuntimeMs: 2500,
    sandbox: createPiToolsSandboxContext({
      workspaceDir: root,
      fsBridge: createHostSandboxFsBridge(root),
    }),
  });
  return createNativeSandboxCodingTools({
    binding,
    timeoutMs: 2000,
    abortSignal: new AbortController().signal,
  });
}
describe("native sandbox tools", () => {
  it("constructs only existing sandbox tools without general adapters or hooks", async () => {
    const selected = tools();
    expect(selected.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
    ]);
    await selected
      .find((tool) => tool.name === "write")!
      .execute("write", { path: "fixture.txt", content: "bounded" });
    expect(await fs.readFile(path.join(root, "fixture.txt"), "utf8")).toBe("bounded");
    expect(mocks.general).not.toHaveBeenCalled();
    expect(mocks.hook).not.toHaveBeenCalled();
    expect(mocks.defaults).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "sandbox",
        allowBackground: false,
        elevated: { enabled: false, allowed: false, defaultLevel: "off" },
        notifyOnExit: false,
      }),
    );
  });
  it.each([
    { host: "gateway" },
    { elevated: true },
    { background: true },
    { yieldMs: 1 },
    { timeout: 0 },
    { timeout: -1 },
    { pty: true },
  ])("rejects command boundary escape %j", async (extra) => {
    const exec = tools().find((tool) => tool.name === "exec")!;
    await expect(exec.execute("exec", { command: "echo fixture", ...extra })).rejects.toThrow();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("clamps every command timeout and locks its sandbox host", async () => {
    const exec = tools().find((tool) => tool.name === "exec")!;
    await exec.execute("exec", { command: "echo fixture", timeout: 9999 });
    expect(mocks.execute.mock.calls[0]?.[1]).toMatchObject({
      host: "sandbox",
      elevated: false,
      timeout: 2,
    });
  });
});
