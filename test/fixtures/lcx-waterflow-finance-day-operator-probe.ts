import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { runFinanceDailyCycleOperator } from "../../scripts/operator/lcx-finance-daily-cycle.js";
import {
  appendUniverseEodBatch,
  validateUniverseEodBatch,
} from "../../scripts/operator/lcx-finance-universe-select.js";
import { readFinanceBarLedger } from "../../src/agents/finance-bar-ledger.js";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import {
  isFinanceUsEquityDailyBarComplete,
  latestCompletedWeekdaySessionDate,
} from "../../src/agents/finance-cycle-schedule.js";
import { createChinaReachableUsEodHistoryCollectionAdapter } from "../../src/agents/finance-free-market-collection-adapters.js";
import type { FetchImpl } from "../../src/agents/finance-live-market-source.js";
import { readFinancePositionLedger } from "../../src/agents/finance-position-ledger.js";
import { readFinanceResearchEquityUniverseSnapshot } from "../../src/agents/finance-research-runner.js";
import { readFinanceRuleReadinessState } from "../../src/agents/finance-rule-readiness-state.js";
import {
  financeReadinessThresholdsPath,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import {
  readFinanceStrategyRuleLedger,
  retireFinanceStrategyRule,
} from "../../src/agents/finance-strategy-rule-ledger.js";
import * as universe from "../../src/agents/finance-universe-selection.js";
import { saveJsonFile } from "../../src/infra/json-file.js";
import { probeOriginalFinanceSchedulerPlan } from "./lcx-waterflow-finance-scheduler-plan-probe.js";

const repo = path.resolve(import.meta.dirname, "../..");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export type DayOperatorFault =
  | "missing_universe"
  | "stale_universe"
  | "missing_prices"
  | "missing_rule"
  | "expired_plan"
  | "broker_unknown"
  | "replaced_plan"
  | "foreign_plan_scope";

async function produceOriginalUniverse(directory: string, asOf: string, fetchImpl: FetchImpl) {
  const sourcePath = path.join(repo, "scripts/operator/lcx-finance-universe-select.ts");
  const source = await fsp.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const names = [
    "runUniverseSelect",
    "parseUniverseSelectArgs",
    "readFreshAssetCache",
    "writeAssetCache",
    "loadAssets",
    "loadQuotes",
    "mapWithConcurrency",
    "alpacaHeaders",
  ];
  const declarations = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  if (declarations.length !== names.length) {
    throw new Error("original universe owner functions missing");
  }
  const date = latestCompletedWeekdaySessionDate(asOf);
  const snapshotCalls: string[] = [];
  let stdout = "";
  let stderr = "";
  // Inputs, not a selected result: the original filters/metrics/eligibility/diversification choose SPY.
  saveJsonFile(path.join(directory, "alpaca-assets.json"), [
    {
      symbol: "SPY",
      name: "Private plain equity fund",
      status: "active",
      tradable: true,
      exchange: "ARCA",
    },
  ]);
  class ScopedDate extends Date {
    constructor(value?: string | number | Date) {
      super(value === undefined ? asOf : value instanceof Date ? value.getTime() : value);
    }
    static now() {
      return Date.parse(asOf);
    }
  }
  const context = vm.createContext({
    ...universe,
    fs,
    path,
    Date: ScopedDate,
    AbortSignal,
    process: {
      env: {
        LCX_FINANCE_STATE_DIR: directory,
        ALPACA_API_KEY_ID: "private-io-stub",
        ALPACA_API_SECRET_KEY: "private-io-stub",
      },
      stdout: {
        write: (text: string) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
        },
      },
    },
    resolveFinanceCredentialEnv,
    resolveFinanceStateDir,
    saveJsonFile,
    validateUniverseEodBatch,
    appendUniverseEodBatch,
    isFinanceUsEquityDailyBarComplete,
    latestCompletedWeekdaySessionDate,
    ASSETS_URL: "https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",
    MAX_ASSET_AGE_DAYS: 7,
    SNAPSHOT_BATCH: 500,
    HISTORY_LIMIT: 1200,
    CONCURRENCY: 6,
    createChinaReachableUsEodHistoryCollectionAdapter: () =>
      createChinaReachableUsEodHistoryCollectionAdapter({ fetchImpl }),
    fetch: async (url: string) => {
      snapshotCalls.push(url);
      if (!url.startsWith("https://data.alpaca.markets/v2/stocks/snapshots?")) {
        throw new Error("unexpected local universe HTTP request");
      }
      return {
        status: 200,
        json: async () => ({ SPY: { dailyBar: { t: `${date}T20:00:00Z`, c: 200, v: 1_000_000 } } }),
      };
    },
  });
  const code = ts.transpileModule(
    `${declarations.map((node) => node.getText(ast).replace(/^export\s+/u, "")).join("\n")}\nglobalThis.nativeOwner=runUniverseSelect;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  new vm.Script(code, { filename: sourcePath }).runInContext(context);
  await (context.nativeOwner as (argv: string[]) => Promise<void>)([
    "--json",
    "--dir",
    directory,
    "--screen",
    "1",
    "--write-snapshot",
  ]);
  const snapshot = readFinanceResearchEquityUniverseSnapshot(directory, asOf);
  return { snapshot, stdout, stderr, snapshotCalls, sourceSha256: sha(source) };
}

/** Complete original day/universe owners use local raw HTTP responses.
 * The inherited scheduler child transport and upstream research model remain scripted IO;
 * the earlier native producer is not proof that it consumed newly assembled preflight evidence.
 */
export async function probeOriginalFinanceDayOperator(params: {
  directory: string;
  allocation?: number;
  fault?: DayOperatorFault;
  installPrivateIo: (input: { workspace: string; directory: string; fetchImpl: FetchImpl }) => void;
  researchPreparation?: Parameters<
    typeof probeOriginalFinanceSchedulerPlan
  >[0]["researchPreparation"];
  researchChildConsumer?: Parameters<
    typeof probeOriginalFinanceSchedulerPlan
  >[0]["researchChildConsumer"];
}) {
  let dayReport: Record<string, unknown> | undefined;
  let operatorArgv: string[] = [];
  let universeProof: Awaited<ReturnType<typeof produceOriginalUniverse>> | undefined;
  let beforeReadiness: Awaited<ReturnType<typeof readFinanceRuleReadinessState>> | undefined;
  let afterReadiness: Awaited<ReturnType<typeof readFinanceRuleReadinessState>> | undefined;
  let bookReadback: Awaited<ReturnType<typeof readFinanceBarLedger>> | undefined;
  let positionReadback: Awaited<ReturnType<typeof readFinancePositionLedger>> | undefined;
  const priceCalls: Array<{ url: string; phase: string }> = [];
  const result = await probeOriginalFinanceSchedulerPlan({
    directory: params.directory,
    allocation: params.allocation,
    dailyExecutableRule: true,
    researchPreparation: params.researchPreparation,
    researchChildConsumer: params.researchChildConsumer,
    dayChildConsumer: async ({ argv, directory, planPath, nativeProducer, signal }) => {
      signal.throwIfAborted();
      if (argv[argv.indexOf("--portfolio-plan") + 1] !== planPath) {
        throw new Error("original scheduler plan path does not match day consumer path");
      }
      const asOf = nativeProducer.receipt!.plan.asOf;
      const rows: string[] = [];
      const cutoff = Date.parse(asOf.slice(0, 10) + "T00:00:00Z");
      for (let offset = 1500; offset > 0; offset--) {
        const day = new Date(cutoff - offset * 86_400_000);
        if ([0, 6].includes(day.getUTCDay())) {
          continue;
        }
        const price = 100 + (1500 - offset) * 0.05 + Math.sin(offset) * 1;
        rows.push(
          `${day.toISOString().slice(0, 10)},${price},${price},${price + 1},${price - 1},1000000`,
        );
      }
      let phase = "universe";
      const fetchImpl: FetchImpl = async (url) => {
        priceCalls.push({ url: String(url), phase });
        if (phase === "operator" && params.fault === "missing_prices") {
          throw new Error("private EOD price source unavailable");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: { klines: rows } }),
        };
      };
      params.installPrivateIo({ workspace: nativeProducer.workspace, directory, fetchImpl });
      universeProof = await produceOriginalUniverse(directory, asOf, fetchImpl);
      const thresholdPath = financeReadinessThresholdsPath(directory);
      saveJsonFile(thresholdPath, {
        minPaperDays: 28,
        minObservations: 20,
        reversalDrawdownPercent: 3,
        chopMinFlips: 4,
        gapMovePercent: 2,
      });
      const rules = (await readFinanceStrategyRuleLedger(directory, { asOf })).ledger.rules;
      beforeReadiness = await readFinanceRuleReadinessState({ directory, asOf, rules });
      await fsp.writeFile(
        path.join(params.directory, "native-universe-before-fault.json"),
        JSON.stringify(universeProof.snapshot, null, 2) + "\n",
      );
      if (params.fault === "missing_universe") {
        await fsp.unlink(
          path.join(directory, universe.FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME),
        );
      }
      if (params.fault === "stale_universe") {
        const old = new Date(Date.parse(asOf) - 8 * 86_400_000).toISOString();
        saveJsonFile(path.join(directory, universe.FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME), {
          ...universeProof.snapshot,
          asOf: old,
          generatedAt: old,
        });
      }
      if (params.fault === "missing_rule") {
        await retireFinanceStrategyRule(directory, {
          kind: "retired",
          ruleId: "private-trend",
          observedAt: asOf,
        });
      }
      operatorArgv = [
        ...argv.slice(argv.indexOf("--json")),
        "--as-of",
        params.fault === "expired_plan"
          ? new Date(Date.parse(nativeProducer.planReadback!.validUntil) + 1).toISOString()
          : asOf,
        "--equity",
        "100000",
        "--max-instrument-notional",
        "50000",
      ];
      if (params.fault === "broker_unknown") {
        operatorArgv[operatorArgv.indexOf("--venue") + 1] = "alpaca";
        operatorArgv.push(
          "--place",
          "--execution-quote-feed",
          "iex",
          "--execution-max-age-ms",
          "1000",
        );
      }
      if (params.fault === "replaced_plan") {
        const original = JSON.parse(await fsp.readFile(planPath, "utf8"));
        await fsp.writeFile(
          planPath,
          JSON.stringify({ ...original, accountId: "replacement-account" }) + "\n",
        );
      }
      if (params.fault === "foreign_plan_scope") {
        operatorArgv[operatorArgv.indexOf("--portfolio-plan-account") + 1] = "foreign-account";
      }
      phase = "operator";
      dayReport = await runFinanceDailyCycleOperator(operatorArgv);
      signal.throwIfAborted();
      await fsp.writeFile(
        path.join(params.directory, "native-day-operator-report.json"),
        JSON.stringify(dayReport, null, 2) + "\n",
      );
      const afterRules = (await readFinanceStrategyRuleLedger(directory)).ledger.rules;
      afterReadiness = await readFinanceRuleReadinessState({ directory, asOf, rules: afterRules });
      bookReadback = await readFinanceBarLedger(directory, { asOf });
      positionReadback = await readFinancePositionLedger(directory, { asOf });
      return {
        ok: dayReport.ok === true,
        status: dayReport.ok === true ? "succeeded" : "failed",
        exitCode: dayReport.ok === true ? 0 : 2,
        signal: null,
        stdout: JSON.stringify(dayReport) + "\n",
        stderr: "",
        outputTruncated: false,
      };
    },
  });
  const proof = {
    result: {
      asOf: result.asOf,
      record: result.record,
      accepted: result.accepted,
      children: result.children,
      planReadback: result.planReadback,
      nativeInput: result.nativeInput,
    },
    operatorArgv,
    dayReport,
    universeProof,
    beforeReadiness,
    afterReadiness,
    bookReadback,
    positionReadback,
    priceCalls,
    operatorSourceSha256: sha(
      await fsp.readFile(path.join(repo, "scripts/operator/lcx-finance-daily-cycle.ts")),
    ),
    boundary:
      "complete original day/universe/readiness/bars/position owners with local raw HTTP responses. Inherited scheduler child IO and earlier research model are scripted; this is not full research CLI preflight input consumption. operator.modelCalls=0 covers the day operator only, not upstream research. Readiness diagnostics are not trading qualification. Preview is not broker confirmation, strategy performance, model/source semantic quality, execution safety acceptance or natural runtime.",
  };
  await fsp.writeFile(
    path.join(params.directory, "captured-operator-consumption.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  return { ...proof, nativeScheduler: result };
}
