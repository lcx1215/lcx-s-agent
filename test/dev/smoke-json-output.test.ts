import { describe, expect, it } from "vitest";
import { parseJsonObjectFromOutput } from "../../scripts/dev/smoke-json-output.ts";

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
          cases: [{ name: "lark-market-capability-intake" }],
        },
        null,
        2,
      ),
      "warning: trailing tool chatter",
    ].join("\n");

    expect(parseJsonObjectFromOutput(output)).toEqual({
      ok: true,
      nested: { status: "application_ready" },
      cases: [{ name: "lark-market-capability-intake" }],
    });
  });

  it("fails clearly when no JSON object is present", () => {
    expect(() => parseJsonObjectFromOutput("warning only\nno payload")).toThrow(
      /did not contain a JSON object/u,
    );
  });
});
