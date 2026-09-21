import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import {
  BINDINGS_BY_THREAD_ID,
  ensureBindingsLoaded,
  resetThreadBindingsForTests,
  resolveThreadBindingsPath,
  saveBindingsToDisk,
  setBindingRecord,
} from "./thread-bindings.state.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const CORRUPT = "{ this is not json";

const makeRecord = (threadId: string): ThreadBindingRecord => ({
  accountId: "acct-1",
  channelId: "chan-1",
  threadId,
  targetKind: "session",
  targetSessionKey: `session:${threadId}`,
  agentId: "main",
  boundBy: "test",
  boundAt: 1,
  lastActivityAt: 1,
});

describe("thread bindings: a file that cannot be read must not be overwritten", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string | null = null;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-bindings-guard-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetThreadBindingsForTests();
  });

  afterEach(() => {
    resetThreadBindingsForTests();
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
    envSnapshot.restore();
  });

  it("persists normally when the file is absent", () => {
    setBindingRecord(makeRecord("thread-1"));
    saveBindingsToDisk({ force: true });

    // Guards the other direction: refusing to write must not become
    // "never writes", or the first run would silently lose every binding.
    expect(fs.existsSync(resolveThreadBindingsPath())).toBe(true);
    expect(fs.readFileSync(resolveThreadBindingsPath(), "utf8")).toContain("session:thread-1");
  });

  it("leaves a corrupt file untouched instead of replacing it with an empty document", () => {
    setBindingRecord(makeRecord("thread-1"));
    saveBindingsToDisk({ force: true });
    const good = fs.readFileSync(resolveThreadBindingsPath(), "utf8");
    expect(good).toContain("session:thread-1");

    fs.writeFileSync(resolveThreadBindingsPath(), CORRUPT, "utf8");
    resetThreadBindingsForTests();
    ensureBindingsLoaded();
    // The load was refused, so nothing is bound...
    expect(BINDINGS_BY_THREAD_ID.size).toBe(0);

    // ...and that emptiness must not be written back over the original.
    saveBindingsToDisk({ force: true });
    expect(fs.readFileSync(resolveThreadBindingsPath(), "utf8")).toBe(CORRUPT);
  });

  it("persists again once the file is readable", () => {
    fs.mkdirSync(path.dirname(resolveThreadBindingsPath()), { recursive: true });
    fs.writeFileSync(resolveThreadBindingsPath(), CORRUPT, "utf8");
    ensureBindingsLoaded();
    saveBindingsToDisk({ force: true });
    expect(fs.readFileSync(resolveThreadBindingsPath(), "utf8")).toBe(CORRUPT);

    // Human repairs the file; the block must not outlive it.
    resetThreadBindingsForTests();
    fs.writeFileSync(
      resolveThreadBindingsPath(),
      `${JSON.stringify({ version: 1, bindings: {} }, null, 2)}\n`,
      "utf8",
    );
    ensureBindingsLoaded();
    setBindingRecord(makeRecord("thread-2"));
    saveBindingsToDisk({ force: true });

    expect(fs.readFileSync(resolveThreadBindingsPath(), "utf8")).toContain("session:thread-2");
  });
});
