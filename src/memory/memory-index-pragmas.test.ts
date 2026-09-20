import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MEMORY_INDEX_SQLITE_PRAGMAS } from "./manager-sync-ops.js";

describe("memory index pragmas", () => {
  it("makes a second writer wait for the lock instead of failing on it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-pragma-"));
    try {
      const db = new DatabaseSync(path.join(dir, "index.sqlite"));
      db.exec(MEMORY_INDEX_SQLITE_PRAGMAS);
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
      const timeout = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined;
      db.close();

      // WAL: readers are not blocked by a writer.
      expect(mode?.journal_mode).toBe("wal");
      // busy_timeout: a concurrent writer waits for the lock rather than failing immediately.
      expect(timeout?.timeout).toBe(5000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
