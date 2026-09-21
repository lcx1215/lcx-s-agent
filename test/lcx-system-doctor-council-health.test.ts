import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Evaluate only the pure parser/counter slice: importing the operator would run diagnostics.
const source = fs.readFileSync(
  new URL("../scripts/operator/lcx-system-doctor.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("type CouncilRoleSummary =");
const end = source.indexOf("async function modelCouncilProviderEvidenceCheck", start);
const pure = stripTypeScriptTypes(source.slice(start, end));
const evaluate = (roles: unknown[]) =>
  vm.runInNewContext(`${pure}\nsummarizeCouncilHealth(summarizeCouncilRoles({roles: input}))`, {
    input: roles,
  }) as {
    roleSuccesses: Record<string, number>;
    roleFailures: Record<string, number>;
    roleHealthSuccesses: Record<string, number>;
    roleHealthUnconfirmed: Record<string, number>;
  };

describe("doctor separates usable output from requested-model evidence", () => {
  it("keeps legacy and fallback successes unconfirmed", () => {
    const result = evaluate([
      { role: "kimi", model: "moonshot/kimi", success: true },
      {
        role: "deepseek",
        model: "deepseek/model",
        success: true,
        requestedModelHealth: "mismatched",
        actualProvider: "fallback",
        actualModel: "model",
      },
    ]);
    expect(result.roleSuccesses).toEqual({ kimi: 1, deepseek: 1 });
    expect(result.roleHealthSuccesses).toEqual({});
    expect(result.roleHealthUnconfirmed).toEqual({ kimi: 1, deepseek: 1 });
  });
  it("requires healthy status, successful output and matching runtime identity", () => {
    const valid = {
      role: "kimi",
      model: "moonshot/kimi",
      success: true,
      requestedModelHealth: "healthy",
      actualProvider: "moonshot",
      actualModel: "kimi",
    };
    const result = evaluate([
      valid,
      { ...valid, actualModel: "other" },
      { ...valid, success: false },
      { ...valid, actualProvider: undefined },
    ]);
    expect(result.roleHealthSuccesses).toEqual({ kimi: 1 });
    expect(result.roleHealthUnconfirmed).toEqual({ kimi: 3 });
  });
});
