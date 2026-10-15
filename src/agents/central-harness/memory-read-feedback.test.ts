import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOriginalMemoryReadFeedback } from "../../../test/fixtures/lcx-waterflow-memory-read-probe.js";
import { createMemoryGetTool } from "../tools/memory-tool.js";
import { verifyCentralEvidenceUse } from "./evidence-use.js";
import { CENTRAL_STEP_OUTCOME_BUDGET_BYTES } from "./harness-loop.js";
import { createCentralToolRegistry } from "./tool-registry.js";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "original-memory-feedback-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("original correction body through the central read-only tool loop", () => {
  it("delivers the natural missing-action gap before an explicit corrected narrow read", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("external calls forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    const result = await probeOriginalMemoryReadFeedback(
      await fixture(),
      "require current source before reuse",
      { omitRecallAction: true },
    );
    const failed = result.receipts[1].steps[0];
    expect(failed.args).not.toHaveProperty("action");
    expect(failed.outcome).toMatchObject({
      available: false,
      gap: "artifact_action_required",
      requiredArgs: ["action"],
    });
    expect(failed.outcome).not.toHaveProperty("selectedValue");
    expect(result.receipts[2].steps[0].args).toEqual({
      action: "read",
      id: result.artifact.id,
      field: result.field,
    });
    expect(result.selectedText).toBe(result.originalText);
    expect(result.judgment?.[0]).toMatchObject({
      effect: "change",
      verification: "reference_verified",
    });
    expect(result.receipts[3].steps).toEqual([]);
    expect(result.sourceUnchanged).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("changes the scripted subsequent judgment when the original correction content changes", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("external calls forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    const results = [];
    for (const rule of ["retain scoped provenance check", "require current source before reuse"]) {
      results.push(await probeOriginalMemoryReadFeedback(await fixture(), rule));
    }
    for (const result of results) {
      expect(result.receipts[0].steps[0].status).toBe("ran_ok");
      expect(result.selectedText).toBe(result.originalText);
      expect(result.judgment?.[0].verification).toBe("reference_verified");
      expect(result.sourceUnchanged).toBe(true);
      expect(result.missing).toMatchObject({ missing: true, text: "" });
      expect(result.receipts[2].steps).toEqual([]);
      expect(result.receipts.every((receipt) => !receipt.liveTouched)).toBe(true);
      expect(result.receipts.every((receipt) => receipt.brainCall.modelCall === undefined)).toBe(
        true,
      );
      for (const receipt of result.receipts) {
        for (const step of receipt.steps) {
          expect(Buffer.byteLength(JSON.stringify(step.outcome))).toBeLessThanOrEqual(
            step.ownerId === "artifact_memory_recall" ? 4096 : CENTRAL_STEP_OUTCOME_BUDGET_BYTES,
          );
        }
      }
      const use = result.judgment![0];
      const input = result.perceptions[2];
      expect(
        verifyCentralEvidenceUse([{ ...use, sourceSha256: "0".repeat(64) }], input)[0],
      ).toMatchObject({ verification: "invalid_reference" });
      expect(
        verifyCentralEvidenceUse([{ ...use, scope: { accountId: "different-account" } }], input)[0],
      ).toMatchObject({ verification: "invalid_reference", gap: "source_scope_mismatch" });
      expect(verifyCentralEvidenceUse([use], { ...input, backlog: [] })[0]).toMatchObject({
        verification: "invalid_reference",
        gap: "matching_read_not_delivered",
      });
    }
    expect(results.map((result) => result.judgment![0].effect)).toEqual(["retain", "change"]);
    expect(results[0].receipts[2].brainCall.note).not.toBe(results[1].receipts[2].brainCall.note);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses missing host scope, disabled recall, model roots and unbounded reads", async () => {
    const workspaceDir = await fixture();
    const config = { agents: { defaults: { workspace: workspaceDir } } };
    const reader = createCentralToolRegistry({ workspaceDir, config }).get("memory_get")!;
    expect(reader.approve({ path: "memory/a.md", from: 1, lines: 80 }).ok).toBe(true);
    for (const args of [
      { path: "../memory/a.md" },
      { path: "/memory/a.md" },
      { path: "memory/../MEMORY.md" },
      { path: "state/a.md" },
      { path: "memory/a.json" },
      { path: "memory/a.md", directory: workspaceDir },
      { path: "memory/a.md", write: false },
      { path: "memory/a.md", lines: 81 },
      { path: "memory/a.md", lines: 1.5 },
      { path: "memory/a.md", from: 0 },
    ]) {
      expect(reader.approve(args).ok).toBe(false);
    }
    expect(createCentralToolRegistry().get("memory_get")!.approve({ path: "MEMORY.md" }).ok).toBe(
      false,
    );
    expect(
      createCentralToolRegistry({
        workspaceDir,
        config: { agents: { defaults: { memorySearch: { enabled: false } } } },
      })
        .get("memory_get")!
        .approve({ path: "MEMORY.md" }).ok,
    ).toBe(false);
    expect(reader.allowedSideEffects).toEqual(["local_read"]);
    expect(createCentralToolRegistry({ workspaceDir, config }).has("selfRepairHands")).toBe(false);
    expect(createCentralToolRegistry({ workspaceDir, config }).has("memory_search")).toBe(false);
  });

  it("uses the host workspace and rejects ancestor aliases without initializing the memory manager", async () => {
    const workspaceDir = await fixture();
    const other = await fixture();
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.mkdir(path.join(other, "memory"));
    await fs.writeFile(path.join(workspaceDir, "memory", "a.md"), "host-rule\nsecond-line");
    await fs.writeFile(path.join(other, "memory", "a.md"), "other-workspace-rule");
    await fs.symlink(path.join(other, "memory"), path.join(workspaceDir, "memory", "alias"));
    const config = {
      agents: {
        defaults: {
          workspace: other,
          memorySearch: { store: { path: path.join(other, "must-not-open.sqlite") } },
        },
      },
    };
    const tool = createMemoryGetTool({ config, readOnlyWorkspaceDir: workspaceDir })!;
    expect(
      (await tool.execute("read", { path: "memory/a.md", from: 2, lines: 1 })).details,
    ).toEqual({ text: "second-line", path: "memory/a.md" });
    expect((await tool.execute("alias", { path: "memory/alias/a.md" })).details).toMatchObject({
      disabled: true,
      text: "",
    });
    await expect(fs.stat(path.join(other, "must-not-open.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
