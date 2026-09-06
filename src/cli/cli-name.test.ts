import { describe, expect, it } from "vitest";
import { replaceCliName, resolveCliName } from "./cli-name.js";

describe("CLI identity", () => {
  it.each([
    ["lcx", "lcx"],
    ["lcx.mjs", "lcx"],
    ["/tmp/bin/lcx", "lcx"],
    ["openclaw", "openclaw"],
    ["openclaw.mjs", "openclaw"],
    ["/tmp/bin/openclaw", "openclaw"],
    ["vitest", "lcx"],
  ])("resolves %s as %s", (argv1, expected) => {
    expect(resolveCliName(["node", argv1])).toBe(expected);
  });

  it("rewrites legacy command examples to the invoked canonical CLI", () => {
    expect(replaceCliName("openclaw doctor", "lcx")).toBe("lcx doctor");
    expect(replaceCliName("pnpm openclaw status", "lcx")).toBe("pnpm lcx status");
    expect(replaceCliName("lcx doctor", "openclaw")).toBe("openclaw doctor");
  });
});
