import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { openBoundaryFileSync } from "../../infra/boundary-file-read.js";

const exec = promisify(execFile);
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_FILES = 20_000;
const PRIVATE =
  /(^|\/)(\.git|\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.openclaw|node_modules|\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth-profiles\.json|auth\.json|openclaw\.json)(\/|$)|^(state|memory|credentials?|secrets?)(\/|$)|\.(pem|key|p12|pfx)$/i;
export type NativeManifest = Record<string, { sha256: string; mode: number; bytes: number }>;
export type NativeSource = {
  root: string;
  head: string;
  branch: string;
  commonDir: string;
  manifest: NativeManifest;
};
export async function nativeGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], {
    timeout: 10_000,
    signal,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}
function safeRelative(name: string) {
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some((p) => p === ".." || p === "")) {
    throw new Error(`unsafe artifact path: ${name}`);
  }
}
export async function readNativeFile(
  root: string,
  relative: string,
): Promise<{ data: Buffer; mode: number }> {
  safeRelative(relative);
  const target = path.join(root, relative);
  const resolved = await fs.realpath(target);
  if (!resolved.startsWith(root + path.sep) || resolved !== target) {
    throw new Error(`symlink rejected: ${relative}`);
  }
  // Reuse boundary/identity validation, with NONBLOCK so a raced FIFO cannot hang the controller.
  const opened = openBoundaryFileSync({
    absolutePath: target,
    rootPath: root,
    boundaryLabel: "native task",
    rejectHardlinks: true,
    maxBytes: MAX_FILE,
    ioFs: {
      ...fsSync,
      openSync: (file, flags, mode) =>
        fsSync.openSync(
          file,
          typeof flags === "number" ? flags | fsSync.constants.O_NONBLOCK : flags,
          mode,
        ),
    },
  });
  if (!opened.ok) {
    throw new Error(`unsafe or oversized file: ${relative}`);
  }
  const { fd, stat } = opened;
  try {
    const canonical = fsSync.realpathSync(target);
    const current = fsSync.lstatSync(canonical);
    if (
      canonical !== target ||
      !canonical.startsWith(root + path.sep) ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.nlink !== 1
    ) {
      throw new Error(`path changed before read: ${relative}`);
    }
    const buffer = Buffer.alloc(Math.min(MAX_FILE + 1, stat.size + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fsSync.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) {
        break;
      }
      bytes += count;
    }
    const after = fsSync.fstatSync(fd);
    if (
      bytes !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.nlink !== 1
    ) {
      throw new Error(`file changed while reading: ${relative}`);
    }
    return { data: buffer.subarray(0, bytes), mode: stat.mode & 0o111 ? 0o755 : 0o644 };
  } finally {
    fsSync.closeSync(fd);
  }
}
export async function snapshotNativeTree(
  root: string,
  destination?: string,
  paths?: string[],
  signal?: AbortSignal,
): Promise<NativeManifest> {
  root = await fs.realpath(root);
  const manifest: NativeManifest = Object.create(null) as NativeManifest;
  let total = 0;
  let entries = 0;
  async function visit(relative: string) {
    signal?.throwIfAborted();
    if (++entries > MAX_FILES) {
      throw new Error("native workspace exceeds entry limit");
    }
    safeRelative(relative);
    if (PRIVATE.test(relative)) {
      throw new Error(`private output path rejected: ${relative}`);
    }
    const stat = await fs.lstat(path.join(root, relative));
    if (stat.isDirectory()) {
      if (paths) {
        throw new Error(`tracked directories/submodules are not supported: ${relative}`);
      }
      for (const child of (await fs.readdir(path.join(root, relative))).toSorted()) {
        await visit(path.posix.join(relative, child));
      }
      return;
    }
    const file = await readNativeFile(root, relative);
    total += file.data.length;
    if (total > MAX_TOTAL || Object.keys(manifest).length >= MAX_FILES) {
      throw new Error("native workspace exceeds artifact limits");
    }
    manifest[relative] = {
      sha256: createHash("sha256").update(file.data).digest("hex"),
      mode: file.mode,
      bytes: file.data.length,
    };
    if (destination) {
      const output = path.join(destination, relative);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await fs.writeFile(output, file.data, { flag: "wx", mode: file.mode });
    }
  }
  const names = paths ?? (await fs.readdir(root)).toSorted();
  for (const name of names) {
    await visit(name);
  }
  return manifest;
}
export function nativeManifestDigest(manifest: NativeManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(manifest).toSorted(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
}
export async function inspectNativeSource(
  cwd: string,
  authorizedWorkspaceDir: string,
  signal?: AbortSignal,
): Promise<NativeSource> {
  signal?.throwIfAborted();
  const root = await fs.realpath(cwd);
  const authorized = await fs.realpath(authorizedWorkspaceDir);
  const gitRoot = (await nativeGit(root, ["rev-parse", "--show-toplevel"], signal)).trim();
  if (root !== (await fs.realpath(gitRoot))) {
    throw new Error("native coding cwd must be a repository root");
  }
  const commonDir = await fs.realpath(
    path.resolve(root, (await nativeGit(root, ["rev-parse", "--git-common-dir"], signal)).trim()),
  );
  const allowedCommon = await fs.realpath(
    path.resolve(
      authorized,
      (await nativeGit(authorized, ["rev-parse", "--git-common-dir"], signal)).trim(),
    ),
  );
  if (commonDir !== allowedCommon) {
    throw new Error("native coding cwd is outside the authorized repository");
  }
  const worktrees = await nativeGit(authorized, ["worktree", "list", "--porcelain"], signal);
  if (root !== authorized && !worktrees.split("\n").includes(`worktree ${root}`)) {
    throw new Error("cwd is not an authorized linked worktree");
  }
  const branch = (await nativeGit(root, ["symbolic-ref", "--short", "HEAD"], signal)).trim();
  let defaultBranch = "main";
  try {
    defaultBranch = (
      await nativeGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], signal)
    )
      .trim()
      .replace(/^origin\//, "");
  } catch {
    signal?.throwIfAborted();
    /* main/master remain blocked without remote metadata. */
  }
  if (["main", "master", defaultBranch].includes(branch)) {
    throw new Error("native coding requires a non-default feature branch");
  }
  if ((await nativeGit(root, ["status", "--porcelain"], signal)).trim()) {
    throw new Error("native coding requires a clean source worktree");
  }
  const tracked = (await nativeGit(root, ["ls-files", "-z"], signal)).split("\0").filter(Boolean);
  const manifest = await snapshotNativeTree(root, undefined, tracked, signal);
  return {
    root,
    branch,
    commonDir,
    head: (await nativeGit(root, ["rev-parse", "HEAD"], signal)).trim(),
    manifest,
  };
}
export async function nativeSourceUnchanged(source: NativeSource): Promise<boolean> {
  try {
    const latest = await inspectNativeSource(source.root, source.root, AbortSignal.timeout(5_000));
    return (
      latest.head === source.head &&
      latest.branch === source.branch &&
      nativeManifestDigest(latest.manifest) === nativeManifestDigest(source.manifest)
    );
  } catch {
    return false;
  }
}
