import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcxIdentityMigrationPlan } from "../config/paths.js";
import {
  listDevicePairing,
  requestDevicePairing,
  type DevicePairingPendingRequest,
  type PairedDevice,
} from "./device-pairing.js";
import { approveNodePairing, listNodePairing, requestNodePairing } from "./node-pairing.js";
import {
  createLcxIdentityPairingMigration,
  readPairingStateForIdentityMigration,
  rollbackPairingIdentityMigration,
  writePairingStateForIdentityMigration,
} from "./pairing-files.js";

async function createRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "lcx-pairing-migration-"));
}

function migrationPlan(root: string, env: NodeJS.ProcessEnv = {}) {
  return resolveLcxIdentityMigrationPlan({ env, homedir: () => root });
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

describe("pairing identity migration writer", () => {
  it("migrates device pairing through the real request writer and rolls back both files", async () => {
    const root = await createRoot();
    const legacyPending = {
      "legacy-request": {
        requestId: "legacy-request",
        deviceId: "legacy-device",
        publicKey: "legacy-public-key",
        ts: 1,
      } satisfies DevicePairingPendingRequest,
    };
    const legacyPaired = {
      "legacy-device": {
        deviceId: "legacy-device",
        publicKey: "legacy-public-key",
        tokens: {
          operator: {
            token: "legacy-device-token",
            role: "operator",
            scopes: ["operator.read"],
            createdAtMs: 1,
          },
        },
        createdAtMs: 1,
        approvedAtMs: 1,
      } satisfies PairedDevice,
    };
    await writeJson(path.join(root, ".openclaw", "devices", "pending.json"), legacyPending);
    await writeJson(path.join(root, ".openclaw", "devices", "paired.json"), legacyPaired);

    const migration = createLcxIdentityPairingMigration({
      kind: "device",
      migrationPlan: migrationPlan(root),
    });
    expect(migration.readDir).toBe(path.join(root, ".openclaw", "devices"));

    const requested = await requestDevicePairing(
      {
        deviceId: "new-device",
        publicKey: "new-public-key",
        role: "operator",
        scopes: ["operator.read"],
      },
      migration,
    );
    expect(requested.created).toBe(true);

    const canonicalPending = path.join(root, ".lcx", "devices", "pending.json");
    const canonicalPaired = path.join(root, ".lcx", "devices", "paired.json");
    expect((await stat(canonicalPending)).mode & 0o777).toBe(0o600);
    expect((await stat(canonicalPaired)).mode & 0o777).toBe(0o600);
    await expect(listDevicePairing(migration)).resolves.toMatchObject({
      pending: [expect.objectContaining({ deviceId: "new-device" })],
      paired: [expect.objectContaining({ deviceId: "legacy-device" })],
    });

    const current = await readPairingStateForIdentityMigration<
      DevicePairingPendingRequest,
      PairedDevice
    >(migration);
    const receipt = await writePairingStateForIdentityMigration({
      migration,
      state: current,
    });
    expect(JSON.parse(await readFile(`${canonicalPaired}.bak`, "utf8"))).toMatchObject({
      "legacy-device": { tokens: { operator: { token: "legacy-device-token" } } },
    });
    await rollbackPairingIdentityMigration(receipt);
    await expect(listDevicePairing(migration)).resolves.toMatchObject({
      pending: [expect.objectContaining({ deviceId: "new-device" })],
      paired: [expect.objectContaining({ deviceId: "legacy-device" })],
    });

    const audit = await readFile(migration.pendingPathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"device-pairing"');
    expect(audit).not.toContain("legacy-device-token");
  });

  it("uses the shared transaction for node pairing and rejects partial split roots", async () => {
    const root = await createRoot();
    const migration = createLcxIdentityPairingMigration({
      kind: "node",
      migrationPlan: migrationPlan(root, {
        OPENCLAW_STATE_DIR: path.join(root, "operator-state"),
      }),
    });
    const requested = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
      },
      migration,
    );
    await approveNodePairing(requested.request.requestId, migration);
    await expect(listNodePairing(migration)).resolves.toMatchObject({
      paired: [expect.objectContaining({ nodeId: "node-1" })],
    });
    expect(migration.readDir).toBe(migration.writeDir);

    const splitRoot = await createRoot();
    await writeJson(path.join(splitRoot, ".lcx", "devices", "pending.json"), {});
    await writeJson(path.join(splitRoot, ".openclaw", "devices", "paired.json"), {});
    expect(() =>
      createLcxIdentityPairingMigration({
        kind: "device",
        migrationPlan: migrationPlan(splitRoot),
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));
  });
});
