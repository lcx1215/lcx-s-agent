import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditWorkflowHandoffs } from "../scripts/operator/lcx-flow-graph.js";
import {
  probeUniverseWhole,
  type UniverseWholeFault,
} from "./fixtures/lcx-waterflow-universe-whole-probe.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function probe(fault?: UniverseWholeFault) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-private-universe-whole-"));
  roots.push(root);
  return probeUniverseWhole(
    root,
    path.join(process.env.LCX_UNIVERSE_WHOLE_PROOF_DIR ?? root, fault ?? "positive"),
    fault,
  );
}
describe("original universe phases with private actual IO", () => {
  it("runs the unchanged CLI and captures original main consumers without inventing a serial map", async () => {
    const result = await probe();
    expect(result.cli?.ok).toBe(true);
    const impact = result.calls.find((call) => call.owner === "changeImpactCoverage")!;
    const mapping = result.calls.find((call) => call.owner === "buildRepoGovernanceCoverage")!;
    expect(impact.args[0]).toEqual(["test/changed.test.ts"]);
    expect(mapping.args[0]).toContain("test/unchanged.test.ts");
    expect(mapping.args[0]).not.toEqual(impact.args[0]);
    expect(result.cli?.repo.changedFiles).toEqual(result.observed?.repo.changedFiles);
    expect(result.cli?.ownerCoverage.changeImpact).toEqual(
      result.observed?.ownerCoverage.changeImpact,
    );
    expect(result.cli?.artifacts.workspaceState.fileCount).toBe(1);
    expect(
      result.calls.find((call) => call.owner === "buildGovernanceInventoryAreas")?.args[0],
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inventory: expect.objectContaining({ fileCount: 1, sourceStatus: "complete" }),
        }),
      ]),
    );
    expect(result.audit?.status).toBe("handoff_gap");
    const provedEdges = [
      "owner_coverage_map:repo_inventory",
      "owner_coverage_map:artifact_inventory",
      "universe_index:owner_coverage_map",
      "universe_index:change_impact_plan",
    ];
    for (const edge of provedEdges) {
      const [node, from] = edge.split(":");
      expect(result.audit?.gaps.some((gap) => gap.node === node && gap.reason.includes(from))).toBe(
        false,
      );
    }
    const ownerMap = result.evidence?.nodes.find((node) => node.nodeId === "owner_coverage_map");
    const terminalMap = result.evidence?.nodes
      .find((node) => node.nodeId === "universe_index")
      ?.inputs?.find((input) => input.from === "owner_coverage_map");
    expect(ownerMap?.output?.pointer).toBe("/phases/validatedOwnerCoverage");
    expect(terminalMap?.value.pointer).toBe("/terminal/ownerCoverage/governanceCoverage");
    expect(ownerMap?.output?.pointer).not.toBe(terminalMap?.value.pointer);
    expect(result.audit?.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ node: "cleanup_candidate_review" })]),
    );
    // Field references are actually audited; content tampering cannot reuse the source hash.
    if (!result.evidence) {
      throw new Error("missing evidence");
    }
    const tracePath = result.evidence.nodes[0].scope.path;
    const rawTrace = await fs.readFile(tracePath);
    await fs.appendFile(tracePath, "\n");
    const conflict = (await auditWorkflowHandoffs([result.evidence])).find(
      (item) => item.scenarioId === result.evidence.scenarioId,
    )!;
    expect(JSON.stringify(conflict)).toContain("receipt_hash_conflict");
    await fs.writeFile(
      path.join(path.dirname(tracePath), "hash-conflict-audit.json"),
      JSON.stringify(conflict, null, 2),
    );
    await fs.writeFile(tracePath, rawTrace);
  }, 60_000);
  it("keeps a real missing route owner visible and blocks the original join", async () => {
    const result = await probe("missing_owner");
    expect(result.cli?.ok).toBe(false);
    expect(result.cli?.ownerCoverage.governanceCoverage.routeOwnerValidation.missing).toContain(
      "scripts/operator/lcx-external-channel-status.ts",
    );
    expect(result.observed?.ownerCoverage.governanceCoverage.status).toBe("incomplete");
  }, 60_000);
  it("propagates actual unmatched child paths into the final failure", async () => {
    const result = await probe("unmatched");
    expect(result.cli?.ok).toBe(false);
    expect(result.cli?.ownerCoverage.changeImpact.unmatchedFiles).toContain(
      "unknown-fixture/unknown.zzz",
    );
    expect(result.observed?.ownerCoverage.changeImpact.ok).toBe(false);
  }, 60_000);
  it("returns the original deadline failure without claiming descendant cleanup", async () => {
    const result = await probe("git_timeout");
    expect(result.cliTimedOut).toBe(false);
    expect(result.terminalReceiptObserved).toBe(true);
    expect(result.cli?.ok).toBe(false);
    expect(result.cli?.ownerDeadline.status).toBe("timed_out");
    expect(result.cli?.ownerDeadline.cleanupStatus).toBe("cleanup_unconfirmed");
    expect(result.cli?.repo.changedFiles).toEqual([]);
    expect(result.observed?.ok).toBe(false);
    expect(result.gap).toContain("cleanup_unconfirmed");
  }, 30_000);
});
