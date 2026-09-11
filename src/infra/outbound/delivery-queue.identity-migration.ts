import fs from "node:fs/promises";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  createLcxIdentityWriterPathContract,
  removeLcxIdentityWriterWithReceipt,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityRemoval,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityRemovalReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../../config/identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../../config/paths.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const SAFE_QUEUE_ENTRY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type LcxIdentityDeliveryQueueMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "queues" }>;
  readQueueDir: string;
  writeQueueDir: string;
  readFailedDir: string;
  writeFailedDir: string;
}>;

export type IdentityQueuedDelivery = {
  id: string;
  enqueuedAt: number;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: { sessionKey: string; agentId?: string; text?: string; mediaUrls?: string[] };
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
};

export type LcxIdentityDeliveryQueueMutationReceipt = Readonly<{
  write: LcxIdentityWriteReceipt;
  removedSource?: LcxIdentityRemovalReceipt;
}>;

export type LcxIdentityDeliveryQueueRemovalReceipt = LcxIdentityRemovalReceipt;

export function createLcxIdentityDeliveryQueueMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityDeliveryQueueMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Delivery queue migration requires a state-root authority");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "queues",
    migrationPlan: params.migrationPlan,
    relativePath: QUEUE_DIRNAME,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readQueueDir: pathContract.readPath,
    writeQueueDir: pathContract.writePath,
    readFailedDir: path.join(pathContract.readPath, FAILED_DIRNAME),
    writeFailedDir: path.join(pathContract.writePath, FAILED_DIRNAME),
  });
}

