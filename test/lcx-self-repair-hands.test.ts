import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
} from "../scripts/operator/lcx-self-repair-hands.ts";

describe("LCX self-repair hands", () => {
  it("retains previous candidate versions and their review boundary after revised feedback", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-versions-"));
    const input = {
      checkedAt: "2026-10-08T07:00:00.000Z",
      workspaceDir,
      signalKey: "snapshot_read_feedback",
      issue: "snapshot_read_failure",
      observedFailure: "a failed snapshot read looked like an empty system",
      replacementRule: "carry an explicit read failure into the next perception",
      domain: "perception_evidence",
      write: true,
    };
    try {
      const original = buildSelfRepairHandsReceipt(input);
      await writeSelfRepairHandsReceipt(original);
      const versionPaths = [
        original.hands.memoryCleaner.path,
        original.hands.trainingCaseBuilder.path,
        original.hands.patchCandidateBuilder.path,
      ];
      const priorBytes = await Promise.all(versionPaths.map((file) => fs.readFile(file)));
      const revised = buildSelfRepairHandsReceipt({
        ...input,
        checkedAt: "2026-10-08T07:01:00.000Z",
        replacementRule:
          "carry explicit read failures and clear them after a fresh successful read",
      });
      await writeSelfRepairHandsReceipt(revised);
      for (const [index, file] of versionPaths.entries()) {
        expect(await fs.readFile(file)).toEqual(priorBytes[index]);
        expect(revised.writtenArtifacts).not.toContain(file);
      }
      const latest = JSON.parse(await fs.readFile(revised.latestJsonPath, "utf8"));
      expect(latest.hands.patchCandidateBuilder.candidate.proposedPatchContract).toMatchObject({
        candidateOnly: true,
        canEditRepoSource: false,
        canCommit: false,
        ownerReviewRequired: true,
      });
      expect(latest.hands.trainingCaseBuilder.candidate.absorptionStatus).toBe(
        "candidate_only_not_in_train_slice",
      );
      const history = (await fs.readFile(revised.jsonlPath, "utf8")).trim().split("\n");
      expect(history.map((line) => JSON.parse(line).checkedAt)).toEqual([
        input.checkedAt,
        revised.checkedAt,
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("builds a supervised dry-run for memory correction, training candidates, and patch candidates", () => {
    const receipt = buildSelfRepairHandsReceipt({
      checkedAt: "2026-05-29T06:00:00.000Z",
      workspaceDir: "/tmp/lcx-self-repair",
      signalKey: "test_stale_rate_rule",
      issue: "stale_rate_rule",
      observedFailure: "old memory said rate cuts always help QQQ",
      replacementRule:
        "rate cuts require growth, real-yield, credit, valuation, and liquidity checks",
      domain: "finance_memory_rule_downrank",
      write: false,
    });

    expect(receipt).toEqual(
      expect.objectContaining({
        ok: true,
        kind: "lcx-self-repair-hands",
        boundary: "local_self_repair_hands_only",
        status: "dry_run_ready",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(receipt.hands.memoryCleaner.canWriteWithoutCodex).toBe(true);
    expect(receipt.hands.memoryCleaner.correctionMarkdown).toContain("Downrank Decision");
    expect(receipt.hands.trainingCaseBuilder.canWriteWithoutCodex).toBe(true);
    expect(receipt.hands.trainingCaseBuilder.candidate.absorptionStatus).toBe(
      "candidate_only_not_in_train_slice",
    );
    expect(receipt.hands.patchCandidateBuilder.canWriteWithoutCodex).toBe(true);
    expect(receipt.hands.patchCandidateBuilder.candidate.boundary).toBe(
      "local_repo_patch_candidate_only_not_applied",
    );
    expect(
      receipt.hands.patchCandidateBuilder.candidate.proposedPatchContract.canEditRepoSource,
    ).toBe(false);
    expect(receipt.notTouched).toEqual(
      expect.arrayContaining([
        "repo_source",
        "git_index",
        "git_commit",
        "external_channel_sender",
        "provider_config",
        "protected_memory",
        "training_processes",
      ]),
    );
  });

  it("writes only allowlisted workspace memory/state/log artifacts", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-self-repair-"));
    const receipt = buildSelfRepairHandsReceipt({
      checkedAt: "2026-05-29T06:05:00.000Z",
      workspaceDir,
      signalKey: "test_blog_alpha_overclaim",
      issue: "blog_alpha_overclaim",
      observedFailure: "investment blog was treated like direct alpha",
      replacementRule:
        "blogs stay hypothesis-only until source grade, official evidence, market follow-through, review, and downrank decision exist",
      domain: "weak_source_training_candidate",
      write: true,
    });

    await writeSelfRepairHandsReceipt(receipt);

    const correction = await fs.readFile(receipt.hands.memoryCleaner.path, "utf8");
    const candidate = JSON.parse(
      await fs.readFile(receipt.hands.trainingCaseBuilder.path, "utf8"),
    ) as { boundary: string; absorptionStatus: string };
    const patchCandidate = JSON.parse(
      await fs.readFile(receipt.hands.patchCandidateBuilder.path, "utf8"),
    ) as {
      boundary: string;
      proposedPatchContract: { ownerReviewRequired: boolean; canCommit: boolean };
    };
    const latest = JSON.parse(await fs.readFile(receipt.latestJsonPath, "utf8")) as {
      status: string;
      writtenArtifacts: string[];
      signalKey: string;
    };
    const markdown = await fs.readFile(receipt.latestMarkdownPath, "utf8");
    const jsonl = await fs.readFile(receipt.jsonlPath, "utf8");

    expect(correction).toContain("local_self_repair_memory_correction_only");
    expect(candidate.boundary).toBe("local_training_candidate_only_not_absorbed");
    expect(candidate.absorptionStatus).toBe("candidate_only_not_in_train_slice");
    expect(patchCandidate.boundary).toBe("local_repo_patch_candidate_only_not_applied");
    expect(patchCandidate.proposedPatchContract.ownerReviewRequired).toBe(true);
    expect(patchCandidate.proposedPatchContract.canCommit).toBe(false);
    expect(latest.status).toBe("write_completed");
    expect(latest.signalKey).toBe("test_blog_alpha_overclaim");
    expect(latest.writtenArtifacts).toEqual(expect.arrayContaining(receipt.writtenArtifacts));
    expect(markdown).toContain("三只手");
    expect(markdown).toContain("补丁候选手");
    expect(jsonl).toContain("lcx-self-repair-hands");
    for (const filePath of receipt.writtenArtifacts) {
      expect(path.relative(workspaceDir, filePath).startsWith("..")).toBe(false);
    }
  });
});
