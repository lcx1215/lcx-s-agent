import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { reviewUniverseCleanup } from "../../scripts/operator/lcx-change-impact-plan.js";
import { recordAgentArtifact } from "../../src/agents/artifact-result-recording.js";
import { buildCentralGovernanceInput } from "../../src/agents/central-harness/governance-input.js";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
  createLcxRunSnapshot,
} from "../../src/shared/lcx-run-receipt.js";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export type CleanupReviewFault =
  | "missing"
  | "hash"
  | "field"
  | "parent"
  | "snapshot"
  | "run"
  | "binding"
  | "quality"
  | "schema"
  | "host";

/** Original archive writer and run contracts; source owner IO is an explicit offline substitute. */
export async function buildCleanupReviewProbe(
  rootDir: string,
  fault?: CleanupReviewFault,
  retained?: { universePath: string; repoRoot: string },
  predecision = false,
) {
  const checkedAt = "2026-10-11T00:00:00.000Z";
  const repoRoot = retained?.repoRoot ?? path.resolve(import.meta.dirname, "../..");
  const snapshot = createLcxRunSnapshot({
    observedAt: checkedAt,
    sourceCommit: "offline-no-git",
    sourceBranch: "offline-fixture",
    authorityOwner: "lcx-governance-autopilot",
  });
  const parentRunId = createLcxRunId({
    checkedAt,
    owner: "lcx-governance-autopilot",
    key: "offline-cleanup-review",
  });
  const host = { rootDir, repoRoot, parentRunId, snapshot };
  const config = {
    agents: {
      defaults: {
        memorySearch: {
          enabled: true,
          store: { path: path.join(rootDir, "private-artifacts.sqlite") },
        },
      },
    },
  };
  const sources: Record<string, { path: string; sha256: string }> = {};
  const owners: Record<string, unknown> = {};
  const ownerCommands = [];
  const values = {
    universeIndex: {
      ok: true,
      checkedAt,
      repoRoot,
      boundary: "local_universe_index_only",
      garbageCandidates: {
        untrackedRepoFiles: [
          "docs/lcx-capability-review-20260702.md",
          ".artifacts/unowned/report.json",
        ],
        unmatchedChangedFiles: [],
        staleRuntimeFiles: [],
        largeRuntimeFiles: [],
        staleSnapshots: [{ id: "lcx-governance-autopilot-latest", stale: true }],
      },
    },
    mindModel: {
      ok: true,
      checkedAt,
      boundary: "local_mind_model_only",
      lanes: [{ id: "offline-source-substitute", ok: true }],
      invariants: [{ id: "offline-boundaries", ok: true }],
    },
    flowGraph: {
      ok: true,
      checkedAt,
      boundary: "local_flow_graph_only",
      checks: [{ id: "offline-structure-only", ok: fault !== "quality" }],
      summary: { proofLevel: "structure_only" },
    },
    contextRecovery: {
      ok: true,
      checkedAt,
      boundary: "local_context_recovery_exam_only",
      compressedContextRecovered: true,
      checks: [{ id: "offline-recovery-source-substitute", ok: true }],
    },
  };
  const retainedBytes = retained ? await fs.readFile(retained.universePath) : undefined;
  for (const id of ["universeIndex", "mindModel", "flowGraph", "contextRecovery"] as const) {
    const runId = createLcxRunId({ checkedAt, owner: id, key: "offline-source-substitute" });
    const runReceipt = buildLcxRunReceipt({
      runId,
      parentRunId: fault === "parent" && id === "universeIndex" ? "other-parent" : parentRunId,
      owner: id,
      phase: "observe",
      status: "passed",
      checkedAt,
      snapshot,
      boundary: boundaryFromFlags({ scope: "offline_fixture" }),
      nextAction: "Offline source substitute; no original owner execution or cleanup authority.",
    });
    if (fault === "snapshot" && id === "mindModel") {
      runReceipt.snapshot = { ...snapshot, snapshotId: "other-snapshot" };
    }
    const value: unknown =
      id === "universeIndex" && retainedBytes
        ? JSON.parse(retainedBytes.toString("utf8"))
        : values[id];
    const observedAt = (value as { checkedAt: string }).checkedAt;
    const recording = await recordAgentArtifact({
      config,
      agentId: "main",
      workspaceDir: rootDir,
      owner: id,
      runId: fault === "run" && id === "flowGraph" ? "other-run" : runId,
      observedAt,
      value,
      ...(id === "universeIndex" && retained ? { sourceReceiptRefs: [retained.universePath] } : {}),
    });
    assert.equal(recording.status, "registered");
    assert.ok(recording.relativePath && recording.sha256);
    sources[id] = { path: recording.relativePath, sha256: recording.sha256 };
    owners[id] = {
      artifactEvidence:
        fault === "binding" && id === "mindModel"
          ? { ...recording, sha256: "0".repeat(64) }
          : recording,
    };
    ownerCommands.push({ id, parsed: true, ok: true, runReceipt });
  }
  const runReceipt = buildLcxRunReceipt({
    runId: parentRunId,
    owner: "lcx-governance-autopilot",
    phase: "observe",
    status: "passed",
    checkedAt,
    snapshot,
    boundary: boundaryFromFlags({ scope: "offline_fixture" }),
    nextAction: "Only private IO substitutes were archived.",
  });
  const governance = { runId: parentRunId, snapshot, runReceipt, ownerCommands, owners };
  const governanceBytes = `${JSON.stringify(governance, null, 2)}\n`;
  if (!predecision) {
    await fs.writeFile(path.join(rootDir, "governance.json"), governanceBytes);
  }
  let governanceRef = { path: "governance.json", sha256: sha(governanceBytes) };
  if (predecision) {
    const beforeCentral = buildCentralGovernanceInput(
      ownerCommands.map((row) => ({
        id: row.id,
        ok: row.ok,
        runReceipt: row.runReceipt,
        compact: owners[row.id] as Record<string, unknown>,
      })),
      { parentRunId, snapshot, checkedAt },
    );
    const archive = await recordAgentArtifact({
      config,
      agentId: "main",
      workspaceDir: rootDir,
      owner: "lcx-governance-autopilot",
      runId: parentRunId,
      observedAt: checkedAt,
      value: beforeCentral,
    });
    assert.equal(archive.status, "registered");
    assert.ok(archive.relativePath && archive.sha256);
    governanceRef = { path: archive.relativePath, sha256: archive.sha256 };
  }
  const input = {
    schemaVersion: 1,
    governance: governanceRef,
    sources: {
      universeIndex: sources.universeIndex,
      mindModel: sources.mindModel,
      flowGraph: sources.flowGraph,
    },
    candidates: [
      "/value/garbageCandidates/untrackedRepoFiles/0",
      "/value/garbageCandidates/untrackedRepoFiles/1",
      "/value/garbageCandidates/staleSnapshots/0",
    ],
    ...(fault === "schema" ? { expectedScope: snapshot } : {}),
  };
  if (fault === "hash") {
    await fs.appendFile(path.join(rootDir, sources.universeIndex.path), " ");
  }
  if (fault === "field") {
    input.candidates[0] = "/value/garbageCandidates/untrackedRepoFiles/99";
  }
  if (fault === "missing") {
    await fs.unlink(path.join(rootDir, sources.universeIndex.path));
  }
  if (fault === "host") {
    host.parentRunId = "";
  }
  await fs.writeFile(
    path.join(rootDir, "review-input.json"),
    `${JSON.stringify(input, null, 2)}\n`,
  );
  return {
    input,
    host,
    governance,
    sources,
    retainedSha256: retainedBytes ? sha(retainedBytes) : undefined,
  };
}

export async function probeCleanupReview(
  rootDir: string,
  fault?: CleanupReviewFault,
  predecision = false,
) {
  const fixture = await buildCleanupReviewProbe(rootDir, fault, undefined, predecision);
  const result = await reviewUniverseCleanup(fixture.input, fixture.host);
  const receiptPath = path.join(rootDir, "cleanup-review.json");
  await fs.writeFile(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
  // Read the new consumer's durable result, not a relabeled producer field.
  const persisted = JSON.parse(await fs.readFile(receiptPath, "utf8")) as typeof result;
  return {
    ...fixture,
    result: persisted,
    receiptPath,
    receiptSha256: sha(await fs.readFile(receiptPath)),
    environment: "offline_fixture" as const,
    originalOwnerRuns: 0,
  };
}
