import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildProblemClusterRadar,
  type OwnerSnapshot,
} from "../../scripts/operator/lcx-problem-cluster-radar.ts";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
/** Only the original pure static radar CLI. Never starts a governance owner stack. */
export async function probeOriginalUpgradeRadar(options: { timeoutMs?: number } = {}) {
  const command = "node --import tsx scripts/operator/lcx-external-agent-upgrade-radar.ts --json";
  let owner: OwnerSnapshot;
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/operator/lcx-external-agent-upgrade-radar.ts", "--json"],
      { cwd: repoRoot, timeout: options.timeoutMs ?? 5_000, maxBuffer: 2 * 1024 * 1024 },
    );
    owner = {
      owner: "lcx-external-agent-upgrade-radar",
      command,
      ok: true,
      payload: JSON.parse(result.stdout) as Record<string, unknown>,
    };
  } catch (error) {
    const failure = error as Error & { killed?: boolean; signal?: string };
    owner = {
      owner: "lcx-external-agent-upgrade-radar",
      command,
      ok: false,
      error: `${failure.killed ? "native_radar_process_timeout:" : "native_radar_process_failed:"}${failure.signal ?? failure.message}`,
    };
  }
  const consumerInput = { externalAgentUpgrade: structuredClone(owner) };
  // Real original consumer; it checks registry/authority drift, not source/license/semantic use.
  const consumer = buildProblemClusterRadar(consumerInput);
  return { owner, consumerInput, consumer };
}
