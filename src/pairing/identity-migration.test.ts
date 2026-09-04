import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  createLcxIdentityChannelPairingMigration,
  readChannelPairingStoreForIdentityMigration,
  rollbackChannelPairingIdentityMigration,
  writeChannelPairingStoreForIdentityMigration,
} from "./identity-migration.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-channel-pairing-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("channel pairing identity migration writers", () => {
  it("migrates pairing requests and account allowlist state with backup and rollback", async () => {
    const root = await createRoot();
    const requestPath = path.join(root, ".openclaw", "credentials", "telegram-pairing.json");
    const allowPath = path.join(
      root,
      ".openclaw",
      "credentials",
      "telegram-primary-allowFrom.json",
    );
    await mkdir(path.dirname(requestPath), { recursive: true });
    await writeFile(requestPath, '{"version":1,"requests":[{"id":"u1","code":"ABCD"}]}\n');
    await writeFile(allowPath, '{"version":1,"allowFrom":["u0"]}\n');
    const plan = resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root });

    const requests = createLcxIdentityChannelPairingMigration({
      migrationPlan: plan,
      channel: "telegram",
      kind: "requests",
    });
    const allowFrom = createLcxIdentityChannelPairingMigration({
      migrationPlan: plan,
      channel: "telegram",
      kind: "allow-from",
      accountId: "primary",
    });
    await expect(readChannelPairingStoreForIdentityMigration(requests)).resolves.toMatchObject({
      requests: [{ id: "u1" }],
    });
    await expect(readChannelPairingStoreForIdentityMigration(allowFrom)).resolves.toEqual({
      version: 1,
      allowFrom: ["u0"],
    });

    const first = await writeChannelPairingStoreForIdentityMigration(requests, {
      version: 1,
      requests: [{ id: "u1", code: "ABCD", createdAt: "now", lastSeenAt: "now" }],
    });
    await writeChannelPairingStoreForIdentityMigration(allowFrom, {
      version: 1,
      allowFrom: ["u0", "u1"],
    });
    const canonicalRequestPath = path.join(root, ".lcx", "credentials", "telegram-pairing.json");
    expect(JSON.parse(await readFile(canonicalRequestPath, "utf8")).requests).toHaveLength(1);
    const second = await writeChannelPairingStoreForIdentityMigration(requests, {
      version: 1,
      requests: [],
    });
    expect(JSON.parse(await readFile(`${canonicalRequestPath}.bak`, "utf8")).requests).toHaveLength(
      1,
    );
    await rollbackChannelPairingIdentityMigration(second);
    expect(JSON.parse(await readFile(canonicalRequestPath, "utf8")).requests).toHaveLength(1);
    expect(first.previous.exists).toBe(false);
    const audit = await readFile(requests.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"channel-pairing"');
  });

  it("rejects multiple legacy roots and config-only authority", async () => {
    const root = await createRoot();
    for (const dirname of [".openclaw", ".clawdbot"]) {
      const filePath = path.join(root, dirname, "credentials", "telegram-pairing.json");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, '{"version":1,"requests":[]}\n');
    }
    expect(() =>
      createLcxIdentityChannelPairingMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
        channel: "telegram",
        kind: "requests",
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));

    expect(() =>
      createLcxIdentityChannelPairingMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({
          env: { OPENCLAW_CONFIG_PATH: path.join(root, "lcx.json") },
          homedir: () => root,
        }),
        channel: "telegram",
        kind: "requests",
      }),
    ).toThrow("state-root authority");
  });
});
