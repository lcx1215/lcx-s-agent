import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const formatCommit = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
};

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cachedCommits = new Map<string, string | null>();

const readCommitFromPackageJson = () => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as {
      gitHead?: string;
      githead?: string;
    };
    return formatCommit(pkg.gitHead ?? pkg.githead ?? null);
  } catch {
    return null;
  }
};

const readCommitFromBuildInfo = () => {
  try {
    const require = createRequire(import.meta.url);
    const candidates = ["../build-info.json", "./build-info.json"];
    for (const candidate of candidates) {
      try {
        const info = require(candidate) as {
          commit?: string | null;
        };
        const formatted = formatCommit(info.commit ?? null);
        if (formatted) {
          return formatted;
        }
      } catch {
        // ignore missing candidate
      }
    }
    return null;
  } catch {
    return null;
  }
};

export const resolveCommitHash = (options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const env = options.env ?? process.env;
  // Agent runs temporarily change process.cwd() to a user workspace. That workspace's
  // Git history must never become the identity of the running service.
  const cwd = path.resolve(options.cwd ?? sourceRoot);
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const key = JSON.stringify([cwd, envCommit ?? null]);
  if (cachedCommits.has(key)) {
    return cachedCommits.get(key)!;
  }
  const normalized = formatCommit(envCommit);
  let commit = normalized ?? readCommitFromBuildInfo() ?? readCommitFromPackageJson();
  if (!commit) {
    try {
      commit = formatCommit(
        execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
          encoding: "utf8",
          timeout: 1000,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      commit = null;
    }
  }
  cachedCommits.set(key, commit);
  return commit;
};
