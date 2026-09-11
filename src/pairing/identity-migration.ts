import fs from "node:fs";
import path from "node:path";
import {
  createLcxIdentityWriterPathContract,
  readLcxIdentityWriterRaw,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  LcxIdentityWriterContractError,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../config/paths.js";
import type { PairingChannel, PairingRequest } from "./pairing-store.js";

export type LcxIdentityChannelPairingStoreKind = "requests" | "allow-from";

export type LcxIdentityChannelPairingMigration = Readonly<{
  channel: PairingChannel;
  kind: LcxIdentityChannelPairingStoreKind;
  accountId: string | null;
  relativePath: string;
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "channel-pairing" }>;
  readStorePath: string;
  writeStorePath: string;
}>;

export type ChannelPairingStoreSnapshot =
  | { version: 1; requests: PairingRequest[] }
  | { version: 1; allowFrom: string[] };

function safeChannelKey(channel: PairingChannel): string {
  const raw = String(channel).trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid pairing channel");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing channel");
  }
  return safe;
}

function safeAccountKey(accountId: string): string {
  const raw = String(accountId).trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid pairing account id");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing account id");
  }
  return safe;
}

function relativeStorePath(params: {
  channel: PairingChannel;
  kind: LcxIdentityChannelPairingStoreKind;
  accountId?: string | null;
}): string {
  const channelKey = safeChannelKey(params.channel);
  if (params.kind === "requests") {
    return path.join("credentials", `${channelKey}-pairing.json`);
  }
  const accountId = params.accountId?.trim();
  return path.join(
    "credentials",
    accountId
      ? `${channelKey}-${safeAccountKey(accountId)}-allowFrom.json`
      : `${channelKey}-allowFrom.json`,
  );
}

function resolveReadRoot(
  migrationPlan: LcxIdentityMigrationPlan,
  relativePath: string,
  existsSync: (candidate: string) => boolean,
): string {
  const writePath = path.join(migrationPlan.writeStateDir, relativePath);
  if (existsSync(writePath)) {
    return migrationPlan.writeStateDir;
  }
  const legacyRoots = migrationPlan.readStateDirs.filter((root) => {
    if (path.resolve(root) === path.resolve(migrationPlan.writeStateDir)) {
      return false;
    }
    return existsSync(path.join(root, relativePath));
  });
  if (legacyRoots.length > 1) {
    throw new LcxIdentityWriterContractError(
      `Channel pairing state exists in multiple legacy roots: ${legacyRoots.join(", ")}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  return legacyRoots[0] ?? migrationPlan.readStateDir;
}

function resolveCurrentChannelPairingMigration(
  migration: LcxIdentityChannelPairingMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "channel-pairing" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return createLcxIdentityWriterPathContract({
    writer: "channel-pairing",
    migrationPlan: plan,
    readPath: path.join(
      resolveReadRoot(plan, migration.relativePath, fs.existsSync),
      migration.relativePath,
    ),
    writePath: migration.writeStorePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export function createLcxIdentityChannelPairingMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  channel: PairingChannel;
  kind: LcxIdentityChannelPairingStoreKind;
  accountId?: string | null;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityChannelPairingMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Channel pairing migration requires a state-root authority");
  }
  const relativePath = relativeStorePath(params);
  const readRoot = resolveReadRoot(
    params.migrationPlan,
    relativePath,
    params.existsSync ?? fs.existsSync,
  );
  const writeStorePath = path.join(params.migrationPlan.writeStateDir, relativePath);
  const pathContract = createLcxIdentityWriterPathContract({
    writer: "channel-pairing",
    migrationPlan: params.migrationPlan,
    readPath: path.join(readRoot, relativePath),
    writePath: writeStorePath,
  });
  return Object.freeze({
    channel: params.channel,
    kind: params.kind,
    accountId: params.accountId?.trim() || null,
    relativePath,
    pathContract,
    readStorePath: pathContract.readPath,
    writeStorePath,
  });
}

function parseSnapshot(
  kind: LcxIdentityChannelPairingStoreKind,
  raw: string | null,
): ChannelPairingStoreSnapshot {
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (kind === "requests" && Array.isArray(parsed.requests)) {
        return { version: 1, requests: parsed.requests as PairingRequest[] };
      }
      if (kind === "allow-from" && Array.isArray(parsed.allowFrom)) {
        return {
          version: 1,
          allowFrom: parsed.allowFrom.filter((value): value is string => typeof value === "string"),
        };
      }
    } catch {
      // Treat malformed legacy state as empty, matching the runtime reader.
    }
  }
  return kind === "requests" ? { version: 1, requests: [] } : { version: 1, allowFrom: [] };
}

export async function readChannelPairingStoreForIdentityMigration(
  migration: LcxIdentityChannelPairingMigration,
): Promise<ChannelPairingStoreSnapshot> {
  const raw = await readLcxIdentityWriterRaw(resolveCurrentChannelPairingMigration(migration));
  return parseSnapshot(migration.kind, raw);
}

export async function writeChannelPairingStoreForIdentityMigration(
  migration: LcxIdentityChannelPairingMigration,
  snapshot: ChannelPairingStoreSnapshot,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const normalized =
    migration.kind === "requests"
      ? { version: 1 as const, requests: "requests" in snapshot ? snapshot.requests : [] }
      : { version: 1 as const, allowFrom: "allowFrom" in snapshot ? snapshot.allowFrom : [] };
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentChannelPairingMigration(migration),
    `${JSON.stringify(normalized, null, 2)}\n`,
    options,
  );
}

export async function rollbackChannelPairingIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
