import fs from "node:fs/promises";
import path from "node:path";
import {
  createLcxIdentityWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import {
  resolveCurrentSessionIdentityPathContract,
  type LcxIdentitySessionMigration,
} from "../config/sessions/identity-migration.js";

export type RepairReport = {
  repaired: boolean;
  droppedLines: number;
  backupPath?: string;
  reason?: string;
  receipt?: LcxIdentityWriteReceipt;
};

function isSessionHeader(entry: unknown): entry is { type: string; id: string } {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; id?: unknown };
  return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}

export async function repairSessionFileIfNeeded(params: {
  sessionFile: string;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return { repaired: false, droppedLines: 0, reason: "missing session file" };
  }

  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return { repaired: false, droppedLines: 0, reason: "missing session file" };
    }
    const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
    params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
    return { repaired: false, droppedLines: 0, reason };
  }

  const lines = content.split(/\r?\n/);
  const entries: unknown[] = [];
  let droppedLines = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch {
      droppedLines += 1;
    }
  }

  if (entries.length === 0) {
    return { repaired: false, droppedLines, reason: "empty session file" };
  }

  if (!isSessionHeader(entries[0])) {
    params.warn?.(
      `session file repair skipped: invalid session header (${path.basename(sessionFile)})`,
    );
    return { repaired: false, droppedLines, reason: "invalid session header" };
  }

  if (droppedLines === 0) {
    return { repaired: false, droppedLines: 0 };
  }

  const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
  const tmpPath = `${sessionFile}.repair-${process.pid}-${Date.now()}.tmp`;
  try {
    const stat = await fs.stat(sessionFile).catch(() => null);
    await fs.writeFile(backupPath, content, "utf-8");
    if (stat) {
      await fs.chmod(backupPath, stat.mode);
    }
    await fs.writeFile(tmpPath, cleaned, "utf-8");
    if (stat) {
      await fs.chmod(tmpPath, stat.mode);
    }
    await fs.rename(tmpPath, sessionFile);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch (cleanupErr) {
      params.warn?.(
        `session file repair cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown error"} (${path.basename(
          tmpPath,
        )})`,
      );
    }
    return {
      repaired: false,
      droppedLines,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  params.warn?.(
    `session file repaired: dropped ${droppedLines} malformed line(s) (${path.basename(
      sessionFile,
    )})`,
  );
  return { repaired: true, droppedLines, backupPath };
}

function resolvePathRelativeTo(root: string, candidate: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function resolveSessionRepairContract(params: {
  migration: LcxIdentitySessionMigration;
  sessionFile: string;
}): LcxIdentityWriterPathContract & Readonly<{ writer: "sessions" }> {
  const storeContract = resolveCurrentSessionIdentityPathContract(params.migration);
  const requestedPath = params.sessionFile.trim();
  const readSessionsDir = path.dirname(storeContract.readPath);
  const writeSessionsDir = path.dirname(storeContract.writePath);
  const relativePath =
    resolvePathRelativeTo(readSessionsDir, requestedPath) ??
    resolvePathRelativeTo(writeSessionsDir, requestedPath);
  if (!relativePath) {
    throw new Error("Session repair path must remain inside the active sessions directory");
  }
  return createLcxIdentityWriterPathContract({
    writer: "sessions",
    migrationPlan: storeContract.migrationPlan,
    readPath: path.join(readSessionsDir, relativePath),
    writePath: path.join(writeSessionsDir, relativePath),
    auditPath: storeContract.auditPath,
  });
}

async function parseRepairableSessionFile(params: {
  sessionFile: string;
  warn?: (message: string) => void;
}): Promise<
  { ok: false; report: RepairReport } | { ok: true; cleaned: string; droppedLines: number }
> {
  let content: string;
  try {
    content = await fs.readFile(params.sessionFile, "utf-8");
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return {
        ok: false,
        report: { repaired: false, droppedLines: 0, reason: "missing session file" },
      };
    }
    const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
    params.warn?.(`session file repair skipped: ${reason} (${path.basename(params.sessionFile)})`);
    return { ok: false, report: { repaired: false, droppedLines: 0, reason } };
  }

  const entries: unknown[] = [];
  let droppedLines = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      droppedLines += 1;
    }
  }
  if (entries.length === 0) {
    return { ok: false, report: { repaired: false, droppedLines, reason: "empty session file" } };
  }
  if (!isSessionHeader(entries[0])) {
    params.warn?.(
      `session file repair skipped: invalid session header (${path.basename(params.sessionFile)})`,
    );
    return {
      ok: false,
      report: { repaired: false, droppedLines, reason: "invalid session header" },
    };
  }
  if (droppedLines === 0) {
    return { ok: false, report: { repaired: false, droppedLines: 0 } };
  }
  return {
    ok: true,
    cleaned: `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    droppedLines,
  };
}

export async function repairSessionFileForIdentityMigration(params: {
  migration: LcxIdentitySessionMigration;
  sessionFile: string;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const contract = resolveSessionRepairContract(params);
  const prepared = await parseRepairableSessionFile({
    sessionFile: contract.readPath,
    warn: params.warn,
  });
  if (!prepared.ok) {
    return prepared.report;
  }

  try {
    const receipt = await writeLcxIdentityWriterRawWithReceipt(contract, prepared.cleaned);
    params.warn?.(
      `session file repaired: dropped ${prepared.droppedLines} malformed line(s) (${path.basename(
        contract.writePath,
      )})`,
    );
    return {
      repaired: true,
      droppedLines: prepared.droppedLines,
      backupPath: receipt.previous.exists ? receipt.rollback.path : undefined,
      receipt,
    };
  } catch (err) {
    return {
      repaired: false,
      droppedLines: prepared.droppedLines,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

export async function rollbackSessionFileIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
