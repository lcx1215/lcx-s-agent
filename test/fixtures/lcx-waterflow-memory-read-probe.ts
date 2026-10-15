import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
} from "../../scripts/operator/lcx-self-repair-hands.js";
import {
  compactReceipts,
  runCentralHarnessCycle,
} from "../../src/agents/central-harness/harness-loop.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import type {
  CentralActionPlan,
  CentralPerception,
  CentralRunReceipt,
} from "../../src/agents/central-harness/types.js";
import type { OpenClawConfig } from "../../src/config/config.js";

/** Native owners and storage with a scripted consumer; no natural-model adoption claim. */
export async function probeOriginalMemoryReadFeedback(
  workspaceDir: string,
  replacementRule: string,
  options: { omitRecallAction?: boolean } = {},
) {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          enabled: true,
          store: { path: path.join(workspaceDir, "private-artifacts.sqlite") },
        },
      },
    },
  };
  const writer = buildSelfRepairHandsReceipt({
    checkedAt: new Date().toISOString(),
    workspaceDir,
    signalKey: "offline_memory_read_handoff",
    issue: "offline_correction_body_handoff",
    observedFailure: "A correction filename alone does not show the replacement rule.",
    replacementRule,
    domain: "offline_fixture",
    write: true,
  });
  await writeSelfRepairHandsReceipt(writer);
  const sourcePath = writer.hands.memoryCleaner.path;
  const sourceBody = await fs.readFile(sourcePath, "utf8");
  const sourceSha256 = createHash("sha256").update(sourceBody).digest("hex");
  const relPath = path.relative(workspaceDir, sourcePath).split(path.sep).join("/");
  const from = sourceBody.split("\n").findIndex((line) => line === "## Replacement Rule") + 1;
  assert.ok(from > 0);
  const capabilities = new Set(["memory_get", "artifact_memory_recall"]);
  const registry = new Map(
    [...createCentralToolRegistry({ workspaceDir, config })].filter(([id]) => capabilities.has(id)),
  );
  const receipts: CentralRunReceipt[] = [];
  const perceptions: CentralPerception[] = [];
  const cycle = async (propose: (input: CentralPerception) => CentralActionPlan) => {
    const perception: CentralPerception = {
      observedAt: new Date().toISOString(),
      ownerTotals: {},
      controlRoom: {},
      backlog: compactReceipts(receipts, 10, capabilities),
      boundaries: ["offline_scripted", "broker_unknown_remains_blocked", "no_execution_authority"],
    };
    perceptions.push(perception);
    const receipt = await runCentralHarnessCycle({
      perception,
      registry,
      capabilityOwnerIds: capabilities,
      planOnly: true,
      brain: {
        propose: async (input) => ({
          kind: "proposed",
          provider: "offline-fixture",
          modelId: "scripted-consumer",
          plan: propose(input),
        }),
      },
    });
    receipts.push(receipt);
    return receipt;
  };
  const read = await cycle(() => ({
    actions: [{ ownerId: "memory_get", args: { path: relPath, from, lines: 3 } }],
    note: "Read the original writer's specific provisional replacement rule.",
  }));
  const artifact = read.steps[0].resultArtifact;
  assert.ok(artifact?.id && artifact.sha256);
  const field = "/value/text";
  if (options.omitRecallAction) {
    const failed = await cycle(() => ({
      actions: [{ ownerId: "artifact_memory_recall", args: { id: artifact.id, field } }],
      note: "Reproduce the natural missing-action proposal without inferring an action.",
    }));
    assert.equal(failed.steps[0].outcome?.gap, "artifact_action_required");
    assert.equal(failed.steps[0].outcome?.available, false);
  }
  const recalled = await cycle((input) => {
    if (options.omitRecallAction) {
      const gap = input.backlog
        .flatMap(
          (entry) => (entry.outcomes as { outcome?: Record<string, unknown> }[] | undefined) ?? [],
        )
        .find((step) => step.outcome?.gap === "artifact_action_required")?.outcome;
      assert.ok(gap, "specific argument gap must enter the next original input");
      assert.deepEqual(gap.requiredArgs, ["action"]);
    }
    return {
      actions: [
        { ownerId: "artifact_memory_recall", args: { action: "read", id: artifact.id, field } },
      ],
      note: "Deliver the exact archived text with the explicitly chosen required action.",
    };
  });
  const selection = recalled.steps[0].outcome;
  assert.equal(selection?.available, true);
  assert.equal(selection?.sourceSha256, artifact.sha256);
  const judgment = await cycle((input) => {
    const delivered = input.backlog
      .flatMap(
        (entry) => (entry.outcomes as { outcome?: Record<string, unknown> }[] | undefined) ?? [],
      )
      .find((step) => step.outcome?.artifactId === artifact.id && step.outcome?.field === field);
    const selectedText = delivered?.outcome?.selectedValue;
    assert.equal(selectedText, selection?.selectedValue);
    assert.equal(typeof selectedText, "string");
    const needsCurrentSource = String(selectedText).includes("require current source before reuse");
    const reason = needsCurrentSource
      ? "Require current source before reuse; keep the unknown broker blocked."
      : "Retain the scoped provenance check; keep the unknown broker blocked.";
    return {
      actions: [],
      note: reason,
      evidenceUse: [
        {
          artifactId: artifact.id!,
          sourceSha256: artifact.sha256!,
          field,
          effect: needsCurrentSource ? "change" : "retain",
          reason,
        },
      ],
    };
  });
  const missing = await registry
    .get("memory_get")!
    .execute(
      { path: "memory/self-repair/correction-downrank/absent.md", lines: 3 },
      new AbortController().signal,
    );
  assert.equal(missing.missing, true);
  assert.equal(await fs.readFile(sourcePath, "utf8"), sourceBody);
  return {
    writer,
    sourcePath,
    sourceSha256,
    relPath,
    from,
    originalText: sourceBody
      .split("\n")
      .slice(from - 1, from + 2)
      .join("\n"),
    artifact,
    selectedText: selection?.selectedValue,
    field,
    receipts,
    perceptions,
    judgment: judgment.evidenceUse,
    missing,
    sourceUnchanged: true,
    semanticAdoption: "offline_scripted_only_natural_not_proven",
  };
}
