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
import { financeBarLedgerExists, readFinanceBarLedger } from "../src/agents/finance-bar-ledger.ts";
import { financeUsEquityRegularCloseInstant } from "../src/agents/finance-cycle-schedule.ts";
import { financeBarLedgerPath } from "../src/agents/finance-state-dir.ts";
import {
  FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME,
  type UniverseAsset,
} from "../src/agents/finance-universe-selection.ts";

type MockHistoryItem = Readonly<{
  itemId: string;
  collection: "eod_history";
  providerName: string;
  providerRole: "primary_market_data";
  sourceFamily: "market_data_api";
  sourceTimestamp: string;
  observedAt: string;
  delayStatus: "end_of_day";
  sourceUrlOrArtifact: string;
  data: Readonly<Record<string, unknown>>;
}>;

const { mockHistoryCollect, collectedHistorySymbols } = vi.hoisted(() => {
  const collectedHistorySymbols: string[] = [];
  const mockHistoryCollect = vi.fn(async (request: { instrument: string }) => {
    collectedHistorySymbols.push(request.instrument);
    return [] as MockHistoryItem[];
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

function makeMockHistoryRows(endDate: string, count: number, symbol = "ALPHA"): MockHistoryItem[] {
  const cursor = new Date(`${endDate}T12:00:00.000Z`);
  const rows: MockHistoryItem[] = [];
  while (rows.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      const index = rows.length;
      const close = 100 + 5 * Math.sin(index / 6);
      rows.push({
        itemId: `${symbol}-eod-${cursor.toISOString().slice(0, 10)}`,
        collection: "eod_history",
        providerName: "test-eod-provider",
        providerRole: "primary_market_data",
        sourceFamily: "market_data_api",
        sourceTimestamp:
          financeUsEquityRegularCloseInstant(cursor.toISOString().slice(0, 10)) ?? "invalid",
        observedAt: "2026-09-25T03:08:00.000Z",
        delayStatus: "end_of_day",
        sourceUrlOrArtifact: "https://example.invalid/eod",
        data: {
          symbol,
          date: cursor.toISOString().slice(0, 10),
          open: close * 0.999,
          high: close * 1.01,
          low: close * 0.99,
          close,
          volume: 1_000_000,
        },
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return rows.toReversed();
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

async function runUniverseSelectCapturingJson(argv: readonly string[]): Promise<{
  snapshotPersisted: boolean;
  selected: string[];
  historyCollectionFailures: { symbol: string; error: string }[];
  canonicalBarPersistence: {
    status: string;
    barCount: number;
    instrumentCount: number;
    instruments: {
      symbol: string;
      providerName: string;
      sourceUrlOrArtifact: string;
      observedAt: string;
      barCount: number;
      newBarCount: number;
      headRef: string | null;
    }[];
    failures: { symbol: string; error: string }[];
  };
}> {
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    if (typeof chunk === "string") {
      chunks.push(chunk);
    }
    return true;
  });
  try {
    await runUniverseSelect(argv);
  } finally {
    stdout.mockRestore();
  }
  return JSON.parse(chunks.join("")) as {
    snapshotPersisted: boolean;
    selected: string[];
    historyCollectionFailures: { symbol: string; error: string }[];
    canonicalBarPersistence: {
      status: string;
      barCount: number;
      instrumentCount: number;
      instruments: {
        symbol: string;
        providerName: string;
        sourceUrlOrArtifact: string;
        observedAt: string;
        barCount: number;
        newBarCount: number;
        headRef: string | null;
      }[];
      failures: { symbol: string; error: string }[];
    };
  };
}

afterEach(() => {
  fs.writeFileSync = ORIGINAL_WRITE_FILE_SYNC;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mockHistoryCollect.mockReset();
  mockHistoryCollect.mockImplementation(async ({ instrument }) => {
    collectedHistorySymbols.push(instrument);
    return [];
  });
  collectedHistorySymbols.splice(0);
  for (const dir of dirs.splice(0)) {
    fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    mockHistoryCollect.mockImplementation(async ({ instrument }) => {
      collectedHistorySymbols.push(instrument);
      return makeMockHistoryRows("2026-09-24", 3, instrument);
    });
    const snapshotPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);

    const writeResult = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "2",
      "--dir",
      directory,
    ]);
    expect(writeResult.snapshotPersisted).toBe(true);

    const snapshot = JSON.parse(fsSync.readFileSync(snapshotPath, "utf8")) as {
      screenedCount: number;
      liquidityPreScreen: {
        sessionDate: string;
        sessionDateDistribution: { sessionDate: string; quoteCount: number }[];
        excludedOlderSessionBarCount: number;
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
      excludedOlderSessionBarCount: 1,
      excludedOlderCandidateCount: 1,
    });
  });

  it("files the exact validated EOD bars under the requested directory only in snapshot mode", async () => {
    const directory = makeCacheDir();
    stubSelectionInputs(directory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    const historyRows = makeMockHistoryRows("2026-09-24", 800, "ALPHA");
    mockHistoryCollect.mockImplementationOnce(async () => historyRows);

    const writeResult = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "1",
      "--dir",
      directory,
    ]);

    expect(writeResult.snapshotPersisted).toBe(true);
    expect(writeResult.canonicalBarPersistence).toMatchObject({
      status: "complete",
      barCount: 800,
      instruments: [
        {
          symbol: "ALPHA",
          providerName: "test-eod-provider",
          sourceUrlOrArtifact: "https://example.invalid/eod",
          observedAt: "2026-09-25T03:08:00.000Z",
          barCount: 800,
          newBarCount: 800,
        },
      ],
      failures: [],
    });
    expect(writeResult.canonicalBarPersistence.instruments[0]?.headRef).toMatch(/^[a-f0-9]{64}$/u);
    expect(writeResult.selected).toContain("ALPHA");
    const ledger = await readFinanceBarLedger(directory, { instrument: "ALPHA" });
    expect(ledger.bars).toHaveLength(800);
    expect(ledger.bars.map((bar) => bar.date)).toEqual(
      historyRows.map((row) => row.data.date as string),
    );
    expect(ledger.bars[0]).toMatchObject({
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
    });
    expect(ledger.bars[0]?.close).toBe(historyRows[0]?.data.close);
    expect(ledger.bars[0]?.sampleCount).toBeNull();
    expect(await financeBarLedgerExists(path.join(directory, "other"))).toBe(false);

    const dryRunDirectory = makeCacheDir();
    stubSelectionInputs(dryRunDirectory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    mockHistoryCollect.mockImplementationOnce(async ({ instrument }) =>
      makeMockHistoryRows("2026-09-24", 3, instrument),
    );
    await runUniverseSelectSilently(["--json", "--screen", "1", "--dir", dryRunDirectory]);
    expect(await financeBarLedgerExists(dryRunDirectory)).toBe(false);
  });

  it("rejects future or symbol-mismatched EOD rows without filing a synthetic bar", async () => {
    const directory = makeCacheDir();
    stubSelectionInputs(directory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    const future = makeMockHistoryRows("2026-09-25", 1, "ALPHA");
    mockHistoryCollect.mockImplementationOnce(async () => future);
    const futureResult = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "1",
      "--dir",
      directory,
    ]);
    expect(futureResult.snapshotPersisted).toBe(true);
    expect(futureResult.canonicalBarPersistence.instruments).toEqual([]);
    expect(futureResult.historyCollectionFailures[0]?.symbol).toBe("ALPHA");
    expect(futureResult.canonicalBarPersistence.status).toBe("partial");
    expect(await financeBarLedgerExists(directory)).toBe(false);

    const mismatchDirectory = makeCacheDir();
    stubSelectionInputs(mismatchDirectory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    mockHistoryCollect.mockImplementationOnce(async ({ instrument }) => {
      const [row] = makeMockHistoryRows("2026-09-24", 1, instrument);
      return row ? [{ ...row, data: { ...row.data, symbol: "BETA" } }] : [];
    });
    const mismatchResult = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "1",
      "--dir",
      mismatchDirectory,
    ]);
    expect(mismatchResult.snapshotPersisted).toBe(true);
    expect(mismatchResult.historyCollectionFailures[0]?.error).toContain("symbol mismatch");
    expect(mismatchResult.canonicalBarPersistence.status).toBe("partial");
    expect(await financeBarLedgerExists(mismatchDirectory)).toBe(false);
  });

  it("rejects conflicting duplicate dates instead of choosing one observation", async () => {
    const directory = makeCacheDir();
    stubSelectionInputs(directory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    mockHistoryCollect.mockImplementationOnce(async ({ instrument }) => {
      const [row] = makeMockHistoryRows("2026-09-24", 1, instrument);
      return row ? [row, { ...row, data: { ...row.data, close: Number(row.data.close) + 1 } }] : [];
    });

    const result = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "1",
      "--dir",
      directory,
    ]);

    expect(result.snapshotPersisted).toBe(true);
    expect(result.historyCollectionFailures[0]?.error).toContain("conflicting close observations");
    expect(result.canonicalBarPersistence.status).toBe("partial");
    expect(await financeBarLedgerExists(directory)).toBe(false);
  });

  it("rejects close-only history instead of inventing an OHLC range", async () => {
    const directory = makeCacheDir();
    stubSelectionInputs(directory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    mockHistoryCollect.mockImplementationOnce(async ({ instrument }) =>
      makeMockHistoryRows("2026-09-24", 800, instrument).map((row) => ({
        ...row,
        data: {
          symbol: row.data.symbol,
          date: row.data.date,
          close: row.data.close,
          volume: row.data.volume,
        },
      })),
    );

    const result = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "1",
      "--dir",
      directory,
    ]);

    expect(result.snapshotPersisted).toBe(true);
    expect(result.selected).toContain("ALPHA");
    expect(result.canonicalBarPersistence.status).toBe("partial");
    expect(result.historyCollectionFailures[0]?.error).toContain("OHLCV was not filed");
    expect(await financeBarLedgerExists(directory)).toBe(false);
  });

  it("files remaining valid rows when a mixed batch has one undecodable bar", async () => {
    const directory = makeCacheDir();
    stubSelectionInputs(directory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    mockHistoryCollect.mockImplementationOnce(async ({ instrument }) => {
      const rows = makeMockHistoryRows("2026-09-24", 800, instrument);
      const [badRow, ...validRows] = rows;
      return badRow
        ? [{ ...badRow, data: { ...badRow.data, high: undefined } }, ...validRows]
        : rows;
    });

    const result = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "1",
      "--dir",
      directory,
    ]);

    expect(result.selected).toContain("ALPHA");
    expect(result.snapshotPersisted).toBe(true);
    expect(result.canonicalBarPersistence.status).toBe("partial");
    expect(result.canonicalBarPersistence.barCount).toBe(799);
    expect((await readFinanceBarLedger(directory, { instrument: "ALPHA" })).bars).toHaveLength(799);
  });

  it("does not let an unreadable non-selected candidate block filing the selected history", async () => {
    const directory = makeCacheDir();
    stubSelectionInputs(directory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
      BETA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    mockHistoryCollect.mockImplementation(async ({ instrument }) => {
      collectedHistorySymbols.push(instrument);
      if (instrument === "BETA") {
        throw new Error("history unavailable");
      }
      return makeMockHistoryRows("2026-09-24", 800, instrument);
    });

    const result = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "2",
      "--dir",
      directory,
    ]);

    expect(result.selected).toContain("ALPHA");
    expect(result.historyCollectionFailures).toEqual([
      { symbol: "BETA", error: "history unavailable" },
    ]);
    expect(result.snapshotPersisted).toBe(true);
    expect(result.canonicalBarPersistence.instruments.map((entry) => entry.symbol)).toEqual([
      "ALPHA",
    ]);
    expect((await readFinanceBarLedger(directory, { instrument: "ALPHA" })).bars).toHaveLength(800);
    expect((await readFinanceBarLedger(directory, { instrument: "BETA" })).bars).toHaveLength(0);
  });

  it("keeps the ready snapshot and reports canonical filing failure", async () => {
    const directory = makeCacheDir();
    stubSelectionInputs(directory, {
      ALPHA: { dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 10, v: 100 } },
    });
    fsSync.writeFileSync(financeBarLedgerPath(directory), "not a sqlite database", "utf8");
    mockHistoryCollect.mockImplementationOnce(async ({ instrument }) =>
      makeMockHistoryRows("2026-09-24", 800, instrument),
    );

    const result = await runUniverseSelectCapturingJson([
      "--json",
      "--write-snapshot",
      "--screen",
      "1",
      "--dir",
      directory,
    ]);

    expect(result.canonicalBarPersistence.status).toBe("failed");
    expect(result.canonicalBarPersistence.failures[0]?.symbol).toBe("ALPHA");
    expect(result.canonicalBarPersistence.instruments).toEqual([]);
    expect(result.snapshotPersisted).toBe(true);
    expect(
      fsSync.existsSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME)),
    ).toBe(true);
  });

  it("fails closed when all observed liquidity bars predate the expected completed session", async () => {
    const directory = makeCacheDir();
    const fetchMock = stubSelectionInputs(directory, {
      OLD: { prevDailyBar: { t: "2026-09-23T20:00:00.000Z", c: 10, v: 100 } },
    });
    const snapshotPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);

    await expect(
      runUniverseSelectSilently(["--json", "--write-snapshot", "--dir", directory]),
    ).rejects.toThrow("does not match expected completed session 2026-09-24");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockHistoryCollect).not.toHaveBeenCalled();
    expect(fsSync.existsSync(snapshotPath)).toBe(false);
  });

  it("fails closed without writing when selection crosses the regular-session close", async () => {
    const directory = makeCacheDir();
    stubSelectionInputs(directory, {
      ALPHA: {
        dailyBar: { t: "2026-09-24T20:00:00.000Z", c: 100, v: 1 },
        prevDailyBar: { t: "2026-09-23T20:00:00.000Z", c: 10, v: 100 },
      },
    });
    vi.setSystemTime(new Date("2026-09-24T19:59:00.000Z"));
    mockHistoryCollect.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-09-24T20:01:00.000Z"));
      return makeMockHistoryRows("2026-09-23", 800);
    });
    const snapshotPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);
    const rulePath = path.join(
      directory,
      "rule-declarations",
      "trend_risk_normalised_auto_v1.json",
    );

    await expect(
      runUniverseSelectSilently(["--json", "--write-snapshot", "--write-rule", "--dir", directory]),
    ).rejects.toThrow("latest completed session changed while selecting the universe");

    expect(fsSync.existsSync(snapshotPath)).toBe(false);
    expect(fsSync.existsSync(rulePath)).toBe(false);
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
