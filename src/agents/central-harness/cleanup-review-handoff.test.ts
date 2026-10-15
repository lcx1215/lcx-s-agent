import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCleanupReviewProbe,
  type CleanupReviewFault,
} from "../../../test/fixtures/lcx-waterflow-cleanup-review-probe.js";
import { recordAgentArtifact } from "../artifact-result-recording.js";
import {
  compactCleanupReview,
  projectCleanupReview,
  reviewCleanupBeforeDecision,
} from "./cleanup-review-handoff.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(fault?: CleanupReviewFault) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network forbidden");
    }),
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cleanup-before-decision-"));
  roots.push(root);
  const original = await buildCleanupReviewProbe(root, fault);
  const completedOwners = original.governance.ownerCommands.map((row) => ({
    id: row.id,
    ok: row.ok,
    runReceipt: row.runReceipt,
    compact: original.governance.owners[row.id] as Record<string, unknown>,
  }));
  const config = {
    agents: {
      defaults: {
        memorySearch: {
          enabled: true,
          store: { path: path.join(root, "private-artifacts.sqlite") },
        },
      },
    },
  };
  return { ...original, completedOwners, host: { ...original.host, config } };
}
async function replaceCandidates(
  setup: Awaited<ReturnType<typeof fixture>>,
  candidates: Record<string, unknown[]>,
) {
  const original = JSON.parse(
    await fs.readFile(path.join(setup.host.rootDir, setup.sources.universeIndex.path), "utf8"),
  ) as { runId: string; observedAt: string; value: Record<string, unknown> };
  const recording = await recordAgentArtifact({
    config: setup.host.config,
    agentId: "main",
    workspaceDir: setup.host.rootDir,
    owner: "universeIndex",
    runId: original.runId,
    observedAt: original.observedAt,
    value: { ...original.value, garbageCandidates: candidates },
  });
  const row = setup.completedOwners.find((owner) => owner.id === "universeIndex")!;
  row.compact = { artifactEvidence: recording };
}
const emptyCandidates = () => ({
  untrackedRepoFiles: [],
  unmatchedChangedFiles: [],
  staleRuntimeFiles: [],
  largeRuntimeFiles: [],
  staleSnapshots: [],
});

