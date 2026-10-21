import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Type } from "@sinclair/typebox";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as barLedger from "../src/agents/finance-bar-ledger.js";
import * as researchBatch from "../src/agents/finance-research-batch.js";
import { financeResearchScoredPath } from "../src/agents/finance-state-dir.js";
import * as strategyLedger from "../src/agents/finance-strategy-rule-ledger.js";
import { jsonResult, readStringParam } from "../src/agents/tools/common.js";
import { createFinanceResearchBatchTool } from "../src/agents/tools/finance-research-batch-tool.js";
import { probeOriginalFinanceNightScheduler } from "./fixtures/lcx-waterflow-finance-scheduler-plan-probe.js";

const transport = vi.hoisted(() => ({
  seriesReads: 0,
  configReads: 0,
  externalFetches: 0,
  requests: [] as string[],
  supplyNightEod: false,
}));
vi.mock("../src/agents/finance-credential-env.js", () => ({
  resolveFinanceCredentialEnv: (env: NodeJS.ProcessEnv) => ({
    LCX_FINANCE_STATE_DIR: env.LCX_FINANCE_STATE_DIR,
    FMP_API_KEY: "private-response-fixture",
    LCX_FINANCE_HTTP_PROXY: "",
  }),
}));
async function privateCollectionFetch(input: string | URL | Request) {
  const url = input instanceof Request ? input.url : String(input);
  transport.requests.push(url);
  if (transport.supplyNightEod && url.includes("/api/qt/stock/kline/get")) {
    return new Response(JSON.stringify({ data: { klines: ["2026-02-02,118,120,121,117,1000"] } }), {
      status: 200,
    });
  }
  if (url.includes("price-target-summary")) {
    return new Response(
      JSON.stringify([{ symbol: "SPY", lastMonthAvgPriceTarget: 150, lastMonthCount: 20 }]),
      { status: 200 },
    );
  }
  if (url.includes("fredgraph.csv")) {
    const seriesId = new URL(url).searchParams.get("id")!;
    const rows = Array.from(
      { length: 100 },
      (_, index) =>
        `${new Date(Date.UTC(2025, 8, 23 + index)).toISOString().slice(0, 10)},${100 + index}`,
    );
    return new Response(`observation_date,${seriesId}\n${rows.join("\n")}\n`, { status: 200 });
  }
  return new Response("private transport does not supply live bars", { status: 404 });
}
vi.mock("../src/agents/finance-market-collection-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agents/finance-market-collection-registry.js")>();
  return {
    ...actual,
    createFinanceMarketCollectionRegistry: (
      options: Parameters<typeof actual.createFinanceMarketCollectionRegistry>[0],
    ) =>
      actual.createFinanceMarketCollectionRegistry({
        ...options,
        fetchImpl: privateCollectionFetch,
      }),
  };
});
vi.mock("../src/agents/finance-registered-capability-adapters.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/agents/finance-registered-capability-adapters.js")
    >();
  return {
    ...actual,
    createRegisteredCapabilityAdapters: (
      options: Parameters<typeof actual.createRegisteredCapabilityAdapters>[0],
    ) =>
      actual.createRegisteredCapabilityAdapters({ ...options, fetchImpl: privateCollectionFetch }),
  };
});
vi.mock("../src/agents/finance-macro-signal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/finance-macro-signal.js")>();
  return {
    ...actual,
    createPublicFredMacroSeriesSupplier: (
      options: Parameters<typeof actual.createPublicFredMacroSeriesSupplier>[0],
    ) =>
      actual.createPublicFredMacroSeriesSupplier({
        ...options,
        fetchText: async (url) => (await privateCollectionFetch(url)).text(),
      }),
  };
});
vi.mock("../src/agents/finance-outcome-backfill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/finance-outcome-backfill.js")>();
  return {
    ...actual,
    backfillOutcomes: (input: Parameters<typeof actual.backfillOutcomes>[0]) =>
      actual.backfillOutcomes({
        ...input,
        seriesFor: async () => {
          transport.seriesReads++;
          return [{ date: "2026-02-02", close: 120 }];
        },
      }),
  };
});
vi.mock("../src/config/config.js", () => ({
  loadConfig: () => {
    transport.configReads++;
    throw new Error("private night probe forbids live configuration");
  },
}));

