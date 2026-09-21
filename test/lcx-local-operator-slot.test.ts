import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_OPERATOR_LATEST_BASENAME,
  LOCAL_OPERATOR_LATEST_PATH,
  localOperatorLatestPathForWorkspace,
  resolveLocalOperatorLatestPath,
} from "../scripts/operator/lcx-local-paths.ts";

// The snapshot describes one checkout's workflow surface. It used to live in a
// single global path shared by every worktree, so two windows overwrote each
// other's evidence and each was judged by the other's flow graph - a mismatch
// neither side could ever clear. The slot is per-workspace now.
const workspaces: string[] = [];

function makeWorkspace(withSnapshot: boolean): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "lcx-operator-slot-"));
  workspaces.push(dir);
  if (withSnapshot) {
    const stateDir = path.join(dir, "state");
    fsSync.mkdirSync(stateDir, { recursive: true });
    fsSync.writeFileSync(
      path.join(stateDir, LOCAL_OPERATOR_LATEST_BASENAME),
      `${JSON.stringify({ checkedAt: new Date().toISOString(), ok: true }, null, 2)}\n`,
      "utf8",
    );
  }
  return dir;
}

describe("local operator latest slot", () => {
  afterEach(() => {
    while (workspaces.length > 0) {
      const dir = workspaces.pop();
      if (dir) {
        fsSync.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("puts the workspace copy in that workspace's state dir", () => {
    const workspace = makeWorkspace(false);
    expect(localOperatorLatestPathForWorkspace(workspace)).toBe(
      path.join(workspace, "state", LOCAL_OPERATOR_LATEST_BASENAME),
    );
  });

  it("prefers the workspace snapshot over the shared global path", () => {
    const workspace = makeWorkspace(true);
    expect(resolveLocalOperatorLatestPath(workspace)).toBe(
      localOperatorLatestPathForWorkspace(workspace),
    );
    expect(resolveLocalOperatorLatestPath(workspace)).not.toBe(LOCAL_OPERATOR_LATEST_PATH);
  });

  it("falls back to the global path only when the workspace has no snapshot", () => {
    const workspace = makeWorkspace(false);
    expect(resolveLocalOperatorLatestPath(workspace)).toBe(LOCAL_OPERATOR_LATEST_PATH);
  });

  it("resolves two worktrees to two different slots", () => {
    const left = makeWorkspace(true);
    const right = makeWorkspace(true);
    expect(resolveLocalOperatorLatestPath(left)).not.toBe(resolveLocalOperatorLatestPath(right));
  });
});
