import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import { withRealpathSymlinkRebindRace } from "../src/test-utils/symlink-rebind-race.js";
import {
  produceOriginalPrewriteRecall,
  readOriginalPrewriteContentReview,
  type HistoricalRecallFault,
  type PrewriteRecallFault,
  probeOriginalSelfRepairSameAttempt,
} from "./fixtures/lcx-waterflow-self-repair-prewrite-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const before = process.env.LCX_SELF_REPAIR_PREWRITE_BEFORE === "1";
describe.skipIf(before)("original latest candidate root byte observation", () => {
  it("pins actual readonly CLI root bytes without inferring review host or preserving a rewritten old hash", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-self-repair-root-pin-"));
    roots.push(directory);
    const produced = await produceOriginalPrewriteRecall({ directory });
    const reviewed = await readOriginalPrewriteContentReview(produced);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const rootPath = produced.current.receipt.latestJsonPath;
    const oldSha256 = digest(produced.current.receiptBytes);
    const missingHostPayload: unknown = JSON.parse(reviewed.missingHost.stdout);
    const completePayload: unknown = JSON.parse(reviewed.complete.stdout);
    const rootIdentity = {
      receipt: { path: rootPath, sha256: oldSha256 },
      sourceReview: { scope: produced.currentScope },
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
    };
    const changedBytes = `${produced.current.receiptBytes}\n`;
    await fs.writeFile(rootPath, changedBytes);
    const changed = await promisify(execFile)(process.execPath, reviewed.missingHost.argv, {
      cwd: path.resolve(import.meta.dirname, ".."),
      timeout: 30_000,
    });
    const changedPayload: unknown = JSON.parse(changed.stdout);
    const evidence = process.env.LCX_SELF_REPAIR_PREWRITE_PROOF_DIR;
    if (evidence) {
      const destination = path.join(evidence, "root-byte-observation");
      await fs.mkdir(destination, { recursive: true });
      await fs.cp(directory, path.join(destination, "private-bytes"), { recursive: true });
      await fs.writeFile(
        path.join(destination, "native-result.json"),
        JSON.stringify(
          {
            produced,
            reviewed,
            oldSha256,
            changedSha256: digest(changedBytes),
            changed,
            changedPayload,
          },
          null,
          2,
        ) + "\n",
      );
      await fs.writeFile(
        path.join(destination, "prior-root-bytes.json"),
        produced.current.receiptBytes,
      );
    }
    expect(completePayload).toMatchObject({ latestWrittenReceipt: rootIdentity });
    expect(missingHostPayload).toMatchObject({
      latestWrittenReceipt: rootIdentity,
      contentReview: { status: "not_observed", gaps: ["self_repair_memory_host_unavailable"] },
    });
    expect(digest(changedBytes)).not.toBe(oldSha256);
    expect(changedPayload).toMatchObject({
      latestWrittenReceipt: {
        ...rootIdentity,
        receipt: { path: rootPath, sha256: digest(changedBytes) },
      },
      contentReview: { status: "not_observed", gaps: ["self_repair_memory_host_unavailable"] },
    });
    expect(await fs.readFile(rootPath, "utf8")).toBe(changedBytes);
    expect(
      await fs.readFile(
        path.join(produced.workspaceDir, "state/lcx-self-repair-content-review-latest.json"),
        "utf8",
      ),
    ).toBe(reviewed.sidecarBefore);
  });
});
describe.skipIf(before)("same-attempt original self-repair consumers", () => {
  it("accepts a canonical producer map through a stable workspace alias", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-prewrite-map-alias-"));
    roots.push(directory);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
    const result = await probeOriginalSelfRepairSameAttempt({
      directory,
      scenario: "read",
      observeNextFeedback: true,
      canonicalProducerMap: true,
    });
    expect(result.nextFeedback?.completed.diagnosticFeedback?.status).toBe("read");
    expect(
      result.scenarioAudit?.gaps.filter(
        (gap) =>
          gap.reason.startsWith("feedback_read_") ||
          gap.reason === "consumer_did_not_receive_output:owner_coverage_map",
      ),
    ).toEqual([]);
  });

  it("rejects a producer map in a retargeted workspace after pinning the original root", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-prewrite-map-rebind-"));
    roots.push(directory);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
    const result = await probeOriginalSelfRepairSameAttempt({
      directory,
      scenario: "read",
      observeNextFeedback: true,
      canonicalProducerMap: true,
    });
    const next = result.nextFeedback!;
    const alias = next.completed.workspaceDir;
    const other = path.join(directory, "other-workspace");
    await fs.cp(result.produced.workspaceDir, other, { recursive: true });
    const otherMap = path.join(other, path.relative(result.produced.workspaceDir, result.mapPath));
    expect(await fs.readFile(otherMap)).toEqual(await fs.readFile(result.mapPath));
    const input = result.auditInput.map((scenario) => ({
      ...scenario,
      nodes: scenario.nodes.map((node) =>
        node.nodeId === "owner_coverage_map"
          ? {
              ...node,
              scope: { ...node.scope, path: otherMap },
              output: node.output ? { ...node.output, path: otherMap } : undefined,
              inputs: node.inputs?.map((input) => ({
                ...input,
                value: { ...input.value, path: otherMap },
              })),
            }
          : node,
      ),
    }));
    const audit = await withRealpathSymlinkRebindRace({
      shouldFlip: (filePath) => filePath === next.completed.latestJsonPath,
      symlinkPath: alias,
      symlinkTarget: other,
      timing: "after-realpath",
      run: () => auditWorkflowHandoffs(input),
    });
    const observed = audit.find((entry) => entry.scenarioId === "self_repair_hands_waterflow");
    expect(await fs.realpath(alias), JSON.stringify(observed?.gaps)).toBe(await fs.realpath(other));
    expect(
      observed?.gaps.some((gap) => gap.reason === "feedback_read_current_map_pin_mismatch"),
    ).toBe(true);
  });

  it.each(["read", "missing_memory", "review_timeout"] as const)(
    "retains original scope and propagates the %s outcome through review, governance and owner feedback",
    async (scenario) => {
      const retained = process.env.LCX_SELF_REPAIR_PREWRITE_PROOF_DIR;
      if (retained) {
        await fs.mkdir(retained, { recursive: true });
      }
      const directory = await fs.mkdtemp(
        path.join(retained ?? os.tmpdir(), "lcx-prewrite-same-attempt-"),
      );
      if (!retained) {
        roots.push(directory);
      }
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
      try {
        const result = await probeOriginalSelfRepairSameAttempt({
          directory,
          scenario,
          observeNextFeedback: scenario === "read",
        });
        if (retained) {
          const snapshotDir = path.join(retained, `same-attempt-${scenario}`);
          await fs.cp(directory, snapshotDir, {
            recursive: true,
          });
          const relocate = (ref: { path: string; sha256: string; pointer: string }) => ({
            ...ref,
            path: path.join(snapshotDir, path.relative(directory, ref.path)),
          });
          // Archive copies keep their original native provenance; qualified feedback reads use those retained paths.
          const retainedInput = result.nextFeedback
            ? result.auditInput
            : result.auditInput.map((entry) => ({
                ...entry,
                nodes: entry.nodes.map((node) => ({
                  ...node,
                  scope: relocate(node.scope),
                  output: node.output ? relocate(node.output) : undefined,
                  inputs: node.inputs?.map((input) => ({ ...input, value: relocate(input.value) })),
                })),
              }));
          const retainedAudit = (await auditWorkflowHandoffs(retainedInput)).find(
            (entry) => entry.scenarioId === "self_repair_hands_waterflow",
          );
          expect(retainedAudit).toEqual(result.scenarioAudit);
          await fs.writeFile(
            path.join(snapshotDir, "retained-audit-input.json"),
            JSON.stringify(retainedInput, null, 2) + "\n",
          );
          await fs.writeFile(
            path.join(snapshotDir, "retained-audit.json"),
            JSON.stringify(retainedAudit, null, 2) + "\n",
          );
        }
        if (scenario !== "missing_memory") {
          const linked = structuredClone(result.auditInput);
          const nodes = linked[0].nodes;
          const memory = nodes.find((node) => node.nodeId === "memory_recall")!;
          const consumer = nodes.find((node) => node.nodeId === "source_conflict_review")!;
          memory.scope = { ...memory.scope, pointer: "/invocation" };
          const reference = (pointer: string) => ({ ...consumer.scope, pointer });
          const input = consumer.inputs!.find((entry) => entry.from === "memory_recall")!;
          input.scopeBinding = {
            kind: "verified_memory_read",
            receipt: reference("/sourceReview/memoryRecall/artifact"),
            sourceScope: reference("/sourceReview/memoryRecall/artifact/invocation"),
            workspace: reference("/workspaceDir"),
            memoryRecall: reference("/sourceReview/memoryRecall"),
            expectedMemoryScope: reference("/sourceReviewRequest/expectedMemoryScope"),
            artifactStorePath: reference("/sourceReviewRequest/artifactStorePath"),
          };
          const audited = (await auditWorkflowHandoffs(linked)).find(
            (entry) => entry.scenarioId === "self_repair_hands_waterflow",
          )!;
          expect(audited.gaps).not.toContainEqual(
            expect.objectContaining({ reason: "handoff_scope_conflict:memory_recall" }),
          );
          expect(audited.gaps.some((gap) => gap.reason.startsWith("scope_binding_"))).toBe(false);
          expect(result.produced.current.receipt.sourceReview.memoryRecall).toMatchObject({
            scope: result.produced.scope,
            artifact: { invocation: { runId: result.produced.memoryObservationRunId } },
          });
          expect(result.produced.memoryObservationRunId).not.toBe(result.produced.scope.runId);
          expect(result.produced.memoryObservationRunId).not.toBe(
            result.produced.currentScope.runId,
          );
          expect(result.produced.reviewInput?.memoryRecall?.artifact.invocation?.runId).toBe(
            result.produced.memoryObservationRunId,
          );
          if (retained) {
            await fs.writeFile(
              path.join(directory, "verified-memory-read-audit-input.json"),
              JSON.stringify(linked, null, 2) + "\n",
            );
            await fs.writeFile(
              path.join(directory, "verified-memory-read-audit.json"),
              JSON.stringify(audited, null, 2) + "\n",
            );
          }
          if (scenario === "read") {
            expect(result.nextFeedback?.completed.diagnosticFeedback?.status).toBe("read");
            expect(result.nextFeedback?.completed.signalKey).not.toBe(result.host.sourceRunId);
            expect(audited.gaps).not.toContainEqual(
              expect.objectContaining({
                reason: "consumer_did_not_receive_output:owner_coverage_map",
              }),
            );
            expect(audited.gaps).not.toContainEqual(
              expect.objectContaining({ reason: "handoff_scope_conflict:owner_coverage_map" }),
            );
            const plain = structuredClone(linked);
            delete plain[0].feedbackReads;
            const withoutNext = (await auditWorkflowHandoffs(plain)).find(
              (entry) => entry.scenarioId === "self_repair_hands_waterflow",
            )!;
            expect(withoutNext.gaps).toContainEqual(
              expect.objectContaining({
                reason: "consumer_did_not_receive_output:owner_coverage_map",
              }),
            );
            const future = result.nextFeedback!.receipt;
            const futureBytes = await fs.readFile(future.path);
            for (const fault of [
              "duplicate",
              "foreign_map",
              "future_boundary",
              "body_hash",
            ] as const) {
              const rejectedInput = structuredClone(linked);
              const feedbackRead = rejectedInput[0].feedbackReads![0];
              let restoreBody: { path: string; bytes: Buffer } | undefined;
              if (fault === "duplicate") {
                rejectedInput[0].feedbackReads!.push(structuredClone(feedbackRead));
              } else if (fault === "foreign_map") {
                const mapNode = rejectedInput[0].nodes.find(
                  (node) => node.nodeId === "owner_coverage_map",
                )!;
                const copyPath = path.join(directory, "foreign-owner-map-copy.json");
                await fs.writeFile(copyPath, result.mapBytes);
                mapNode.scope = { ...mapNode.scope, path: copyPath };
                mapNode.output = { ...mapNode.output!, path: copyPath };
                mapNode.inputs = mapNode.inputs?.map((port) => ({
                  ...port,
                  value: { ...port.value, path: copyPath },
                }));
              } else if (fault === "future_boundary") {
                const changed = JSON.parse(futureBytes.toString()) as { reuseAllowed: boolean };
                changed.reuseAllowed = true;
                const copyPath = path.join(
                  result.produced.workspaceDir,
                  "state/invalid-future-boundary.json",
                );
                const changedBytes = JSON.stringify(changed);
                await fs.writeFile(copyPath, changedBytes);
                feedbackRead.receipt = {
                  ...future,
                  path: copyPath,
                  sha256: createHash("sha256").update(changedBytes).digest("hex"),
                };
              } else {
                const bodyPath = result.nextFeedback!.completed.hands.memoryCleaner.path;
                restoreBody = { path: bodyPath, bytes: await fs.readFile(bodyPath) };
                await fs.appendFile(bodyPath, "\n");
              }
              try {
                const rejectedNext = (await auditWorkflowHandoffs(rejectedInput)).find(
                  (entry) => entry.scenarioId === "self_repair_hands_waterflow",
                )!;
                expect(
                  rejectedNext.gaps.some((gap) => gap.reason.startsWith("feedback_read_")),
                ).toBe(true);
                expect(rejectedNext.gaps).toContainEqual(
                  expect.objectContaining({
                    reason: "consumer_did_not_receive_output:owner_coverage_map",
                  }),
                );
              } finally {
                if (restoreBody) {
                  await fs.writeFile(restoreBody.path, restoreBody.bytes);
                }
              }
            }
            const malformed = structuredClone(linked);
            const malformedInput = malformed[0].nodes
              .find((node) => node.nodeId === "source_conflict_review")!
              .inputs!.find((entry) => entry.from === "memory_recall")!;
            malformedInput.scopeBinding!.sourceScope = reference("/sourceReview/scope");
            const rejected = (await auditWorkflowHandoffs(malformed)).find(
              (entry) => entry.scenarioId === "self_repair_hands_waterflow",
            )!;
            expect(rejected.gaps.some((gap) => gap.reason.startsWith("scope_binding_"))).toBe(true);
            const sourcePath = path.join(
              result.produced.workspaceDir,
              result.produced.current.sourceRef.path,
            );
            const sourceBytes = await fs.readFile(sourcePath);
            try {
              await fs.appendFile(sourcePath, "\n");
              const changed = (await auditWorkflowHandoffs(linked)).find(
                (entry) => entry.scenarioId === "self_repair_hands_waterflow",
              )!;
              expect(changed.gaps).toContainEqual(
                expect.objectContaining({
                  reason: "self_repair_review_source_hash_mismatch:memory_recall",
                }),
              );
            } finally {
              await fs.writeFile(sourcePath, sourceBytes);
            }
          }
        }
        expect(result.scenarioAudit?.status).toBe("handoff_gap");
        expect(result.scenarioAudit?.semanticAdoption).toBe("not_proven");
        expect(result.produced.scope.runId).not.toBe(result.produced.currentScope.runId);
        expect(result.consumed.owner.runReceipt.parentRunId).toBe(result.consumed.parentRunId);
        expect(result.consumed.owner.runReceipt.snapshot).toEqual(result.consumed.snapshot);
        expect(result.consumed.owner.compact.latestWrittenReceipt).toMatchObject({
          receipt: {
            path: result.produced.current.receipt.latestJsonPath,
            sha256: createHash("sha256").update(result.produced.current.receiptBytes).digest("hex"),
          },
          sourceReview: { scope: result.produced.currentScope },
        });
        expect(result.consumed.parentRunId).not.toBe(result.produced.currentScope.runId);
        expect(result.consumed.projection.runReceipt).toMatchObject({ status: "blocked" });
        expect(JSON.parse(result.mapBytes)).toEqual(result.consumed.map);
        expect(result.feedback.parsed).toMatchObject({
          status: "dry_run_ready",
          candidateOnly: true,
          reuseAllowed: false,
          semanticTruth: "not_proven",
          diagnosticFeedback: {
            status: "read",
            sourceRunId: result.consumed.parentRunId,
            actionAuthority: false,
          },
        });
        expect(result.rootAfterLate).toBe(result.rootAfter);
        expect(result.rootAfter).toBe(result.produced.current.receiptBytes);
        expect(result.reviewAfterLate).toBe(result.reviewAfter);
        const item = result.consumed.map.items.find(
          (entry) => entry.id === "self_repair_memory_and_training_candidate_hands",
        );
        expect(item).toBeDefined();
        if (scenario === "missing_memory") {
          expect(result.produced.current.receipt.status).toBe("blocked");
          expect(result.produced.bodyReads.every((entry) => entry.bytes === undefined)).toBe(true);
          expect(result.reviewed).toBeUndefined();
          expect(item?.status).toBe("blocked_now");
          expect(item?.reason).toContain("self_repair_memory_unreadable");
        } else {
          expect(result.produced.current.receipt.status).toBe("write_completed");
          expect(result.reviewed?.reviewed.status).toBe("failed");
          expect(result.consumed.owner.compact.contentReview).toMatchObject({ status: "failed" });
          expect(item?.reason).toContain("候选内容审阅：failed");
          expect(
            result.produced.reviewInput?.request.evidence.some((entry) =>
              entry.text?.includes(result.produced.oldRule),
            ),
          ).toBe(true);
          expect(
            result.produced.reviewInput?.request.evidence.some((entry) =>
              entry.text?.includes(result.produced.currentRule),
            ),
          ).toBe(true);
        }
        if (scenario === "review_timeout") {
          expect(result.reviewCalls.length).toBeGreaterThan(0);
          expect(result.reviewCalls.every((entry) => entry.abortObserved)).toBe(true);
        } else {
          expect(result.reviewCalls).toHaveLength(0);
        }
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
describe.skipIf(!before)("original prewrite recall missing handoff counterexamples", () => {
  it.each([undefined, "missing_memory", "artifact_hash"] as const)(
    "observes original tools and the absent current consumer for %s",
    async (fault: PrewriteRecallFault | undefined) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-prewrite-recall-"));
      roots.push(directory);
      const result = await produceOriginalPrewriteRecall({ directory, fault, before: true });
      const retained = process.env.LCX_SELF_REPAIR_PREWRITE_PROOF_DIR;
      if (retained) {
        await fs.mkdir(retained, { recursive: true });
        await fs.cp(directory, path.join(retained, fault ?? "content_difference"), {
          recursive: true,
        });
      }
      expect(result.toolRegistration).toEqual(["memory_get", "artifact_memory_recall"]);
      expect(result.artifact.sha256).toBe(result.artifactActualSha256);
      if (fault === "missing_memory") {
        expect(result.memoryResult.missing).toBe(true);
        expect(result.deliveredRecall.selectedValue).toBe("");
      } else if (fault === "artifact_hash") {
        expect(result.deliveredRecall.available).toBe(false);
        expect(result.deliveredRecall.gap).toBe("artifact_original_hash_mismatch");
      } else {
        expect(result.deliveredRecall.available).toBe(true);
        expect(result.deliveredRecall.selectedValue).toContain(result.oldRule);
        expect(result.deliveredRecall.selectedValue).not.toContain(result.currentRule);
      }
      // This explicitly reproduces the existing omission; candidate-only is not approval.
      expect(result.current.receipt.status).toBe("write_completed");
      expect(result.current.receipt.sourceReview.status).toBe("verified_reference_candidate_only");
      expect(result.current.receipt.reuseAllowed).toBe(false);
      expect(result.current.receipt.semanticTruth).toBe("not_proven");
      expect(result.current.receipt).not.toHaveProperty("prewriteRecall");
    },
  );
});

describe.skipIf(before)(
  "original prewrite recall -> source review -> writer -> quality input",
  () => {
    it.each([
      "different_content",
      "same_content",
      "missing_memory",
      "artifact_hash",
      "missing_host",
      "account_scope",
      "run_scope",
      "old_file_changed",
      "partial_range",
      "old_source_missing",
      "downstream_host_missing",
      "downstream_artifact_hash",
      "oversized_selection",
    ] as const)("consumes actual content or blocks the %s gap", async (scenario) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-prewrite-consumer-"));
      roots.push(directory);
      const positive = scenario === "different_content" || scenario === "same_content";
      const downstreamFailure =
        scenario === "downstream_host_missing" || scenario === "downstream_artifact_hash";
      const result = await produceOriginalPrewriteRecall({
        directory,
        fault: positive ? undefined : scenario,
        sameContent: scenario === "same_content",
        useCli: scenario === "different_content",
      });
      const retained = process.env.LCX_SELF_REPAIR_PREWRITE_PROOF_DIR;
      if (retained) {
        await fs.mkdir(retained, { recursive: true });
        await fs.cp(directory, path.join(retained, scenario), { recursive: true });
      }
      const native = JSON.parse(result.current.receiptBytes) as {
        ok: boolean;
        status: string;
        candidateOnly: boolean;
        reuseAllowed: boolean;
        semanticTruth: string;
        sourceReview: {
          status: string;
          blockers: string[];
          memoryRecall?: Record<string, unknown>;
        };
      };
      expect(native.candidateOnly).toBe(true);
      expect(native.reuseAllowed).toBe(false);
      expect(native.semanticTruth).toBe("not_proven");
      expect(result.scope.accountId).toBe(result.currentScope.accountId);
      expect(result.scope.runId).not.toBe(result.currentScope.runId);
      expect(result.currentReceiptBytesAfterReview).toBe(result.current.receiptBytes);
      if (positive) {
        if (scenario === "different_content") {
          expect(result.current.cli?.argv).toContain("--memory-source-run-id");
          expect(result.current.cli?.argv).toContain("--artifact-store-path");
        }
        expect(native.status).toBe("write_completed");
        expect(native.sourceReview.memoryRecall).toMatchObject({
          status: "read_candidate_only",
          comparison:
            scenario === "same_content" ? "same_content" : "different_content_requires_review",
          semanticTruth: "not_proven",
          selectedText: result.deliveredRecall.selectedValue,
          scope: result.scope,
          previousReceipt: result.prior.receiptRef,
          source: result.prior.sourceRef,
          correction: result.correctionRef,
          artifact: {
            id: result.artifact.id,
            sha256: result.artifact.sha256,
            path: result.artifact.relativePath,
            field: "/value/text",
          },
          reuseAllowed: false,
          actionAuthority: false,
        });
        expect(result.bodyReads.every((entry) => entry.bytes !== undefined)).toBe(true);
        expect(result.reviewInput).toBeDefined();
        expect(result.reviewReadError).toBeUndefined();
        const evidenceTexts =
          result.reviewInput?.request.evidence?.map((entry) => entry.text) ?? [];
        expect(evidenceTexts.some((text) => text?.includes(result.oldRule))).toBe(true);
        expect(evidenceTexts.some((text) => text?.includes(result.currentRule))).toBe(true);
        // All four original old references join the quality fingerprint and stay unchanged.
        for (const reference of result.oldReferences) {
          expect(result.reviewInput?.inputs).toContainEqual(expect.objectContaining(reference));
        }
        for (const reference of result.oldReferenceReadback) {
          expect(reference.actualSha256).toBe(reference.sha256);
        }
      } else if (downstreamFailure) {
        expect(native.status).toBe("write_completed");
        expect(native.sourceReview.memoryRecall).toMatchObject({
          status: "read_candidate_only",
          comparison: "different_content_requires_review",
        });
        expect(result.reviewInput).toBeUndefined();
        expect(result.reviewReadError).toBe(
          scenario === "downstream_host_missing"
            ? "self_repair_memory_host_missing"
            : "artifact_original_hash_mismatch",
        );
        expect(result.bodyReads.every((entry) => entry.bytes !== undefined)).toBe(true);
      } else {
        expect(native.ok).toBe(false);
        expect(native.status).toBe("blocked");
        expect(native.sourceReview.status).toBe("blocked");
        expect(native.sourceReview.blockers.length).toBeGreaterThan(0);
        const expectedGap: Record<PrewriteRecallFault, string> = {
          missing_memory: `self_repair_memory_unreadable:correction:${result.correctionRef.path}`,
          artifact_hash: "artifact_original_hash_mismatch",
          missing_host: "self_repair_memory_host_missing",
          account_scope: "self_repair_memory_account_mismatch",
          run_scope: "self_repair_memory_scope_mismatch",
          old_file_changed: `self_repair_memory_source_hash_mismatch:correction:${result.correctionRef.path}`,
          partial_range: "self_repair_memory_rule_not_fully_delivered",
          old_source_missing: `self_repair_memory_unreadable:source:${result.prior.sourceRef.path}`,
          downstream_host_missing: "self_repair_memory_host_missing",
          downstream_artifact_hash: "artifact_original_hash_mismatch",
          oversized_selection:
            "self_repair_memory_selected_field_unavailable:artifact_field_budget_exceeded",
        };
        expect(native.sourceReview.blockers).toContain(expectedGap[scenario]);
        expect(result.bodyReads.every((entry) => entry.bytes === undefined)).toBe(true);
        expect(result.reviewInput).toBeUndefined();
        if (scenario === "artifact_hash") {
          const original = result.oldReferenceReadback.find(
            (entry) => entry.path === result.artifact.relativePath,
          );
          expect(original).toBeDefined();
          expect(original?.actualSha256).toMatch(/^[a-f0-9]{64}$/u);
          expect(original?.actualSha256).not.toBe(result.artifact.sha256);
        }
        if (scenario === "oversized_selection") {
          expect(Buffer.byteLength(result.correctionBytes)).toBeGreaterThan(64 * 1024);
          expect(result.memoryResult.text).toContain(result.oldRule);
          expect(result.deliveredRecall.available).toBe(false);
          expect(result.deliveredRecall.gap).toBe("artifact_field_budget_exceeded");
        }
      }
    });
  },
);

describe.skipIf(before)(
  "historical comparison and default content-review readback boundaries",
  () => {
    it.each([
      "historical_stale",
      "current_stale",
      "current_missing",
      "old_rule_mismatch",
      "old_future",
      "old_invalid_time",
      "content_review_readback",
    ] as const)("preserves the actual %s boundary", async (scenario) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-prewrite-history-"));
      roots.push(directory);
      const oldNow = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const result = await produceOriginalPrewriteRecall({
        directory,
        historicalFault:
          scenario === "historical_stale" || scenario === "content_review_readback"
            ? undefined
            : (scenario as HistoricalRecallFault),
        withPriorClock: async (operation) => {
          // Only Date is replaced: actual writer filesystem/receipt and all IO remain real.
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(oldNow);
          try {
            return await operation();
          } finally {
            vi.useRealTimers();
          }
        },
      });
      const positive = scenario === "historical_stale" || scenario === "content_review_readback";
      if (scenario !== "old_future" && scenario !== "old_invalid_time") {
        expect(
          Date.now() - Date.parse(JSON.parse(result.prior.sourceBytes).observedAt),
        ).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
      }
      if (positive) {
        expect(result.current.receipt.status).toBe("write_completed");
        expect(result.current.receipt.sourceReview.memoryRecall).toMatchObject({
          status: "read_candidate_only",
          sourceUse: "historical_comparison_only",
          sourceObservedAt: JSON.parse(result.prior.sourceBytes).observedAt,
          scope: result.scope,
          semanticTruth: "not_proven",
          reuseAllowed: false,
          actionAuthority: false,
        });
        expect(result.reviewInput).toBeDefined();
        expect(result.reviewReadError).toBeUndefined();
        for (const reference of result.oldReferenceReadback) {
          expect(reference.actualSha256).toBe(reference.sha256);
        }
      } else {
        const expected =
          scenario === "old_rule_mismatch"
            ? "correction_replacement_rule_source_mismatch"
            : scenario === "current_missing"
              ? "source_evidence_unreadable"
              : "correction_source_not_fresh";
        expect(result.current.receipt.status).toBe("blocked");
        expect(result.current.receipt.sourceReview.blockers).toContain(expected);
        expect(result.bodyReads.every((entry) => entry.bytes === undefined)).toBe(true);
      }
      if (scenario === "content_review_readback") {
        const readback = await readOriginalPrewriteContentReview(result);
        expect(readback.reviewed.status).toBe("failed");
        expect(readback.reviewed.gaps).toContain("self_repair_review_model_unavailable");
        expect(
          readback.reviewed.quality?.execution.modelCalls.some(
            (call) => call.outcome === "completed",
          ),
        ).toBe(false);
        expect(readback.complete.parsed.contentReview.status).toBe("failed");
        expect(readback.complete.parsed.contentReview.gaps).toEqual(readback.reviewed.gaps);
        expect(readback.complete.parsed.contentReview.gaps).not.toContain(
          "self_repair_memory_host_missing",
        );
        expect(readback.missingHost.parsed.contentReview).toMatchObject({
          status: "not_observed",
          gaps: ["self_repair_memory_host_unavailable"],
        });
        expect(readback.sidecarAfter).toBe(readback.sidecarBefore);
        expect(readback.rootAfter).toBe(result.current.receiptBytes);
      }
      const retained = process.env.LCX_SELF_REPAIR_PREWRITE_PROOF_DIR;
      if (retained) {
        await fs.mkdir(retained, { recursive: true });
        await fs.cp(directory, path.join(retained, scenario), { recursive: true });
      }
    });
  },
);
