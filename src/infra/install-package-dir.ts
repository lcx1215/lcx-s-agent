import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fileExists } from "./archive.js";
import { assertCanonicalPathWithinBase } from "./install-safe-path.js";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sanitizeManifestForNpmInstall(targetDir: string): Promise<void> {
  const manifestPath = path.join(targetDir, "package.json");
  let manifestRaw = "";
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return;
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestRaw) as unknown;
    if (!isObjectRecord(parsed)) {
      return;
    }
    manifest = parsed;
  } catch {
    return;
  }

  const devDependencies = manifest.devDependencies;
  if (!isObjectRecord(devDependencies)) {
    return;
  }

  const filteredEntries = Object.entries(devDependencies).filter(([, rawSpec]) => {
    const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
    return !spec.startsWith("workspace:");
  });
  if (filteredEntries.length === Object.keys(devDependencies).length) {
    return;
  }

  if (filteredEntries.length === 0) {
    delete manifest.devDependencies;
  } else {
    manifest.devDependencies = Object.fromEntries(filteredEntries);
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

async function assertInstallBoundaryPaths(params: {
  installBaseDir: string;
  candidatePaths: string[];
}): Promise<void> {
  for (const candidatePath of params.candidatePaths) {
    await assertCanonicalPathWithinBase({
      baseDir: params.installBaseDir,
      candidatePath,
      boundaryLabel: "install directory",
    });
  }
}

function errorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err
    ? String((err as NodeJS.ErrnoException).code)
    : "error";
}

/** Keep the original failure first: the rollback problem is context, not the headline. */
function withRollbackProblem(error: string, rollbackProblem: string | null): string {
  return rollbackProblem === null ? error : `${error} (rollback incomplete: ${rollbackProblem})`;
}

export async function installPackageDir(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void };
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: () => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  const installBaseDir = path.dirname(params.targetDir);
  await fs.mkdir(installBaseDir, { recursive: true });
  await assertInstallBoundaryPaths({
    installBaseDir,
    candidatePaths: [params.targetDir],
  });
  let backupDir: string | null = null;
  if (params.mode === "update" && (await fileExists(params.targetDir))) {
    const backupRoot = path.join(path.dirname(params.targetDir), ".openclaw-install-backups");
    backupDir = path.join(backupRoot, `${path.basename(params.targetDir)}-${Date.now()}`);
    await fs.mkdir(backupRoot, { recursive: true });
    await assertInstallBoundaryPaths({
      installBaseDir,
      candidatePaths: [backupDir],
    });
    await fs.rename(params.targetDir, backupDir);
  }

  /**
   * Put the previous install back, and return a description of what could not be put back — or
   * `null` when the previous state is in place again.
   *
   * A rollback that fails is reported rather than swallowed. "the install failed" and "the install
   * failed and your previous install is gone" are different outcomes, and returning only the first
   * leaves a caller believing the package is intact while the target sits half-copied and the
   * backup is stranded beside it.
   */
  const rollback = async (): Promise<string | null> => {
    if (!backupDir) {
      return null;
    }
    await assertInstallBoundaryPaths({
      installBaseDir,
      candidatePaths: [params.targetDir, backupDir],
    });
    const problems: string[] = [];
    try {
      await fs.rm(params.targetDir, { recursive: true, force: true });
    } catch (err) {
      problems.push(`could not clear ${params.targetDir}: ${errorCode(err)}`);
    }
    try {
      await fs.rename(backupDir, params.targetDir);
    } catch (err) {
      problems.push(`could not restore ${backupDir}: ${errorCode(err)}`);
    }
    return problems.length > 0 ? problems.join("; ") : null;
  };

  try {
    await assertInstallBoundaryPaths({
      installBaseDir,
      candidatePaths: [params.targetDir],
    });
    await fs.cp(params.sourceDir, params.targetDir, { recursive: true });
  } catch (err) {
    const rollbackProblem = await rollback();
    return {
      ok: false,
      error: withRollbackProblem(`${params.copyErrorPrefix}: ${String(err)}`, rollbackProblem),
    };
  }

  try {
    await params.afterCopy?.();
  } catch (err) {
    const rollbackProblem = await rollback();
    return {
      ok: false,
      error: withRollbackProblem(`post-copy validation failed: ${String(err)}`, rollbackProblem),
    };
  }

  if (params.hasDeps) {
    await sanitizeManifestForNpmInstall(params.targetDir);
    params.logger?.info?.(params.depsLogMessage);
    const npmRes = await runCommandWithTimeout(
      ["npm", "install", "--omit=dev", "--silent", "--ignore-scripts"],
      {
        timeoutMs: Math.max(params.timeoutMs, 300_000),
        cwd: params.targetDir,
      },
    );
    if (npmRes.code !== 0) {
      const rollbackProblem = await rollback();
      return {
        ok: false,
        error: withRollbackProblem(
          `npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`,
          rollbackProblem,
        ),
      };
    }
  }

  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { ok: true };
}

export async function installPackageDirWithManifestDeps(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void };
  copyErrorPrefix: string;
  depsLogMessage: string;
  manifestDependencies?: Record<string, unknown>;
  afterCopy?: () => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return installPackageDir({
    ...params,
    hasDeps: Object.keys(params.manifestDependencies ?? {}).length > 0,
  });
}
