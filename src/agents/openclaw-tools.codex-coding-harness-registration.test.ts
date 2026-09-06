import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools Codex coding harness registration", () => {
  it("exposes a guarded Codex coding tool through the normal tool seam", () => {
    const tool = createOpenClawTools({ workspaceDir: "/tmp/lcx-coding-worktree" }).find(
      (candidate) => candidate.name === "codex_coding_harness",
    );

    expect(tool).toBeDefined();
    expect(tool?.ownerOnly).toBe(true);
    expect(tool?.description).toMatch(/ACP/);
  });
});
