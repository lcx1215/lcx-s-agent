import { type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFinanceDailyCycleOperator } from "../scripts/operator/lcx-finance-daily-cycle.js";
import { financeEtClock } from "../src/agents/finance-cycle-schedule.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "../src/agents/finance-execution-adapter.js";
import {
  buildFinanceNightReviewEvidence,
  writeFinanceNightReviewEvidence,
} from "../src/agents/finance-night-review-context.js";
import { FINANCE_RESEARCH_PORTFOLIO_PLAN_FILENAME } from "../src/agents/finance-portfolio-composition.js";
import {
  appendFinanceExecutionReceipt,
  closeFinancePositionLedger,
} from "../src/agents/finance-position-ledger.js";
import { financeResearchPortfolioAbstentionSchema } from "../src/agents/finance-research-portfolio-plan.js";
import { FINANCE_SCHEDULER_LOCK } from "../src/agents/finance-scheduler-lock.js";
import { runFinanceCycleProcess } from "../src/agents/finance-scheduler-process.js";
import {
  readFinanceSchedulerState,
  writeFinanceSchedulerState,
} from "../src/agents/finance-scheduler-state.js";
import {
  FINANCE_DAILY_CYCLE_RUNS_FILENAME,
  FINANCE_RESEARCH_SAMPLES_FILENAME,
  financeResearchSamplesPath,
} from "../src/agents/finance-state-dir.js";

const transport = vi.hoisted(() => ({
  run: undefined as ((argv: string[], child: ChildProcess) => Promise<void>) | undefined,
  children: [] as ChildProcess[],
  forbiddenCalls: 0,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_command: string, argv: string[]) => {
      if (!transport.run) {
        throw new Error("no private child transport");
      }
      const child = new actual.ChildProcess();
      Object.defineProperties(child, {
        pid: { value: 2_000_000_000 },
        stdout: { value: new PassThrough() },
        stderr: { value: new PassThrough() },
      });
      transport.children.push(child);
      queueMicrotask(() => {
        const run = transport.run;
        if (!run) {
          throw new Error("private transport removed before child started");
        }
        void run(argv, child).catch((error: unknown) => {
          child.emit("error", error);
          child.emit("close", null, null);
        });
      });
      return child;
    },
  };
});
vi.mock("../src/process/kill-tree.js", () => ({
  killProcessTree: () => {
    const child = transport.children.at(-1);
    queueMicrotask(() => child?.emit("close", null, "SIGTERM"));
  },
}));
vi.mock("../src/config/config.js", () => ({
  loadConfig: () => {
    transport.forbiddenCalls++;
    throw new Error("private probe cannot load live config");
  },
}));

const repo = path.resolve(import.meta.dirname, "..");
const asOf = "2026-02-01T23:00:00.000Z";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type Fault =
  | "missing"
  | "unreadable"
  | "invalid_json"
  | "other_failure"
  | "timeout"
  | "cancelled"
  | "body_missing"
  | "cross_directory"
  | "cross_asof"
  | "positive_filed"
  | "source_kind"
  | "additional_issue";
type Trace = {
  argv: string[];
  payload: Record<string, unknown>;
  controllerEvidence?: unknown;
  controllerEvidenceSha256?: string;
};
let directory: string;
beforeEach(async () => {
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), "lcx-night-independent-"));
  transport.children = [];
  transport.forbiddenCalls = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(asOf));
  vi.stubGlobal("fetch", () => {
    transport.forbiddenCalls++;
    throw new Error("private probe cannot use external HTTP");
  });
});
afterEach(async () => {
  transport.run = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  closeFinancePositionLedger(directory);
  await fsp.rm(directory, { recursive: true, force: true });
});

