import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResearchDataAutopilotTool } from "./research-data-autopilot-tool.js";

const roots: string[] = [];
const network = vi.fn(async () => {
  throw new Error("offline receipt test");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(network).not.toHaveBeenCalled();
  network.mockClear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-autopilot-receipt-"));
  roots.push(root);
  return {
    root,
    directory: path.join(root, "memory", "research-data-autopilot"),
    tool: createResearchDataAutopilotTool({ workspaceDir: root, fetchImpl: network }),
  };
}
const request = {
  intent: "quote",
  target: "AAPL",
  liveFetch: false,
  writeReceipt: true,
  asOf: "2026-09-07T12:00:00.000Z",
};

describe("autopilot receipt publication and caller cancellation", () => {
  it("rejects a cancelled request before inspecting source health", async () => {
    const { tool } = await fixture();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    const reads = vi.spyOn(fs, "readdir");
    await expect(
      tool.execute("cancelled", { intent: "source_health", target: "all" }, controller.signal),
    ).rejects.toBe(reason);
    expect(reads).not.toHaveBeenCalled();
  });

  it("does not publish when cancellation arrives during directory creation", async () => {
    const { tool, directory } = await fixture();
    const controller = new AbortController();
    const reason = new Error("cancel during mkdir");
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementationOnce(async (target, options) => {
      const result = await mkdir(target, options);
      controller.abort(reason);
      return result;
    });
    await expect(tool.execute("mkdir-cancel", request, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("does not publish when cancellation arrives during the receipt write", async () => {
    const { tool, directory } = await fixture();
    const controller = new AbortController();
    const reason = new Error("cancel during write");
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
      await write(...args);
      controller.abort(reason);
    });
    await expect(tool.execute("write-cancel", request, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("retains a committed receipt but does not report success if cancellation races publication", async () => {
    const { tool, directory } = await fixture();
    const controller = new AbortController();
    const reason = new Error("cancel during rename");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
      await rename(...args);
      controller.abort(reason);
    });
    await expect(tool.execute("rename-cancel", request, controller.signal)).rejects.toBe(reason);
    const files = await fs.readdir(directory);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await fs.readFile(path.join(directory, files[0]), "utf8"));
    expect(saved).toMatchObject({ target: request.target, result: { noNetworkCalled: true } });
  });

  it("keeps partial failed writes out of the published JSON receipts", async () => {
    const { tool, directory } = await fixture();
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
      await write(file, '{"partial":');
      throw new Error("synthetic disk write failure");
    });
    await expect(tool.execute("write-failed", request)).rejects.toThrow(
      "synthetic disk write failure",
    );
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("preserves both receipts for concurrent same-target calls in the same millisecond", async () => {
    const { root, tool, directory } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T15:00:00.000Z"));
    const results = await Promise.all([
      tool.execute("one", request),
      tool.execute("two", { ...request, asOf: "2026-09-07T13:00:00.000Z" }),
    ]);
    const paths = results.map((result) => (result.details as { receiptPath: string }).receiptPath);
    expect(new Set(paths).size).toBe(2);
    expect(await fs.readdir(directory)).toHaveLength(2);
    const saved = await Promise.all(
      paths.map(async (file) => JSON.parse(await fs.readFile(path.join(root, file), "utf8"))),
    );
    expect(
      saved
        .map((value) => value.result.request.asOf)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
    ).toEqual([request.asOf, "2026-09-07T13:00:00.000Z"]);
  });

  it("keeps a long target in the receipt without exceeding the filesystem name limit", async () => {
    const { root, tool } = await fixture();
    const target = "long-address-".repeat(40);
    const result = await tool.execute("long-target", { ...request, intent: "geocode", target });
    const file = (result.details as { receiptPath: string }).receiptPath;
    expect(Buffer.byteLength(path.basename(file))).toBeLessThanOrEqual(255);
    expect(JSON.parse(await fs.readFile(path.join(root, file), "utf8")).target).toBe(target);
  });
});