async function saveHandoff(
  setup: Awaited<ReturnType<typeof fixture>>,
  result: Awaited<ReturnType<typeof reviewCleanupBeforeDecision>>,
  name: string,
) {
  const proof = process.env.LCX_WATERFLOW_PROOF_DIR;
  if (proof) {
    const directory = path.join(proof, name);
    await fs.cp(setup.host.rootDir, directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "handoff-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
}

describe("original cleanup predecision handoff", () => {
  it("archives the original completed-owner builder and actually consumes its three pinned archives", async () => {
    const setup = await fixture();
    await fs.unlink(path.join(setup.host.rootDir, "governance.json"));
    const result = await reviewCleanupBeforeDecision(setup.completedOwners, setup.host);
    expect(result.review.status).toBe("reviewed");
    expect(result.selectedCandidates).toBe(3);
    expect(result.omittedCandidates).toBe(0);
    expect(result.review.dispositions.map((row) => row.disposition)).toEqual([
      "preserve",
      "unknown",
      "unknown",
    ]);
    expect(result.predecisionArtifact.status).toBe("registered");
    const raw = JSON.parse(
      await fs.readFile(
        path.join(setup.host.rootDir, result.predecisionArtifact.relativePath!),
        "utf8",
      ),
    );
    expect(raw).toMatchObject({
      owner: "lcx-governance-autopilot",
      runId: setup.host.parentRunId,
      value: {
        schemaVersion: "lcx_central_governance_input_v1",
        phase: "before_central_decision",
        parentRunId: setup.host.parentRunId,
      },
    });
    expect(result.review.sourceReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer: "/value/byOwner/mindModel/runReceipt" }),
        expect.objectContaining({ pointer: "/value/checks/0/ok", value: true }),
      ]),
    );
    expect(fetch).not.toHaveBeenCalled();
    const proof = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proof) {
      await fs.cp(setup.host.rootDir, path.join(proof, "handoff-positive"), { recursive: true });
      await fs.writeFile(
        path.join(proof, "handoff-positive-result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
  });
  it.each<CleanupReviewFault>([
    "hash",
    "missing",
    "parent",
    "snapshot",
    "run",
    "binding",
    "quality",
  ])("returns blocked %s without throwing the host", async (fault) => {
    const setup = await fixture(fault);
    const result = await reviewCleanupBeforeDecision(setup.completedOwners, setup.host);
    expect(result.review.status).toBe("blocked");
    expect(result.review.reason).not.toBe("cleanup_review_not_completed");
    expect(result.review.dispositions).toEqual([]);
    expect(result.review.cleanupAuthorized).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await saveHandoff(setup, result, `handoff-fault-${fault}`);
  });
  it("names the missing original source owner", async () => {
    const setup = await fixture();
    setup.completedOwners.find((row) => row.id === "mindModel")!.compact = {};
    const result = await reviewCleanupBeforeDecision(setup.completedOwners, setup.host);
    expect(result.review.reason).toBe("cleanup_review_source_ref_missing:mindModel");
    await saveHandoff(setup, result, "handoff-source-ref-missing");
  });
  it("null artifact config degrades to an explicit block", async () => {
    const setup = await fixture();
    const result = await reviewCleanupBeforeDecision(setup.completedOwners, {
      ...setup.host,
      config: null,
    });
    expect(result.review.status).toBe("blocked");
    expect(result.review.reason).toBe("cleanup_review_artifact_config_unavailable");
    expect(result.predecisionArtifact.status).toBe("unavailable");
    await saveHandoff(setup, result, "handoff-null-config");
  });
  it("empty candidates still validate all three sources", async () => {
    const setup = await fixture();
    await replaceCandidates(setup, emptyCandidates());
    const result = await reviewCleanupBeforeDecision(setup.completedOwners, setup.host);
    expect(result.review.status).toBe("reviewed");
    expect(result.selectedCandidates).toBe(0);
    expect(result.review.sourceReads).toEqual(
      expect.arrayContaining([expect.objectContaining({ pointer: "/value/checks/0/ok" })]),
    );
    await saveHandoff(setup, result, "handoff-empty-positive");
    const failed = await fixture("quality");
    await replaceCandidates(failed, emptyCandidates());
    const blocked = await reviewCleanupBeforeDecision(failed.completedOwners, failed.host);
    expect(blocked.review.status).toBe("blocked");
    await saveHandoff(failed, blocked, "handoff-empty-quality-block");
  });
  it("selects at most 256 exact pointers and reports omitted candidates without inflating the decision input", async () => {
    const setup = await fixture();
    await replaceCandidates(setup, {
      ...emptyCandidates(),
      untrackedRepoFiles: Array.from(
        { length: 300 },
        (_, index) => `.artifacts/unowned/${index}.json`,
      ),
    });
    const result = await reviewCleanupBeforeDecision(setup.completedOwners, setup.host);
    expect(result.review.status).toBe("reviewed");
    expect(result.selectedCandidates).toBe(256);
    expect(result.omittedCandidates).toBe(44);
    const summary = compactCleanupReview(result.review, result);
    expect(summary).toMatchObject({
      status: "reviewed",
      count: 256,
      unknown: 256,
      preserve: 0,
      selectedCandidates: 256,
      omittedCandidates: 44,
      cleanupAuthorized: false,
    });
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(1200);
    expect(summary).not.toHaveProperty("dispositions");
    expect(summary).not.toHaveProperty("sourceReads");
    await saveHandoff(setup, result, "handoff-overflow");
  });
});

describe("bounded cleanup projection", () => {
  it.each([undefined, null, [], { status: "reviewed" }, { dispositions: [] }])(
    "malformed summaries are explicit blocks: %j",
    (value) => {
      expect(projectCleanupReview(value).status).toBe("blocked");
      expect(compactCleanupReview(value, undefined).status).toBe("blocked");
    },
  );
  it("uses a whitelist and UTF-8 byte limits for hostile oversized strings and source bodies", () => {
    const valid = {
      status: "reviewed",
      reason: "证据😀".repeat(10000),
      count: 0,
      preserve: 0,
      unknown: 0,
      selectedCandidates: 0,
      omittedCandidates: 123,
      coverage: "selected_candidates_only",
      missingChecks: Array.from({ length: 30 }, () => "未检验😀".repeat(1000)),
      missingChecksOmitted: 0,
      semanticTruth: "not_proven",
      cleanupAuthorized: false,
      dispositions: { privateBody: "x".repeat(100000) },
      sourceReads: { privateBody: "x".repeat(100000) },
      detailPointers: { sourceReads: "evil" },
    };
    const summary = projectCleanupReview(valid);
    expect(summary.status).toBe("reviewed");
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(1200);
    expect(summary.detailPointers.sourceReads).toBe("/value/cleanupReview/sourceReads");
    expect(summary.missingChecksOmitted).toBe(26);
    expect(summary).not.toHaveProperty("sourceReads");
    expect(summary).not.toHaveProperty("dispositions");
    expect(projectCleanupReview({ ...valid, cleanupAuthorized: true }).status).toBe("blocked");
    expect(projectCleanupReview({ ...valid, count: 1 }).status).toBe("blocked");
    expect(projectCleanupReview({ ...valid, omittedCandidates: Infinity }).status).toBe("blocked");
  });
});
