import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function exampleLine(): string {
  return JSON.stringify({
    prompt: "You are the LCX Agent local auxiliary thought-flow router.",
    completion: JSON.stringify({
      task_family: "health_digest",
      primary_modules: ["agent_brain_eval"],
      supporting_modules: ["baseline_hardening"],
      required_tools: ["local_filesystem"],
      missing_data: [],
      risk_boundaries: ["research_only", "no_execution_authority"],
      next_step: "continue_health_digest",
      rejected_context: ["old_lark_conversation_history"],
    }),
    meta: { sourcePath: "test.json", sourceKind: "curated_seed" },
  });
}

async function writeValidSplits(dataDir: string): Promise<void> {
  const line = exampleLine();
  await fs.writeFile(path.join(dataDir, "train.jsonl"), `${line}\n`, "utf8");
  await fs.writeFile(path.join(dataDir, "valid.jsonl"), `${line}\n`, "utf8");
  await fs.writeFile(path.join(dataDir, "test.jsonl"), `${line}\n`, "utf8");
}

describe("local brain distill smoke", () => {
  it("retries transient partial JSONL reads from an in-progress dataset write", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-brain-smoke-"));
    await fs.mkdir(dataDir, { recursive: true });
    await writeValidSplits(dataDir);
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      '{"prompt":"You are the LCX Agent local auxiliary tho\n',
      "utf8",
    );

    const run = execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-smoke.ts",
        "--data",
        dataDir,
        "--min-train",
        "1",
        "--json",
      ],
      { cwd: path.resolve(import.meta.dirname, "..") },
    );

    await sleep(50);
    await writeValidSplits(dataDir);

    const { stdout } = await run;
    const result = JSON.parse(stdout) as { ok: boolean; counts: { train: number } };

    expect(result.ok).toBe(true);
    expect(result.counts.train).toBe(1);
  });
});
