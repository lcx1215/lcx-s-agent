import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import {
  createLcxIdentityWriterPathContract,
  readLcxIdentityWriterRaw,
  removeLcxIdentityWriterWithReceipt,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityRemoval,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityRemovalReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import { resolveStateDir } from "../config/paths.js";
import type { LcxIdentityMigrationPlan } from "../config/paths.js";

export type RestartSentinelLog = {
  stdoutTail?: string | null;
  stderrTail?: string | null;
  exitCode?: number | null;
};

export type RestartSentinelStep = {
  name: string;
  command: string;
  cwd?: string | null;
  durationMs?: number | null;
  log?: RestartSentinelLog | null;
};

export type RestartSentinelStats = {
  mode?: string;
  root?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  steps?: RestartSentinelStep[];
  reason?: string | null;
  durationMs?: number | null;
};

export type RestartSentinelPayload = {
  kind: "config-apply" | "config-patch" | "update" | "restart";
  status: "ok" | "error" | "skipped";
  ts: number;
  sessionKey?: string;
  /** Delivery context captured at restart time to ensure channel routing survives restart. */
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  /** Thread ID for reply threading (e.g., Slack thread_ts). */
  threadId?: string;
  message?: string | null;
  doctorHint?: string | null;
  stats?: RestartSentinelStats | null;
};

export type RestartSentinel = {
  version: 1;
  payload: RestartSentinelPayload;
};

const SENTINEL_FILENAME = "restart-sentinel.json";

function parseRestartSentinel(raw: string): RestartSentinel | null {
  try {
    const parsed = JSON.parse(raw) as RestartSentinel | undefined;
    return parsed?.version === 1 && parsed.payload ? parsed : null;
  } catch {
    return null;
  }
}

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Run: ${formatCliCommand("openclaw doctor --non-interactive", env)}`;
}

export function resolveRestartSentinelPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SENTINEL_FILENAME);
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
) {
  const filePath = resolveRestartSentinelPath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: RestartSentinel = { version: 1, payload };
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return filePath;
}

export type LcxIdentityRestartSentinelMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "restart-sentinel" }>;
  readSentinelPath: string;
  writeSentinelPath: string;
}>;

export type LcxIdentityRestartSentinelSnapshot = Readonly<{
  path: string;
  exists: boolean;
  raw: string | null;
  sentinel: RestartSentinel | null;
}>;

export function createLcxIdentityRestartSentinelMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityRestartSentinelMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Restart sentinel migration requires a state-root authority");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "restart-sentinel",
    migrationPlan: params.migrationPlan,
    relativePath: SENTINEL_FILENAME,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readSentinelPath: pathContract.readPath,
    writeSentinelPath: pathContract.writePath,
  });
}

function resolveCurrentRestartSentinelPathContract(
  migration: LcxIdentityRestartSentinelMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "restart-sentinel" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "restart-sentinel",
    migrationPlan: plan,
    relativePath: SENTINEL_FILENAME,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export async function readRestartSentinelForIdentityMigration(
  migration: LcxIdentityRestartSentinelMigration,
): Promise<LcxIdentityRestartSentinelSnapshot> {
  const pathContract = resolveCurrentRestartSentinelPathContract(migration);
  const raw = await readLcxIdentityWriterRaw(pathContract);
  return {
    path: pathContract.readPath,
    exists: raw !== null,
    raw,
    sentinel: raw === null ? null : parseRestartSentinel(raw),
  };
}

export async function writeRestartSentinelForIdentityMigration(
  migration: LcxIdentityRestartSentinelMigration,
  payload: RestartSentinelPayload,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  const pathContract = resolveCurrentRestartSentinelPathContract(migration);
  const data: RestartSentinel = { version: 1, payload };
  return await writeLcxIdentityWriterRawWithReceipt(
    pathContract,
    `${JSON.stringify(data, null, 2)}\n`,
    options,
  );
}

export async function consumeRestartSentinelForIdentityMigration(
  migration: LcxIdentityRestartSentinelMigration,
): Promise<{ sentinel: RestartSentinel; receipt: LcxIdentityRemovalReceipt } | null> {
  const snapshot = await readRestartSentinelForIdentityMigration(migration);
  if (!snapshot.sentinel) {
    return null;
  }
  const pathContract = resolveCurrentRestartSentinelPathContract(migration);
  const removalContract =
    pathContract.readPath === pathContract.writePath
      ? pathContract
      : createLcxIdentityWriterPathContract({
          writer: "restart-sentinel",
          migrationPlan: pathContract.migrationPlan,
          readPath: pathContract.readPath,
          writePath: pathContract.readPath,
          auditPath: pathContract.auditPath,
        });
  const receipt = await removeLcxIdentityWriterWithReceipt(removalContract, {
    expectedReadPath: removalContract.readPath,
    expectedWritePath: removalContract.writePath,
  });
  return { sentinel: snapshot.sentinel, receipt };
}

export async function rollbackRestartSentinelIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export async function rollbackConsumedRestartSentinelMigration(
  receipt: LcxIdentityRemovalReceipt,
): Promise<void> {
  await rollbackLcxIdentityRemoval(receipt);
}

export async function readRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const filePath = resolveRestartSentinelPath(env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = parseRestartSentinel(raw);
    if (!parsed) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function consumeRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  const filePath = resolveRestartSentinelPath(env);
  const parsed = await readRestartSentinel(env);
  if (!parsed) {
    return null;
  }
  await fs.unlink(filePath).catch(() => {});
  return parsed;
}

export function formatRestartSentinelMessage(payload: RestartSentinelPayload): string {
  const message = payload.message?.trim();
  if (message && !payload.stats) {
    return message;
  }
  const lines: string[] = [summarizeRestartSentinel(payload)];
  if (message) {
    lines.push(message);
  }
  const reason = payload.stats?.reason?.trim();
  if (reason && reason !== message) {
    lines.push(`Reason: ${reason}`);
  }
  if (payload.doctorHint?.trim()) {
    lines.push(payload.doctorHint.trim());
  }
  return lines.join("\n");
}

export function summarizeRestartSentinel(payload: RestartSentinelPayload): string {
  const kind = payload.kind;
  const status = payload.status;
  const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
  return `Gateway restart ${kind} ${status}${mode}`.trim();
}

export function trimLogTail(input?: string | null, maxChars = 8000) {
  if (!input) {
    return null;
  }
  const text = input.trimEnd();
  if (text.length <= maxChars) {
    return text;
  }
  return `…${text.slice(text.length - maxChars)}`;
}
