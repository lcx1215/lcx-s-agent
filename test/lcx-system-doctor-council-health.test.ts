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
const evaluateFailureReason = (
  latest: { status: string; roles: unknown[] } | undefined,
  unconfirmedRoles: string[],
) =>
  vm.runInNewContext(`${pure}\nlatestLearningCouncilFailureReason(latest, unconfirmedRoles)`, {
    latest,
    unconfirmedRoles,
  }) as string | undefined;

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
  it("explains missing recent evidence without undefined status placeholders", () => {
    const reason = evaluateFailureReason(undefined, []);
    expect(reason).toContain("no learning-council artifact in the 7-day evidence window");
    expect(reason).toContain("provider health is unconfirmed");
    expect(reason).not.toContain("undefined");
  });
  it("distinguishes missing role evidence from unconfirmed provider roles", () => {
    expect(evaluateFailureReason({ status: "unknown", roles: [] }, [])).toContain(
      "unconfirmedModelRoles=no_role_evidence",
    );
    expect(
      evaluateFailureReason({ status: "degraded", roles: [{ role: "kimi" }] }, ["kimi"]),
    ).toContain("unconfirmedModelRoles=kimi");
  });
});