let directory: string;
beforeEach(async () => {
  const retained = process.env.LCX_NIGHT_SCHEDULER_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
  }
  directory = await fs.mkdtemp(path.join(retained ?? os.tmpdir(), "native-night-scheduler-"));
  transport.seriesReads = 0;
  transport.configReads = 0;
  transport.externalFetches = 0;
  transport.requests = [];
  transport.supplyNightEod = false;
  vi.stubGlobal("fetch", () => {
    transport.externalFetches++;
    throw new Error("private night probe forbids external fetch");
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  barLedger.closeFinanceBarLedger(path.join(directory, "default-book"));
  barLedger.closeFinanceBarLedger(path.join(directory, "workspace", "state", "finance"));
  if (!process.env.LCX_NIGHT_SCHEDULER_PROOF_DIR) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const nativeBatch = researchBatch.runResearchBatch;
const nativeRuleRead = strategyLedger.readFinanceStrategyRuleLedger;
const nativeBarRead = barLedger.readFinanceBarLedger;
const batchSourceRepo = path.resolve(import.meta.dirname, "..");
const batchCalls: {
  input: Parameters<typeof nativeBatch>[0];
  result: Awaited<ReturnType<typeof nativeBatch>>;
}[] = [];
const ruleReads: { directory: string; value: Awaited<ReturnType<typeof nativeRuleRead>> }[] = [];
const barReads: { directory: string; value: Awaited<ReturnType<typeof nativeBarRead>> }[] = [];

async function privateBatchBooks(withCurrentBars = true) {
  const defaultBook = path.join(directory, "default-book");
  const currentBook = path.join(directory, "workspace", "state", "finance");
  await fs.mkdir(defaultBook, { recursive: true });
  await fs.mkdir(currentBook, { recursive: true });
  vi.stubEnv("LCX_FINANCE_STATE_DIR", defaultBook);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T23:00:00.000Z"));
  for (const [book, instrument] of [
    [defaultBook, "OLD"],
    [currentBook, "SPY"],
  ]) {
    await strategyLedger.declareFinanceStrategyRule(book, {
      kind: "declared",
      ruleId: "private-batch-rule",
      form: "expression",
      instruments: [instrument],
      emits: "target_weights",
      schedule: { kind: "daily", at: "21:30", timezone: "America/New_York" },
      body: { expression: "close > sma(close, 20)" },
      observedAt: "2025-12-01T00:00:00.000Z",
    });
    await strategyLedger.activateFinanceStrategyRule(book, {
      kind: "activated",
      ruleId: "private-batch-rule",
      observedAt: "2025-12-01T01:00:00.000Z",
    });
  }
  const barWrites = [];
  for (const [book, lastPrice] of [
    [defaultBook, 777],
    ...(withCurrentBars ? [[currentBook, 100]] : []),
  ] as [string, number][]) {
    barWrites.push(
      await barLedger.appendFinanceBars(book, {
        instrument: "SPY",
        derivation: "ohlcv",
        provenance: {
          origin: "private_native_bar_fixture",
          sourceUrlOrArtifact: `fixture://${path.basename(book)}/SPY`,
        },
        observedAt: "2025-12-31T23:00:00.000Z",
        bars: Array.from({ length: 60 }, (_, index) => {
          const close = lastPrice * (0.5 + index / 118);
          return {
            date: new Date(Date.UTC(2025, 10, 2 + index)).toISOString().slice(0, 10),
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1_000,
          };
        }),
      }),
    );
  }
  batchCalls.length = 0;
  ruleReads.length = 0;
  barReads.length = 0;
  vi.spyOn(researchBatch, "runResearchBatch").mockImplementation(async (input) => {
    const result = await nativeBatch(input);
    batchCalls.push({ input, result });
    return result;
  });
  vi.spyOn(strategyLedger, "readFinanceStrategyRuleLedger").mockImplementation(async (...args) => {
    const value = await nativeRuleRead(...args);
    ruleReads.push({ directory: args[0], value });
    return value;
  });
  vi.spyOn(barLedger, "readFinanceBarLedger").mockImplementation(async (book, filter) => {
    const value = await nativeBarRead(book, filter);
    barReads.push({ directory: book, value });
    return value;
  });
  return { defaultBook, currentBook, barWrites };
}

async function originalBatchEntry(
  kind: "cli" | "tool",
  args: string[] | Record<string, unknown>,
  historical = false,
) {
  const relative =
    kind === "cli"
      ? "scripts/operator/lcx-finance-research-batch.ts"
      : "src/agents/tools/finance-research-batch-tool.ts";
  const sourcePath = historical
    ? path.join(process.env.LCX_BATCH_BOOK_BEFORE_SOURCE_DIR!, relative)
    : path.join(batchSourceRepo, relative);
  const source = await fs.readFile(sourcePath, "utf8");
  if (kind === "tool" && !historical) {
    const toolReadback = await createFinanceResearchBatchTool().execute(
      "private-original-batch",
      args,
    );
    return {
      sourcePath,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      stdout: "",
      toolReadback,
    };
  }
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements
    .filter((node) => !ts.isImportDeclaration(node) && !ts.isExpressionStatement(node))
    .map((node) => node.getText(ast))
    .join("\n");
  let stdout = "";
  const context = vm.createContext({
    Type,
    DEFAULT_POOL: researchBatch.DEFAULT_POOL,
    runResearchBatch: researchBatch.runResearchBatch,
    jsonResult,
    readStringParam,
    exports: {},
    process: {
      argv: ["node", sourcePath, ...(Array.isArray(args) ? args : [])],
      stdout: {
        write: (value: string) => {
          stdout += value;
        },
      },
    },
  });
  const code = ts.transpileModule(
    `${declarations}\nglobalThis.nativeEntry=${kind === "cli" ? "main" : "createFinanceResearchBatchTool()"};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  new vm.Script(code, { filename: sourcePath }).runInContext(context);
  if (kind === "cli") {
    await (context.nativeEntry as () => Promise<void>)();
  } else {
    await (context.nativeEntry as ReturnType<typeof createFinanceResearchBatchTool>).execute(
      "private-original-batch",
      args,
    );
  }
  return { sourcePath, sourceSha256: createHash("sha256").update(source).digest("hex"), stdout };
}

async function saveBatchProof(name: string, value: unknown) {
  await fs.writeFile(
    path.join(directory, `${name}.json`),
    JSON.stringify(
      {
        value,
        batchCalls,
        ruleReads,
        barReads,
        transport,
        boundary:
          "actual_original_entries_and_batch_signal_fusion_private_native_books_scripted_HTTP_not_source_truth",
        accountRunBinding: "not_observed",
      },
      null,
      2,
    ) + "\n",
  );
}

describe("original research batch entry uses the declared finance book", () => {
  it("captures the original mixed-book failure before the entry fix", async () => {
    if (!process.env.LCX_BATCH_BOOK_BEFORE_SOURCE_DIR) {
      return;
    }
    const books = await privateBatchBooks();
    const oldTool = await originalBatchEntry(
      "tool",
      {
        directory: books.currentBook,
        instruments: "SPY",
        recordPath: path.join(books.currentBook, "before-tool.jsonl"),
        maxInstruments: 1,
      },
      true,
    );
    const oldCli = await originalBatchEntry(
      "cli",
      [
        "--dir",
        books.currentBook,
        "--instruments",
        "SPY",
        "--record",
        path.join(books.currentBook, "before-cli.jsonl"),
      ],
      true,
    );
    await saveBatchProof("before-mixed-book", { books, oldTool, oldCli });
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls.map((call) => call.input?.directory)).toEqual([undefined, undefined]);
    expect(batchCalls.map((call) => call.result.recorded[0]?.lastPrice)).toEqual([777, 777]);
    expect(ruleReads.every((read) => read.directory === books.defaultBook)).toBe(true);
    expect(barReads.every((read) => read.directory === books.defaultBook)).toBe(true);
  });
  it.each(["cli", "tool"] as const)(
    "uses the same %s book for rule/bar reads, original sample bytes and the next night caller",
    async (kind) => {
      const books = await privateBatchBooks();
      const entry =
        kind === "cli"
          ? await originalBatchEntry("cli", ["--dir", books.currentBook, "--instruments", "SPY"])
          : await originalBatchEntry("tool", {
              directory: books.currentBook,
              instruments: "SPY,QQQ",
              maxInstruments: 1,
            });
      const batch = batchCalls[0]?.result;
      const samplePath = path.join(books.currentBook, "research-samples.jsonl");
      const producerBytes = await fs.readFile(samplePath);
      const producerSha256 = createHash("sha256").update(producerBytes).digest("hex");
      await saveBatchProof(`after-${kind}-producer`, {
        books,
        entry,
        samplePath,
        producerSha256,
        producerBody: producerBytes.toString("utf8"),
      });
      expect(batchCalls).toHaveLength(1);
      expect(batchCalls[0]?.input).toMatchObject({
        directory: books.currentBook,
        instruments: ["SPY"],
      });
      expect(batch?.recordPath).toBe(samplePath);
      expect(batch?.recorded).toHaveLength(1);
      expect(batch?.recorded[0]).toMatchObject({
        instrument: "SPY",
        lastPrice: 100,
        priceSource: "bar_ledger",
        direction: "buy",
      });
      expect(batch?.recorded[0]?.conviction).toBeGreaterThan(0);
      expect(ruleReads.every((read) => read.directory === books.currentBook)).toBe(true);
      expect(barReads.every((read) => read.directory === books.currentBook)).toBe(true);
      const batchSelectedRules = ruleReads[0]?.value.ledger.rules;
      expect(batchSelectedRules?.find((rule) => rule.state === "active")?.instruments).toEqual([
        "SPY",
      ]);
      vi.setSystemTime(new Date("2026-02-02T23:00:00.000Z"));
      transport.supplyNightEod = true;
      const night = await run("existing");
      await saveBatchProof(`after-${kind}-night`, {
        entry,
        producerSha256,
        nightProof: path.join(directory, "native-night-scheduler.json"),
        sourceReads: night.sourceReads,
      });
      expect(night.sampleSourceSha256).toBe(producerSha256);
      expect(await fs.readFile(samplePath)).toEqual(producerBytes);
      expect(night.accepted).toBe(true);
      expect(night.actualNightOutput).toMatchObject({
        ok: true,
        sampleCount: 1,
        scoredFiled: { appended: 1 },
      });
      expect(night.record.tuningLifecycle?.result?.proposal.samplesUsed).toBe(1);
      expect(night.record.tuningLifecycle?.result?.paperExecutionPromotion.status).toBe("blocked");
      expect(transport.configReads).toBe(0);
      expect(transport.externalFetches).toBe(0);
    },
  );

  it("preserves explicit record overrides while binding the source readers to the declared book", async () => {
    const books = await privateBatchBooks();
    const recordPath = path.join(directory, "deliberate-separate-output.jsonl");
    const entry = await originalBatchEntry("cli", [
      "--dir",
      books.currentBook,
      "--instruments",
      "SPY",
      "--record",
      recordPath,
    ]);
    await saveBatchProof("record-override", { books, entry });
    expect(batchCalls[0]?.input).toMatchObject({ directory: books.currentBook, recordPath });
    expect(batchCalls[0]?.result.recordPath).toBe(recordPath);
    expect(batchCalls[0]?.result.recorded[0]?.lastPrice).toBe(100);
    expect(barReads.every((read) => read.directory === books.currentBook)).toBe(true);
  });

  it("does not borrow the default book price when the explicitly selected source book has no bars", async () => {
    const books = await privateBatchBooks(false);
    const entry = await originalBatchEntry("tool", {
      directory: books.currentBook,
      instruments: "SPY,QQQ",
      maxInstruments: 1,
    });
    await saveBatchProof("foreign-book-missing-source", { books, entry });
    expect(batchCalls[0]?.result.recorded[0]).toMatchObject({
      instrument: "SPY",
      lastPrice: 0,
      priceSource: "none",
      direction: "none",
      conviction: 0,
    });
    expect(batchCalls[0]?.result.recorded[0]?.refusals?.length).toBeGreaterThan(0);
    expect(barReads.every((read) => read.directory === books.currentBook)).toBe(true);
    vi.setSystemTime(new Date("2026-02-02T23:00:00.000Z"));
    const night = await run("existing");
    expect(night.actualNightOutput).toMatchObject({ scoredFiled: { appended: 0 } });
    expect(night.accepted).toBe(false);
    expect(night.actualNightOutput).toMatchObject({
      ok: false,
      issues: ["SPY: no complete OHLC row from configured EOD sources"],
    });
    expect(night.record.tuningLifecycle).toBeUndefined();
    expect(transport.seriesReads).toBe(0);
  });
});

async function run(
  sampleSource: Parameters<typeof probeOriginalFinanceNightScheduler>[0]["sampleSource"],
) {
  const result = await probeOriginalFinanceNightScheduler({ directory, sampleSource });
  await fs.writeFile(
    path.join(directory, "transport-observations.json"),
    JSON.stringify({ sampleSource, ...transport }, null, 2) + "\n",
  );
  expect(transport.configReads).toBe(0);
  expect(transport.externalFetches).toBe(0);
  expect(result.record.nightReview).toBeUndefined();
  expect(
    result.children.some((child) =>
      child.argv.some((arg) => arg.includes("lcx-finance-research-run")),
    ),
  ).toBe(false);
  return result;
}

describe("original scheduler night caller → actual settlement → original calibration reader", () => {
  it("consumes this child scored ledger and independently reads its proposal without execution promotion", async () => {
    const result = await run("available");
    expect(result.accepted).toBe(true);
    expect(result.actualNightOutput).toMatchObject({
      ok: true,
      modelCalls: 0,
      scoredFiled: { appended: 5 },
    });
    expect(result.children[0]).toMatchObject({ kind: "night", exitCode: 0 });
    expect(JSON.parse(result.children[0].stdout)).toEqual(result.actualNightOutput);
    expect(result.children[0].argv).toContain(result.directory);
    expect(result.record.tuningLifecycle?.status).toBe("completed");
    const tuning = result.record.tuningLifecycle?.result;
    expect(tuning?.proposal.samplesUsed).toBe(5);
    expect(tuning?.newlyRecorded).toBe(1);
    expect(tuning?.promotions).toEqual([]);
    expect(tuning?.paperExecutionPromotion).toEqual({
      status: "blocked",
      reason: "directional_forecast_outcomes_are_not_net_trade_pnl",
    });
    const scoredBytes = await fs.readFile(financeResearchScoredPath(result.directory));
    const scoredRead = result.sourceReads.find(
      (read) => read.path === financeResearchScoredPath(result.directory),
    );
    expect(scoredRead?.sha256).toBe(createHash("sha256").update(scoredBytes).digest("hex"));
    expect(scoredRead?.text).toBe(scoredBytes.toString("utf8"));
    const toolText = result.proposalToolReadback.content.find((item) => item.type === "text");
    expect(toolText?.type).toBe("text");
    if (toolText?.type !== "text") {
      throw new Error("original proposal tool text missing");
    }
    expect(JSON.parse(toolText.text)).toMatchObject({
      ok: true,
      count: 1,
      proposals: tuning?.proposal.proposals,
    });
    expect(result.record.intradayCloseCapture).toMatchObject({
      status: "skipped",
      reason: "intraday_not_configured",
    });
    expect(result.record.universeSelection?.status).toBe("failed");
    expect(result.children[1]).toMatchObject({ kind: "universe", exitCode: 2, stdout: "" });
    expect(transport.seriesReads).toBe(1);
  });

  it.each(["missing", "invalid_json"] as const)(
    "preserves %s source failure through the actual child and scheduler without tuning",
    async (sampleSource) => {
      const result = await run(sampleSource);
      expect(result.accepted).toBe(false);
      expect(result.record).toMatchObject({ ok: false, status: "failed" });
      expect(result.actualNightOutput).toMatchObject({
        ok: false,
        failureKind: "night_sample_source_gate",
        sampleSource: { status: sampleSource },
        scoredFiled: { appended: 0 },
      });
      expect(result.children).toHaveLength(2);
      expect(result.children[0]).toMatchObject({ kind: "night", exitCode: 2 });
      expect(result.children[1]).toMatchObject({ kind: "universe", exitCode: 2 });
      expect(result.record.universeSelection?.status).toBe("failed");
      expect(result.record.tuningLifecycle).toBeUndefined();
      expect(result.sourceReads).toEqual([]);
      expect(transport.seriesReads).toBe(0);
    },
  );

  it("retains readable empty source as zero-new-scored skip rather than a missing-source block", async () => {
    const result = await run("empty");
    expect(result.accepted).toBe(true);
    expect(result.actualNightOutput).toMatchObject({
      ok: true,
      sampleCount: 0,
      scoredFiled: { appended: 0 },
    });
    expect(result.record.tuningLifecycle).toEqual({
      ok: true,
      status: "no_new_scored_outcomes",
      result: null,
    });
    expect(result.sourceReads).toEqual([]);
    expect(transport.seriesReads).toBe(0);
  });
});