function resolveEntryContract(
  migration: LcxIdentityDeliveryQueueMigration,
  id: string,
  failed = false,
): LcxIdentityWriterPathContract & Readonly<{ writer: "queues" }> {
  if (!SAFE_QUEUE_ENTRY_ID_RE.test(id)) {
    throw new Error(`Invalid delivery queue entry ID: ${id}`);
  }
  const fileName = `${id}.json`;
  return createLcxIdentityWriterPathContract({
    writer: "queues",
    migrationPlan: migration.pathContract.migrationPlan,
    readPath: path.join(failed ? migration.readFailedDir : migration.readQueueDir, fileName),
    writePath: path.join(failed ? migration.writeFailedDir : migration.writeQueueDir, fileName),
    auditPath: migration.pathContract.auditPath,
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function resolveActiveEntryPaths(params: {
  migration: LcxIdentityDeliveryQueueMigration;
  id: string;
  failed?: boolean;
}): Promise<{ readPath: string; writePath: string }> {
  if (!SAFE_QUEUE_ENTRY_ID_RE.test(params.id)) {
    throw new Error(`Invalid delivery queue entry ID: ${params.id}`);
  }
  const fileName = `${params.id}.json`;
  const canonicalPath = path.join(
    params.failed ? params.migration.writeFailedDir : params.migration.writeQueueDir,
    fileName,
  );
  const legacyPath = path.join(
    params.failed ? params.migration.readFailedDir : params.migration.readQueueDir,
    fileName,
  );
  const [canonicalExists, legacyExists] = await Promise.all([
    pathExists(canonicalPath),
    pathExists(legacyPath),
  ]);
  if (canonicalPath !== legacyPath && canonicalExists && legacyExists) {
    throw new Error(`Delivery queue migration found split entry state for ${params.id}`);
  }
  return {
    readPath: canonicalExists ? canonicalPath : legacyPath,
    writePath: canonicalPath,
  };
}

function createQueueEntryContract(params: {
  migration: LcxIdentityDeliveryQueueMigration;
  readPath: string;
  writePath: string;
}): LcxIdentityWriterPathContract & Readonly<{ writer: "queues" }> {
  return createLcxIdentityWriterPathContract({
    writer: "queues",
    migrationPlan: params.migration.pathContract.migrationPlan,
    readPath: params.readPath,
    writePath: params.writePath,
    auditPath: params.migration.pathContract.auditPath,
  });
}

async function removeQueueEntryWithReceipt(params: {
  migration: LcxIdentityDeliveryQueueMigration;
  filePath: string;
}): Promise<LcxIdentityDeliveryQueueRemovalReceipt> {
  return await removeLcxIdentityWriterWithReceipt(
    createQueueEntryContract({
      migration: params.migration,
      readPath: params.filePath,
      writePath: params.filePath,
    }),
  );
}

export async function readPendingDeliveriesForIdentityMigration(
  migration: LcxIdentityDeliveryQueueMigration,
): Promise<IdentityQueuedDelivery[]> {
  const files = new Set<string>();
  for (const queueDir of [migration.writeQueueDir, migration.readQueueDir]) {
    try {
      for (const file of await fs.readdir(queueDir)) {
        if (file.endsWith(".json")) {
          files.add(file);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }
  const entries: IdentityQueuedDelivery[] = [];
  for (const file of files) {
    const candidatePaths = [
      path.join(migration.writeQueueDir, file),
      path.join(migration.readQueueDir, file),
    ];
    try {
      let raw: string | null = null;
      for (const candidatePath of candidatePaths) {
        try {
          raw = await fs.readFile(candidatePath, "utf8");
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            throw err;
          }
        }
      }
      if (raw === null) {
        continue;
      }
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as IdentityQueuedDelivery);
      }
    } catch {
      // Preserve the existing queue behavior: malformed entries are skipped.
    }
  }
  return entries;
}

export async function enqueueDeliveryForIdentityMigration(params: {
  migration: LcxIdentityDeliveryQueueMigration;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  payloads: ReplyPayload[];
  accountId?: string;
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: IdentityQueuedDelivery["mirror"];
}): Promise<{ id: string; receipt: LcxIdentityWriteReceipt }> {
  const id = generateSecureUuid();
  const entry: IdentityQueuedDelivery = {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: params.payloads,
    threadId: params.threadId,
    replyToId: params.replyToId,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    silent: params.silent,
    mirror: params.mirror,
    retryCount: 0,
  };
  const receipt = await writeLcxIdentityWriterRawWithReceipt(
    resolveEntryContract(params.migration, id),
    JSON.stringify(entry, null, 2),
  );
  return { id, receipt };
}

export async function ackDeliveryForIdentityMigration(params: {
  migration: LcxIdentityDeliveryQueueMigration;
  id: string;
}): Promise<LcxIdentityDeliveryQueueRemovalReceipt | null> {
  const paths = await resolveActiveEntryPaths(params);
  if (!(await pathExists(paths.readPath))) {
    return null;
  }
  return await removeQueueEntryWithReceipt({
    migration: params.migration,
    filePath: paths.readPath,
  });
}

export async function failDeliveryForIdentityMigration(params: {
  migration: LcxIdentityDeliveryQueueMigration;
  id: string;
  error: string;
  nowMs?: number;
}): Promise<LcxIdentityDeliveryQueueMutationReceipt> {
  const paths = await resolveActiveEntryPaths(params);
  const raw = await fs.readFile(paths.readPath, "utf8");
  const entry = JSON.parse(raw) as IdentityQueuedDelivery;
  const next: IdentityQueuedDelivery = {
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: params.nowMs ?? Date.now(),
    lastError: params.error,
  };
  const write = await writeLcxIdentityWriterRawWithReceipt(
    createQueueEntryContract({
      migration: params.migration,
      readPath: paths.readPath,
      writePath: paths.writePath,
    }),
    JSON.stringify(next, null, 2),
  );
  let removedSource: LcxIdentityRemovalReceipt | undefined;
  try {
    removedSource =
      paths.readPath === paths.writePath
        ? undefined
        : await removeQueueEntryWithReceipt({
            migration: params.migration,
            filePath: paths.readPath,
          });
  } catch (error) {
    await rollbackLcxIdentityWriter(write);
    throw error;
  }
  return Object.freeze({ write, removedSource });
}

export async function moveDeliveryToFailedForIdentityMigration(params: {
  migration: LcxIdentityDeliveryQueueMigration;
  id: string;
}): Promise<LcxIdentityDeliveryQueueMutationReceipt | null> {
  const source = await resolveActiveEntryPaths(params);
  if (!(await pathExists(source.readPath))) {
    return null;
  }
  const destination = await resolveActiveEntryPaths({ ...params, failed: true });
  const raw = await fs.readFile(source.readPath, "utf8");
  const write = await writeLcxIdentityWriterRawWithReceipt(
    createQueueEntryContract({
      migration: params.migration,
      readPath: source.readPath,
      writePath: destination.writePath,
    }),
    raw,
  );
  let removedSource: LcxIdentityRemovalReceipt;
  try {
    removedSource = await removeQueueEntryWithReceipt({
      migration: params.migration,
      filePath: source.readPath,
    });
  } catch (error) {
    await rollbackLcxIdentityWriter(write);
    throw error;
  }
  return Object.freeze({ write, removedSource });
}

export async function rollbackDeliveryQueueMutation(
  receipt: LcxIdentityDeliveryQueueMutationReceipt,
): Promise<void> {
  if (receipt.removedSource) {
    await rollbackLcxIdentityRemoval(receipt.removedSource);
  }
  await rollbackLcxIdentityWriter(receipt.write);
}

export async function rollbackDeliveryQueueRemoval(
  receipt: LcxIdentityDeliveryQueueRemovalReceipt,
): Promise<void> {
  await rollbackLcxIdentityRemoval(receipt);
}

export async function rollbackDeliveryQueueIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
