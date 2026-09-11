import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCloudPreflight } from "../scripts/operator/lcx-cloud-preflight.js";

async function withCloudState(
  callback: (stateDir: string, configPath: string) => Promise<void>,
): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cloud-preflight-test-"));
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, "{}\n", "utf8");
  try {
    await callback(stateDir, configPath);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("LCX cloud preflight", () => {
  it("accepts one writable state root with an in-root config and secret", async () => {
    await withCloudState(async (stateDir, configPath) => {
      const result = await buildCloudPreflight({
        LCX_CLOUD_RUNTIME: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CONFIG_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: stateDir,
        OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
        LCX_LOCAL_VISION_ENABLED: "0",
      });
      expect(result.status).toBe("ready");
    });
  });

  it("accepts the documented nested workspace mount under the config root", async () => {
    await withCloudState(async (stateDir, configPath) => {
      const result = await buildCloudPreflight({
        LCX_CLOUD_RUNTIME: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CONFIG_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
        OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
        LCX_LOCAL_VISION_ENABLED: "0",
      });
      expect(result.status).toBe("ready");
      expect(result.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "compose_mounts", status: "pass" })]),
      );
    });
  });

  it("blocks a workspace mount outside the canonical state root", async () => {
    await withCloudState(async (stateDir, configPath) => {
      const result = await buildCloudPreflight({
        LCX_CLOUD_RUNTIME: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CONFIG_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "..", "workspace"),
        OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
        LCX_LOCAL_VISION_ENABLED: "0",
      });
      expect(result.status).toBe("blocked");
      expect(result.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "compose_mounts", status: "fail" })]),
      );
    });
  });

  it("blocks a split config root and placeholder gateway secret", async () => {
    await withCloudState(async (stateDir) => {
      const result = await buildCloudPreflight({
        LCX_CLOUD_RUNTIME: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "..", "openclaw.json"),
        OPENCLAW_GATEWAY_TOKEN: "REPLACE_WITH_SECRET_MANAGER_INJECTION",
        LCX_LOCAL_VISION_ENABLED: "0",
      });
      expect(result.status).toBe("blocked");
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "config_path", status: "fail" }),
          expect.objectContaining({ id: "gateway_auth_secret", status: "fail" }),
        ]),
      );
    });
  });

  it("blocks an in-root config path that does not resolve to a readable file", async () => {
    await withCloudState(async (stateDir, configPath) => {
      await fs.rm(configPath);
      const result = await buildCloudPreflight({
        LCX_CLOUD_RUNTIME: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
        LCX_LOCAL_VISION_ENABLED: "0",
      });
      expect(result.status).toBe("blocked");
      expect(result.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "config_path", status: "fail" })]),
      );
    });
  });
});
