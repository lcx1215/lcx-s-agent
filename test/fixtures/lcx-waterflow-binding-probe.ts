import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import JSON5 from "json5";
import ts from "typescript";
import { runExternalChannelLocalVerificationTest } from "../../scripts/operator/lcx-external-channel-binding.js";
import { resolveExternalChannelTruth } from "../../scripts/operator/lcx-external-channel-status.js";
import { buildLearningSedimentationBridge } from "../../scripts/operator/lcx-learning-sedimentation-bridge.js";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.js";
import { resolveLcxIdentityMigrationPlan } from "../../src/config/paths.js";

const repo = path.resolve(import.meta.dirname, "../..");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type RecordValue = Record<string, unknown>;
export type BindingProbeFault = "missing" | "timeout" | "malformed";

/** Preserve original declarations; replace only imports and the direct-execution guard. */
async function originalModule(file: string, globals: RecordValue) {
  const sourcePath = path.join(repo, file);
  const source = await fs.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const statements = ast.statements.filter(
    (node) =>
      !ts.isImportDeclaration(node) &&
      !(
        ts.isIfStatement(node) &&
        node.expression.getText(ast).includes("import.meta.url === pathToFileURL(process.argv[1])")
      ),
  );
  const text = statements
    .map((node) => node.getText(ast).replaceAll("import.meta.url", "sourceMeta.url"))
    .join("\n");
  const runtime = vm.createContext({
    exports: {},
    sourceMeta: { url: pathToFileURL(sourcePath).href },
    fileURLToPath,
    pathToFileURL,
    path,
    os,
    JSON5,
    Buffer,
    Date,
    createHash,
    randomUUID,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  vm.runInContext(
    ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    runtime,
    { filename: file },
  );
  return { runtime, sourcePath, sourceSha256: sha(source) };
}

export type BindingVerificationFault =
  | "missing_receipt"
  | "source_conflict"
  | "test_failure"
  | "missing_host_pin";

export async function probeOriginalBinding(
  root: string,
  fault?: BindingProbeFault,
  localVerification?: { fault?: BindingVerificationFault },
) {
  await fs.mkdir(root, { recursive: true });
  const workspace = path.join(root, "workspace");
  const privateRepo = path.join(root, "repo");
  const guardLog = path.join(root, "guard.jsonl");
  const quotaLog = path.join(root, "quota.jsonl");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(privateRepo, "scripts/operator"), { recursive: true });
  // Real source bytes permit the original registered-case reader; no eval is executed.
  await fs.copyFile(
    path.join(repo, "scripts/operator/local-brain-distill-eval.ts"),
    path.join(privateRepo, "scripts/operator/local-brain-distill-eval.ts"),
  );
  await fs.writeFile(guardLog, "");
  await fs.writeFile(quotaLog, "");
  let localVerificationProduced:
    | Awaited<ReturnType<typeof runExternalChannelLocalVerificationTest>>
    | undefined;
  let localVerificationTestResultBytes: string | undefined;
  if (localVerification) {
    // A private source projection uses the existing read-only Git HEAD; no refs/index/commit writes.
    const actualGit = await promisify(execFile)("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: repo,
      encoding: "utf8",
    });
    await fs.writeFile(path.join(privateRepo, ".git"), `gitdir: ${actualGit.stdout.trim()}\n`);
    await fs.copyFile(
      path.join(repo, "scripts/operator/lcx-external-channel-binding.ts"),
      path.join(privateRepo, "scripts/operator/lcx-external-channel-binding.ts"),
    );
    const code = `const fs=require('node:fs');const assert=require('node:assert/strict');const text=fs.readFileSync('scripts/operator/lcx-external-channel-binding.ts','utf8');assert(text.includes('readExternalChannelLocalVerification'));console.log('binding reader source assertion executed');${localVerification.fault === "test_failure" ? "process.exitCode=3;" : ""}`;
    localVerificationProduced = await runExternalChannelLocalVerificationTest({
      sourceRoot: privateRepo,
      changedFiles: ["scripts/operator/lcx-external-channel-binding.ts"],
      command: process.execPath,
      args: ["-e", code],
      receiptPath: path.join(root, "local-verification.json"),
    });
    localVerificationTestResultBytes = await fs.readFile(
      localVerificationProduced.testResult.path,
      "utf8",
    );
    if (localVerification.fault === "source_conflict") {
      await fs.appendFile(
        path.join(privateRepo, "scripts/operator/lcx-external-channel-binding.ts"),
        "\n// source changed after test\n",
      );
    }
    if (localVerification.fault === "missing_receipt") {
      await fs.unlink(localVerificationProduced.receiptPath);
    }
  }
  const reads: Array<{ operation: string; path: string; sha256?: string; bytes?: number }> = [];
  const deniedReads: string[] = [];
  const inside = (file: string) => {
    const absolute = path.resolve(file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      deniedReads.push(absolute);
      throw Object.assign(new Error("private source unavailable; host reads forbidden"), {
        code: "ENOENT",
      });
    }
    return absolute;
  };
  const privateFs = {
    ...fs,
    readFile: async (file: string, encoding?: BufferEncoding) => {
      const absolute = inside(file);
      const bytes = await fs.readFile(absolute);
      reads.push({
        operation: "readFile",
        path: absolute,
        sha256: sha(bytes),
        bytes: bytes.length,
      });
      return encoding ? bytes.toString(encoding) : bytes;
    },
    access: async (file: string) => fs.access(inside(file)),
    stat: async (file: string) => fs.stat(inside(file)),
    readdir: async (file: string) => fs.readdir(inside(file)),
    mkdir: async (file: string, options?: { recursive?: boolean }) =>
      fs.mkdir(inside(file), options),
    writeFile: async (file: string, bytes: string | Buffer) => fs.writeFile(inside(file), bytes),
  };
  const invocations: Array<{
    command: string;
    args: string[];
    cwd?: string;
    timeout?: number;
    stdoutSha256?: string;
    outcome?: string;
  }> = [];
  let trainingPlan: RecordValue | undefined;
  let trainingPlanBytes: string | undefined;
  const producer = await originalModule("scripts/operator/local-brain-training-plan.ts", {
    fs: privateFs,
    process: { env: {}, argv: [], execPath: process.execPath },
    DEFAULT_GUARD_LOG_PATH: guardLog,
    DEFAULT_WORKSPACE_DIR: workspace,
    DEFAULT_WORKSPACE_LOG_DIR: root,
    createModuleLearningPipelineReviewTool,
    resolveLcxIdentityMigrationPlan,
    buildLearningSedimentationBridge,
    promisify: () => async () => {
      throw new Error("training/process/provider child forbidden");
    },
    execFile: undefined,
  });
  const snapshotPath = path.join(root, "binding.json");
  const owner = await originalModule("scripts/operator/lcx-external-channel-binding.ts", {
    fs: privateFs,
    LCX_USER_HOME: path.join(root, "private-user"),
    process: {
      env: { LCX_EXTERNAL_CHANNEL_COMMAND_TIMEOUT_MS: "20" },
      argv: [],
      execPath: process.execPath,
    },
    promisify:
      () =>
      async (command: string, args: string[], options: { cwd?: string; timeout?: number }) => {
        const call: (typeof invocations)[number] = { command, args: [...args], ...options };
        invocations.push(call);
        if (command === "git") {
          const result = await promisify(execFile)(command, args, {
            cwd: options.cwd,
            encoding: "utf8",
          });
          call.outcome = "original_git_head_read_only";
          call.stdoutSha256 = sha(result.stdout);
          return result;
        }
        if (args.includes("scripts/operator/local-brain-training-plan.ts")) {
          if (fault === "missing" || fault === "timeout") {
            call.outcome = fault;
            throw Object.assign(new Error(`private training-plan ${fault}`), {
              killed: fault === "timeout",
              signal: fault === "timeout" ? "SIGTERM" : undefined,
            });
          }
          trainingPlan = (await vm.runInContext(
            `buildLocalBrainTrainingPlan({guardLogPath: ${JSON.stringify(guardLog)}, quotaLogPath: ${JSON.stringify(quotaLog)}, workspaceDir: ${JSON.stringify(workspace)}, worktree: ${JSON.stringify(privateRepo)}, json: true, processCheck: false})`,
            producer.runtime,
          )) as RecordValue;
          trainingPlanBytes = JSON.stringify(trainingPlan);
          const stdout = fault === "malformed" ? "{native-plan-body-unreadable" : trainingPlanBytes;
          call.stdoutSha256 = sha(stdout);
          call.outcome = "original_plan_built_transport_response";
          return { stdout, stderr: "" };
        }
        if (args.includes("scripts/operator/lcx-external-channel-compat.ts")) {
          call.outcome = "probe_unavailable_lowest_transport";
          throw new Error("offline runtime probe is unavailable; no probe executed");
        }
        if (command.endsWith("live-sidecar-sync-doctor.sh") && args.length === 0) {
          call.outcome = "doctor_unavailable_lowest_transport";
          throw new Error("offline host doctor is unavailable; no doctor executed");
        }
        throw new Error("unexpected child forbidden");
      },
    execFile: undefined,
  });
  const options = {
    json: true,
    apply: false,
    compatibilityOnly: false,
    snapshotPath,
    sidecarRoot: path.join(root, "unbound-runtime"),
    ...(localVerificationProduced
      ? {
          localVerificationReceipt: localVerificationProduced.receiptPath,
          localVerificationSourceRoot: privateRepo,
          ...(localVerification?.fault === "missing_host_pin"
            ? {}
            : { localVerificationTestResultSha256: localVerificationProduced.testResult.sha256 }),
        }
      : {}),
  };
  owner.runtime.bindingOptions = options;
  const binding = (await vm.runInContext(
    "runExternalChannelBinding(bindingOptions)",
    owner.runtime,
  )) as RecordValue;
  const writtenBytes = await fs.readFile(snapshotPath);
  const written = JSON.parse(writtenBytes.toString("utf8")) as RecordValue;
  const summary = written.externalChannelBinding as RecordValue;
  const statusInput = {
    binding: summary,
    bindingOwnerAvailable: true,
    legacyExternalChannelStatus: undefined,
    visibleProof: undefined,
  };
  const status = resolveExternalChannelTruth(statusInput);
  return {
    boundary: "offline_original_binding_nonapply_private_io_no_training_provider_probe_or_send",
    sourcePins: [producer, owner].map(({ sourcePath, sourceSha256 }) => ({
      path: sourcePath,
      sha256: sourceSha256,
    })),
    localInput: { guardLog, quotaLog, privateRepo, processCheck: false },
    localVerificationProduced,
    localVerificationTestResultBytes,
    reads,
    deniedReads,
    invocations,
    trainingPlan,
    trainingPlanBytes,
    trainingPlanSha256: trainingPlanBytes ? sha(trainingPlanBytes) : undefined,
    binding,
    writer: { path: snapshotPath, sha256: sha(writtenBytes), body: written },
    statusInput,
    status,
    observedNativeScope: "original_plan_and_binding_do_not_emit_shared_run_identity",
    missingFrontend:
      localVerification && (binding.localVerification as RecordValue)?.status === "verified"
        ? []
        : ["local_change_to_local_tests", "local_tests_to_native_training_plan"],
    actualHostProbeObserved: false,
    userVisibleObserved: false,
  };
}
