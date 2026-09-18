import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheFile, cachedJson } from "../paper-loop/cache.ts";

// Keys are unique per run so a parallel or repeated run can never collide, and
// every entry is removed afterwards: the on-disk cache is a runtime artifact,
// not test state.
const writtenKeys: string[] = [];

function uniqueKey(label: string): string {
  const key = `test:paper-loop-cache:${label}:${process.pid}:${Date.now()}:${Math.random()}`;
  writtenKeys.push(key);
  return key;
}

afterEach(() => {
  for (const key of writtenKeys.splice(0)) {
    rmSync(cacheFile(key), { force: true });
  }
});

function countingFetcher(): { calls: () => number; fetcher: () => Promise<{ n: number }> } {
  let calls = 0;
  return {
    calls: () => calls,
    fetcher: async () => {
      calls += 1;
      return { n: calls };
    },
  };
}

describe("cachedJson", () => {
  it("reuses the cached value by default", async () => {
    const { calls, fetcher } = countingFetcher();
    const key = uniqueKey("default");

    const first = await cachedJson(key, fetcher);
    const second = await cachedJson(key, fetcher);

    expect(calls()).toBe(1);
    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 });
  });

  it("refetches and overwrites when useCache is false", async () => {
    const { calls, fetcher } = countingFetcher();
    const key = uniqueKey("bypass");

    await cachedJson(key, fetcher);
    const refreshed = await cachedJson(key, fetcher, false);
    const afterRefresh = await cachedJson(key, fetcher);

    expect(calls()).toBe(2);
    expect(refreshed).toEqual({ n: 2 });
    // The bypass must also overwrite, so the next cached read sees the fresh value.
    expect(afterRefresh).toEqual({ n: 2 });
  });

  it("refetches instead of failing when the cached entry is corrupt", async () => {
    const { calls, fetcher } = countingFetcher();
    const key = uniqueKey("corrupt");
    const file = cacheFile(key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");

    const value = await cachedJson(key, fetcher);

    expect(calls()).toBe(1);
    expect(value).toEqual({ n: 1 });
  });
});
