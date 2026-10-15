import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readExternalAgentLocalIntake,
  type ExternalAgentLocalIntakeReceipt,
} from "../scripts/operator/lcx-external-agent-upgrade-radar.ts";
import {
  auditExternalIntakeReceipt,
  createExternalIntakeProbe,
  EXTERNAL_INTAKE_LICENSE,
  EXTERNAL_INTAKE_SOURCE,
  runExternalIntakeCli,
  runExternalIntakeDelayedRead,
  saveExternalIntakeProof,
  type ExternalIntakeFault,
} from "./fixtures/lcx-waterflow-external-intake-twentieth-probe.ts";

let workspaceDir: string;
beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-external-intake-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("real_intake_network_forbidden")));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.rm(`${workspaceDir}-outside-source.md`, { force: true });
});
function actualCliIntake(value: unknown): ExternalAgentLocalIntakeReceipt {
  if (!value || typeof value !== "object" || !("localIntake" in value)) {
    throw new Error("original_cli_local_intake_missing");
  }
  const receipt = value.localIntake;
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("schemaVersion" in receipt) ||
    receipt.schemaVersion !== "lcx_external_local_intake_v1"
  ) {
    throw new Error("original_cli_intake_schema_missing");
  }
  return receipt as ExternalAgentLocalIntakeReceipt;
}

