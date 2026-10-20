import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeDirectedDailyResearchBatch,
  executeDirectedDailyResearchTask,
  buildDirectedTaskAsk,
  readDirectedDailyCases,
  readDirectedLearningUsageReceipt,
  readDirectedDailyAdmission,
  reviewDirectedDailyCases,
  writeBrief,
} from "../scripts/operator/lcx-directed-daily-research-brief.js";
import { buildFinanceCaseRun, saveFinanceCaseRun } from "../src/agents/finance-caseflow.js";
import type { LogicalAgentModelAdapter } from "../src/agents/logical-agent-model-router.js";
import type { QualityHarnessModelRequest } from "../src/agents/quality-harness-contract.js";
import { createFinanceLearningCapabilityApplyTool } from "../src/agents/tools/finance-learning-capability-apply-tool.js";
import { prepareNativeDirectedTask } from "./fixtures/lcx-waterflow-directed-brief-probe.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runBrief(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-directed-daily-research-brief.ts", ...args, "--json"],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("lcx-directed-daily-research-brief", () => {
  it("defines a focused daily research product instead of relying on open-ended Q&A", async () => {
    const payload = await runBrief(["--date", "2026-06-01"]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_directed_daily_research_brief_only",
        productMode: "focused_daily_research_product_not_open_ended_chat",
        executionStatus: "planning_contract_only",
        researchPacketStatus: "not_produced",
        date: "2026-06-01",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.focus).toEqual(
      expect.objectContaining({
        primary: "index_options_and_semiconductor_ai_compute_chain",
        cadence: "daily_low_frequency_research",
      }),
    );
    expect(payload.universe).toEqual(
      expect.objectContaining({
        indexOptions: expect.arrayContaining(["SPX", "NDX", "QQQ", "VIX"]),
        semiconductorAiCompute: expect.arrayContaining(["NVDA", "AMD", "AVGO", "TSM", "ASML"]),
      }),
    );
    expect(payload.outputContract).toEqual(
      expect.objectContaining({
        requiredEvidence: expect.arrayContaining([
          "source_timestamp",
          "field_definition",
          "provider_role",
          "conflict_or_missing_data_status",
        ]),
        forbiddenVisibleOutputs: expect.arrayContaining([
          "buy_sell_add_reduce_instruction",
          "position_percentage",
          "options_bet_instruction",
        ]),
      }),
    );
    expect(payload.learningContract).toEqual(
      expect.objectContaining({
        sourceNameAndPathRequired: true,
        terminalDecision: "application_ready_or_failedReason",
      }),
    );
    expect(String(payload.visibleBrief)).toContain("指数期权");
    expect(String(payload.visibleBrief)).toContain("半导体/AI 算力链");
    expect(String(payload.visibleBrief)).toContain("research-only");
    expect(payload.missingForPacket).toHaveLength(3);
  });

  it("writes latest owner-visible state when explicitly requested", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-daily-"));
    const payload = await runBrief(["--write", "--date", "2026-06-01"], {
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    const written = payload.written as Record<string, string>;
    const actualWorkspaceDir = await fs.realpath(workspaceDir);
    expect(written.latestJsonPath).toBe(
      path.join(actualWorkspaceDir, "state", "lcx-directed-daily-research-brief-latest.json"),
    );
    expect(written.latestMarkdownPath).toBe(
      path.join(actualWorkspaceDir, "state", "lcx-directed-daily-research-brief-latest.md"),
    );
    await expect(fs.readFile(written.latestMarkdownPath, "utf8")).resolves.toContain(
      "每天固定产出",
    );
    await expect(fs.readFile(written.latestJsonPath, "utf8")).resolves.toContain(
      "focused_daily_research_product_not_open_ended_chat",
    );
  });
});

describe("original directed learning usage readback", () => {
  async function produce(workspace: string) {
    const queryText = `Finance module finance_learning_memory. Apply retained guidance to this bounded research question: ${buildDirectedTaskAsk("risk_gate_and_learning_loop")}. Use only supplied fresh evidence and state missing inputs; research-only.`;
    const toolCallId = `private-directed-learning-component:${Date.now()}`;
    const input = { queryText, maxCandidates: 3, writeUsageReceipt: true };
    const output = await createFinanceLearningCapabilityApplyTool({
      workspaceDir: workspace,
    }).execute(toolCallId, input);
    const details = output.details as {
      ok: boolean;
      failedReason: string;
      usageReceiptSource: { path: string; sha256: string; bytes: number };
    };
    const source = details.usageReceiptSource;
    const body = await fs.readFile(path.join(workspace, source.path));
    return { queryText, toolCallId, input, output, details, source, body };
  }
  async function withProducer(
    run: (workspace: string, native: Awaited<ReturnType<typeof produce>>) => Promise<void>,
  ) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-learning-usage-"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
    try {
      await run(workspace, await produce(workspace));
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
  it("reads the real apply writer refusal without attributing a new usage file to an old research run", async () => {
    await withProducer(async (workspace, native) => {
      expect(native.details.failedReason).toBe("finance_learning_capability_candidates_missing");
      expect(native.source.sha256).toBe(createHash("sha256").update(native.body).digest("hex"));
      expect(native.source.bytes).toBe(native.body.length);
      const read = await readDirectedLearningUsageReceipt({
        workspaceDir: workspace,
        queryText: native.queryText,
        toolCallId: native.toolCallId,
        toolResult: native.details,
      });
      expect(read).toMatchObject({
        status: "not_observed",
        sourceReadStatus: "verified",
        observedToolDecision: "refused",
        failureReason: "finance_learning_capability_candidates_missing",
        candidateCount: 0,
        source: native.source,
      });
      expect(read.gaps).toContain("learning_application_host_not_observed");
      expect(read.gaps).toContain("adjacent_task_application_not_observed");
      // Retained research remains byte-identical; this new local producer is a separate invocation.
      const retained = process.env.LCX_DIRECTED_LEARNING_NATIVE_DIR;
      let legacy: Awaited<ReturnType<typeof readDirectedDailyCases>> | undefined;
      if (retained) {
        const retainedResult = JSON.parse(
          await fs.readFile(path.join(retained, "native-result.json"), "utf8"),
        ) as {
          result: {
            date: string;
            bindingsFile: string;
            batchExecution: {
              host: {
                accountId: string;
                runId: string;
                maxApiCalls: number;
                maxModelCalls: number;
              };
            };
          };
        };
        legacy = await readDirectedDailyCases({
          date: retainedResult.result.date,
          bindingsFile: retainedResult.result.bindingsFile,
          workspaceDir: path.join(retained, "private-bytes"),
          batchHost: retainedResult.result.batchExecution.host,
        });
        const fourth = legacy.packetCandidateSections.find(
          (section) => section.taskId === "risk_gate_and_learning_loop",
        );
        expect(fourth?.learningApplication).toMatchObject({
          status: "not_observed",
          sourceReadStatus: "not_observed",
        });
        expect(fourth?.gaps).toContain("learning_application_receipt_pin_not_observed");
        expect(fourth?.status).toBe("held");
      }
      await saveBatchProof("learning-usage-native-refusal", workspace, {
        invocation: { toolCallId: native.toolCallId, input: native.input },
        producer: native.output,
        read,
        legacy,
        limits:
          "Direct original apply producer and daily reader component; no new research or Quality invocation, no task/application attribution or semantic learning claim.",
      });
    });
  });
  it("rejects changed and missing bytes from the actual apply writer", async () => {
    await withProducer(async (workspace, native) => {
      const input = {
        workspaceDir: workspace,
        queryText: native.queryText,
        toolCallId: native.toolCallId,
        toolResult: native.details,
      };
      const file = path.join(workspace, native.source.path);
      await fs.appendFile(file, " ");
      const changed = await readDirectedLearningUsageReceipt(input);
      expect(changed.status).toBe("failed");
      expect(changed.gaps).toContain("learning_application_receipt_hash_conflict");
      await fs.unlink(file);
      const missing = await readDirectedLearningUsageReceipt(input);
      expect(missing.status).toBe("failed");
      expect(missing.gaps).toContain("learning_application_receipt_unreadable_or_invalid");
      await saveBatchProof("learning-usage-byte-failures", workspace, {
        producer: native.output,
        changed,
        missing,
      });
    });
  });
  it("rejects external references and aliases instead of reading their body", async () => {
    await withProducer(async (workspace, native) => {
      const input = {
        workspaceDir: workspace,
        queryText: native.queryText,
        toolCallId: native.toolCallId,
      };
      const outside = await readDirectedLearningUsageReceipt({
        ...input,
        toolResult: {
          ...native.details,
          usageReceiptSource: { ...native.source, path: "../outside.json" },
        },
      });
      expect(outside.status).toBe("failed");
      expect(outside.gaps).toContain("learning_application_receipt_reference_conflict");
      const actual = path.join(workspace, native.source.path);
      const aliasTarget = path.join(workspace, "private-alias-body.json");
      await fs.rename(actual, aliasTarget);
      await fs.symlink(aliasTarget, actual);
      const alias = await readDirectedLearningUsageReceipt({
        ...input,
        toolResult: native.details,
      });
      expect(alias.status).toBe("failed");
      expect(alias.gaps).toContain("learning_application_receipt_alias");
      expect(await fs.readFile(aliasTarget)).toEqual(native.body);
      await saveBatchProof("learning-usage-path-failures", workspace, {
        producer: native.output,
        outside,
        alias,
      });
    });
  });
  it("refuses foreign observation scope and a newer usage file attached to an older recorded run", async () => {
    await withProducer(async (workspace, native) => {
      const input = {
        workspaceDir: workspace,
        queryText: native.queryText,
        toolCallId: native.toolCallId,
        toolResult: native.details,
      };
      const foreign = await readDirectedLearningUsageReceipt({
        ...input,
        execution: {
          accountId: "private-source-account",
          runId: native.toolCallId,
          taskId: "risk_gate_and_learning_loop",
        },
        host: { accountId: "private-other-account", runId: native.toolCallId },
      });
      expect(foreign.status).toBe("failed");
      expect(foreign.gaps).toContain("learning_application_host_scope_conflict");
      const old = await readDirectedLearningUsageReceipt({
        ...input,
        recordedAt: "2000-01-01T00:00:00.000Z",
      });
      expect(old.status).toBe("failed");
      expect(old.gaps).toContain("learning_application_receipt_caller_or_time_conflict");
      await saveBatchProof("learning-usage-attribution-failures", workspace, {
        producer: native.output,
        foreign,
        old,
      });
    });
  });
});

const batchTaskIds = [
  "index_options_regime",
  "semiconductor_leader_board",
  "timely_stock_candidates",
  "risk_gate_and_learning_loop",
];
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
async function prepareBatch(
  workspace: string,
  maxApiCalls = 64,
  maxModelCalls = 48,
  fault?: Parameters<typeof prepareNativeDirectedTask>[1],
) {
  const native = await prepareNativeDirectedTask(workspace, fault);
  const host = { ...native.host, maxApiCalls, maxModelCalls };
  const hostBody = JSON.stringify(host) + "\n";
  await fs.writeFile(native.hostPath, hostBody);
  const targets = native.request.targets;
  if (!targets) {
    throw new Error("native batch fixture requires declared targets");
  }
  const tasks = [];
  for (const taskId of batchTaskIds) {
    const request = {
      ...native.request,
      ...host,
      taskId,
      caseId: `native-${taskId}`,
      targets:
        taskId === "semiconductor_leader_board"
          ? targets.map((target) => ({
              ...target,
              id: "private-NVDA",
              instrument: "NVDA",
            }))
          : targets,
    };
    const body = JSON.stringify(request) + "\n";
    const file = `${taskId}-request.json`;
    await fs.writeFile(path.join(workspace, file), body);
    tasks.push({ taskId, request: { path: file, sha256: hash(body) } });
  }
  const manifest = {
    schemaVersion: "lcx_directed_daily_batch_request_v1",
    ...host,
    date: native.request.date,
    asOf: native.request.asOf,
    tasks,
  };
  const body = JSON.stringify(manifest) + "\n";
  const requestPath = path.join(workspace, "batch-request.json");
  await fs.writeFile(requestPath, body);
  const options = {
    date: native.request.date,
    workspaceDir: workspace,
    requestPath,
    requestSha256: hash(body),
    hostPath: native.hostPath,
    hostSha256: hash(hostBody),
    researchOptions: {
      ...native.nativeOptions.researchOptions,
      qualityModelRouting: {
        ...native.nativeOptions.researchOptions.qualityModelRouting,
        adapters: native.nativeOptions.researchOptions.qualityModelRouting.adapters.map(
          (adapter) => ({
            ...adapter,
            invoke: async (
              call: Parameters<LogicalAgentModelAdapter["invoke"]>[0],
              signal: Parameters<LogicalAgentModelAdapter["invoke"]>[1],
            ) => {
              const response = await adapter.invoke(call, signal);
              const payload = call.payload as {
                task?: string;
                evidence?: readonly { id: string }[];
              };
              if (
                !payload.task?.includes("supportingAnalysis.directedWatchlist") ||
                typeof response !== "object" ||
                response === null ||
                !("artifact" in response) ||
                typeof response.artifact !== "object" ||
                response.artifact === null
              ) {
                return response;
              }
              const id = payload.evidence?.[0]?.id;
              if (!id) {
                throw new Error("batch_watchlist_actual_evidence_missing");
              }
              const previous =
                "supportingAnalysis" in response.artifact &&
                typeof response.artifact.supportingAnalysis === "object" &&
                response.artifact.supportingAnalysis !== null
                  ? response.artifact.supportingAnalysis
                  : {};
              return {
                ...response,
                artifact: {
                  ...response.artifact,
                  supportingAnalysis: {
                    ...previous,
                    directedWatchlist: {
                      coreTracking: [],
                      needsData: [
                        {
                          instrument: "SPY",
                          reason: "Observe actual supplied source; further data remains missing.",
                          evidenceIds: [id],
                          counterEvidenceIds: [],
                          counterEvidenceGap:
                            "No independent contrary source supplied; needs review.",
                          invalidation:
                            "Independent contradictory source invalidates this observation.",
                        },
                      ],
                      downrankObservation: [],
                      discarded: [],
                    },
                  },
                },
              };
            },
          }),
        ),
      },
    },
    controllerEvidence: native.nativeOptions.controllerEvidence,
    timeoutMs: 10_000,
  };
  return { native, host, manifest, options };
}

it("holds the original third task before Caseflow persistence when generic Quality omits the watchlist", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-watchlist-task-"));
  try {
    const native = await prepareNativeDirectedTask(workspace);
    const request = { ...native.request, taskId: "timely_stock_candidates" };
    const bytes = JSON.stringify(request) + "\n";
    await fs.writeFile(native.requestPath, bytes);
    const result = await executeDirectedDailyResearchTask({
      ...native.nativeOptions,
      taskId: request.taskId,
      requestSha256: hash(bytes),
      timeoutMs: 10_000,
    });
    expect(result.taskExecution).toMatchObject({
      status: "held",
      gaps: ["daily_task_watchlist_missing"],
    });
    expect(result.taskExecution.researchReceipt?.status).toBe("candidate");
    expect(result.taskExecution.savedCase).toBeUndefined();
    const attempts = await fs.readdir(path.join(workspace, "state/directed-daily-research-runs"));
    for (const attempt of attempts) {
      expect(
        await fs.readdir(
          path.join(workspace, "state/directed-daily-research-runs", attempt, "cases"),
        ),
      ).toEqual(["scope.json"]);
    }
    expect(result.packetCandidateSections.every((section) => section.status === "held")).toBe(true);
    await saveBatchProof("native-third-task-missing-watchlist-held", workspace, result);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

it("preserves other original batch tasks while holding a third generic output without saving its case", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-watchlist-batch-"));
  try {
    const prepared = await prepareBatch(workspace, 64, 192);
    const result = await executeDirectedDailyResearchBatch({
      ...prepared.options,
      researchOptions: prepared.native.nativeOptions.researchOptions,
    });
    const third = result.batchExecution.tasks.find(
      (task) => task.taskId === "timely_stock_candidates",
    );
    expect(third).toMatchObject({
      status: "failed",
      gaps: ["daily_task_watchlist_missing"],
      taskExecution: { status: "held", researchReceipt: { status: "candidate" } },
    });
    const ready = result.packetCandidateSections
      .filter((section) => section.status === "read_ready")
      .map((section) => section.taskId);
    expect(ready).toEqual(["index_options_regime", "semiconductor_leader_board"]);
    await saveBatchProof("native-batch-third-watchlist-held", workspace, result);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

it("keeps a healthy private 35ms source eligible while the explicit timeout fault remains held", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-source-budget-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
  try {
    const native = await prepareNativeDirectedTask(workspace);
    const batch = native.nativeOptions.researchOptions.batchOptions;
    const result = await executeDirectedDailyResearchTask({
      ...native.nativeOptions,
      timeoutMs: 10_000,
      researchOptions: {
        ...native.nativeOptions.researchOptions,
        batchOptions: {
          ...batch,
          realtimeAdapters: batch.realtimeAdapters.map((adapter) => ({
            ...adapter,
            collect: async (...args: Parameters<typeof adapter.collect>) => {
              await new Promise((resolve) => setTimeout(resolve, 35));
              args[1].throwIfAborted();
              return await adapter.collect(...args);
            },
          })),
        },
      },
    });
    expect(
      result.taskExecution.status,
      JSON.stringify("gaps" in result.taskExecution ? result.taskExecution.gaps : []),
    ).toBe("executed");
    expect(result.caseBindingsSource).toBeDefined();
    const faultRoot = path.join(workspace, "timeout-fault");
    await fs.mkdir(faultRoot);
    const fault = await prepareNativeDirectedTask(faultRoot, "source_timeout");
    const held = await executeDirectedDailyResearchTask({
      ...fault.nativeOptions,
      timeoutMs: 10_000,
    });
    expect(held.taskExecution.status).toBe("failed");
    expect(held.packetCandidateSections.every((section) => section.status === "held")).toBe(true);
    expect(held.caseBindingsSource).toBeUndefined();
    expect(fault.nativeOptions.researchOptions.batchOptions.sourceTimeoutMs).toBe(20);
    expect(fault.prepared.sourceCalls.some((call) => call.aborted)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

const priorReviewGap =
  "directed_review_gap: current IV/skew evidence remains missing; retain needs-data stance";

async function preparePublishedDirectedReview(
  workspace: string,
  batch = false,
  missingWatchlist = false,
  firstRunAdmission = false,
) {
  const prepared = await prepareBatch(workspace, 64, batch ? 192 : 48);
  const native = prepared.native;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.parse(native.request.asOf) + 1000));
  const executionStartedAt = performance.now();
  const execution = batch
    ? await executeDirectedDailyResearchBatch({
        ...prepared.options,
        ...(firstRunAdmission
          ? {
              admission: {
                firstRun: true,
                host: {
                  accountId: prepared.host.accountId,
                  runId: prepared.host.runId,
                  date: native.request.date,
                  nowMs: Date.parse(`${native.request.date}T12:00:00.000Z`),
                },
              },
            }
          : {}),
        ...(missingWatchlist ? { researchOptions: native.nativeOptions.researchOptions } : {}),
      })
    : await executeDirectedDailyResearchTask({ ...native.nativeOptions, timeoutMs: 10_000 });
  if (!execution.caseBindingsSource) {
    await saveBatchProof("whole-admission-execution-held", workspace, execution);
    throw new Error(
      "native_execution_binding_not_produced:" +
        JSON.stringify({
          elapsedMs: Math.round(performance.now() - executionStartedAt),
          batch,
          batchExecution:
            "batchExecution" in execution && execution.batchExecution
              ? {
                  status: execution.batchExecution.status,
                  tasks: execution.batchExecution.tasks.map((task) => ({
                    taskId: task.taskId,
                    status: task.status,
                    gaps: task.gaps,
                  })),
                }
              : undefined,
          taskExecution:
            "taskExecution" in execution
              ? {
                  status: execution.taskExecution.status,
                  gaps: "gaps" in execution.taskExecution ? execution.taskExecution.gaps : [],
                }
              : undefined,
          sourceBudget: {
            sourceTimeoutMs:
              "sourceTimeoutMs" in native.nativeOptions.researchOptions.batchOptions
                ? native.nativeOptions.researchOptions.batchOptions.sourceTimeoutMs
                : "original_owner_default",
            totalTimeoutMs: native.nativeOptions.researchOptions.batchOptions.totalTimeoutMs,
          },
        }).slice(0, 8_000),
    );
  }
  const nativeWrite = await writeBrief(execution, { workspaceDir: workspace });
  const archiveBefore = await fs.readFile(nativeWrite.jsonPath);
  const actualReviewRequests: QualityHarnessModelRequest[] = [];
  const review = await reviewDirectedDailyCases({
    workspaceDir: workspace,
    date: native.request.date,
    bindingsFile: execution.caseBindingsSource.sourceRef,
    batchHost: prepared.host,
    timeoutMs: 5000,
    qualityOptions: {
      taskTimeoutMs: 1000,
      modelInvoker: async (input) => {
        const request = input as QualityHarnessModelRequest;
        actualReviewRequests.push(structuredClone(request));
        if (request.stage === "intake") {
          return {
            kind: "plan",
            requirements: ["Review original source-bound daily task"],
            missingEvidence: [],
          };
        }
        if (request.stage === "draft" || request.stage === "format") {
          const id = request.evidence.find(
            (item) => !item.id.endsWith(":directed-candidate-body"),
          )?.id;
          if (!id) {
            throw new Error("review_actual_source_not_supplied");
          }
          return {
            kind: "artifact",
            artifact: {
              answer:
                "The supplied candidate remains conditional; current IV/skew coverage is missing.",
              claims: [
                {
                  id: "prior-gap",
                  text: "The supplied source coverage requires further review.",
                  status: "supported",
                  evidenceIds: [id],
                  epistemicClass: "inference",
                  basis: "Actual supplied original evidence and its limits.",
                  evidenceRelations: [{ evidenceId: id, relation: "supports" }],
                },
              ],
            },
          };
        }
        return {
          kind: "review",
          review: {
            verdict: "reject",
            criticalFindings: [priorReviewGap],
            evidenceGaps: [],
            notes: request.evidence.map(
              (item) => `[${item.id}] actually supplied to this offline review.`,
            ),
          },
        };
      },
    },
  });
  const reviewWrite = await writeBrief(review, { workspaceDir: workspace });
  return {
    prepared,
    native,
    execution,
    nativeWrite,
    archiveBefore,
    review,
    reviewWrite,
    actualReviewRequests,
  };
}

async function prepareNextDirectedInvocation(
  published: Awaited<ReturnType<typeof preparePublishedDirectedReview>>,
  workspace: string,
  fault?: "account" | "future" | "targets" | "horizon",
  taskId = "index_options_regime",
) {
  const actualNextRequests: QualityHarnessModelRequest[] = [];
  const actualNextReplies: unknown[] = [];
  const host = {
    ...published.native.host,
    runId: "private-next-directed-attempt",
    ...(fault === "account" ? { accountId: "private-other-account" } : {}),
  };
  const request = {
    ...published.native.request,
    ...host,
    caseId: "native-next-directed-task",
    taskId,
    asOf: new Date(
      Date.parse(published.native.request.asOf) + (fault === "future" ? 500 : 2000),
    ).toISOString(),
    ...(fault === "horizon" ? { horizonMonths: 6 } : {}),
    ...(fault === "targets"
      ? {
          targets: published.native.request.targets?.map((target) => ({
            ...target,
            instrument: "QQQ",
          })),
        }
      : {}),
  };
  const bytes = JSON.stringify(request) + "\n";
  const requestPath = path.join(workspace, "next-task-request.json");
  await fs.writeFile(requestPath, bytes);
  const original = published.native.nativeOptions.researchOptions;
  const originalInvoker = original.modelInvoker;
  const useFeedback = (payload: QualityHarnessModelRequest, response: unknown) => {
    const diagnostic = payload.evidence.find(
      (item) => item.source === "directed-daily-review-diagnostic",
    );
    if (
      diagnostic &&
      response &&
      typeof response === "object" &&
      "artifact" in response &&
      response.artifact &&
      typeof response.artifact === "object" &&
      "answer" in response.artifact
    ) {
      const previous =
        "supportingAnalysis" in response.artifact &&
        response.artifact.supportingAnalysis &&
        typeof response.artifact.supportingAnalysis === "object"
          ? response.artifact.supportingAnalysis
          : {};
      const id = payload.evidence[0]?.id;
      const repairWatchlist =
        taskId === "timely_stock_candidates" &&
        diagnostic.text.includes("daily_task_watchlist_missing");
      const learningRefusal = payload.evidence.find(
        (item) =>
          item.id.endsWith(":diagnostic") &&
          item.source === "finance-module-execution" &&
          item.text.includes("module_refusal_diagnostic_not_market_evidence"),
      );
      if (repairWatchlist && !id) {
        throw new Error("next_watchlist_original_evidence_missing");
      }
      const output = {
        ...response,
        artifact: {
          ...response.artifact,
          answer: `${String(response.artifact.answer)} Historical review's current IV/skew gap remains unresolved; retain needs-data stance instead of upgrading the conclusion.${learningRefusal ? " Original learning tool refused with finance_learning_capability_candidates_missing; do not claim retained guidance was adopted." : ""}`,
          ...(repairWatchlist
            ? {
                supportingAnalysis: {
                  ...previous,
                  directedWatchlist: {
                    coreTracking: [],
                    needsData: [
                      {
                        instrument: "SPY",
                        reason:
                          "Original failed task omitted four-tier structure; retain this observation as needs-data.",
                        evidenceIds: [id ?? "unresolved"],
                        counterEvidenceIds: [],
                        counterEvidenceGap:
                          "Independent counterevidence is not supplied; requires review.",
                        invalidation:
                          "Independent contradictory source invalidates the observation.",
                      },
                    ],
                    downrankObservation: [],
                    discarded: [],
                  },
                },
              }
            : {}),
        },
      };
      actualNextReplies.push({ diagnosticActuallyReceived: diagnostic, output });
      return output;
    }
    return response;
  };
  const options = {
    ...published.native.nativeOptions,
    taskId,
    host,
    requestPath,
    requestSha256: hash(bytes),
    timeoutMs: 10_000,
    researchOptions: {
      ...original,
      modelInvoker: async (input: unknown, signal: AbortSignal) => {
        const payload = input as QualityHarnessModelRequest;
        actualNextRequests.push(structuredClone(payload));
        return useFeedback(payload, await originalInvoker(input, signal));
      },
      qualityModelRouting: {
        ...original.qualityModelRouting,
        adapters: original.qualityModelRouting.adapters.map((adapter) => ({
          ...adapter,
          invoke: async (
            call: Parameters<LogicalAgentModelAdapter["invoke"]>[0],
            signal: AbortSignal,
          ) => {
            const payload = call.payload as QualityHarnessModelRequest;
            actualNextRequests.push(structuredClone(payload));
            return useFeedback(payload, await adapter.invoke(call, signal));
          },
        })),
      },
    },
  };
  return { request, host, options, actualNextRequests, actualNextReplies };
}

describe("original directed publication and next-run review feedback", () => {
  it("carries the admitted whole daily packet review into the next original learning application", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-whole-feedback-"));
    try {
      const published = await preparePublishedDirectedReview(workspace, true, false, true);
      expect(published.execution).toMatchObject({
        scheduleAdmission: { status: "due" },
        batchExecution: { status: "completed" },
      });
      const next = await prepareNextDirectedInvocation(
        published,
        workspace,
        undefined,
        "risk_gate_and_learning_loop",
      );
      const result = await executeDirectedDailyResearchTask(next.options);
      const learning = result.taskExecution.researchReceipt?.moduleExecution?.nodes.find(
        (node) => node.moduleId === "finance_learning_memory",
      );
      const call = learning?.toolCalls.find(
        (item) => item.toolName === "finance_learning_capability_apply",
      );
      await saveBatchProof("whole-admission-review-next-learning", workspace, {
        retainedWorkspace: process.env.LCX_DIRECTED_BATCH_PROOF_DIR
          ? path.join(
              process.env.LCX_DIRECTED_BATCH_PROOF_DIR,
              "whole-admission-review-next-learning",
              "private-bytes",
            )
          : undefined,
        published,
        nextRequest: next.request,
        result,
        actualNextRequests: next.actualNextRequests,
        actualNextReplies: next.actualNextReplies,
        naturalSemanticAdoption: "not_observed",
      });
      expect(result.taskExecution.reviewFeedback?.status).toBe("forwarded_to_original_runner");
      expect(result.taskExecution.reviewFeedback?.sourceScope).toEqual(published.prepared.host);
      expect(call?.outputSummary).toContain(priorReviewGap);
      expect(call?.inputEvidenceIds.some((id) => id.startsWith("directed-review:"))).toBe(true);
      expect(call?.status).toBe("blocked");
      const receivedRefusal = next.actualNextRequests
        .flatMap((request) => request.evidence)
        .find(
          (item) =>
            item.id.endsWith(":diagnostic") &&
            item.text.includes("module_refusal_diagnostic_not_market_evidence"),
        );
      expect(receivedRefusal?.text).toContain("finance_learning_capability_candidates_missing");
      expect(JSON.stringify(next.actualNextReplies)).toContain(
        "do not claim retained guidance was adopted",
      );
      const diagnostic = result.packetCandidateSections[3].evidence?.find(
        (item) => item.source === "directed-daily-review-diagnostic",
      );
      expect(diagnostic).toBeDefined();
      expect(Buffer.byteLength(diagnostic!.text, "utf8")).toBeLessThanOrEqual(4096);
      const omitted = JSON.parse(diagnostic!.text).omittedFields as Array<{
        field: string;
        fromIndex?: number;
        count: number;
        source: { path: string; sha256: string };
      }>;
      expect(omitted.length).toBeGreaterThan(0);
      for (const item of omitted) {
        expect(item.count).toBeGreaterThan(0);
        expect(item.field.startsWith("/contentReview/")).toBe(true);
        expect(hash(await fs.readFile(path.join(workspace, item.source.path), "utf8"))).toBe(
          item.source.sha256,
        );
        if (item.field === "/contentReview/quality/verification/details") {
          expect(item.fromIndex).toBeDefined();
          expect(item.fromIndex! + item.count).toBe(
            published.review.contentReview.quality?.verification.details.length,
          );
        }
      }
      expect(result.contentAcceptance).toBe("review_required");
      expect(result.packetCandidateSections[3].learningApplication).toMatchObject({
        status: "refused",
        sourceReadStatus: "verified",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
  it.each(["account", "future", "source"] as const)(
    "keeps a refused learning section's %s source fault out of the next original tool query",
    async (fault) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-learning-fault-"));
      try {
        const published = await preparePublishedDirectedReview(workspace, true);
        if (fault === "source") {
          const source = published.review.packetCandidateSections[3].source;
          if (!source) {
            throw new Error("original_risk_source_missing");
          }
          await fs.appendFile(path.join(workspace, source.sourceRef), "\n");
        }
        const next = await prepareNextDirectedInvocation(
          published,
          workspace,
          fault === "source" ? undefined : fault,
          "risk_gate_and_learning_loop",
        );
        const result = await executeDirectedDailyResearchTask(next.options);
        expect(result.taskExecution.reviewFeedback?.status).toBe("not_consumed");
        const call = result.taskExecution.researchReceipt?.moduleExecution?.nodes.find(
          (node) => node.moduleId === "finance_learning_memory",
        )?.toolCalls[0];
        expect(call?.outputSummary).not.toContain(priorReviewGap);
        expect(call?.inputEvidenceIds.some((id) => id.startsWith("directed-review:"))).toBe(false);
        expect(result.contentAcceptance).toBe("review_required");
        expect(fetch).not.toHaveBeenCalled();
        await saveBatchProof(`whole-next-learning-${fault}-blocked`, workspace, { result });
      } finally {
        vi.useRealTimers();
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  );
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it.each([false, true])(
    "preserves actual native %s execution through review publication, while admission holds failed review or partial execution",
    async (batch) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-history-"));
      try {
        const published = await preparePublishedDirectedReview(workspace, batch);
        expect(published.review.executionProvenance).toMatchObject({
          status: "verified",
          archive: { sha256: hash(published.archiveBefore.toString("utf8")) },
        });
        expect(await fs.readFile(published.nativeWrite.jsonPath)).toEqual(published.archiveBefore);
        expect(published.reviewWrite.jsonPath).not.toBe(published.nativeWrite.jsonPath);
        if (!batch) {
          const withoutHost = await readDirectedDailyCases({
            workspaceDir: workspace,
            date: published.native.request.date,
            bindingsFile: published.execution.caseBindingsSource!.sourceRef,
          });
          expect(withoutHost.executionProvenance).toMatchObject({
            status: "not_observed",
            reason: "directed_original_independent_host_not_observed_or_conflict",
          });
        }
        const latestBytes = await fs.readFile(published.reviewWrite.latestJsonPath);
        const latest = JSON.parse(latestBytes.toString("utf8")) as Record<string, unknown>;
        expect(latest[batch ? "batchExecution" : "taskExecution"]).toBeDefined();
        expect(published.review.contentReview.quality?.status).not.toBe("verified");
        const day = new Date(Date.parse(`${published.native.request.date}T00:00:00Z`) + 86400_000)
          .toISOString()
          .slice(0, 10);
        const host = {
          accountId: published.native.host.accountId,
          runId: "private-admission-next",
          date: day,
          nowMs: Date.parse(`${day}T12:00:00Z`),
        };
        const admission = await readDirectedDailyAdmission({
          workspaceDir: workspace,
          date: day,
          host,
          admission: {
            host,
            previous: {
              path: "state/lcx-directed-daily-research-brief-latest.json",
              sha256: hash(latestBytes.toString("utf8")),
            },
          },
        });
        await saveBatchProof(
          `native-review-admission-before-assert-${batch ? "batch" : "single"}`,
          workspace,
          { published, admission, latest },
        );
        const batchExecution =
          "batchExecution" in published.review ? published.review.batchExecution : undefined;
        expect(admission).toMatchObject({
          status: "held",
          reason:
            batchExecution && batchExecution.status !== "completed"
              ? "daily_admission_previous_failed_or_partial_requires_review"
              : "daily_admission_previous_review_failed_or_unverified_requires_review",
        });
        await saveBatchProof(`native-review-preserved-${batch ? "batch" : "single"}`, workspace, {
          published,
          admission,
          latest,
        });
      } finally {
        vi.useRealTimers();
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("forwards exact original review gap to the next real runner/model request without claiming natural adoption", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-next-gap-"));
    try {
      const published = await preparePublishedDirectedReview(workspace);
      const next = await prepareNextDirectedInvocation(published, workspace);
      const result = await executeDirectedDailyResearchTask(next.options);
      expect(result.taskExecution.reviewFeedback).toMatchObject({
        status: "forwarded_to_original_runner",
        upstreamRunId: published.native.host.runId,
        currentRunId: next.host.runId,
        semanticAdoption: "not_proven",
      });
      const evidence = next.actualNextRequests
        .flatMap((request) => request.evidence)
        .filter((item) => item.source === "directed-daily-review-diagnostic");
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.every((item) => item.text.includes(priorReviewGap))).toBe(true);
      expect(next.actualNextReplies.length).toBeGreaterThan(0);
      expect(JSON.stringify(next.actualNextReplies)).toContain(
        "retain needs-data stance instead of upgrading",
      );
      expect(
        result.taskExecution.reviewFeedback?.pins.some((pin) =>
          pin.path.endsWith("next-task-request.json"),
        ),
      ).toBe(false);

      const sourcePin = result.taskExecution.reviewFeedback?.pins[0];
      expect(sourcePin?.path).toContain("memory/directed-daily-research/");
      if (!sourcePin) {
        throw new Error("review_persistent_pin_missing");
      }
      const sourceBefore = await fs.readFile(path.join(workspace, sourcePin.path));
      await writeBrief(result, { workspaceDir: workspace });
      expect(await fs.readFile(path.join(workspace, sourcePin.path))).toEqual(sourceBefore);
      expect(hash(sourceBefore.toString("utf8"))).toBe(sourcePin.sha256);
      expect(fetch).not.toHaveBeenCalled();
      await saveBatchProof("native-review-next-model-gap-used", workspace, {
        published,
        nextRequest: next.request,
        actualNextRequests: next.actualNextRequests,
        actualNextReplies: next.actualNextReplies,
        result,
        naturalSemanticAdoption: "not_observed",
      });
    } finally {
      vi.useRealTimers();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("repairs the real failed third task from native batch diagnostics without a fabricated prior Caseflow", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "lcx-directed-failed-watchlist-feedback-"),
    );
    try {
      const published = await preparePublishedDirectedReview(workspace, true, true);
      const batchExecution =
        "batchExecution" in published.review ? published.review.batchExecution : undefined;
      const previousTask = batchExecution?.tasks.find(
        (task) => task.taskId === "timely_stock_candidates",
      );
      expect(previousTask).toMatchObject({
        status: "failed",
        gaps: ["daily_task_watchlist_missing"],
        taskExecution: { status: "held" },
      });
      expect(previousTask?.taskExecution?.savedCase).toBeUndefined();
      expect(
        published.review.packetCandidateSections.find(
          (section) => section.taskId === "timely_stock_candidates",
        )?.source,
      ).toBeUndefined();
      const next = await prepareNextDirectedInvocation(
        published,
        workspace,
        undefined,
        "timely_stock_candidates",
      );

      const result = await executeDirectedDailyResearchTask(next.options);
      await saveBatchProof("native-failed-third-next-before-assert", workspace, {
        nextRequest: next.request,
        actualCallerOptions: {
          taskId: next.options.taskId,
          requestPath: next.options.requestPath,
          host: next.options.host,
        },
        actualNextRequests: next.actualNextRequests,
        result,
      });
      expect(result.taskExecution.reviewFeedback).toMatchObject({
        status: "forwarded_to_original_runner",
        semanticAdoption: "not_proven",
      });
      const actualEvidence = next.actualNextRequests
        .flatMap((request) => request.evidence)
        .filter((item) => item.source === "directed-daily-review-diagnostic");
      expect(
        actualEvidence.some(
          (item) =>
            item.text.includes("daily_task_watchlist_missing") &&
            item.text.includes("not_saved_after_native_task_failure_not_market_evidence"),
        ),
      ).toBe(true);
      expect(JSON.stringify(next.actualNextReplies)).toContain(
        "Original failed task omitted four-tier structure",
      );
      expect(result.taskExecution.status).toBe("executed");
      const watchlist = result.packetCandidateSections.find(
        (section) => section.taskId === "timely_stock_candidates",
      )?.packet?.supportingAnalysis?.directedWatchlist;
      expect(watchlist).toMatchObject({
        coreTracking: [],
        needsData: expect.arrayContaining([expect.objectContaining({ instrument: "SPY" })]),
        downrankObservation: [],
        discarded: [],
      });
      expect(fetch).not.toHaveBeenCalled();
      await saveBatchProof("native-failed-third-next-gap-field-repaired", workspace, {
        published,
        nextRequest: next.request,
        actualNextRequests: next.actualNextRequests,
        actualNextReplies: next.actualNextReplies,
        result,
        naturalSemanticAdoption: "not_observed",
      });
    } finally {
      vi.useRealTimers();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["account", "directed_review_account_conflict"],
    ["future", "directed_review_future_completion"],
    ["targets", "directed_review_task_or_targets_conflict"],
    ["horizon", "directed_review_horizon_not_applicable"],
    ["source", "directed_review_source_not_current:case_source_hash_conflict"],
  ] as const)("does not forward %s review evidence to the next caller", async (fault, reason) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-feedback-fault-"));
    try {
      const published = await preparePublishedDirectedReview(workspace);
      if (fault === "source") {
        const source = published.review.packetCandidateSections.find(
          (section) => section.source,
        )?.source;
        if (!source) {
          throw new Error("original_review_source_missing");
        }
        await fs.appendFile(path.join(workspace, source.sourceRef), " ");
      }
      const next = await prepareNextDirectedInvocation(
        published,
        workspace,
        fault === "source" ? undefined : fault,
      );
      const result = await executeDirectedDailyResearchTask(next.options);
      expect(result.taskExecution.reviewFeedback).toMatchObject({
        status: "not_consumed",
        reason,
        semanticAdoption: "not_proven",
      });
      expect(
        next.actualNextRequests
          .flatMap((request) => request.evidence)
          .some((item) => item.source === "directed-daily-review-diagnostic"),
      ).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      await saveBatchProof(`native-review-feedback-${fault}-rejected`, workspace, {
        published,
        nextRequest: next.request,
        actualNextRequests: next.actualNextRequests,
        result,
      });
    } finally {
      vi.useRealTimers();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

async function saveBatchProof(name: string, workspace: string, result: unknown) {
  const root = process.env.LCX_DIRECTED_BATCH_PROOF_DIR;
  if (!root) {
    return;
  }
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.cp(workspace, path.join(directory, "private-bytes"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "native-result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}

describe("explicit original four-task daily batch", () => {
  it("runs four real task owners, bounds total calls and independently reads scoped Caseflow bodies", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-batch-"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
    try {
      const prepared = await prepareBatch(workspace, 64, 192);
      // This positive case runs four complete owners; Windows exceeded the
      // former 10s fixture budget before the final owner could finish.
      const result = await executeDirectedDailyResearchBatch({
        ...prepared.options,
        timeoutMs: 30_000,
      });
      await saveBatchProof("four-native-tasks", workspace, {
        result,
        sourceCalls: prepared.native.prepared.sourceCalls,
        committeeRequests: prepared.native.prepared.committeeRequests,
        qualityRequests: prepared.native.prepared.qualityRequests,
      });
      expect(result.batchExecution.status, JSON.stringify(result.batchExecution.tasks)).toBe(
        "completed",
      );
      expect(result.batchExecution.tasks.map((task) => task.status)).toEqual([
        "executed",
        "executed",
        "executed",
        "executed",
      ]);
      const nvdaReads = prepared.native.prepared.sourceBodyUses.filter(
        (entry) => entry.evidenceId === "finance-model:NVDA",
      );
      expect(nvdaReads.length).toBeGreaterThan(0);
      for (const entry of nvdaReads) {
        expect(entry.evidenceSummary).toContain("[finance-model:NVDA]");
        expect(entry.sourceText).toContain("fixture://primary_market_data/NVDA");
        expect(entry.sourceText).not.toContain("fixture://primary_market_data/SPY");
      }
      const nvdaDraft = prepared.native.prepared.committeeRequests.find(
        (request) =>
          request.stage === "draft" &&
          request.evidence.some((entry) => entry.id === "finance-model:NVDA"),
      );
      if (!nvdaDraft) {
        throw new Error("actual NVDA draft request not observed");
      }
      await expect(
        prepared.native.prepared.scriptedOutput(
          {
            ...nvdaDraft,
            evidence: nvdaDraft.evidence.map((entry) =>
              entry.id === "finance-model:NVDA" ? { ...entry, id: "finance-model:SPY" } : entry,
            ),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("market identity conflicts with source body");
      await expect(
        prepared.native.prepared.scriptedOutput(
          {
            ...nvdaDraft,
            evidence: nvdaDraft.evidence.filter((entry) => entry.id !== "finance-model:NVDA"),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("lacks unique dated target source observations");
      expect(result.batchExecution.allocation.allocatedApiCalls).toBeLessThanOrEqual(
        prepared.host.maxApiCalls,
      );
      expect(result.batchExecution.allocation.allocatedModelCalls).toBeLessThanOrEqual(
        prepared.host.maxModelCalls,
      );
      expect(result.batchExecution.notObserved).toContain("schedule_due_gate");
      expect(result.researchPacketStatus).toBe("partial_sections");
      expect(result.packetCandidateSections[3]?.gaps).toContain(
        "adjacent_task_application_not_observed",
      );
      expect(result.packetCandidateSections[3]?.learningApplication).toMatchObject({
        status: "refused",
        sourceReadStatus: "verified",
        failureReason: "finance_learning_capability_candidates_missing",
        candidateCount: 0,
      });
      if (!("bindingsFile" in result)) {
        throw new Error("native batch binding missing");
      }
      const readback = await readDirectedDailyCases({
        date: prepared.options.date,
        workspaceDir: workspace,
        bindingsFile: result.bindingsFile,
        batchHost: prepared.host,
      });
      expect(readback.packetCandidateSections.slice(0, 3).map((section) => section.status)).toEqual(
        ["read_ready", "read_ready", "read_ready"],
      );
      expect(readback.packetCandidateSections.every((section) => section.packet?.analysis)).toBe(
        true,
      );
      expect(JSON.stringify(readback.packetCandidateSections)).toContain(
        "Original quantitative history",
      );
      for (const task of result.batchExecution.tasks) {
        if (task.taskExecution?.status !== "executed") {
          throw new Error("task did not execute");
        }
        const native = task.taskExecution.researchReceipt;
        const allocation = task.taskExecution.allocation;
        if (!native || !allocation) {
          throw new Error("original native budget not observed");
        }
        expect(native.batch?.budget.maxApiCalls).toBe(allocation.maxApiCalls);
        expect(native.batch?.budget.reservedCallBudget).toBeLessThanOrEqual(allocation.maxApiCalls);
        expect(native.modelCheckpoint?.reservedModelCalls).toBeLessThanOrEqual(
          allocation.maxModelCalls,
        );
        const section = readback.packetCandidateSections.find(
          (section) => section.taskId === task.taskId,
        );
        expect(hash(section?.packet?.analysis ?? "")).toBe(native.candidateAnalysisSha256);
      }
      const unknown = await readDirectedDailyCases({
        date: prepared.options.date,
        workspaceDir: workspace,
        bindingsFile: result.bindingsFile,
      });
      expect(
        unknown.packetCandidateSections.every((section) =>
          section.gaps.includes("batch_host_scope_not_observed"),
        ),
      ).toBe(true);
      const foreign = await readDirectedDailyCases({
        date: prepared.options.date,
        workspaceDir: workspace,
        bindingsFile: result.bindingsFile,
        batchHost: { ...prepared.host, runId: "foreign-run" },
      });
      expect(
        foreign.packetCandidateSections.every((section) =>
          section.gaps.includes("batch_host_scope_conflict"),
        ),
      ).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not reset insufficient parent API or model budgets for later tasks", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-budget-"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
    try {
      const prepared = await prepareBatch(workspace, 1, 1);
      const result = await executeDirectedDailyResearchBatch(prepared.options);
      await saveBatchProof("shared-budget-one", workspace, {
        result,
        sourceCalls: prepared.native.prepared.sourceCalls,
        committeeRequests: prepared.native.prepared.committeeRequests,
      });
      expect(result.batchExecution.allocation).toMatchObject({
        allocatedApiCalls: 1,
        allocatedModelCalls: 1,
      });
      expect(
        result.batchExecution.tasks
          .slice(1)
          .every(
            (task) =>
              task.status === "not_executed" && task.gaps.includes("shared_batch_budget_exhausted"),
          ),
      ).toBe(true);
      expect(prepared.native.prepared.sourceCalls.length).toBeLessThanOrEqual(1);
      expect(prepared.native.prepared.committeeRequests.length).toBeLessThanOrEqual(1);
      expect(
        result.batchExecution.tasks[0]?.taskExecution?.researchReceipt?.batch?.budget.maxApiCalls,
      ).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects altered task request hashes before calling any task", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-pin-"));
    try {
      const prepared = await prepareBatch(workspace);
      await fs.appendFile(path.join(workspace, prepared.manifest.tasks[1].request.path), "\n");
      const result = await executeDirectedDailyResearchBatch(prepared.options);
      expect(result.batchExecution.status).toBe("failed");
      expect(result.batchExecution.tasks.every((task) => task.status === "not_executed")).toBe(
        true,
      );
      expect(prepared.native.prepared.sourceCalls).toHaveLength(0);
      expect(result.batchExecution).toMatchObject({
        gaps: ["directed_batch_manifest_hash_conflict"],
      });
      await saveBatchProof("request-hash-rejected", workspace, result);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses one parent deadline, rejects late model completion and never dispatches later tasks", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-deadline-"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
    try {
      const prepared = await prepareBatch(workspace);
      let calls = 0;
      let released = false;
      const options = {
        ...prepared.options,
        timeoutMs: 100,
        researchOptions: {
          ...prepared.options.researchOptions,
          modelInvoker: async (request: unknown) => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 200));
            released = true;
            return prepared.native.prepared.scriptedOutput(
              request as Parameters<typeof prepared.native.prepared.scriptedOutput>[0],
              new AbortController().signal,
            );
          },
        },
      };
      const result = await executeDirectedDailyResearchBatch(options);
      const beforeLate = JSON.stringify(result);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(released).toBe(true);
      expect(calls).toBeLessThanOrEqual(1);
      expect(result.batchExecution.status).toBe("failed");
      expect(
        result.batchExecution.tasks.slice(1).every((task) => task.status === "not_executed"),
      ).toBe(true);
      expect(JSON.stringify(result)).toBe(beforeLate);
      expect("bindingsFile" in result).toBe(false);
      await saveBatchProof("shared-deadline-late", workspace, {
        result,
        calls,
        released,
        afterLateUnchanged: JSON.stringify(result) === beforeLate,
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
  it.each(["date", "run", "duplicate_case"])(
    "rejects %s identity conflicts before any source/model call",
    async (fault) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-identity-"));
      try {
        const prepared = await prepareBatch(workspace);
        const selected = prepared.manifest.tasks[1];
        const file = path.join(workspace, selected.request.path);
        const original = JSON.parse(await fs.readFile(file, "utf8"));
        if (fault === "date") {
          original.asOf = "2026-10-01T20:00:00Z";
        } else if (fault === "run") {
          original.runId = "foreign-run";
        } else {
          original.caseId = "native-index_options_regime";
        }
        const changed = JSON.stringify(original) + "\n";
        await fs.writeFile(file, changed);
        selected.request.sha256 = hash(changed);
        const body = JSON.stringify(prepared.manifest) + "\n";
        await fs.writeFile(prepared.options.requestPath, body);
        const result = await executeDirectedDailyResearchBatch({
          ...prepared.options,
          requestSha256: hash(body),
        });
        expect(result.batchExecution.status).toBe("failed");
        expect(prepared.native.prepared.sourceCalls).toHaveLength(0);
        expect(prepared.native.prepared.committeeRequests).toHaveLength(0);
        expect(result.batchExecution).toMatchObject({
          gaps: [
            fault === "duplicate_case"
              ? "directed_batch_duplicate_case_id"
              : "directed_batch_task_scope_conflict",
          ],
        });
        await saveBatchProof(`identity-${fault}`, workspace, result);
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("retains each actual native missing-source failure instead of publishing fake Caseflow bodies", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-source-"));
    try {
      const prepared = await prepareBatch(workspace, 64, 192, "missing_source");
      const result = await executeDirectedDailyResearchBatch(prepared.options);
      expect(result.batchExecution.tasks.every((task) => task.status === "failed")).toBe(true);
      expect(
        result.batchExecution.tasks.every(
          (task) => task.taskExecution?.researchReceipt?.batch?.status === "blocked",
        ),
      ).toBe(true);
      expect(
        result.packetCandidateSections.every(
          (section) =>
            !section.packet && section.gaps.some((gap) => gap.includes("source_evidence")),
        ),
      ).toBe(true);
      expect(result.batchExecution.allocation).toMatchObject({
        allocatedApiCalls: 64,
        allocatedModelCalls: 192,
      });
      await saveBatchProof("four-native-source-failures", workspace, result);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
  it("wires explicit batch CLI while reporting the original unavailable model without source dispatch", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-cli-batch-"));
    try {
      const prepared = await prepareBatch(workspace);
      const result = await runBrief(
        [
          "--execute-batch",
          "--date",
          prepared.options.date,
          "--research-request",
          prepared.options.requestPath,
          "--research-request-sha",
          prepared.options.requestSha256,
          "--research-host",
          prepared.options.hostPath,
          "--research-host-sha",
          prepared.options.hostSha256,
        ],
        { OPENCLAW_WORKSPACE_DIR: workspace },
      );
      expect(result).toMatchObject({
        researchPacketStatus: "held",
        batchExecution: {
          status: "failed",
          tasks: batchTaskIds.map((taskId) => ({
            taskId,
            status: "failed",
            taskExecution: {
              modelAvailability: "unavailable_no_source_fetch",
              researchReceipt: { status: "planned" },
            },
          })),
        },
      });
      expect(prepared.native.prepared.sourceCalls).toHaveLength(0);
      expect(prepared.native.prepared.committeeRequests).toHaveLength(0);
      await saveBatchProof("explicit-cli-unavailable", workspace, result);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
  it.each(["memory/protected", "config", "state/sibling"])(
    "rejects %s as a shared Caseflow write directory before source/model calls",
    async (caseDirectory) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-case-boundary-"));
      try {
        const prepared = await prepareNativeDirectedTask(workspace);
        const result = await executeDirectedDailyResearchTask({
          ...prepared.nativeOptions,
          caseDirectory,
        });
        expect(result.taskExecution).toMatchObject({
          status: "failed",
          gaps: ["directed_research_case_scope_outside_batch"],
        });
        expect(prepared.prepared.sourceCalls).toHaveLength(0);
        expect(prepared.prepared.committeeRequests).toHaveLength(0);
        await expect(fs.access(path.join(workspace, caseDirectory))).rejects.toThrow();
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("rejects an internal alias without creating a scope marker or changing private canary bytes", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-case-alias-"));
    try {
      const prepared = await prepareNativeDirectedTask(workspace);
      const outsideBatch = path.join(workspace, "memory/private-canary");
      await fs.mkdir(outsideBatch, { recursive: true });
      await fs.writeFile(path.join(outsideBatch, "canary.txt"), "private unchanged bytes");
      const batchDir = "state/directed-daily-research-batches/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      await fs.mkdir(path.dirname(path.join(workspace, batchDir)), { recursive: true });
      await fs.symlink(outsideBatch, path.join(workspace, batchDir));
      const result = await executeDirectedDailyResearchTask({
        ...prepared.nativeOptions,
        caseDirectory: `${batchDir}/cases`,
      });
      expect(result.taskExecution).toMatchObject({
        status: "failed",
        gaps: ["directed_research_case_scope_alias"],
      });
      expect(await fs.readFile(path.join(outsideBatch, "canary.txt"), "utf8")).toBe(
        "private unchanged bytes",
      );
      expect(await fs.readdir(outsideBatch)).toEqual(["canary.txt"]);
      expect(prepared.prepared.sourceCalls).toHaveLength(0);
      expect(prepared.prepared.committeeRequests).toHaveLength(0);
      await saveBatchProof("case-write-alias-refused", workspace, result);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
  it("checks actual native budget against matching but false parent and execution declarations", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-native-budget-"));
    try {
      const prepared = await prepareBatch(workspace, 64, 192);
      const selected = prepared.manifest.tasks[0];
      const native = await executeDirectedDailyResearchTask({
        ...prepared.native.nativeOptions,
        host: prepared.host,
        requestPath: selected.request.path,
        requestSha256: selected.request.sha256,
      });
      if (native.taskExecution.status !== "executed") {
        throw new Error("actual native task failed");
      }
      const original = native.taskExecution.researchReceipt;
      const caseId = "native-index_options_regime";
      const allocation = { maxApiCalls: 1, maxModelCalls: 1 };
      const frozen = buildFinanceCaseRun({
        caseId,
        receipt: original,
        execution: {
          mode: "explicit_directed_task",
          accountId: prepared.host.accountId,
          runId: prepared.host.runId,
          taskId: selected.taskId,
          request: selected.request,
          allocation,
          noExecutionAuthority: true,
        },
        budget: allocation,
      });
      const directory = path.join(workspace, "counter-cases");
      const saved = await saveFinanceCaseRun(directory, frozen);
      const caseBytes = await fs.readFile(saved.path);
      const bindings = {
        schemaVersion: "lcx_directed_daily_case_bindings_v1",
        date: prepared.manifest.date,
        asOf: prepared.manifest.asOf,
        caseDirectory: "counter-cases",
        parent: {
          ...prepared.host,
          date: prepared.manifest.date,
          asOf: prepared.manifest.asOf,
          request: { path: "batch-request.json", sha256: prepared.options.requestSha256 },
          tasks: prepared.manifest.tasks.map((task, index) => ({
            ...task,
            allocation: index === 0 ? allocation : { maxApiCalls: 0, maxModelCalls: 0 },
          })),
        },
        tasks: [
          {
            taskId: selected.taskId,
            caseId,
            ref: saved.ref,
            caseSha256: createHash("sha256").update(caseBytes).digest("hex"),
            snapshotFingerprint: frozen.run.snapshotFingerprint,
            ask: original.plan.ask,
            targets: original.plan.targets.map((target) => target.instrument),
          },
        ],
      };
      await fs.writeFile(
        path.join(workspace, "counter-bindings.json"),
        JSON.stringify(bindings) + "\n",
      );
      const read = await readDirectedDailyCases({
        date: prepared.manifest.date,
        workspaceDir: workspace,
        bindingsFile: "counter-bindings.json",
        batchHost: prepared.host,
      });
      await saveBatchProof("matching-false-budget-declarations", workspace, {
        read,
        actualNativeBudget: original.batch?.budget,
        actualNativeModel: original.modelCheckpoint,
        declaredAllocation: allocation,
      });
      expect(read.packetCandidateSections[0]).toMatchObject({
        status: "held",
        gaps: ["case_batch_native_budget_conflict"],
      });
      expect(read.packetCandidateSections[0]?.packet).toBeUndefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("explicit original UTC daily admission", () => {
  it("consumes confirmed first-run admission in the original batch and holds repeats before research", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-due-"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
    try {
      const prepared = await prepareBatch(workspace, 64, 192);
      const host = {
        accountId: prepared.host.accountId,
        runId: prepared.host.runId,
        date: prepared.options.date,
        nowMs: Date.parse(`${prepared.options.date}T12:00:00.000Z`),
      };
      const result = await executeDirectedDailyResearchBatch({
        ...prepared.options,
        admission: { host, firstRun: true },
      });
      expect(result.scheduleAdmission).toMatchObject({
        status: "due",
        reason: "daily_admission_first_run_latest_absent",
        reservation: "not_atomic",
        consumer: { scope: prepared.host, taskIds: batchTaskIds },
      });
      expect(result.batchExecution.status).toBe("completed");
      expect(result.batchExecution.notObserved).not.toContain("schedule_due_gate");
      const bytes = JSON.stringify(result) + "\n";
      const latestPath = "state/lcx-directed-daily-research-brief-latest.json";
      await fs.mkdir(path.join(workspace, "state"), { recursive: true });
      // Persist exact native output at the existing owner path; no intermediate receipt is invented.
      await fs.writeFile(path.join(workspace, latestPath), bytes);
      const repeated = await executeDirectedDailyResearchBatch({
        ...prepared.options,
        admission: { host, previous: { path: latestPath, sha256: hash(bytes) } },
      });
      expect(repeated.scheduleAdmission).toMatchObject({
        status: "held",
        reason: "daily_admission_duplicate_day_or_run",
      });
      expect(repeated.batchExecution.status).toBe("held");
      expect(repeated.batchExecution.tasks.every((task) => task.status === "not_executed")).toBe(
        true,
      );
      const nextDate = new Date(host.nowMs + 86_400_000).toISOString().slice(0, 10);
      const nextHost = {
        ...host,
        date: nextDate,
        nowMs: host.nowMs + 86_400_000,
        runId: "next-private-daily-attempt",
      };
      const next = await readDirectedDailyAdmission({
        workspaceDir: workspace,
        date: nextDate,
        host: nextHost,
        admission: { host: nextHost, previous: { path: latestPath, sha256: hash(bytes) } },
      });
      expect(
        await readDirectedDailyAdmission({
          workspaceDir: workspace,
          date: nextDate,
          host: { ...nextHost, accountId: "other-account" },
          admission: {
            host: { ...nextHost, accountId: "other-account" },
            previous: { path: latestPath, sha256: hash(bytes) },
          },
        }),
      ).toMatchObject({
        status: "held",
        reason: "daily_admission_previous_account_conflict",
      });
      expect(next).toMatchObject({
        status: "due",
        reason: "daily_admission_previous_utc_day_attempt_completed",
        previous: { sha256: hash(bytes), date: host.date, runId: host.runId },
      });
      const conflicting = await executeDirectedDailyResearchTask({
        ...prepared.native.nativeOptions,
        admission: { host: { ...host, accountId: "foreign-account" }, firstRun: true },
      });
      expect(conflicting.scheduleAdmission).toMatchObject({
        status: "held",
        reason: "daily_admission_host_scope_conflict",
      });
      expect(conflicting.taskExecution).toMatchObject({
        status: "held",
        modelAvailability: "not_observed",
      });
      await saveBatchProof("actual-native-daily-admission", workspace, {
        result,
        repeated,
        next,
        conflicting,
      });
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("holds unconfirmed history, UTC/scope conflicts and previously failed native results", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-due-fault-"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
    try {
      const prepared = await prepareBatch(workspace);
      const host = {
        accountId: prepared.host.accountId,
        runId: "next-attempt",
        date: prepared.options.date,
        nowMs: Date.parse(`${prepared.options.date}T12:00:00.000Z`),
      };
      const check = (admission: Parameters<typeof readDirectedDailyAdmission>[0]["admission"]) =>
        readDirectedDailyAdmission({ workspaceDir: workspace, date: host.date, host, admission });
      expect(await check({ host })).toMatchObject({
        status: "held",
        reason: "daily_admission_history_choice_required",
      });
      expect(
        await check({
          host,
          previous: {
            path: "state/lcx-directed-daily-research-brief-latest.json",
            sha256: "0".repeat(64),
          },
        }),
      ).toMatchObject({ status: "held", reason: "daily_admission_latest_unconfirmed" });
      expect(await check({ host: { ...host, date: "2001-01-01" }, firstRun: true })).toMatchObject({
        status: "held",
        reason: "daily_admission_utc_date_conflict",
      });
      const failed = await executeDirectedDailyResearchBatch({
        ...prepared.options,
        researchOptions: {
          ...prepared.options.researchOptions,
          modelInvoker: undefined,
          modelRouting: undefined,
        },
      });
      expect(failed.batchExecution.status).toBe("failed");
      const latestPath = "state/lcx-directed-daily-research-brief-latest.json";
      const bytes = JSON.stringify(failed) + "\n";
      await fs.mkdir(path.join(workspace, "state"), { recursive: true });
      await fs.writeFile(path.join(workspace, latestPath), bytes);
      expect(await check({ host, firstRun: true })).toMatchObject({
        status: "held",
        reason: "daily_admission_first_run_history_exists",
      });
      expect(
        await check({ host, previous: { path: latestPath, sha256: "0".repeat(64) } }),
      ).toMatchObject({
        status: "held",
        reason: "daily_admission_previous_hash_or_latest_conflict",
      });
      await fs.writeFile(path.join(workspace, "unowned-copy.json"), bytes);
      expect(
        await check({ host, previous: { path: "unowned-copy.json", sha256: hash(bytes) } }),
      ).toMatchObject({ status: "held", reason: "daily_admission_previous_not_owner_receipt" });
      const previous = { path: latestPath, sha256: hash(bytes) };
      const futureClock = {
        ...host,
        nowMs: host.nowMs + 86_400_000,
        date: new Date(host.nowMs + 86_400_000).toISOString().slice(0, 10),
      };
      expect(
        await readDirectedDailyAdmission({
          workspaceDir: workspace,
          date: futureClock.date,
          host: futureClock,
          admission: { host: futureClock, previous },
        }),
      ).toMatchObject({
        status: "held",
        reason: "daily_admission_previous_failed_or_partial_requires_review",
      });
      const pastClock = {
        ...host,
        nowMs: host.nowMs - 86_400_000,
        date: new Date(host.nowMs - 86_400_000).toISOString().slice(0, 10),
      };
      expect(
        await readDirectedDailyAdmission({
          workspaceDir: workspace,
          date: pastClock.date,
          host: pastClock,
          admission: { host: pastClock, previous },
        }),
      ).toMatchObject({
        status: "held",
        reason: "daily_admission_previous_future_or_invalid_date",
      });
      await saveBatchProof("actual-native-failed-daily-admission", workspace, { failed, previous });
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("cannot turn a symlink or caller cancellation into confirmed first-run absence", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-due-alias-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-due-outside-"));
    try {
      const host = {
        accountId: "private-account",
        runId: "private-run",
        date: "2026-06-01",
        nowMs: Date.parse("2026-06-01T12:00:00.000Z"),
      };
      await fs.symlink(outside, path.join(workspace, "state"));
      expect(
        await readDirectedDailyAdmission({
          workspaceDir: workspace,
          date: host.date,
          host,
          admission: { host, firstRun: true },
        }),
      ).toMatchObject({ status: "held", reason: "daily_admission_latest_unconfirmed" });
      const controller = new AbortController();
      controller.abort(new Error("actual-caller-cancelled"));
      await expect(
        readDirectedDailyAdmission({
          workspaceDir: workspace,
          date: host.date,
          host,
          admission: { host, firstRun: true },
          signal: controller.signal,
        }),
      ).rejects.toThrow("actual-caller-cancelled");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("original directed admission file entry", () => {
  it.each(["task", "batch"] as const)(
    "loads pinned %s CLI admission within the original caller and retains unavailable-model failure",
    async (mode) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-admission-cli-"));
      try {
        const prepared = await prepareBatch(workspace);
        const admission = {
          firstRun: true,
          host: {
            accountId: prepared.host.accountId,
            runId: prepared.host.runId,
            date: prepared.options.date,
            nowMs: Date.parse(`${prepared.options.date}T12:00:00.000Z`),
          },
        };
        const bytes = JSON.stringify(admission) + "\n";
        const admissionPath = path.join(workspace, "admission.json");
        await fs.writeFile(admissionPath, bytes);
        const task = prepared.manifest.tasks[0];
        if (!task) {
          throw new Error("original task pin missing");
        }
        const args = [
          ...(mode === "batch" ? ["--execute-batch"] : ["--execute-task", task.taskId]),
          "--date",
          prepared.options.date,
          "--research-request",
          mode === "batch" ? prepared.options.requestPath : path.join(workspace, task.request.path),
          "--research-request-sha",
          mode === "batch" ? prepared.options.requestSha256 : task.request.sha256,
          "--research-host",
          prepared.options.hostPath,
          "--research-host-sha",
          prepared.options.hostSha256,
          "--admission-file",
          admissionPath,
          "--admission-sha",
          hash(bytes),
        ];
        const result = await runBrief([...args, "--write"], { OPENCLAW_WORKSPACE_DIR: workspace });
        expect(result.scheduleAdmission).toMatchObject({
          status: "due",
          reason: "daily_admission_first_run_latest_absent",
          inputFile: { path: "admission.json", sha256: hash(bytes) },
          consumer: { scope: prepared.host },
        });
        if (mode === "batch") {
          expect(result.batchExecution).toMatchObject({
            status: "failed",
            tasks: batchTaskIds.map((taskId) => ({
              taskId,
              status: "failed",
              taskExecution: {
                modelAvailability: "unavailable_no_source_fetch",
                researchReceipt: { status: "planned" },
              },
            })),
          });
        } else {
          expect(result.taskExecution).toMatchObject({
            status: "failed",
            modelAvailability: "unavailable_no_source_fetch",
            researchReceipt: { status: "planned" },
          });
        }
        const held = await runBrief(args, { OPENCLAW_WORKSPACE_DIR: workspace });
        expect(held.scheduleAdmission).toMatchObject({
          status: "held",
          reason: "daily_admission_first_run_history_exists",
          inputFile: { path: "admission.json", sha256: hash(bytes) },
        });
        if (mode === "batch") {
          expect(held.batchExecution).toMatchObject({
            status: "held",
            tasks: batchTaskIds.map((taskId) => ({ taskId, status: "not_executed" })),
          });
        } else {
          expect(held.taskExecution).toMatchObject({
            status: "held",
            modelAvailability: "not_observed",
          });
        }
        const wrongShaArgs = args.slice();
        wrongShaArgs[wrongShaArgs.length - 1] = "0".repeat(64);
        const wrongSha = await runBrief(wrongShaArgs, { OPENCLAW_WORKSPACE_DIR: workspace });
        expect(wrongSha.scheduleAdmission).toBeUndefined();
        if (mode === "batch") {
          expect(wrongSha.batchExecution).toMatchObject({
            status: "failed",
            gaps: ["directed_batch_manifest_hash_conflict"],
          });
          expect(wrongSha.batchExecution).toMatchObject({
            tasks: batchTaskIds.map((taskId) => ({ taskId, status: "not_executed" })),
          });
        } else {
          expect(wrongSha.taskExecution).toMatchObject({
            status: "failed",
            gaps: ["directed_research_manifest_hash_conflict"],
            modelAvailability: "not_observed",
          });
        }
        expect(prepared.native.prepared.sourceCalls).toHaveLength(0);
        expect(prepared.native.prepared.committeeRequests).toHaveLength(0);
        await saveBatchProof(`cli-daily-admission-${mode}`, workspace, {
          admission,
          result,
          held,
          wrongSha,
        });
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("rejects incomplete/non-execution CLI inputs and mixed API admission before source/model dispatch", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-admission-args-"));
    try {
      const prepared = await prepareBatch(workspace);
      const env = { OPENCLAW_WORKSPACE_DIR: workspace };
      const executeArgs = [
        "--execute-batch",
        "--date",
        prepared.options.date,
        "--research-request",
        prepared.options.requestPath,
        "--research-request-sha",
        prepared.options.requestSha256,
        "--research-host",
        prepared.options.hostPath,
        "--research-host-sha",
        prepared.options.hostSha256,
      ];
      for (const args of [
        [...executeArgs, "--admission-file", "missing.json"],
        [...executeArgs, "--admission-sha", "0".repeat(64)],
        ["--admission-file", "missing.json", "--admission-sha", "0".repeat(64)],
      ]) {
        await expect(runBrief(args, env)).rejects.toMatchObject({ code: 1 });
      }
      const host = {
        accountId: prepared.host.accountId,
        runId: prepared.host.runId,
        date: prepared.options.date,
        nowMs: Date.parse(`${prepared.options.date}T12:00:00.000Z`),
      };
      const ambiguous = await executeDirectedDailyResearchBatch({
        ...prepared.options,
        admission: { host, firstRun: true },
        admissionPath: "unread.json",
        admissionSha256: "0".repeat(64),
      });
      expect(ambiguous.batchExecution).toMatchObject({
        status: "failed",
        gaps: ["directed_admission_ambiguous_or_incomplete_input"],
      });
      const incomplete = await executeDirectedDailyResearchTask({
        ...prepared.native.nativeOptions,
        admissionPath: "unread.json",
      });
      expect(incomplete.taskExecution).toMatchObject({
        status: "failed",
        gaps: ["directed_admission_ambiguous_or_incomplete_input"],
        modelAvailability: "not_observed",
      });
      const empty = await executeDirectedDailyResearchBatch({
        ...prepared.options,
        admissionPath: "",
        admissionSha256: "",
      });
      expect(empty.batchExecution).toMatchObject({
        status: "failed",
        gaps: ["directed_admission_ambiguous_or_incomplete_input"],
      });
      expect(prepared.native.prepared.sourceCalls).toHaveLength(0);
      expect(prepared.native.prepared.committeeRequests).toHaveLength(0);
      await saveBatchProof("cli-daily-admission-invalid-input", workspace, {
        ambiguous,
        incomplete,
        empty,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
