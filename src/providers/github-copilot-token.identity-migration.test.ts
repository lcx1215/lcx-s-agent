import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityCopilotTokenMigration,
  readCopilotTokenForIdentityMigration,
  resolveCopilotApiToken,
  rollbackCopilotTokenIdentityMigration,
  writeCopilotTokenForIdentityMigration,
} from "./github-copilot-token.js";

const tempRoots: string[] = [];

async function createLegacyMigration() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-copilot-token-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, ".openclaw", "credentials"), { recursive: true });
  const migrationPlan = resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root });
  return createLcxIdentityCopilotTokenMigration({ migrationPlan });
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("LCX GitHub Copilot token identity migration", () => {
  it("reads legacy cache, writes canonical cache, removes the legacy duplicate, and rolls back", async () => {
    const migration = await createLegacyMigration();
    const legacyToken = {
      token: "legacy-token;proxy-ep=proxy.example.com;",
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
    };
    await fs.writeFile(migration.pathContract.readPath, `${JSON.stringify(legacyToken)}\n`, "utf8");

    await expect(readCopilotTokenForIdentityMigration(migration)).resolves.toEqual(legacyToken);
    const receipt = await writeCopilotTokenForIdentityMigration(migration, {
      ...legacyToken,
      token: "canonical-token;proxy-ep=proxy.example.com;",
    });
    expect(receipt.removedLegacy).toBeDefined();
    await expect(fs.access(migration.pathContract.readPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readCopilotTokenForIdentityMigration(migration)).resolves.toMatchObject({
      token: "canonical-token;proxy-ep=proxy.example.com;",
    });
    const audit = await fs.readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).not.toContain("canonical-token");

    await rollbackCopilotTokenIdentityMigration(receipt);
    await expect(fs.access(migration.pathContract.writePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(migration.pathContract.readPath, "utf8")).resolves.toContain(
      "legacy-token",
    );
  });

  it("uses the identity writer for a fetched token and rejects split credential state", async () => {
    const migration = await createLegacyMigration();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "fresh-token;proxy-ep=proxy.example.com;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    await expect(
      resolveCopilotApiToken({
        githubToken: "gh",
        identityMigration: migration,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ token: "fresh-token;proxy-ep=proxy.example.com;" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await fs.writeFile(migration.pathContract.readPath, "legacy", "utf8");
    await expect(readCopilotTokenForIdentityMigration(migration)).rejects.toMatchObject({
      code: "LCX_IDENTITY_SPLIT_STATE",
    });
  });
});
