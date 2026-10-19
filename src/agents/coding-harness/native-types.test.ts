import { expect, it } from "vitest";
import {
  issueNativeCodingBinding,
  resolveTrustedNativeCodingBinding,
  revokeNativeCodingBinding,
} from "./native-types.js";
it("rejects forged/revoked bindings and freezes detached configuration", () => {
  expect(() => resolveTrustedNativeCodingBinding({ kind: "native-coding-run" })).toThrow("forged");
  const config = { agents: { defaults: { workspace: "/original" } } };
  const binding = issueNativeCodingBinding({
    taskId: "task",
    runId: "run",
    sessionId: "session",
    sessionKey: "agent:fixture:subagent:run",
    workspaceDir: "/task",
    sessionFile: "/state/session",
    agentDir: "/auth",
    config,
    maxRuntimeMs: 1000,
    sandbox: {
      enabled: true,
      sessionKey: "session",
      workspaceDir: "/task",
      agentWorkspaceDir: "/task",
      workspaceAccess: "rw",
      containerName: "id",
      containerWorkdir: "/workspace",
      docker: {
        image: "fixture",
        containerPrefix: "fixture",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: [],
        network: "none",
        capDrop: ["ALL"],
      },
      tools: { allow: ["exec"] },
      browserAllowHostControl: false,
    },
  });
  config.agents.defaults.workspace = "/changed";
  const view = resolveTrustedNativeCodingBinding(binding);
  expect(view.config.agents?.defaults?.workspace).toBe("/original");
  expect(Object.isFrozen(view.config.agents?.defaults)).toBe(true);
  revokeNativeCodingBinding(binding);
  expect(() => resolveTrustedNativeCodingBinding(binding)).toThrow("revoked");
});
