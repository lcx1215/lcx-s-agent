import fs from "node:fs/promises";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  createLcxIdentityWriterPathContract,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
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

export async function rollbackDeliveryQueueIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
