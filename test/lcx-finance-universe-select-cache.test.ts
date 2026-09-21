import fsSync from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readFreshAssetCache,
  writeAssetCache,
} from "../scripts/operator/lcx-finance-universe-select.ts";
import type { UniverseAsset } from "../src/agents/finance-universe-selection.ts";

// The asset cache is a copy of the venue's tradable asset list, and it used to be written with
// writeFileSync straight into its final path. writeFileSync truncates first, so a run interrupted
// part way through left a half-written file behind - and because freshness only looks at
// existence and mtime, that file was then read and parsed on every later run. JSON.parse throws,
// so the command stayed broken until somebody deleted the cache by hand.

const dirs: string[] = [];
const ORIGINAL_WRITE_FILE_SYNC = fs.writeFileSync;

function makeCacheDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "lcx-universe-cache-"));
  dirs.push(dir);
  return dir;
}

function writeRaw(dir: string, contents: string): string {
  const cachePath = path.join(dir, "alpaca-assets.json");
  fsSync.writeFileSync(cachePath, contents, "utf8");
  return cachePath;
}

afterEach(() => {
  fs.writeFileSync = ORIGINAL_WRITE_FILE_SYNC;
  for (const dir of dirs.splice(0)) {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readFreshAssetCache", () => {
  it("returns null when there is no cache file yet", () => {
    expect(readFreshAssetCache(path.join(makeCacheDir(), "alpaca-assets.json"))).toBeNull();
  });

  it("returns the assets when the cache is present and fresh", () => {
    const cachePath = writeRaw(makeCacheDir(), JSON.stringify([{ symbol: "AAPL" }]));
    expect(readFreshAssetCache(cachePath)).toEqual([{ symbol: "AAPL" }]);
  });

  it("answers null for a cache that cannot be parsed, so the run refetches instead of throwing", () => {
    const cachePath = writeRaw(makeCacheDir(), '[{"symbol": "AAPL"');
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    try {
      expect(readFreshAssetCache(cachePath)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("")).toContain("could not be parsed");
  });
});

describe("writeAssetCache", () => {
  it("never truncates the cache in place: the payload goes to a temp file first", () => {
    const cachePath = writeRaw(makeCacheDir(), JSON.stringify([{ symbol: "AAPL" }]));
    const targets: string[] = [];
    fs.writeFileSync = ((target: unknown, ...rest: unknown[]) => {
      targets.push(String(target));
      return (ORIGINAL_WRITE_FILE_SYNC as (...args: unknown[]) => unknown).call(
        fs,
        target,
        ...rest,
      );
    }) as typeof fs.writeFileSync;

    writeAssetCache(cachePath, [{ symbol: "MSFT" }] as UniverseAsset[]);

    fs.writeFileSync = ORIGINAL_WRITE_FILE_SYNC;
    expect(targets).not.toHaveLength(0);
    for (const target of targets) {
      expect(target).not.toBe(cachePath);
    }
    expect(JSON.parse(fsSync.readFileSync(cachePath, "utf8"))).toEqual([{ symbol: "MSFT" }]);
  });
});
