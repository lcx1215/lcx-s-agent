import path from "node:path";
import {
  readLcxIdentityWriterRaw,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../../config/identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../../config/paths.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { AUTH_PROFILE_FILENAME } from "./constants.js";
import type { AuthProfileStore } from "./types.js";

export type LcxIdentityAuthProfileMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "credentials" }>;
  agentId: string;
  readAgentDir: string;
  writeAgentDir: string;
  readAuthStorePath: string;
  writeAuthStorePath: string;
}>;

export function createLcxIdentityAuthProfileMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  agentId?: string;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityAuthProfileMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Credential identity migration requires a state-root authority");
  }
  const agentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  const relativePath = path.join("agents", agentId, "agent", AUTH_PROFILE_FILENAME);
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "credentials",
    migrationPlan: params.migrationPlan,
    relativePath,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    agentId,
    readAgentDir: path.dirname(pathContract.readPath),
    writeAgentDir: path.dirname(pathContract.writePath),
    readAuthStorePath: pathContract.readPath,
    writeAuthStorePath: pathContract.writePath,
  });
}

export async function readAuthProfileStoreForIdentityMigration(
  migration: LcxIdentityAuthProfileMigration,
): Promise<AuthProfileStore | null> {
  const raw = await readLcxIdentityWriterRaw(migration.pathContract);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as AuthProfileStore;
  } catch {
    return null;
  }
}

export async function writeAuthProfileStoreForIdentityMigration(
  migration: LcxIdentityAuthProfileMigration,
  store: AuthProfileStore,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  return await writeLcxIdentityWriterRawWithReceipt(
    migration.pathContract,
    `${JSON.stringify(store, null, 2)}\n`,
    options,
  );
}

export async function rollbackAuthProfileIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
