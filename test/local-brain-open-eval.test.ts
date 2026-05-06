import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("local-brain-open-eval", () => {
  it("runs the provider command without a shell", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-open-eval.ts",
        "--json",
        "--provider-command",
        "node --import tsx test/fixtures/local-brain-open-eval-provider.ts",
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );

    const result = JSON.parse(stdout) as {
      ok: boolean;
      summary: { passed: number; total: number; failedCaseIds: string[] };
    };
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ passed: 5, total: 5, failedCaseIds: [] });
  });

  it("rejects shell metacharacters in provider commands", async () => {
    const marker = path.join(os.tmpdir(), `openclaw-local-brain-open-eval-injection-${Date.now()}`);
    await rm(marker, { force: true });

    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/dev/local-brain-open-eval.ts",
          "--json",
          "--provider-command",
          `node --import tsx test/fixtures/local-brain-open-eval-provider.ts; touch ${marker}`,
        ],
        { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("unsupported shell metacharacters"),
    });
    await expect(access(marker)).rejects.toThrow();
  });
});
