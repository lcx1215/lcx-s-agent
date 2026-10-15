import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import {
  reviewFailureCurriculum,
  recordTrainingCaller,
  readTrainingCaller,
  readTrainingPromptHandoff,
  verifyTrainingFailureSource,
  type TrainingCallerRef,
  type FailureCurriculumOptions,
  type TeacherPrompt,
} from "../../scripts/operator/minimax-brain-failure-curriculum.js";
import { parseJsonObjectFromOutput } from "../../scripts/operator/smoke-json-output.js";

export const feedbackRepo = path.resolve(import.meta.dirname, "../..");
export async function feedbackHash(file: string) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

// Execute the original entry's one recording statement, not its guard loop.
export async function beginOriginalGuardCaller(root: string) {
  const source = await fs.readFile(
    path.join(feedbackRepo, "scripts/operator/minimax-brain-training-guard.ts"),
    "utf8",
  );
  const ast = ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true);
  const statement = ast.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      node.expression
        .getText(ast)
        .startsWith("options.trainingCaller = await recordTrainingCaller("),
  );
  if (!statement) {
    throw new Error("Missing native guard caller recording statement");
  }
  const options = {
    logPath: path.join(root, "guard.jsonl"),
    workspaceDir: root,
    teacherProfile: "minimax-plus-brain",
    batchLimit: 2,
    teacherDurationMinutes: 1,
    teacherConcurrency: 1,
    dataDir: path.join(root, "data"),
    mock: true,
    trainingCaller: undefined as TrainingCallerRef | undefined,
  };
  const runtime = await isolate(
    "scripts/operator/minimax-brain-training-guard.ts",
    ["runTeacherStep"],
    {
      recordTrainingCaller,
      options,
      runJsonStep: async (
        _options: unknown,
        _round: number,
        _name: string,
        command: string,
        args: string[],
      ) => ({
        command,
        args,
        boundary: "original_guard_function_branch_argv_only_no_child_dispatch",
      }),
    },
  );
  await vm.runInContext(
    ts.transpileModule(`(async()=>{${statement.getText(ast)}})()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    runtime,
  );
  const dispatch = (await vm.runInContext("runTeacherStep(options, 1)", runtime)) as {
    command: string;
    args: string[];
    boundary: string;
  };
  return {
    caller: options.trainingCaller!,
    dispatch,
    boundary: "original_entry_statement_and_branch_functions_only_not_guard_loop",
  };
}

// Invalid private input makes main return before any teacher/provider invocation.
export async function originalTeacherReadFailure(
  root: string,
  caller: TrainingCallerRef,
  promptFile: string,
  handoff: { path: string; sha256: string },
) {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/minimax-brain-teacher-batch.ts",
        "--mock",
        "--json",
        "--workspace",
        root,
        "--agent-dir",
        path.join(root, "private-agent"),
        "--prompt-file",
        promptFile,
        "--prompt-handoff",
        JSON.stringify(handoff),
        "--caller-receipt",
        JSON.stringify(caller),
      ],
      {
        cwd: feedbackRepo,
        env: { PATH: process.env.PATH, HOME: path.join(root, "private-home") },
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    throw new Error("Invalid private input unexpectedly reached teacher main success");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("stdout" in error) ||
      typeof error.stdout !== "string"
    ) {
      throw error;
    }
    return JSON.parse(error.stdout) as Record<string, unknown>;
  }
}
async function isolate(file: string, names: readonly string[], context: Record<string, unknown>) {
  const source = await fs.readFile(
    path.isAbsolute(file) ? file : path.join(feedbackRepo, file),
    "utf8",
  );
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const selected = new Set(names);
  const declarations = ast.statements.flatMap((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && selected.has(node.name.text)) {
      return [node.getText(ast)];
    }
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) => selected.has(d.name.getText(ast)))
    ) {
      return [node.getText(ast)];
    }
    return [];
  });
  const runtime = vm.createContext({ fs, path, console, ...context });
  vm.runInContext(
    ts.transpileModule(declarations.join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    runtime,
  );
  return runtime;
}

/** Original quota loop and guard branches, with native local stdout replacing only teacher I/O. */
export async function originalProviderPaymentStop(
  root: string,
  error: string | undefined,
  probe: {
    quotaSource?: string;
    guardSource?: string;
    expireOnCompletion?: boolean;
    curriculumCaller?: TrainingCallerRef;
  } = {},
) {
  const quotaFile =
    probe.quotaSource ??
    path.join(feedbackRepo, "scripts/operator/minimax-quota-brain-saturator.ts");
  const guardFile =
    probe.guardSource ??
    path.join(feedbackRepo, "scripts/operator/minimax-brain-training-guard.ts");
  const quotaSource = await fs.readFile(quotaFile, "utf8");
  const quotaAst = ts.createSourceFile(quotaFile, quotaSource, ts.ScriptTarget.Latest, true);
  const quotaLoop = quotaAst.statements.find(
    (node) => ts.isTryStatement(node) && node.tryBlock.statements.some(ts.isForStatement),
  );
  if (!quotaLoop) {
    throw new Error("original_quota_loop_missing");
  }
  const payload = {
    ok: !error,
    acceptedCandidates: error ? 1 : 2,
    failures: error ? [{ id: "private_partial", error }] : [],
    answer: "Market example: price 402; payment required is a quote, not a provider error",
  };
  const responseFile = path.join(root, "local-teacher-response.json");
  await fs.writeFile(responseFile, JSON.stringify(payload) + "\n");
  let stdout = "";
  let stderr = "";
  let teacherRequests = 0;
  let integrityChecks = 0;
  const nativeInputs: Record<string, unknown>[] = [];
  const localProcess = {
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
    exitCode: 0,
  };
  const quota = await isolate(
    quotaFile,
    [
      "runJsonStep",
      "parseJsonFromStdout",
      "appendLog",
      "writePromptFile",
      "promptFamilyCounts",
      "familyFromPromptId",
      "isProviderLimitSignal",
      "isProviderPaymentRequired",
      "isProviderTransportSignal",
      "providerTransportFailureCount",
      "failureErrorsFromResult",
      "acceptedCandidatesFromResult",
      "backOffAfterProviderPressure",
      "sleep",
      ...(probe.curriculumCaller
        ? [
            "TASK_TEMPLATES",
            "ASSETS",
            "SINGLE_COMPANY_ASSETS",
            "THEMES",
            "HORIZONS",
            "fillTemplate",
            "buildPrompt",
            "buildPrompts",
            "buildBatchPrompts",
          ]
        : []),
    ],
    {
      process: localProcess,
      parseJsonObjectFromOutput,
      createHash,
      reviewFailureCurriculum,
      readTrainingCaller,
      verifyTrainingFailureSource,
      setTimeout,
      options: {
        logPath: path.join(root, "quota.jsonl"),
        promptDir: path.join(root, "prompts"),
        workspaceDir: root,
        failureFocus: Boolean(probe.curriculumCaller),
        guardLogPath: path.join(root, "guard.jsonl"),
        trainingCaller: probe.curriculumCaller,
        allowPartialWrite: true,
        timeoutSeconds: 20,
        openclawAgent: "private-offline-teacher",
        adaptive: true,
        minBatchLimit: 1,
        minConcurrency: 1,
        rateLimitCooldownSeconds: 0,
        providerCooldownSeconds: 0,
        maxRateLimitRounds: 4,
        maxProviderInstabilityRounds: 4,
      },
      calls: 4,
      attempted: 0,
      completedRounds: 0,
      currentBatchLimit: 2,
      currentConcurrency: 2,
      consecutiveRateLimitRounds: 0,
      consecutiveProviderUnstableRounds: 0,
      stopReason: "target_calls_reached",
      deadline: Date.now() + 10_000,
      buildBatchPrompts: async (_options: unknown, _start: number, count: number) => ({
        prompts: Array.from({ length: count }, (_, i) => ({
          id: `private_math_${i}`,
          userMessage: "offline arithmetic fixture",
        })),
        failureFocusPrompts: 0,
      }),
      runIntegrityChecks: async () => {
        integrityChecks += 1;
      },
      runCommand: async (command: string, args: string[]) => {
        teacherRequests += 1;
        let promptConsumption: unknown;
        if (probe.curriculumCaller) {
          const teacher = await isolate(
            "scripts/operator/minimax-brain-teacher-batch.ts",
            ["isTeacherPrompt", "loadTeacherPrompts", "buildTeacherUserPayload"],
            { readTrainingPromptHandoff },
          );
          const options = {
            promptFile: args[args.indexOf("--prompt-file") + 1],
            workspaceDir: root,
            trainingCaller: JSON.parse(args[args.indexOf("--caller-receipt") + 1]),
            promptHandoff: JSON.parse(args[args.indexOf("--prompt-handoff") + 1]),
            promptReadback: undefined,
          };
          teacher.options = options;
          teacher.prompts = await vm.runInContext("loadTeacherPrompts(options)", teacher);
          promptConsumption = {
            prompts: teacher.prompts,
            inputs: vm.runInContext("prompts.map(buildTeacherUserPayload)", teacher),
            readback: options.promptReadback,
          };
        }
        nativeInputs.push({
          command,
          args,
          responseFile,
          responseSha256: await feedbackHash(responseFile),
          promptConsumption,
          boundary: "native_local_response_substitute_no_teacher_service",
        });
        const startedAt = Date.now();
        try {
          const result = await promisify(execFile)(
            process.execPath,
            [
              "-e",
              "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'));process.exitCode=Number(process.argv[2])",
              responseFile,
              error ? "1" : "0",
            ],
            { cwd: root, timeout: 2000 },
          );
          localProcess.stdout.write(result.stdout);
          localProcess.stderr.write(result.stderr);
          return { ...result, durationMs: Date.now() - startedAt, exitCode: 0 };
        } catch (failure) {
          const failed = failure as { stdout: string; stderr: string; code: number };
          localProcess.stdout.write(failed.stdout);
          localProcess.stderr.write(failed.stderr);
          return {
            stdout: failed.stdout,
            stderr: failed.stderr,
            durationMs: Date.now() - startedAt,
            exitCode: failed.code,
          };
        }
      },
    },
  );
  if (probe.expireOnCompletion) {
    const originalAppendLog = quota.appendLog;
    quota.appendLog = async (file: string, value: Record<string, unknown>) => {
      if (value.event === "teacher_provider_payment_blocked") {
        quota.deadline = Date.now() - 1;
      }
      return originalAppendLog(file, value);
    };
  }
  await vm.runInContext(
    ts.transpileModule(`(async()=>{${quotaLoop.getText(quotaAst)}})()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    quota,
    { timeout: 1000 },
  );
  const quotaOutput = parseJsonObjectFromOutput(stdout);
  const quotaOutputFile = path.join(root, "original-quota-stdout.txt");
  await fs.writeFile(quotaOutputFile, stdout);
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<void> | undefined;
  let serialFallbacks = 0;
  let datasetCalls = 0;
  let smokeCalls = 0;
  const guardSource = await fs.readFile(guardFile, "utf8");
  const guardAst = ts.createSourceFile(guardFile, guardSource, ts.ScriptTarget.Latest, true);
  let teacherBranch: ts.IfStatement | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(guardAst) === "teacherSidecar") {
      teacherBranch = node;
    }
    ts.forEachChild(node, walk);
  };
  walk(guardAst);
  if (!teacherBranch || !ts.isBlock(teacherBranch.parent)) {
    throw new Error("original_guard_teacher_branch_missing");
  }
  const statements = teacherBranch.parent.statements;
  const index = statements.indexOf(teacherBranch);
  const next = statements
    .slice(index + 1, index + 3)
    .map((node) => node.getText(guardAst))
    .join("\n");
  if (
    !next.includes("runDatasetStep(options, round)") ||
    !next.includes("runSmokeStep(options, round)")
  ) {
    throw new Error("original_guard_continuation_changed");
  }
  const guard = await isolate(
    guardFile,
    [
      "startTeacherSidecar",
      "shouldRunTeacherSidecar",
      "teacherPaymentBlocked",
      "parseJsonFromStdout",
      "appendLog",
    ],
    {
      process: {
        env: process.env,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
      parseJsonObjectFromOutput,
      setTimeout,
      WORKTREE_CWD: root,
      spawn: () => {
        child = spawn(
          process.execPath,
          [
            "-e",
            "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'));process.exitCode=Number(process.argv[2])",
            quotaOutputFile,
            String(localProcess.exitCode),
          ],
          { cwd: root },
        );
        childClosed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
        return child;
      },
      runTeacherStepOrRetire: async () => {
        serialFallbacks += 1;
      },
      runDatasetStep: async () => {
        datasetCalls += 1;
      },
      runSmokeStep: async () => {
        smokeCalls += 1;
      },
      options: {
        teacherSidecar: true,
        teacherProfile: "minimax-plus-brain",
        logPath: path.join(root, "guard.jsonl"),
        workspaceDir: root,
        dataDir: path.join(root, "datasets"),
        durationMinutes: 1,
        teacherSidecarDurationMinutes: 1,
        teacherSidecarMaxCalls: 4,
        teacherSidecarBatchLimit: 2,
        teacherSidecarConcurrency: 2,
      },
      round: 1,
      minimaxTeacherRetired: false,
    },
  );
  guard.teacherSidecar = await vm.runInContext("startTeacherSidecar(options)", guard);
  if (!child) {
    throw new Error("private_native_sidecar_missing");
  }
  await childClosed;
  const sidecar = guard.teacherSidecar as { exitCode: number | null; stopReason?: string };
  const sidecarAtDecision = { exitCode: sidecar.exitCode, stopReason: sidecar.stopReason };
  let guardError: string | undefined;
  try {
    await vm.runInContext(
      ts.transpileModule(`(async()=>{${teacherBranch.getText(guardAst)}\n${next}})()`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      guard,
      { timeout: 1000 },
    );
  } catch (failure) {
    guardError = String(failure);
  }
  return {
    source: {
      quota: {
        path: quotaFile,
        sha256: await feedbackHash(quotaFile),
        loopSha256: createHash("sha256").update(quotaLoop.getText(quotaAst)).digest("hex"),
      },
      guard: {
        path: guardFile,
        sha256: await feedbackHash(guardFile),
        branchSha256: createHash("sha256").update(teacherBranch.getText(guardAst)).digest("hex"),
      },
    },
    quotaOutput,
    quotaOutputFile,
    localExitCode: localProcess.exitCode,
    nativeInputs,
    teacherRequests,
    integrityChecks,
    sidecarAtDecision,
    serialFallbacks,
    datasetCalls,
    smokeCalls,
    guardError,
    stderr,
    boundary:
      "original_quota_loop_and_guard_native_stdout_consumer_with_local_teacher_response_substitute; no_training_or_provider",
  };
}

// Run only the original receipt writer and runJsonStep with a local engine response.
// No guard loop, child process, evaluator, trainer, credential, or model is run.
export async function appendOriginalEval(
  logPath: string,
  at: string,
  result: Record<string, unknown>,
  timedOut = false,
) {
  class FixedDate extends Date {
    constructor() {
      super(at);
    }
  }
  const runtime = await isolate(
    "scripts/operator/minimax-brain-training-guard.ts",
    [
      "appendLog",
      "runJsonStep",
      "parseJsonFromStdout",
      "promotionEvalPassed",
      "MIN_PROMOTION_EVAL_CASES",
      "timedOutStepResult",
      "trainingResultSha256",
      "adapterArgFromArgs",
    ],
    {
      Date: FixedDate,
      process: { stdout: { write() {} } },
      TRAINING_ABSORPTION_CONTRACT_VERSION: "compact_teacher_review_v2",
      parseJsonObjectFromOutput,
      createHash,
      runCommand: async () => ({
        stdout: JSON.stringify(result),
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        timedOut,
        timeoutReason: timedOut ? "timeout" : undefined,
      }),
    },
  );
  runtime.options = { logPath };
  runtime.args = ["--adapter", result.adapterPath];
  await vm.runInContext(
    "runJsonStep(options, 2, 'candidate_hardened_eval', 'offline-engine', args, {allowFailure:true})",
    runtime,
  );
  return (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function frozenCurriculum(file: string) {
  const source = await fs.readFile(file, "utf8");
  const exports = {};
  const runtime = vm.createContext({
    exports,
    process: { env: {} },
    require(name: string) {
      if (name === "node:fs/promises") {
        return fs;
      }
      if (name === "node:os") {
        return os;
      }
      if (name === "node:path") {
        return path;
      }
      throw new Error(`Forbidden frozen import ${name}`);
    },
  });
  vm.runInContext(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    runtime,
  );
  return exports as {
    buildFailureCurriculumPrompts: (options: FailureCurriculumOptions) => Promise<TeacherPrompt[]>;
  };
}

// Extract original file producers/consumers, never their top-level owner stacks.
export async function deliverToOriginalTeacher(
  root: string,
  buildFailureCurriculumPrompts: (options: FailureCurriculumOptions) => Promise<TeacherPrompt[]>,
  probe: {
    saturatorSource?: string;
    review?: typeof reviewFailureCurriculum;
    caller?: TrainingCallerRef;
    beforeTeacherRead?: (input: {
      promptPath: string;
      handoff?: { path: string; sha256: string };
    }) => Promise<void>;
  } = {},
) {
  const saturatorSource =
    probe.saturatorSource ?? "scripts/operator/minimax-quota-brain-saturator.ts";
  const runtime = await isolate(
    saturatorSource,
    [
      "TASK_TEMPLATES",
      "ASSETS",
      "SINGLE_COMPANY_ASSETS",
      "THEMES",
      "HORIZONS",
      "fillTemplate",
      "buildPrompt",
      "buildPrompts",
      "buildBatchPrompts",
      "writePromptFile",
      "appendLog",
    ],
    {
      buildFailureCurriculumPrompts,
      reviewFailureCurriculum: probe.review ?? reviewFailureCurriculum,
      readTrainingCaller,
      verifyTrainingFailureSource,
      createHash,
    },
  );
  runtime.options = {
    failureFocus: true,
    workspaceDir: root,
    guardLogPath: path.join(root, "guard.jsonl"),
    promptDir: path.join(root, "prompts"),
    logPath: path.join(root, "saturator.jsonl"),
    trainingCaller: probe.caller,
  };
  const batch = (await vm.runInContext("buildBatchPrompts(options, 0, 2)", runtime)) as {
    prompts: TeacherPrompt[];
    failureFocusPrompts: number;
    curriculumReview?: unknown;
  };
  // Only the original review logging block is evaluated, never the owner loop.
  if (batch.curriculumReview) {
    const source = await fs.readFile(
      path.isAbsolute(saturatorSource) ? saturatorSource : path.join(feedbackRepo, saturatorSource),
      "utf8",
    );
    const ast = ts.createSourceFile(saturatorSource, source, ts.ScriptTarget.Latest, true);
    let block: string | undefined;
    const walk = (node: ts.Node) => {
      if (ts.isIfStatement(node) && node.expression.getText(ast) === "curriculumReview") {
        block = node.getText(ast);
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
    if (!block) {
      throw new Error("Missing original curriculum review log consumer");
    }
    runtime.curriculumReview = batch.curriculumReview;
    runtime.round = 2;
    await vm.runInContext(
      ts.transpileModule(`(async () => {${block}})()`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      runtime,
    );
  }
  runtime.prompts = batch.prompts;
  runtime.review = batch.curriculumReview;
  const promptPath = (await vm.runInContext(
    "writePromptFile(options, 2, prompts, review)",
    runtime,
  )) as string;
  const teacher = await isolate(
    "scripts/operator/minimax-brain-teacher-batch.ts",
    ["isTeacherPrompt", "loadTeacherPrompts", "buildTeacherUserPayload"],
    { readTrainingPromptHandoff },
  );
  const writerOptions = runtime.options as { promptHandoff?: { path: string; sha256: string } };
  await probe.beforeTeacherRead?.({ promptPath, handoff: writerOptions.promptHandoff });
  const teacherOptions = {
    promptFile: promptPath,
    workspaceDir: root,
    trainingCaller: probe.caller,
    promptHandoff: writerOptions.promptHandoff,
    promptReadback: undefined as Awaited<ReturnType<typeof readTrainingPromptHandoff>> | undefined,
  };
  teacher.options = teacherOptions;
  const consumed = (await vm.runInContext(
    "loadTeacherPrompts(options)",
    teacher,
  )) as TeacherPrompt[];
  teacher.prompts = consumed;
  const inputs = vm.runInContext("prompts.map(buildTeacherUserPayload)", teacher) as string[];
  return {
    batch,
    promptPath,
    consumed,
    inputs,
    promptReadback: teacherOptions.promptReadback,
    promptHandoff: writerOptions.promptHandoff,
    boundary: "original_batch_file_loader_and_teacher_payload_only_no_provider",
  };
}
