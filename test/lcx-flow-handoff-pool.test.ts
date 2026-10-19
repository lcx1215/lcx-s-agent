import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import { createCanonicalStateRootLogicalAgentCheckpointStore } from "../src/agents/logical-agent-pool-checkpoint-store.js";
import {
  runLogicalAgentPlan,
  buildDefaultLogicalAgentPlan,
} from "../src/agents/logical-agent-pool.js";
import {
  probeOriginalLogicalPool,
  verifyOriginalPoolConsumption,
} from "./fixtures/lcx-waterflow-pool-probe.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-native-pool-waterflow-"));
  roots.push(dir);
  return dir;
}

describe("whole original logical-pool waterflow", () => {
  it("joins intake, schedule, real consumer inputs and native persisted terminal output for one run", async () => {
    const probe = await probeOriginalLogicalPool({
      directory: await directory(),
      runId: "offline-positive",
      seed: 7,
    });
    expect(probe.result.status).toBe("completed");
    expect(probe.result.tasks).toHaveLength(10);
    expect(verifyOriginalPoolConsumption(probe.result, probe.checkpoint)).toEqual([]);
    const audit = (await auditWorkflowHandoffs([probe.evidence!])).find(
      (item) => item.scenarioId === "logical_agent_pool_waterflow",
    );
    expect(audit).toMatchObject({
      status: "handoffs_verified",
      semanticAdoption: "not_proven",
      gaps: [],
    });
    const changed = await probeOriginalLogicalPool({
      directory: await directory(),
      runId: "offline-changed-input",
      seed: 11,
    });
    expect(changed.result.planFingerprint).not.toBe(probe.result.planFingerprint);
    expect(changed.result.tasks.at(-1)?.output?.value).not.toBe(
      probe.result.tasks.at(-1)?.output?.value,
    );
  });
  it.each(["missing_input", "timeout"] as const)(
    "propagates %s to terminal failure without running descendants",
    async (fault) => {
      const probe = await probeOriginalLogicalPool({
        directory: await directory(),
        runId: `offline-${fault}`,
        seed: 7,
        fault,
      });
      expect(probe.result.status).toBe("failed");
      expect(probe.invoked).toEqual(["data_cleaning"]);
      expect(
        probe.result.tasks
          .slice(1)
          .every((task) => task.status === "blocked" && task.modelId === "not-executed"),
      ).toBe(true);
      expect(probe.result.events.at(-1)).toMatchObject({
        kind: "run_completed",
        payload: { status: "failed" },
      });
      expect(probe.checkpoint).toBeUndefined();
      const readback = JSON.parse(await fs.readFile(probe.nativeResultPath, "utf8")) as {
        status: string;
      };
      expect(readback.status).toBe("failed");
    },
  );

  it("rejects an upstream field relabeled as consumer readback inside one native run receipt", async () => {
    const probe = await probeOriginalLogicalPool({
      directory: await directory(),
      runId: "offline-alias",
      seed: 7,
    });
    const evidence = structuredClone(probe.evidence!);
    evidence.nodes[1].inputs![0].value = evidence.nodes[0].output!;
    const observed = (await auditWorkflowHandoffs([evidence])).find(
      (item) => item.scenarioId === "logical_agent_pool_waterflow",
    );
    expect(observed).toMatchObject({
      status: "handoff_gap",
      gaps: expect.arrayContaining([
        expect.objectContaining({
          reason: "producer_field_cannot_serve_as_consumer_readback:logical_agent_pool_intake",
        }),
      ]),
    });
  });
  it("rejects changed facts before reusing a completed native checkpoint", async () => {
    const dir = await directory();
    const probe = await probeOriginalLogicalPool({
      directory: dir,
      runId: "offline-checkpoint",
      seed: 7,
    });
    const checkpointStore = createCanonicalStateRootLogicalAgentCheckpointStore({
      stateDir: path.join(dir, "native-state"),
    });
    let called = 0;
    await expect(
      runLogicalAgentPlan({
        tasks: buildDefaultLogicalAgentPlan({ ask: "Offline evidence handoff" }),
        runId: probe.result.runId,
        checkpointStore,
        resume: true,
        sharedContext: { seed: 11, source: "offline_fixture" },
        executor: () => {
          called++;
          return { output: "unexpected", sideEffects: [] };
        },
      }),
    ).rejects.toThrow(/fingerprint|checkpoint/i);
    expect(called).toBe(0);
  });
});
