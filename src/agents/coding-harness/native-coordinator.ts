import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { STATE_DIR, type OpenClawConfig } from "../../config/config.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { nativeDocker, type NativeContainer, type NativeDocker } from "./native-docker.js";
import {
  issueNativeCodingBinding,
  revokeNativeCodingBinding,
  type NativeCodingRunner,
  type NativeCodingRunBinding,
  type NativeCodingRunResult,
} from "./native-types.js";
import {
  inspectNativeSource,
  nativeManifestDigest,
  nativeSourceUnchanged,
  snapshotNativeTree,
  type NativeSource,
} from "./native-workspace.js";
import {
  AppendOnlyCodingTrajectory,
  sanitizeCodingHarnessText,
  type CodingHarnessTrajectoryEventKind,
} from "./trajectory.js";

export type NativeCodingHarnessInput = Readonly<{
  task: string;
  cwd: string;
  authorizedWorkspaceDir: string;
  config: OpenClawConfig;
  agentDir: string;
  requesterSessionKey: string;
  artifactRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Trusted controller input only. Never populated from model tool arguments. */
  verification?: Readonly<{ argv: readonly string[]; timeoutMs?: number }>;
}>;
export type NativeCodingReceipt = {
  taskId: string;
  runId: string;
  executor: "lcx-embedded-runner";
  baseline?: { head: string; branch: string; manifestDigest: string };
  status:
    | "preparing"
    | "running"
    | "verified"
    | "completed-unverified"
    | "failed"
    | "blocked"
    | "timed-out"
    | "cancelled"
    | "interrupted";
  verified: boolean;
  sourceUnchanged: boolean;
  delivery: "patch/artifact";
  artifactDir: string;
  patchPath: string;
  receiptPath: string;
  sourceDir: string;
  changedPaths: string[];
  artifactDigest?: string;
  error?: string;
  runnerStatus?: NativeCodingRunResult["status"];
  containers: Array<{ name: string; taskId: string; id?: string }>;
  cleanupConfirmed: boolean;
  terminationReason?: "cancelled" | "timed-out" | "failed" | "interrupted";
  verification?: { argv: readonly string[]; code: number; artifactDigest: string };
};
export type NativeCoordinatorDeps = { docker?: NativeDocker; runner?: NativeCodingRunner };
const exec = promisify(execFile);
async function saveReceipt(receipt: NativeCodingReceipt) {
  const temporary = `${receipt.receiptPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temporary, receipt.receiptPath);
}
function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("native run cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function runNativeCodingHarness(
  input: NativeCodingHarnessInput,
  deps: NativeCoordinatorDeps = {},
): Promise<NativeCodingReceipt> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const root = await fs.mkdtemp(path.join(await prepareArtifactRoot(input.artifactRoot), "run-"));
  const receipt: NativeCodingReceipt = {
    taskId,
    runId,
    executor: "lcx-embedded-runner",
    status: "preparing",
    verified: false,
    sourceUnchanged: false,
    delivery: "patch/artifact",
    artifactDir: path.join(root, "artifact"),
    patchPath: path.join(root, "changes.patch"),
    receiptPath: path.join(root, "receipt.json"),
    sourceDir: path.resolve(input.cwd),
    changedPaths: [],
    containers: [],
    cleanupConfirmed: false,
  };
  const trajectory = new AppendOnlyCodingTrajectory(runId);
  async function event(kind: CodingHarnessTrajectoryEventKind, data: Record<string, unknown>) {
    const item = trajectory.append(kind, data);
    await fs.appendFile(path.join(root, "trajectory.jsonl"), JSON.stringify(item) + "\n", {
      mode: 0o600,
    });
    await saveReceipt(receipt);
  }
  const timeoutMs = Math.min(1_800_000, Math.max(1, input.timeoutMs ?? 300_000));
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const docker = deps.docker ?? nativeDocker;
  let source: NativeSource | undefined;
  let binding: NativeCodingRunBinding | undefined;
  let acceptancePassed = false;
  const verification = input.verification
    ? Object.freeze({
        argv: Object.freeze([...input.verification.argv]),
        timeoutMs: input.verification.timeoutMs ?? 60_000,
      })
    : undefined;
  async function allocate(workspaceDir: string): Promise<NativeContainer> {
    const container = await docker.create({
      taskId,
      workspaceDir,
      signal,
      image: input.config.agents?.defaults?.sandbox?.docker?.image,
      allocated: async (name) => {
        receipt.containers.push({ name, taskId });
        await saveReceipt(receipt);
      },
    });
    const record = receipt.containers.find((c) => c.name === container.name);
    if (record) {
      record.id = container.id;
    }
    await saveReceipt(receipt);
    return container;
  }
  try {
    await event("run/requested", { sourceDir: receipt.sourceDir, delivery: receipt.delivery });
    signal.throwIfAborted();
    if (!input.task.trim() || !input.requesterSessionKey) {
      throw new Error("task and requester session are required");
    }
    source = await inspectNativeSource(input.cwd, input.authorizedWorkspaceDir);
    signal.throwIfAborted();
    receipt.baseline = {
      head: source.head,
      branch: source.branch,
      manifestDigest: nativeManifestDigest(source.manifest),
    };
    await fs.writeFile(path.join(root, "baseline.json"), JSON.stringify(source, null, 2) + "\n", {
      mode: 0o600,
    });
    await saveReceipt(receipt);
    const base = path.join(root, "base");
    const taskWorkspace = path.join(root, "task");
    await fs.mkdir(base, { mode: 0o700 });
    await fs.mkdir(taskWorkspace, { mode: 0o700 });
    const copied = await snapshotNativeTree(
      source.root,
      base,
      Object.keys(source.manifest),
      signal,
    );
    if (nativeManifestDigest(copied) !== nativeManifestDigest(source.manifest)) {
      throw new Error("source changed during snapshot");
    }
    await snapshotNativeTree(base, taskWorkspace, undefined, signal);
    const editor = await allocate(taskWorkspace);
    signal.throwIfAborted();
    const agentId = resolveAgentIdFromSessionKey(input.requesterSessionKey);
    binding = issueNativeCodingBinding({
      taskId,
      runId,
      sessionId: randomUUID(),
      sessionKey: `agent:${agentId}:subagent:${runId}`,
      workspaceDir: taskWorkspace,
      sessionFile: path.join(root, "session.jsonl"),
      agentDir: input.agentDir,
      sandbox: editor.sandbox,
      config: input.config,
      maxRuntimeMs: timeoutMs,
    });
    receipt.status = "running";
    await event("run/accepted", { containerId: editor.id });
    const runner = deps.runner ?? (await import("./native-runner.js")).runNativeCodingAgent;
    const result = await untilAbort(
      runner({
        binding,
        task: input.task,
        requesterSessionKey: input.requesterSessionKey,
        signal,
        timeoutMs,
      }),
      signal,
    );
    receipt.runnerStatus = result.status;
    revokeNativeCodingBinding(binding);
    binding = undefined;
    if (!(await docker.destroy(editor))) {
      throw new Error("editor cleanup_unconfirmed; artifact cannot be frozen");
    }
    signal.throwIfAborted();
    await fs.mkdir(receipt.artifactDir, { mode: 0o700 });
    const artifact = await snapshotNativeTree(
      taskWorkspace,
      receipt.artifactDir,
      undefined,
      signal,
    );
    receipt.artifactDigest = nativeManifestDigest(artifact);
    receipt.changedPaths = [...new Set([...Object.keys(source.manifest), ...Object.keys(artifact)])]
      .filter((p) => JSON.stringify(source!.manifest[p]) !== JSON.stringify(artifact[p]))
      .toSorted();
    let patch = "";
    try {
      patch = (
        await exec(
          "git",
          ["diff", "--no-index", "--binary", "--no-ext-diff", "--", "base", "artifact"],
          { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 },
        )
      ).stdout;
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (failure.code !== 1) {
        throw error;
      }
      patch = failure.stdout ?? "";
    }
    let inHunk = false;
    const normalizedPatch = patch
      .split("\n")
      .map((line) => {
        if (line.startsWith("diff --git ")) {
          inHunk = false;
        }
        if (line.startsWith("@@")) {
          inHunk = true;
        }
        return !inHunk && /^(diff --git |--- |\+\+\+ )/.test(line)
          ? line
              .replaceAll("a/base/", "a/")
              .replaceAll("a/artifact/", "a/")
              .replaceAll("b/base/", "b/")
              .replaceAll("b/artifact/", "b/")
          : line;
      })
      .join("\n");
    await fs.writeFile(receipt.patchPath, normalizedPatch, { flag: "wx", mode: 0o600 });
    for (const [relative, entry] of Object.entries(artifact)) {
      await fs.chmod(path.join(receipt.artifactDir, relative), entry.mode & 0o111 ? 0o555 : 0o444);
    }
    await event("workspace/observed", {
      changedPaths: receipt.changedPaths,
      artifactDigest: receipt.artifactDigest,
    });
    if (result.status !== "completed" || !result.executionStarted) {
      receipt.status =
        result.status === "timed-out"
          ? "timed-out"
          : result.status === "cancelled"
            ? "cancelled"
            : result.status === "blocked"
              ? "blocked"
              : "failed";
      receipt.error = result.error ?? `runner did not complete: ${result.status}`;
    } else if (!verification) {
      receipt.status = "completed-unverified";
    } else {
      const verifierWorkspace = path.join(root, "verifier");
      await fs.mkdir(verifierWorkspace, { mode: 0o700 });
      const copy = await snapshotNativeTree(
        receipt.artifactDir,
        verifierWorkspace,
        undefined,
        signal,
      );
      if (nativeManifestDigest(copy) !== receipt.artifactDigest) {
        throw new Error("artifact changed before verification");
      }
      const verifier = await allocate(verifierWorkspace);
      const verifySignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, Math.min(30_000, verification.timeoutMs))),
      ]);
      let observed: { code: number; stdout: string; stderr: string };
      try {
        observed = await untilAbort(
          docker.verify(verifier, verification.argv, verifySignal),
          verifySignal,
        );
      } catch (error) {
        if (verifySignal.aborted && !signal.aborted) {
          receipt.status = "timed-out";
          throw new Error("verification deadline exceeded", { cause: error });
        }
        throw error;
      }
      if (!(await docker.destroy(verifier))) {
        throw new Error("verifier cleanup_unconfirmed");
      }
      await fs.writeFile(
        path.join(root, "verification.json"),
        JSON.stringify({ argv: verification.argv, ...observed }, null, 2) + "\n",
        { mode: 0o600 },
      );
      receipt.verification = {
        argv: verification.argv,
        code: observed.code,
        artifactDigest: receipt.artifactDigest,
      };
      if (
        nativeManifestDigest(await snapshotNativeTree(receipt.artifactDir)) !==
        receipt.artifactDigest
      ) {
        throw new Error("immutable artifact changed during verification");
      }
      acceptancePassed = observed.code === 0 && receipt.changedPaths.length > 0;
      if (!acceptancePassed) {
        receipt.status = "failed";
      }
      await event("verification/observed", {
        status: acceptancePassed ? "passed" : "failed",
        artifactDigest: receipt.artifactDigest,
      });
    }
  } catch (error) {
    receipt.error = sanitizeCodingHarnessText(String(error)).slice(0, 2_000);
    receipt.status =
      deadline.aborted || receipt.status === "timed-out"
        ? "timed-out"
        : input.signal?.aborted
          ? "cancelled"
          : receipt.status === "preparing"
            ? "blocked"
            : "failed";
  } finally {
    if (binding) {
      revokeNativeCodingBinding(binding);
    }
    const cleanup = await Promise.all(
      receipt.containers.map((c) => docker.destroy(c).catch(() => false)),
    );
    receipt.cleanupConfirmed = cleanup.every(Boolean);
    receipt.sourceUnchanged = source ? await nativeSourceUnchanged(source) : false;
    if (
      receipt.status === "cancelled" ||
      receipt.status === "timed-out" ||
      receipt.status === "failed"
    ) {
      receipt.terminationReason = receipt.status;
    }
    if (!receipt.cleanupConfirmed) {
      receipt.status = "interrupted";
      receipt.error = `${receipt.error ?? ""}; container cleanup_unconfirmed`;
    }
    if (acceptancePassed && signal.aborted) {
      receipt.status = deadline.aborted ? "timed-out" : "cancelled";
      receipt.terminationReason = receipt.status;
    } else if (acceptancePassed && receipt.cleanupConfirmed && receipt.status === "running") {
      receipt.status = receipt.sourceUnchanged ? "verified" : "failed";
      if (!receipt.sourceUnchanged) {
        receipt.error = "source changed while isolated task ran";
      }
    }
    receipt.verified =
      receipt.status === "verified" && receipt.cleanupConfirmed && receipt.sourceUnchanged;
    await event(
      receipt.status === "verified" || receipt.status === "completed-unverified"
        ? "run/completed"
        : receipt.status === "timed-out"
          ? "run/timed-out"
          : "run/failed",
      {
        status: receipt.status,
        verified: receipt.verified,
        cleanupConfirmed: receipt.cleanupConfirmed,
        sourceUnchanged: receipt.sourceUnchanged,
      },
    );
  }
  return receipt;
}
async function prepareArtifactRoot(root?: string): Promise<string> {
  const target = path.resolve(root ?? path.join(STATE_DIR, "coding-harness", "native"));
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  return fs.realpath(target);
}
/** Explicit restart reconciliation only: never replay a model run or claim inferred success. */
export async function reconcileNativeCodingRun(
  receiptPath: string,
  docker: NativeDocker = nativeDocker,
): Promise<NativeCodingReceipt> {
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as NativeCodingReceipt;
  if (receipt.receiptPath !== path.resolve(receiptPath)) {
    throw new Error("receipt location mismatch");
  }
  if (["preparing", "running", "interrupted"].includes(receipt.status)) {
    receipt.cleanupConfirmed = (
      await Promise.all(receipt.containers.map((c) => docker.destroy(c).catch(() => false)))
    ).every(Boolean);
    receipt.terminationReason ??= "interrupted";
    receipt.status = "interrupted";
    receipt.verified = false;
    receipt.sourceUnchanged = false;
    receipt.error = "previous run interrupted; artifacts retained; no automatic replay";
    await saveReceipt(receipt);
  }
  return receipt;
}
