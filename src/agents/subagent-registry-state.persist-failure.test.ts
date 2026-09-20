import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  getSubagentRegistryPersistFailure,
  persistSubagentRunsToDisk,
  resetSubagentRegistryStateForTests,
} from "./subagent-registry-state.js";
import {
  loadSubagentRegistryFromDisk,
  resetSubagentRegistryStoreForTests,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const makeRun = (runId: string): SubagentRunRecord => ({
  runId,
  childSessionKey: `agent:main:subagent:${runId}`,
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: `task for ${runId}`,
  cleanup: "keep",
  createdAt: 1,
});

describe("subagent registry persist: a write that did not happen must be visible", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string | null = null;

  const registryPath = () => path.join(stateDir ?? "", "subagents", "runs.json");

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-persist-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetSubagentRegistryStoreForTests();
    resetSubagentRegistryStateForTests();
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
  });

  afterEach(() => {
    envSnapshot.restore();
    if (stateDir) {
      try {
        fs.chmodSync(path.join(stateDir, "subagents"), 0o700);
      } catch {
        // may not exist
      }
      fs.chmodSync(stateDir, 0o700);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    stateDir = null;
  });

  it("reports a write that was blocked because the registry could not be read", () => {
    fs.writeFileSync(registryPath(), '{"version":2,"runs":{"run-1":', "utf-8");
    loadSubagentRegistryFromDisk();

    const ok = persistSubagentRunsToDisk(new Map([["run-1", makeRun("run-1")]]));

    expect(ok).toBe(false);
    expect(getSubagentRegistryPersistFailure()).toMatchObject({ kind: "blocked" });
  });

  it("reports a write that failed outright", () => {
    // Nothing readable to block on, but the state dir cannot be written to.
    fs.rmSync(path.dirname(registryPath()), { recursive: true, force: true });
    fs.chmodSync(stateDir ?? "", 0o500);

    const ok = persistSubagentRunsToDisk(new Map([["run-1", makeRun("run-1")]]));

    expect(ok).toBe(false);
    const failure = getSubagentRegistryPersistFailure();
    expect(failure?.kind).toBe("write-error");
    expect(failure?.detail.length ?? 0).toBeGreaterThan(0);
  });

  it("clears the failure once a write succeeds", () => {
    fs.writeFileSync(registryPath(), '{"version":2,"runs":{"run-1":', "utf-8");
    loadSubagentRegistryFromDisk();
    expect(persistSubagentRunsToDisk(new Map([["run-1", makeRun("run-1")]]))).toBe(false);

    fs.writeFileSync(registryPath(), `${JSON.stringify({ version: 2, runs: {} })}\n`, "utf-8");
    loadSubagentRegistryFromDisk();

    expect(persistSubagentRunsToDisk(new Map([["run-2", makeRun("run-2")]]))).toBe(true);
    expect(getSubagentRegistryPersistFailure()).toBeNull();
  });
});
