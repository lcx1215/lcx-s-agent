import { afterEach, expect, it, vi } from "vitest";
const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.defineProperty(vi.fn(), promisify.custom, { value: execFileAsync });
  return { ...actual, execFile };
});
import { createCentralToolRegistry } from "./tool-registry.js";
afterEach(() => vi.resetAllMocks());

it("passes cancellation to the actual owner subprocess seam", async () => {
  const controller = new AbortController();
  execFileAsync.mockImplementation(
    (_file: string, _args: readonly string[], options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
  );
  const spec = createCentralToolRegistry().get("problemRadar")!;
  const pending = spec.execute({}, controller.signal);
  expect(execFileAsync).toHaveBeenCalledWith(
    process.execPath,
    expect.any(Array),
    expect.objectContaining({ signal: controller.signal }),
  );
  controller.abort(new Error("owner cancelled"));
  await expect(pending).rejects.toThrow("owner cancelled");
});
