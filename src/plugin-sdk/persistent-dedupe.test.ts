import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as jsonStore from "./json-store.js";
import { createPersistentDedupe } from "./persistent-dedupe.js";

const tmpRoots: string[] = [];

async function makeTmpRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dedupe-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createPersistentDedupe", () => {
  it("refuses compatibility admission while an absent state file is actively locked", async () => {
    const root = await makeTmpRoot();
    const filePath = path.join(root, "dedupe.json");
    await fs.writeFile(
      `${filePath}.lock`,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    const compatibility = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 100,
      resolveFilePath: () => filePath,
      lockOptions: {
        retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1, randomize: false },
      },
    });
    await expect(compatibility.checkAndRecord("not-dispatched")).rejects.toThrow();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.unlink(`${filePath}.lock`);
    expect(await compatibility.checkAndRecord("not-dispatched")).toBe(true);
  });
  it("blocks compatibility admission when existing protected state cannot be locked", async () => {
    const root = await makeTmpRoot();
    const filePath = path.join(root, "dedupe.json");
    const options = {
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 100,
      resolveFilePath: () => filePath,
      lockOptions: {
        retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1, randomize: false },
      },
    };
    const strict = createPersistentDedupe(options);
    const now = Date.now();
    await strict.checkAndRecord("unknown", { now, requirePersistence: true });
    await strict.settleClaim("unknown", {
      recordedAt: now,
      retryable: false,
      outcome: "delivery_unknown",
    });
    const before = await fs.readFile(filePath, "utf8");
    await fs.writeFile(
      `${filePath}.lock`,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    const compatibility = createPersistentDedupe(options);
    await expect(compatibility.checkAndRecord("unknown")).rejects.toThrow();
    await expect(compatibility.checkAndRecord("not-dispatched")).rejects.toThrow();
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    await fs.unlink(`${filePath}.lock`);
    expect(await compatibility.checkAndRecord("not-dispatched")).toBe(true);
  });
  it.each(["malformed", "unreadable"] as const)(
    "never overwrites %s protected state through a compatibility caller",
    async (fault) => {
      const root = await makeTmpRoot();
      const filePath = path.join(root, "dedupe.json");
      const options = {
        ttlMs: 10_000,
        memoryMaxSize: 0,
        fileMaxEntries: 100,
        resolveFilePath: () => filePath,
      };
      await createPersistentDedupe(options).checkAndRecord("unknown", { requirePersistence: true });
      if (fault === "malformed") {
        await fs.writeFile(filePath, '{"schemaVersion":"lcx_persistent_dedupe_v2",');
      }
      const before = await fs.readFile(filePath, "utf8");
      const canonicalPath = await fs.realpath(filePath);
      const original = fs.readFile;
      let readFailures = 0;
      const spy =
        fault === "unreadable"
          ? vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
              if (args[0] === filePath || args[0] === canonicalPath) {
                readFailures++;
                throw Object.assign(new Error("offline unreadable replay file"), {
                  code: "EACCES",
                });
              }
              return original(...args);
            })
          : undefined;
      try {
        await expect(createPersistentDedupe(options).checkAndRecord("new")).rejects.toThrow();
      } finally {
        spy?.mockRestore();
      }
      expect(readFailures).toBe(fault === "unreadable" ? 1 : 0);
      expect(await fs.readFile(filePath, "utf8")).toBe(before);
    },
  );
  it("deduplicates keys and persists across instances", async () => {
    const root = await makeTmpRoot();
    const resolveFilePath = (namespace: string) => path.join(root, `${namespace}.json`);

    const first = createPersistentDedupe({
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath,
    });
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(true);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(false);

    const second = createPersistentDedupe({
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath,
    });
    expect(await second.checkAndRecord("m1", { namespace: "a" })).toBe(false);
    expect(await second.checkAndRecord("m1", { namespace: "b" })).toBe(true);
  });

  it("guards concurrent calls for the same key", async () => {
    const root = await makeTmpRoot();
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
    });

    const [first, second] = await Promise.all([
      dedupe.checkAndRecord("race-key", { namespace: "external" }),
      dedupe.checkAndRecord("race-key", { namespace: "external" }),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("falls back to memory-only behavior on disk errors", async () => {
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: () => path.join("/dev/null", "dedupe.json"),
    });

    expect(await dedupe.checkAndRecord("memory-only", { namespace: "x" })).toBe(true);
    expect(await dedupe.checkAndRecord("memory-only", { namespace: "x" })).toBe(false);
  });

  it("warmup loads persisted entries into memory", async () => {
    const root = await makeTmpRoot();
    const resolveFilePath = (namespace: string) => path.join(root, `${namespace}.json`);

    const writer = createPersistentDedupe({
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath,
    });
    expect(await writer.checkAndRecord("msg-1", { namespace: "acct" })).toBe(true);
    expect(await writer.checkAndRecord("msg-2", { namespace: "acct" })).toBe(true);

    const reader = createPersistentDedupe({
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath,
    });
    const loaded = await reader.warmup("acct");
    expect(loaded).toBe(2);
    expect(await reader.checkAndRecord("msg-1", { namespace: "acct" })).toBe(false);
    expect(await reader.checkAndRecord("msg-2", { namespace: "acct" })).toBe(false);
    expect(await reader.checkAndRecord("msg-3", { namespace: "acct" })).toBe(true);
  });

  it("warmup returns 0 when no disk file exists", async () => {
    const root = await makeTmpRoot();
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: (ns) => path.join(root, `${ns}.json`),
    });
    const loaded = await dedupe.warmup("nonexistent");
    expect(loaded).toBe(0);
  });

  it("warmup skips expired entries", async () => {
    const root = await makeTmpRoot();
    const resolveFilePath = (namespace: string) => path.join(root, `${namespace}.json`);
    const ttlMs = 1000;

    const writer = createPersistentDedupe({
      ttlMs,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath,
    });
    const oldNow = Date.now() - 2000;
    expect(await writer.checkAndRecord("old-msg", { namespace: "acct", now: oldNow })).toBe(true);
    expect(await writer.checkAndRecord("new-msg", { namespace: "acct" })).toBe(true);

    const reader = createPersistentDedupe({
      ttlMs,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath,
    });
    const loaded = await reader.warmup("acct");
    expect(loaded).toBe(1);
    expect(await reader.checkAndRecord("old-msg", { namespace: "acct" })).toBe(true);
    expect(await reader.checkAndRecord("new-msg", { namespace: "acct" })).toBe(false);
  });
  it("conditionally releases one strict claim without deleting a replacement", async () => {
    const root = await makeTmpRoot();
    const options = {
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: (namespace: string) => path.join(root, `${namespace}.json`),
    };
    const dedupe = createPersistentDedupe(options);
    const now = Date.now();
    expect(
      await dedupe.checkAndRecord("retry", { namespace: "a", now, requirePersistence: true }),
    ).toBe(true);
    expect(
      await dedupe.settleClaim("retry", { namespace: "a", recordedAt: now - 1, retryable: true }),
    ).toBe(false);
    expect(
      await dedupe.settleClaim("retry", { namespace: "a", recordedAt: now, retryable: true }),
    ).toBe(true);
    await expect(
      dedupe.checkAndRecord("retry", { namespace: "a", now, requirePersistence: true }),
    ).rejects.toThrow("timestamp must be unique");
    expect(
      await dedupe.checkAndRecord("retry", {
        namespace: "a",
        now: now + 1,
        requirePersistence: true,
      }),
    ).toBe(true);
    expect(
      await dedupe.settleClaim("retry", { namespace: "a", recordedAt: now, retryable: true }),
    ).toBe(false);
    expect(await createPersistentDedupe(options).checkAndRecord("retry", { namespace: "a" })).toBe(
      false,
    );
    expect(
      await dedupe.settleClaim("retry", { namespace: "a", recordedAt: now + 1, retryable: false }),
    ).toBe(true);
  });

  it("persists prototype-looking message IDs before accepting a strict claim", async () => {
    const root = await makeTmpRoot();
    const options = {
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: () => path.join(root, "dedupe.json"),
    };
    const first = createPersistentDedupe(options);
    expect(await first.checkAndRecord("__proto__", { requirePersistence: true })).toBe(true);
    expect(
      await createPersistentDedupe(options).checkAndRecord("__proto__", {
        requirePersistence: true,
      }),
    ).toBe(false);
  });

  it("refuses strict dispatch on disk failure while preserving existing memory fallback", async () => {
    const root = await makeTmpRoot();
    const parentFile = path.join(root, "file");
    await fs.writeFile(parentFile, "not a directory");
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: () => path.join(parentFile, "dedupe.json"),
    });
    await expect(dedupe.checkAndRecord("strict", { requirePersistence: true })).rejects.toThrow();
    expect(await dedupe.checkAndRecord("legacy")).toBe(true);
    expect(await dedupe.checkAndRecord("legacy")).toBe(false);
  });
  it("serializes a release and a peer claim on the same real file without losing the peer", async () => {
    const root = await makeTmpRoot();
    const filePath = path.join(root, "dedupe.json");
    const options = {
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: () => filePath,
    };
    const first = createPersistentDedupe(options);
    const peer = createPersistentDedupe({
      ...options,
      resolveFilePath: () => path.join(root, "..", path.basename(root), "dedupe.json"),
    });
    const now = Date.now();
    expect(await first.checkAndRecord("release", { now, requirePersistence: true })).toBe(true);
    let enterWrite!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      enterWrite = resolve;
    });
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const original = jsonStore.writeJsonFileAtomically;
    let firstWrite = true;
    const spy = vi
      .spyOn(jsonStore, "writeJsonFileAtomically")
      .mockImplementation(async (...args) => {
        if (firstWrite) {
          firstWrite = false;
          enterWrite();
          await writing;
        }
        return original(...args);
      });
    try {
      const release = first.settleClaim("release", { recordedAt: now, retryable: true });
      await writeEntered;
      const claim = peer.checkAndRecord("peer", { now: now + 1, requirePersistence: true });
      setTimeout(releaseWrite, 50);
      expect(await release).toBe(true);
      expect(await claim).toBe(true);
      expect(
        await createPersistentDedupe(options).checkAndRecord("peer", { requirePersistence: true }),
      ).toBe(false);
    } finally {
      releaseWrite();
      spy.mockRestore();
    }
  });
  it("migrates ambiguous numeric records conservatively and never downgrades v2 through the legacy API", async () => {
    const root = await makeTmpRoot();
    const filePath = path.join(root, "dedupe.json");
    const now = Date.now();
    const options = {
      ttlMs: 10,
      memoryMaxSize: 0,
      fileMaxEntries: 3,
      resolveFilePath: () => filePath,
    };
    const legacy = createPersistentDedupe(options);
    expect(await legacy.checkAndRecord("old", { now: now - 100 })).toBe(true);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ old: now - 100 });
    const strict = createPersistentDedupe(options);
    expect(await strict.checkAndRecord("active", { now, requirePersistence: true })).toBe(true);
    expect(await createPersistentDedupe(options).checkAndRecord("old", { now: now + 100 })).toBe(
      false,
    );
    expect(
      await strict.settleClaim("active", {
        recordedAt: now,
        retryable: false,
        outcome: "delivery_unknown",
      }),
    ).toBe(true);
    expect(await legacy.checkAndRecord("complete", { now: now + 100 })).toBe(true);
    expect(await legacy.checkAndRecord("later", { now: now + 200 })).toBe(true);
    const state = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(state.schemaVersion).toBe("lcx_persistent_dedupe_v2");
    expect(state.entries.old.status).toBe("delivery_unknown");
    expect(state.entries.active.status).toBe("delivery_unknown");
    expect(state.entries.complete).toBeUndefined();
    expect(state.entries.later.status).toBe("completed");
  });
});
