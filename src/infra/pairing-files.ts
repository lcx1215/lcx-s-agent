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
import { resolveStateDir } from "../config/paths.js";

export { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

export type LcxIdentityPairingKind = "device" | "node";
export type LcxIdentityPairingWriterName = "device-pairing" | "node-pairing";

export type LcxIdentityPairingMigration = Readonly<{
  kind: LcxIdentityPairingKind;
  subdir: "devices" | "nodes";
  readDir: string;
  writeDir: string;
  pendingPathContract: LcxIdentityWriterPathContract &
    Readonly<{ writer: LcxIdentityPairingWriterName }>;
  pairedPathContract: LcxIdentityWriterPathContract &
    Readonly<{ writer: LcxIdentityPairingWriterName }>;
  readPendingPath: string;
  writePendingPath: string;
  readPairedPath: string;
  writePairedPath: string;
}>;

export type LcxIdentityPairingState<TPending = unknown, TPaired = unknown> = Readonly<{
  pending: Record<string, TPending>;
  paired: Record<string, TPaired>;
}>;

export type LcxIdentityPairingWriteReceipt = Readonly<{
  pending: LcxIdentityWriteReceipt;
  paired: LcxIdentityWriteReceipt;
}>;

function pairingSubdir(kind: LcxIdentityPairingKind): "devices" | "nodes" {
  return kind === "device" ? "devices" : "nodes";
}

function pairingWriterName(kind: LcxIdentityPairingKind): LcxIdentityPairingWriterName {
  return kind === "device" ? "device-pairing" : "node-pairing";
}

function pathExists(existsSync: (candidate: string) => boolean, candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

function resolvePairingReadRoot(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  subdir: "devices" | "nodes";
  existsSync: (candidate: string) => boolean;
}): string {
  const stateFiles = ["pending.json", "paired.json"] as const;
  const hasState = (root: string) =>
    stateFiles.some((filename) =>
      pathExists(params.existsSync, path.join(root, params.subdir, filename)),
    );
  const writeRoot = params.migrationPlan.writeStateDir;
  const writeFiles = stateFiles.filter((filename) =>
    pathExists(params.existsSync, path.join(writeRoot, params.subdir, filename)),
  );
  const otherRootsWithState = params.migrationPlan.readStateDirs.filter(
    (root) => root !== writeRoot && hasState(root),
  );

  // Once both write targets exist, they are the authoritative single state;
  // legacy roots remain readable evidence until activation removes them.
  if (writeFiles.length === stateFiles.length) {
    return writeRoot;
  }
  if (writeFiles.length > 0 && otherRootsWithState.length > 0) {
    throw new LcxIdentityWriterContractError(
      `${params.subdir} pairing migration found partial write state alongside another read root`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  if (writeFiles.length > 0) {
    return writeRoot;
  }
  if (otherRootsWithState.length > 1) {
    throw new LcxIdentityWriterContractError(
      `${params.subdir} pairing migration found state in multiple read roots: ${otherRootsWithState.join(", ")}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  return otherRootsWithState[0] ?? params.migrationPlan.readStateDir;
}

function buildPairingMigration(params: {
  kind: LcxIdentityPairingKind;
  migrationPlan: LcxIdentityMigrationPlan;
  readRoot: string;
  backupPendingPath?: string;
  backupPairedPath?: string;
  auditPath?: string;
}): LcxIdentityPairingMigration {
  const subdir = pairingSubdir(params.kind);
  const writer = pairingWriterName(params.kind);
  const readDir = path.join(params.readRoot, subdir);
  const writeDir = path.join(params.migrationPlan.writeStateDir, subdir);
  const auditPath =
    params.auditPath ??
    path.join(params.migrationPlan.writeStateDir, "logs", "identity-migration-audit.jsonl");
  const pendingPathContract = createLcxIdentityWriterPathContract({
    writer,
    migrationPlan: params.migrationPlan,
    readPath: path.join(readDir, "pending.json"),
    writePath: path.join(writeDir, "pending.json"),
    backupPath: params.backupPendingPath,
    auditPath,
  });
  const pairedPathContract = createLcxIdentityWriterPathContract({
    writer,
    migrationPlan: params.migrationPlan,
    readPath: path.join(readDir, "paired.json"),
    writePath: path.join(writeDir, "paired.json"),
    backupPath: params.backupPairedPath,
    auditPath,
  });
  return Object.freeze({
    kind: params.kind,
    subdir,
    readDir,
    writeDir,
    pendingPathContract,
    pairedPathContract,
    readPendingPath: pendingPathContract.readPath,
    writePendingPath: pendingPathContract.writePath,
    readPairedPath: pairedPathContract.readPath,
    writePairedPath: pairedPathContract.writePath,
  });
}

export function createLcxIdentityPairingMigration(params: {
  kind: "device";
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityPairingMigration & { kind: "device" };
export function createLcxIdentityPairingMigration(params: {
  kind: "node";
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityPairingMigration & { kind: "node" };
export function createLcxIdentityPairingMigration(params: {
  kind: LcxIdentityPairingKind;
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityPairingMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Pairing migration requires a state-root authority");
  }
  const existsSync = params.existsSync ?? fs.existsSync;
  const subdir = pairingSubdir(params.kind);
  const readRoot = resolvePairingReadRoot({
    migrationPlan: params.migrationPlan,
    subdir,
    existsSync,
  });
  return buildPairingMigration({
    kind: params.kind,
    migrationPlan: params.migrationPlan,
    readRoot,
  });
}

function resolveCurrentPairingMigration(
  migration: LcxIdentityPairingMigration,
): LcxIdentityPairingMigration {
  const plan = migration.pendingPathContract.migrationPlan;
  if (!plan) {
    return migration;
  }
  const readRoot = resolvePairingReadRoot({
    migrationPlan: plan,
    subdir: migration.subdir,
    existsSync: fs.existsSync,
  });
  return buildPairingMigration({
    kind: migration.kind,
    migrationPlan: plan,
    readRoot,
    backupPendingPath: migration.pendingPathContract.backupPath,
    backupPairedPath: migration.pairedPathContract.backupPath,
    auditPath: migration.pendingPathContract.auditPath,
  });
}

function parsePairingRecord<T>(raw: string | null): Record<string, T> {
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, T>;
  } catch {
    return {};
  }
}

export async function readPairingStateForIdentityMigration<TPending, TPaired>(
  migration: LcxIdentityPairingMigration,
): Promise<LcxIdentityPairingState<TPending, TPaired>> {
  const current = resolveCurrentPairingMigration(migration);
  const [pendingRaw, pairedRaw] = await Promise.all([
    readLcxIdentityWriterRaw(current.pendingPathContract),
    readLcxIdentityWriterRaw(current.pairedPathContract),
  ]);
  return {
    pending: parsePairingRecord<TPending>(pendingRaw),
    paired: parsePairingRecord<TPaired>(pairedRaw),
  };
}

export async function writePairingStateForIdentityMigration<TPending, TPaired>(params: {
  migration: LcxIdentityPairingMigration;
  state: LcxIdentityPairingState<TPending, TPaired>;
  expectedPendingReadPath?: string;
  expectedPendingWritePath?: string;
  expectedPairedReadPath?: string;
  expectedPairedWritePath?: string;
}): Promise<LcxIdentityPairingWriteReceipt> {
  const current = resolveCurrentPairingMigration(params.migration);
  let pendingReceipt: LcxIdentityWriteReceipt | undefined;
  try {
    pendingReceipt = await writeLcxIdentityWriterRawWithReceipt(
      current.pendingPathContract,
      `${JSON.stringify(params.state.pending, null, 2)}\n`,
      {
        expectedReadPath: params.expectedPendingReadPath,
        expectedWritePath: params.expectedPendingWritePath,
      },
    );
    const pairedReceipt = await writeLcxIdentityWriterRawWithReceipt(
      current.pairedPathContract,
      `${JSON.stringify(params.state.paired, null, 2)}\n`,
      {
        expectedReadPath: params.expectedPairedReadPath,
        expectedWritePath: params.expectedPairedWritePath,
      },
    );
    return Object.freeze({ pending: pendingReceipt, paired: pairedReceipt });
  } catch (error) {
    if (pendingReceipt) {
      await rollbackLcxIdentityWriter(pendingReceipt).catch(() => undefined);
    }
    throw error;
  }
}

export async function rollbackPairingIdentityMigration(
  receipt: LcxIdentityPairingWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt.paired);
  await rollbackLcxIdentityWriter(receipt.pending);
}

export function resolvePairingPaths(baseDir: string | undefined, subdir: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, subdir);
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

export function pruneExpiredPending<T extends { ts: number }>(
  pendingById: Record<string, T>,
  nowMs: number,
  ttlMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > ttlMs) {
      delete pendingById[id];
    }
  }
}

export type PendingPairingRequestResult<TPending> = {
  status: "pending";
  request: TPending;
  created: boolean;
};

export async function upsertPendingPairingRequest<TPending extends { requestId: string }>(params: {
  pendingById: Record<string, TPending>;
  isExisting: (pending: TPending) => boolean;
  createRequest: (isRepair: boolean) => TPending;
  isRepair: boolean;
  persist: () => Promise<void>;
}): Promise<PendingPairingRequestResult<TPending>> {
  const existing = Object.values(params.pendingById).find(params.isExisting);
  if (existing) {
    return { status: "pending", request: existing, created: false };
  }

  const request = params.createRequest(params.isRepair);
  params.pendingById[request.requestId] = request;
  await params.persist();
  return { status: "pending", request, created: true };
}
