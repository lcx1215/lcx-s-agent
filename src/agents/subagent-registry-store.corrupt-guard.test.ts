import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  getSubagentRegistryLoadStatus,
  loadSubagentRegistryFromDisk,
  resolveSubagentRegistryPath,
  resetSubagentRegistryStoreForTests,
  saveSubagentRegistryToDisk,
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

describe("subagent registry store: a source that cannot be read must not be overwritten", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string | null = null;

  const registryPath = () => {
    if (!stateDir) {
      throw new Error("stateDir not initialized");
    }
    return path.join(stateDir, "subagents", "runs.json");
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-registry-store-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetSubagentRegistryStoreForTests();
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
  });

  afterEach(() => {
    envSnapshot.restore();
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    stateDir = null;
  });

  it("reports a truncated registry as corrupt instead of an empty registry", () => {
    const corrupted = '{"version":2,"runs":{"run-1":{"runId":"run-1"';
    fs.writeFileSync(registryPath(), corrupted, "utf-8");

    expect(loadSubagentRegistryFromDisk().size).toBe(0);
    expect(getSubagentRegistryLoadStatus()).toMatchObject({ state: "corrupt" });
  });

  it("reports an unrecognised registry version as corrupt instead of empty", () => {
    fs.writeFileSync(
      registryPath(),
      `${JSON.stringify({ version: 99, runs: { "run-1": { runId: "run-1" } } })}\n`,
      "utf-8",
    );

    expect(loadSubagentRegistryFromDisk().size).toBe(0);
    expect(getSubagentRegistryLoadStatus()).toMatchObject({ state: "corrupt" });
  });

  it("reports a directory standing in for the registry file as unreadable", () => {
    fs.mkdirSync(registryPath(), { recursive: true });

    expect(loadSubagentRegistryFromDisk().size).toBe(0);
    expect(getSubagentRegistryLoadStatus()).toMatchObject({ state: "unreadable" });
  });

  it("refuses to overwrite a corrupt registry with an empty one", () => {
    const corrupted = '{"version":2,"runs":{"run-1":{"runId":"run-1"';
    fs.writeFileSync(registryPath(), corrupted, "utf-8");

    loadSubagentRegistryFromDisk();
    saveSubagentRegistryToDisk(new Map());

    expect(fs.readFileSync(registryPath(), "utf-8")).toBe(corrupted);
  });

  it("refuses to overwrite an unreadable registry", () => {
    fs.mkdirSync(registryPath(), { recursive: true });

    loadSubagentRegistryFromDisk();
    saveSubagentRegistryToDisk(new Map());

    expect(fs.existsSync(registryPath())).toBe(true);
    expect(fs.statSync(registryPath()).isDirectory()).toBe(true);
  });

  it("still writes when the registry simply does not exist yet", () => {
    expect(fs.existsSync(registryPath())).toBe(false);

    loadSubagentRegistryFromDisk();
    expect(getSubagentRegistryLoadStatus()).toMatchObject({ state: "absent" });

    saveSubagentRegistryToDisk(new Map([["run-1", makeRun("run-1")]]));

    const persisted = JSON.parse(fs.readFileSync(registryPath(), "utf-8")) as {
      runs: Record<string, { runId: string }>;
    };
    expect(persisted.runs["run-1"]?.runId).toBe("run-1");
  });

  it("still writes after a successful load", () => {
    fs.writeFileSync(
      registryPath(),
      `${JSON.stringify({ version: 2, runs: { "run-1": { runId: "run-1" } } })}\n`,
      "utf-8",
    );

    expect(loadSubagentRegistryFromDisk().size).toBe(1);
    expect(getSubagentRegistryLoadStatus()).toMatchObject({ state: "ok" });

    saveSubagentRegistryToDisk(new Map([["run-2", makeRun("run-2")]]));

    const persisted = JSON.parse(fs.readFileSync(registryPath(), "utf-8")) as {
      runs: Record<string, { runId: string }>;
    };
    expect(Object.keys(persisted.runs)).toEqual(["run-2"]);
  });

  it("resolves the registry path under the configured state dir", () => {
    expect(resolveSubagentRegistryPath()).toBe(registryPath());
  });
});
