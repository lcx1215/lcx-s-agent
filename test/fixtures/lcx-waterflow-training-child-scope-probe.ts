import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import {
  buildFailureCurriculumPrompts,
  readTrainingCaller,
  verifyTrainingFailureSource,
  reviewFailureCurriculum,
  type TrainingCallerRef,
} from "../../scripts/operator/minimax-brain-failure-curriculum.js";
import { parseJsonObjectFromOutput } from "../../scripts/operator/smoke-json-output.js";
import {
  buildExternalBrainDistillationCandidate,
  buildExternalBrainDistillationCandidateArtifact,
} from "../../src/agents/external-brain-distillation-candidates.js";
import {
  beginOriginalGuardCaller,
  appendOriginalEval,
  deliverToOriginalTeacher,
} from "./lcx-waterflow-training-feedback-probe.js";

const execute = promisify(execFile);
export const trainingScopeRepo = path.resolve(import.meta.dirname, "../..");
export type TrainingChildOptions = {
  workspaceDir: string;
  dataDir: string;
  trainSliceDir: string;
  logPath: string;
  teacherProfile: string;
  batchLimit: number;
  teacherConcurrency: number;
  teacherDurationMinutes: number;
  mock: boolean;
  noTrainSlice: boolean;
  trainSliceMaxReviewExamples: number;
  trainSliceCuratedRepeat: number;
  trainSliceNonReviewRepeat: number;
};
export type TrainingScopeInvocation = {
  command: string;
  args: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  boundary?: string;
};
type ChildOwners = {
  runTeacherStep: (options: TrainingChildOptions, round: number) => Promise<unknown>;
  runDatasetStep: (options: TrainingChildOptions, round: number) => Promise<unknown>;
  runSmokeStep: (options: TrainingChildOptions, round: number) => Promise<unknown>;
  buildTrainSlice: (options: TrainingChildOptions, round: number) => Promise<string>;
};
export async function trainingScopeHash(file: string) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}
export function trainingScopeOptions(root: string): TrainingChildOptions {
  return {
    workspaceDir: path.join(root, "requested-workspace"),
    dataDir: path.join(root, "requested-data"),
    trainSliceDir: path.join(root, "requested-slice"),
    logPath: path.join(root, "guard-child-receipt.jsonl"),
    teacherProfile: "teacher-batch",
    batchLimit: 1,
    teacherConcurrency: 1,
    teacherDurationMinutes: 1,
    mock: true,
    noTrainSlice: false,
    trainSliceMaxReviewExamples: 20,
    trainSliceCuratedRepeat: 1,
    trainSliceNonReviewRepeat: 1,
  };
}

export async function seedTrainingScopeHoldouts(root: string) {
  // These private external sources are explicit deterministic fixture reviews, not teacher
  // labels relabeled as holdouts. The original dataset split decides their allocation.
  const candidates = [
    "Review ETF liquidity",
    "Review company valuation",
    "Review commodity evidence",
  ].map((userMessage) =>
    buildExternalBrainDistillationCandidate({
      source: "external_visible_reply",
      userMessage,
      payload: `${userMessage}: source registry, finance evidence, portfolio risk and review panel; research-only.`,
      review: {
        accepted: true,
        reviewer: "deterministic_smoke",
        reason: "Private structural input fixture, not semantic acceptance",
      },
    }),
  );
  const artifact = buildExternalBrainDistillationCandidateArtifact({ candidates });
  const externalSourcePath = path.join(
    root,
    "memory/external-brain-distillation-candidates/private-holdout.json",
  );
  await fs.mkdir(path.dirname(externalSourcePath), { recursive: true });
  await fs.writeFile(externalSourcePath, JSON.stringify(artifact) + "\n");
  return { artifact, externalSourcePath };
}

