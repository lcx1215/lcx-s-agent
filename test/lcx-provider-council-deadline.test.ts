import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import {
  readCentralGovernanceInput,
  projectGovernanceDigest,
} from "../scripts/operator/lcx-central-agent.js";
import { buildCentralGovernanceInput } from "../src/agents/central-harness/governance-input.js";
import { boundPerception } from "../src/agents/central-harness/harness-loop.js";
import { buildCentralBrainPrompt } from "../src/agents/central-harness/model-brain.js";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunSnapshot,
} from "../src/shared/lcx-run-receipt.js";

const io = vi.hoisted(() => ({
  run: vi.fn(),
  agent: vi.fn(),
  nativeRun: undefined as
    | typeof import("../src/agents/provider-learning-council.js").runExternalLearningCouncil
    | undefined,
}));
vi.mock("../src/config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/config.js")>()),
  loadConfig: () => ({
    agents: { defaults: { models: { "custom-api-deepseek-com/deepseek-v4-flash": {} } } },
  }),
}));
vi.mock("../src/commands/agent.js", () => ({
  agentCommand: (params: unknown) => io.agent(params),
}));
vi.mock("../src/cli/deps.js", () => ({ createDefaultDeps: () => ({}) }));
vi.mock("../src/agents/provider-learning-council.js", async (importOriginal) => {
  const native =
    await importOriginal<typeof import("../src/agents/provider-learning-council.js")>();
  io.nativeRun = native.runExternalLearningCouncil;
  return { ...native, runExternalLearningCouncil: (params: unknown) => io.run(params) };
});
import {
  ProviderCouncilDeadlineError,
  runCouncilWithTimeout,
} from "../scripts/operator/lcx-provider-council-acceleration.js";

async function originalGovernanceReadback(error: unknown, workspace: string) {
  const repo = path.resolve(import.meta.dirname, "..");
  const producerSource = await fs.readFile(
    path.join(repo, "scripts/operator/lcx-provider-council-acceleration.ts"),
    "utf8",
  );
  const producerAst = ts.createSourceFile("owner.ts", producerSource, ts.ScriptTarget.Latest, true);
  const catches: ts.CatchClause[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCatchClause(node) &&
      node.block.getText(producerAst).includes("providerRunCleanup =")
    ) {
      catches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(producerAst);
  expect(catches).toHaveLength(1);
  const governorSource = await fs.readFile(
    path.join(repo, "scripts/operator/lcx-governance-autopilot.ts"),
    "utf8",
  );
  const governorAst = ts.createSourceFile(
    "governor.ts",
    governorSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const selected = governorAst.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        ["compactOwner", "recordValue"].includes(node.name?.text ?? ""),
    )
    .map((node) => node.getText(governorAst))
    .join("\n");
  const original = `function originalFailurePayload(error) { let providerRunError,providerRunCleanup,providerRunTimedOut,forceExitAfterOutput,action,status,ok; ${catches[0].block.getText(producerAst)} return { providerRunError,providerRunCleanup,providerRunTimedOut,forceExitAfterOutput,action,status,ok }; } ${selected}`;
  const context = vm.createContext({ Error, Buffer, ProviderCouncilDeadlineError, error });
  vm.runInContext(
    ts.transpileModule(original, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText,
    context,
  );
  const payload = vm.runInContext("originalFailurePayload(error)", context) as Record<
    string,
    unknown
  >;
  context.payload = payload;
  const compact = JSON.parse(
    JSON.stringify(vm.runInContext('compactOwner("providerCouncilAcceleration",payload)', context)),
  ) as Record<string, unknown>;
  const now = new Date().toISOString();
  const snapshot = createLcxRunSnapshot({
    observedAt: now,
    sourceCommit: "offline-council-cleanup",
    sourceBranch: "test",
    authorityOwner: "lcx-governance-autopilot",
  });
  const runReceipt = buildLcxRunReceipt({
    runId: "offline-council-owner",
    parentRunId: "offline-council-parent",
    owner: "providerCouncilAcceleration",
    phase: "observe",
    status: "failed",
    checkedAt: now,
    snapshot,
    boundary: boundaryFromFlags({ scope: "offline" }),
    evidence: [],
    nextAction: "retain_original_failure",
  });
  const input = buildCentralGovernanceInput(
    [{ id: "providerCouncilAcceleration", ok: false, compact, runReceipt }],
    { parentRunId: "offline-council-parent", snapshot },
  );
  const file = path.join(workspace, "same-cycle-governance-input.json");
  await fs.writeFile(file, JSON.stringify(input));
  const read = await readCentralGovernanceInput(file);
  const digest = projectGovernanceDigest(read);
  const bounded = boundPerception({
    observedAt: now,
    ownerTotals: {},
    backlog: [],
    boundaries: [],
    controlRoom: { governanceDigest: digest },
  });
  const prompt = buildCentralBrainPrompt(bounded.perception);
  expect(compact.providerRunFailureCode).toBe("provider_council_timeout");
  expect(JSON.stringify(compact)).not.toContain("provider council timeout after");
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(12000);
  expect(Buffer.byteLength(JSON.stringify(digest))).toBeLessThanOrEqual(2048);
  return {
    payload,
    compact,
    read,
    digest,
    bounded,
    prompt,
    sourcePins: {
      producer: createHash("sha256").update(producerSource).digest("hex"),
      governor: createHash("sha256").update(governorSource).digest("hex"),
    },
  };
}

const options: Parameters<typeof runCouncilWithTimeout>[1] = {
  json: true,
  write: false,
  workspaceDir: "/offline-unused",
  routeAgentId: "main",
  profile: "balanced",
  maxFreshMinutes: 120,
  timeoutMs: 10,
};
afterEach(() => {
  vi.useRealTimers();
  io.run.mockReset();
  io.agent.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("returns an on-time original response without cancelling it", async () => {
  let signal: AbortSignal | undefined;
  io.run.mockImplementation(async (params: { abortSignal: AbortSignal }) => {
    signal = params.abortSignal;
    return "on-time result";
  });
  const result = await runCouncilWithTimeout("offline", options, true);
  expect(result.text).toBe("on-time result");
  expect(signal?.aborted).toBe(false);
});

it("requests cancellation and retains timeout when the original local operation settles", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  io.run.mockImplementation((params: { abortSignal: AbortSignal }) => {
    signal = params.abortSignal;
    return new Promise((_, reject) => {
      params.abortSignal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      });
    });
  });
  const result = runCouncilWithTimeout("offline", options, true).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10);
  expect(signal?.aborted).toBe(true);
  expect(await result).toMatchObject({
    message: "provider council timeout after 10ms",
    cancellationRequested: true,
    cleanupStatus: "local_operation_settled",
  });
});

