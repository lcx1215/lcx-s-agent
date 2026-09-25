import fsSync from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseUniverseSelectArgs,
  readFreshAssetCache,
  runUniverseSelect,
  writeAssetCache,
} from "../scripts/operator/lcx-finance-universe-select.ts";
import {
  FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME,
  type UniverseAsset,
} from "../src/agents/finance-universe-selection.ts";

const { mockHistoryCollect, collectedHistorySymbols } = vi.hoisted(() => {
  const collectedHistorySymbols: string[] = [];
  const mockHistoryCollect = vi.fn(async (request: { instrument: string }) => {
    collectedHistorySymbols.push(request.instrument);
    return [];
  });
  return { mockHistoryCollect, collectedHistorySymbols };
});

vi.mock("../src/agents/finance-free-market-collection-adapters.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/agents/finance-free-market-collection-adapters.js")
    >();
  return {
    ...actual,
    createChinaReachableUsEodHistoryCollectionAdapter: () => ({ collect: mockHistoryCollect }),
  };
});

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

function makeUniverseAsset(symbol: string): UniverseAsset {
  return {
    symbol,
    name: `${symbol} Example Common Stock`,
    exchange: "NASDAQ",
    tradable: true,
    status: "active",
  };
}

function stubSelectionInputs(directory: string, snapshots: Readonly<Record<string, unknown>>) {
  writeAssetCache(
    path.join(directory, "alpaca-assets.json"),
    Object.keys(snapshots).map(makeUniverseAsset),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  vi.stubEnv("ALPACA_API_KEY_ID", "test-key");
  vi.stubEnv("ALPACA_API_SECRET_KEY", "test-secret");
  vi.setSystemTime(new Date("2026-09-25T03:09:00.000Z"));

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const requestUrl =
      input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    expect(requestUrl.hostname).toBe("data.alpaca.markets");
    const symbols = requestUrl.searchParams.get("symbols")?.split(",") ?? [];
    return Response.json(
      Object.fromEntries(symbols.map((symbol) => [symbol, snapshots[symbol] ?? {}])),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runUniverseSelectSilently(argv: readonly string[]): Promise<void> {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runUniverseSelect(argv);
  } finally {
    stdout.mockRestore();
  }
}

afterEach(() => {
  fs.writeFileSync = ORIGINAL_WRITE_FILE_SYNC;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mockHistoryCollect.mockClear();
  collectedHistorySymbols.splice(0);
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

describe("universe selection command bounds", () => {
  it("uses the screen only as a candidate-work ceiling and rejects the old fixed target option", () => {
    expect(parseUniverseSelectArgs([])).toMatchObject({ screen: 120, writeSnapshot: false });
    expect(parseUniverseSelectArgs(["--screen", "37"]).screen).toBe(37);
    expect(parseUniverseSelectArgs(["--write-snapshot", "--json"]).writeSnapshot).toBe(true);
    expect(() => parseUniverseSelectArgs(["--target", "8"])).toThrow(
      "--target is no longer supported",
    );
    expect(() => parseUniverseSelectArgs(["--screen", "501"])).toThrow("--screen must");
  });

  it("fails closed on a failed later snapshot batch and preserves the prior latest snapshot", async () => {
    const directory = makeCacheDir();
    const assets = Array.from({ length: 501 }, (_, index) => {
      let value = index + 1;
      let symbol = "";
      while (value > 0) {
        value -= 1;
        symbol = String.fromCharCode(65 + (value % 26)) + symbol;
        value = Math.floor(value / 26);
      }
      return {
        symbol,
        name: "Example Common Stock",
        exchange: "NASDAQ",
        tradable: true,
        status: "active",
      } satisfies UniverseAsset;
    });
    writeAssetCache(path.join(directory, "alpaca-assets.json"), assets);

    const snapshotPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);
    const previousSnapshot = JSON.stringify({ selected: ["PREVIOUS"] });
    fsSync.writeFileSync(snapshotPath, previousSnapshot, "utf8");

    vi.stubEnv("OPENCLAW_STATE_DIR", directory);
    vi.stubEnv("ALPACA_API_KEY_ID", "test-key");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "test-secret");
    vi.setSystemTime(new Date("2026-09-24T21:00:00.000Z"));

    let snapshotBatch = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      expect(requestUrl.hostname).toBe("data.alpaca.markets");
      snapshotBatch += 1;
      if (snapshotBatch === 2) {
        return new Response("upstream unavailable", { status: 503 });
      }
      const symbols = requestUrl.searchParams.get("symbols")?.split(",") ?? [];
      return Response.json(
        Object.fromEntries(
          symbols.map((symbol) => [
            symbol,
            { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 1_000 } },
          ]),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runUniverseSelect(["--json", "--write-snapshot", "--dir", directory]),
    ).rejects.toThrow("snapshot batch 2 returned 503");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockHistoryCollect).not.toHaveBeenCalled();
    expect(fsSync.readFileSync(snapshotPath, "utf8")).toBe(previousSnapshot);
  });

  it("screens only the latest completed session and records older-session evidence", async () => {
    const directory = makeCacheDir();
    const fetchMock = stubSelectionInputs(directory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
      BETA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 20, v: 100 } },
      OLDER: { prevDailyBar: { t: "2026-09-23T20:00:00.000Z", c: 1_000, v: 1_000 } },
    });
    const snapshotPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);

    await runUniverseSelectSilently([
      "--json",
      "--write-snapshot",
      "--screen",
      "2",
      "--dir",
      directory,
    ]);

    const snapshot = JSON.parse(fsSync.readFileSync(snapshotPath, "utf8")) as {
      screenedCount: number;
      liquidityPreScreen: {
        sessionDate: string;
        sessionDateDistribution: { sessionDate: string; quoteCount: number }[];
        excludedOlderSessionCount: number;
        excludedOlderCandidateCount: number;
      };
    };
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(collectedHistorySymbols.toSorted()).toEqual(["ALPHA", "BETA"]);
    expect(snapshot.screenedCount).toBe(2);
    expect(snapshot.liquidityPreScreen).toEqual({
      basis: "latest_completed_regular_session",
      source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
      sessionDate: "2026-09-24",
      sessionDateDistribution: [
        { sessionDate: "2026-09-23", quoteCount: 1 },
        { sessionDate: "2026-09-24", quoteCount: 2 },
      ],
      excludedOlderSessionCount: 1,
      excludedOlderCandidateCount: 1,
    });
  });

  it("fails closed when the newest completed session has no usable dollar-volume bars", async () => {
    const directory = makeCacheDir();
    const fetchMock = stubSelectionInputs(directory, {
      ZERO: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 0, v: 100 } },
      OLD: { prevDailyBar: { t: "2026-09-23T20:00:00.000Z", c: 100, v: 100 } },
    });
    const snapshotPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);

    await expect(
      runUniverseSelectSilently(["--json", "--write-snapshot", "--dir", directory]),
    ).rejects.toThrow("latest completed-session liquidity data has no usable dollar-volume bars");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(collectedHistorySymbols).toEqual([]);
    expect(fsSync.existsSync(snapshotPath)).toBe(false);
  });
});
