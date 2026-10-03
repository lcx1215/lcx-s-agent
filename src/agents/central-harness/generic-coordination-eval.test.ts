import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { receiptsForHostTask } from "../../../scripts/operator/lcx-central-agent.js";
import {
  LogicalAgentPool,
  runLogicalAgentPlan,
  createInMemoryLogicalAgentCheckpointStore,
  type LogicalAgentTask,
} from "../logical-agent-pool.js";
import { runQualityHarness } from "../quality-harness.js";
import { runCentralHarnessCycle, compactReceipts, nextCycleContinuation } from "./harness-loop.js";
import { buildCentralBrainPrompt } from "./model-brain.js";
import { createCentralToolRegistry } from "./tool-registry.js";
import type {
  CentralHostTask,
  CentralPerception,
  CentralProposedAction,
  CentralRunReceipt,
} from "./types.js";

// Actual canonical local tools/control loops; every decision below is scripted offline.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const at = "2026-10-03T00:00:00.000Z";
const mathArgs = (scale: number) => ({
  action: "linear_regression",
  series: [scale, scale * 2, scale * 3],
  benchmark: [1, 2, 3],
});
async function fixture() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "generic-coordination-"));
  roots.push(workspaceDir);
  const registry = createCentralToolRegistry({ workspaceDir });
  const capabilities = new Set(["quant_math", "learning_distill", "finance_research_runs_read"]);
  const history: CentralRunReceipt[] = [];
  const perceived: CentralPerception[] = [];
  const cycle = async (task: CentralHostTask, actions: readonly CentralProposedAction[]) => {
    const perception: CentralPerception = {
      task,
      observedAt: at,
      controlRoom: {},
      ownerTotals: {},
      boundaries: ["no_execution_authority"],
      backlog: compactReceipts(receiptsForHostTask(history, task), 10, capabilities),
    };
    const receipt = await runCentralHarnessCycle({
      perception,
      registry,
      capabilityOwnerIds: capabilities,
      planOnly: true,
      brain: {
        propose: async (input) => {
          perceived.push(input);
          expect(buildCentralBrainPrompt(input, [...registry.values()])).toContain(task.objective);
          return {
            kind: "proposed",
            provider: "offline-fixture",
            modelId: "scripted",
            plan: { actions, note: "offline scripted local-tool acceptance" },
          };
        },
      },
    });
    history.push(receipt);
    expect(receipt.brainCall.modelCall).toBeUndefined();
    expect(receipt.liveTouched).toBe(false);
    return receipt;
  };
  return { workspaceDir, registry, cycle, history, capabilities, perceived };
}
const engineering: CentralHostTask = {
  objective: "Calculate an engineering measurement from supplied inputs",
  focus: "general",
};

