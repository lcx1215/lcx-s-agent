/**
 * Compatibility entrypoint for the pre-normalization binding filename.
 * New callers must use lcx-external-channel-legacy-binding.ts.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const target = path.join(import.meta.dirname, "lcx-external-channel-legacy-binding.ts");
const result = spawnSync(process.execPath, ["--import", "tsx", target, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
