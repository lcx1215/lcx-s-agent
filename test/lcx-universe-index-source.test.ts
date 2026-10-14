import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { walkArtifacts } from "../scripts/operator/lcx-universe-index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-inventory-source-"));
  roots.push(directory);
  return directory;
}
function denied(code = "EACCES") {
  return Object.assign(new Error(`${code}: offline metadata read failed`), { code });
}

describe("original universe inventory source completeness", () => {
  it("distinguishes a confirmed empty directory from a confirmed missing optional root", async () => {
    const directory = await root();
    expect(await walkArtifacts(directory, Date.now())).toMatchObject({
      exists: true,
      sourceStatus: "complete",
      fileCount: 0,
      readErrors: [],
    });
    expect(await walkArtifacts(path.join(directory, "absent"), Date.now())).toMatchObject({
      exists: false,
      sourceStatus: "missing",
      fileCount: 0,
      readErrors: [],
    });
  });
  it("keeps inaccessible root existence unknown rather than calling it absent", async () => {
    const directory = await root();
    vi.spyOn(fs, "access").mockRejectedValueOnce(denied());
    expect(await walkArtifacts(directory, Date.now())).toMatchObject({
      exists: null,
      sourceStatus: "incomplete",
      fileCount: 0,
      readErrors: [{ path: directory, operation: "access", code: "EACCES" }],
    });
  });
  it("retains readable sibling files and names an unreadable directory", async () => {
    const directory = await root(),
      bad = path.join(directory, "unreadable");
    await fs.mkdir(bad);
    await fs.writeFile(path.join(directory, "good.json"), "{}");
    const native = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === bad) {
        throw denied();
      }
      return native(...args);
    });
    const inventory = await walkArtifacts(directory, Date.now());
    expect(inventory).toMatchObject({
      exists: true,
      sourceStatus: "incomplete",
      fileCount: 1,
      readErrors: [{ path: bad, operation: "readdir", code: "EACCES" }],
    });
    expect(inventory.largestFiles[0].relativePath).toBe("good.json");
  });
  it.each(["EACCES", "ENOENT"])(
    "preserves %s from a file metadata read with partial evidence",
    async (code) => {
      const directory = await root(),
        bad = path.join(directory, "bad.json");
      await fs.writeFile(bad, "{}");
      await fs.writeFile(path.join(directory, "good.json"), "{}");
      const native = fs.stat;
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        if (args[0] === bad) {
          throw denied(code);
        }
        return native(...args);
      });
      expect(await walkArtifacts(directory, Date.now())).toMatchObject({
        exists: true,
        sourceStatus: "incomplete",
        fileCount: 1,
        readErrors: [{ path: bad, operation: "stat", code }],
      });
    },
  );
  it("keeps deliberate exclusions explicit without labelling them read failures", async () => {
    const directory = await root();
    await fs.mkdir(path.join(directory, "dist"));
    await fs.writeFile(path.join(directory, "dist", "ignored.json"), "{}");
    expect(await walkArtifacts(directory, Date.now())).toMatchObject({
      exists: true,
      sourceStatus: "complete",
      skippedDirs: ["dist"],
      readErrors: [],
      fileCount: 0,
    });
  });
  it("delivers original inventory failures in the compact governance projection without running the coordinator", async () => {
    const filename = path.resolve(
      import.meta.dirname,
      "../scripts/operator/lcx-governance-autopilot.ts",
    );
    const raw = await fs.readFile(filename, "utf8");
    const source = ts.createSourceFile(
      filename,
      raw,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const declarations = source.statements
      .filter(
        (statement) =>
          ts.isFunctionDeclaration(statement) &&
          ["recordValue", "compactOwner"].includes(statement.name?.text ?? ""),
      )
      .map((statement) => statement.getFullText(source))
      .join("\n");
    const javascript = ts.transpileModule(declarations, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
    }).outputText;
    const compact = vm.runInNewContext(`${javascript}\ncompactOwner`, {}) as (
      id: string,
      payload: Record<string, unknown>,
    ) => Record<string, unknown>;
    const visibleInventory = {
      ok: false,
      error: "original rg unavailable",
      fallback: "tracked_files_only",
    };
    expect(
      compact("universeIndex", {
        summary: {
          artifactInventoryComplete: false,
          unreadableArtifactAreas: 1,
          artifactReadFailures: 2,
        },
        repo: { visibleInventory },
      }),
    ).toMatchObject({
      artifactInventoryComplete: false,
      unreadableArtifactAreas: 1,
      artifactReadFailures: 2,
      visibleInventory,
    });
  });
});
