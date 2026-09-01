import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runFuzzer(args: string[] = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-lark-short-intent-fuzzer.ts", ...args, "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("lcx-lark-short-intent-fuzzer", () => {
  it("proves short Lark canaries are family-generated and not a fixed whitelist", async () => {
    const payload = await runFuzzer();

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_lark_short_intent_fuzzer_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.macroContract).toEqual(
      expect.objectContaining({
        notWhitelist: true,
      }),
    );
    expect(payload.summary).toEqual(
      expect.objectContaining({
        families: 10,
        generated: 70,
        passed: 70,
        failed: 0,
      }),
    );
    expect(payload.perFamily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "short_finance_action_intent", failed: 0 }),
        expect.objectContaining({ id: "short_generic_intro_wrong_route", failed: 0 }),
        expect.objectContaining({ id: "short_data_conflict", failed: 0 }),
        expect.objectContaining({ id: "short_model_disagreement", failed: 0 }),
      ]),
    );
    expect(payload.failedCases).toEqual([]);
    expect(payload.generatedEvalSeeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          familyId: "short_finance_action_intent",
          ask: "能买吗",
        }),
        expect.objectContaining({
          familyId: "short_system_status_claim",
          ask: "状态呢",
        }),
      ]),
    );
  });
});
