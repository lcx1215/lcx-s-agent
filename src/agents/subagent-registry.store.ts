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
import { loadJsonFileDetailed, saveJsonFile } from "../infra/json-file.js";
import { logWarn } from "../logger.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/**
 * How the registry file looked the last time it was read. "absent" is a normal
 * first run; "unreadable"/"corrupt" mean there *is* a file and it could not be
 * turned into state — in which case the in-memory map is empty but the file on
 * disk is still the only copy of the truth, so writes are blocked.
 */
export type SubagentRegistryLoadStatus =
  | { state: "ok" }
  | { state: "absent" }
  | { state: "unreadable"; code: string }
  | { state: "corrupt"; code: string };

let registryLoadStatus: SubagentRegistryLoadStatus = { state: "absent" };
let warnedWriteBlocked = false;

export function getSubagentRegistryLoadStatus(): SubagentRegistryLoadStatus {
  return registryLoadStatus;
}

export function resetSubagentRegistryStoreForTests() {
  registryLoadStatus = { state: "absent" };
  warnedWriteBlocked = false;
}

function isRegistryWriteBlocked(): boolean {
  return registryLoadStatus.state === "unreadable" || registryLoadStatus.state === "corrupt";
}

export function describeSubagentRegistryLoadStatus(): string {
  if (registryLoadStatus.state === "ok" || registryLoadStatus.state === "absent") {
    return registryLoadStatus.state;
  }
  return `${registryLoadStatus.state}/${registryLoadStatus.code}`;
}

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
  invalid: boolean;
} {
  if (!raw || typeof raw !== "object") {
    return { runs: new Map(), migrated: false, invalid: true };
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    return { runs: new Map(), migrated: false, invalid: true };
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    return { runs: new Map(), migrated: false, invalid: true };
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
  return { runs: out, migrated, invalid: false };
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
  const loaded = loadJsonFileDetailed(pathname);
  warnedWriteBlocked = false;
  if (loaded.status !== "ok") {
    registryLoadStatus =
      loaded.status === "corrupt"
        ? { state: "corrupt", code: loaded.code }
        : { state: loaded.status, code: loaded.code };
    logWarn(
      `[subagent-registry] cannot read ${pathname} (${describeSubagentRegistryLoadStatus()}): the registry is treated as empty and writes are blocked`,
    );
    return new Map();
  }
  const parsed = parseSubagentRegistry(loaded.value);
  if (parsed.invalid) {
    registryLoadStatus = { state: "corrupt", code: "UNRECOGNISED_REGISTRY_SHAPE" };
    logWarn(
      `[subagent-registry] unrecognised registry at ${pathname}: the registry is treated as empty and writes are blocked`,
    );
    return new Map();
  }
  registryLoadStatus = { state: "ok" };
  if (parsed.migrated) {
    try {
      saveSubagentRegistryToDisk(parsed.runs);
    } catch {
      // ignore migration write failures
    }
  }
  return parsed.runs;
}

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>): boolean {
  // The in-memory map is empty when the file on disk could not be read. Writing
  // that emptiness back would replace the only remaining copy of these runs
  // with `{}`, so hold writes until a load actually succeeds.
  if (isRegistryWriteBlocked()) {
    if (!warnedWriteBlocked) {
      warnedWriteBlocked = true;
      logWarn(
        `[subagent-registry] refusing to overwrite ${resolveSubagentRegistryPath()}: last load was ${describeSubagentRegistryLoadStatus()}`,
      );
    }
    return false;
  }
  const pathname = resolveSubagentRegistryPath();
  saveJsonFile(pathname, serializeSubagentRegistry(runs));
  return true;
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