it("reports unconfirmed cleanup after a bounded wait and does not adopt a later success", async () => {
  vi.useFakeTimers();
  let release!: (text: string) => void;
  io.run.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const result = runCouncilWithTimeout("offline", options, true).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1010);
  const verdict = await result;
  expect(verdict).toMatchObject({
    message: "provider council timeout after 10ms",
    cleanupStatus: "cleanup_unconfirmed",
    cleanupScope: "local_council_operation_only_remote_execution_not_confirmed",
  });
  release("late success");
  await vi.advanceTimersByTimeAsync(0);
  expect(await result).toBe(verdict);
});

it("retains timeout when success arrives during the local settlement window", async () => {
  vi.useFakeTimers();
  io.run.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("late success"), 20);
      }),
  );
  const result = runCouncilWithTimeout("offline", options, true).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(20);
  expect(await result).toMatchObject({
    message: "provider council timeout after 10ms",
    cleanupStatus: "local_operation_settled",
  });
});

it("propagates the real operator deadline through the original council to its original in-process role and seals a late result", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "council-native-deadline-"));
  const observed: { receivedSignal: boolean; cancelled: boolean; calls: number } = {
    receivedSignal: false,
    cancelled: false,
    calls: 0,
  };
  vi.stubEnv("LCX_LEARNING_COUNCIL_TRANSPORT", "in-process");
  vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "");
  vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL", "");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline provider forbidden"));
  if (!io.nativeRun) {
    throw new Error("original council export missing");
  }
  io.run.mockImplementation(io.nativeRun);
  io.agent.mockImplementation((params: { abortSignal?: AbortSignal }) => {
    observed.calls++;
    observed.receivedSignal = params.abortSignal instanceof AbortSignal;
    return new Promise((resolve) => {
      params.abortSignal?.addEventListener(
        "abort",
        () => {
          observed.cancelled = true;
          setTimeout(
            () =>
              resolve({
                payloads: [{ text: "late source result" }],
                meta: {
                  agentMeta: { provider: "custom-api-deepseek-com", model: "deepseek-v4-flash" },
                },
              }),
            5,
          );
        },
        { once: true },
      );
    });
  });
  try {
    const result = await runCouncilWithTimeout(
      "offline source cancellation",
      { ...options, timeoutMs: 100, workspaceDir: workspace },
      true,
    ).catch((error: unknown) => error);
    expect(result).toMatchObject({
      message: "provider council timeout after 100ms",
      cleanupStatus: "local_operation_settled",
    });
    expect(observed).toEqual({ receivedSignal: true, cancelled: true, calls: 1 });
    const governance = await originalGovernanceReadback(result, workspace);
    expect(governance.digest.providerCouncilRun).toMatchObject({
      cleanupStatus: "local_operation_settled",
      remoteCancellation: "not_confirmed",
      actionAuthority: "diagnostic_only",
    });
    expect(governance.prompt).toContain("local_operation_settled");
    if (process.env.LCX_COUNCIL_DEADLINE_PROOF_DIR) {
      await fs.writeFile(
        path.join(process.env.LCX_COUNCIL_DEADLINE_PROOF_DIR, "original-governance-settled.json"),
        JSON.stringify(governance, null, 2) + "\n",
      );
    }
    const files = await fs
      .readdir(path.join(workspace, "bank", "knowledge", "learning-councils"))
      .catch(() => [] as string[]);
    expect(files).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    if (process.env.LCX_COUNCIL_DEADLINE_PROOF_DIR) {
      await fs.writeFile(
        path.join(process.env.LCX_COUNCIL_DEADLINE_PROOF_DIR, "original-native-deadline.json"),
        JSON.stringify(
          {
            observed,
            failure: {
              message: (result as Error).message,
              cleanupStatus: (result as { cleanupStatus: string }).cleanupStatus,
            },
            artifactFiles: files,
            providerCalls: 0,
            networkCalls: 0,
            scope:
              "original operator -> original council -> original agent command with local model response substitute",
          },
          null,
          2,
        ) + "\n",
      );
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

it("does not confirm cleanup while a second original role is still pending", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "council-sibling-deadline-"));
  let release!: (value: unknown) => void;
  vi.stubEnv("LCX_LEARNING_COUNCIL_TRANSPORT", "in-process");
  vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "moonshot/kimi-k2.6");
  vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL", "");
  if (!io.nativeRun) {
    throw new Error("original council export missing");
  }
  io.run.mockImplementation(io.nativeRun);
  io.agent.mockImplementation(
    (params: { model: string; abortSignal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        if (params.model.startsWith("moonshot/")) {
          params.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("synthesis cancelled")),
            { once: true },
          );
        } else {
          release = resolve;
        }
      }),
  );
  try {
    const verdict = await runCouncilWithTimeout(
      "offline parallel cancellation",
      { ...options, timeoutMs: 100, workspaceDir: workspace },
      true,
    ).catch((error: unknown) => error);
    expect(io.agent).toHaveBeenCalledTimes(2);
    expect(verdict).toMatchObject({ cleanupStatus: "cleanup_unconfirmed" });
    const governance = await originalGovernanceReadback(verdict, workspace);
    expect(governance.digest.providerCouncilRun).toMatchObject({
      timedOut: true,
      failureCode: "provider_council_timeout",
      cleanupStatus: "cleanup_unconfirmed",
      cancellationRequested: true,
      remoteCancellation: "not_confirmed",
    });
    expect(governance.prompt).toContain("cleanup_unconfirmed");
    if (process.env.LCX_COUNCIL_DEADLINE_PROOF_DIR) {
      await fs.writeFile(
        path.join(
          process.env.LCX_COUNCIL_DEADLINE_PROOF_DIR,
          "original-governance-unconfirmed.json",
        ),
        JSON.stringify(governance, null, 2) + "\n",
      );
    }
    release({
      payloads: [{ text: "late extraction" }],
      meta: { agentMeta: { provider: "custom-api-deepseek-com", model: "deepseek-v4-flash" } },
    });
    const originalOperation = io.run.mock.results[0]?.value as Promise<string>;
    await expect(originalOperation).rejects.toThrow("learning_council_cancelled");
    const files = await fs
      .readdir(path.join(workspace, "bank", "knowledge", "learning-councils"))
      .catch(() => [] as string[]);
    expect(files).toEqual([]);
    if (process.env.LCX_COUNCIL_DEADLINE_PROOF_DIR) {
      await fs.writeFile(
        path.join(
          process.env.LCX_COUNCIL_DEADLINE_PROOF_DIR,
          "original-native-sibling-unconfirmed.json",
        ),
        JSON.stringify(
          {
            roleCalls: io.agent.mock.calls.length,
            cleanupStatus: (verdict as { cleanupStatus: string }).cleanupStatus,
            lateOperationStatus: "cancelled",
            artifactFiles: files,
            providerCalls: 0,
          },
          null,
          2,
        ) + "\n",
      );
    }
  } finally {
    if (release) {
      release(undefined);
    }
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

it("keeps a foreign cleanup claim unconfirmed through the original failure and governance readers", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "council-foreign-cleanup-"));
  try {
    const error = new ProviderCouncilDeadlineError(100, "local_operation_settled");
    Object.defineProperty(error, "cleanupScope", { value: "foreign_remote_execution" });
    const readback = await originalGovernanceReadback(error, workspace);
    expect(readback.compact.providerRunCleanup).toMatchObject({
      status: "cleanup_unconfirmed",
      reason: "provider_cleanup_receipt_invalid",
    });
    expect(readback.digest.providerCouncilRun).toMatchObject({
      cleanupStatus: "cleanup_unconfirmed",
      remoteCancellation: "not_confirmed",
    });
    expect(readback.prompt).toContain("cleanup_unconfirmed");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