async function probe(
  fault: Fault,
  sourcePath = path.join(repo, "scripts/operator/lcx-finance-scheduler.ts"),
) {
  const source = await fsp.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "fire",
    "cycleOutputSucceeded",
    "parseNightSettlement",
    "runNightResearchReview",
    "runScheduledCycleProcess",
    "financeResearchProcessEnv",
    "writeSchedulerProgress",
    "inspectFinanceResearchReceiptPersistence",
    "describeFinanceCycleExecution",
    "SchedulerProgressBeforeDispatchError",
  ]);
  if (source.includes("function unavailableNightSampleSettlement(")) {
    names.add("unavailableNightSampleSettlement");
  }
  const declarations = ast.statements
    .filter(
      (node) =>
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name &&
        names.has(node.name.text),
    )
    .map((node) => node.getText(ast).replace(/^export\s+/u, ""));
  expect(declarations).toHaveLength(names.size);
  const calls: Trace[] = [];
  let lateChildWrites = 0;
  const observedEvidence: unknown[] = [];
  const blockedOwner = vi.fn(() => {
    throw new Error("unrelated owner must remain blocked");
  });
  const independentUniverseRefresh = vi.fn(async () => ({
    status: "unavailable",
    reason: "private_fixture_no_universe_evidence",
  }));
  const filename = financeResearchSamplesPath(directory);
  // Original ledger writer records synthetic private inventory. A crypto symbol is
  // outside the equity EOD refresh's scope; no source adapter/provider is needed.
  await appendFinanceExecutionReceipt(directory, {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: "private-crypto-fill",
    intentId: "private-crypto-intent",
    runAuthorizationId: "private-offline-paper",
    adapterId: "private-offline-transport",
    adapterKind: "paper",
    venue: "paper",
    instrument: "BTC/USD",
    side: "buy",
    orderType: "market",
    quantity: 1,
    referencePrice: 100,
    referencePriceAt: "2026-02-01T22:00:00.000Z",
    notional: 100,
    fill: {
      filledQuantity: 1,
      fillPrice: 100,
      filledAt: "2026-02-01T22:00:00.000Z",
      venueRef: "private-fixture-no-venue-action",
    },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: "2026-02-01T22:00:00.000Z",
  });
  if (fault === "unreadable") {
    await fsp.mkdir(filename);
  }
  if (fault === "invalid_json") {
    await fsp.writeFile(filename, "{not json}\n");
  }
  await fsp.mkdir(path.join(directory, FINANCE_SCHEDULER_LOCK));
  transport.run = async (argv, child) => {
    const index = argv.indexOf("--controller-evidence");
    if (index >= 0) {
      const bytes = await fsp.readFile(argv[index + 1]);
      const payload = {
        status: "needs_review",
        gaps: ["private transport does not run research models"],
      };
      calls.push({
        argv,
        payload,
        controllerEvidence: JSON.parse(bytes.toString()),
        controllerEvidenceSha256: sha(bytes),
      });
      child.stdout!.emit("data", JSON.stringify(payload));
      child.emit("close", 0, null);
      return;
    }
    const payload = await runFinanceDailyCycleOperator([
      "--json",
      "--dir",
      directory,
      "--mode",
      "night",
      "--as-of",
      asOf,
    ]);
    expect(payload.failureKind).toBe("night_sample_source_gate");
    const mutated = structuredClone(payload);
    if (fault === "other_failure") {
      mutated.failureKind = "execution_readiness_gate";
    }
    if (fault === "cross_directory") {
      mutated.directory = path.join(directory, "other-book");
    }
    if (fault === "cross_asof") {
      mutated.asOf = "2026-02-02T23:00:00.000Z";
    }
    if (fault === "positive_filed") {
      mutated.scoredFiled = { appended: 1, skipped: 0 };
    }
    if (fault === "source_kind") {
      mutated.sampleSource = { path: filename, status: "unknown" };
    }
    if (fault === "additional_issue") {
      mutated.issues = ["night_sample_source_missing", "account_reconciliation_failed"];
    }
    calls.push({ argv, payload: mutated });
    if (fault === "timeout") {
      return;
    }
    if (fault === "cancelled") {
      context.signalController.abort();
      setTimeout(() => {
        lateChildWrites++;
        child.stdout!.emit("data", JSON.stringify(mutated));
        child.emit("close", 0, null);
      }, 2);
      return;
    }
    child.stdout!.emit("data", fault === "body_missing" ? "" : JSON.stringify(mutated));
    child.emit("close", 2, null);
  };
  const context = {
    root: { directory, source: "explicit" },
    options: {
      command: "once",
      timeoutMs: fault === "timeout" ? 5 : 2_000,
      extraArgs: [],
      researchPlan: {
        contextPath: path.join(directory, "unused-day-context.json"),
        ask: "Review original portfolio risk and news; no execution authority",
      },
    },
    signalController: new AbortController(),
    get signal() {
      return this.signalController.signal;
    },
  };
  const sandbox = vm.createContext({
    fs,
    path,
    randomUUID,
    Date,
    process: {
      pid: process.pid,
      env: { OPENCLAW_WORKSPACE_DIR: path.join(directory, "workspace") },
      stdout: { write: () => true },
      stderr: { write: () => true },
    },
    REPO_ROOT: repo,
    CYCLE_SCRIPT: path.join(repo, "scripts/operator/lcx-finance-daily-cycle.ts"),
    RESEARCH_SCRIPT: path.join(repo, "scripts/operator/lcx-finance-research-run.ts"),
    RUNS_LOG: FINANCE_DAILY_CYCLE_RUNS_FILENAME,
    FINANCE_SCHEDULER_LOCK,
    FINANCE_RESEARCH_PORTFOLIO_PLAN_FILENAME,
    FINANCE_RESEARCH_SAMPLES_FILENAME,
    readFinanceSchedulerState,
    writeFinanceSchedulerState,
    financeEtClock,
    financeResearchPortfolioAbstentionSchema,
    runFinanceCycleProcess: (input: Parameters<typeof runFinanceCycleProcess>[0]) =>
      runFinanceCycleProcess({ ...input, killGraceMs: 0 }),
    buildFinanceNightReviewEvidence: async (
      input: Parameters<typeof buildFinanceNightReviewEvidence>[0],
    ) => {
      const output = await buildFinanceNightReviewEvidence(input);
      observedEvidence.push({ input: structuredClone(input), output: structuredClone(output) });
      return output;
    },
    writeFinanceNightReviewEvidence,
    captureFinanceIntradayCloseBars: blockedOwner,
    refreshFinanceUniverseSelection: independentUniverseRefresh,
    runNightTuning: blockedOwner,
  });
  const code = ts.transpileModule(`${declarations.join("\n")}\nglobalThis.nativeFire=fire;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new vm.Script(code, { filename: sourcePath }).runInContext(sandbox);
  const fire = sandbox.nativeFire as (input: typeof context, mode: "night") => Promise<boolean>;
  expect(await fire(context, "night")).toBe(false);
  expect(blockedOwner).not.toHaveBeenCalled();
  expect(transport.forbiddenCalls).toBe(0);
  const state = readFinanceSchedulerState(directory);
  expect(state.lastStatus.night).toBe(
    fault === "timeout" ? "timed_out" : fault === "cancelled" ? "cancelled" : "failed",
  );
  expect(state.lastSucceeded.night).toBeUndefined();
  const proof = {
    fault,
    sourcePath,
    sourceSha256: sha(source),
    calls,
    observedEvidence,
    terminal: state.lastRun,
    forbiddenCalls: transport.forbiddenCalls,
    lateChildWrites,
    boundary:
      "original private night operator, exact original scheduler declarations and original evidence builder/writer; subprocess IO only, no models or semantic adoption",
  };
  const proofDir = process.env.LCX_NIGHT_REVIEW_PROOF_DIR;
  if (proofDir) {
    await fsp.mkdir(proofDir, { recursive: true });
    await fsp.writeFile(
      path.join(proofDir, `${path.basename(sourcePath)}-${fault}.json`),
      JSON.stringify(proof, null, 2) + "\n",
    );
  }
  return proof;
}

describe("original independent night review under a failed forecast source", () => {
  it.skipIf(!process.env.LCX_NIGHT_REVIEW_BEFORE_SOURCE)(
    "freezes the original missing-source suppression before repair",
    async () => {
      const proof = await probe("missing", process.env.LCX_NIGHT_REVIEW_BEFORE_SOURCE);
      expect(proof.calls).toHaveLength(1);
      expect(proof.observedEvidence).toEqual([]);
      expect(proof.terminal?.nightReview).toBeUndefined();
    },
  );
  it.each(["missing", "unreadable", "invalid_json"] as const)(
    "dispatches real original evidence for %s, keeping night failed",
    async (fault) => {
      const proof = await probe(fault);
      expect(proof.calls).toHaveLength(2);
      expect(proof.observedEvidence).toHaveLength(1);
      const review = proof.calls[1];
      expect(review.argv).toContain("--controller-research-scope");
      expect(review.argv).toContain("research_only");
      expect(review.controllerEvidence).toEqual(
        (proof.observedEvidence[0] as { output: unknown }).output,
      );
      expect(JSON.stringify(review.controllerEvidence)).toContain(`night_sample_source_${fault}`);
      expect(proof.terminal?.nightReview).toMatchObject({ ok: false, receiptPersisted: false });
      expect(proof.terminal?.tuningLifecycle).toBeUndefined();
      expect(proof.terminal?.intradayCloseCapture).toBeUndefined();
      expect(proof.terminal?.universeSelection).toMatchObject({
        status: "unavailable",
        reason: "private_fixture_no_universe_evidence",
      });
    },
  );
  it.each([
    "other_failure",
    "timeout",
    "cancelled",
    "body_missing",
    "cross_directory",
    "cross_asof",
    "positive_filed",
    "source_kind",
    "additional_issue",
  ] as const)("does not release independent review for %s", async (fault) => {
    const proof = await probe(fault);
    expect(proof.calls).toHaveLength(1);
    expect(proof.observedEvidence).toEqual([]);
    expect(proof.terminal?.nightReview).toBeUndefined();
    if (fault === "cancelled") {
      expect(proof.lateChildWrites).toBe(1);
      expect(proof.terminal?.status).toBe("cancelled");
    }
  });
});
