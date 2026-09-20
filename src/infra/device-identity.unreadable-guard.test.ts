import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeDeviceAuthToken } from "./device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";

// Both of these files hold material that cannot be re-derived: a device private key, and the
// auth tokens issued to every device/role. The defect this pins is that a file which existed but
// could not be read or parsed was answered as "no file", and the caller then wrote a fresh
// document over the only copy that existed — silently rotating a device's identity, or dropping
// every token in the store.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-device-guard-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("device identity: an identity file that cannot be read is not an absent one", () => {
  it("refuses to replace a corrupted identity file", () => {
    const filePath = path.join(root, "device.json");
    const original = '{"version":1,"deviceId":"dev-1","publicKeyPem":"pub","privateKeyPem":';
    fs.writeFileSync(filePath, original, "utf-8");

    expect(() => loadOrCreateDeviceIdentity(filePath)).toThrow(/cannot read device identity/);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
  });

  it("refuses to replace an identity file it is not allowed to read", () => {
    const filePath = path.join(root, "device.json");
    const original = JSON.stringify({
      version: 1,
      deviceId: "dev-1",
      publicKeyPem: "pub",
      privateKeyPem: "priv",
    });
    fs.writeFileSync(filePath, original, "utf-8");
    fs.chmodSync(filePath, 0o000);

    try {
      expect(() => loadOrCreateDeviceIdentity(filePath)).toThrow(/cannot read device identity/);
    } finally {
      fs.chmodSync(filePath, 0o600);
    }
    expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
  });

  it("still generates an identity when there is no file", () => {
    const identity = loadOrCreateDeviceIdentity(path.join(root, "fresh", "device.json"));

    expect(identity.privateKeyPem).toContain("PRIVATE KEY");
    expect(fs.existsSync(path.join(root, "fresh", "device.json"))).toBe(true);
  });
});

describe("device auth store: a token store that cannot be read is not an empty one", () => {
  const env = () => ({ ...process.env, OPENCLAW_STATE_DIR: root }) as NodeJS.ProcessEnv;

  function authFilePath(): string {
    return path.join(root, "identity", "device-auth.json");
  }

  it("refuses to replace a corrupted token store", () => {
    fs.mkdirSync(path.dirname(authFilePath()), { recursive: true });
    const original = '{"version":1,"deviceId":"dev-1","tokens":{"dev-1":{';
    fs.writeFileSync(authFilePath(), original, "utf-8");

    expect(() =>
      storeDeviceAuthToken({ deviceId: "dev-1", role: "node", token: "tok", env: env() }),
    ).toThrow(/cannot read device auth store/);
    expect(fs.readFileSync(authFilePath(), "utf-8")).toBe(original);
  });

  it("still stores a token when there is no store yet", () => {
    storeDeviceAuthToken({ deviceId: "dev-1", role: "node", token: "tok", env: env() });

    expect(fs.existsSync(authFilePath())).toBe(true);
    const written = JSON.parse(fs.readFileSync(authFilePath(), "utf-8")) as Record<string, unknown>;
    expect(written.version).toBe(1);
  });
});
