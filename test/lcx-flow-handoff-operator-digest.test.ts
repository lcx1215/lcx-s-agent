import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOperatorDigest } from "../scripts/operator/lcx-owner-brief.ts";
import {
  operatorBytesHash,
  originalOperatorBriefCli,
  originalOperatorWriter,
} from "./fixtures/lcx-waterflow-operator-digest-probe.ts";

const nativeWriter = process.env.LCX_NATIVE_OPERATOR_WRITER_PATH;
const proofDir = process.env.LCX_OPERATOR_DIGEST_PROOF_DIR;
const roots: string[] = [];
async function privateRoot(name: string) {
  const parent = proofDir ?? os.tmpdir();
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, `${name}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  if (!proofDir) {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  }
});

describe("operator digest source rejection without any owner run", () => {
  it("returns a concrete unavailable receipt for missing source", async () => {
    const root = await privateRoot("missing-source");
    const read = await readOperatorDigest(path.join(root, "missing.json"), { repoRoot: root });
    expect(read.evidence.status).toBe("blocked");
    expect(read.evidence.contentStatus).toBe("unavailable");
    expect(read.evidence.reasons.some((reason) => reason.includes("ENOENT"))).toBe(true);
    expect(read.evidence.runBinding).toBe("unavailable");
  });
  it("rejects invalid JSON and primitive roots", async () => {
    const root = await privateRoot("invalid-source");
    for (const body of ["{broken", "true"]) {
      const file = path.join(root, "invalid.json");
      await fs.writeFile(file, body);
      const read = await readOperatorDigest(file, { repoRoot: root });
      expect(read.evidence.status).toBe("blocked");
      expect(read.evidence.contentStatus).toBe("unavailable");
      expect(read.operator).toEqual({});
    }
  });
});

describe.skipIf(!nativeWriter)(
  "original operator writer → owner-brief CLI → original writer → disk readback",
  () => {
    async function source(
      name: string,
      options: Parameters<typeof originalOperatorWriter>[2] = {},
    ) {
      const root = await privateRoot(name);
      const writer = await originalOperatorWriter(root, nativeWriter!, options);
      expect(writer.io.filter((row) => row.op === "read").length).toBeGreaterThan(8);
      const pins = { sha256: writer.sha256, checkedAt: String(writer.value.checkedAt) };
      return { root, writer, pins };
    }
    it("renders the original single file while keeping canonical run acceptance unavailable", async () => {
      const { root, writer, pins } = await source("normal");
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.exitCode).toBe(0);
      expect(result.readback.operatorDigest.status).toBe("rendered_requires_review");
      expect(result.readback.operatorDigest.contentStatus).toBe("read");
      expect(result.readback.operatorDigest.source.sha256).toBe(writer.sha256);
      expect(result.readback.operatorDigest.source.checkedAt).toBe(writer.value.checkedAt);
      expect(result.readback.operatorDigest.sourcePins).toEqual({
        hash: "matched",
        checkedAt: "matched",
        repoRoot: "matched",
      });
      expect(result.readback.operatorDigest.runBinding).toBe("unavailable");
      expect(result.readback.operatorDigest.semanticTruth).toBe("not_proven");
      expect(result.readback.runReceipt).toBeUndefined();
      expect(result.readback.snapshot).toBeUndefined();
      expect(result.readback.sourcePaths).toEqual([writer.path]);
      expect(result.readback.headline).toContain("等待验收");
      expect(result.readback.markdown).not.toContain("没有发现新的硬卡点");
      // No legacy governance/trace exists in this private workspace; the single-file mode does not read them.
      expect(await fs.readdir(path.join(root, ".openclaw/workspace/state"))).toEqual([
        "lcx-owner-brief-latest.json",
        "lcx-owner-brief-latest.md",
      ]);
    });
    it("consumes actual producer aggregate failure and preserves its original doctor reason", async () => {
      const { root, writer, pins } = await source("business-blocked", { doctorBlocked: true });
      expect(writer.value.ok).toBe(false);
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.exitCode).toBe(1);
      expect(result.readback.ok).toBe(false);
      expect(result.readback.operatorDigest.contentStatus).toBe("read");
      expect(result.readback.operatorDigest.status).toBe("blocked");
      expect(result.readback.firstFailedGate).toContain(
        "operator_owner_blocked:doctor:native-doctor-source-check",
      );
      expect(result.readback.markdown).toContain(
        "native-doctor-source-check: source quality gate failed",
      );
      expect(result.readback.operatorDigest.owners.doctor.exitCode).toBe(0);
    });
    it("uses original structured business failures before harmless stderr diagnostics", async () => {
      const reason =
        "local_operator_latest_matches_current_workflow_surface: local operator latest flow graph must match the current workflow surface";
      const warning = "Harmless legacy Feishu configuration warning";
      const { root, writer, pins } = await source("structured-reason", {
        contextRecoveryBlocked: true,
        contextRecoveryFailures: [reason],
        contextRecoveryStderr: warning,
      });
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.exitCode).toBe(1);
      expect(result.readback.firstFailedGate).toBe(
        `operator_owner_blocked:contextRecovery:${reason}`,
      );
      expect(result.readback.operatorDigest.owners.contextRecovery).toEqual({
        ok: false,
        exitCode: 0,
        reason,
        reasonField: "/contextRecovery/actionableFailures/0",
        stderr: warning,
      });
      expect(result.readback.operatorDigest.fieldsUsed).toContain(
        "/contextRecovery/actionableFailures/0",
      );
      expect(result.readback.operatorDigest.fieldsUsed).toContain("/errors/contextRecovery");
      expect(result.readback.markdown).toContain(`contextRecovery：${reason}`);
      expect(result.readback.markdown).not.toContain(warning);
    });
    it("keeps healthy stderr warnings as diagnostics without manufacturing a business blocker", async () => {
      const warning = "Harmless legacy Feishu configuration warning";
      const { root, writer, pins } = await source("healthy-warning", {
        contextRecoveryStderr: warning,
      });
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.exitCode).toBe(0);
      expect(result.readback.operatorDigest.status).toBe("rendered_requires_review");
      expect(result.readback.operatorDigest.owners.contextRecovery.stderr).toBe(warning);
      expect(result.readback.operatorDigest.fieldsUsed).toContain("/errors/contextRecovery");
      expect(result.readback.operatorDigest.reasons).toHaveLength(1);
      expect(result.readback.firstFailedGate).toBe("operator_canonical_run_identity_unavailable");
      expect(result.readback.markdown).not.toContain("contextRecovery：");
      expect(result.readback.markdown).not.toContain(warning);
    });
    it("preserves actual governance business blockers despite healthy wrapper ok and exit zero", async () => {
      const { root, writer, pins } = await source("governance-business-blocked", {
        governanceSummary: {
          structuralOwnerFailures: ["commercialAcceptance"],
          releaseBlocked: true,
          blockedGates: ["broker_confirmation_missing"],
          failedGates: [],
          fastestSafeNextAction: "confirm_broker_evidence_before_any_execution",
        },
      });
      expect(writer.value.ok).toBe(true);
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.exitCode).toBe(1);
      expect(result.readback.operatorDigest.owners.governanceAutopilot).toEqual({
        ok: true,
        exitCode: 0,
      });
      expect(result.readback.operatorDigest.status).toBe("blocked");
      expect(result.readback.operatorDigest.contentStatus).toBe("read");
      expect(result.readback.firstFailedGate).toBe(
        "operator_governance_gate_blocked:broker_confirmation_missing",
      );
      expect(result.readback.markdown).toContain(
        "operator_governance_owner_blocked:commercialAcceptance",
      );
      expect(result.readback.markdown).toContain("operator_governance_release_blocked");
      expect(result.readback.operatorDigest.fieldsUsed).toContain(
        "/governanceAutopilot/summary/blockedGates",
      );
      expect(result.readback.operatorDigest.runBinding).toBe("unavailable");
      expect(result.readback.operatorDigest.semanticTruth).toBe("not_proven");
    });
    it("shows structural owner failures when no commercial gate detail is available", async () => {
      const { root, writer, pins } = await source("governance-owner-blocked", {
        governanceSummary: {
          structuralOwnerFailures: ["contextRecovery"],
          failedGates: [],
          blockedGates: [],
        },
      });
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.readback.operatorDigest.status).toBe("blocked");
      expect(result.readback.firstFailedGate).toBe(
        "operator_governance_owner_blocked:contextRecovery",
      );
      expect(result.readback.markdown).toContain("contextRecovery");
    });
    it("preserves original failed gates and explicit release blockers independently", async () => {
      for (const [name, summary, reason] of [
        [
          "failed-gate",
          { failedGates: ["source_quality_gate"] },
          "operator_governance_gate_failed:source_quality_gate",
        ],
        ["release-blocked", { releaseBlocked: true }, "operator_governance_release_blocked"],
      ] as const) {
        const { root, writer, pins } = await source(name, { governanceSummary: summary });
        const result = await originalOperatorBriefCli(root, writer.path, pins);
        expect(result.readback.operatorDigest.status).toBe("blocked");
        expect(result.readback.firstFailedGate).toBe(reason);
        expect(result.readback.markdown).toContain(reason);
      }
    });
    it("keeps healthy empty failure lists and intentionally open gates pending run review", async () => {
      const { root, writer, pins } = await source("governance-healthy", {
        governanceSummary: {
          structuralOwnerFailures: [],
          failedGates: [],
          blockedGates: [],
          releaseBlocked: false,
          activeTrainingOrEval: true,
          openGates: ["local_observability_only"],
        },
      });
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.exitCode).toBe(0);
      expect(result.readback.operatorDigest.status).toBe("rendered_requires_review");
      expect(result.readback.operatorDigest.reasons).toEqual([
        "operator_canonical_run_identity_unavailable; aggregate source status is not proof of business acceptance",
      ]);
      expect(result.readback.headline).toContain("等待验收");
    });
    it("rejects malformed governance blocker fields without interpreting them as healthy", async () => {
      const { root, writer, pins } = await source("governance-unknown", {
        governanceSummary: { blockedGates: "broker_confirmation_missing" },
      });
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.readback.operatorDigest.status).toBe("blocked");
      expect(result.readback.operatorDigest.contentStatus).toBe("unavailable");
      expect(result.readback.firstFailedGate).toBe(
        "operator_source_governance_summary_invalid:blockedGates",
      );
    });
    it("does not accept the original producer's true aggregate when a recorded owner exit is nonzero", async () => {
      const { root, writer, pins } = await source("nonzero-exit", { doctorExitCode: 7 });
      expect(writer.value.ok).toBe(true);
      const result = await originalOperatorBriefCli(root, writer.path, pins);
      expect(result.readback.operatorDigest.status).toBe("blocked");
      expect(result.readback.firstFailedGate).toBe("operator_owner_exit_failed:doctor:7");
    });
    it("still persists a complete blocked brief when the requested source is missing", async () => {
      const { root, pins } = await source("missing-cli");
      const result = await originalOperatorBriefCli(root, path.join(root, "missing.json"), pins);
      expect(result.exitCode).toBe(1);
      expect(result.readback.operatorDigest.contentStatus).toBe("unavailable");
      expect(result.readback.firstFailedGate).toContain("ENOENT");
    });
    it("rejects independent source hash and frame-time conflicts", async () => {
      const { root, writer, pins } = await source("independent-pins");
      const conflict = await originalOperatorBriefCli(root, writer.path, {
        ...pins,
        sha256: "0".repeat(64),
      });
      expect(conflict.readback.firstFailedGate).toBe("operator_source_hash_conflict");
      expect(conflict.readback.operatorDigest.contentStatus).toBe("unavailable");
      const crossFrame = await originalOperatorBriefCli(root, writer.path, {
        ...pins,
        checkedAt: "2000-01-01T00:00:00.000Z",
      });
      expect(crossFrame.readback.firstFailedGate).toBe("operator_source_checked_at_conflict");
      expect(crossFrame.readback.operatorDigest.source.checkedAt).toBe(writer.value.checkedAt);
    });
    it("rejects stale original time without treating a newly written file as a new observation", async () => {
      const { root, writer } = await source("stale");
      const stale = {
        ...writer.value,
        checkedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      };
      const bytes = JSON.stringify(stale);
      const file = path.join(root, "stale-source.json");
      await fs.writeFile(file, bytes);
      const result = await originalOperatorBriefCli(root, file, {
        sha256: operatorBytesHash(bytes),
        checkedAt: stale.checkedAt,
      });
      expect(result.readback.firstFailedGate).toBe("operator_source_stale");
      expect(result.readback.operatorDigest.source.checkedAt).toBe(stale.checkedAt);
      expect(result.readback.operatorDigest.contentStatus).toBe("unavailable");
    });
    it("rejects cross-repository sources and never invents a missing snapshot identity", async () => {
      const { root, writer, pins } = await source("cross-repo");
      const result = await originalOperatorBriefCli(root, writer.path, {
        ...pins,
        repoRoot: path.join(root, "different-root"),
      });
      expect(result.readback.firstFailedGate).toBe("operator_source_repo_root_conflict");
      const forged = { ...writer.value, snapshot: { sourceCommit: "forged" } };
      const bytes = JSON.stringify(forged);
      const file = path.join(root, "forged-snapshot.json");
      await fs.writeFile(file, bytes);
      const forgedResult = await originalOperatorBriefCli(root, file, {
        sha256: operatorBytesHash(bytes),
        checkedAt: String(writer.value.checkedAt),
      });
      expect(forgedResult.readback.firstFailedGate).toBe("operator_unrecognized_run_identity");
      expect(forgedResult.readback.snapshot).toBeUndefined();
    });
    it("returns blocked original writer output for bad JSON instead of throwing without a brief", async () => {
      const { root } = await source("bad-json");
      const file = path.join(root, "broken.json");
      await fs.writeFile(file, "{broken");
      const result = await originalOperatorBriefCli(root, file);
      expect(result.exitCode).toBe(1);
      expect(result.readback.operatorDigest.contentStatus).toBe("unavailable");
      expect(
        result.readback.operatorDigest.reasons.some((reason) =>
          reason.startsWith("operator_source_unavailable:"),
        ),
      ).toBe(true);
    });
    it("keeps unknown owner fields blocked and records concrete field pointers", async () => {
      const { root, writer } = await source("missing-owner");
      const changed = { ...writer.value, mindModel: { ok: "true" } };
      const bytes = JSON.stringify(changed);
      const file = path.join(root, "unknown-owner.json");
      await fs.writeFile(file, bytes);
      const result = await originalOperatorBriefCli(root, file, {
        sha256: operatorBytesHash(bytes),
        checkedAt: String(writer.value.checkedAt),
      });
      expect(result.readback.firstFailedGate).toBe("operator_owner_status_unknown:mindModel");
      expect(result.readback.operatorDigest.fieldsUsed).toContain("/mindModel/ok");
      expect(result.readback.operatorDigest.contentStatus).toBe("unavailable");
    });
  },
);
