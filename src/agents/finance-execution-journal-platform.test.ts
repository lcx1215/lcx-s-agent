import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Exercise only the original persistence helper; no controller, credentials or HTTP imports.
async function journal(platform: string, failure?: "file" | "directory" | "open-directory") {
  const source = await fs.readFile(
    new URL("./finance-execution-safety.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "finance-execution-safety.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const helper = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "appendJournal",
  );
  if (!helper) {
    throw new Error("original journal persistence helper missing");
  }
  const calls: string[] = [];
  const error = new Error("synthetic persistence failure");
  const file = "journal.jsonl";
  const handle = {
    writeFile: vi.fn(async () => {
      calls.push("write");
    }),
    sync: vi.fn(async () => {
      calls.push("file-sync");
      if (failure === "file") {
        throw error;
      }
    }),
    close: vi.fn(async () => {
      calls.push("file-close");
    }),
  };
  const directory = {
    sync: vi.fn(async () => {
      calls.push("directory-sync");
      if (failure === "directory") {
        throw error;
      }
    }),
    close: vi.fn(async () => {
      calls.push("directory-close");
    }),
  };
  const open = vi.fn(async (filename: string) => {
    calls.push(filename === file ? "file-open" : "directory-open");
    if (filename === file) {
      return handle;
    }
    if (failure === "open-directory") {
      throw error;
    }
    return directory;
  });
  const context = vm.createContext({ fs: { open }, path, process: { platform } });
  const js = ts.transpileModule(`${helper.getText(ast)}\nglobalThis.append = appendJournal;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(js, context);
  const append = context.append as (filename: string, claim: object) => Promise<void>;
  return { run: () => append(file, { status: "reserved" }), calls, error, handle, open };
}

it("flushes and closes the Windows journal without opening a directory handle", async () => {
  const f = await journal("win32");
  await f.run();
  expect(f.calls).toEqual(["file-open", "write", "file-sync", "file-close"]);
  expect(f.handle.writeFile).toHaveBeenCalledWith('{"status":"reserved"}\n');
  expect(f.open).toHaveBeenCalledWith("journal.jsonl", "a", 0o600);
});

it.each(["win32", "linux"])("retains a failed %s journal flush", async (platform) => {
  const f = await journal(platform, "file");
  await expect(f.run()).rejects.toBe(f.error);
  expect(f.calls).toEqual(["file-open", "write", "file-sync", "file-close"]);
});

it("retains file-before-directory flush ordering on POSIX", async () => {
  const f = await journal("linux");
  await f.run();
  expect(f.calls).toEqual([
    "file-open",
    "write",
    "file-sync",
    "file-close",
    "directory-open",
    "directory-sync",
    "directory-close",
  ]);
});

it.each(["directory", "open-directory"] as const)("retains POSIX %s failures", async (failure) => {
  const f = await journal("linux", failure);
  await expect(f.run()).rejects.toBe(f.error);
  expect(f.calls).toContain("file-sync");
});
