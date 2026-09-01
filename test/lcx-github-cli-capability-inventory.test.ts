import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runInventory() {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-github-cli-capability-inventory.ts", "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    boundary: string;
    gh: {
      available: boolean;
      version: string | null;
      auth: {
        checked: boolean;
        ok: boolean;
        loggedIn: boolean;
        scopesSeen: boolean;
      };
      installedExtensions: string[];
      hasAgenticExtension: boolean;
    };
    repo: {
      branch: string | null;
      remoteUrl: string | null;
      githubRepo: string | null;
    };
    allowedByDefault: string[];
    blockedRemoteWriteCommands: Array<{
      command: string;
      reason: string;
      ownerUnlock: string;
    }>;
    remoteGitHubTouched: boolean;
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
}

describe("lcx-github-cli-capability-inventory", () => {
  it("keeps GitHub CLI as read-only inventory until remote writes are owner-unlocked", async () => {
    const payload = await runInventory();

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_github_cli_capability_inventory_only",
        remoteGitHubTouched: false,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.gh).toEqual(
      expect.objectContaining({
        available: true,
        version: expect.stringContaining("gh version"),
        auth: expect.objectContaining({ checked: true }),
      }),
    );
    expect(payload.allowedByDefault).toEqual(
      expect.arrayContaining(["gh --version", "gh extension list"]),
    );
    expect(payload.blockedRemoteWriteCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "gh issue create|edit|close|reopen|comment",
          ownerUnlock: "explicit_owner_remote_issue_write_command",
        }),
        expect.objectContaining({
          command: "gh pr create|edit|merge|close|comment|review",
          ownerUnlock: "explicit_owner_remote_pr_write_command",
        }),
        expect.objectContaining({
          command: "gh copilot|gh aw|github-mcp-server write-capable commands",
          ownerUnlock: "explicit_owner_agent_delegation_command",
        }),
      ]),
    );
  });
});