// Load only original child functions. Importing this operator would start its guard loop.
// No owner function is replaced: the adapter is its lowest spawn call, never the trainer.
export async function loadOriginalTrainingChildOwners(sourcePath: string, privateRoot: string) {
  const source = await fs.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "appendLog",
    "runCommand",
    "parseJsonFromStdout",
    "runJsonStep",
    "trainingResultSha256",
    "runTeacherStep",
    "runDatasetStep",
    "runSmokeStep",
    "buildTrainSlice",
  ]);
  const declarations = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""),
  );
  const functionTexts = declarations.map((node) => node.getText(ast));
  for (const [name, step] of [
    ["runDatasetStep", "dataset"],
    ["runSmokeStep", "smoke"],
  ]) {
    if (declarations.some((node) => node.name?.text === name)) {
      continue;
    }
    let originalCall: string | undefined;
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === "runJsonStep" &&
        node.arguments[2]?.getText(ast) === JSON.stringify(step)
      ) {
        originalCall = node.getText(ast);
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
    if (!originalCall) {
      throw new Error(`Missing original ${step} child seam`);
    }
    functionTexts.push(`async function ${name}(options, round) { return await ${originalCall}; }`);
  }
  const invocations: TrainingScopeInvocation[] = [];
  const context = vm.createContext({
    fs,
    path,
    Date,
    setTimeout,
    clearTimeout,
    WORKTREE_CWD: trainingScopeRepo,
    TRAINING_ABSORPTION_CONTRACT_VERSION: "compact_teacher_review_v2",
    parseJsonObjectFromOutput,
    createHash,
    process: { env: {}, stdout: { write() {} }, stderr: { write() {} } },
    spawn(command: string, args: string[]) {
      const observation: TrainingScopeInvocation = { command, args: [...args] };
      invocations.push(observation);
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(async () => {
        try {
          if (command !== "node") {
            throw new Error("Non-node child is forbidden in the offline scope fixture");
          }
          const script = args[2];
          if (script === "scripts/operator/minimax-quota-brain-saturator.ts") {
            observation.boundary = "plus_teacher_branch_arguments_only_no_saturator_execution";
            observation.stdout = JSON.stringify({ ok: true, boundary: observation.boundary });
            child.stdout.write(observation.stdout);
            child.emit("close", 0);
            return;
          }
          if (
            ![
              "scripts/operator/minimax-brain-teacher-batch.ts",
              "scripts/operator/local-brain-distill-dataset.ts",
              "scripts/operator/local-brain-distill-smoke.ts",
              "scripts/operator/local-brain-distill-train-slice.ts",
            ].includes(script)
          ) {
            throw new Error(`Forbidden child: ${script}`);
          }
          if (script.endsWith("minimax-brain-teacher-batch.ts") && !args.includes("--mock")) {
            throw new Error("Non-mock teacher is forbidden");
          }
          // This is a child-only fixture HOME. Every fallback stays inside privateRoot;
          // no user HOME/config/model/provider or default dataset is read or written.
          const result = await execute(process.execPath, args, {
            cwd: trainingScopeRepo,
            env: { ...process.env, HOME: path.join(privateRoot, "private-default-home") },
            maxBuffer: 4 * 1024 * 1024,
          });
          observation.stdout = result.stdout;
          observation.stderr = result.stderr;
          observation.exitCode = 0;
          child.stdout.write(result.stdout);
          child.stderr.write(result.stderr);
          child.emit("close", 0);
        } catch (error) {
          observation.stderr = String(error);
          observation.exitCode = 1;
          child.stderr.write(observation.stderr);
          child.emit("close", 1);
        }
      });
      return child;
    },
  });
  const isolated =
    functionTexts.join("\n") +
    "\nglobalThis.owners = {runTeacherStep, runDatasetStep, runSmokeStep, buildTrainSlice};";
  vm.runInContext(
    ts.transpileModule(isolated, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  const owners = vm.runInContext("owners", context) as ChildOwners;
  return { owners, invocations, sourceSha256: await trainingScopeHash(sourcePath) };
}
export async function preserveTrainingScope(root: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(root, path.join(destination, "private-bytes"), { recursive: true });
}

/** Original guard functions and selected original caller statements, never its resident loop.
 * File CLIs are real; only trainer process I/O and Python generation are local substitutes.
 * No substitute result is labeled model/semantic success or adapter promotion.
 */
type NativeTrainingProbeResult = Awaited<ReturnType<typeof runNativeTrainingProbe>>;
export function probeOriginalTrainingTail(
  root: string,
  fault: "eval_timeout" | "train_nan" | undefined,
  capture: { guardRounds: 2; fullQuota?: boolean; seniorFailure?: boolean },
): Promise<Extract<NativeTrainingProbeResult, { quotaRuns: unknown }>>;
export function probeOriginalTrainingTail(
  root: string,
  fault?: "eval_timeout" | "train_nan",
  capture?: { fullQuota?: boolean; guardRounds?: undefined },
): Promise<Exclude<NativeTrainingProbeResult, { quotaRuns: unknown }>>;
export function probeOriginalTrainingTail(
  root: string,
  fault?: "eval_timeout" | "train_nan",
  capture: { fullQuota?: boolean; guardRounds?: 2; seniorFailure?: boolean } = {},
): Promise<NativeTrainingProbeResult> {
  return runNativeTrainingProbe(root, fault, capture);
}

async function runNativeTrainingProbe(
  root: string,
  fault?: "eval_timeout" | "train_nan",
  capture: { fullQuota?: boolean; guardRounds?: 2; seniorFailure?: boolean } = {},
) {
  const sourcePath = path.join(
    trainingScopeRepo,
    "scripts/operator/minimax-brain-training-guard.ts",
  );
  const source = await fs.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements
    .filter(ts.isFunctionDeclaration)
    .map((node) => node.getText(ast));
  const constants = new Set([
    "MIN_PROMOTION_EVAL_CASES",
    "TRAIN_NAN_PATTERN",
    "TRAINING_ABSORPTION_CONTRACT_VERSION",
    "CATASTROPHIC_CANDIDATE_MIN_CASES",
    "CATASTROPHIC_CANDIDATE_MAX_PASS_RATE",
    "LOCAL_TRAINING_COLLAPSE_BACKOFF_SEED_LIMIT",
    "HARDENED_EVAL_STEP_TIMEOUT_MS",
    "HARDENED_EVAL_IDLE_TIMEOUT_MS",
  ]);
  const declarations = ast.statements
    .filter(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.every((item) => constants.has(item.name.getText(ast))),
    )
    .map((node) => node.getText(ast));
  const caller = await beginOriginalGuardCaller(root);
  const options = {
    ...trainingScopeOptions(root),
    workspaceDir: root,
    logPath: path.join(root, "guard.jsonl"),
    pythonBin: path.join(root, "worker-python"),
    model: "private-fixture-model",
    trainIters: 1,
    trainLoadMax: Number.MAX_VALUE,
    evolutionCooldownMinutes: 0.0001,
    trainingCaller: caller.caller,
    adapterPrefix: path.join(root, "adapters/candidate"),
    ...(capture.guardRounds
      ? {
          teacherProfile: "minimax-plus-brain",
          batchLimit: 2,
          teacherConcurrency: 1,
          teacherSidecar: false,
          noTrain: false,
          bootstrapIfMissing: true,
          currentAdapter: "latest-passing",
          evalEvery: 99,
          trainEvery: 1,
          loadMax: Number.MAX_VALUE,
          durationMinutes: 1,
          lockEnabled: true,
          lockPath: path.join(root, "private-guard.lock"),
        }
      : {}),
  };
  // Independent fixture failure input is written by the original guard receipt writer.
  // It seeds this attempt's original curriculum, not a transplanted previous proof.
  await appendOriginalEval(options.logPath, new Date().toISOString(), {
    adapterPath: path.join(root, "prior-private-adapter"),
    summary: {
      passed: 1,
      total: 2,
      passRate: 0.5,
      failedCaseIds: ["data_vendor_conflict_reconciliation"],
      promotionReady: false,
    },
  });
  if (!capture.guardRounds) {
    await fs.link(options.logPath, path.join(root, "minimax-brain-training-guard-whole.jsonl"));
  }
  const curriculum = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts, {
    caller: caller.caller,
  });
  const invocations: Array<
    TrainingScopeInvocation & {
      inputFiles?: Array<{ path: string; sha256: string; raw: string }>;
      kills?: string[];
      lateClose?: boolean;
      actualArgs?: string[];
      guardLogInput?: { path: string; raw: string; sha256: string; bytes: number };
      localTransportClosed?: boolean;
    }
  > = [];
  const candidateAdapter = path.join(root, "adapters", "candidate-1");
  const privateHome = path.join(root, "private-home");
  const fakePython = path.join(
    privateHome,
    ".openclaw",
    "local-brain-trainer",
    ".venv",
    "bin",
    "python",
  );
  await fs.mkdir(path.dirname(fakePython), { recursive: true });
  await fs.writeFile(fakePython, "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o755 });
  const pending: Promise<void>[] = [];
  let clockOffset = 0;
  let observedGuardRound = 0;
  const clockEvents: Array<{ round: number; offsetMs: number }> = [];
  class LocalWorkerClock extends Date {
    constructor(value?: string | number | Date) {
      super(value instanceof Date ? value.getTime() : (value ?? Date.now() + clockOffset));
    }
    static now() {
      return Date.now() + clockOffset;
    }
  }
  const privateLogDir = path.join(privateHome, ".openclaw/workspace/logs");
  // In the complete guard branch the resolver default directory stays absent;
  // its actual explicit --log file must work without any copied/linked history alias.
  const context = vm.createContext({
    fs,
    path,
    os: { loadavg: () => [0] },
    Date: capture.guardRounds ? LocalWorkerClock : Date,
    clearTimeout,
    setTimeout: (callback: () => void, ms: number) =>
      setTimeout(
        () => {
          if (
            capture.guardRounds &&
            observedGuardRound === 2 &&
            ms === options.evolutionCooldownMinutes * 60000
          ) {
            clockOffset = 60000;
            clockEvents.push({ round: 2, offsetMs: clockOffset });
          }
          callback();
        },
        fault === "eval_timeout" &&
          (!capture.guardRounds || observedGuardRound === 2) &&
          ms >= 720000
          ? 15
          : ms,
      ),
    CPU_COUNT: 1,
    WORKTREE_CWD: trainingScopeRepo,
    DEFAULT_GUARD_LOG_DIR: capture.guardRounds ? privateLogDir : root,
    TRAINER_ROOT: path.join(privateHome, ".openclaw/local-brain-trainer"),
    parseJsonObjectFromOutput,
    createHash,
    options,
    round: 2,
    candidateAdapter,
    currentAdapter: undefined,
    trainingSeedAdapter: undefined,
    trainingResumeAdapter: undefined,
    trainingResumeSeed: undefined,
    resumeAdapter: undefined,
    trainingSeed: undefined,
    catastrophicTrainingSeedBackoffs: new Set<string>(),
    localTrainingPaused: false,
    deadline: Date.now() + 60000,
    process: {
      env: {},
      pid: process.pid,
      argv: process.argv,
      kill(pid: number, signal: number) {
        if (signal !== 0) {
          throw new Error("Host signal forbidden");
        }
        return process.kill(pid, signal);
      },
      stdout: {
        write(text: string) {
          const match = /\[minimax-guard\] round=(\d+)/u.exec(text);
          if (match) {
            observedGuardRound = Number(match[1]);
          }
        },
      },
      stderr: { write() {} },
    },
    spawn(command: string, args: string[]) {
      const row: (typeof invocations)[number] = { command, args: [...args], kills: [] };
      invocations.push(row);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill(signal: string) {
          row.kills?.push(signal);
          return true;
        },
      });
      const work = (async () => {
        // Allow the native process owner to install its data/close handlers first.
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        try {
          if (capture.guardRounds && command === "ps") {
            row.stdout = "";
            row.boundary = "private_process_inventory_IO_substitute_not_host_inventory";
          } else if (command === "nice") {
            const data = args[args.indexOf("--data") + 1];
            const adapter = args[args.indexOf("--adapter-path") + 1];
            if (
              !data.startsWith(root + path.sep) ||
              !(capture.guardRounds
                ? adapter.startsWith(options.adapterPrefix + "-")
                : adapter === candidateAdapter)
            ) {
              throw new Error("Private training paths required");
            }
            row.inputFiles = await Promise.all(
              ["train.jsonl", "valid.jsonl", "test.jsonl", "manifest.json"].map(async (name) => {
                const file = path.join(data, name);
                const bytes = await fs.readFile(file);
                return {
                  path: file,
                  raw: bytes.toString(),
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                };
              }),
            );
            row.boundary = "local_trainer_IO_reads_actual_slice_no_MLX_or_model";
            await fs.mkdir(adapter, { recursive: true });
            await fs.writeFile(path.join(adapter, "adapter_config.json"), "{}\n");
            await fs.writeFile(
              path.join(adapter, "adapters.safetensors"),
              "NOT_MODEL_WEIGHTS_LOCAL_IO_FIXTURE\n",
            );
            row.stdout =
              fault === "train_nan"
                ? "train loss nan\n"
                : "local worker IO finished; no model trained\n";
          } else if (
            capture.seniorFailure &&
            command === "node" &&
            args[2] === "scripts/operator/local-brain-distill-eval.ts"
          ) {
            // Fresh subprocess-schema input, not an old compact receipt or an evaluator run.
            // The guard's native parser, log writer and promotion branch consume these bytes.
            const seniorCaseId = "senior_trader_failure_focus_promotion_chain";
            row.boundary =
              "synthetic_eval_subprocess_stdout_no_original_evaluator_or_model_execution";
            row.stdout =
              JSON.stringify(
                {
                  ok: false,
                  boundary: "local_auxiliary_thought_flow_only",
                  model: args[args.indexOf("--model") + 1],
                  adapterPath: args[args.indexOf("--adapter") + 1],
                  noAdapter: false,
                  hardened: args.includes("--hardened"),
                  blind: args.includes("--blind"),
                  contractOnly: false,
                  summary: {
                    total: 1,
                    passed: 0,
                    passRate: 0,
                    failedCaseIds: [seniorCaseId],
                    modelContractFailureCaseIds: [seniorCaseId],
                    parseRecoveredCaseIds: [],
                    promotionReady: false,
                  },
                },
                null,
                2,
              ) + "\n";
            row.exitCode = 1;
            child.stdout.write(row.stdout);
            child.emit("close", 1);
            child.stdout.destroy();
            child.stderr.destroy();
            row.localTransportClosed = child.stdout.destroyed && child.stderr.destroyed;
            return;
          } else if (
            command === "node" &&
            args[2] === "scripts/operator/local-brain-distill-eval.ts" &&
            fault === "eval_timeout" &&
            (!capture.guardRounds || observedGuardRound === 2)
          ) {
            row.boundary = "local_delayed_eval_process_IO_no_evaluator_execution";
            await new Promise((resolve) => setTimeout(resolve, 60));
            row.stdout = JSON.stringify({
              summary: { total: 100, passed: 100, promotionReady: true },
            });
            row.lateClose = true;
          } else {
            if (
              capture.guardRounds &&
              args[2] === "scripts/operator/minimax-quota-brain-saturator.ts"
            ) {
              row.actualArgs = [
                ...args,
                "--log",
                path.join(root, `quota-${observedGuardRound}.jsonl`),
                "--prompt-dir",
                path.join(root, `quota-prompts-${observedGuardRound}`),
                "--timeout",
                "10",
              ];
              const inputPath = args[args.indexOf("--guard-log") + 1];
              const inputBytes = await fs.readFile(inputPath);
              row.guardLogInput = {
                path: inputPath,
                raw: inputBytes.toString("utf8"),
                sha256: createHash("sha256").update(inputBytes).digest("hex"),
                bytes: inputBytes.length,
              };
            }
            if (
              command !== "node" ||
              ![
                "scripts/operator/minimax-brain-teacher-batch.ts",
                "scripts/operator/local-brain-distill-dataset.ts",
                "scripts/operator/local-brain-distill-smoke.ts",
                "scripts/operator/local-brain-distill-train-slice.ts",
                "scripts/operator/local-brain-distill-eval.ts",
                ...(capture.guardRounds
                  ? ["scripts/operator/minimax-quota-brain-saturator.ts"]
                  : []),
              ].includes(args[2]) ||
              (args[2].endsWith("teacher-batch.ts") && !args.includes("--mock"))
            ) {
              throw new Error("Forbidden worker in private training probe");
            }
            const result = await execute(process.execPath, row.actualArgs ?? args, {
              cwd: trainingScopeRepo,
              env: privateTrainingEnvironment(root, privateHome),
              maxBuffer: 16 * 1024 * 1024,
            });
            row.stdout = result.stdout;
            row.stderr = result.stderr;
            row.boundary = args[2].endsWith("distill-eval.ts")
              ? "original_eval_CLI_private_empty_Python_response_no_model"
              : "original_file_CLI";
          }
          row.exitCode = 0;
          child.stdout.write(row.stdout ?? "");
          child.stderr.write(row.stderr ?? "");
          child.emit("close", 0);
          child.stdout.destroy();
          child.stderr.destroy();
          row.localTransportClosed = child.stdout.destroyed && child.stderr.destroyed;
        } catch (error) {
          const failed = error as { stdout?: string; stderr?: string };
          row.exitCode = 1;
          row.stdout = failed.stdout;
          row.stderr = failed.stderr ?? String(error);
          child.stdout.write(row.stdout ?? "");
          child.stderr.write(row.stderr);
          child.emit("close", 1);
          child.stdout.destroy();
          child.stderr.destroy();
          row.localTransportClosed = child.stdout.destroyed && child.stderr.destroyed;
        }
      })();
      pending.push(work);
      return child;
    },
  });
  const evaluate = (code: string) =>
    vm.runInContext(
      ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      context,
    ) as Promise<unknown>;
  await evaluate([...declarations, ...functions].join("\n"));
  // Execute the actual quota caller's teacher invocation with its original prompt sidecar.
  const quotaPath = path.join(
    trainingScopeRepo,
    "scripts/operator/minimax-quota-brain-saturator.ts",
  );
  const quotaSource = await fs.readFile(quotaPath, "utf8");
  const quotaAst = ts.createSourceFile(quotaPath, quotaSource, ts.ScriptTarget.Latest, true);
  let teacherCall: string | undefined;
  let evalStatement: string | undefined;
  let promotionBranch: string | undefined;
  const promotionInputs: string[] = [];
  const visitQuota = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(quotaAst) === "runJsonStep" &&
      node.arguments[2]?.getText(quotaAst) === '"minimax_teacher_batch"'
    ) {
      teacherCall = node.getText(quotaAst);
    }
    ts.forEachChild(node, visitQuota);
  };
  visitQuota(quotaAst);
  const visitGuard = (node: ts.Node) => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((item) => item.name.getText(ast) === "candidateEval")
    ) {
      evalStatement = node.getText(ast);
      if (ts.isBlock(node.parent)) {
        promotionInputs.push(
          ...node.parent.statements
            .filter(
              (item) =>
                ts.isVariableStatement(item) &&
                item.declarationList.declarations.some((declaration) =>
                  [
                    "datasetPromotionRisk",
                    "candidateEvalSha256",
                    "candidateEvalPromotionReady",
                    "promotionBlockedByDatasetShrink",
                  ].includes(declaration.name.getText(ast)),
                ),
            )
            .map((item) => item.getText(ast)),
        );
      }
    }
    if (
      ts.isIfStatement(node) &&
      [
        "promotionEvalPassed(candidateEval) && !promotionBlockedByDatasetShrink",
        "candidateEvalPromotionReady && !promotionBlockedByDatasetShrink",
      ].includes(node.expression.getText(ast))
    ) {
      promotionBranch = node.getText(ast);
    }
    ts.forEachChild(node, visitGuard);
  };
  visitGuard(ast);
  if (!teacherCall || !evalStatement || !promotionBranch) {
    throw new Error("Original training caller statements unavailable");
  }
  context.teacherOptions = {
    ...options,
    timeoutSeconds: 10,
    concurrency: 1,
    openclawAgent: "offline",
    mock: true,
    promptHandoff: curriculum.promptHandoff,
  };
  context.promptPath = curriculum.promptPath;
  context.batchSize = 2;
  context.currentConcurrency = 1;
  let quota: Awaited<ReturnType<typeof runOriginalPrivateQuotaLoop>> | undefined;
  const { artifact, externalSourcePath } = await seedTrainingScopeHoldouts(root);
  if (capture.guardRounds) {
    await evaluate("options.adapterPrefix=defaultAdapterPrefixForModel(options.model)");
    const stateNames = new Set([
      "releaseRunLock",
      "startedAt",
      "deadline",
      "round",
      "currentAdapter",
      "catastrophicTrainingSeedBackoffs",
      "currentAdapterUsableForTraining",
      "trainingSeed",
      "localTrainingPaused",
      "trainingSeedAdapter",
      "trainingResumeSeed",
      "trainingResumeAdapter",
      "teacherSidecar",
      "minimaxTeacherRetired",
    ]);
    const entryState = ast.statements.filter(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.every((item) => stateNames.has(item.name.getText(ast))),
    );
    const entryTry = ast.statements.find(
      (node) => ts.isTryStatement(node) && node.tryBlock.statements.some(ts.isWhileStatement),
    );
    const guardStart = ast.statements.find(
      (node) =>
        ts.isExpressionStatement(node) && node.getText(ast).includes('event: "guard_start"'),
    );
    if (!entryTry || !guardStart) {
      throw new Error("Original complete guard loop/start caller unavailable");
    }
    await evaluate(
      `(async()=>{${entryState.map((node) => node.getText(ast)).join("\n")}\n${guardStart.getText(ast)}\n${entryTry.getText(ast)}})()`,
    );
    await Promise.all(pending);
    const guardRaw = await fs.readFile(options.logPath, "utf8");
    const quotaRuns = await Promise.all(
      invocations
        .filter((row) => row.args[2] === "scripts/operator/minimax-quota-brain-saturator.ts")
        .map(async (row) => {
          const output = parseJsonObjectFromOutput(row.stdout ?? "");
          const logPath = String(output.logPath);
          if (!logPath.startsWith(root + path.sep)) {
            throw new Error("Private quota native log path required");
          }
          const raw = await fs.readFile(logPath, "utf8");
          const receipts = raw
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          const teacherReceipt = receipts.find((entry) => entry.name === "minimax_teacher_batch");
          const teacherResult = teacherReceipt?.result as Record<string, unknown> | undefined;
          const reviewPath = path.resolve(root, String(teacherResult?.reviewPath));
          if (!reviewPath.startsWith(root + path.sep)) {
            throw new Error("Private teacher producer path required");
          }
          const reviewBytes = await fs.readFile(reviewPath);
          return {
            invocation: row,
            output,
            logReadback: {
              path: logPath,
              raw,
              sha256: createHash("sha256").update(raw).digest("hex"),
            },
            receipts,
            teacher: teacherReceipt?.result,
            teacherReviewReadback: {
              path: reviewPath,
              sha256: createHash("sha256").update(reviewBytes).digest("hex"),
              bytes: reviewBytes.length,
            },
          };
        }),
    );
    const lastQuota = quotaRuns.at(-1);
    if (!lastQuota) {
      throw new Error("Original guard never dispatched quota");
    }
    const args = [
      "--import",
      "tsx",
      "scripts/operator/local-brain-promotion-audit.ts",
      "--guard-log",
      options.logPath,
      "--quota-log",
      lastQuota.logReadback.path,
      "--worktree",
      trainingScopeRepo,
      "--model",
      options.model,
      "--no-process-check",
      "--json",
    ];
    const audit = await execute(process.execPath, args, {
      cwd: trainingScopeRepo,
      env: privateTrainingEnvironment(root, privateHome),
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const auditResult = JSON.parse(audit.stdout) as Record<string, unknown>;
    const resolverFailureOutput = auditResult.resolverFailureReceipt;
    const auditSourcePath = path.join(
      trainingScopeRepo,
      "scripts/operator/local-brain-promotion-audit.ts",
    );
    const auditSource = await fs.readFile(auditSourcePath, "utf8");
    const auditAst = ts.createSourceFile(
      auditSourcePath,
      auditSource,
      ts.ScriptTarget.Latest,
      true,
    );
    const resolverFunction = auditAst.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "resolveCurrentAdapter",
    );
    const asRecordFunction = auditAst.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "asRecord",
    );
    if (!resolverFunction || !asRecordFunction) {
      throw new Error("Original independent resolver consumer unavailable");
    }
    const negativeResolverReads: Array<{ kind: string; result: unknown }> = [];
    for (const [kind, stdout] of [
      ["missing_stdout", undefined],
      ["non_json", "not a receipt"],
      [
        "oversize",
        JSON.stringify({
          ok: false,
          status: "blocked",
          reason: "adapter_resolution_failed",
          boundary: "local_auxiliary_thought_flow_only",
        }) + " ".repeat(13000),
      ],
    ] as const) {
      const isolated = vm.createContext({
        process: { execPath: process.execPath },
        Buffer,
        parseJsonObjectFromOutput,
        execFileAsync: async () => {
          throw Object.assign(new Error("private nonzero child IO substitute"), { stdout });
        },
      });
      vm.runInContext(
        ts.transpileModule(
          asRecordFunction.getText(auditAst) + "\n" + resolverFunction.getText(auditAst),
          {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
          },
        ).outputText,
        isolated,
      );
      isolated.params = {
        worktree: trainingScopeRepo,
        guardLogPath: options.logPath,
        model: options.model,
      };
      negativeResolverReads.push({
        kind,
        result: await vm.runInContext("resolveCurrentAdapter(params)", isolated),
      });
    }
    return {
      caller,
      options,
      quotaRuns,
      invocations,
      clockEvents,
      receipts: guardRaw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
      guardLog: {
        path: options.logPath,
        raw: guardRaw,
        sha256: createHash("sha256").update(guardRaw).digest("hex"),
      },
      promotionAudit: {
        args,
        stdout: audit.stdout,
        result: auditResult,
        resolverFailureOutput,
        negativeResolverReads,
      },
      source: {
        guard: {
          path: sourcePath,
          sha256: await trainingScopeHash(sourcePath),
          entryTrySha256: createHash("sha256").update(entryTry.getText(ast)).digest("hex"),
        },
      },
      boundary:
        "original_complete_guard_two_rounds_deadline_clock_and_low_worker_IO_substitutes_no_semantic_model_success",
    };
  }
  const teacher = capture.fullQuota
    ? (quota = await runOriginalPrivateQuotaLoop(root, caller.caller, options.dataDir, privateHome))
        .teacher
    : await evaluate(`(async()=>{const options=teacherOptions;return await ${teacherCall};})()`);
  const dataset = await evaluate("runDatasetStep(options,round)");
  const smoke = await evaluate("runSmokeStep(options,round)");
  const trained = await evaluate("runTrain(options,round,candidateAdapter)");
  context.trained = trained;
  let candidateEval: unknown;
  if ((trained as { ok?: boolean }).ok) {
    candidateEval = await evaluate(
      `(async()=>{${evalStatement}\n${promotionInputs.join("\n")}\n${promotionBranch}\nreturn candidateEval;})()`,
    );
  }
  await evaluate("runEvolutionCooldown(options,round,deadline)");
  await Promise.all(pending);
  const selectedAdapter = await evaluate(
    `resolveLatestPassingAdapter(${JSON.stringify(path.join(root, "adapters/candidate"))})`,
  );
  const nextReview = await reviewFailureCurriculum({
    guardLogPath: options.logPath,
    workspaceDir: root,
    maxPrompts: 2,
    caller: caller.caller,
  });
  let nextCurriculum: Awaited<ReturnType<typeof deliverToOriginalTeacher>> | undefined;
  let nextTeacherReadError: string | undefined;
  try {
    nextCurriculum = await deliverToOriginalTeacher(root, buildFailureCurriculumPrompts, {
      caller: caller.caller,
    });
  } catch (error) {
    nextTeacherReadError = String(error);
  }
  const guardRaw = await fs.readFile(options.logPath, "utf8");
  const teacherReviewPath = path.resolve(root, (teacher as { reviewPath: string }).reviewPath);
  const teacherReviewBytes = await fs.readFile(teacherReviewPath);
  const teacherReviewReadback = {
    path: teacherReviewPath,
    raw: teacherReviewBytes.toString("utf8"),
    sha256: createHash("sha256").update(teacherReviewBytes).digest("hex"),
    bytes: teacherReviewBytes.length,
  };
  let promotionAudit:
    | {
        args: string[];
        stdout: string;
        stderr: string;
        result: Record<string, unknown>;
        source: { path: string; sha256: string };
      }
    | undefined;
  if (capture.fullQuota) {
    const args = [
      "--import",
      "tsx",
      "scripts/operator/local-brain-promotion-audit.ts",
      "--guard-log",
      options.logPath,
      "--quota-log",
      path.join(root, "quota.jsonl"),
      "--worktree",
      trainingScopeRepo,
      "--model",
      options.model,
      "--no-process-check",
      "--json",
    ];
    const result = await execute(process.execPath, args, {
      cwd: trainingScopeRepo,
      env: privateTrainingEnvironment(root, privateHome),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20000,
    });
    const auditSource = path.join(
      trainingScopeRepo,
      "scripts/operator/local-brain-promotion-audit.ts",
    );
    promotionAudit = {
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      result: JSON.parse(result.stdout),
      source: { path: auditSource, sha256: await trainingScopeHash(auditSource) },
    };
  }
  return {
    caller,
    options,
    curriculum,
    teacher,
    teacherReviewReadback,
    quota,
    promotionAudit,
    artifact,
    externalSource: {
      path: externalSourcePath,
      sha256: await trainingScopeHash(externalSourcePath),
    },
    dataset,
    smoke,
    trained,
    candidateEval,
    selectedAdapter,
    nextReview,
    nextCurriculum,
    nextTeacherReadError,
    invocations,
    receipts: guardRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    source: {
      guard: { path: sourcePath, sha256: await trainingScopeHash(sourcePath) },
      quota: { path: quotaPath, sha256: await trainingScopeHash(quotaPath) },
      statements: { teacherCall, evalStatement, promotionBranch },
    },
    boundary:
      "same_private_attempt_original_selected_callers_and_file_consumers_not_resident_guard_or_model_learning",
    gaps: [
      "no_resident_guard_loop_execution",
      "no_real_model_training_or_semantic_eval_success",
      "no_actual_adapter_promotion",
      "no_natural_next_guard_dispatch",
    ],
  };
}

