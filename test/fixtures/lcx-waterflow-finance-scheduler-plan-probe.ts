import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { runFinanceDailyCycleOperator } from "../../scripts/operator/lcx-finance-daily-cycle.js";
import { readControllerResearchInput } from "../../scripts/operator/lcx-finance-research-run.js";
import { caseflowFingerprint } from "../../src/agents/finance-caseflow.js";
import {
  financeEtClock,
  FINANCE_TRADING_WEEKDAYS,
} from "../../src/agents/finance-cycle-schedule.js";
import {
  buildFinanceBrokerAccountResearchEvidence,
  writeFinanceNightReviewEvidence,
} from "../../src/agents/finance-night-review-context.js";
import { latestFinanceDirectionalCalibrationPromotion } from "../../src/agents/finance-paper-promotion.js";
import { FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON } from "../../src/agents/finance-paper-promotion.js";
import {
  financePortfolioPlanSchema,
  FINANCE_RESEARCH_PORTFOLIO_PLAN_FILENAME,
} from "../../src/agents/finance-portfolio-composition.js";
import { buildFinanceHistoricalResearchFeedback } from "../../src/agents/finance-research-evidence.js";
import {
  financeResearchPortfolioAbstentionSchema,
  financeResearchPortfolioContextSchema,
  financeScheduledResearchHandoffSchema,
  financeResearchControllerHandoffSchema,
} from "../../src/agents/finance-research-portfolio-plan.js";
import { readFinanceSchedulerDatabaseRuns } from "../../src/agents/finance-scheduler-ledger.js";
import { FINANCE_SCHEDULER_LOCK } from "../../src/agents/finance-scheduler-lock.js";
import type { FinanceCycleProcessResult } from "../../src/agents/finance-scheduler-process.js";
import {
  FINANCE_SCHEDULER_TICK_MS,
  normalizeFinanceSchedulerIntradayLastTick,
  readFinanceSchedulerPolicyAuthorization,
  readFinanceSchedulerState,
  writeFinanceSchedulerState,
} from "../../src/agents/finance-scheduler-state.js";
import {
  FINANCE_DAILY_CYCLE_RUNS_FILENAME,
  FINANCE_RESEARCH_SAMPLES_FILENAME,
  financeResearchScoredPath,
  financeTuningProposalsPath,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import {
  runFinanceTuningLifecycle,
  readFinanceTuningProposals,
  type FinanceTuningLifecycleResult,
} from "../../src/agents/finance-tuning-lifecycle.js";
import {
  proposeTuning,
  TUNING_PROPOSAL_SCHEMA_VERSION,
} from "../../src/agents/finance-tuning-proposal.js";
import { FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME } from "../../src/agents/finance-universe-selection.js";
import { createFinanceTuningProposalTool } from "../../src/agents/tools/finance-tuning-proposal-tool.js";
import {
  probeOriginalFinanceModuleMain,
  type prepareOriginalFinanceModuleMain,
} from "./lcx-waterflow-finance-module-main-probe.js";

const repo = path.resolve(import.meta.dirname, "../..");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type NativeProducer = Awaited<ReturnType<typeof probeOriginalFinanceModuleMain>>;
export type FinanceSchedulerPlanFault =
  | "as_of_conflict"
  | "gate_conflict"
  | "missing_gate"
  | "path_conflict"
  | "missing_pin"
  | "foreign_scope"
  | "research_timeout"
  | "research_cancel";
export type FinanceSchedulerDayChildConsumer = (input: {
  argv: readonly string[];
  directory: string;
  signal: AbortSignal;
  planPath: string;
  nativeProducer: NativeProducer;
}) => Promise<FinanceCycleProcessResult>;
type CompactSummary = {
  status: string;
  plan?: { asOf: string };
  portfolioPlanWritten?: string;
  portfolioPlanWrite?: {
    path: string;
    sha256: string;
    asOf: string;
    accountId: string;
    venue: "paper" | "alpaca";
  };
  gates: readonly { id: string; passed: boolean }[];
};
type NativeOwners = {
  fire: (context: unknown, mode: "day") => Promise<boolean>;
  writeVerifiedPortfolioPlan: (
    filename: string,
    plan: unknown,
  ) => Promise<NonNullable<CompactSummary["portfolioPlanWrite"]>>;
  compactFinanceResearchSummary: (receipt: unknown) => CompactSummary;
};
class PrivatePipe extends EventEmitter {
  setEncoding() {
    return this;
  }
}

/** Original fire/night branch; only spawned-child transport and directional-price IO are local. */
export async function probeOriginalFinanceNightScheduler(params: {
  directory: string;
  sampleSource: "available" | "missing" | "invalid_json" | "empty" | "existing";
  workspace?: string;
  book?: string;
  asOf?: string;
}) {
  const workspace = params.workspace ?? path.join(params.directory, "workspace");
  const directory = params.book ?? path.join(workspace, "state", "finance");
  const asOf = params.asOf ?? "2026-02-02T23:00:00.000Z";
  await fsp.mkdir(path.join(directory, FINANCE_SCHEDULER_LOCK), { recursive: true });
  const samplePath = path.join(directory, FINANCE_RESEARCH_SAMPLES_FILENAME);
  const samples = Array.from({ length: 5 }, (_, index) => ({
    asOf: `2026-01-0${index + 1}T14:00:00.000Z`,
    instrument: "SPY",
    direction: "buy",
    conviction: 0.7,
    lastPrice: 100,
    horizonDays: 27,
  }));
  if (params.sampleSource !== "missing" && params.sampleSource !== "existing") {
    await fsp.writeFile(
      samplePath,
      params.sampleSource === "invalid_json"
        ? "{invalid source}\n"
        : params.sampleSource === "empty"
          ? "\n"
          : samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
  }
  const sourceBytes = fs.existsSync(samplePath) ? fs.readFileSync(samplePath) : undefined;
  const children: {
    argv: string[];
    kind: "night" | "universe";
    stdout: string;
    stderr: string;
    exitCode: number;
  }[] = [];
  const sourceReads: { path: string; sha256: string; text: string }[] = [];
  const tuningCalls: {
    input: Parameters<typeof runFinanceTuningLifecycle>[0];
    result: FinanceTuningLifecycleResult;
  }[] = [];
  let scoredSourceSnapshot:
    | { path: string; sha256: string; bytes: number; base64: string }
    | undefined;
  const logs = { stdout: "", stderr: "" };
  let actualNightOutput: Record<string, unknown> | undefined;
  const cycleScript = path.join(repo, "scripts/operator/lcx-finance-daily-cycle.ts");
  const universeScript = path.join(repo, "scripts/operator/lcx-finance-universe-select.ts");
  const spawn = (_executable: string, argv: string[]) => {
    const child = new PrivateChild();
    queueMicrotask(() => {
      void (async () => {
        let stdout = "";
        let stderr = "";
        let exitCode = 2;
        const kind = argv.includes(cycleScript) ? "night" : "universe";
        try {
          if (kind === "night") {
            actualNightOutput = await runFinanceDailyCycleOperator(
              argv.slice(argv.indexOf(cycleScript) + 1),
            );
            const scoredFiled = actualNightOutput.scoredFiled as { path?: string } | undefined;
            if (scoredFiled?.path && fs.existsSync(scoredFiled.path)) {
              const bytes = fs.readFileSync(scoredFiled.path);
              scoredSourceSnapshot = {
                path: scoredFiled.path,
                sha256: sha(bytes),
                bytes: bytes.length,
                base64: bytes.toString("base64"),
              };
            }
            stdout = JSON.stringify(actualNightOutput) + "\n";
            exitCode = actualNightOutput.ok === true ? 0 : 2;
          } else {
            if (!argv.includes(universeScript)) {
              throw new Error("unexpected child dispatch");
            }
            stderr = "private universe transport unavailable; original selector not executed";
          }
        } catch (error) {
          stderr = String(error);
        }
        children.push({ argv: [...argv], kind, stdout, stderr, exitCode });
        child.stdout.emit("data", stdout);
        child.stderr.emit("data", stderr);
        child.emit("close", exitCode, null);
      })();
    });
    return child;
  };
  const scheduler = selectOriginal(path.join(repo, "scripts/operator/lcx-finance-scheduler.ts"), [
    "fire",
    "runScheduledCycleProcess",
    "writeSchedulerProgress",
    "SchedulerProgressBeforeDispatchError",
    "cycleOutputSucceeded",
    "describeFinanceCycleExecution",
    "parseNightSettlement",
    "unavailableNightSampleSettlement",
    "runNightTuning",
    "captureFinanceIntradayCloseBars",
    "refreshFinanceUniverseSelection",
    "preserveUniverseSnapshot",
    "replaceIntradaySystemUniverse",
  ]);
  const processOwner = selectOriginal(path.join(repo, "src/agents/finance-scheduler-process.ts"), [
    "runFinanceCycleProcess",
  ]);
  const lifecycle = selectOriginal(path.join(repo, "src/agents/finance-tuning-lifecycle.ts"), [
    "isCalibrationScore",
    "readFinanceScoredFloorSamples",
    "readFinanceScoredFloorSamplesWithSource",
    "readFinanceTuningProposals",
    "runFinanceTuningLifecycle",
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
    createHash,
    fs,
    path,
    Buffer,
    Date: ScopedDate,
    randomUUID,
    spawn,
    process: {
      pid: process.pid,
      execPath: process.execPath,
      platform: process.platform,
      env: {},
      stdout: {
        write: (value: string) => {
          logs.stdout += value;
        },
      },
      stderr: {
        write: (value: string) => {
          logs.stderr += value;
        },
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    killProcessTree: () => {
      throw new Error("unexpected private child deadline");
    },
    readFileSync: (filename: string, encoding?: BufferEncoding) => {
      const bytes = fs.readFileSync(filename);
      const text = bytes.toString(encoding ?? "utf8");
      sourceReads.push({ path: filename, sha256: sha(bytes), text });
      return encoding ? text : bytes;
    },
    existsSync: fs.existsSync,
    appendFileSync: fs.appendFileSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
    runFinanceTuningLifecycle: (input: Parameters<typeof runFinanceTuningLifecycle>[0]) => {
      const result = runFinanceTuningLifecycle(input);
      tuningCalls.push({ input: structuredClone(input), result });
      return result;
    },
    latestFinanceDirectionalCalibrationPromotion,
    proposeTuning,
    TUNING_PROPOSAL_SCHEMA_VERSION,
    FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON,
    financeResearchScoredPath,
    financeTuningProposalsPath,
    REPO_ROOT: repo,
    CYCLE_SCRIPT: cycleScript,
    UNIVERSE_SELECTION_SCRIPT: universeScript,
    RUNS_LOG: FINANCE_DAILY_CYCLE_RUNS_FILENAME,
    UNIVERSE_SELECTION_RUNS_LOG: "finance-universe-selection-runs.jsonl",
    FINANCE_RESEARCH_SAMPLES_FILENAME,
    FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME,
    FINANCE_SCHEDULER_LOCK,
    FINANCE_RESEARCH_PORTFOLIO_PLAN_FILENAME,
    OUTPUT_LIMIT: 1024 * 1024,
    FINANCE_SCHEDULER_TICK_MS,
    financeEtClock,
    readFinanceSchedulerState,
    writeFinanceSchedulerState,
    readFinanceSchedulerPolicyAuthorization,
    normalizeFinanceSchedulerIntradayLastTick,
  });
  const code = ts.transpileModule(
    `${scheduler.text}\n${processOwner.text}\n${params.book ? "" : lifecycle.text}\nglobalThis.nativeOwners={fire};`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  new vm.Script(code, { filename: "original-finance-night-scheduler-seam" }).runInContext(context);
  const accepted = await (
    context.nativeOwners as { fire: (input: unknown, mode: "night") => Promise<boolean> }
  ).fire(
    {
      root: resolveFinanceStateDir({ directory }),
      options: {
        command: "once",
        timeoutMs: 10_000,
        extraArgs: ["--as-of", asOf, "--venue", "paper"],
      },
      signal: new AbortController().signal,
    },
    "night",
  );
  const runLogPath = path.join(directory, FINANCE_DAILY_CYCLE_RUNS_FILENAME);
  const runLogBytes = fs.readFileSync(runLogPath);
  const record = JSON.parse(runLogBytes.toString("utf8").trim().split("\n").at(-1)!) as {
    runId: string;
    firedAt: string;
    ok: boolean;
    status: string;
    tuningLifecycle?: { ok: boolean; status: string; result: FinanceTuningLifecycleResult | null };
    universeSelection?: { status: string; error?: string };
    intradayCloseCapture?: { status: string; reason?: string };
    nightReview?: unknown;
  };
  const proposalToolReadback = await createFinanceTuningProposalTool().execute(
    "private-night-proposal-read",
    { action: "list", workspaceDir: workspace },
  );
  const proposalReadback = params.book ? readFinanceTuningProposals(directory) : undefined;
  const proof = {
    accepted,
    workspace,
    directory,
    asOf,
    samplePath,
    sampleSourceSha256: sourceBytes ? sha(sourceBytes) : null,
    sampleSourceText: sourceBytes?.toString("utf8") ?? null,
    children,
    actualNightOutput,
    record,
    sourceReads,
    tuningCalls,
    scoredSourceSnapshot,
    proposalToolReadback,
    proposalToolDirectory: path.join(workspace, "state", "finance"),
    proposalReadback,
    logs,
    runLog: { path: runLogPath, sha256: sha(runLogBytes) },
    sourceSha256: {
      scheduler: scheduler.sourceSha256,
      processOwner: processOwner.sourceSha256,
      lifecycle: lifecycle.sourceSha256,
      operator: sha(fs.readFileSync(cycleScript)),
      proposalTool: sha(
        fs.readFileSync(path.join(repo, "src/agents/tools/finance-tuning-proposal-tool.ts")),
      ),
    },
    boundary:
      "actual_original_fire_night_operator_tuning_and_tool_readback_private_child_io_directional_price_substitute",
    limits: [
      "universe child transport failed; original selector not executed",
      "intraday original not_configured skip",
      "researchPlan absent; no model research",
      "directional sample fixture has no financial account binding",
      "no day-to-directional-sample caller proved",
      "no net-trade promotion; whole finance not accepted",
    ],
  };
  await fsp.writeFile(
    path.join(params.directory, "native-night-scheduler.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  return proof;
}
class PrivateChild extends EventEmitter {
  pid = 60_000_001;
  stdout = new PrivatePipe();
  stderr = new PrivatePipe();
}
type ChildCapture = {
  argv: string[];
  cwd: string;
  kind: "research" | "day";
  stdout: string;
  stderr: string;
  closeCode?: number;
  signalAborted: boolean;
};

function selectOriginal(sourcePath: string, names: readonly string[]) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(
    (node) =>
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      names.includes(node.name.text),
  );
  if (declarations.length !== names.length) {
    throw new Error(`original owner declarations missing: ${sourcePath}`);
  }
  return {
    text: declarations.map((node) => node.getText(ast).replace(/^export\s+/u, "")).join("\n"),
    sourceSha256: sha(source),
  };
}

/** Actual day-only original owner functions; original child deadlines use a local EventEmitter transport. */
export async function probeOriginalFinanceSchedulerPlan(params: {
  directory: string;
  fault?: FinanceSchedulerPlanFault;
  allocation?: number;
  dailyExecutableRule?: boolean;
  dayChildConsumer?: FinanceSchedulerDayChildConsumer;
  researchPreparation?: Awaited<ReturnType<typeof prepareOriginalFinanceModuleMain>>;
  researchChildConsumer?: (input: { argv: readonly string[]; directory: string }) => Promise<{
    nativeProducer: NativeProducer;
    summary: CompactSummary;
    exitCode?: number;
    stderr?: string;
  }>;
}) {
  let nativeProducer = params.researchPreparation
    ? undefined
    : await probeOriginalFinanceModuleMain({
        directory: path.join(params.directory, "native-producer"),
        allocation: params.allocation,
        dailyExecutableRule: params.dailyExecutableRule,
      });
  if (
    !params.researchPreparation &&
    (!nativeProducer?.receipt?.portfolioPlan || nativeProducer.receipt.status !== "candidate")
  ) {
    const receipt = nativeProducer?.receipt;
    throw new Error(
      "native producer did not make an accepted research plan; do not fabricate one:" +
        JSON.stringify({
          status: receipt?.status,
          gates: receipt?.gates,
          missingEvidence: receipt?.missingEvidence.slice(0, 20),
          checkpoint: nativeProducer?.checkpoint
            ? {
                status: nativeProducer.checkpoint.status,
                reason: nativeProducer.checkpoint.reason,
                runId: nativeProducer.checkpoint.runId,
              }
            : undefined,
          sourceJobs: receipt?.batch?.jobs.map((job) => ({
            targetId: job.targetId,
            status: job.status,
            missingEvidence: job.missingEvidence,
            conflicts: job.conflicts,
            sourceAttempts: job.receipt?.sourceAttempts.map((attempt) => ({
              adapterId: attempt.adapterId,
              status: attempt.status,
              error: attempt.error,
              latencyMs: attempt.latencyMs,
              apiCalls: attempt.apiCalls?.map(({ status, timeoutMs, transportError }) => ({
                status,
                timeoutMs,
                transportError,
              })),
            })),
          })),
          committee: {
            coverage: receipt?.committee?.coverage,
            status: receipt?.committee?.model.status,
            roles: receipt?.committee?.model.roleStatuses.map(({ taskId, status, error }) => ({
              taskId,
              status,
              error,
            })),
          },
          modelCheckpoint: receipt?.modelCheckpoint,
          moduleNodes: receipt?.moduleExecution?.nodes.map((node) => ({
            moduleId: node.moduleId,
            status: node.status,
            missingEvidence: node.missingEvidence,
          })),
          quality: {
            status: receipt?.quality?.status,
            verification: receipt?.quality?.verification,
            quality: receipt?.quality?.quality,
          },
        }).slice(0, 8_000),
    );
  }
  const directory = params.researchPreparation?.book ?? nativeProducer!.book;
  const asOf = params.researchPreparation?.asOf ?? nativeProducer!.receipt!.plan.asOf;
  const frozenContext = financeResearchPortfolioContextSchema.parse(
    params.researchPreparation?.input.portfolioContext ??
      nativeProducer!.executeInput!.portfolioContext,
  );
  const contextPath = path.join(directory, "private-controller-context.json");
  fs.writeFileSync(contextPath, JSON.stringify(frozenContext) + "\n", { mode: 0o600 });
  fs.mkdirSync(path.join(directory, FINANCE_SCHEDULER_LOCK), { recursive: true });
  const controller = new AbortController();
  const children: ChildCapture[] = [];
  const logs: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  const kills: { pid: number; graceMs: number }[] = [];
  let originalSummary: CompactSummary | undefined;
  let deliveredSummary: CompactSummary | undefined;
  let originalSummaryBytes: string | undefined;
  let researchExitCode = 0;
  let researchStderr = "";
  let frozenContextReadback: unknown;
  let controllerEvidenceReadback: unknown;
  let dayResult: FinanceCycleProcessResult | undefined;
  let child: PrivateChild | undefined;
  let lateSummaryBytes: string | undefined;
  let owners: NativeOwners;
  const captureOutput = (
    target: PrivateChild,
    capture: ChildCapture,
    stdout: string,
    stderr: string,
    code: number,
  ) => {
    capture.stdout += stdout;
    capture.stderr += stderr;
    capture.closeCode = code;
    capture.signalAborted = controller.signal.aborted;
    if (stdout) {
      target.stdout.emit("data", stdout);
    }
    if (stderr) {
      target.stderr.emit("data", stderr);
    }
    target.emit("close", code, null);
  };
  const argvValue = (argv: readonly string[], flag: string) => {
    const value = argv[argv.indexOf(flag) + 1];
    if (!argv.includes(flag) || !value) {
      throw new Error(`original child flag missing: ${flag}`);
    }
    return value;
  };
  const spawn = (_command: string, argv: string[], options: { cwd: string }) => {
    const current = new PrivateChild();
    child = current;
    const research = argv.includes("--portfolio-plan-out");
    const capture: ChildCapture = {
      argv: [...argv],
      cwd: options.cwd,
      kind: research ? "research" : "day",
      stdout: "",
      stderr: "",
      signalAborted: false,
    };
    children.push(capture);
    queueMicrotask(async () => {
      try {
        if (research) {
          if (
            argvValue(argv, "--as-of") !== asOf ||
            argvValue(argv, "--finance-state-dir") !== directory
          ) {
            throw new Error("original research invocation lost the native run scope");
          }
          frozenContextReadback = JSON.parse(
            fs.readFileSync(argvValue(argv, "--portfolio-context"), "utf8"),
          );
          controllerEvidenceReadback = JSON.parse(
            fs.readFileSync(argvValue(argv, "--controller-evidence"), "utf8"),
          );
          if (JSON.stringify(frozenContextReadback) !== JSON.stringify(frozenContext)) {
            throw new Error("original preflight changed the native account context");
          }
          if (params.researchChildConsumer) {
            const produced = await params.researchChildConsumer({ argv, directory });
            nativeProducer = produced.nativeProducer;
            originalSummary = produced.summary;
            researchExitCode = produced.exitCode ?? 0;
            researchStderr = produced.stderr ?? "";
          } else {
            const written = await owners.writeVerifiedPortfolioPlan(
              argvValue(argv, "--portfolio-plan-out"),
              nativeProducer!.receipt!.portfolioPlan,
            );
            originalSummary = owners.compactFinanceResearchSummary({
              ...nativeProducer!.receipt,
              ...(await readControllerResearchInput(
                {
                  controllerEvidencePath: argvValue(argv, "--controller-evidence"),
                  portfolioContextPath: argvValue(argv, "--portfolio-context"),
                  controllerHandoffPath: argvValue(argv, "--controller-handoff"),
                  controllerHandoffSha256: argvValue(argv, "--controller-handoff-sha256"),
                },
                asOf,
              )),
              portfolioPlanWritten: written.path,
              portfolioPlanWrite: written,
            });
          }
          originalSummaryBytes = JSON.stringify(originalSummary) + "\n";
          deliveredSummary = structuredClone(originalSummary);
          if (params.fault === "as_of_conflict") {
            deliveredSummary.plan!.asOf = new Date(Date.parse(asOf) - 1).toISOString();
          }
          if (params.fault === "gate_conflict") {
            deliveredSummary.gates.find((gate) => gate.id === "quality")!.passed = false;
          }
          if (params.fault === "missing_gate") {
            deliveredSummary.gates = deliveredSummary.gates.filter(
              (gate) => gate.id !== "module_execution",
            );
          }
          if (params.fault === "missing_pin") {
            delete deliveredSummary.portfolioPlanWrite;
          }
          if (params.fault === "foreign_scope") {
            deliveredSummary.portfolioPlanWrite!.accountId = "different-account";
          }
          if (params.fault === "path_conflict") {
            deliveredSummary.portfolioPlanWritten = path.join(directory, "different-plan.json");
          }
          if (params.fault === "research_timeout") {
            lateSummaryBytes = originalSummaryBytes;
            return;
          }
          if (params.fault === "research_cancel") {
            lateSummaryBytes = originalSummaryBytes;
            controller.abort(new Error("private cancellation"));
            return;
          }
          captureOutput(
            current,
            capture,
            JSON.stringify(deliveredSummary) + "\n",
            researchStderr,
            researchExitCode,
          );
          return;
        }
        const planPath = argvValue(argv, "--portfolio-plan");
        dayResult = params.dayChildConsumer
          ? await params.dayChildConsumer({
              argv,
              directory,
              signal: controller.signal,
              planPath,
              nativeProducer: nativeProducer!,
            })
          : {
              ok: false,
              status: "failed",
              exitCode: 2,
              signal: null,
              stdout: "",
              stderr: "day consumer deliberately not run in scheduler-only sample",
              outputTruncated: false,
            };
        captureOutput(
          current,
          capture,
          dayResult.stdout,
          dayResult.stderr,
          dayResult.exitCode ?? 2,
        );
      } catch (error) {
        captureOutput(current, capture, "", String(error), 2);
      }
    });
    return current;
  };
  const scheduler = selectOriginal(path.join(repo, "scripts/operator/lcx-finance-scheduler.ts"), [
    "fire",
    "runDayResearchPreflight",
    "runScheduledCycleProcess",
    "writeSchedulerProgress",
    "failedDayResearchPreflight",
    "SchedulerProgressBeforeDispatchError",
    "financeResearchPreflightRetryDue",
    "financeResearchProcessEnv",
    "readFinanceScheduledResearchFeedback",
    "inspectFinanceResearchControllerHandoff",
    "inspectFinanceResearchReceiptPersistence",
    "isObjectRecord",
    "cycleOutputSucceeded",
    "describeFinanceCycleExecution",
  ]);
  const processOwner = selectOriginal(path.join(repo, "src/agents/finance-scheduler-process.ts"), [
    "runFinanceCycleProcess",
  ]);
  const writer = selectOriginal(path.join(repo, "scripts/operator/lcx-finance-research-run.ts"), [
    "writePrivateReceipt",
    "writeVerifiedPortfolioPlan",
    "compactFinanceResearchSummary",
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
    fs,
    path,
    Buffer,
    URL,
    randomUUID,
    createHash,
    Date: ScopedDate,
    process: {
      pid: process.pid,
      execPath: process.execPath,
      platform: process.platform,
      env: {},
      stdout: {
        write: (text: string) => {
          logs.stdout += text;
        },
      },
      stderr: {
        write: (text: string) => {
          logs.stderr += text;
        },
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    spawn,
    killProcessTree: (pid: number, options: { graceMs: number }) => {
      kills.push({ pid, graceMs: options.graceMs });
      const capture = children.at(-1)!;
      // The actual process owner retains timeout/cancel status despite a late valid body and exit 0.
      setTimeout(() => captureOutput(child!, capture, lateSummaryBytes ?? "", "", 0), 1);
    },
    REPO_ROOT: repo,
    RESEARCH_SCRIPT: path.join(repo, "scripts/operator/lcx-finance-research-run.ts"),
    CYCLE_SCRIPT: path.join(repo, "scripts/operator/lcx-finance-daily-cycle.ts"),
    RUNS_LOG: FINANCE_DAILY_CYCLE_RUNS_FILENAME,
    FINANCE_SCHEDULER_LOCK,
    FINANCE_RESEARCH_PORTFOLIO_PLAN_FILENAME,
    FINANCE_SCHEDULER_TICK_MS,
    FINANCE_TRADING_WEEKDAYS,
    financeEtClock,
    readFinanceSchedulerState,
    writeFinanceSchedulerState,
    readFinanceSchedulerDatabaseRuns,
    readFinanceSchedulerPolicyAuthorization,
    normalizeFinanceSchedulerIntradayLastTick,
    financeResearchPortfolioContextSchema,
    financeResearchPortfolioAbstentionSchema,
    financeScheduledResearchHandoffSchema,
    financeResearchControllerHandoffSchema,
    caseflowFingerprint,
    buildFinanceBrokerAccountResearchEvidence,
    writeFinanceNightReviewEvidence,
    buildFinanceHistoricalResearchFeedback,
    DEFAULT_WORKSPACE_DIR: params.researchPreparation?.workspace ?? nativeProducer!.workspace,
    OUTPUT_LIMIT: 1024 * 1024,
    require: (specifier: string) => {
      if (specifier !== "../../src/agents/finance-portfolio-composition.ts") {
        throw new Error(`unexpected original dependency: ${specifier}`);
      }
      return { financePortfolioPlanSchema };
    },
  });
  const code = ts.transpileModule(
    `${scheduler.text}\n${processOwner.text}\nglobalThis.nativeOwners={fire};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  new vm.Script(code, { filename: "original-finance-scheduler-day-seam" }).runInContext(context);
  const writerContext = vm.createContext({
    createHash,
    fs: fsp,
    path,
    randomUUID,
    process: { pid: process.pid },
    require: (specifier: string) => {
      if (specifier !== "../../src/agents/finance-portfolio-composition.ts") {
        throw new Error(`unexpected original writer dependency: ${specifier}`);
      }
      return { financePortfolioPlanSchema };
    },
  });
  const writerCode = ts.transpileModule(
    `${writer.text}\nglobalThis.nativeOwners={writeVerifiedPortfolioPlan,compactFinanceResearchSummary};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  new vm.Script(writerCode, { filename: "original-finance-scheduler-plan-writer" }).runInContext(
    writerContext,
  );
  owners = {
    ...(context.nativeOwners as Pick<NativeOwners, "fire">),
    ...(writerContext.nativeOwners as Omit<NativeOwners, "fire">),
  };
  const accepted = await owners.fire(
    {
      root: resolveFinanceStateDir({ directory }),
      options: {
        command: "once",
        mode: "day",
        researchPlan: {
          contextPath,
          ask: params.researchPreparation?.input.ask ?? nativeProducer!.receipt!.plan.ask,
        },
        timeoutMs: params.fault === "research_timeout" ? 30 : 10_000,
        extraArgs: ["--venue", "paper"],
      },
      signal: controller.signal,
    },
    "day",
  );
  const state = readFinanceSchedulerState(directory);
  const runLogPath = path.join(directory, FINANCE_DAILY_CYCLE_RUNS_FILENAME);
  const runLogBytes = fs.readFileSync(runLogPath, "utf8");
  const record = JSON.parse(runLogBytes.trim().split("\n").at(-1)!) as {
    runId: string;
    firedAt: string;
    ok: boolean;
    execution: { outcome: string; blockReason?: string };
    researchPlanRefresh: {
      ok: boolean;
      planPath: string | null;
      processResult: FinanceCycleProcessResult;
    };
  };
  const planPath = path.join(directory, "research-portfolio-plan-latest.json");
  const planReadback = fs.existsSync(planPath)
    ? financePortfolioPlanSchema.parse(JSON.parse(fs.readFileSync(planPath, "utf8")))
    : undefined;
  const proof = {
    asOf,
    accepted,
    originalSummary,
    originalSummaryBytes,
    deliveredSummary,
    children,
    kills,
    logs,
    record,
    state,
    planReadback,
    frozenContextReadback,
    controllerEvidenceReadback,
    dayResult,
    nativeInput: nativeProducer?.executeInput,
    nativeReceiptPath: nativeProducer?.receiptPath,
    nativeBook: directory,
    runLogSha256: sha(runLogBytes),
    nativeSourceSha256: {
      scheduler: scheduler.sourceSha256,
      processOwner: processOwner.sourceSha256,
      writer: writer.sourceSha256,
    },
    limits: params.researchChildConsumer
      ? "original same-attempt research child consumer injected at process IO; actual original CLI result supplies summary. No full scheduler/heartbeat/autopilot/provider/broker; scripted transport is not semantic quality."
      : "only original day owner functions and actual process deadline; local child IO. Native research producer ran once; preflight account evidence is observed separately, not represented as consumed by that earlier runner. No full scheduler/heartbeat/autopilot/provider/broker. Default day callback is deliberately not_run, not a completed day cycle. Scripted model transport is not semantic quality.",
  };
  await fsp.writeFile(
    path.join(params.directory, "native-scheduler-captured-consumption.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  return { ...proof, directory, planPath, runLogPath, nativeProducer: nativeProducer! };
}
