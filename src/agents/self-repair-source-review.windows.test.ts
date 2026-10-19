import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  return { ...original, default: original.win32 };
});
const files = vi.hoisted(() => ({ readFileWithinRoot: vi.fn() }));
vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  readFileWithinRoot: files.readFileWithinRoot,
}));
import { createHash } from "node:crypto";
import { readSelfRepairMemoryRecall } from "./self-repair-source-review.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
describe("Windows correction recall path contract", () => {
  it("compares a native writer path with its POSIX workspace reference", async () => {
    const workspaceDir = "C:\\fixture\\workspace";
    const relative = "memory/self-repair/correction-downrank/prior.md";
    const scope = { accountId: "fixture", runId: "prior" };
    const previous = JSON.stringify({
      kind: "lcx-self-repair-hands",
      status: "write_completed",
      candidateOnly: true,
      reuseAllowed: false,
      semanticTruth: "not_proven",
      sourceReview: {
        status: "verified_reference_candidate_only",
        scope,
        source: { path: "state/source.json", sha256: sha("source") },
      },
      hands: {
        memoryCleaner: { path: path.join(workspaceDir, relative), correctionMarkdown: "original" },
        patchCandidateBuilder: {
          candidate: { proposedPatchContract: { replacementRule: "rule" } },
        },
      },
    });
    files.readFileWithinRoot
      .mockResolvedValueOnce({ buffer: Buffer.from(previous) })
      .mockResolvedValueOnce({ buffer: Buffer.from("changed body") });
    await expect(
      readSelfRepairMemoryRecall({
        workspaceDir,
        currentScope: { ...scope, runId: "current" },
        expectedMemoryScope: scope,
        artifactStorePath: "C:\\fixture\\artifacts.sqlite",
        replacementRule: "rule",
        request: {
          previousReceipt: { path: "state/prior.json", sha256: sha(previous) },
          correction: { path: relative, sha256: sha("changed body") },
          artifact: { id: "prior", sha256: sha("artifact") },
          from: 1,
          lines: 10,
        },
      }),
    ).rejects.toThrow("self_repair_memory_correction_body_mismatch");
    expect(files.readFileWithinRoot).toHaveBeenLastCalledWith(
      expect.objectContaining({ relativePath: relative }),
    );
  });
});
