import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DEFAULT_AGENT_WORKSPACE_DIR", () => {
  it("uses OPENCLAW_HOME when resolving the default workspace dir", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    vi.stubEnv("HOME", path.join(path.sep, "home", "other"));

    expect(resolveDefaultAgentWorkspaceDir()).toBe(
      path.join(path.resolve(home), ".lcx", "workspace"),
    );
  });

  it("keeps an existing compatibility workspace active", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-workspace-home-"));
    try {
      const legacyWorkspace = path.join(home, ".openclaw", "workspace");
      await fs.mkdir(legacyWorkspace, { recursive: true });
      expect(resolveDefaultAgentWorkspaceDir({ OPENCLAW_HOME: home } as NodeJS.ProcessEnv)).toBe(
        legacyWorkspace,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("uses an explicit state-root override for named profiles", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-workspace-explicit-home-"));
    try {
      const stateDir = path.join(home, "operator-state");
      await fs.mkdir(path.join(home, ".openclaw", "workspace-work"), { recursive: true });

      expect(
        resolveDefaultAgentWorkspaceDir(
          {
            HOME: home,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: stateDir,
          } as NodeJS.ProcessEnv,
          () => home,
        ),
      ).toBe(path.join(stateDir, "workspace-work"));
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
