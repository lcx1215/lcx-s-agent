import fs from "node:fs";
import path from "node:path";

/**
 * Atomic JSON write for Zalouser state files.
 *
 * `writeFileSync` truncates before it writes, so a crash or ENOSPC part way through leaves a
 * half-written file behind — and the credentials written here are the only copy. Renaming is
 * atomic: a reader sees either the old file or the new one, never a partial one.
 *
 * This mirrors `saveJsonFile` in `src/infra/json-file.ts`. It is duplicated rather than imported
 * because the `lcx-agent` package does not export that primitive, and an extension cannot reach
 * into the host's `src`. If the host ever exports it, delete this file and use that one.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, payload, "utf-8");
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // the temp file never made it; nothing to clean up
    }
    throw err;
  }
}
