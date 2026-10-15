import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import {
  compactReceipts,
  runCentralHarnessCycle,
  type CompactBacklogEntry,
} from "../../src/agents/central-harness/harness-loop.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import type {
  CentralActionPlan,
  CentralPerception,
  CentralRunReceipt,
} from "../../src/agents/central-harness/types.js";
import { ArtifactStore, type ArtifactRecord } from "../../src/memory/artifact-store.js";

export type UniverseReadbackFault = "missing" | "hash" | "field";
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");

/** Reuse retained bytes from a previously proved original CLI; never rerun that owner or a scheduler. */
export async function probeRetainedUniverseReadback(
  workspaceDir: string,
  originalReceiptPath: string,
  fault?: UniverseReadbackFault,
) {
  const originalBytes = await fs.readFile(originalReceiptPath);
  const source = JSON.parse(originalBytes.toString("utf8")) as {
    boundary: string;
    checkedAt: string;
    repoRoot: string;
    ownerCoverage: { changeImpact: { source: string; affectedLanes: string[] } };
  };
  assert.equal(source.boundary, "local_universe_index_only");
  assert.ok(source.repoRoot && source.checkedAt);
  const relativePath = "state/artifacts/retained-original-universe.json";
  const localPath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, originalBytes);
  const dbPath = path.join(workspaceDir, "private-artifacts.sqlite");
  const store = ArtifactStore.open({ dbPath, workspaceDir });
  let artifact: ArtifactRecord;
  try {
    ({ artifact } = await store.register({
      id: `retained-universe-${sha(originalBytes)}`,
      owner: "universeIndex",
      runId: "retained-original-cli-readback",
      observedAt: source.checkedAt,
      relativePath,
      mimeType: "application/json",
      summary:
        "Retained original CLI inventory; source integrity is not complete workflow execution.",
      sourceReceiptRefs: [originalReceiptPath],
    }));
  } finally {
    store.close();
  }
  assert.equal(artifact.sha256, sha(originalBytes));
  if (fault === "missing") {
    await fs.unlink(localPath);
  }
  if (fault === "hash") {
    await fs.appendFile(localPath, "\n");
  }
  const field =
    fault === "field" ? "/ownerCoverage/missingOwnership" : "/ownerCoverage/changeImpact/source";
  const ids = new Set(["artifact_memory_recall"]);
  const registry = new Map(
    [
      ...createCentralToolRegistry({
        workspaceDir,
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
              memorySearch: { enabled: true, store: { path: dbPath } },
            },
          },
        },
      }),
    ].filter(([id]) => ids.has(id)),
  );
  const receipts: CentralRunReceipt[] = [];
  const inputs: CentralPerception[] = [];
  const cycle = async (propose: (input: CentralPerception) => CentralActionPlan) => {
    const input: CentralPerception = {
      observedAt: new Date().toISOString(),
      ownerTotals: {},
      controlRoom: {},
      backlog: compactReceipts(receipts, 10, ids),
      boundaries: ["offline_scripted", "no_cleanup_authority", "broker_unknown_remains_blocked"],
    };
    inputs.push(input);
    const result = await runCentralHarnessCycle({
      perception: input,
      registry,
      capabilityOwnerIds: ids,
      planOnly: true,
      brain: {
        propose: async (seen) => ({
          kind: "proposed",
          provider: "offline-fixture",
          modelId: "scripted-retained-inventory-consumer",
          plan: propose(seen),
        }),
      },
    });
    receipts.push(result);
    await fs.writeFile(
      path.join(workspaceDir, "state", `readback-${receipts.length}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return result;
  };
  await cycle(() => ({
    actions: [
      { ownerId: "artifact_memory_recall", args: { action: "read", id: artifact.id, field } },
    ],
    note: "Read the exact original index change-impact source field.",
  }));
  await cycle((input) => {
    const delivered = input.backlog
      .flatMap((entry) => (entry.outcomes ?? []) as CompactBacklogEntry["outcomes"])
      .find(
        (step) => step.outcome?.artifactId === artifact.id || step.args?.id === artifact.id,
      )?.outcome;
    assert.ok(delivered, "actual read outcome must reach the next input");
    if (delivered.available !== true) {
      return {
        actions: [],
        note: `Unresolved original inventory read: ${String(delivered.gap)}. No cleanup or broker authority.`,
      };
    }
    assert.equal(delivered.sourceSha256, artifact.sha256);
    assert.equal(delivered.selectedValue, source.ownerCoverage.changeImpact.source);
    return {
      actions: [],
      note: `Retain actual index field ${delivered.selectedValue}; child change-impact output is inventory evidence, not proof of mind-model/flow/candidate-review consumption.`,
      evidenceUse: [
        {
          artifactId: artifact.id,
          sourceSha256: artifact.sha256,
          field,
          effect: "retain",
          reason:
            "The delivered original index records a change-impact child output; cleanup remains unapproved and full owner handoffs remain missing.",
        },
      ],
    };
  });
  await cycle((input) => {
    assert.ok(input.backlog.some((entry) => entry.note === receipts[1].brainCall.note));
    return {
      actions: [],
      note: "Preserve the exact prior result and gaps; no scheduler, provider or cleanup invocation.",
    };
  });
  // Only one actual original producer is represented. Other phases must not be invented from its fields.
  const evidence: WorkflowHandoffEvidence = {
    scenarioId: "universe_index_total_coverage_waterflow",
    environment: "offline_fixture",
    nodes: [
      {
        nodeId: "universe_index",
        scope: { path: originalReceiptPath, pointer: "/repoRoot", sha256: artifact.sha256 },
        output: { path: originalReceiptPath, pointer: "/ownerCoverage", sha256: artifact.sha256 },
      },
    ],
  };
  const audit = (await auditWorkflowHandoffs([evidence])).find(
    (entry) => entry.scenarioId === evidence.scenarioId,
  )!;
  return {
    sourcePath: originalReceiptPath,
    sourceSha256: artifact.sha256,
    sourceObservedAt: source.checkedAt,
    originalSourceReused: true,
    newUniverseOwnerRuns: 0,
    artifact,
    field,
    receipts,
    inputs,
    evidence,
    audit,
    fault,
    privateSourcePath: localPath,
    rawSourceUnchanged: sha(await fs.readFile(originalReceiptPath)) === artifact.sha256,
    semanticAdoption: "offline_scripted_only_natural_not_proven",
    wholeSceneComplete: false,
  };
}
