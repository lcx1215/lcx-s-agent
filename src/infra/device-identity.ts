import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readLcxIdentityWriterRaw,
  resolveLcxIdentityStateWriterPathContract,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  LcxIdentityWriterContractError,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../config/identity-migration.js";
import { resolveStateDir } from "../config/paths.js";
import type { LcxIdentityMigrationPlan } from "../config/paths.js";
import { saveJsonFile } from "./json-file.js";
import { describeReadFailure } from "./unreadable-source.js";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export type StoredDeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

function resolveDefaultIdentityPath(): string {
  return path.join(resolveStateDir(), "identity", "device.json");
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

export function loadOrCreateDeviceIdentity(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredDeviceIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedId && derivedId !== parsed.deviceId) {
          const updated: StoredDeviceIdentity = {
            ...parsed,
            deviceId: derivedId,
          };
          saveJsonFile(filePath, updated);
          return {
            deviceId: derivedId,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch (err) {
    // "There is a file and I could not look inside it" is not the same as "there is no file".
    // Regenerating on an unreadable file wrote a brand-new key pair over the only copy of the old
    // one, silently — the device just stops matching whatever it was paired with, and nothing says
    // why. A file that is genuinely absent still regenerates; one we cannot see fails loudly.
    // (This is also the tail of the old non-atomic write: a half-written device.json lands here.)
    const failure = describeReadFailure(err);
    if (failure.status !== "absent") {
      throw new Error(
        `cannot read device identity at ${filePath} (${failure.status}/${failure.code}); refusing to replace it`,
        { cause: err },
      );
    }
  }

  const identity = generateIdentity();
  ensureDir(filePath);
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  saveJsonFile(filePath, stored);
  return identity;
}

export type LcxIdentityDeviceMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "device" }>;
  readIdentityPath: string;
  writeIdentityPath: string;
}>;

const DEVICE_IDENTITY_RELATIVE_PATH = path.join("identity", "device.json");

export function createLcxIdentityDeviceMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityDeviceMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("Device identity migration requires a state-root authority");
  }
  const pathContract = resolveLcxIdentityStateWriterPathContract({
    writer: "device",
    migrationPlan: params.migrationPlan,
    relativePath: DEVICE_IDENTITY_RELATIVE_PATH,
    existsSync: params.existsSync,
  });
  return Object.freeze({
    pathContract,
    readIdentityPath: pathContract.readPath,
    writeIdentityPath: pathContract.writePath,
  });
}

function resolveCurrentDeviceIdentityPathContract(
  migration: LcxIdentityDeviceMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "device" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  return resolveLcxIdentityStateWriterPathContract({
    writer: "device",
    migrationPlan: plan,
    relativePath: DEVICE_IDENTITY_RELATIVE_PATH,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

function parseStoredDeviceIdentity(raw: string): StoredDeviceIdentity | null {
  try {
    const parsed = JSON.parse(raw) as StoredDeviceIdentity;
    if (
      parsed?.version !== 1 ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.publicKeyPem !== "string" ||
      typeof parsed.privateKeyPem !== "string" ||
      typeof parsed.createdAtMs !== "number"
    ) {
      return null;
    }
    const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
    return derivedId ? { ...parsed, deviceId: derivedId } : null;
  } catch {
    return null;
  }
}

export async function readDeviceIdentityForIdentityMigration(
  migration: LcxIdentityDeviceMigration,
): Promise<DeviceIdentity | null> {
  const pathContract = resolveCurrentDeviceIdentityPathContract(migration);
  const raw = await readLcxIdentityWriterRaw(pathContract);
  const stored = raw === null ? null : parseStoredDeviceIdentity(raw);
  if (!stored) {
    return null;
  }
  return {
    deviceId: stored.deviceId,
    publicKeyPem: stored.publicKeyPem,
    privateKeyPem: stored.privateKeyPem,
  };
}

export async function writeDeviceIdentityForIdentityMigration(
  migration: LcxIdentityDeviceMigration,
  identity: DeviceIdentity,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  let derivedId: string | null = null;
  let publicKeyDer: Buffer;
  let privateDerivedPublicKeyDer: Buffer;
  try {
    const publicKey = crypto.createPublicKey(identity.publicKeyPem);
    const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
    const privateDerivedPublicKey = crypto.createPublicKey(privateKey);
    publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    privateDerivedPublicKeyDer = privateDerivedPublicKey.export({
      type: "spki",
      format: "der",
    }) as Buffer;
    derivedId = fingerprintPublicKey(identity.publicKeyPem);
  } catch {
    throw new LcxIdentityWriterContractError(
      "Device identity keys are invalid",
      "LCX_IDENTITY_DEVICE_KEYS_INVALID",
    );
  }
  if (!publicKeyDer.equals(privateDerivedPublicKeyDer)) {
    throw new LcxIdentityWriterContractError(
      "Device identity public and private keys do not form the same keypair",
      "LCX_IDENTITY_DEVICE_KEYPAIR_MISMATCH",
    );
  }
  if (!derivedId) {
    throw new LcxIdentityWriterContractError(
      "Device identity public key is invalid",
      "LCX_IDENTITY_DEVICE_PUBLIC_KEY_INVALID",
    );
  }

  const pathContract = resolveCurrentDeviceIdentityPathContract(migration);
  const previousRaw = await readLcxIdentityWriterRaw(pathContract);
  const previous = previousRaw === null ? null : parseStoredDeviceIdentity(previousRaw);
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: derivedId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: previous?.createdAtMs ?? Date.now(),
  };
  return await writeLcxIdentityWriterRawWithReceipt(
    pathContract,
    `${JSON.stringify(stored, null, 2)}\n`,
    options,
  );
}

export async function rollbackDeviceIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

export function normalizeDevicePublicKeyBase64Url(publicKey: string): string | null {
  try {
    if (publicKey.includes("BEGIN")) {
      return base64UrlEncode(derivePublicKeyRaw(publicKey));
    }
    const raw = base64UrlDecode(publicKey);
    return base64UrlEncode(raw);
  } catch {
    return null;
  }
}

export function deriveDeviceIdFromPublicKey(publicKey: string): string | null {
  try {
    const raw = publicKey.includes("BEGIN")
      ? derivePublicKeyRaw(publicKey)
      : base64UrlDecode(publicKey);
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signatureBase64Url: string,
): boolean {
  try {
    const key = publicKey.includes("BEGIN")
      ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
          type: "spki",
          format: "der",
        });
    const sig = (() => {
      try {
        return base64UrlDecode(signatureBase64Url);
      } catch {
        return Buffer.from(signatureBase64Url, "base64");
      }
    })();
    return crypto.verify(null, Buffer.from(payload, "utf8"), key, sig);
  } catch {
    return false;
  }
}
