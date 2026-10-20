import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { createResearchWebAutopilotTool } from "./research-web-autopilot-tool.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});
function fixtureTool(execute: AnyAgentTool["execute"]): AnyAgentTool {
  return { name: "offline", label: "offline", description: "fixture", parameters: {}, execute };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-web-receipt-"));
  roots.push(root);
  const tool = createResearchWebAutopilotTool({
    workspaceDir: root,
    searchTool: fixtureTool(async () =>
      jsonResult({ results: [{ url: "https://www.sec.gov/fixture" }] }),
    ),
    fetchTool: fixtureTool(async () =>
      jsonResult({
        finalUrl: "https://www.sec.gov/fixture",
        status: 200,
        text: "offline source body",
      }),
    ),
  });
  return { root, directory: path.join(root, "memory", "web-research-autopilot"), tool };
}
const request = { query: "same query", openTop: 1, writeReceipt: true };

describe("web evidence receipt publication", () => {
  it("does not publish after cancellation during directory creation", async () => {
    const { tool, directory } = await fixture();
    const controller = new AbortController();
    const reason = new Error("mkdir expired");
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementationOnce(async (target, options) => {
      const result = await mkdir(target, options);
      controller.abort(reason);
      return result;
    });
    await expect(tool.execute("mkdir", request, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("does not publish after cancellation during the receipt write", async () => {
    const { tool, directory } = await fixture();
    const controller = new AbortController();
    const reason = new Error("write expired");
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
      await write(...args);
      controller.abort(reason);
    });
    await expect(tool.execute("write", request, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("keeps a committed receipt but rejects success when cancellation races rename", async () => {
    const { tool, directory } = await fixture();
    const controller = new AbortController();
    const reason = new Error("rename expired");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
      await rename(...args);
      controller.abort(reason);
    });
    await expect(tool.execute("rename", request, controller.signal)).rejects.toBe(reason);
    const files = await fs.readdir(directory);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(directory, files[0]), "utf8"))).toMatchObject({
      query: request.query,
      status: "ready",
    });
  });

  it("keeps a failed partial write unpublished and allows the next request to recover", async () => {
    const { tool, directory, root } = await fixture();
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
      await write(file, '{"partial":');
      throw new Error("fixture disk failure");
    });
    await expect(tool.execute("failure", request)).rejects.toThrow("fixture disk failure");
    expect(await fs.readdir(directory)).toEqual([]);
    const result = await tool.execute("recovery", request);
    const relative = (result.details as { receiptPath: string }).receiptPath;
    expect(JSON.parse(await fs.readFile(path.join(root, relative), "utf8"))).toMatchObject({
      query: request.query,
      openedDocuments: [{ text: "offline source body" }],
    });
    expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it("retains both same-query receipts published concurrently in the same millisecond", async () => {
    const { tool, root, directory } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    const results = await Promise.all([
      tool.execute("one", { ...request, requirePrimary: false }),
      tool.execute("two", { ...request, requirePrimary: true }),
    ]);
    const paths = results.map((result) => (result.details as { receiptPath: string }).receiptPath);
    expect(new Set(paths).size).toBe(2);
    expect(await fs.readdir(directory)).toHaveLength(2);
    const saved = await Promise.all(
      paths.map(async (relative) =>
        JSON.parse(await fs.readFile(path.join(root, relative), "utf8")),
      ),
    );
    expect(new Set(saved.map((receipt) => receipt.crossCheck.requirePrimary))).toEqual(
      new Set([false, true]),
    );
  });

  it("retains the full long query while limiting the file name", async () => {
    const { tool, root } = await fixture();
    const query = "long research query ".repeat(40);
    const result = await tool.execute("long", { ...request, query });
    const relative = (result.details as { receiptPath: string }).receiptPath;
    expect(Buffer.byteLength(path.basename(relative))).toBeLessThanOrEqual(255);
    expect(JSON.parse(await fs.readFile(path.join(root, relative), "utf8")).query).toBe(
      query.trim(),
    );
  });
});
