import "./run.overflow-compaction.mocks.shared.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markAuthProfileGood, markAuthProfileUsed } from "../auth-profiles.js";
import { issueNativeCodingBinding } from "../coding-harness/native-types.js";
import { ensureAuthProfileStore, getApiKeyForModel } from "../model-auth.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { createPiToolsSandboxContext } from "../test-helpers/pi-tools-sandbox-context.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult, makeOverflowError } from "./run.overflow-compaction.fixture.js";
import { mockedGlobalHookRunner } from "./run.overflow-compaction.mocks.shared.js";
import {
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.shared-test.js";
let root: string;
function binding() {
  return issueNativeCodingBinding({
    taskId: "fixture",
    runId: "native-run",
    sessionId: "native-session",
    sessionKey: "agent:main:subagent:native",
    workspaceDir: root,
    sessionFile: path.join(root, "session.jsonl"),
    agentDir: path.join(root, "auth"),
    config: {},
    maxRuntimeMs: 1000,
    sandbox: createPiToolsSandboxContext({ workspaceDir: root }),
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "native-run-policy-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
describe("embedded native run policy", () => {
  it("binds workspace identity and uses readonly auth without hooks or global writes", async () => {
    mockedGlobalHookRunner.hasHooks.mockReturnValue(true);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const cwd = process.cwd();
    await runEmbeddedPiAgent({ ...overflowBaseRunParams, nativeCodingBinding: binding() });
    expect(ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(markAuthProfileGood).not.toHaveBeenCalled();
    expect(markAuthProfileUsed).not.toHaveBeenCalled();
    expect(mockedGlobalHookRunner.hasHooks).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore).toHaveBeenCalledWith(path.join(root, "auth"), {
      allowKeychainPrompt: false,
      readOnly: true,
    });
    expect(getApiKeyForModel).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: root,
        runId: "native-run",
        sessionFile: path.join(root, "session.jsonl"),
        timeoutMs: 1000,
      }),
    );
    expect(process.cwd()).toBe(cwd);
  });
  it("returns context-limit without invoking overflow compaction", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: makeOverflowError() }),
    );
    await expect(
      runEmbeddedPiAgent({ ...overflowBaseRunParams, nativeCodingBinding: binding() }),
    ).rejects.toThrow("native-context-limit");
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });
});
