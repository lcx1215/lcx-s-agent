import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createLcxIdentityWriterPathContract,
  readLcxIdentityWriterRaw,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  LcxIdentityWriterContractError,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../../src/config/identity-migration.js";
import { createConfigIO, type ConfigIoDeps, type ConfigWriteReceipt } from "../../src/config/io.js";
import type { LcxIdentityMigrationPlan } from "../../src/config/paths.js";
import type { OpenClawConfig } from "../../src/config/types.js";

const ARM_STATE_RELATIVE_PATH = path.join("plugins", "phone-control", "armed.json");

export type LcxIdentityPhoneControlMigration = Readonly<{
  migrationPlan: LcxIdentityMigrationPlan;
  statePathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "phone-control" }>;
  readStatePath: string;
  writeStatePath: string;
  configIO: ReturnType<typeof createConfigIO>;
}>;

export type LcxIdentityPhoneControlWriteReceipt = Readonly<{
  config: ConfigWriteReceipt;
  state: LcxIdentityWriteReceipt;
}>;

function resolvePhoneControlReadRoot(
  migrationPlan: LcxIdentityMigrationPlan,
  existsSync: (candidate: string) => boolean,
): string {
  const writePath = path.join(migrationPlan.writeStateDir, ARM_STATE_RELATIVE_PATH);
  if (existsSync(writePath)) {
    return migrationPlan.writeStateDir;
  }
  const legacyRoots = migrationPlan.readStateDirs.filter((root) => {
    if (path.resolve(root) === path.resolve(migrationPlan.writeStateDir)) {
      return false;
    }
    return existsSync(path.join(root, ARM_STATE_RELATIVE_PATH));
  });
  if (legacyRoots.length > 1) {
    throw new LcxIdentityWriterContractError(
      `Phone-control state exists in multiple legacy roots: ${legacyRoots.join(", ")}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  return legacyRoots[0] ?? migrationPlan.readStateDir;
}

function resolveStatePathContract(
  migrationPlan: LcxIdentityMigrationPlan,
  existsSync: (candidate: string) => boolean,
): LcxIdentityWriterPathContract & Readonly<{ writer: "phone-control" }> {
  const readRoot = resolvePhoneControlReadRoot(migrationPlan, existsSync);
  return createLcxIdentityWriterPathContract({
    writer: "phone-control",
    migrationPlan,
    readPath: path.join(readRoot, ARM_STATE_RELATIVE_PATH),
    writePath: path.join(migrationPlan.writeStateDir, ARM_STATE_RELATIVE_PATH),
  });
}

function resolveCurrentPhoneControlStateContract(
  migration: LcxIdentityPhoneControlMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "phone-control" }> {
  const plan = migration.migrationPlan;
  const readRoot = resolvePhoneControlReadRoot(plan, fsSync.existsSync);
  return createLcxIdentityWriterPathContract({
    writer: "phone-control",
    migrationPlan: plan,
    readPath: path.join(readRoot, ARM_STATE_RELATIVE_PATH),
    writePath: migration.writeStatePath,
    backupPath: migration.statePathContract.backupPath,
    auditPath: migration.statePathContract.auditPath,
  });
}

export function createLcxIdentityPhoneControlMigration(
  params: Omit<ConfigIoDeps, "lcxIdentityMigrationPlan"> & {
    migrationPlan: LcxIdentityMigrationPlan;
  },
): LcxIdentityPhoneControlMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Phone-control migration requires a state-root authority");
  }
  const statePathContract = resolveStatePathContract(
    params.migrationPlan,
    params.fs?.existsSync ?? fsSync.existsSync,
  );
  const { migrationPlan: _migrationPlan, ...configOverrides } = params;
  const configIO = createConfigIO({
    ...configOverrides,
    lcxIdentityMigrationPlan: params.migrationPlan,
  });
  return Object.freeze({
    migrationPlan: params.migrationPlan,
    statePathContract,
    readStatePath: statePathContract.readPath,
    writeStatePath: statePathContract.writePath,
    configIO,
  });
}

export async function readPhoneControlIdentityMigration(
  migration: LcxIdentityPhoneControlMigration,
): Promise<{
  config: OpenClawConfig;
  configExists: boolean;
  configPath: string;
  stateRaw: string | null;
  statePath: string;
}> {
  const snapshot = await migration.configIO.readConfigFileSnapshot();
  const statePathContract = resolveCurrentPhoneControlStateContract(migration);
  const stateRaw = await readLcxIdentityWriterRaw(statePathContract);
  return {
    config: snapshot.config,
    configExists: snapshot.exists,
    configPath: snapshot.path,
    stateRaw,
    statePath: statePathContract.readPath,
  };
}

export async function writePhoneControlForIdentityMigration(
  migration: LcxIdentityPhoneControlMigration,
  config: OpenClawConfig,
  stateRaw: string,
): Promise<LcxIdentityPhoneControlWriteReceipt> {
  const observed = await readPhoneControlIdentityMigration(migration);
  if (!observed.configExists || observed.stateRaw === null) {
    throw new LcxIdentityWriterContractError(
      "Phone-control migration requires both config and arm state authorities",
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  const configIsCanonical =
    path.resolve(migration.configIO.pathContract.readPath) ===
    path.resolve(migration.configIO.pathContract.writePath);
  const stateIsCanonical =
    path.resolve(observed.statePath) === path.resolve(migration.writeStatePath);
  if (configIsCanonical !== stateIsCanonical) {
    throw new LcxIdentityWriterContractError(
      "Phone-control config and arm state must migrate from the same authority",
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  const configReceipt = await migration.configIO.writeConfigFileWithReceipt(config, {
    expectedReadPath: migration.configIO.pathContract.readPath,
    expectedWritePath: migration.configIO.pathContract.writePath,
  });
  try {
    const statePathContract = resolveCurrentPhoneControlStateContract(migration);
    const stateReceipt = await writeLcxIdentityWriterRawWithReceipt(statePathContract, stateRaw, {
      expectedReadPath: statePathContract.expectedReadPath,
      expectedWritePath: statePathContract.expectedWritePath,
    });
    return Object.freeze({ config: configReceipt, state: stateReceipt });
  } catch (error) {
    await migration.configIO.rollbackConfigFileWrite(configReceipt);
    throw error;
  }
}

export async function rollbackPhoneControlIdentityMigration(
  migration: LcxIdentityPhoneControlMigration,
  receipt: LcxIdentityPhoneControlWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt.state);
  await migration.configIO.rollbackConfigFileWrite(receipt.config);
}
