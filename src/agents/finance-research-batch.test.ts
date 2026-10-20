import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordedKeys, researchPricedRows, runResearchBatch } from "./finance-research-batch.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
} from "./finance-strategy-rule-ledger.js";

vi.mock("./finance-credential-env.js", () => ({
  resolveFinanceCredentialEnv: (env: NodeJS.ProcessEnv) => env,
}));

/**
 * Where a sample is recorded decides which book the night run settles.
 *
 * These used to be reached as `state/finance/...` relative to the process working directory, which
 * is the right book only while the caller happens to be started from the repository root. A
 * scheduler is not, and would have written a second samples file beside the first while the night
 * run settled the empty one and reported "no history" forever.
 *
 * An empty instrument list keeps this offline: nothing is collected, so the only thing under test
 * is where the file would go.
 */

const KEY = { FMP_API_KEY: "test-key" };

const savedStateDir = process.env.LCX_FINANCE_STATE_DIR;
const scopeDirectories: string[] = [];

afterEach(() => {
  if (savedStateDir === undefined) {
    delete process.env.LCX_FINANCE_STATE_DIR;
  } else {
    process.env.LCX_FINANCE_STATE_DIR = savedStateDir;
  }
  for (const directory of scopeDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runResearchBatch native rule scope", () => {
  async function scopedBooks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-rule-scope-"));
    scopeDirectories.push(root);
    const books = { root, a: path.join(root, "a"), b: path.join(root, "b") };
    fs.mkdirSync(books.a);
    fs.mkdirSync(books.b);
    process.env.LCX_FINANCE_STATE_DIR = books.a;
    return books;
  }

  async function activate(directory: string, instruments: string[]) {
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "scope-rule",
      form: "expression",
      instruments,
      emits: "target_weights",
      schedule: { kind: "daily", at: "21:30", timezone: "America/New_York" },
      body: { expression: "close > sma(close, 20)" },
      observedAt: "2026-09-17T00:00:00Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "scope-rule",
      observedAt: "2026-09-17T01:00:00Z",
    });
  }

  async function retain(
    name: string,
    books: Awaited<ReturnType<typeof scopedBooks>>,
    result: Awaited<ReturnType<typeof runResearchBatch>>,
  ) {
    const proofRoot = process.env.LCX_FINANCE_BATCH_SCOPE_PROOF_DIR;
    if (!proofRoot) {
      return;
    }
    const destination = path.join(proofRoot, name);
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(books.root, path.join(destination, "private-books"), { recursive: true });
    fs.writeFileSync(
      path.join(destination, "native-result.json"),
      JSON.stringify(
        {
          defaultDirectory: books.a,
          explicitDirectory: name === "default_compatibility" ? null : books.b,
          result,
          a: await readFinanceStrategyRuleLedger(books.a),
          b: await readFinanceStrategyRuleLedger(books.b),
          boundary: "private_native_ledgers_zero_collection_no_model_or_provider",
        },
        null,
        2,
      ) + "\n",
    );
  }

  it("does not borrow an active rule from the default book when the explicit book is empty", async () => {
    const books = await scopedBooks();
    await activate(books.a, ["AAA"]);
    const result = await runResearchBatch({ directory: books.b, instruments: [], env: {} });
    await retain("explicit_empty", books, result);
    expect(result.recordPath).toBe(path.join(books.b, "research-samples.jsonl"));
    expect(result.universeSource).toBe("fallback_pool");
    expect(result.recorded).toEqual([]);
    expect(result.requested).toBe(0);
  });

  it("reads active rules from the explicit book while the default book is empty", async () => {
    const books = await scopedBooks();
    await activate(books.b, ["BBB"]);
    const result = await runResearchBatch({ directory: books.b, instruments: [], env: {} });
    await retain("explicit_active", books, result);
    expect(result.universeSource).toBe("active_rule");
    expect(result.recorded).toEqual([]);
    expect(result.requested).toBe(0);
  });

  it("selects only the explicit book's instruments before skipping already priced samples", async () => {
    const books = await scopedBooks();
    await activate(books.a, ["AAA", "AAB"]);
    await activate(books.b, ["BBB"]);
    // All possible symbols are already priced today: the original selector executes, while
    // the original idempotency filter prevents every source collection call.
    fs.writeFileSync(
      path.join(books.b, "research-samples.jsonl"),
      ["AAA", "AAB", "BBB"]
        .map((instrument) =>
          JSON.stringify({ instrument, asOf: new Date().toISOString(), lastPrice: 1 }),
        )
        .join("\n") + "\n",
    );
    const result = await runResearchBatch({ directory: books.b, env: {} });
    await retain("explicit_instruments", books, result);
    expect(result.universeSource).toBe("active_rule");
    expect(result.requested).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.recorded).toEqual([]);
  });

  it("preserves default-book selection when no explicit directory is supplied", async () => {
    const books = await scopedBooks();
    await activate(books.a, ["AAA"]);
    const result = await runResearchBatch({ instruments: [], env: {} });
    await retain("default_compatibility", books, result);
    expect(result.recordPath).toBe(path.join(books.a, "research-samples.jsonl"));
    expect(result.universeSource).toBe("active_rule");
    expect(result.recorded).toEqual([]);
  });
});

