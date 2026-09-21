import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueNativeCodingBinding } from "../../coding-harness/native-types.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "../../test-helpers/pi-tools-sandbox-context.js";
const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  createOriginal: undefined as
    | (typeof import("@mariozechner/pi-coding-agent"))["createAgentSession"]
    | undefined,
  forbidden: vi.fn(() => {
    throw new Error("ambient side effect invoked");
  }),
}));
vi.mock("@mariozechner/pi-coding-agent", async (original) => {
  const actual = await original<typeof import("@mariozechner/pi-coding-agent")>();
  mocks.createOriginal = actual.createAgentSession;
  return { ...actual, createAgentSession: mocks.createSession };
});
vi.mock("../../model-egress.js", () => ({ ensureModelEgressDispatcher: vi.fn() }));
vi.mock("../../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: mocks.forbidden }));
vi.mock("../../sandbox.js", async (original) => ({
  ...(await original<typeof import("../../sandbox.js")>()),
  resolveSandboxContext: mocks.forbidden,
}));
vi.mock("../../cache-trace.js", () => ({ createCacheTrace: mocks.forbidden }));
vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: mocks.forbidden,
}));
vi.mock("../../rollout-summary.js", () => ({ scheduleRolloutSummary: mocks.forbidden }));
vi.mock("../../rollout-distill.js", () => ({ maybeDistillRolloutSummaries: mocks.forbidden }));
vi.mock("../../bootstrap-files.js", async (original) => ({
  ...(await original<typeof import("../../bootstrap-files.js")>()),
  resolveBootstrapContextForRun: mocks.forbidden,
}));
vi.mock("../skills-runtime.js", () => ({ resolveEmbeddedRunSkillEntries: mocks.forbidden }));
import { runEmbeddedAttempt } from "./attempt.js";
let root: string | undefined;
afterEach(async () => {
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});
describe("native attempt assembly", () => {
  it.each(["assembly", "completion"])(
    "isolates native %s from ambient hooks, resources and writes",
    async (phase) => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "native-attempt-"));
      const workspaceDir = path.join(root, "task");
      const agentDir = path.join(root, "auth");
      await fs.mkdir(workspaceDir);
      await fs.mkdir(agentDir);
      const sessionFile = path.join(root, "state", "session.jsonl");
      const sandbox = createPiToolsSandboxContext({
        workspaceDir,
        fsBridge: createHostSandboxFsBridge(workspaceDir),
      });
      const binding = issueNativeCodingBinding({
        taskId: "fixture",
        runId: "run",
        sessionId: "session",
        sessionKey: "agent:main:subagent:fixture",
        workspaceDir,
        sessionFile,
        agentDir,
        config: {},
        sandbox,
        maxRuntimeMs: 1000,
      });
      const authStorage = AuthStorage.inMemory();
      const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
      const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");
      expect(model).toBeDefined();
      mocks.createSession.mockImplementation(async (options) => {
        expect(options.resourceLoader.getSkills().skills).toEqual([]);
        expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
        expect(options.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
        expect(options.settingsManager.getCompactionSettings().enabled).toBe(false);
        expect(options.customTools.map((tool: { name: string }) => tool.name)).toEqual([
          "read",
          "write",
          "edit",
          "apply_patch",
          "exec",
        ]);
        if (phase === "assembly") {
          throw new Error("fixture model boundary");
        }
        const session = await mocks.createOriginal!(options);
        vi.spyOn(session.session, "prompt").mockResolvedValue(undefined);
        return session;
      });
      const cwd = process.cwd();
      const attempt = runEmbeddedAttempt({
        nativeCodingBinding: binding,
        workspaceDir,
        agentDir,
        sessionFile,
        runId: "run",
        sessionId: "session",
        sessionKey: "agent:main:subagent:fixture",
        prompt: "fixture",
        provider: "anthropic",
        modelId: model!.id,
        model: model!,
        authStorage,
        modelRegistry,
        thinkLevel: "off",
        timeoutMs: 1000,
      });
      if (phase === "assembly") {
        await expect(attempt).rejects.toThrow("fixture model boundary");
      } else {
        await expect(attempt).resolves.toMatchObject({
          promptCompleted: true,
          aborted: false,
          timedOut: false,
        });
      }
      expect(mocks.createSession).toHaveBeenCalledOnce();
      expect(mocks.forbidden).not.toHaveBeenCalled();
      expect(process.cwd()).toBe(cwd);
      expect(await fs.readdir(agentDir)).toEqual([]);
    },
  );
});
