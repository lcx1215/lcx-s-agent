import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveConfigPath,
  resolveLcxConfigPath,
  resolveLcxIdentityMigrationCompletionPath,
  resolveLcxIdentityMigrationPlan,
  resolveLcxStateDir,
  resolveNewStateDirForProfile,
  resolveStateDirForProfile,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
} from "./paths.js";

describe("oauth paths", () => {
  it("prefers OPENCLAW_OAUTH_DIR over OPENCLAW_STATE_DIR", () => {
    const env = {
      OPENCLAW_OAUTH_DIR: "/custom/oauth",
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from OPENCLAW_STATE_DIR when unset", () => {
    const env = {
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  async function withTempRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function expectLcxHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.OPENCLAW_HOME;
    if (!configuredHome) {
      throw new Error("OPENCLAW_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".lcx"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".lcx", "lcx.json"));
  }

  it("uses OPENCLAW_STATE_DIR when set", () => {
    const env = {
      OPENCLAW_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("centralizes compatibility profile state roots", () => {
    expect(resolveNewStateDirForProfile(undefined, () => "/home/test")).toBe(
      path.join("/home/test", ".lcx"),
    );
    expect(resolveNewStateDirForProfile("default", () => "/home/test")).toBe(
      path.join("/home/test", ".lcx"),
    );
    expect(resolveNewStateDirForProfile("Dev", () => "/home/test")).toBe(
      path.join("/home/test", ".lcx-Dev"),
    );
  });

  it("keeps an existing compatibility profile root active", async () => {
    await withTempRoot("lcx-profile-legacy-", async (root) => {
      const legacyStateDir = path.join(root, ".openclaw-work");
      await fs.mkdir(legacyStateDir, { recursive: true });
      await fs.writeFile(path.join(legacyStateDir, "openclaw.json"), "{}", "utf8");

      expect(resolveStateDirForProfile("work", {} as NodeJS.ProcessEnv, () => root)).toBe(
        legacyStateDir,
      );
    });
  });

  it("keeps profile state canonical when only config is explicitly overridden", async () => {
    await withTempRoot("lcx-profile-config-only-", async (root) => {
      const legacyStateDir = path.join(root, ".openclaw-work");
      await fs.mkdir(legacyStateDir, { recursive: true });
      await fs.writeFile(path.join(legacyStateDir, "openclaw.json"), "{}", "utf8");

      const env = {
        OPENCLAW_CONFIG_PATH: path.join(root, "selected-config.json"),
      } as NodeJS.ProcessEnv;
      expect(resolveStateDirForProfile("work", env, () => root)).toBe(path.join(root, ".lcx-work"));
    });
  });

  it("honors an explicit profile state-root override", async () => {
    await withTempRoot("lcx-profile-explicit-state-", async (root) => {
      const explicitStateDir = path.join(root, "operator-state");
      const env = {
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: explicitStateDir,
      } as NodeJS.ProcessEnv;

      expect(resolveStateDirForProfile("work", env, () => root)).toBe(explicitStateDir);
    });
  });

  it("prefers an existing compatibility profile root when both roots are empty", async () => {
    await withTempRoot("lcx-profile-empty-roots-", async (root) => {
      const canonicalStateDir = path.join(root, ".lcx-work");
      const legacyStateDir = path.join(root, ".openclaw-work");
      await fs.mkdir(canonicalStateDir, { recursive: true });
      await fs.mkdir(legacyStateDir, { recursive: true });

      expect(resolveStateDirForProfile("work", {} as NodeJS.ProcessEnv, () => root)).toBe(
        legacyStateDir,
      );
    });
  });

  it("uses OPENCLAW_HOME for default state/config locations", () => {
    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;
    expectLcxHomeDefaults(env);
  });

  it("prefers OPENCLAW_HOME over HOME for default state/config locations", () => {
    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectLcxHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [
      path.join(resolvedHome, ".lcx", "lcx.json"),
      path.join(resolvedHome, ".lcx", "openclaw.json"),
      path.join(resolvedHome, ".lcx", "clawdbot.json"),
      path.join(resolvedHome, ".lcx", "moldbot.json"),
      path.join(resolvedHome, ".lcx", "moltbot.json"),
      path.join(resolvedHome, ".openclaw", "lcx.json"),
      path.join(resolvedHome, ".openclaw", "openclaw.json"),
      path.join(resolvedHome, ".openclaw", "clawdbot.json"),
      path.join(resolvedHome, ".openclaw", "moldbot.json"),
      path.join(resolvedHome, ".openclaw", "moltbot.json"),
      path.join(resolvedHome, ".clawdbot", "lcx.json"),
      path.join(resolvedHome, ".clawdbot", "openclaw.json"),
      path.join(resolvedHome, ".clawdbot", "clawdbot.json"),
      path.join(resolvedHome, ".clawdbot", "moldbot.json"),
      path.join(resolvedHome, ".clawdbot", "moltbot.json"),
      path.join(resolvedHome, ".moldbot", "lcx.json"),
      path.join(resolvedHome, ".moldbot", "openclaw.json"),
      path.join(resolvedHome, ".moldbot", "clawdbot.json"),
      path.join(resolvedHome, ".moldbot", "moldbot.json"),
      path.join(resolvedHome, ".moldbot", "moltbot.json"),
      path.join(resolvedHome, ".moltbot", "lcx.json"),
      path.join(resolvedHome, ".moltbot", "openclaw.json"),
      path.join(resolvedHome, ".moltbot", "clawdbot.json"),
      path.join(resolvedHome, ".moltbot", "moldbot.json"),
      path.join(resolvedHome, ".moltbot", "moltbot.json"),
    ];
    expect(candidates).toEqual(expected);
  });

  it("keeps a legacy root active when it is the existing state source", async () => {
    await withTempRoot("openclaw-state-", async (root) => {
      const compatibilityDir = path.join(root, ".openclaw");
      await fs.mkdir(compatibilityDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(compatibilityDir);
    });
  });

  it("keeps legacy config and state on one active root", async () => {
    await withTempRoot("openclaw-state-legacy-", async (root) => {
      const legacyDir = path.join(root, ".openclaw");
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, "openclaw.json"), "{}", "utf8");
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyDir);
      expect(resolveConfigPath({} as NodeJS.ProcessEnv, resolved, () => root)).toBe(
        path.join(legacyDir, "openclaw.json"),
      );
    });
  });

  it("discovers non-openclaw legacy config filenames in the active root", async () => {
    await withTempRoot("legacy-config-name-", async (root) => {
      const legacyDir = path.join(root, ".openclaw");
      const legacyPath = path.join(legacyDir, "clawdbot.json");
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(legacyPath, "{}", "utf8");

      const env = {} as NodeJS.ProcessEnv;
      const stateDir = resolveStateDir(env, () => root);
      expect(resolveConfigPath(env, stateDir, () => root)).toBe(legacyPath);
      expect(resolveConfigPathCandidate(env, () => root)).toBe(legacyPath);
    });
  });

  it("keeps CONFIG_PATH on the legacy root until migration is explicit", async () => {
    await withTempRoot("openclaw-config-", async (root) => {
      const legacyDir = path.join(root, ".openclaw");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "openclaw.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    });
  });

  it("keeps config-only overrides on the canonical state root", async () => {
    await withTempRoot("openclaw-config-only-", async (root) => {
      const compatibilityDir = path.join(root, ".openclaw");
      await fs.mkdir(compatibilityDir, { recursive: true });
      const configPath = path.join(root, "selected-config.json");
      const env = { OPENCLAW_CONFIG_PATH: configPath } as NodeJS.ProcessEnv;

      const plan = resolveLcxIdentityMigrationPlan({ env, homedir: () => root });

      expect(plan.readConfigPath).toBe(configPath);
      expect(plan.readStateDir).toBe(path.join(root, ".lcx"));
      expect(resolveStateDir(env, () => root)).toBe(path.join(root, ".lcx"));
    });
  });

  it("respects state dir overrides when config is missing", async () => {
    await withTempRoot("openclaw-config-override-", async (root) => {
      const legacyDir = path.join(root, ".openclaw");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "openclaw.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "openclaw.json"));
    });
  });
});

describe("LCX identity migration plan", () => {
  async function withTempRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("defines LCX as the active default runtime target", async () => {
    await withTempRoot("lcx-identity-empty-", async (root) => {
      const env = {} as NodeJS.ProcessEnv;
      const plan = resolveLcxIdentityMigrationPlan({ env, homedir: () => root });

      expect(resolveLcxStateDir(() => root)).toBe(path.join(root, ".lcx"));
      expect(resolveLcxConfigPath(plan.canonicalStateDir)).toBe(
        path.join(root, ".lcx", "lcx.json"),
      );
      expect(plan.mode).toBe("canonical-default");
      expect(plan.source).toBe("none");
      expect(plan.readStateDir).toBe(path.join(root, ".lcx"));
      expect(plan.readConfigPath).toBe(path.join(root, ".lcx", "lcx.json"));
      expect(plan.writeStateDir).toBe(path.join(root, ".lcx"));
      expect(plan.writeConfigPath).toBe(path.join(root, ".lcx", "lcx.json"));
      expect(resolveStateDir(env, () => root)).toBe(path.join(root, ".lcx"));
      expect(resolveConfigPathCandidate(env, () => root)).toBe(path.join(root, ".lcx", "lcx.json"));
      await expect(fs.stat(path.join(root, ".lcx"))).rejects.toThrow();
    });
  });

  it("reads an existing legacy config but keeps the canonical LCX write target", async () => {
    await withTempRoot("lcx-identity-legacy-", async (root) => {
      const legacyStateDir = path.join(root, ".openclaw");
      const legacyConfigPath = path.join(legacyStateDir, "openclaw.json");
      await fs.mkdir(legacyStateDir, { recursive: true });
      await fs.writeFile(legacyConfigPath, "{}", "utf8");

      const plan = resolveLcxIdentityMigrationPlan({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(plan.source).toBe("legacy");
      expect(plan.readStateDir).toBe(legacyStateDir);
      expect(plan.readConfigPath).toBe(legacyConfigPath);
      expect(plan.writeStateDir).toBe(path.join(root, ".lcx"));
      expect(plan.writeConfigPath).toBe(path.join(root, ".lcx", "lcx.json"));
      expect(plan.readConfigCandidates[0]).toBe(path.join(root, ".lcx", "lcx.json"));
      expect(plan.readConfigCandidates).toContain(legacyConfigPath);
      await expect(fs.stat(path.join(root, ".lcx"))).rejects.toThrow();
    });
  });

  it("prefers an existing canonical LCX config over every legacy candidate", async () => {
    await withTempRoot("lcx-identity-canonical-", async (root) => {
      const canonicalConfigPath = path.join(root, ".lcx", "lcx.json");
      const legacyConfigPath = path.join(root, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(canonicalConfigPath), { recursive: true });
      await fs.mkdir(path.dirname(legacyConfigPath), { recursive: true });
      await fs.writeFile(canonicalConfigPath, "{}", "utf8");
      await fs.writeFile(legacyConfigPath, "{}", "utf8");
      await fs.writeFile(
        resolveLcxIdentityMigrationCompletionPath(path.join(root, ".lcx")),
        JSON.stringify({
          schemaVersion: 1,
          canonicalStateDir: path.join(root, ".lcx"),
          completedAt: "2026-09-06T00:00:00.000Z",
        }),
        "utf8",
      );

      const plan = resolveLcxIdentityMigrationPlan({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(plan.source).toBe("canonical");
      expect(plan.readStateDir).toBe(path.join(root, ".lcx"));
      expect(plan.readConfigPath).toBe(canonicalConfigPath);
      expect(plan.writeConfigPath).toBe(canonicalConfigPath);
    });
  });

  it("does not activate canonical config before migration completion is marked", async () => {
    await withTempRoot("lcx-identity-unmarked-", async (root) => {
      const canonicalConfigPath = path.join(root, ".lcx", "lcx.json");
      const legacyConfigPath = path.join(root, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(canonicalConfigPath), { recursive: true });
      await fs.mkdir(path.dirname(legacyConfigPath), { recursive: true });
      await fs.writeFile(canonicalConfigPath, "{}", "utf8");
      await fs.writeFile(legacyConfigPath, "{}", "utf8");

      const plan = resolveLcxIdentityMigrationPlan({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(plan.source).toBe("legacy");
      expect(plan.readStateDir).toBe(path.join(root, ".openclaw"));
      expect(plan.readConfigPath).toBe(legacyConfigPath);
      expect(plan.writeConfigPath).toBe(canonicalConfigPath);
    });
  });

  it("keeps the legacy config target when canonical config was written early", async () => {
    await withTempRoot("lcx-identity-early-config-", async (root) => {
      const canonicalConfigPath = path.join(root, ".lcx", "lcx.json");
      const legacyStateDir = path.join(root, ".openclaw");
      await fs.mkdir(path.dirname(canonicalConfigPath), { recursive: true });
      await fs.mkdir(path.join(legacyStateDir, "sessions"), { recursive: true });
      await fs.writeFile(canonicalConfigPath, "{}", "utf8");

      const plan = resolveLcxIdentityMigrationPlan({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(plan.source).toBe("none");
      expect(plan.readStateDir).toBe(legacyStateDir);
      expect(plan.readConfigPath).toBe(path.join(legacyStateDir, "openclaw.json"));
      expect(plan.writeConfigPath).toBe(canonicalConfigPath);
    });
  });

  it("does not let an empty canonical state dir split the legacy read source", async () => {
    await withTempRoot("lcx-identity-partial-", async (root) => {
      const canonicalStateDir = path.join(root, ".lcx");
      const legacyStateDir = path.join(root, ".openclaw");
      const legacyConfigPath = path.join(legacyStateDir, "openclaw.json");
      await fs.mkdir(canonicalStateDir, { recursive: true });
      await fs.mkdir(legacyStateDir, { recursive: true });
      await fs.writeFile(legacyConfigPath, "{}", "utf8");

      const plan = resolveLcxIdentityMigrationPlan({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(plan.readStateDir).toBe(legacyStateDir);
      expect(plan.readConfigPath).toBe(legacyConfigPath);
      expect(plan.writeStateDir).toBe(canonicalStateDir);
      expect(plan.writeConfigPath).toBe(path.join(canonicalStateDir, "lcx.json"));
    });
  });

  it("keeps explicit legacy overrides authoritative for both reads and writes", () => {
    const env = {
      OPENCLAW_STATE_DIR: "~/legacy-state",
      OPENCLAW_CONFIG_PATH: "~/legacy-state/openclaw.json",
    } as NodeJS.ProcessEnv;
    const plan = resolveLcxIdentityMigrationPlan({ env, homedir: () => "/home/test" });

    expect(plan.mode).toBe("explicit-config-override");
    expect(plan.source).toBe("explicit");
    expect(plan.readStateDirs).toEqual([path.join("/home/test", "legacy-state")]);
    expect(plan.readConfigCandidates).toEqual([
      path.join("/home/test", "legacy-state", "openclaw.json"),
    ]);
    expect(plan.writeStateDir).toBe(path.join("/home/test", "legacy-state"));
    expect(plan.writeConfigPath).toBe(path.join("/home/test", "legacy-state", "openclaw.json"));
  });
});
