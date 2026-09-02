import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export const GLOBAL_EVIDENCE_PROJECTION_SNAPSHOT_FILENAME =
  "lcx-governance-autopilot-latest.json" as const;

export type CanonicalGlobalEvidenceProjectionCandidate = {
  candidate: unknown;
  sourceOwner: string;
  sourcePath: string;
};

type ReadFile = (filePath: string) => Promise<string>;

function resolveWorkspaceDir(params: {
  workspaceDir?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  const explicitWorkspace = params.workspaceDir?.trim() || env.OPENCLAW_WORKSPACE_DIR?.trim();
  if (explicitWorkspace) {
    return path.resolve(explicitWorkspace);
  }
  const stateDir = params.stateDir?.trim() || resolveStateDir(env);
  return path.join(stateDir, "workspace");
}

export function resolveCanonicalGlobalEvidenceProjectionSnapshotPath(
  params: {
    workspaceDir?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  return path.join(
    resolveWorkspaceDir(params),
    "state",
    GLOBAL_EVIDENCE_PROJECTION_SNAPSHOT_FILENAME,
  );
}

/**
 * Read the canonical, local governance snapshot without assigning it any
 * authority. The reader contract remains responsible for shape and freshness
 * validation; this function only locates and unwraps the shared candidate.
 */
export async function readCanonicalGlobalEvidenceProjectionCandidate(
  params: {
    workspaceDir?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
    readFile?: ReadFile;
  } = {},
): Promise<CanonicalGlobalEvidenceProjectionCandidate | null> {
  const sourcePath = resolveCanonicalGlobalEvidenceProjectionSnapshotPath(params);
  const readFile = params.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"));
  try {
    const raw = await readFile(sourcePath);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const snapshot = parsed as Record<string, unknown>;
    if (!("globalEvidenceProjection" in snapshot)) {
      return null;
    }
    return {
      candidate: snapshot.globalEvidenceProjection,
      sourceOwner: "governance-autopilot",
      sourcePath,
    };
  } catch {
    // Missing, unreadable, or malformed state is a blocked read, not a reason
    // to invent a projection or change the normal message flow.
    return null;
  }
}
