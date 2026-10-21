import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  readExternalCandidateCapture,
  resolveExternalChannelTruth,
  selectBindingOwnerPayload,
} from "../scripts/operator/lcx-external-channel-status.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runStatus(args: string[]) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-external-channel-status.ts", ...args],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("lcx-external-channel-status", () => {
  it.each([
    "channel_runtime_probe_failed",
    "ready_for_channel_bind_apply",
    "unrecognized",
    "channel_runtime_probe_ok_user_visible_pending",
  ])(
    "rejects a visible claim contradicting canonical %s while retaining the reported observation",
    (status) => {
      const truth = resolveExternalChannelTruth({
        binding: { status, userVisibleObserved: true },
        bindingOwnerAvailable: true,
        legacyExternalChannelStatus: { externalChannelBound: true, userVisibleObserved: true },
        visibleProof: { status: "user_visible_observed", acceptanceMatched: true },
      });
      expect(truth.userVisibleObserved).toBe(false);
      expect(truth.visibleProofObservation).toEqual({
        reported: true,
        adoptedForCurrentBinding: false,
        reason: "binding_probe_or_visible_status_not_confirmed",
      });
    },
  );
  it("adopts a matching canonical observed status and keeps raw external proof separate", () => {
    expect(
      resolveExternalChannelTruth({
        binding: {
          status: "channel_runtime_probe_ok_user_visible_observed",
          userVisibleObserved: true,
        },
        bindingOwnerAvailable: true,
        legacyExternalChannelStatus: undefined,
        visibleProof: undefined,
      }),
    ).toEqual({
      externalChannelBound: true,
      userVisibleObserved: true,
      bindingStatus: "channel_runtime_probe_ok_user_visible_observed",
    });
  });
  it("does not let legacy compatibility evidence override the binding owner", () => {
    expect(
      resolveExternalChannelTruth({
        binding: {
          status: "deferred_active_training_or_eval",
          userVisibleObserved: false,
        },
        legacyExternalChannelStatus: {
          externalChannelBound: true,
          userVisibleObserved: true,
        },
        visibleProof: {
          status: "user_visible_observed",
          acceptanceMatched: true,
        },
      }),
    ).toEqual({
      externalChannelBound: false,
      userVisibleObserved: false,
      bindingStatus: "deferred_active_training_or_eval",
    });
  });

  it("fails closed when the canonical binding owner is unavailable", () => {
    expect(
      resolveExternalChannelTruth({
        binding: undefined,
        bindingOwnerAvailable: false,
        legacyExternalChannelStatus: {
          externalChannelBound: true,
          userVisibleObserved: true,
        },
        visibleProof: {
          status: "user_visible_observed",
          acceptanceMatched: true,
        },
      }),
    ).toEqual({
      externalChannelBound: false,
      userVisibleObserved: false,
      bindingStatus: "unavailable",
    });
  });

  it("never substitutes a stale latest snapshot after owner failure", () => {
    expect(
      selectBindingOwnerPayload({
        commandSucceeded: false,
        payload: {
          externalChannelBinding: {
            status: "channel_runtime_probe_ok_user_visible_observed",
            userVisibleObserved: true,
          },
        },
      }),
    ).toEqual({ payload: {}, source: "unavailable" });
  });

  it("wraps legacy promote-live status as a read-only external-channel owner", async () => {
    const payload = await runStatus(["--json"]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_external_channel_status_only",
        owner: "lcx-external-channel-status",
        conceptStatus: "legacy_promote_live_status_wrapped_by_external_channel_status",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.externalChannelStatus).toEqual(
      expect.objectContaining({
        statusModel: "core-ready -> external-channel-bound -> user-visible-observed",
        canonicalBindingOwner: "lcx-external-channel-binding",
        canonicalBindingStatus: expect.any(String),
        nextHumanStep: expect.not.stringContaining("promote_local_to_live"),
        userVisibleObserved: expect.any(Boolean),
      }),
    );
    expect(payload.ownerChildStatus).toEqual(
      expect.objectContaining({
        bindingStatusAvailable: expect.any(Boolean),
        bindingStatusSource: expect.stringMatching(/^(command|unavailable)$/u),
        bindingLatestPath: expect.stringContaining("lcx-external-channel-binding-latest.json"),
      }),
    );
    const ownerChildStatus = payload.ownerChildStatus as { bindingStatusAvailable?: boolean };
    if (ownerChildStatus.bindingStatusAvailable === true) {
      expect(payload.externalChannelBinding).toEqual(
        expect.objectContaining({
          boundary: "local_external_channel_binding_operator_only",
        }),
      );
    } else {
      expect(payload.externalChannelStatus).toEqual(
        expect.objectContaining({
          canonicalBindingStatus: "unavailable",
          nextHumanStep: "inspect_lcx_external_channel_binding_owner",
        }),
      );
    }
    expect(payload.visibleProof).toEqual(
      expect.objectContaining({
        replyFlowProbeCommand:
          "node --import tsx scripts/operator/lcx-external-channel-status.ts --json --with-probe",
        legacyReplyFlowProbeCommand: expect.stringContaining("lcx-external-channel-compat.ts"),
      }),
    );
    const externalChannelStatus = payload.externalChannelStatus as {
      externalChannelBound?: boolean;
    };
    expect(payload).not.toHaveProperty("devLiveDrift");
    expect(payload).not.toHaveProperty("legacyLegacyRepoLiveDrift");
    const canonicalWorktreeDrift = payload.canonicalWorktreeDrift as
      | {
          repositoryDrift?: unknown;
          liveNeedsPromotion?: unknown;
        }
      | undefined;
    if (externalChannelStatus.externalChannelBound === true) {
      expect(canonicalWorktreeDrift).toEqual(
        expect.objectContaining({
          repositoryDrift: "external_channel_bound_legacy_commit_diff_ignored",
          liveNeedsPromotion: false,
        }),
      );
    }
    expect(payload.legacyPromoteLiveStatus).toEqual(
      expect.objectContaining({
        owner: "lcx-external-channel-compat",
        boundary: "local_external_channel_status_only",
        devLiveDrift: expect.any(Object),
        visibleProof: expect.any(Object),
      }),
    );
  });
});

