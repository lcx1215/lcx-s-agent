import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
} from "../scripts/dev/lcx-self-repair-hands.ts";

describe("LCX self-repair hands", () => {
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
        boundary: "dev_self_repair_hands_only",
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
      "dev_repo_patch_candidate_only_not_applied",
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

    expect(correction).toContain("dev_self_repair_memory_correction_only");
    expect(candidate.boundary).toBe("dev_training_candidate_only_not_absorbed");
    expect(candidate.absorptionStatus).toBe("candidate_only_not_in_train_slice");
    expect(patchCandidate.boundary).toBe("dev_repo_patch_candidate_only_not_applied");
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
