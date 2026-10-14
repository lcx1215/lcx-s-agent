import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
} from "../../scripts/operator/lcx-self-repair-hands.js";
import {
  compactReceipts,
  type CompactBacklogEntry,
  runCentralHarnessCycle,
} from "../../src/agents/central-harness/harness-loop.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import type {
  CentralActionPlan,
  CentralPerception,
  CentralRunReceipt,
} from "../../src/agents/central-harness/types.js";

export type MemoryCorrectionFault =
  | "missing_source"
  | "source_hash"
  | "correction_hash"
  | "account_scope"
  | "run_scope"
  | "rule_drift"
  | "stale_source"
  | "future_source"
  | "missing_downrank"
  | "protected_unknown";
const sha = (body: string) => createHash("sha256").update(body).digest("hex");

/** Actual original writer/reviewer/tools; only the reasoning consumer is scripted. */
export async function probeOriginalMemoryCorrection(
  workspaceDir: string,
  fault?: MemoryCorrectionFault,
  replacementRule = "require current source before reuse",
  gateRepoDir = path.resolve(import.meta.dirname, "../.."),
) {
  await fs.mkdir(path.join(workspaceDir, "state"), { recursive: true });
  const scope = { accountId: "paper-offline-memory", runId: "offline-correction-review" };
  const sourcePath = "state/original-source.json";
  const source = {
    scope: {
      accountId: fault === "account_scope" ? "different-account" : scope.accountId,
      runId: fault === "run_scope" ? "different-run" : scope.runId,
    },
    observedAt: new Date(
      Date.now() +
        (fault === "future_source" ? 60000 : fault === "stale_source" ? -8 * 86400000 : -1000),
    ).toISOString(),
    replacementRule: fault === "rule_drift" ? "invented correction" : replacementRule,
    sourceTrust: "offline_fixture_not_market_truth",
  };
  const sourceBody = `${JSON.stringify(source, null, 2)}\n`;
  await fs.writeFile(path.join(workspaceDir, sourcePath), sourceBody);
  const writer = buildSelfRepairHandsReceipt({
    checkedAt: new Date().toISOString(),
    workspaceDir,
    signalKey: scope.runId,
    issue: "original_correction_review_handoff",
    observedFailure: "Old memory lacks current source evidence.",
    replacementRule,
    domain: "offline_fixture",
    write: true,
  });
  await writeSelfRepairHandsReceipt(writer);
  const correctionPath = writer.hands.memoryCleaner.relativePath.split(path.sep).join("/");
  if (fault === "missing_downrank") {
    const original = await fs.readFile(writer.hands.memoryCleaner.path, "utf8");
    await fs.writeFile(
      writer.hands.memoryCleaner.path,
      original.replace("keep_downrank_or_discard: downrank", "keep_downrank_or_discard: keep"),
    );
  }
  const correctionBody = await fs.readFile(writer.hands.memoryCleaner.path, "utf8");
  const manifest = {
    schemaVersion: 1,
    correction: {
      path: correctionPath,
      sha256: fault === "correction_hash" ? "0".repeat(64) : sha(correctionBody),
    },
    source: {
      path: sourcePath,
      sha256: fault === "source_hash" ? "0".repeat(64) : sha(sourceBody),
    },
  };
  const manifestPath = path.join(workspaceDir, "state/review-input.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const protectedStatus = path.join(workspaceDir, "protected-status.txt");
  if (fault !== "protected_unknown") {
    await fs.writeFile(protectedStatus, "");
  }
  if (fault === "missing_source") {
    await fs.unlink(path.join(workspaceDir, sourcePath));
  }
  const cli = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(gateRepoDir, "scripts/operator/lcx-system-memory-sedimentation-gate.ts"),
      "--workspace",
      workspaceDir,
      "--protected-status",
      protectedStatus,
      "--correction-review",
      manifestPath,
      "--review-account-id",
      scope.accountId,
      "--review-run-id",
      scope.runId,
      "--json",
    ],
    { cwd: gateRepoDir, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const gate = JSON.parse(cli.stdout) as {
    status: string;
    recallClaimReady: boolean;
    blockers: string[];
    correctionReview?: {
      status: string;
      replacementRule?: string;
      blockers: string[];
      reuseAllowed: false;
    };
  };
  const gatePath = path.join(workspaceDir, "state/review-consumer.json");
  await fs.writeFile(gatePath, cli.stdout);
  const registry = new Map(
    [
      ...createCentralToolRegistry({
        workspaceDir,
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
              memorySearch: {
                enabled: true,
                store: { path: path.join(workspaceDir, "private-artifacts.sqlite") },
              },
            },
          },
        },
      }),
    ].filter(([id]) => ["memory_get", "artifact_memory_recall"].includes(id)),
  );
  const receipts: CentralRunReceipt[] = [];
  const perceptions: CentralPerception[] = [];
  // Read back the actual persisted reviewer receipt, rather than reusing its producer object.
  const consumedReview = JSON.parse(await fs.readFile(gatePath, "utf8")) as typeof gate;
  const cycle = async (propose: (input: CentralPerception) => CentralActionPlan) => {
    const perception: CentralPerception = {
      observedAt: new Date().toISOString(),
      ownerTotals: {},
      controlRoom: { memoryReview: consumedReview },
      backlog: compactReceipts(receipts, 10, new Set(registry.keys())),
      boundaries: ["offline_scripted", "broker_unknown_remains_blocked", "no_execution_authority"],
    };
    perceptions.push(perception);
    const receipt = await runCentralHarnessCycle({
      perception,
      registry,
      capabilityOwnerIds: new Set(registry.keys()),
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
    await fs.writeFile(
      path.join(workspaceDir, "state", `memory-cycle-${receipts.length}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return receipt;
  };
  const review = consumedReview.correctionReview;
  if (!consumedReview.recallClaimReady || review?.status !== "verified_provisional_downrank") {
    await cycle((input) => ({
      actions: [],
      note: `Unresolved memory review: ${JSON.stringify(input.controlRoom.memoryReview)}; broker remains unknown and blocked.`,
    }));
  } else {
    const from = correctionBody.split("\n").findIndex((line) => line === "## Replacement Rule") + 1;
    const read = await cycle(() => ({
      actions: [{ ownerId: "memory_get", args: { path: correctionPath, from, lines: 3 } }],
      note: "Read the source-checked provisional correction body.",
    }));
    const artifact = read.steps[0].resultArtifact;
    assert.ok(artifact?.id && artifact.sha256);
    await cycle(() => ({
      actions: [
        {
          ownerId: "artifact_memory_recall",
          args: { action: "read", id: artifact.id, field: "/value/text" },
        },
      ],
      note: "Deliver the exact archived correction text.",
    }));
    await cycle((input) => {
      const delivered = input.backlog
        .flatMap((entry) => (entry.outcomes ?? []) as CompactBacklogEntry["outcomes"])
        .find(
          (step) =>
            step.outcome?.artifactId === artifact.id && step.outcome?.field === "/value/text",
        );
      const text = delivered?.outcome?.selectedValue;
      assert.ok(typeof text === "string", "selected correction body must actually be text");
      assert.ok(text.includes(review.replacementRule!));
      return {
        actions: [],
        note: `Keep old memory downranked; ${text}; broker remains unknown and blocked.`,
        evidenceUse: [
          {
            artifactId: artifact.id!,
            sourceSha256: artifact.sha256!,
            field: "/value/text",
            effect: "change",
            reason: `Apply the delivered provisional correction: ${review.replacementRule}; current source still required for reuse.`,
          },
        ],
      };
    });
    await cycle((input) => {
      assert.ok(
        input.backlog.some((entry) => String(entry.note).includes("Keep old memory downranked")),
        "actual previous result must enter the next input",
      );
      return {
        actions: [],
        note: "Retain downrank from actual prior receipt; no reuse or execution authority.",
      };
    });
  }
  return {
    writer,
    source,
    manifest,
    gate,
    consumedReview,
    gatePath,
    correctionBody,
    correctionPath,
    receipts,
    perceptions,
    feedbackObserved: receipts.length === 4,
    semanticAdoption: "offline_scripted_only_natural_not_proven",
    wholeScene: "partial_original_owner_handoffs_prewrite_source_review_not_implemented",
  };
}