describe("representative coordination acceptance (offline, no model intelligence claim)", () => {
  it("selects targeted actual tools for distinct explicit objectives without cross-task evidence", async () => {
    const f = await fixture();
    const math = await f.cycle(engineering, [{ ownerId: "quant_math", args: mathArgs(3) }]);
    expect(math.steps).toHaveLength(1);
    expect(math.steps[0].outcome).toMatchObject({ beta: 3, observations: 3 });
    const learning = await f.cycle(
      { objective: "Inspect local retained-learning availability", focus: "general" },
      [{ ownerId: "learning_distill", args: { since: at } }],
    );
    expect(learning.steps).toHaveLength(1);
    expect(learning.steps[0].ownerId).toBe("learning_distill");
    expect(learning.steps[0].status).toBe("ran_ok");
    expect(learning.task).not.toEqual(math.task);
    expect(f.perceived[1].backlog).toEqual([]);
    expect(f.history.filter((r) => r.task?.objective === learning.task?.objective)).toHaveLength(1);
  });

  it("recovers a real tool parameter failure only from declared missing inputs", async () => {
    const f = await fixture();
    const wrong = await f.cycle(engineering, [
      { ownerId: "quant_math", args: { action: "linear_regression", series: [2, 4, 6] } },
    ]);
    expect(wrong.steps[0].status).toBe("ran_failed");
    expect(wrong.steps[0].failureReason).toMatch(/benchmark|series/iu);
    expect(nextCycleContinuation(wrong, 1, 3).run).toBe(true);
    const carried = compactReceipts([wrong], 10, f.capabilities)[0].outcomes[0];
    expect(carried.args).toEqual({ action: "linear_regression", series: [2, 4, 6] });
    const repaired = await f.cycle(engineering, [{ ownerId: "quant_math", args: mathArgs(2) }]);
    expect(repaired.steps[0].outcome).toMatchObject({ beta: 2 });
    const unchanged = await f.cycle(engineering, [
      { ownerId: "quant_math", args: { action: "linear_regression", series: [2, 4, 6] } },
    ]);
    expect(nextCycleContinuation(unchanged, 2, 3, wrong)).toEqual({
      run: false,
      because: "unchanged_failure",
    });
  });

  it("uses an actual saved-run index to recover a named field and preserves absent files as gaps", async () => {
    const f = await fixture();
    const dir = path.join(f.workspaceDir, "state/finance-research-runs/run-a");
    await fs.mkdir(dir, { recursive: true });
    const source = JSON.stringify({ latencyMs: 17, sourceId: "experiment-a" });
    await fs.writeFile(path.join(dir, "measurement.json"), source);
    const task = {
      objective: "Audit a saved engineering experiment result",
      focus: "general",
    } as const;
    const listed = await f.cycle(task, [
      { ownerId: "finance_research_runs_read", args: { action: "list" } },
    ]);
    expect(listed.steps[0].status).toBe("ran_ok");
    const runs = listed.steps[0].outcome?.runs as Array<{ id: string }> | undefined;
    expect(runs?.map((run) => run.id)).toEqual(["run-a"]);
    const runId = runs![0].id;
    const read = await f.cycle(task, [
      {
        ownerId: "finance_research_runs_read",
        args: { action: "read", run: runId, file: "measurement.json" },
      },
    ]);
    expect(read.steps[0].outcome).toMatchObject({
      json: { latencyMs: 17, sourceId: "experiment-a" },
      truncated: false,
    });
    const absent = await f.cycle(task, [
      {
        ownerId: "finance_research_runs_read",
        args: { action: "read", run: runId, file: "absent.json" },
      },
    ]);
    expect(absent.steps[0].outcome).toMatchObject({
      ok: false,
      error: "unreadable file: absent.json",
    });
    expect(await fs.readFile(path.join(dir, "measurement.json"), "utf8")).toBe(source);
  });

  it("hands two independent actual numerical results to a DAG synthesis with immutable sources", async () => {
    const f = await fixture();
    const pool = new LogicalAgentPool<object, { source: string; beta: number }>({
      maxConcurrency: 2,
    });
    const tasks: LogicalAgentTask<object>[] = [
      { id: "support", agentId: "data_cleaning", input: {} },
      { id: "counter", agentId: "risk_check", input: {} },
      { id: "synthesis", agentId: "final_precheck", input: {}, dependsOn: ["support", "counter"] },
    ];
    const packet = { sourceId: "experiment-packet", supportScale: 4, counterScale: -2 };
    const result = await runLogicalAgentPlan({
      pool,
      tasks,
      sharedContext: packet,
      handoffs: [
        {
          fromTaskId: "support",
          toTaskId: "synthesis",
          contextScope: "dependency_results",
          ownership: "transferred",
        },
      ],
      executor: async ({ task, dependencyResults, sharedContext, signal }) => {
        if (task.id === "synthesis") {
          expect(dependencyResults.support.output).toEqual({
            source: "experiment-packet",
            beta: 4,
          });
          expect(dependencyResults.counter.output).toEqual({
            source: "experiment-packet",
            beta: -2,
          });
          return {
            output: {
              source: "both-dependencies",
              beta: dependencyResults.support.output!.beta + dependencyResults.counter.output!.beta,
            },
            sideEffects: [],
          };
        }
        const scale = task.id === "support" ? packet.supportScale : packet.counterScale;
        const actual = await f.registry.get("quant_math")!.execute(mathArgs(scale), signal);
        expect(sharedContext).toEqual(packet);
        return { output: { source: packet.sourceId, beta: Number(actual.beta) }, sideEffects: [] };
      },
    });
    expect(result.status).toBe("completed");
    expect(result.tasks.at(-1)?.output).toEqual({ source: "both-dependencies", beta: 2 });
    expect(packet).toEqual({ sourceId: "experiment-packet", supportScale: 4, counterScale: -2 });
  });

  it("keeps contrary evidence mandatory and stops before model or verifier calls", async () => {
    let modelCalls = 0;
    let verifierCalls = 0;
    const receipt = await runQualityHarness({
      request: {
        task: "Evaluate the engineering latency claim with its counterexample",
        evidence: [{ id: "support", text: "One run measured 17ms" }],
      },
      maxAttempts: 1,
      requireEvidenceCoverage: true,
      evidenceCoverage: {
        sourceEvidenceIds: ["support", "counter"],
        selectedEvidenceIds: ["support"],
        runnerOmittedEvidenceIds: ["counter"],
        runnerClippedEvidenceIds: [],
      },
      modelInvoker: async () => {
        modelCalls++;
        throw new Error("offline preflight must not invoke a model");
      },
      verify: async () => {
        verifierCalls++;
        return { status: "passed", summary: "must not run", details: [] };
      },
    });
    expect(receipt.status).toBe("quality-failed");
    expect(receipt.verification.details.join(" ")).toContain("counter");
    expect(modelCalls).toBe(0);
    expect(verifierCalls).toBe(0);
    expect(receipt.execution.realModelInferenceObserved).toBe(false);
  });

  it("quarantines a shared pool across independent DAGs until actual timeout cleanup", async () => {
    const pool = new LogicalAgentPool<object, string>({ maxConcurrency: 1, taskTimeoutMs: 5 });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondStarted = false;
    const first = runLogicalAgentPlan({
      pool,
      runId: "task-a",
      tasks: [{ id: "producer", agentId: "data_cleaning", input: {} }],
      executor: async () => {
        await pending;
        return { output: "late-a", sideEffects: [] };
      },
    });
    const second = runLogicalAgentPlan({
      pool,
      runId: "task-b",
      tasks: [{ id: "reader", agentId: "risk_check", input: {} }],
      executor: async () => {
        secondStarted = true;
        return { output: "b", sideEffects: [] };
      },
    });
    try {
      const [a, b] = await Promise.all([first, second]);
      expect(a.tasks[0].error).toContain("cleanup_unconfirmed");
      expect(b.tasks[0].startedAt).toBeUndefined();
      expect(secondStarted).toBe(false);
      expect(pool.status.activeRuns).toBe(1);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovered = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "new-reader", agentId: "risk_check", input: {} }],
      executor: async () => ({ output: "new-b", sideEffects: [] }),
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.tasks[0].output).toBe("new-b");
    const cancellation = new AbortController();
    let acknowledgeStart!: () => void;
    let releaseCancelled!: () => void;
    const started = new Promise<void>((resolve) => {
      acknowledgeStart = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseCancelled = resolve;
    });
    const cancelled = runLogicalAgentPlan({
      pool,
      signal: cancellation.signal,
      tasks: [{ id: "cancelled-reader", agentId: "risk_check", input: {} }],
      executor: async () => {
        acknowledgeStart();
        await held;
        return { output: "late-cancelled", sideEffects: [] };
      },
    });
    try {
      await started;
      cancellation.abort();
      expect((await cancelled).status).toBe("failed");
      expect(pool.status.activeRuns).toBe(1);
    } finally {
      releaseCancelled();
      await cancelled;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pool.status.activeRuns).toBe(0);
  });

  it("resumes only the same immutable fact packet and unfinished role suffix", async () => {
    const store = createInMemoryLogicalAgentCheckpointStore<number>();
    const tasks: LogicalAgentTask<object>[] = [
      { id: "producer", agentId: "data_cleaning", input: {} },
      { id: "review", agentId: "risk_check", input: {}, dependsOn: ["producer"] },
    ];
    let producers = 0;
    let reviews = 0;
    const executor = ({
      task,
      dependencyResults,
    }: {
      task: LogicalAgentTask<object>;
      dependencyResults: Readonly<Record<string, { output?: number }>>;
    }) => {
      if (task.id === "producer") {
        producers++;
        return { output: 17, sideEffects: [] } as const;
      }
      reviews++;
      if (reviews === 1) {
        throw new Error("transient reviewer unavailable");
      }
      expect(dependencyResults.producer.output).toBe(17);
      return { output: 17, sideEffects: [] } as const;
    };
    const args = {
      runId: "scoped-recovery",
      tasks,
      executor,
      checkpointStore: store,
      sharedContext: { sourceId: "original" },
    };
    expect((await runLogicalAgentPlan(args)).status).toBe("failed");
    const resumed = await runLogicalAgentPlan({ ...args, resume: true });
    expect(resumed.status).toBe("completed");
    expect(producers).toBe(1);
    expect(reviews).toBe(2);
    await expect(
      runLogicalAgentPlan({ ...args, resume: true, sharedContext: { sourceId: "changed" } }),
    ).rejects.toThrow("fingerprint mismatch");
  });
});
