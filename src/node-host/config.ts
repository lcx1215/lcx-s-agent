import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  readLcxIdentityWriterRaw,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../config/paths.js";
import { resolveStateDir } from "../config/paths.js";
import { writeJsonAtomic } from "../infra/json-files.js";

export type NodeHostGatewayConfig = {
  host?: string;
  port?: number;
  tls?: boolean;
  tlsFingerprint?: string;
};

export type NodeHostConfig = {
  version: 1;
  nodeId: string;
  token?: string;
  displayName?: string;
  gateway?: NodeHostGatewayConfig;
};

const NODE_HOST_FILE = "node.json";
const NODE_HOST_RELATIVE_PATH = NODE_HOST_FILE;

export function resolveNodeHostConfigPath(): string {
  return path.join(resolveStateDir(), NODE_HOST_FILE);
}

function normalizeConfig(config: Partial<NodeHostConfig> | null): NodeHostConfig {
  const base: NodeHostConfig = {
    version: 1,
    nodeId: "",
    token: config?.token,
    displayName: config?.displayName,
    gateway: config?.gateway,
  };
  if (config?.version === 1 && typeof config.nodeId === "string") {
    base.nodeId = config.nodeId.trim();
  }
  if (!base.nodeId) {
    base.nodeId = crypto.randomUUID();
  }
  return base;
}

export type LcxIdentityNodeHostMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "node-host" }>;
  readNodeHostConfigPath: string;
  writeNodeHostConfigPath: string;
}>;

export function createLcxIdentityNodeHostMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityNodeHostMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Node host migration requires a state-root authority");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "node-host",
    migrationPlan: params.migrationPlan,
    relativePath: NODE_HOST_RELATIVE_PATH,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readNodeHostConfigPath: pathContract.readPath,
    writeNodeHostConfigPath: pathContract.writePath,
  });
}

function resolveCurrentNodeHostPathContract(
  migration: LcxIdentityNodeHostMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "node-host" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "node-host",
    migrationPlan: plan,
    relativePath: NODE_HOST_RELATIVE_PATH,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export async function readNodeHostConfigForIdentityMigration(
  migration: LcxIdentityNodeHostMigration,
): Promise<NodeHostConfig | null> {
  const raw = await readLcxIdentityWriterRaw(resolveCurrentNodeHostPathContract(migration));
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NodeHostConfig>;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

export async function writeNodeHostConfigForIdentityMigration(
  migration: LcxIdentityNodeHostMigration,
  config: NodeHostConfig,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentNodeHostPathContract(migration),
    `${JSON.stringify(normalizeConfig(config), null, 2)}\n`,
    options,
  );
}

export async function rollbackNodeHostIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export async function loadNodeHostConfig(): Promise<NodeHostConfig | null> {
  const filePath = resolveNodeHostConfigPath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<NodeHostConfig>;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

export async function saveNodeHostConfig(config: NodeHostConfig): Promise<void> {
  const filePath = resolveNodeHostConfigPath();
  await writeJsonAtomic(filePath, config, { mode: 0o600 });
}

export async function ensureNodeHostConfig(): Promise<NodeHostConfig> {
  const existing = await loadNodeHostConfig();
  const normalized = normalizeConfig(existing);
  await saveNodeHostConfig(normalized);
  return normalized;
}
