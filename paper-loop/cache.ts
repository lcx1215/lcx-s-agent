import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Small on-disk cache for the upstream funding/price requests.
 *
 * An analysis the system is supposed to run on its own cannot refetch four
 * years of hourly funding on every cycle. Raw upstream responses are cached
 * per request, so a routine run is cheap and a full-history run stays cheap
 * after the first pass.
 */

export const CACHE_DIR = resolve("branches/_system/paper-loop/cache");

export function cacheFile(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return join(CACHE_DIR, `${hash}.json`);
}

export async function cachedJson<T>(
  key: string,
  fetcher: () => Promise<T>,
  useCache = true,
): Promise<T> {
  const file = cacheFile(key);
  // `useCache: false` is the caller's `--no-cache`: skip the read, then overwrite
  // the entry so the next cached run sees the fresher response.
  if (useCache && existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      // A corrupt cache entry must never block the analysis; refetch instead.
    }
  }
  const value = await fetcher();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
  return value;
}
