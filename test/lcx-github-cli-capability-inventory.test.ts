import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runInventory() {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-github-cli-capability-inventory.ts", "--json"],
    { cwd: repoRoot, env: process.env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout) as {
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
    nextSafeLocalProbe: string;
    remoteGitHubTouched: boolean;
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
}

describe("lcx-github-cli-capability-inventory", () => {
  it("keeps GitHub CLI as read-only inventory until remote writes are owner-unlocked", () => {
    const payload = runInventory();

    expect(payload).toEqual(
      expect.objectContaining({
        boundary: "local_github_cli_capability_inventory_only",
        remoteGitHubTouched: false,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    if (!payload.gh.available) {
      expect(payload.ok).toBe(false);
      expect(payload.gh.auth.checked).toBe(true);
      return;
    }
    expect(payload.ok).toBe(true);
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
    if (payload.repo.githubRepo) {
      expect(payload.allowedByDefault).toEqual(
        expect.arrayContaining([
          `gh repo view ${payload.repo.githubRepo} --json nameWithOwner,visibility,defaultBranchRef`,
          `gh issue list --repo ${payload.repo.githubRepo} --limit <n>`,
          `gh pr list --repo ${payload.repo.githubRepo} --limit <n>`,
        ]),
      );
      expect(payload.nextSafeLocalProbe).toContain(`--repo ${payload.repo.githubRepo}`);
    }
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

type AutomationWorkflow = {
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      permissions: Record<string, string>;
      steps: Array<{ name?: string; with?: { script?: string; "operations-per-run"?: number } }>;
    }
  >;
};
async function automationWorkflow(name: string): Promise<AutomationWorkflow> {
  return parse(
    await fs.readFile(path.join(repoRoot, ".github", "workflows", `${name}.yml`), "utf8"),
  ) as AutomationWorkflow;
}
function automationScript(workflow: AutomationWorkflow, job: string, name: string): string {
  const script = workflow.jobs[job]?.steps.find((step) => step.name === name)?.with?.script;
  if (!script) {
    throw new Error(`missing automation script ${name}`);
  }
  return script;
}
const automationContext = {
  repo: { owner: "fixture", repo: "fixture" },
  payload: { pull_request: { number: 1, user: { login: "writer" } } },
};
const automationCore = { info: vi.fn(), warning: vi.fn() };

describe("repository automation recovery contracts", () => {
  it("recognizes repository write collaborators without organization-token access", async () => {
    const workflow = await automationWorkflow("labeler");
    const addLabels = vi.fn();
    const permissions = vi.fn(async () => ({ data: { permission: "write" } }));
    await vm.runInNewContext(
      `(async () => {${automationScript(workflow, "label", "Apply maintainer or trusted-contributor label")} })()`,
      {
        github: {
          rest: { repos: { getCollaboratorPermissionLevel: permissions }, issues: { addLabels } },
        },
        context: automationContext,
        core: automationCore,
      },
    );
    expect(permissions).toHaveBeenCalledWith({ ...automationContext.repo, username: "writer" });
    expect(addLabels).toHaveBeenCalledWith({
      ...automationContext.repo,
      issue_number: 1,
      labels: ["maintainer"],
    });
    for (const name of ["labeler", "auto-response"]) {
      const raw = await fs.readFile(
        path.join(repoRoot, ".github", "workflows", `${name}.yml`),
        "utf8",
      );
      expect(raw).not.toContain("teams.getMembershipForUserInOrg");
      expect(raw).not.toMatch(/members:\s*read/);
    }
  });

  it("runs the existing noisy PR guard directly after token-based labeling", async () => {
    const workflow = await automationWorkflow("labeler");
    const script = automationScript(
      workflow,
      "label",
      "Apply noisy PR guard after repository-token labeling",
    );
    for (const count of [20, 21]) {
      const update = vi.fn();
      await vm.runInNewContext(`(async () => {${script} })()`, {
        github: {
          paginate: async () =>
            Array.from({ length: count }, (_, index) => ({ name: `label-${index}` })),
          rest: { issues: { listLabelsOnIssue: {}, update, createComment: vi.fn() } },
        },
        context: automationContext,
        core: automationCore,
      });
      expect(update).toHaveBeenCalledTimes(count === 21 ? 1 : 0);
    }
  });

  it("bounds stale and lock requests within the repository-token hourly allowance", async () => {
    const workflow = await automationWorkflow("stale");
    const staleBudget = workflow.jobs.stale.steps[0].with?.["operations-per-run"] ?? 0;
    const script = automationScript(
      workflow,
      "lock-closed-issues",
      "Lock closed issues after 48h of no comments",
    );
    const listForRepo = vi.fn(async () => ({
      data: Array.from({ length: 100 }, (_, index) => ({
        number: index + 1,
        comments: 2,
        closed_at: "2020-01-01T00:00:00Z",
        updated_at: "2020-01-01T00:00:00Z",
      })),
    }));
    const lock = vi.fn();
    await vm.runInNewContext(`(async () => {${script} })()`, {
      github: { rest: { issues: { listForRepo, lock } } },
      context: automationContext,
      core: automationCore,
    });
    const requests = listForRepo.mock.calls.length + lock.mock.calls.length;
    expect(requests).toBe(200);
    expect(staleBudget).toBe(400);
    expect(staleBudget + requests).toBeLessThan(1000);
  });
});