describe("offline capture artifacts", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });
  const capturePath = "memory/external-brain-distillation-candidates/capture.json";
  const candidate = (
    id: number,
    status = "pending_brain_review",
    source = "external_user_utterance",
  ) => ({
    id: `candidate-${id}`,
    source,
    status,
    boundary: "brain_distillation_candidate",
    createdAt: "2026-10-21T00:00:00Z",
  });
  const review = (
    accepted: ReturnType<typeof candidate>[],
    rejected: ReturnType<typeof candidate>[],
    sourceArtifacts = [capturePath],
  ) => ({
    schemaVersion: 1,
    boundary: "brain_distillation_review",
    reviewedAt: "2026-10-21T01:00:00Z",
    sourceArtifacts,
    acceptedCandidates: accepted.map((entry) => ({ ...entry, status: "accepted_brain_plan" })),
    rejectedCandidates: rejected.map(({ id, source }) => ({
      id,
      source,
      reason: "fixture rejection",
    })),
  });
  async function workspace(files: Record<string, unknown>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-capture-status-"));
    roots.push(root);
    for (const [file, value] of Object.entries(files)) {
      const fullPath = path.join(root, file);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, JSON.stringify(value));
    }
    return root;
  }
  const artifact = (candidates: ReturnType<typeof candidate>[]) => ({
    schemaVersion: 1,
    boundary: "brain_distillation_candidate",
    generatedAt: "2026-10-21T00:00:00Z",
    candidates,
  });

  it("joins reviewed arrays to original capture identity/source and deduplicates receipts", async () => {
    const candidates = Array.from({ length: 10 }, (_, id) => candidate(id));
    const reviewed = review(candidates.slice(0, 8), candidates.slice(8));
    const root = await workspace({
      [capturePath]: artifact(candidates),
      "memory/external-brain-distillation-candidates/duplicate.json": artifact(candidates),
      "memory/external-brain-distillation-reviews/review.json": reviewed,
      "memory/external-brain-distillation-reviews/duplicate.json": reviewed,
    });
    const status = await readExternalCandidateCapture(root);
    expect(status).toMatchObject({
      candidateCount: 10,
      acceptedCandidateCount: 8,
      rejectedCandidateCount: 2,
      reviewedCandidateCount: 10,
      pendingCandidateCount: 0,
      reviewArtifactCount: 2,
      invalidArtifactCount: 0,
    });
    expect(status.currentReplay.rejectedRate).toBe(0.2);
    expect(status.replayLoop.status).toBe("ready_for_reviewed_batch_absorption");
  });

  it.each(["pending_brain_review", "discarded"])(
    "does not inflate reviewed threshold with %s",
    async (status) => {
      const candidates = [
        candidate(0, "accepted_brain_plan"),
        ...Array.from({ length: 99 }, (_, id) => candidate(id + 1, status)),
      ];
      const root = await workspace({ [capturePath]: artifact(candidates) });
      const result = await readExternalCandidateCapture(root);
      expect(result.candidateCount).toBe(100);
      expect(result.reviewedCandidateCount).toBe(1);
      expect(result.replayLoop.status).toBe("needs_review_promotion");
    },
  );

  it("keeps pending out of ready even after ten accepted dispositions", async () => {
    const root = await workspace({
      [capturePath]: artifact([
        ...Array.from({ length: 10 }, (_, id) => candidate(id, "accepted_brain_plan")),
        candidate(10),
      ]),
    });
    const status = await readExternalCandidateCapture(root);
    expect(status.reviewedCandidateCount).toBe(10);
    expect(status.pendingCandidateCount).toBe(1);
    expect(status.replayLoop.status).toBe("needs_review_promotion");
  });

  it("does not dilute reviewed rejection rate with discarded candidates", async () => {
    const root = await workspace({
      [capturePath]: artifact([
        candidate(0, "accepted_brain_plan"),
        candidate(1, "rejected_brain_plan"),
        ...Array.from({ length: 100 }, (_, id) => candidate(id + 2, "discarded")),
      ]),
    });
    const status = await readExternalCandidateCapture(root);
    expect(status.currentReplay.rejectedRate).toBe(0.5);
    expect(status.reviewedCandidateCount).toBe(2);
    expect(status.replayLoop.status).toBe("needs_route_family_hardening");
  });

  it("reports teacher review separately without inventing natural capture", async () => {
    const teachers = Array.from({ length: 12 }, (_, id) =>
      candidate(id, "accepted_brain_plan", "teacher_review"),
    );
    const root = await workspace({
      "memory/external-brain-distillation-reviews/teacher.json": review(
        teachers,
        [candidate(99, "rejected_brain_plan", "teacher_review")],
        ["minimax_teacher_batch:fixture"],
      ),
    });
    const status = await readExternalCandidateCapture(root);
    expect(status).toMatchObject({
      candidateCount: 0,
      reviewArtifactCount: 1,
      teacherReviewAcceptedCount: 12,
      teacherReviewRejectedCount: 1,
      acceptedCandidateCount: 0,
      rejectedCandidateCount: 0,
      invalidArtifactCount: 0,
    });
    expect(status.replayLoop.status).toBe("needs_candidate_capture");
    expect(status.currentReplay.source).toBe("none");
  });

  it("does not join reviews with wrong origin or same IDs from teacher source", async () => {
    const candidates = Array.from({ length: 10 }, (_, id) => candidate(id));
    const root = await workspace({
      [capturePath]: artifact(candidates),
      "memory/external-brain-distillation-reviews/wrong-origin.json": review(
        candidates,
        [],
        ["memory/external-brain-distillation-candidates/other.json"],
      ),
      "memory/external-brain-distillation-reviews/teacher.json": review(
        candidates.map((entry) => ({ ...entry, source: "teacher_review" })),
        [],
      ),
    });
    const status = await readExternalCandidateCapture(root);
    expect(status).toMatchObject({
      candidateCount: 10,
      reviewedCandidateCount: 0,
      pendingCandidateCount: 10,
      unmatchedReviewCandidateCount: 10,
      teacherReviewAcceptedCount: 10,
    });
    expect(status.replayLoop.status).toBe("needs_review_promotion");
  });

  it("retains conflicting reviews as pending instead of depending on file order", async () => {
    const candidates = [candidate(0)];
    const root = await workspace({
      [capturePath]: artifact(candidates),
      "memory/external-brain-distillation-reviews/accept.json": review(candidates, []),
      "memory/external-brain-distillation-reviews/reject.json": review([], candidates),
    });
    const status = await readExternalCandidateCapture(root);
    expect(status).toMatchObject({
      candidateCount: 1,
      reviewedCandidateCount: 0,
      pendingCandidateCount: 1,
    });
  });
});