function privateTrainingEnvironment(root: string, privateHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: privateHome,
    // lcx-local-paths intentionally ignores HOME, so this independent sandbox override
    // is required as well. No global config, workspace or trainer path is inherited.
    LCX_USER_HOME: privateHome,
    OPENCLAW_CONFIG_PATH: path.join(root, "private-config.json"),
    OPENCLAW_STATE_DIR: path.join(root, "private-state"),
    HF_HUB_OFFLINE: "1",
  };
}

async function runOriginalPrivateQuotaLoop(
  root: string,
  caller: TrainingCallerRef,
  dataDir: string,
  privateHome: string,
) {
  const file = path.join(trainingScopeRepo, "scripts/operator/minimax-quota-brain-saturator.ts");
  const source = await fs.readFile(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const loop = ast.statements.find(
    (node) => ts.isTryStatement(node) && node.tryBlock.statements.some(ts.isForStatement),
  );
  const plan = ast.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((item) => item.name.getText(ast) === "plan"),
  );
  if (!loop || !plan) {
    throw new Error("Original quota entry loop/plan unavailable");
  }
  const arrays = new Set([
    "TASK_TEMPLATES",
    "ASSETS",
    "SINGLE_COMPANY_ASSETS",
    "THEMES",
    "HORIZONS",
  ]);
  const declarations = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.every((item) => arrays.has(item.name.getText(ast)))),
  );
  const chunks: string[] = [];
  const errors: string[] = [];
  const io: Array<{
    command: string;
    originalArgs: string[];
    actualArgs: string[];
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    prompt?: { path: string; raw: string; sha256: string };
    handoff?: { path: string; raw: string; sha256: string };
  }> = [];
  const localProcess = {
    env: privateTrainingEnvironment(root, privateHome),
    stdout: {
      write(text: string) {
        chunks.push(text);
      },
    },
    stderr: {
      write(text: string) {
        errors.push(text);
      },
    },
    exitCode: 0,
  };
  const options = {
    workspaceDir: root,
    dataDir,
    logPath: path.join(root, "quota.jsonl"),
    promptDir: path.join(root, "quota-prompts"),
    guardLogPath: path.join(root, "guard.jsonl"),
    trainingCaller: caller,
    failureFocus: true,
    write: true,
    mock: true,
    profile: "manual",
    maxCalls: 2,
    batchLimit: 2,
    reserve: 0,
    durationMinutes: 1,
    concurrency: 1,
    datasetEvery: 1,
    smokeEvery: 1,
    timeoutSeconds: 10,
    openclawAgent: "private-offline-teacher",
    directApi: false,
    allowPartialWrite: false,
    adaptive: false,
    minBatchLimit: 1,
    minConcurrency: 1,
    rateLimitCooldownSeconds: 0,
    providerCooldownSeconds: 0,
    maxRateLimitRounds: 1,
    maxProviderInstabilityRounds: 1,
    previewPrompts: 0,
  };
  const pending: Promise<void>[] = [];
  const context = vm.createContext({
    fs,
    path,
    createHash,
    Date,
    setTimeout,
    clearTimeout,
    WORKTREE_CWD: trainingScopeRepo,
    parseJsonObjectFromOutput,
    reviewFailureCurriculum,
    readTrainingCaller,
    verifyTrainingFailureSource,
    options,
    process: localProcess,
    attempted: 0,
    completedRounds: 0,
    currentBatchLimit: 2,
    currentConcurrency: 1,
    consecutiveRateLimitRounds: 0,
    consecutiveProviderUnstableRounds: 0,
    stopReason: "target_calls_reached",
    spawn(command: string, args: string[]) {
      const row: (typeof io)[number] = { command, originalArgs: [...args], actualArgs: [...args] };
      io.push(row);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      const work = (async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        try {
          if (
            command !== "node" ||
            ![
              "scripts/operator/minimax-brain-teacher-batch.ts",
              "scripts/operator/local-brain-distill-dataset.ts",
              "scripts/operator/local-brain-distill-smoke.ts",
            ].includes(args[2]) ||
            (args[2].endsWith("teacher-batch.ts") && !args.includes("--mock"))
          ) {
            throw new Error("Private quota child whitelist rejected");
          }
          for (const [flag, key] of [
            ["--prompt-file", "prompt"],
            ["--prompt-handoff", "handoff"],
          ] as const) {
            const index = args.indexOf(flag);
            if (index < 0) {
              continue;
            }
            const target =
              flag === "--prompt-handoff"
                ? (JSON.parse(args[index + 1]) as { path: string }).path
                : args[index + 1];
            if (!target.startsWith(root + path.sep)) {
              throw new Error("Private quota prompt path required");
            }
            const raw = await fs.readFile(target, "utf8");
            row[key] = {
              path: target,
              raw,
              sha256: createHash("sha256").update(raw).digest("hex"),
            };
          }
          const result = await execute(process.execPath, row.actualArgs, {
            cwd: trainingScopeRepo,
            env: privateTrainingEnvironment(root, privateHome),
            maxBuffer: 8 * 1024 * 1024,
            timeout: 15000,
          });
          row.stdout = result.stdout;
          row.stderr = result.stderr;
          row.exitCode = 0;
        } catch (error) {
          const failed = error as { stdout?: string; stderr?: string; code?: number };
          row.stdout = failed.stdout;
          row.stderr = failed.stderr ?? String(error);
          row.exitCode = typeof failed.code === "number" ? failed.code : 1;
        }
        child.stdout.write(row.stdout ?? "");
        child.stderr.write(row.stderr ?? "");
        child.emit("close", row.exitCode);
      })();
      pending.push(work);
      return child;
    },
  });
  const evaluate = (code: string) =>
    vm.runInContext(
      ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      context,
    ) as Promise<unknown>;
  await evaluate(declarations.map((node) => node.getText(ast)).join("\n"));
  await evaluate(
    `const calls=targetCalls(options);const rounds=Math.ceil(calls/options.batchLimit);const deadline=Date.now()+options.durationMinutes*60000;${plan.getText(ast)}`,
  );
  await evaluate("appendLog(options.logPath,{event:'quota_saturator_start',plan})");
  await evaluate(`(async()=>{${loop.getText(ast)}})()`);
  await Promise.all(pending);
  const terminal = chunks.at(-1);
  if (!terminal) {
    throw new Error("Original quota terminal JSON missing");
  }
  const teacherIo = io.find((row) => row.originalArgs[2].endsWith("teacher-batch.ts"));
  if (!teacherIo?.stdout) {
    throw new Error("Original quota teacher stdout absent");
  }
  return {
    output: JSON.parse(terminal) as Record<string, unknown>,
    stdout: chunks.join(""),
    stderr: errors.join(""),
    teacher: parseJsonObjectFromOutput(teacherIo.stdout),
    io,
    log: {
      path: options.logPath,
      raw: await fs.readFile(options.logPath, "utf8"),
      sha256: await trainingScopeHash(options.logPath),
    },
    source: {
      path: file,
      sha256: await trainingScopeHash(file),
      loopSha256: createHash("sha256").update(loop.getText(ast)).digest("hex"),
    },
    boundary:
      "original_complete_quota_loop_original_mock_teacher_dataset_smoke_processes_no_paid_provider",
  };
}
