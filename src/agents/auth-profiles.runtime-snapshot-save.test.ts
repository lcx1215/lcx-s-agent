import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  ensureAuthProfileStore,
  markAuthProfileUsed,
  markModelTimeoutCooldown,
} from "./auth-profiles.js";

describe("auth profile runtime snapshot persistence", () => {
  it("does not write resolved plaintext keys during usage updates", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-runtime-save-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        env: { OPENAI_API_KEY: "sk-runtime-openai" },
        agentDirs: [agentDir],
      });
      activateSecretsRuntimeSnapshot(snapshot);

      const runtimeStore = ensureAuthProfileStore(agentDir);
      expect(runtimeStore.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        key: "sk-runtime-openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      });

      await markAuthProfileUsed({
        store: runtimeStore,
        profileId: "openai:default",
        agentDir,
      });

      const persisted = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        profiles: Record<string, { key?: string; keyRef?: unknown }>;
      };
      expect(persisted.profiles["openai:default"]?.key).toBeUndefined();
      expect(persisted.profiles["openai:default"]?.keyRef).toEqual({
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      });
    } finally {
      clearSecretsRuntimeSnapshot();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("refreshes runtime snapshots after model timeout cooldown writes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-runtime-cooldown-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "custom-api-deepseek-com:default": {
                type: "api_key",
                provider: "custom-api-deepseek-com",
                keyRef: {
                  source: "env",
                  provider: "default",
                  id: "DEEPSEEK_API_KEY",
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        env: { DEEPSEEK_API_KEY: "sk-runtime-deepseek" },
        agentDirs: [agentDir],
      });
      activateSecretsRuntimeSnapshot(snapshot);

      const runtimeStore = ensureAuthProfileStore(agentDir);
      await markModelTimeoutCooldown({
        store: runtimeStore,
        provider: "custom-api-deepseek-com",
        model: "deepseek-chat",
        profileId: "custom-api-deepseek-com:default",
        agentDir,
        cooldownMs: 60_000,
      });

      const reloaded = ensureAuthProfileStore(agentDir);
      expect(
        reloaded.modelTimeoutCooldowns?.["custom-api-deepseek-com/deepseek-chat"],
      ).toMatchObject({
        lastProfileId: "custom-api-deepseek-com:default",
      });
    } finally {
      clearSecretsRuntimeSnapshot();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
