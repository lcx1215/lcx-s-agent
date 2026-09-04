import fs from "node:fs";
import path from "node:path";
import {
  createLcxIdentityWriterPathContract,
  readLcxIdentityWriterRaw,
  removeLcxIdentityWriterWithReceipt,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityRemoval,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  LcxIdentityWriterContractError,
  type LcxIdentityRemovalReceipt,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import { resolveStateDir, type LcxIdentityMigrationPlan } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

export type CachedCopilotToken = {
  token: string;
  /** milliseconds since epoch */
  expiresAt: number;
  /** milliseconds since epoch */
  updatedAt: number;
};

const COPILOT_TOKEN_RELATIVE_PATH = path.join("credentials", "github-copilot.token.json");

export type LcxIdentityCopilotTokenMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "credentials" }>;
}>;

export type LcxIdentityCopilotTokenWriteReceipt = Readonly<{
  write: LcxIdentityWriteReceipt;
  removedLegacy?: LcxIdentityRemovalReceipt;
}>;

export function createLcxIdentityCopilotTokenMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityCopilotTokenMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Copilot token migration requires a state-root authority");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "credentials",
    migrationPlan: params.migrationPlan,
    relativePath: COPILOT_TOKEN_RELATIVE_PATH,
    existsSync: params.existsSync,
  });
  return Object.freeze({ pathContract });
}

function resolveCurrentCopilotTokenPathContract(
  migration: LcxIdentityCopilotTokenMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "credentials" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  const existsSync = fs.existsSync;
  const existingPaths = plan.readStateDirs
    .map((stateDir) => path.resolve(stateDir, COPILOT_TOKEN_RELATIVE_PATH))
    .filter((candidate) => existsSync(candidate));
  if (existingPaths.length > 1) {
    throw new LcxIdentityWriterContractError(
      `Copilot token migration found split credential state: ${existingPaths.join(" and ")}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "credentials",
    migrationPlan: plan,
    relativePath: COPILOT_TOKEN_RELATIVE_PATH,
    auditPath: migration.pathContract.auditPath,
  });
}

function parseCachedCopilotToken(value: unknown): CachedCopilotToken | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const parsed = value as Partial<CachedCopilotToken>;
  if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number") {
    return null;
  }
  return {
    token: parsed.token,
    expiresAt: parsed.expiresAt,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
  };
}

export async function readCopilotTokenForIdentityMigration(
  migration: LcxIdentityCopilotTokenMigration,
): Promise<CachedCopilotToken | null> {
  const raw = await readLcxIdentityWriterRaw(resolveCurrentCopilotTokenPathContract(migration));
  if (raw === null) {
    return null;
  }
  try {
    return parseCachedCopilotToken(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeCopilotTokenForIdentityMigration(
  migration: LcxIdentityCopilotTokenMigration,
  token: CachedCopilotToken,
): Promise<LcxIdentityCopilotTokenWriteReceipt> {
  const contract = resolveCurrentCopilotTokenPathContract(migration);
  const write = await writeLcxIdentityWriterRawWithReceipt(
    contract,
    `${JSON.stringify(token, null, 2)}\n`,
  );
  if (contract.readPath === contract.writePath) {
    return Object.freeze({ write });
  }
  let removedLegacy: LcxIdentityRemovalReceipt | undefined;
  try {
    if (fs.existsSync(contract.readPath)) {
      removedLegacy = await removeLcxIdentityWriterWithReceipt(
        createLcxIdentityWriterPathContract({
          writer: "credentials",
          migrationPlan: contract.migrationPlan,
          readPath: contract.readPath,
          writePath: contract.readPath,
          auditPath: contract.auditPath,
        }),
      );
    }
  } catch (error) {
    await rollbackLcxIdentityWriter(write);
    throw error;
  }
  return Object.freeze({ write, removedLegacy });
}

export async function rollbackCopilotTokenIdentityMigration(
  receipt: LcxIdentityCopilotTokenWriteReceipt,
): Promise<void> {
  if (receipt.removedLegacy) {
    await rollbackLcxIdentityRemoval(receipt.removedLegacy);
  }
  await rollbackLcxIdentityWriter(receipt.write);
}

function resolveCopilotTokenCachePath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}

function isTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  // Keep a small safety margin when checking expiry.
  return cache.expiresAt - now > 5 * 60 * 1000;
}

function parseCopilotTokenResponse(value: unknown): {
  token: string;
  expiresAt: number;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot token endpoint");
  }
  const asRecord = value as Record<string, unknown>;
  const token = asRecord.token;
  const expiresAt = asRecord.expires_at;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Copilot token response missing token");
  }

  // GitHub returns a unix timestamp (seconds), but we defensively accept ms too.
  let expiresAtMs: number;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    expiresAtMs = expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000;
  } else if (typeof expiresAt === "string" && expiresAt.trim().length > 0) {
    const parsed = Number.parseInt(expiresAt, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error("Copilot token response has invalid expires_at");
    }
    expiresAtMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  } else {
    throw new Error("Copilot token response missing expires_at");
  }

  return { token, expiresAt: expiresAtMs };
}

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

export function deriveCopilotApiBaseUrlFromToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  // The token returned from the Copilot token endpoint is a semicolon-delimited
  // set of key/value pairs. One of them is `proxy-ep=...`.
  const match = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) {
    return null;
  }

  // pi-ai expects converting proxy.* -> api.*
  // (see upstream getGitHubCopilotBaseUrl).
  const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  if (!host) {
    return null;
  }

  return `https://${host}`;
}

export async function resolveCopilotApiToken(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  loadJsonFileImpl?: (path: string) => unknown;
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
  identityMigration?: LcxIdentityCopilotTokenMigration;
}): Promise<{
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
}> {
  const env = params.env ?? process.env;
  const cachePath =
    params.cachePath?.trim() ||
    params.identityMigration?.pathContract.writePath ||
    resolveCopilotTokenCachePath(env);
  const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
  const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
  const cached = params.identityMigration
    ? await readCopilotTokenForIdentityMigration(params.identityMigration)
    : parseCachedCopilotToken(loadJsonFileFn(cachePath));
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    if (isTokenUsable(cached)) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        source: `cache:${cachePath}`,
        baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? DEFAULT_COPILOT_API_BASE_URL,
      };
    }
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.githubToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
  }

  const json = parseCopilotTokenResponse(await res.json());
  const payload: CachedCopilotToken = {
    token: json.token,
    expiresAt: json.expiresAt,
    updatedAt: Date.now(),
  };
  if (params.identityMigration) {
    await writeCopilotTokenForIdentityMigration(params.identityMigration, payload);
  } else {
    saveJsonFileFn(cachePath, payload);
  }

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: `fetched:${COPILOT_TOKEN_URL}`,
    baseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? DEFAULT_COPILOT_API_BASE_URL,
  };
}
