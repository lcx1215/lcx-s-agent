import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalVisionVlm } from "./local-vision-vlm.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function fixture(mode: "timeout" | "abort" | "overflow" | "success") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-vision-process-test-"));
  directories.push(directory);
  const marker = path.join(directory, "process.json");
  const executable = path.join(directory, "offline-runtime");
  await fs.writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
process.stdout.on('error', () => {});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}));
if (${JSON.stringify(mode)} === 'success') {
  console.log('Synthetic image observation.');
} else {
  setInterval(() => {}, 1000);
  if (${JSON.stringify(mode)} === 'overflow') process.stdout.write('x'.repeat(3 * 1024 * 1024));
}
`,
    { mode: 0o700 },
  );
  return {
    executable,
    async process() {
      return JSON.parse(await fs.readFile(marker, "utf8")) as { pid: number; cwd: string };
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

describe.skipIf(process.platform === "win32")("local vision process recovery", () => {
  it("does not launch a process for an already cancelled request", async () => {
    const runtime = await fixture("success");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runLocalVisionVlm({
        images: [{ base64: "YQ==", mimeType: "image/png" }],
        prompt: "Describe the synthetic input.",
        pythonPath: runtime.executable,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(runtime.process()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["timeout", "abort", "overflow"] as const)(
    "reaps a SIGTERM-resistant child after %s and permits the next call",
    async (mode) => {
      const runtime = await fixture(mode);
      const controller = new AbortController();
      const invocation = runLocalVisionVlm({
        images: [{ base64: "YQ==", mimeType: "image/png" }],
        prompt: "Describe the synthetic input.",
        pythonPath: runtime.executable,
        timeoutMs: mode === "timeout" ? 6000 : 20_000,
        signal: controller.signal,
      }).then(
        () => "unexpected_success" as const,
        () => "rejected" as const,
      );
      let child: { pid: number; cwd: string } | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await vi.waitFor(
          async () => {
            child = await runtime.process();
          },
          { timeout: 5000 },
        );
        if (mode === "abort") {
          controller.abort();
        }
        const outcome = await Promise.race([
          invocation,
          new Promise<"stalled">((resolve) => {
            deadline = setTimeout(() => resolve("stalled"), mode === "timeout" ? 8000 : 2500);
          }),
        ]);
        expect(outcome).toBe("rejected");
        expect(alive(child!.pid)).toBe(false);
        await expect(fs.stat(child!.cwd)).rejects.toMatchObject({ code: "ENOENT" });

        const nextRuntime = await fixture("success");
        await expect(
          runLocalVisionVlm({
            images: [{ base64: "YQ==", mimeType: "image/png" }],
            prompt: "Describe the synthetic input.",
            pythonPath: nextRuntime.executable,
            timeoutMs: 2000,
          }),
        ).resolves.toMatchObject({ text: "Synthetic image observation." });
      } finally {
        if (deadline) {
          clearTimeout(deadline);
        }
        // Only reap the synthetic child created by this fixture, including on a red baseline.
        if (!child) {
          await vi
            .waitFor(
              async () => {
                child = await runtime.process();
              },
              { timeout: 5000 },
            )
            .catch(() => undefined);
        }
        if (child && alive(child.pid)) {
          process.kill(child.pid, "SIGKILL");
        }
        await invocation;
      }
    },
  );
});
