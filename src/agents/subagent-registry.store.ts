import os from "node:os";
import path from "node:path";
import {
  readLcxIdentityWriterRaw,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import { resolveStateDir } from "../config/paths.js";
import type { LcxIdentityMigrationPlan } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type PersistedSubagentRegistryVersion = 1 | 2;

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

const REGISTRY_VERSION = 2 as const;
const SUBAGENT_REGISTRY_RELATIVE_PATH = path.join("subagents", "runs.json");

type PersistedSubagentRunRecord = SubagentRunRecord;

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

export type LcxIdentitySubagentRegistryMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "subagents" }>;
  readRegistryPath: string;
  writeRegistryPath: string;
}>;

function resolveCurrentSubagentRegistryPathContract(
  migration: LcxIdentitySubagentRegistryMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "subagents" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "subagents",
    migrationPlan: plan,
    relativePath: SUBAGENT_REGISTRY_RELATIVE_PATH,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

function parseSubagentRegistry(raw: unknown): {
  runs: Map<string, SubagentRunRecord>;
  migrated: boolean;
} {
  if (!raw || typeof raw !== "object") {
    return { runs: new Map(), migrated: false };
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    return { runs: new Map(), migrated: false };
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    return { runs: new Map(), migrated: false };
  }
  const out = new Map<string, SubagentRunRecord>();
  const isLegacy = record.version === 1;
  let migrated = false;
  for (const [runId, entry] of Object.entries(runsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as LegacySubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    const legacyCompletedAt =
      isLegacy && typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    const cleanupCompletedAt =
      typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
    const cleanupHandled =
      typeof typed.cleanupHandled === "boolean"
        ? typed.cleanupHandled
        : isLegacy
          ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
          : undefined;
    const requesterOrigin = normalizeDeliveryContext(
      typed.requesterOrigin ?? {
        channel: typeof typed.requesterChannel === "string" ? typed.requesterChannel : undefined,
        accountId:
          typeof typed.requesterAccountId === "string" ? typed.requesterAccountId : undefined,
      },
    );
    const {
      announceCompletedAt: _announceCompletedAt,
      announceHandled: _announceHandled,
      requesterChannel: _channel,
      requesterAccountId: _accountId,
      ...rest
    } = typed;
    out.set(runId, {
      ...rest,
      requesterOrigin,
      cleanupCompletedAt,
      cleanupHandled,
      spawnMode: typed.spawnMode === "session" ? "session" : "run",
    });
    if (isLegacy) {
      migrated = true;
    }
  }
  return { runs: out, migrated };
}

function serializeSubagentRegistry(
  runs: Map<string, SubagentRunRecord>,
): PersistedSubagentRegistry {
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = entry;
  }
  return {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
}

export function createLcxIdentitySubagentRegistryMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentitySubagentRegistryMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Subagent registry migration requires a state-root authority");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "subagents",
    migrationPlan: params.migrationPlan,
    relativePath: SUBAGENT_REGISTRY_RELATIVE_PATH,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readRegistryPath: pathContract.readPath,
    writeRegistryPath: pathContract.writePath,
  });
}

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

export function resolveSubagentRegistryPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  const pathname = resolveSubagentRegistryPath();
  const raw = loadJsonFile(pathname);
  const parsed = parseSubagentRegistry(raw);
  if (parsed.migrated) {
    try {
      saveSubagentRegistryToDisk(parsed.runs);
    } catch {
      // ignore migration write failures
    }
  }
  return parsed.runs;
}

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>) {
  const pathname = resolveSubagentRegistryPath();
  saveJsonFile(pathname, serializeSubagentRegistry(runs));
}

export async function readSubagentRegistryForIdentityMigration(
  migration: LcxIdentitySubagentRegistryMigration,
): Promise<Map<string, SubagentRunRecord>> {
  const pathContract = resolveCurrentSubagentRegistryPathContract(migration);
  const raw = await readLcxIdentityWriterRaw(pathContract);
  if (raw === null) {
    return new Map();
  }
  try {
    return parseSubagentRegistry(JSON.parse(raw)).runs;
  } catch {
    return new Map();
  }
}

export async function writeSubagentRegistryForIdentityMigration(
  migration: LcxIdentitySubagentRegistryMigration,
  runs: Map<string, SubagentRunRecord>,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const pathContract = resolveCurrentSubagentRegistryPathContract(migration);
  return await writeLcxIdentityWriterRawWithReceipt(
    pathContract,
    `${JSON.stringify(serializeSubagentRegistry(runs), null, 2)}\n`,
    options,
  );
}

export async function rollbackSubagentRegistryIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
