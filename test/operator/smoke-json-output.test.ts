import { describe, expect, it } from "vitest";
import { parseJsonObjectFromOutput } from "../../scripts/operator/smoke-json-output.ts";

describe("parseJsonObjectFromOutput", () => {
  it("parses a plain JSON object", () => {
    expect(parseJsonObjectFromOutput('{"ok":true,"count":2}\n')).toEqual({
      ok: true,
      count: 2,
    });
  });

  it("parses the last complete JSON object through stdout chatter", () => {
    const output = [
      "> pnpm exec tsx smoke.ts",
      "warning: package manager banner",
      JSON.stringify(
        {
          ok: true,
          nested: { status: "application_ready" },
          cases: [{ name: "external-market-capability-intake" }],
        },
        null,
        2,
      ),
      "warning: trailing tool chatter",
    ].join("\n");

    expect(parseJsonObjectFromOutput(output)).toEqual({
      ok: true,
      nested: { status: "application_ready" },
      cases: [{ name: "external-market-capability-intake" }],
    });
  });

  it("returns the last whole object instead of an inner nested object", () => {
    const output = [
      JSON.stringify({ stale: true }),
      "progress: running",
      JSON.stringify(
        {
          ok: true,
          summary: { passed: 61, total: 68, promotionReady: false },
          failedCaseIds: ["source_gap"],
        },
        null,
        2,
      ),
      "trailing warning with unmatched { brace",
    ].join("\n");

    expect(parseJsonObjectFromOutput(output)).toEqual({
      ok: true,
      summary: { passed: 61, total: 68, promotionReady: false },
      failedCaseIds: ["source_gap"],
    });
  });

  it("handles braces inside strings", () => {
    const output = [
      "debug before",
      JSON.stringify({
        ok: true,
        message: "the model emitted {braces} inside text",
      }),
      "debug after",
    ].join("\n");

    expect(parseJsonObjectFromOutput(output)).toEqual({
      ok: true,
      message: "the model emitted {braces} inside text",
    });
  });

  it("fails clearly when no JSON object is present", () => {
    expect(() => parseJsonObjectFromOutput("warning only\nno payload")).toThrow(
      /did not contain a JSON object/u,
    );
  });
});
