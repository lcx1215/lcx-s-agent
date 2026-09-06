import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(
  home: string,
  dirname: ".lcx" | ".openclaw",
  port: number,
  filename: string = "openclaw.json",
) {
  const dir = path.join(home, dirname);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, filename);
  await fs.writeFile(configPath, JSON.stringify({ gateway: { port } }, null, 2));
  return configPath;
}

function createIoForHome(home: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) {
  return createConfigIO({
    env,
    homedir: () => home,
  });
}

describe("config io paths", () => {
  it("uses ~/.lcx/lcx.json when canonical config exists", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".lcx", 19001, "lcx.json");
      const io = createIoForHome(home);
      expect(io.configPath).toBe(configPath);
      expect(io.loadConfig().gateway?.port).toBe(19001);
    });
  });

  it("prefers lcx.json when a compatibility root contains both config names", async () => {
    await withTempHome(async (home) => {
      const canonicalCompatibilityPath = await writeConfig(home, ".openclaw", 20006, "lcx.json");
      await writeConfig(home, ".openclaw", 20007, "openclaw.json");

      const io = createIoForHome(home);
      expect(io.configPath).toBe(canonicalCompatibilityPath);
      expect(io.loadConfig().gateway?.port).toBe(20006);
    });
  });

  it("does not reactivate an early canonical config while legacy state is active", async () => {
    await withTempHome(async (home) => {
      await fs.mkdir(path.join(home, ".lcx"), { recursive: true });
      await fs.mkdir(path.join(home, ".openclaw", "sessions"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".lcx", "lcx.json"),
        JSON.stringify({ gateway: { port: 20008 } }),
        "utf8",
      );

      const io = createIoForHome(home);
      expect(io.configPath).toBe(path.join(home, ".openclaw", "openclaw.json"));
      expect(io.loadConfig().gateway?.port).not.toBe(20008);
    });
  });

  it("defaults to ~/.lcx/lcx.json when config is missing", async () => {
    await withTempHome(async (home) => {
      const io = createIoForHome(home);
      expect(io.configPath).toBe(path.join(home, ".lcx", "lcx.json"));
    });
  });

  it("uses OPENCLAW_HOME for default config path", async () => {
    await withTempHome(async (home) => {
      const io = createConfigIO({
        env: { OPENCLAW_HOME: path.join(home, "svc-home") } as NodeJS.ProcessEnv,
        homedir: () => path.join(home, "ignored-home"),
      });
      expect(io.configPath).toBe(path.join(home, "svc-home", ".lcx", "lcx.json"));
    });
  });

  it("honors explicit OPENCLAW_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const customPath = await writeConfig(home, ".openclaw", 20002, "custom.json");
      const io = createIoForHome(home, { OPENCLAW_CONFIG_PATH: customPath } as NodeJS.ProcessEnv);
      expect(io.configPath).toBe(customPath);
      expect(io.loadConfig().gateway?.port).toBe(20002);
    });
  });

  it("honors legacy CLAWDBOT_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const customPath = await writeConfig(home, ".openclaw", 20003, "legacy-custom.json");
      const io = createIoForHome(home, { CLAWDBOT_CONFIG_PATH: customPath } as NodeJS.ProcessEnv);
      expect(io.configPath).toBe(customPath);
      expect(io.loadConfig().gateway?.port).toBe(20003);
    });
  });

  it("prefers the canonical config in an explicit state directory", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, "operator-state");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "lcx.json"),
        JSON.stringify({ gateway: { port: 20004 } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({ gateway: { port: 20005 } }),
        "utf8",
      );

      const io = createIoForHome(home, { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
      expect(io.configPath).toBe(path.join(stateDir, "lcx.json"));
      expect(io.loadConfig().gateway?.port).toBe(20004);
    });
  });

  it("normalizes safe-bin config entries at config load time", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".lcx");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "lcx.json");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            tools: {
              exec: {
                safeBinTrustedDirs: [" /custom/bin ", "", "/custom/bin", "/agent/bin"],
                safeBinProfiles: {
                  " MyFilter ": {
                    allowedValueFlags: ["--limit", " --limit ", ""],
                  },
                },
              },
            },
            agents: {
              list: [
                {
                  id: "ops",
                  tools: {
                    exec: {
                      safeBinTrustedDirs: [" /ops/bin ", "/ops/bin"],
                      safeBinProfiles: {
                        " Custom ": {
                          deniedFlags: ["-f", " -f ", ""],
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const io = createIoForHome(home);
      expect(io.configPath).toBe(configPath);
      const cfg = io.loadConfig();
      expect(cfg.tools?.exec?.safeBinProfiles).toEqual({
        myfilter: {
          allowedValueFlags: ["--limit"],
        },
      });
      expect(cfg.tools?.exec?.safeBinTrustedDirs).toEqual(["/custom/bin", "/agent/bin"]);
      expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinProfiles).toEqual({
        custom: {
          deniedFlags: ["-f"],
        },
      });
      expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinTrustedDirs).toEqual(["/ops/bin"]);
    });
  });

  it("logs invalid config path details and returns empty config", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { port: "not-a-number" } }, null, 2),
      );

      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });

      expect(io.loadConfig()).toEqual({});
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid config at ${configPath}:\\n`),
      );
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("- gateway.port:"));
    });
  });
});
