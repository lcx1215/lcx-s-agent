import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { reviewUniverseCleanup } from "../../../scripts/operator/lcx-change-impact-plan.js";
import { buildCleanupReviewProbe } from "../../../test/fixtures/lcx-waterflow-cleanup-review-probe.js";
import { readFileWithinRoot } from "../../infra/fs-safe.js";
import { recordAgentArtifact } from "../artifact-result-recording.js";
import { reviewCleanupBeforeDecision } from "./cleanup-review-handoff.js";
import { buildCentralGovernanceInput } from "./governance-input.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cleanup-recovery-"));
  roots.push(root);
  const fixture = await buildCleanupReviewProbe(root, undefined, undefined, true);
  const owners = fixture.governance.ownerCommands.map((row) => ({
    ...row,
    compact: fixture.governance.owners[row.id] as Record<string, unknown>,
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
  return { ...fixture, owners, host: { ...fixture.host, config } };
}
async function changeRecovery(
  value: Awaited<ReturnType<typeof setup>>,
  patch: Record<string, unknown>,
) {
  const owner = value.owners.find((row) => row.id === "contextRecovery")!;
  const source = JSON.parse(
    await fs.readFile(path.join(value.host.rootDir, value.sources.contextRecovery.path), "utf8"),
  ) as { runId: string; observedAt: string; value: Record<string, unknown> };
  const recorded = await recordAgentArtifact({
    config: value.host.config,
    agentId: "main",
    workspaceDir: value.host.rootDir,
    owner: "contextRecovery",
    runId: source.runId,
    observedAt: source.observedAt,
    value: { ...source.value, ...patch },
  });
  owner.compact = { artifactEvidence: recorded };
}
async function save(name: string, value: unknown) {
  const proof = process.env.LCX_WATERFLOW_PROOF_DIR;
  if (!proof) {
    return;
  }
  await fs.mkdir(proof, { recursive: true });
  await fs.writeFile(path.join(proof, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}

describe("same-cycle recovery gates the original cleanup consumer", () => {
  it.skipIf(!process.env.LCX_CLEANUP_RECOVERY_BEFORE_SOURCE)(
    "preserves the original before: missing recovery still produced reviewed candidates",
    async () => {
      const file = process.env.LCX_CLEANUP_RECOVERY_BEFORE_SOURCE!;
      const source = await fs.readFile(file, "utf8");
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const functions = ast.statements
        .filter(
          (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) &&
            ["record", "reviewCleanupBeforeDecision"].includes(node.name?.text ?? ""),
        )
        .map((node) => node.getText(ast).replace(/^export /u, ""));
      expect(functions).toHaveLength(2);
      const context = vm.createContext({
        buildCentralGovernanceInput,
        recordAgentArtifact,
        readFileWithinRoot,
        createHash,
        reviewUniverseCleanup,
        CANDIDATE_FIELDS: [
          "untrackedRepoFiles",
          "unmatchedChangedFiles",
          "staleRuntimeFiles",
          "largeRuntimeFiles",
          "staleSnapshots",
        ],
      });
      vm.runInContext(
        ts.transpile(functions.join("\n"), {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.None,
        }),
        context,
      );
      const value = await setup();
      value.owners = value.owners.filter((owner) => owner.id !== "contextRecovery");
      const original = context.reviewCleanupBeforeDecision as typeof reviewCleanupBeforeDecision;
      const before = await original(value.owners, value.host);
      expect(before.review.status).toBe("reviewed");
      expect(
        before.review.sourceReads.some((read) => read.pointer.includes("contextRecovery")),
      ).toBe(false);
      await save("before-missing-recovery", {
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        before,
        boundary: "original_isolated_function_no_owner_dispatch",
      });
    },
  );

  it("actually reads recovery quality/checks from its pinned original artifact", async () => {
    const value = await setup();
    const result = await reviewCleanupBeforeDecision(value.owners, value.host);
    expect(result.review.status).toBe("reviewed");
    expect(result.review.cleanupAuthorized).toBe(false);
    expect(result.review.sourceReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: value.sources.contextRecovery.path,
          sha256: value.sources.contextRecovery.sha256,
          pointer: "/value/compressedContextRecovered",
          value: true,
        }),
        expect.objectContaining({
          path: value.sources.contextRecovery.path,
          pointer: "/value/checks/0/ok",
          value: true,
        }),
        expect.objectContaining({ pointer: "/value/byOwner/contextRecovery/runReceipt" }),
      ]),
    );
    await save("after-recovery-consumed", {
      result,
      ownerSource: value.sources.contextRecovery,
      boundary: "offline_source_io_substitute_original_review_consumer_no_natural_adoption",
    });
  });

  it.each([
    ["missing", "cleanup_review_owner_receipt_missing:contextRecovery"],
    ["duplicate", "cleanup_review_owner_receipt_missing:contextRecovery"],
    ["scope", "cleanup_review_owner_scope_conflict:contextRecovery"],
    ["hash", "cleanup_review_hash_conflict"],
    ["timeout", "cleanup_review_upstream_quality_failed:contextRecovery"],
  ] as const)("blocks actual %s recovery before candidate dispositions", async (fault, reason) => {
    const value = await setup();
    const owner = value.owners.find((row) => row.id === "contextRecovery")!;
    if (fault === "missing") {
      value.owners = value.owners.filter((row) => row !== owner);
    }
    if (fault === "duplicate") {
      value.owners.push(owner);
    }
    if (fault === "scope") {
      owner.runReceipt.parentRunId = "other-parent";
    }
    if (fault === "hash") {
      await fs.appendFile(path.join(value.host.rootDir, value.sources.contextRecovery.path), " ");
    }
    if (fault === "timeout") {
      owner.runReceipt.status = "failed";
    }
    const result = await reviewCleanupBeforeDecision(value.owners, value.host);
    expect(result.review).toMatchObject({
      status: "blocked",
      reason,
      dispositions: [],
      cleanupAuthorized: false,
    });
    await save(`after-recovery-${fault}`, result);
  });

  it.each([
    [{ compressedContextRecovered: false }, "cleanup_review_recovery_not_complete"],
    [{ checks: [] }, "cleanup_review_recovery_checks_missing"],
    [
      { checks: [{ id: "failed-original-check", ok: false }] },
      "cleanup_review_recovery_check_failed:0",
    ],
    [{ ok: false }, "cleanup_review_upstream_quality_failed:contextRecovery"],
    [{ boundary: "another_owner" }, "cleanup_review_recovery_not_complete"],
  ] as const)(
    "rejects contradictory recovery body %j even with fresh SHA and legal identity",
    async (patch, reason) => {
      const value = await setup();
      await changeRecovery(value, patch);
      const result = await reviewCleanupBeforeDecision(value.owners, value.host);
      expect(result.review).toMatchObject({
        status: "blocked",
        reason,
        dispositions: [],
        cleanupAuthorized: false,
      });
      await save(`after-recovery-body-${Object.keys(patch)[0]}-${reason.split(":")[0]}`, result);
    },
  );

  it("keeps legacy three-source local review compatible without calling it a recovery-complete workflow", async () => {
    const value = await setup();
    const legacy = await reviewUniverseCleanup(value.input, value.host);
    expect(legacy.status).toBe("reviewed");
    expect(
      legacy.sourceReads.some((read) => read.path === value.sources.contextRecovery.path),
    ).toBe(false);
    expect(legacy.semanticTruth).toBe("not_proven");
  });
});