describe("runResearchBatch sample path", () => {
  it("follows the finance state directory from the environment", async () => {
    process.env.LCX_FINANCE_STATE_DIR = "/tmp/lcx-state-a";
    const result = await runResearchBatch({ instruments: [], env: KEY });
    expect(result.recordPath).toBe(path.join("/tmp/lcx-state-a", "research-samples.jsonl"));
  });

  it("prefers an explicit directory over the environment", async () => {
    process.env.LCX_FINANCE_STATE_DIR = "/tmp/lcx-state-a";
    const result = await runResearchBatch({
      instruments: [],
      env: KEY,
      directory: "/tmp/lcx-state-b",
    });
    expect(result.recordPath).toBe(path.join("/tmp/lcx-state-b", "research-samples.jsonl"));
  });

  it("never hands back a path the working directory can change", async () => {
    // The defect was not the directory name, it was that the answer depended on where the process
    // was started. An absolute path is the minimum that has to be true for the rest to matter.
    process.env.LCX_FINANCE_STATE_DIR = "/tmp/lcx-state-a";
    const result = await runResearchBatch({ instruments: [], env: KEY });
    expect(path.isAbsolute(result.recordPath)).toBe(true);
    expect(result.recordPath).not.toContain("state/finance/");
  });
});

describe("recordedKeys", () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sample-keys-")), "s.jsonl");

  it("counts a priced sample as already sampled", () => {
    const target = file();
    fs.writeFileSync(
      target,
      JSON.stringify({ instrument: "SPY", asOf: "2026-09-21T00:00:00.000Z", lastPrice: 761.69 }) +
        "\n",
    );
    expect(recordedKeys(target).has("SPY|2026-09-21")).toBe(true);
  });

  it("does not let a priceless sample block re-collection forever", () => {
    // Recorded while FMP was refusing the symbol: `lastPrice: 0`, not an observation. Counting
    // it as sampled froze the failure -- every later run skipped it, including the runs after
    // the cause was fixed.
    const target = file();
    fs.writeFileSync(
      target,
      JSON.stringify({ instrument: "QQQ", asOf: "2026-09-21T00:00:00.000Z", lastPrice: 0 }) + "\n",
    );
    expect(recordedKeys(target).has("QQQ|2026-09-21")).toBe(false);
  });
});

describe("research price provenance", () => {
  it("keeps date/source on the same selected price row without turning collection time into quote time", () => {
    const rows = researchPricedRows([
      { data: { date: "2026-09-20", close: 100 }, sourceUrlOrArtifact: "fixture://newer" },
      { data: { date: "2026-09-19", close: 90 }, sourceUrlOrArtifact: "fixture://older" },
    ]);
    expect(rows.at(-1)).toMatchObject({
      date: "2026-09-20",
      close: 100,
      sourceUrlOrArtifact: "fixture://newer",
    });
    expect(rows.at(-1)).not.toHaveProperty("lastPriceAt");
  });
  it("does not borrow provenance from another row", () => {
    const rows = researchPricedRows([
      { data: { date: "2026-09-19", close: 90 }, sourceUrlOrArtifact: "fixture://older" },
      { data: { date: "2026-09-20", close: 100 } },
    ]);
    expect(rows.at(-1)?.sourceUrlOrArtifact).toBeUndefined();
  });
});

it("shares one verified ledger snapshot across default fallback instruments", async () => {
  const ledger = await import("./finance-bar-ledger.js");
  const collections = await import("./finance-market-collection-registry.js");
  const capabilities = await import("./finance-registered-capability-adapters.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "batch-bar-snapshot-"));
  scopeDirectories.push(directory);
  for (const [instrument, close] of [
    ["SPY", 100],
    ["QQQ", 200],
  ] as const) {
    await ledger.appendFinanceBars(directory, {
      instrument,
      derivation: "ohlcv",
      observedAt: "2026-09-10T00:00:00Z",
      provenance: { origin: "fixture" },
      bars: [{ date: "2026-09-09", open: close, high: close, low: close, close }],
    });
  }
  const read = vi.spyOn(ledger, "readFinanceBarLedger");
  vi.spyOn(collections, "createFinanceMarketCollectionRegistry").mockReturnValue([]);
  vi.spyOn(capabilities, "createRegisteredCapabilityAdapters").mockReturnValue([]);
  try {
    const result = await runResearchBatch({
      directory,
      instruments: ["SPY", "QQQ"],
      env: {},
      warn: () => {},
      macroFor: async () => [],
      newsFor: async () => ({ sourceId: "fixture", items: [] }),
    });
    expect(result.recorded.map((row) => [row.instrument, row.lastPrice, row.priceSource])).toEqual([
      ["SPY", 100, "bar_ledger"],
      ["QQQ", 200, "bar_ledger"],
    ]);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(directory, { instruments: ["SPY", "QQQ"] });
    await ledger.appendFinanceBars(directory, {
      instrument: "SPY",
      derivation: "ohlcv",
      observedAt: "2026-09-11T00:00:00Z",
      provenance: { origin: "fixture" },
      bars: [{ date: "2026-09-10", open: 101, high: 101, low: 101, close: 101 }],
    });
    const next = await runResearchBatch({
      directory,
      recordPath: path.join(directory, "next-batch.jsonl"),
      instruments: ["SPY", "QQQ"],
      env: {},
      warn: () => {},
      macroFor: async () => [],
      newsFor: async () => ({ sourceId: "fixture", items: [] }),
    });
    expect(next.recorded.map((row) => row.lastPrice)).toEqual([101, 200]);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
  }
});
