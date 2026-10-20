import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
const children: ChildProcess[] = [];
const run = (id: string): SubagentRunRecord => ({
  runId: id,
  childSessionKey: `agent:main:subagent:${id}`,
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: id,
  cleanup: "keep",
  createdAt: 1,
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-concurrent-"));
  directories.push(directory);
  fs.mkdirSync(path.join(directory, "subagents"));
  fs.writeFileSync(path.join(directory, "config.json"), "{}");
  const pathname = path.join(directory, "subagents", "runs.json");
  fs.writeFileSync(
    pathname,
    JSON.stringify({ version: 2, runs: { old: run("old"), retired: run("retired") } }),
  );
  return { directory, pathname };
}
function start(directory: string, body: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", body],
    {
      cwd: root,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: directory,
        OPENCLAW_CONFIG_PATH: path.join(directory, "config.json"),
        NODE_ENV: "test",
        VITEST: "true",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const messages: unknown[] = [];
  let wake: (() => void) | undefined;
  child.on("message", (message) => {
    messages.push(message);
    wake?.();
  });
  child.on("exit", () => wake?.());
  return {
    child,
    async receive(): Promise<unknown> {
      const deadline = Date.now() + 60_000;
      while (messages.length === 0) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
          throw new Error(
            `fixture child stopped (${child.exitCode}/${child.signalCode}): ${stderr}`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      return messages.shift();
    },
  };
}
const storeImports = `
import { restoreSubagentRunsFromDisk, persistSubagentRunsToDisk, getSubagentRegistryPersistFailure } from './src/agents/subagent-registry-state.ts';
import { loadSubagentRegistryFromDisk } from './src/agents/subagent-registry.store.ts';
const runs = new Map(); restoreSubagentRunsFromDisk({ runs });
`;
afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill();
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("subagent registry cross-process persistence", () => {
  it.each(["absent", "corrupt"])(
    "retains known in-memory runs when the read snapshot becomes %s",
    async (fault) => {
      const { directory, pathname } = fixture();
      const reader = start(
        directory,
        `${storeImports}
        import { getSubagentRunsSnapshotForRead } from './src/agents/subagent-registry-state.ts';
        process.send('ready'); process.once('message', () => {
          delete process.env.VITEST; process.env.NODE_ENV = 'production';
          process.send([...getSubagentRunsSnapshotForRead(runs).keys()].sort());
          process.exit(0);
        });
      `,
      );
      expect(await reader.receive()).toBe("ready");
      if (fault === "absent") {
        fs.unlinkSync(pathname);
      } else {
        fs.writeFileSync(pathname, "{broken");
      }
      reader.child.send("read");
      expect(await reader.receive()).toEqual(["old", "retired"]);
      if (fault === "absent") {
        expect(fs.existsSync(pathname)).toBe(false);
      } else {
        expect(fs.readFileSync(pathname, "utf8")).toBe("{broken");
      }
    },
  );

  it.each(["terminal", "deleted"])(
    "reads a concurrent %s receipt instead of an unchanged in-memory snapshot",
    async (change) => {
      const { directory, pathname } = fixture();
      const reader = start(
        directory,
        `${storeImports}
        import { getSubagentRunsSnapshotForRead } from './src/agents/subagent-registry-state.ts';
        import { countActiveRunsForSessionFromRuns } from './src/agents/subagent-registry-queries.ts';
        process.send('ready'); process.once('message', () => {
          delete process.env.VITEST; process.env.NODE_ENV = 'production';
          const snapshot = getSubagentRunsSnapshotForRead(runs);
          process.send({
            hasOld: snapshot.has('old'),
            oldEndedAt: snapshot.get('old')?.endedAt ?? null,
            active: countActiveRunsForSessionFromRuns(snapshot, 'agent:main:main'),
            memoryUnchanged: runs.get('old')?.endedAt === undefined,
          });
          runs.get('retired').task = 'unpersisted local edit';
          runs.set('memory-only', {...runs.get('retired'), runId: 'memory-only'});
          const localSnapshot = getSubagentRunsSnapshotForRead(runs);
          process.send({localTask: localSnapshot.get('retired')?.task, hasMemoryOnly: localSnapshot.has('memory-only')});
          process.exit(0);
        });
      `,
      );
      expect(await reader.receive()).toBe("ready");
      const writer = start(
        directory,
        `${storeImports}
        ${change === "terminal" ? "runs.get('old').endedAt = 5; runs.get('old').outcome = {status: 'ok'};" : "runs.delete('old');"}
        process.send(persistSubagentRunsToDisk(runs)); process.exit(0);
      `,
      );
      expect(await writer.receive()).toBe(true);
      const before = fs.readFileSync(pathname, "utf8");
      reader.child.send("read");
      expect(await reader.receive()).toEqual({
        hasOld: change === "terminal",
        oldEndedAt: change === "terminal" ? 5 : null,
        active: 1,
        memoryUnchanged: true,
      });
      expect(await reader.receive()).toEqual({
        localTask: "unpersisted local edit",
        hasMemoryOnly: true,
      });
      expect(fs.readFileSync(pathname, "utf8")).toBe(before);
    },
  );

  it("preserves concurrent gateway additions, terminal updates and deletions when a local run completes", async () => {
    const { directory, pathname } = fixture();
    const local = start(
      directory,
      `
      globalThis.fetch = async () => { throw new Error('network forbidden in fixture'); };
      import { registerSubagentRun, confirmSubagentDispatch, completeLocalSubagentRun } from './src/agents/subagent-registry.ts';
      registerSubagentRun({ runId: 'local', childSessionKey: 'agent:main:subagent:local', requesterSessionKey: 'agent:main:main', requesterDisplayKey: 'main', task: 'local', cleanup: 'keep', completionSource: 'local', dispatchState: 'preparing' });
      if (!confirmSubagentDispatch('local', 'local')) throw new Error('dispatch receipt failed');
      process.send('ready');
      process.once('message', () => { process.send(completeLocalSubagentRun('local', {status: 'ok'})); process.exit(0); });
    `,
    );
    expect(await local.receive()).toBe("ready");
    const gateway = start(
      directory,
      `${storeImports}
      runs.get('old').endedAt = 5; runs.get('old').outcome = {status: 'ok'};
      runs.set('new', {...runs.get('old'), runId: 'new'}); runs.delete('retired');
      process.send(persistSubagentRunsToDisk(runs)); process.exit(0);
    `,
    );
    expect(await gateway.receive()).toBe(true);
    local.child.send("complete");
    expect(await local.receive()).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(pathname, "utf8")) as {
      runs: Record<string, SubagentRunRecord>;
    };
    expect(persisted.runs.local?.outcome?.status).toBe("ok");
    expect(persisted.runs.new).toBeDefined();
    expect(persisted.runs.old?.endedAt).toBe(5);
    expect(persisted.runs.retired).toBeUndefined();
  });

  it.each(["terminal", "deleted"])(
    "rejects a conflicting stale write after a same-run %s change",
    async (change) => {
      const { directory, pathname } = fixture();
      const stale = start(
        directory,
        `${storeImports}
      process.send('ready'); process.once('message', () => {
        // Ordinary read queries must not advance the write baseline.
        loadSubagentRegistryFromDisk(); runs.get('old').task = 'stale update';
        process.send({ok: persistSubagentRunsToDisk(runs), failure: getSubagentRegistryPersistFailure()}); process.exit(0);
      });
    `,
      );
      expect(await stale.receive()).toBe("ready");
      const latest = start(
        directory,
        `${storeImports}
      ${change === "terminal" ? "runs.get('old').endedAt = 9; runs.get('old').outcome = {status: 'ok'};" : "runs.delete('old');"}
      process.send(persistSubagentRunsToDisk(runs)); process.exit(0);
    `,
      );
      expect(await latest.receive()).toBe(true);
      const before = fs.readFileSync(pathname, "utf8");
      stale.child.send("persist");
      expect(await stale.receive()).toMatchObject({
        ok: false,
        failure: { kind: "write-error", detail: expect.stringContaining("conflict") },
      });
      expect(fs.readFileSync(pathname, "utf8")).toBe(before);
    },
  );
  it("serializes simultaneous independent writers and keeps both deltas", async () => {
    const { directory, pathname } = fixture();
    const writers = ["first", "second"].map((id) =>
      start(
        directory,
        `${storeImports}
      runs.set('${id}', {...runs.get('old'), runId: '${id}'});
      process.send('ready'); process.once('message', () => {
        process.send(persistSubagentRunsToDisk(runs)); process.exit(0);
      });
    `,
      ),
    );
    for (const writer of writers) {
      expect(await writer.receive()).toBe("ready");
    }
    for (const writer of writers) {
      writer.child.send("persist");
    }
    for (const writer of writers) {
      expect(await writer.receive()).toBe(true);
    }
    const persisted = JSON.parse(fs.readFileSync(pathname, "utf8")) as {
      runs: Record<string, unknown>;
    };
    expect(Object.keys(persisted.runs).toSorted()).toEqual(["first", "old", "retired", "second"]);
  });

  it("releases a crashed writer's mutex without deleting or expiring a living owner's marker", async () => {
    const { directory, pathname } = fixture();
    const holder = start(
      directory,
      `
      import { acquireSubagentRegistryWriteLock } from './src/agents/subagent-registry-lock.ts';
      acquireSubagentRegistryWriteLock(${JSON.stringify(pathname)});
      process.send('locked'); process.on('message', () => {});
    `,
    );
    expect(await holder.receive()).toBe("locked");
    const writer = start(
      directory,
      `${storeImports}
      runs.set('after-crash', {...runs.get('old'), runId: 'after-crash'});
      process.send('waiting'); process.send(persistSubagentRunsToDisk(runs)); process.exit(0);
    `,
    );
    expect(await writer.receive()).toBe("waiting");
    const before = fs.readFileSync(pathname, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
    const exited = new Promise((resolve) => holder.child.once("exit", resolve));
    holder.child.kill("SIGKILL");
    await exited;
    expect(await writer.receive()).toBe(true);
    expect(JSON.parse(fs.readFileSync(pathname, "utf8")).runs["after-crash"]).toBeDefined();
  });

  it("reports local completion contention and preserves an uncertain receipt through recovery", async () => {
    const { directory, pathname } = fixture();
    fs.writeFileSync(pathname, JSON.stringify({ version: 2, runs: {} }));
    const local = start(
      directory,
      `
      globalThis.fetch = async () => { throw new Error('network forbidden in fixture'); };
      import { registerSubagentRun, confirmSubagentDispatch, completeLocalSubagentRun } from './src/agents/subagent-registry.ts';
      import { getSubagentRegistryPersistFailure } from './src/agents/subagent-registry-state.ts';
      registerSubagentRun({ runId: 'local', childSessionKey: 'agent:main:subagent:local', requesterSessionKey: 'agent:main:main', requesterDisplayKey: 'main', task: 'local', cleanup: 'keep', completionSource: 'local', dispatchState: 'preparing' });
      if (!confirmSubagentDispatch('local', 'local')) throw new Error('dispatch receipt failed');
      process.send('ready'); process.once('message', () => {
        process.send({ok: completeLocalSubagentRun('local', {status: 'ok'}), failure: getSubagentRegistryPersistFailure()}); process.exit(0);
      });
    `,
    );
    expect(await local.receive()).toBe("ready");
    const holder = start(
      directory,
      `
      import fs from 'node:fs';
      import { acquireSubagentRegistryWriteLock } from './src/agents/subagent-registry-lock.ts';
      acquireSubagentRegistryWriteLock(${JSON.stringify(pathname)});
      // An old mtime never authorizes stealing a living writer's lock.
      const directory = ${JSON.stringify(pathname)} + '.write-lock';
      for (const name of fs.readdirSync(directory)) fs.utimesSync(directory + '/' + name, 0, 0);
      process.send('locked'); process.on('message', () => {});
    `,
    );
    expect(await holder.receive()).toBe("locked");
    const before = fs.readFileSync(pathname, "utf8");
    local.child.send("complete");
    expect(await local.receive()).toMatchObject({
      ok: false,
      failure: { kind: "write-error", detail: expect.stringContaining("lock timeout") },
    });
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
    expect(holder.child.exitCode).toBeNull();
    const exited = new Promise((resolve) => holder.child.once("exit", resolve));
    holder.child.kill("SIGKILL");
    await exited;
    const recovered = start(
      directory,
      `
      globalThis.fetch = async () => { throw new Error('network forbidden in fixture'); };
      import { initSubagentRegistry, listSubagentRunsForRequester } from './src/agents/subagent-registry.ts';
      initSubagentRegistry(); process.send(listSubagentRunsForRequester('agent:main:main')[0]); process.exit(0);
    `,
    );
    expect(await recovered.receive()).toMatchObject({ runId: "local", dispatchState: "uncertain" });
    const receipt = JSON.parse(fs.readFileSync(pathname, "utf8")).runs.local;
    expect(receipt.dispatchState).toBe("uncertain");
    expect(receipt.endedAt).toBeUndefined();
    expect(receipt.outcome).toBeUndefined();
  });

  it("never overlaps critical sections when independent processes repeatedly contend", async () => {
    const { directory, pathname } = fixture();
    const guard = path.join(directory, "exclusive");
    const counter = path.join(directory, "counter");
    fs.writeFileSync(counter, "0");
    const writers = [0, 1, 2].map(() =>
      start(
        directory,
        `
      import fs from 'node:fs';
      import { acquireSubagentRegistryWriteLock } from './src/agents/subagent-registry-lock.ts';
      const wait = new Int32Array(new SharedArrayBuffer(4));
      process.send('ready'); process.once('message', () => {
        for (let i = 0; i < 6; i++) {
          const release = acquireSubagentRegistryWriteLock(${JSON.stringify(pathname)});
          try {
            fs.writeFileSync(${JSON.stringify(guard)}, '', {flag: 'wx'});
            const value = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
            Atomics.wait(wait, 0, 0, 10);
            fs.writeFileSync(${JSON.stringify(counter)}, String(value + 1));
            fs.unlinkSync(${JSON.stringify(guard)});
          } finally { release(); }
        }
        process.send('done'); process.exit(0);
      });
    `,
      ),
    );
    for (const writer of writers) {
      expect(await writer.receive()).toBe("ready");
    }
    for (const writer of writers) {
      writer.child.send("start");
    }
    for (const writer of writers) {
      expect(await writer.receive()).toBe("done");
    }
    expect(fs.readFileSync(counter, "utf8")).toBe("18");
  });
  it("reports a local completion conflict without overwriting a newer same-run terminal receipt", async () => {
    const { directory, pathname } = fixture();
    const local = start(
      directory,
      `
      import { registerSubagentRun, confirmSubagentDispatch, completeLocalSubagentRun } from './src/agents/subagent-registry.ts';
      import { getSubagentRegistryPersistFailure } from './src/agents/subagent-registry-state.ts';
      registerSubagentRun({ runId: 'local', childSessionKey: 'agent:main:subagent:local', requesterSessionKey: 'agent:main:main', requesterDisplayKey: 'main', task: 'local', cleanup: 'keep', completionSource: 'local', dispatchState: 'preparing' });
      if (!confirmSubagentDispatch('local', 'local')) throw new Error('dispatch receipt failed');
      process.send('ready'); process.once('message', () => {
        process.send({ok: completeLocalSubagentRun('local', {status: 'ok'}), failure: getSubagentRegistryPersistFailure()}); process.exit(0);
      });
    `,
    );
    expect(await local.receive()).toBe("ready");
    const latest = start(
      directory,
      `${storeImports}
      runs.get('local').endedAt = 17; runs.get('local').outcome = {status: 'error', error: 'newer terminal'};
      process.send(persistSubagentRunsToDisk(runs)); process.exit(0);
    `,
    );
    expect(await latest.receive()).toBe(true);
    const before = fs.readFileSync(pathname, "utf8");
    local.child.send("complete");
    expect(await local.receive()).toMatchObject({
      ok: false,
      failure: { detail: expect.stringContaining("conflict") },
    });
    expect(fs.readFileSync(pathname, "utf8")).toBe(before);
  });
  it("retries the pending restore commit after initial lock contention before starting listeners", async () => {
    const { directory, pathname } = fixture();
    fs.writeFileSync(
      pathname,
      JSON.stringify({
        version: 2,
        runs: {
          local: { ...run("local"), completionSource: "local", dispatchState: "preparing" },
          gateway: { ...run("gateway"), dispatchState: "preparing" },
        },
      }),
    );
    const holder = start(
      directory,
      `
      import { acquireSubagentRegistryWriteLock } from './src/agents/subagent-registry-lock.ts';
      acquireSubagentRegistryWriteLock(${JSON.stringify(pathname)}); process.send('locked'); process.on('message', () => {});
    `,
    );
    expect(await holder.receive()).toBe("locked");
    const restoring = start(
      directory,
      `
      globalThis.fetch = async () => {throw new Error('network forbidden in fixture');};
      import fs from 'node:fs';
      import {initSubagentRegistry, listSubagentRunsForRequester} from './src/agents/subagent-registry.ts';
      import {emitAgentEvent} from './src/infra/agent-events.ts';
      initSubagentRegistry(); process.send({disk: JSON.parse(fs.readFileSync(${JSON.stringify(pathname)}, 'utf8')).runs.local.dispatchState, memory: listSubagentRunsForRequester('agent:main:main').find(run => run.runId === 'local').dispatchState});
      process.once('message', () => {
        initSubagentRegistry(); initSubagentRegistry();
        emitAgentEvent({runId: 'gateway', stream: 'lifecycle', data: {phase: 'start', startedAt: 77}});
        process.send(JSON.parse(fs.readFileSync(${JSON.stringify(pathname)}, 'utf8')).runs); process.exit(0);
      });
    `,
    );
    expect(await restoring.receive()).toEqual({ disk: "preparing", memory: "uncertain" });
    const exited = new Promise((resolve) => holder.child.once("exit", resolve));
    holder.child.kill("SIGKILL");
    await exited;
    restoring.child.send("retry");
    expect(await restoring.receive()).toMatchObject({
      local: { dispatchState: "uncertain" },
      gateway: { startedAt: 77 },
    });
  });

  it("retries a failed terminal commit without losing its evidence or emitting the ended hook twice", async () => {
    const { directory, pathname } = fixture();
    fs.writeFileSync(
      pathname,
      JSON.stringify({
        version: 2,
        runs: { target: { ...run("target"), dispatchState: "preparing" } },
      }),
    );
    const terminating = start(
      directory,
      `
      globalThis.fetch = async () => {throw new Error('network forbidden in fixture');};
      import fs from 'node:fs';
      import {initSubagentRegistry, markSubagentRunTerminated, listSubagentRunsForRequester} from './src/agents/subagent-registry.ts';
      initSubagentRegistry(); process.send('ready');
      process.once('message', () => {
        const first = markSubagentRunTerminated({runId: 'target', reason: 'first terminal reason'});
        const endedAt = listSubagentRunsForRequester('agent:main:main')[0].endedAt;
        process.send({first, memoryEndedAt: endedAt, disk: JSON.parse(fs.readFileSync(${JSON.stringify(pathname)}, 'utf8')).runs.target});
        process.once('message', async () => {
          const retry = markSubagentRunTerminated({runId: 'target', reason: 'must not replace original evidence'});
          await Promise.resolve(); await Promise.resolve();
          const before = JSON.parse(fs.readFileSync(${JSON.stringify(pathname)}, 'utf8')).runs.target;
          const again = markSubagentRunTerminated({runId: 'target'});
          await Promise.resolve();
          const after = JSON.parse(fs.readFileSync(${JSON.stringify(pathname)}, 'utf8')).runs.target;
          process.send({retry, again, before, after, endedAt}); process.exit(0);
        });
      });
    `,
    );
    expect(await terminating.receive()).toBe("ready");
    const holder = start(
      directory,
      `
      import { acquireSubagentRegistryWriteLock } from './src/agents/subagent-registry-lock.ts';
      acquireSubagentRegistryWriteLock(${JSON.stringify(pathname)}); process.send('locked'); process.on('message', () => {});
    `,
    );
    expect(await holder.receive()).toBe("locked");
    terminating.child.send("terminate");
    const first = (await terminating.receive()) as {
      first: number;
      memoryEndedAt: number;
      disk: SubagentRunRecord;
    };
    expect(first.first).toBe(0);
    expect(first.memoryEndedAt).toBeGreaterThan(0);
    expect(first.disk.endedAt).toBeUndefined();
    const exited = new Promise((resolve) => holder.child.once("exit", resolve));
    holder.child.kill("SIGKILL");
    await exited;
    terminating.child.send("retry");
    const result = (await terminating.receive()) as {
      retry: number;
      again: number;
      before: SubagentRunRecord;
      after: SubagentRunRecord;
      endedAt: number;
    };
    expect(result.retry).toBe(1);
    expect(result.again).toBe(0);
    expect(result.before).toMatchObject({
      endedAt: result.endedAt,
      outcome: { status: "error", error: "first terminal reason" },
      endedHookEmittedAt: expect.any(Number),
    });
    expect(result.after).toEqual(result.before);
  });
  it("commits the original failed termination after a late lifecycle result through the original sweeper", async () => {
    const { directory, pathname } = fixture();
    fs.writeFileSync(
      pathname,
      JSON.stringify({
        version: 2,
        runs: { target: { ...run("target"), spawnMode: "session", dispatchState: "preparing" } },
      }),
    );
    const terminal = start(
      directory,
      `
      globalThis.fetch = async () => {throw new Error('network forbidden in fixture');};
      let clockEnabled = false;
      const originalInterval = globalThis.setInterval;
      globalThis.setInterval = (callback, ms, ...args) => originalInterval(ms === 60000 ? () => {if (clockEnabled) callback(...args);} : callback, ms === 60000 ? 20 : ms, ...args);
      import fs from 'node:fs';
      import {initSubagentRegistry, markSubagentRunTerminated, listSubagentRunsForRequester} from './src/agents/subagent-registry.ts';
      import {emitAgentEvent} from './src/infra/agent-events.ts';
      initSubagentRegistry(); process.send('ready');
      process.once('message', () => {
        const first = markSubagentRunTerminated({runId: 'target', reason: 'original terminal evidence'});
        const endedAt = listSubagentRunsForRequester('agent:main:main')[0].endedAt;
        emitAgentEvent({runId: 'target', stream: 'lifecycle', data: {phase: 'end', endedAt: 77}});
        process.send({first, endedAt, memory: listSubagentRunsForRequester('agent:main:main')[0]});
        process.once('message', () => {
          clockEnabled = true;
          const deadline = Date.now() + 2000;
          const observe = originalInterval(() => {
            const receipt = JSON.parse(fs.readFileSync(${JSON.stringify(pathname)}, 'utf8')).runs.target;
            if (receipt?.endedHookEmittedAt || Date.now() > deadline) {
              clearInterval(observe); process.send(receipt); process.exit(0);
            }
          }, 10);
        });
      });
    `,
    );
    expect(await terminal.receive()).toBe("ready");
    const holder = start(
      directory,
      `
      import {acquireSubagentRegistryWriteLock} from './src/agents/subagent-registry-lock.ts';
      acquireSubagentRegistryWriteLock(${JSON.stringify(pathname)}); process.send('locked'); process.on('message', () => {});
    `,
    );
    expect(await holder.receive()).toBe("locked");
    terminal.child.send("terminate");
    const pending = (await terminal.receive()) as {
      first: number;
      endedAt: number;
      memory: SubagentRunRecord;
    };
    expect(pending.first).toBe(0);
    expect(pending.memory).toMatchObject({
      endedAt: pending.endedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "original terminal evidence" },
    });
    expect(JSON.parse(fs.readFileSync(pathname, "utf8")).runs.target.endedAt).toBeUndefined();
    const exited = new Promise((resolve) => holder.child.once("exit", resolve));
    holder.child.kill("SIGKILL");
    await exited;
    terminal.child.send("observe");
    expect(await terminal.receive()).toMatchObject({
      endedAt: pending.endedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "original terminal evidence" },
      endedHookEmittedAt: expect.any(Number),
    });
  });
});
