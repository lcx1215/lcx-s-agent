import assert from "node:assert/strict";
import path from "node:path";
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

/** The real registry/archives/recall/loop. An optional owner response is a diagnostic adapter only. */
export async function probeOriginalContextFeedback(
  workspaceDir: string,
  field: string,
  ownerResponse?: Readonly<Record<string, unknown>>,
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
  let ownerCalls = 0;
  const options = {
    workspaceDir,
    config,
    ...(ownerResponse
      ? {
          execute: async (owner: { id: string; args: readonly string[] }) => {
            assert.equal(owner.id, "contextRecovery");
            assert.deepEqual(owner.args, ["--handoff", "--json"]);
            ownerCalls += 1;
            return ownerResponse;
          },
        }
      : {}),
  };
  const ids = new Set(["contextRecovery", "artifact_memory_recall"]);
  const registry = new Map([...createCentralToolRegistry(options)].filter(([id]) => ids.has(id)));
  const receipts: CentralRunReceipt[] = [];
  const perceptions: CentralPerception[] = [];
  const cycle = async (propose: (input: CentralPerception) => CentralActionPlan) => {
    const input: CentralPerception = {
      observedAt: new Date().toISOString(),
      ownerTotals: {},
      controlRoom: {},
      backlog: compactReceipts(receipts, 10, ids),
      boundaries: ["offline_scripted", "broker_unknown_remains_blocked", "no_execution_authority"],
    };
    perceptions.push(input);
    const receipt = await runCentralHarnessCycle({
      perception: input,
      registry,
      brain: {
        propose: async (seen) => ({
          kind: "proposed",
          provider: "offline-fixture",
          modelId: "scripted-consumer",
          plan: propose(seen),
        }),
      },
    });
    receipts.push(receipt);
    return receipt;
  };
  const observed = await cycle(() => ({
    actions: [{ ownerId: "contextRecovery", args: {} }],
    note: "Need the original recovery handoff before judging the source gap.",
  }));
  const artifact = observed.steps[0].resultArtifact;
  assert.ok(artifact?.id && artifact.sha256, "original owner result must be archived");
  const read = await cycle((input) => {
    const prior = input.backlog
      .flatMap(
        (entry) =>
          (entry.outcomes as
            | { ownerId?: string; resultArtifact?: { id?: string } }[]
            | undefined) ?? [],
      )
      .find((step) => step.ownerId === "contextRecovery");
    assert.equal(prior?.resultArtifact?.id, artifact.id);
    return {
      actions: [
        { ownerId: "artifact_memory_recall", args: { action: "read", id: artifact.id, field } },
      ],
      note: "Resolve only the concrete module-source question from the existing owner artifact.",
    };
  });
  assert.equal(read.steps[0].outcome?.available, true);
  assert.equal(read.steps[0].outcome?.sourceSha256, artifact.sha256);
  const judgment = await cycle((input) => {
    const delivered = input.backlog
      .flatMap(
        (entry) => (entry.outcomes as { outcome?: Record<string, unknown> }[] | undefined) ?? [],
      )
      .find(
        (step) => step.outcome?.artifactId === artifact.id && step.outcome?.field === field,
      )?.outcome;
    assert.ok(
      delivered && Object.hasOwn(delivered, "selectedValue"),
      "selected owner content must reach the next input",
    );
    const value = delivered.selectedValue;
    let effect: "retain" | "unresolved";
    let reason: string;
    if (value === "hold_at_application_ready") {
      effect = "retain";
      reason =
        "Retain the original application-ready hold; recovery is not eval absorption or broker confirmation.";
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).ok === false
    ) {
      const source = value as Record<string, unknown>;
      effect = "unresolved";
      reason = `Cannot judge module absorption: ${String(source.summary)}. Broker remains unconfirmed and blocked.`;
    } else {
      throw new Error("unexpected original module source content");
    }
    return {
      actions: [],
      note: reason,
      evidenceUse: [
        { artifactId: artifact.id!, sourceSha256: artifact.sha256!, field, effect, reason },
      ],
    };
  });
  assert.equal(
    judgment.evidenceUse?.[0].verification,
    judgment.evidenceUse?.[0].effect === "unresolved" ? "unresolved" : "reference_verified",
  );
  assert.ok(judgment.evidenceUse?.[0].sourceValueSha256);
  assert.equal(judgment.evidenceUse?.[0].gap, undefined);
  assert.equal(judgment.steps.length, 0);
  return {
    artifact,
    ownerCalls,
    receipts,
    perceptions,
    selectedValue: read.steps[0].outcome?.selectedValue,
    judgment: judgment.evidenceUse,
    semanticAdoption: "offline_scripted_only_natural_not_proven",
  };
}
