import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = {
  ok: boolean;
  command: string[];
  stdout: string;
  stderr: string;
  error?: string;
};

type BlockedCommand = {
  command: string;
  reason: string;
  ownerUnlock: string;
};

const REMOTE_WRITE_BLOCKS: BlockedCommand[] = [
  {
    command: "gh issue create|edit|close|reopen|comment",
    reason: "mutates remote GitHub issue state",
    ownerUnlock: "explicit_owner_remote_issue_write_command",
  },
  {
    command: "gh pr create|edit|merge|close|comment|review",
    reason: "mutates remote GitHub pull request state",
    ownerUnlock: "explicit_owner_remote_pr_write_command",
  },
  {
    command: "gh workflow run|enable|disable",
    reason: "can trigger or alter remote CI/runtime behavior",
    ownerUnlock: "explicit_owner_workflow_dispatch_command",
  },
  {
    command: "gh extension install|remove|upgrade",
    reason: "changes local executable tool surface",
    ownerUnlock: "skill_harvester_security_receipt",
  },
  {
    command: "gh auth refresh|login",
    reason: "changes credential or token scope",
    ownerUnlock: "explicit_owner_credential_scope_command",
  },
  {
    command: "gh copilot|gh aw|github-mcp-server write-capable commands",
    reason: "delegates work to another agent or MCP tool",
    ownerUnlock: "explicit_owner_agent_delegation_command",
  },
];

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 4000,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      command: [command, ...args],
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const maybeError = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: string | number;
    };
    return {
      ok: false,
      command: [command, ...args],
      stdout: String(maybeError.stdout ?? "").trim(),
      stderr: String(maybeError.stderr ?? "").trim(),
      error: maybeError.message ?? `${maybeError.code ?? "unknown_error"}`,
    };
  }
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? null;
}

function parseGitHubRemote(remote: string | null): string | null {
  if (!remote) {
    return null;
  }
  const httpsMatch = remote.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?$/);
  if (!httpsMatch?.groups) {
    return null;
  }
  return `${httpsMatch.groups.owner}/${httpsMatch.groups.repo}`;
}

function parseExtensions(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

function authSummary(authStatus: CommandResult) {
  const combined = `${authStatus.stdout}\n${authStatus.stderr}`;
  return {
    checked: true,
    ok: authStatus.ok,
    loggedIn: authStatus.ok && /Logged in to|✓ Logged in to/.test(combined),
    scopesSeen: combined.includes("Token scopes") || combined.includes("Token:"),
    error: authStatus.ok ? undefined : authStatus.error,
  };
}

export async function buildGithubCliCapabilityInventory() {
  const [ghVersion, authStatus, extensionList, gitRemote, gitBranch] = await Promise.all([
    runCommand("gh", ["--version"]),
    runCommand("gh", ["auth", "status", "--show-token-scopes"]),
    runCommand("gh", ["extension", "list"]),
    runCommand("git", ["remote", "get-url", "origin"]),
    runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const remoteUrl = firstLine(gitRemote.stdout);
  const installedExtensions = extensionList.ok ? parseExtensions(extensionList.stdout) : [];
  const hasAgenticExtension = installedExtensions.some((extension) =>
    /copilot|aw|agent|mcp/i.test(extension),
  );

  return {
    ok: ghVersion.ok,
    boundary: "local_github_cli_capability_inventory_only",
    checkedAt: new Date().toISOString(),
    gh: {
      available: ghVersion.ok,
      version: firstLine(ghVersion.stdout),
      auth: authSummary(authStatus),
      installedExtensions,
      hasAgenticExtension,
    },
    repo: {
      branch: firstLine(gitBranch.stdout),
      remoteUrl,
      githubRepo: parseGitHubRemote(remoteUrl),
    },
    allowedByDefault: [
      "gh --version",
      "gh auth status --show-token-scopes",
      "gh extension list",
      "gh repo view --json nameWithOwner,visibility,defaultBranchRef",
      "gh issue list --limit <n>",
      "gh pr list --limit <n>",
    ],
    blockedRemoteWriteCommands: REMOTE_WRITE_BLOCKS,
    nextSafeLocalProbe:
      "Use read-only gh issue/pr/repo inventory, then create a JSON wrapper contract before any remote write or agent delegation.",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    remoteGitHubTouched: false,
  };
}

function parseArgs(args: string[]) {
  return { json: args.includes("--json") };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildGithubCliCapabilityInventory();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `github cli capability inventory ${payload.ok ? "ok" : "unavailable"}`,
        `boundary=${payload.boundary}`,
        `gh=${payload.gh.version ?? "missing"}`,
        `authLoggedIn=${payload.gh.auth.loggedIn}`,
        `extensions=${payload.gh.installedExtensions.join(",") || "none"}`,
        `githubRepo=${payload.repo.githubRepo ?? "unknown"}`,
        `remoteGitHubTouched=${payload.remoteGitHubTouched}`,
      ].join("\n") + "\n",
    );
  }
  if (!payload.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
