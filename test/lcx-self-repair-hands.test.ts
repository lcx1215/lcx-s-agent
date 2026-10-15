import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
} from "../scripts/operator/lcx-self-repair-hands.ts";
import * as safeFs from "../src/infra/fs-safe.js";

async function saveWriterProof(
  name: string,
  receipt: ReturnType<typeof buildSelfRepairHandsReceipt>,
) {
  const root = process.env.LCX_SELF_REPAIR_WRITER_PROOF_DIR;
  if (!root) {
    return;
  }
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  const files = [];
  for (const [index, originalPath] of receipt.writtenArtifacts.entries()) {
    const body = await fs.readFile(originalPath);
    const savedPath = `${index}-${path.basename(originalPath)}`;
    await fs.writeFile(path.join(directory, savedPath), body);
    files.push({
      originalPath,
      savedPath,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    });
  }
  await fs.writeFile(
    path.join(directory, "proof.json"),
    `${JSON.stringify({ receipt, files }, null, 2)}\n`,
  );
}

describe("LCX self-repair hands", () => {
  it("uses explicit CLI manifest and host identity, persisting blocked instead of candidate files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-cli-source-"));
    try {
      const manifestPath = path.join(workspaceDir, "review-input.json");
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          source: { path: "state/missing-source.json", sha256: "0".repeat(64) },
        }),
      );
      const cli = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/lcx-self-repair-hands.ts",
          "--workspace-dir",
          workspaceDir,
          "--source-review",
          manifestPath,
          "--review-account-id",
          "private-paper",
          "--review-run-id",
          "private-run",
          "--write",
          "--json",
        ],
        { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30000 },
      );
      expect(cli.status, cli.stderr).toBe(0);
      const receipt = JSON.parse(cli.stdout) as ReturnType<typeof buildSelfRepairHandsReceipt>;
      expect(receipt).toMatchObject({
        status: "blocked",
        reuseAllowed: false,
        sourceReview: { requested: true, blockers: ["source_evidence_unreadable"] },
      });
      const persisted = JSON.parse(await fs.readFile(receipt.latestJsonPath, "utf8"));
      expect(persisted).toMatchObject({
        status: "blocked",
        processEvidence: {
          gates: { source: "blocked", reasons: ["source_evidence_unreadable"] },
          writer: {
            publication: "pending_in_snapshot",
            diskReadback: "not_observed",
            publicationInputs: { candidateWritesAllowed: false },
          },
        },
      });
      expect(receipt.processEvidence?.writer.publication).toBe("completed_after_await");
      expect(receipt.processEvidence?.gates).toMatchObject({
        consumedSource: { status: "blocked" },
        candidateWritesAllowed: false,
      });
      expect(receipt.processEvidence?.writer.candidateEligibility).toBe(false);
      expect(receipt.processEvidence?.writer.successfulWrites.map((item) => item.field)).toEqual([
        "/latestMarkdownPath",
        "/jsonlPath",
        "/latestJsonPath",
      ]);
      await saveWriterProof("source-blocked", receipt);
      await expect(fs.access(receipt.hands.memoryCleaner.path)).rejects.toThrow();
      await expect(fs.access(receipt.hands.trainingCaseBuilder.path)).rejects.toThrow();
      await expect(fs.access(receipt.hands.patchCandidateBuilder.path)).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
  it("keeps a failed source review terminal even when an earlier valid read completes late", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-late-source-"));
    await fs.mkdir(path.join(workspaceDir, "state"));
    const source = {
      scope: { accountId: "private-paper", runId: "private-run" },
      observedAt: new Date(Date.now() - 1000).toISOString(),
      replacementRule: "require current evidence",
    };
    const sourceBody = JSON.stringify(source);
    const sourcePath = path.join(workspaceDir, "state/source.json");
    await fs.writeFile(sourcePath, sourceBody);
    const receipt = buildSelfRepairHandsReceipt({
      checkedAt: new Date().toISOString(),
      workspaceDir,
      signalKey: "late-source",
      issue: "late_source",
      observedFailure: "missing evidence",
      replacementRule: source.replacementRule,
      domain: "private-fixture",
      write: true,
      sourceReview: {
        schemaVersion: 1,
        source: {
          path: "state/source.json",
          sha256: createHash("sha256").update(sourceBody).digest("hex"),
        },
        expectedScope: source.scope,
      },
    });
    let release!: () => void;
    let entered!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalRead = safeFs.readFileWithinRoot;
    const spy = vi.spyOn(safeFs, "readFileWithinRoot").mockImplementationOnce(async (args) => {
      const result = await originalRead(args);
      entered();
      await delayed;
      return result;
    });
    try {
      const late = writeSelfRepairHandsReceipt(receipt);
      await started;
      await fs.appendFile(sourcePath, "\n");
      await writeSelfRepairHandsReceipt(receipt);
      expect(receipt.sourceReview).toMatchObject({
        status: "blocked",
        blockers: ["source_sha256_mismatch"],
      });
      release();
      await late;
      expect(JSON.parse(await fs.readFile(receipt.latestJsonPath, "utf8"))).toMatchObject({
        status: "blocked",
        sourceReview: { status: "blocked" },
        processEvidence: { writer: { publicationInputs: { candidateWritesAllowed: false } } },
      });
      await expect(fs.access(receipt.hands.memoryCleaner.path)).rejects.toThrow();
      // Even repairing the private source cannot resurrect this failed receipt.
      await fs.writeFile(sourcePath, sourceBody);
      await writeSelfRepairHandsReceipt(receipt);
      expect(receipt.status).toBe("blocked");
      await expect(fs.access(receipt.hands.trainingCaseBuilder.path)).rejects.toThrow();
    } finally {
      release();
      spy.mockRestore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("persists malformed explicit review as blocked while preserving older candidate bytes", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-source-block-"));
    const input = {
      checkedAt: "2026-10-11T07:00:00Z",
      workspaceDir,
      signalKey: "preserve-prior",
      issue: "source-missing",
      observedFailure: "missing evidence",
      replacementRule: "require current source",
      domain: "private-fixture",
      write: true,
    };
    try {
      const old = buildSelfRepairHandsReceipt(input);
      await writeSelfRepairHandsReceipt(old);
      const prior = await fs.readFile(old.hands.memoryCleaner.path);
      const blocked = buildSelfRepairHandsReceipt({
        ...input,
        sourceReview: {
          schemaVersion: 1,
          expectedScope: { accountId: "private", runId: "private" },
        },
      });
      await writeSelfRepairHandsReceipt(blocked);
      expect(blocked).toMatchObject({
        status: "blocked",
        sourceReview: { blockers: ["source_review_manifest_invalid"] },
      });
      expect(await fs.readFile(old.hands.memoryCleaner.path)).toEqual(prior);
      expect(blocked.writtenArtifacts).toEqual([
        blocked.latestMarkdownPath,
        blocked.jsonlPath,
        blocked.latestJsonPath,
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
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
    expect(receipt.writtenArtifacts).toEqual([]);
    expect(receipt.processEvidence?.writer.status).toBe("not_started");
    expect(receipt.processEvidence?.branches).toHaveLength(3);
    expect(
      new Set(receipt.processEvidence?.branches.map((branch) => branch.inputSha256)).size,
    ).toBe(1);
    expect(receipt.processEvidence?.branches[0]?.intendedBytes).toEqual({
      sha256: createHash("sha256")
        .update(`${receipt.hands.memoryCleaner.correctionMarkdown}\n`)
        .digest("hex"),
      bytes: Buffer.byteLength(`${receipt.hands.memoryCleaner.correctionMarkdown}\n`),
    });
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
    expect(latest.writtenArtifacts).toEqual(
      receipt.writtenArtifacts.filter((file) => file !== receipt.latestJsonPath),
    );
    expect(receipt.processEvidence?.writer).toMatchObject({
      status: "completed",
      publication: "completed_after_await",
      diskReadback: "not_observed",
    });
    for (const [index, file] of receipt.writtenArtifacts.entries()) {
      const bytes = await fs.readFile(file);
      expect(receipt.processEvidence?.writer.successfulWrites[index]).toMatchObject({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    }
    const persistedEvidence = JSON.parse(
      await fs.readFile(receipt.latestJsonPath, "utf8"),
    ).processEvidence;
    expect(persistedEvidence.writer).toMatchObject({
      status: "writing",
      publication: "pending_in_snapshot",
    });
    expect(
      persistedEvidence.writer.successfulWrites.some(
        (item: { field: string }) => item.field === "/latestJsonPath",
      ),
    ).toBe(false);
    const evidence = receipt.processEvidence;
    expect(evidence?.gates.candidateWritesAllowed).toBe(true);
    expect(evidence?.writer.candidateEligibility).toBe(true);
    expect(evidence?.branches.map((branch) => branch.inputSha256)).toEqual(
      Array(3).fill(evidence?.input?.sha256),
    );
    for (const [index, branch] of (evidence?.branches ?? []).entries()) {
      expect(evidence?.gates.consumedPaths?.[index]).toEqual({
        field: branch.field,
        pathSha256: branch.pathSha256,
      });
      const actualPath = [
        receipt.hands.memoryCleaner.path,
        receipt.hands.trainingCaseBuilder.path,
        receipt.hands.patchCandidateBuilder.path,
      ][index];
      expect(branch.pathSha256).toBe(createHash("sha256").update(actualPath).digest("hex"));
    }
    expect(persistedEvidence.writer.publicationInputs).toMatchObject(
      persistedEvidence.writer.publicationSource,
    );
    expect(persistedEvidence.writer.publicationInputs).toEqual({
      candidateWritesAllowed: true,
      successfulWritesSha256: createHash("sha256")
        .update(JSON.stringify(persistedEvidence.writer.successfulWrites))
        .digest("hex"),
      memoryTier: receipt.hands.memoryCleaner.memoryTier,
      correctionSha256: createHash("sha256")
        .update(await fs.readFile(receipt.hands.memoryCleaner.path))
        .digest("hex"),
      trainingSha256: createHash("sha256")
        .update(await fs.readFile(receipt.hands.trainingCaseBuilder.path))
        .digest("hex"),
    });
    expect(Buffer.byteLength(JSON.stringify(receipt.processEvidence))).toBeLessThan(4096);
    await saveWriterProof("successful-writes", receipt);
    const readback = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/lcx-self-repair-hands.ts",
        "--json",
        "--workspace-dir",
        workspaceDir,
      ],
      { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30000 },
    );
    expect(readback.status, readback.stderr).toBe(0);
    expect(JSON.parse(readback.stdout).latestWrittenReceipt.processEvidence).toEqual(
      JSON.parse(await fs.readFile(receipt.latestJsonPath, "utf8")).processEvidence,
    );
    expect(markdown).toContain("三只手");
    expect(markdown).toContain("补丁候选手");
    expect(jsonl).toContain("lcx-self-repair-hands");
    for (const filePath of receipt.writtenArtifacts) {
      expect(path.relative(workspaceDir, filePath).startsWith("..")).toBe(false);
    }
  });
  it("keeps construction pending and preserves successful prefix on actual second-file write failure", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-partial-"));
    const input = {
      checkedAt: "2026-10-12T07:00:00Z",
      workspaceDir,
      signalKey: "private-partial",
      issue: "partial",
      observedFailure: "source unavailable",
      replacementRule: "require evidence",
      domain: "private-fixture",
      write: true,
    };
    const previous = buildSelfRepairHandsReceipt({ ...input, checkedAt: "2026-10-12T06:00:00Z" });
    await writeSelfRepairHandsReceipt(previous);
    const priorLatest = await fs.readFile(previous.latestJsonPath);
    const receipt = buildSelfRepairHandsReceipt(input);
    expect(receipt.status).toBe("awaiting_write");
    expect(receipt.writtenArtifacts).toEqual([]);
    const originalWrite = fs.writeFile;
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, body, options) => {
      if (file === receipt.hands.trainingCaseBuilder.path) {
        throw new Error("private_injected_second_write_failure");
      }
      return originalWrite(file, body, options);
    });
    try {
      await expect(writeSelfRepairHandsReceipt(receipt)).rejects.toThrow(
        "private_injected_second_write_failure",
      );
      expect(receipt).toMatchObject({
        ok: false,
        status: "write_failed",
        processEvidence: {
          writer: {
            status: "failed",
            failure: {
              field: "/hands/trainingCaseBuilder/candidate",
              persistence: "not_confirmed",
            },
          },
        },
      });
      expect(receipt.writtenArtifacts).toEqual([receipt.hands.memoryCleaner.path]);
      expect(receipt.processEvidence?.writer.successfulWrites).toHaveLength(1);
      expect(await fs.readFile(receipt.latestJsonPath)).toEqual(priorLatest);
      await expect(fs.access(receipt.hands.trainingCaseBuilder.path)).rejects.toThrow();
      spy.mockRestore();
      await expect(writeSelfRepairHandsReceipt(receipt)).rejects.toThrow(
        "self_repair_prior_write_failed",
      );
      expect(receipt.status).toBe("write_failed");
      await saveWriterProof("partial-write-failed", receipt);
    } finally {
      spy.mockRestore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps legacy receipts compatible without claiming their missing original input", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-legacy-"));
    try {
      const receipt = buildSelfRepairHandsReceipt({
        checkedAt: "2026-10-12T07:00:00Z",
        workspaceDir,
        signalKey: "legacy",
        issue: "legacy",
        observedFailure: "missing evidence",
        replacementRule: "require evidence",
        domain: "private",
        write: true,
      });
      receipt.processEvidence = undefined;
      await writeSelfRepairHandsReceipt(receipt);
      expect(receipt.status).toBe("write_completed");
      expect(receipt).toMatchObject({
        processEvidence: { branches: [], writer: { successfulWrites: expect.any(Array) } },
      });
      const persisted = JSON.parse(await fs.readFile(receipt.latestJsonPath, "utf8"));
      expect(persisted.processEvidence.input).toBeUndefined();
      expect(persisted.processEvidence.writer.successfulWrites).toHaveLength(5);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
  it("bounds process evidence without copying long multilingual rule or failure bodies", () => {
    const input = {
      checkedAt: "2026-10-12T07:00:00Z",
      workspaceDir: "/tmp/private-writer",
      signalKey: "budget",
      issue: "来源".repeat(2000),
      observedFailure: "缺失".repeat(2000),
      replacementRule: "仅引用已核来源".repeat(2000),
      domain: "证据".repeat(2000),
      write: true,
    };
    const receipt = buildSelfRepairHandsReceipt(input);
    expect(receipt.processEvidence?.input?.sha256).toBe(
      createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    );
    expect(Buffer.byteLength(JSON.stringify(receipt.processEvidence))).toBeLessThan(4096);
    expect(JSON.stringify(receipt.processEvidence)).not.toContain(input.observedFailure);
    expect(receipt.writtenArtifacts).toEqual([]);
  });
});