describe("original external Radar explicit source/registry/license intake", () => {
  it("keeps actual default static CLI compatible and performs no intake", async () => {
    const probe = await createExternalIntakeProbe(workspaceDir);
    const cli = await runExternalIntakeCli(probe, true);
    expect(cli.exitCode).toBe(0);
    expect(cli.receipt).toMatchObject({
      proofLevel: "static_registration_only",
      sourceContentRead: false,
      summary: { sourceReceiptVerifiedCount: 0, sourceReceiptMissingCount: 100 },
    });
    expect(cli.receipt).not.toHaveProperty("localIntake");
    expect(cli.observations).toEqual([]);
    await saveExternalIntakeProof(workspaceDir, "actual-default-static-cli", cli);
  }, 25_000);

  it("original CLI reads full source and license, independently consumes original outputs, and terminates normally blocked", async () => {
    const probe = await createExternalIntakeProbe(workspaceDir);
    const cli = await runExternalIntakeCli(probe);
    const receipt = actualCliIntake(cli.receipt);
    expect(cli.exitCode).toBe(0);
    expect(cli.receipt).toMatchObject({ ok: true });
    expect(receipt).toMatchObject({
      status: "blocked",
      upstreamScope: "not_observed",
      runtimeAuthority: "not_granted",
      stages: [
        {
          nodeId: "external_agent_source",
          status: "read",
          output: { text: EXTERNAL_INTAKE_SOURCE },
        },
        {
          nodeId: "source_registry",
          status: "registered",
          output: { text: EXTERNAL_INTAKE_SOURCE },
        },
        {
          nodeId: "license_scope_review",
          status: "blocked",
          output: { licenseText: EXTERNAL_INTAKE_LICENSE, permission: "not_verified" },
          reason: "license_permission_not_verified",
        },
      ],
    });
    expect(receipt.stages).toHaveLength(3);
    expect(receipt.stages[1].input).toEqual(receipt.stages[0].output);
    expect(receipt.stages[2].input).toEqual(receipt.stages[1].output);
    expect(cli.observations).toEqual([]);
    expect(cli.directChildExitObserved).toBe(true);
    const observed = await auditExternalIntakeReceipt(
      workspaceDir,
      "actual-cli-license-hold",
      receipt,
      cli.receipt,
      "/localIntake",
    );
    expect(observed.audit).toMatchObject({
      status: "normal_block",
      blocked: ["license_scope_review"],
      gaps: [],
      semanticAdoption: "not_proven",
    });
    expect(observed.evidence.nodes).toHaveLength(3);
    await saveExternalIntakeProof(workspaceDir, "actual-cli-license-hold-transport", cli);
  }, 25_000);

  it("actual CLI missing manifest emits the complete failed source stage instead of losing the terminal receipt", async () => {
    const probe = await createExternalIntakeProbe(workspaceDir, "missing_manifest");
    const cli = await runExternalIntakeCli(probe);
    const receipt = actualCliIntake(cli.receipt);
    expect(cli.exitCode).toBe(1);
    expect(cli.receipt).toMatchObject({ ok: false });
    expect(receipt.status).toBe("failed");
    expect(receipt.stages).toHaveLength(1);
    expect(receipt.stages[0]).toMatchObject({
      nodeId: "external_agent_source",
      status: "failed",
      filter: "untrusted_source_isolation",
    });
    expect(receipt.stages[0].output).toBeUndefined();
    expect(cli.observations).toEqual([]);
    await saveExternalIntakeProof(workspaceDir, "actual-cli-missing-manifest", cli);
  }, 25_000);

  it.each(["--intake-run-id", "--local-intake-sha256"] as const)(
    "actual CLI missing %s emits failed JSON without fabricating host scope or stages",
    async (omitFlag) => {
      const probe = await createExternalIntakeProbe(workspaceDir);
      const cli = await runExternalIntakeCli(probe, false, { omitFlag });
      expect(cli.exitCode).toBe(1);
      expect(cli.receipt).toMatchObject({ ok: false, argumentError: expect.any(String) });
      expect(cli.receipt).not.toHaveProperty("localIntake");
      expect(cli.observations).toEqual([]);
      await saveExternalIntakeProof(
        workspaceDir,
        `actual-cli-missing-flag-${omitFlag.slice(2)}`,
        cli,
      );
    },
    25_000,
  );

  it("actual CLI source hash failure propagates into the original aggregate and nonzero exit", async () => {
    const probe = await createExternalIntakeProbe(workspaceDir, "source_hash");
    const cli = await runExternalIntakeCli(probe);
    expect(cli.exitCode).toBe(1);
    expect(cli.receipt).toMatchObject({ ok: false });
    const receipt = actualCliIntake(cli.receipt);
    expect(receipt.stages).toHaveLength(1);
    expect(receipt.stages[0].reason).toContain("hash_mismatch:source");
    expect(cli.observations).toEqual([]);
    await saveExternalIntakeProof(workspaceDir, "actual-cli-source-hash-aggregate", cli);
  }, 25_000);

  it.each<ExternalIntakeFault>([
    "missing_source",
    "missing_license",
    "manifest_hash",
    "source_hash",
    "license_hash",
    "cross_scope",
    "candidate_unknown",
    "source_escape",
    "source_symlink",
  ])(
    "original intake blocks actual %s at the earliest owner without inventing later stages",
    async (fault) => {
      const probe = await createExternalIntakeProbe(workspaceDir, fault);
      const receipt = await readExternalAgentLocalIntake(probe);
      expect(receipt.status).toBe("failed");
      expect(receipt.runtimeAuthority).toBe("not_granted");
      const licenseFault = fault === "missing_license" || fault === "license_hash";
      expect(receipt.stages).toHaveLength(licenseFault ? 3 : 1);
      expect(receipt.stages.at(-1)?.status).toBe("failed");
      expect(receipt.stages.at(-1)?.output).toBeUndefined();
      expect(receipt.stages.at(-1)?.reason).toBeTruthy();
      const observed = await auditExternalIntakeReceipt(
        workspaceDir,
        `actual-fault-${fault}`,
        receipt,
      );
      expect(observed.audit.status).toBe("normal_block");
      expect(observed.audit.gaps).toEqual([]);
    },
  );

  it.each(["deadline", "cancel"] as const)(
    "original %s after real source read entry cannot continue registry/license on late IO",
    async (fault) => {
      const probe = await createExternalIntakeProbe(workspaceDir);
      const actual = await runExternalIntakeDelayedRead(probe, fault);
      expect(actual.readEntered).toBe(true);
      expect(actual.receipt.status).toBe("failed");
      expect(actual.receipt.stages).toHaveLength(1);
      expect(actual.receipt.stages[0].output).toBeUndefined();
      expect(actual.readsAtTerminal).toEqual([probe.manifest.path, probe.manifestBody.source.path]);
      expect(actual.readsAfterLate).toEqual(actual.readsAtTerminal);
      expect(actual.lateResultCannotChangeTerminal).toBe(true);
      expect(actual.receipt.cleanup).toBe("local_listener_released_read_cleanup_unconfirmed");
      expect(JSON.stringify(actual.receipt)).toContain(
        fault === "deadline" ? "external_local_intake_deadline" : "external_local_intake_cancelled",
      );
      const observed = await auditExternalIntakeReceipt(
        workspaceDir,
        `actual-${fault}-terminal`,
        actual.receipt,
      );
      expect(observed.audit.status).toBe("normal_block");
      await saveExternalIntakeProof(workspaceDir, `actual-${fault}-read-entry-and-late`, actual);
    },
  );
});
