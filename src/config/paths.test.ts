import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveConfigPath,
  resolveLcxConfigPath,
  resolveLcxIdentityMigrationPlan,
  resolveLcxStateDir,
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

  function expectOpenClawHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.OPENCLAW_HOME;
    if (!configuredHome) {
      throw new Error("OPENCLAW_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".openclaw"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".openclaw", "openclaw.json"));
  }

  it("uses OPENCLAW_STATE_DIR when set", () => {
    const env = {
      OPENCLAW_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses OPENCLAW_HOME for default state/config locations", () => {
    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;
    expectOpenClawHomeDefaults(env);
  });

  it("prefers OPENCLAW_HOME over HOME for default state/config locations", () => {
    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectOpenClawHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [
      path.join(resolvedHome, ".openclaw", "openclaw.json"),
      path.join(resolvedHome, ".openclaw", "clawdbot.json"),
      path.join(resolvedHome, ".openclaw", "moldbot.json"),
      path.join(resolvedHome, ".openclaw", "moltbot.json"),
      path.join(resolvedHome, ".clawdbot", "openclaw.json"),
      path.join(resolvedHome, ".clawdbot", "clawdbot.json"),
      path.join(resolvedHome, ".clawdbot", "moldbot.json"),
      path.join(resolvedHome, ".clawdbot", "moltbot.json"),
      path.join(resolvedHome, ".moldbot", "openclaw.json"),
      path.join(resolvedHome, ".moldbot", "clawdbot.json"),
      path.join(resolvedHome, ".moldbot", "moldbot.json"),
      path.join(resolvedHome, ".moldbot", "moltbot.json"),
      path.join(resolvedHome, ".moltbot", "openclaw.json"),
      path.join(resolvedHome, ".moltbot", "clawdbot.json"),
      path.join(resolvedHome, ".moltbot", "moldbot.json"),
      path.join(resolvedHome, ".moltbot", "moltbot.json"),
    ];
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.openclaw when it exists and legacy dir is missing", async () => {
    await withTempRoot("openclaw-state-", async (root) => {
      const newDir = path.join(root, ".openclaw");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("falls back to existing legacy state dir when ~/.openclaw is missing", async () => {
    await withTempRoot("openclaw-state-legacy-", async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyDir);
    });
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    await withTempRoot("openclaw-config-", async (root) => {
      const legacyDir = path.join(root, ".openclaw");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "openclaw.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
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

  it("defines LCX as the write target without changing current runtime defaults", async () => {
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
