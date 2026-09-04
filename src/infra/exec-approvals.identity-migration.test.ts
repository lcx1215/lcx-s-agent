import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityExecApprovalsMigration,
  ensureExecApprovalsForIdentityMigration,
  readExecApprovalsSnapshotForIdentityMigration,
  rollbackExecApprovalsIdentityMigration,
  writeExecApprovalsForIdentityMigration,
} from "./exec-approvals.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-exec-approvals-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

describe("exec approvals identity migration writer", () => {
  it("migrates JSON state, preserves the socket boundary, and rolls back without the token in audit", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "exec-approvals.json");
    const legacyToken = "legacy-approval-token";
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify(
        {
          version: 1,
          socket: { path: "/tmp/existing-exec-approvals.sock", token: legacyToken },
          agents: { default: { allowlist: ["echo"] } },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const migration = createLcxIdentityExecApprovalsMigration({
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readApprovalsPath).toBe(legacyPath);
    await expect(readExecApprovalsSnapshotForIdentityMigration(migration)).resolves.toMatchObject({
      exists: true,
      file: { agents: { main: { allowlist: [{ pattern: "echo" }] } } },
    });

    const ensured = await ensureExecApprovalsForIdentityMigration(migration);
    const canonicalPath = path.join(root, ".lcx", "exec-approvals.json");
    expect(ensured.file.socket?.token).toBe(legacyToken);
    expect((await stat(canonicalPath)).mode & 0o777).toBe(0o600);
    expect(migration.writeSocketPath).toBe(path.join(root, ".lcx", "exec-approvals.sock"));
    expect(await readFile(migration.writeSocketPath).catch(() => null)).toBeNull();

    const replacement = {
      ...ensured.file,
      socket: { path: migration.writeSocketPath, token: "replacement-approval-token" },
    };
    const replacementReceipt = await writeExecApprovalsForIdentityMigration(migration, replacement);
    expect(JSON.parse(await readFile(`${canonicalPath}.bak`, "utf8"))).toMatchObject({
      socket: { token: legacyToken },
    });
    await rollbackExecApprovalsIdentityMigration(replacementReceipt);
    await expect(readExecApprovalsSnapshotForIdentityMigration(migration)).resolves.toMatchObject({
      file: { socket: { token: legacyToken } },
    });

    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"exec-approvals"');
    expect(audit).not.toContain(legacyToken);
    expect(audit).not.toContain("replacement-approval-token");
  });

  it("uses an explicit state override and rejects config-only authority", async () => {
    const root = await createRoot();
    const stateDir = path.join(root, "operator-state");
    const migration = createLcxIdentityExecApprovalsMigration({
      migrationPlan: migrationPlan(root, { OPENCLAW_STATE_DIR: stateDir }),
    });
    const receipt = await writeExecApprovalsForIdentityMigration(
      migration,
      {
        version: 1,
        agents: {},
      },
      {
        expectedReadPath: migration.readApprovalsPath,
        expectedWritePath: migration.writeApprovalsPath,
      },
    );
    expect(migration.readApprovalsPath).toBe(migration.writeApprovalsPath);
    await rollbackExecApprovalsIdentityMigration(receipt);

    expect(() =>
      createLcxIdentityExecApprovalsMigration({
        migrationPlan: migrationPlan(root, {
          OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json"),
        }),
      }),
    ).toThrow("state-root authority");
  });
});
