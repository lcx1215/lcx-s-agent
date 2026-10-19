import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import { CONFIG_DIR, ensureDir, resolveUserPath, shortenHomeInString } from "../../utils.js";
import { normalizeFingerprint } from "./fingerprint.js";

const execFileAsync = promisify(execFile);

type GatewayTlsInterfaceAddress = {
  address: string;
  internal: boolean;
};

export function buildGatewayTlsSubjectAltNames(
  params: {
    hostname?: string;
    interfaces?: GatewayTlsInterfaceAddress[];
  } = {},
): string[] {
  const subjectAltNames = new Set(["DNS:localhost", "IP:127.0.0.1", "IP:::1"]);
  const hostname = params.hostname?.trim().replace(/\.$/u, "").toLowerCase();
  if (
    hostname &&
    hostname.length <= 253 &&
    hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    subjectAltNames.add(`DNS:${hostname}`);
  }
  for (const iface of params.interfaces ?? []) {
    if (iface.internal) {
      continue;
    }
    const address = iface.address.split("%", 1)[0];
    if (!address || net.isIP(address) === 0 || address === "0.0.0.0" || address === "::") {
      continue;
    }
    subjectAltNames.add(`IP:${address}`);
  }
  return [...subjectAltNames];
}

export type GatewayTlsRuntime = {
  enabled: boolean;
  required: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  fingerprintSha256?: string;
  tlsOptions?: tls.TlsOptions;
  error?: string;
};

export async function readGatewayTlsFingerprint(
  cfg: GatewayTlsConfig | undefined,
): Promise<string | undefined> {
  if (!cfg || cfg.enabled !== true) {
    return undefined;
  }
  const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
  const certPath = resolveUserPath(cfg.certPath ?? path.join(baseDir, "gateway-cert.pem"));
  try {
    const cert = await fs.readFile(certPath, "utf8");
    const fingerprintSha256 = normalizeFingerprint(new X509Certificate(cert).fingerprint256 ?? "");
    return fingerprintSha256 || undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateSelfSignedCert(params: {
  certPath: string;
  keyPath: string;
  subjectAltNames: string[];
  log?: { info?: (msg: string) => void };
}): Promise<void> {
  const certDir = path.dirname(params.certPath);
  const keyDir = path.dirname(params.keyPath);
  await ensureDir(certDir);
  if (keyDir !== certDir) {
    await ensureDir(keyDir);
  }
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "3650",
    "-nodes",
    "-keyout",
    params.keyPath,
    "-out",
    params.certPath,
    "-addext",
    `subjectAltName=${params.subjectAltNames.join(",")}`,
    "-subj",
    "/CN=lcx-gateway",
  ]);
  await fs.chmod(params.keyPath, 0o600).catch(() => {});
  await fs.chmod(params.certPath, 0o600).catch(() => {});
  params.log?.info?.(
    `gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`,
  );
}

export async function loadGatewayTlsRuntime(
  cfg: GatewayTlsConfig | undefined,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<GatewayTlsRuntime> {
  if (!cfg || cfg.enabled !== true) {
    return { enabled: false, required: false };
  }

  const autoGenerate = cfg.autoGenerate !== false;
  const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
  const certPath = resolveUserPath(cfg.certPath ?? path.join(baseDir, "gateway-cert.pem"));
  const keyPath = resolveUserPath(cfg.keyPath ?? path.join(baseDir, "gateway-key.pem"));
  const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : undefined;

  const hasCert = await fileExists(certPath);
  const hasKey = await fileExists(keyPath);

  if (!hasCert && !hasKey && autoGenerate) {
    try {
      const interfaces = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []);
      await generateSelfSignedCert({
        certPath,
        keyPath,
        log,
        subjectAltNames: buildGatewayTlsSubjectAltNames({
          hostname: os.hostname(),
          interfaces,
        }),
      });
    } catch (err) {
      return {
        enabled: false,
        required: true,
        certPath,
        keyPath,
        error: `gateway tls: failed to generate cert (${String(err)})`,
      };
    }
  }

  if (!(await fileExists(certPath)) || !(await fileExists(keyPath))) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      error: "gateway tls: cert/key missing",
    };
  }

  try {
    const cert = await fs.readFile(certPath, "utf8");
    const key = await fs.readFile(keyPath, "utf8");
    const ca = caPath ? await fs.readFile(caPath, "utf8") : undefined;
    const x509 = new X509Certificate(cert);
    const fingerprintSha256 = normalizeFingerprint(x509.fingerprint256 ?? "");

    if (!fingerprintSha256) {
      return {
        enabled: false,
        required: true,
        certPath,
        keyPath,
        caPath,
        error: "gateway tls: unable to compute certificate fingerprint",
      };
    }

    return {
      enabled: true,
      required: true,
      certPath,
      keyPath,
      caPath,
      fingerprintSha256,
      tlsOptions: {
        cert,
        key,
        ca,
        minVersion: "TLSv1.3",
      },
    };
  } catch (err) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      caPath,
      error: `gateway tls: failed to load cert (${String(err)})`,
    };
  }
}
