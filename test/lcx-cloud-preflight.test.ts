import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildCloudPreflight } from "../scripts/operator/lcx-cloud-preflight.js";

async function withCloudState(
  callback: (stateDir: string, configPath: string) => Promise<void>,
): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cloud-preflight test-"));
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, "{}\n", "utf8");
  await fs.mkdir(path.join(stateDir, "workspace"));
  try {
    await callback(stateDir, configPath);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("LCX cloud preflight", () => {
  it("does not claim observed mounts when both Compose inputs are absent", async () => {
    await withCloudState(async (stateDir, configPath) => {
      const result = await buildCloudPreflight({
        LCX_CLOUD_RUNTIME: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: "fixture",
      });
      expect(result.status).toBe("needs_review");
      expect(result.checks).toContainEqual(
        expect.objectContaining({ id: "compose_mounts", status: "warn" }),
      );
    });
  });

  it("rejects host workspace aliases of the state root", async () => {
    await withCloudState(async (stateDir, configPath) => {
      const result = await buildCloudPreflight({
        LCX_CLOUD_RUNTIME: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CONFIG_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: stateDir,
        OPENCLAW_GATEWAY_TOKEN: "fixture",
      });
      expect(result.status).toBe("blocked");
    });
  });

  // These mountinfo fixtures use real POSIX temporary paths, not Windows drive paths.
  it.skipIf(path.sep === "\\")(
    "rejects a different backing workspace despite sharing the same device",
    async () => {
      await withCloudState(async (stateDir, configPath) => {
        const canonical = await fs.realpath(stateDir);
        const escaped = canonical.replaceAll(" ", "\\040");
        const mountInfo = `1 0 0:1 / / rw - overlay overlay rw\n2 1 8:1 /volume/state ${escaped} rw - ext4 /dev/vda rw\n3 2 8:1 /volume/other ${escaped}/workspace rw - ext4 /dev/vda rw`;
        const result = await buildCloudPreflight(
          {
            LCX_CLOUD_RUNTIME: "1",
            LCX_CLOUD_MOUNT_LAYOUT: "state-workspace-child-v1",
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_GATEWAY_TOKEN: "fixture",
          },
          { mountInfo },
        );
        expect(result.status).toBe("blocked");
      });
    },
  );

  it("does not treat a container overlay root as an observed persistent state mount", async () => {
    await withCloudState(async (stateDir, configPath) => {
      const result = await buildCloudPreflight(
        {
          LCX_CLOUD_RUNTIME: "1",
          LCX_CLOUD_MOUNT_LAYOUT: "state-workspace-child-v1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "fixture",
        },
        { mountInfo: "1 0 0:1 / / rw - overlay overlay rw" },
      );
      expect(result.status).toBe("needs_review");
    });
  });

  it.skipIf(path.sep === "\\").each([
    ["single-state-mount", "ready"],
    ["matching-child-mount", "ready"],
    ["different-device", "blocked"],
    ["state-alias", "blocked"],
    ["hidden-config-mount", "blocked"],
    ["missing-observation", "needs_review"],
    ["stacked-workspace", "needs_review"],
    ["workspace-file", "blocked"],
  ] as const)("checks container filesystem coordinates: %s", async (variant, expected) => {
    await withCloudState(async (stateDir, configPath) => {
      const canonical = await fs.realpath(stateDir);
      const escaped = (value: string) => value.replaceAll(" ", "\\040");
      const mount = escaped(canonical);
      const lines = [
        `1 0 0:1 / / rw - overlay overlay rw`,
        `2 1 8:1 /volume/state ${mount} rw - ext4 /dev/vda rw`,
      ];
      if (variant === "matching-child-mount") {
        lines.push(`3 2 8:1 /volume/state/workspace ${mount}/workspace rw - ext4 /dev/vda rw`);
      }
      if (variant === "different-device") {
        lines.push(`3 2 8:2 /volume/state/workspace ${mount}/workspace rw - ext4 /dev/vdb rw`);
      }
      if (variant === "state-alias") {
        lines.push(`3 2 8:1 /volume/state ${mount}/workspace rw - ext4 /dev/vda rw`);
      }
      if (variant === "hidden-config-mount") {
        lines.push(`3 2 8:1 /volume/other.json ${mount}/openclaw.json rw - ext4 /dev/vda rw`);
      }
      if (variant === "stacked-workspace") {
        lines.push(`3 2 8:1 /volume/state/workspace ${mount}/workspace rw - ext4 /dev/vda rw`);
        lines.push(`4 3 8:1 /volume/state ${mount}/workspace rw - ext4 /dev/vda rw`);
      }
      if (variant === "workspace-file") {
        await fs.rmdir(path.join(stateDir, "workspace"));
        await fs.writeFile(path.join(stateDir, "workspace"), "not a directory");
      }
      const result = await buildCloudPreflight(
        {
          LCX_CLOUD_RUNTIME: "1",
          LCX_CLOUD_MOUNT_LAYOUT: "state-workspace-child-v1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "fixture",
        },
        { mountInfo: variant === "missing-observation" ? "" : lines.join("\n") },
      );
      expect(result.status).toBe(expected);
    });
  });

  it("retains unresolved suffix order when validating nested host paths", async () => {
    await withCloudState(async (stateDir, configPath) => {
      const configDir = path.join(stateDir, "configuration", "runtime");
      const result = await buildCloudPreflight({
        LCX_CLOUD_RUNTIME: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CONFIG_DIR: configDir,
        OPENCLAW_WORKSPACE_DIR: path.join(configDir, "workspace"),
        OPENCLAW_GATEWAY_TOKEN: "fixture",
      });
      expect(result.status).toBe("ready");
    });
  });

  it("declares the observed mount contract for each Compose service", async () => {
    const compose = parse(
      await fs.readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    ) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    for (const service of ["lcx-agent-serve", "lcx-gateway", "lcx-cli"]) {
      expect(compose.services[service]?.environment.LCX_CLOUD_MOUNT_LAYOUT).toBe(
        "state-workspace-child-v1",
      );
    }
  });

  it("accepts host paths with an in-root config and distinct workspace child", async () => {
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

  it("blocks an in-root symlink that resolves outside the canonical state root", async () => {
    await withCloudState(async (stateDir) => {
      const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cloud-preflight-outside-"));
      try {
        const externalConfig = path.join(externalDir, "openclaw.json");
        const linkedConfig = path.join(stateDir, "linked-openclaw.json");
        await fs.writeFile(externalConfig, "{}\n", "utf8");
        await fs.symlink(externalConfig, linkedConfig);
        const result = await buildCloudPreflight({
          LCX_CLOUD_RUNTIME: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: linkedConfig,
          OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
          LCX_LOCAL_VISION_ENABLED: "0",
        });
        expect(result.status).toBe("blocked");
        expect(result.checks).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "config_path", status: "fail" })]),
        );
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });
  });
});
