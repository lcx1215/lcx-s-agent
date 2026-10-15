/** Offline observations of the original pool; no agent, provider or scheduler is launched. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowFieldRef,
  WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import {
  createCanonicalStateRootLogicalAgentCheckpointStore,
  resolveLogicalAgentCheckpointPath,
} from "../../src/agents/logical-agent-pool-checkpoint-store.js";
import {
  buildDefaultLogicalAgentPlan,
  LogicalAgentPool,
  runLogicalAgentPlan,
  type LogicalAgentCheckpoint,
  type LogicalAgentPlanResult,
  type LogicalAgentRequest,
} from "../../src/agents/logical-agent-pool.js";

type Output = {
  value: number;
  observedSchedule: { agentId: string; dependsOn: readonly string[] };
  received: Record<string, number>;
};
export async function probeOriginalLogicalPool(params: {
  directory: string;
  runId: string;
  seed: number;
  fault?: "missing_input" | "timeout";
}) {
  const tasks = buildDefaultLogicalAgentPlan({ ask: "Offline evidence handoff" });
  const stateDir = path.join(params.directory, "native-state");
  const store = createCanonicalStateRootLogicalAgentCheckpointStore<Output>({ stateDir });
  const invoked: string[] = [];
  const pool = new LogicalAgentPool<LogicalAgentRequest, Output>({
    maxConcurrency: 1,
    taskTimeoutMs: params.fault === "timeout" ? 10 : 1_000,
  });
  const execute = () =>
    runLogicalAgentPlan<LogicalAgentRequest, Output>({
      tasks,
      runId: params.runId,
      pool,
      checkpointStore: store,
      sharedContext: { seed: params.seed, source: "offline_fixture" },
      executor: async ({ task, agent, sharedContext, dependencyResults, signal }) => {
        invoked.push(task.id);
        if (task.id === "data_cleaning" && params.fault === "missing_input") {
          throw new Error("fixture_source_missing: no input evidence");
        }
        if (task.id === "data_cleaning" && params.fault === "timeout") {
          await new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("fixture_read_aborted")), {
              once: true,
            }),
          );
        }
        const received = Object.fromEntries(
          Object.entries(dependencyResults).map(([id, result]) => {
            if (result.status !== "completed" || !result.output) {
              throw new Error(`unusable_dependency:${id}`);
            }
            return [id, result.output.value];
          }),
        );
        const value = Object.keys(received).length
          ? Object.values(received).reduce((sum, n) => sum + n, 1)
          : Number(sharedContext.seed);
        return {
          output: {
            value,
            received,
            observedSchedule: { agentId: agent.id, dependsOn: task.dependsOn ?? [] },
          },
          sideEffects: [],
        };
      },
    });
  const result = await execute();
  await fs.mkdir(params.directory, { recursive: true });
  const nativeResultPath = path.join(params.directory, "native-pool-result.json");
  await fs.writeFile(nativeResultPath, JSON.stringify(result, null, 2) + "\n");
  const checkpoint = store.load(params.runId);
  const checkpointPath = resolveLogicalAgentCheckpointPath(params.runId, stateDir);
  const ref = async (file: string, pointer: string): Promise<WorkflowFieldRef> => ({
    path: file,
    pointer,
    sha256: createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex"),
  });
  let evidence: WorkflowHandoffEvidence | undefined;
  if (result.status === "completed" && checkpoint) {
    const dispatch = result.events.findIndex((event) => event.kind === "task_dispatched");
    const firstTask = result.tasks.findIndex(
      (task) => task.taskId === result.events[dispatch].taskId,
    );
    const finalTask = result.tasks.findIndex((task) => task.taskId === result.finalTaskId);
    const checkpointFinal = checkpoint.results.findIndex(
      (task) => task.taskId === result.finalTaskId,
    );
    const scope = await ref(nativeResultPath, "/runId");
    evidence = {
      scenarioId: "logical_agent_pool_waterflow",
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "logical_agent_pool_intake",
          scope,
          output: await ref(nativeResultPath, "/planFingerprint"),
        },
        {
          nodeId: "logical_agent_pool_schedule",
          scope,
          output: await ref(nativeResultPath, `/events/${dispatch}/payload`),
          inputs: [
            {
              from: "logical_agent_pool_intake",
              value: await ref(nativeResultPath, "/events/0/payload/planFingerprint"),
            },
          ],
        },
        {
          nodeId: "logical_agent_task_executor",
          scope,
          output: await ref(nativeResultPath, `/tasks/${finalTask}/output`),
          inputs: [
            {
              from: "logical_agent_pool_schedule",
              value: await ref(nativeResultPath, `/tasks/${firstTask}/output/observedSchedule`),
            },
          ],
        },
        {
          nodeId: "logical_agent_pool_terminal",
          scope: await ref(checkpointPath, "/runId"),
          output: await ref(checkpointPath, `/results/${checkpointFinal}`),
          inputs: [
            {
              from: "logical_agent_task_executor",
              value: await ref(checkpointPath, `/results/${checkpointFinal}/output`),
            },
          ],
        },
      ],
    };
  }
  return { result, checkpoint, checkpointPath, nativeResultPath, evidence, invoked, pool };
}

export function verifyOriginalPoolConsumption(
  result: LogicalAgentPlanResult<Output>,
  checkpoint: LogicalAgentCheckpoint<Output> | undefined,
): string[] {
  const gaps: string[] = [];
  for (const task of result.tasks) {
    if (task.status !== "completed" || !task.output) {
      gaps.push(`${task.taskId}:${task.status}`);
      continue;
    }
    for (const [id, value] of Object.entries(task.output.received)) {
      const producer = result.tasks.find((entry) => entry.taskId === id);
      if (producer?.output?.value !== value) {
        gaps.push(`${task.taskId}:wrong_dependency_value:${id}`);
      }
    }
    const planned = buildDefaultLogicalAgentPlan({ ask: "Offline evidence handoff" }).find(
      (entry) => entry.id === task.taskId,
    )!;
    if (
      JSON.stringify(Object.keys(task.output.received).toSorted()) !==
      JSON.stringify([...(planned.dependsOn ?? [])].toSorted())
    ) {
      gaps.push(`${task.taskId}:missing_dependency`);
    }
  }
  if (checkpoint?.runId !== result.runId || checkpoint.planFingerprint !== result.planFingerprint) {
    gaps.push("checkpoint_identity_conflict");
  }
  if (JSON.stringify(checkpoint?.results) !== JSON.stringify(result.tasks)) {
    gaps.push("checkpoint_result_not_consumed");
  }
  return gaps;
}
