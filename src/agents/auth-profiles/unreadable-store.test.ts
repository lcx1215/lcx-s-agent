import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { log } from "./constants.js";
import { ensureAuthProfileStore } from "./store.js";

const LEGACY_CREDENTIALS = {
  anthropic: { type: "api_key", provider: "anthropic", key: "sk-legacy" },
};

describe("auth profile store: a store that cannot be read must be left on disk", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tmp: string | null = null;
  let agentDir = "";

  const authPath = () => path.join(agentDir, "auth-profiles.json");
  const legacyPath = () => path.join(agentDir, "auth.json");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-store-"));
    process.env.OPENCLAW_STATE_DIR = tmp;
    agentDir = path.join(tmp, "agents", "sub");
    fs.mkdirSync(agentDir, { recursive: true });
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    tmp = null;
  });

  it("does not overwrite an unreadable store with credentials migrated from auth.json", () => {
    const corrupt =
      '{"version":1,"profiles":{"openai":{"type":"api_key","provider":"openai","key":"sk-real-';
    fs.writeFileSync(authPath(), corrupt, "utf-8");
    fs.writeFileSync(legacyPath(), JSON.stringify(LEGACY_CREDENTIALS), "utf-8");

    const store = ensureAuthProfileStore(agentDir);

    // The credentials we never managed to read are still the only copy on disk.
    expect(fs.readFileSync(authPath(), "utf-8")).toBe(corrupt);
    // The migrated legacy credential is still usable for this process, it just is not persisted.
    expect(Object.keys(store.profiles)).toContain("anthropic:default");
  });

  it("says the store could not be read instead of reporting an empty one", () => {
    fs.writeFileSync(authPath(), '{"version":1,"profiles":{', "utf-8");
    fs.writeFileSync(legacyPath(), JSON.stringify(LEGACY_CREDENTIALS), "utf-8");

    ensureAuthProfileStore(agentDir);

    const warned = vi.mocked(log.warn).mock.calls.map((call) => String(call[0]));
    expect(warned.some((message) => message.includes("could not be read"))).toBe(true);
  });

  it("does not overwrite a store whose shape is unrecognised", () => {
    const unrecognised = '{"not":"an auth store"}\n';
    fs.writeFileSync(authPath(), unrecognised, "utf-8");
    fs.writeFileSync(legacyPath(), JSON.stringify(LEGACY_CREDENTIALS), "utf-8");

    ensureAuthProfileStore(agentDir);

    expect(fs.readFileSync(authPath(), "utf-8")).toBe(unrecognised);
  });

  it("still migrates auth.json into a store that does not exist yet", () => {
    expect(fs.existsSync(authPath())).toBe(false);
    fs.writeFileSync(legacyPath(), JSON.stringify(LEGACY_CREDENTIALS), "utf-8");

    ensureAuthProfileStore(agentDir);

    const persisted = JSON.parse(fs.readFileSync(authPath(), "utf-8")) as {
      profiles: Record<string, unknown>;
    };
    expect(Object.keys(persisted.profiles)).toContain("anthropic:default");
  });
});
