import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPerception,
  readCentralGovernanceInput,
} from "../../../scripts/operator/lcx-central-agent.js";
import { buildCleanupReviewProbe } from "../../../test/fixtures/lcx-waterflow-cleanup-review-probe.js";
import { boundaryFromFlags, buildLcxRunReceipt } from "../../shared/lcx-run-receipt.js";
import { compactCleanupReview, reviewCleanupBeforeDecision } from "./cleanup-review-handoff.js";
import { buildCentralGovernanceInput } from "./governance-input.js";
import { boundPerception, compactReceipts, runCentralHarnessCycle } from "./harness-loop.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("cleanup review reaches the original central loop without terminal governance (offline)", () => {
  it.each([undefined, "quality", "hash"] as const)(
    "consumes the actual %s review and retains its reason in the following receipt",
    async (fault) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cleanup-judgment-"));
      roots.push(root);
      const fixture = await buildCleanupReviewProbe(root, fault, undefined, true);
      const completed = fixture.governance.ownerCommands.map((row) => ({
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
      const cleanup = await reviewCleanupBeforeDecision(completed, {
        ...fixture.host,
        config,
        snapshot: fixture.governance.snapshot,
      });
      const compact = compactCleanupReview(cleanup.review, cleanup);
      expect(compact.cleanupAuthorized).toBe(false);
      expect(compact.semanticTruth).toBe("not_proven");
      expect(cleanup.review.status).toBe(fault ? "blocked" : "reviewed");
      expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(1200);
      const runReceipt = buildLcxRunReceipt({
        runId: "offline-impact-review",
        parentRunId: fixture.host.parentRunId,
        owner: "changeImpact",
        phase: "observe",
        status: fault ? "blocked" : "passed",
        checkedAt: fixture.governance.snapshot.observedAt,
        snapshot: fixture.governance.snapshot,
        boundary: boundaryFromFlags({ scope: "offline_fixture" }),
        nextAction: "Retain missing checks; no cleanup authority.",
      });
      const handoff = buildCentralGovernanceInput(
        [
          ...completed,
          { id: "changeImpact", ok: !fault, compact: { cleanupReview: compact }, runReceipt },
        ],
        { parentRunId: fixture.host.parentRunId, snapshot: fixture.governance.snapshot },
      );
      const file = path.join(root, "before-central.json");
      await fs.writeFile(file, JSON.stringify(handoff));
      const read = await readCentralGovernanceInput(file);
      const perception = boundPerception(
        await buildPerception(
          [],
          { objective: "Review original cleanup gaps", focus: "general" },
          read,
          undefined,
          { stateDirectory: root },
        ),
      ).perception;
      const delivered = (perception.controlRoom.governanceDigest as Record<string, unknown>)
        .cleanupReview;
      expect(delivered).toEqual(compact);
      const note = `Preserve candidates: ${cleanup.review.reason}; missing checks remain, no deletion permitted.`;
      const receipt = await runCentralHarnessCycle({
        perception,
        registry: new Map(),
        brain: {
          propose: async (input) => {
            expect(
              (input.controlRoom.governanceDigest as Record<string, unknown>).cleanupReview,
            ).toEqual(delivered);
            return {
              kind: "proposed",
              provider: "offline",
              modelId: "scripted",
              plan: { actions: [], note },
            };
          },
        },
      });
      expect(receipt.brainCall.note).toBe(note);
      expect(receipt.actionsApproved).toBe(0);
      expect(JSON.stringify(compactReceipts([receipt], 10))).toContain(cleanup.review.reason);
      await expect(fs.stat(path.join(root, "governance.json"))).rejects.toThrow();
      if (process.env.LCX_WATERFLOW_PROOF_DIR) {
        const dir = process.env.LCX_WATERFLOW_PROOF_DIR;
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, `cleanup-${fault ?? "positive"}-original-loop.json`),
          JSON.stringify(
            {
              boundary: "offline_original_functions_scripted_brain_not_natural_adoption",
              cleanup,
              compact,
              handoff,
              read,
              delivered,
              receipt,
              next: compactReceipts([receipt], 10),
            },
            null,
            2,
          ) + "\n",
        );
      }
    },
  );

  it("keeps the native review after fanout and before downstream joins without starting governance", async () => {
    const file = "scripts/operator/lcx-governance-autopilot.ts";
    const source = await fs.readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const call = ast.statements.find(
      (statement) =>
        ts.isIfStatement(statement) &&
        statement.getText(ast).includes("await reviewCleanupBeforeDecision"),
    );
    expect(call).toBeDefined();
    const body = call!.getText(ast);
    expect(body).toContain("reviewCleanupBeforeDecision(directOwners");
    expect(body).toContain("parentRunId: governanceRunId");
    expect(body).toContain("captureOwnerRun(");
    expect(body).toContain('impactRun.runReceipt.status === "passed"');
    expect(body).toContain("exitCode: impactRun.exitCode");
    expect(body).toContain("error: impactRun.error");
    expect(body).toContain("impactSourceRunReceipt: impactRun.runReceipt");
    expect(body).toContain("impactSourceArtifact: impactRun.compact.artifactEvidence");
    expect(
      source.indexOf("const [sharedOwnerSnapshots, acceptanceProbes] = await Promise.all"),
    ).toBeLessThan(call!.pos);
    expect(call!.end).toBeLessThan(source.indexOf("const directByOwner = ownerMap(directOwners)"));
    expect(call!.end).toBeLessThan(
      source.indexOf("const centralAgentOwnerRun = await runCentralOwnerAfterSnapshots"),
    );
  });
});
