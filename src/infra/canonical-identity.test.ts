import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_CLI_NAME,
  CANONICAL_CONFIG_FILENAME,
  CANONICAL_PACKAGE_NAME,
  CANONICAL_PRODUCT_NAME,
  CANONICAL_STATE_DIRNAME,
  LEGACY_CLI_NAME,
  LEGACY_PACKAGE_NAME,
} from "./canonical-identity.js";

describe("canonical LCX identity", () => {
  it("keeps the four approved canonical names in one registry", () => {
    expect({
      product: CANONICAL_PRODUCT_NAME,
      package: CANONICAL_PACKAGE_NAME,
      cli: CANONICAL_CLI_NAME,
      config: CANONICAL_CONFIG_FILENAME,
      stateDir: CANONICAL_STATE_DIRNAME,
    }).toEqual({
      product: "LCX Agent",
      package: "lcx-agent",
      cli: "lcx",
      config: "lcx.json",
      stateDir: ".lcx",
    });
  });

  it("publishes the canonical CLI and retains only a thin legacy wrapper", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      name: string;
      bin: Record<string, string>;
      files: string[];
      exports: Record<string, string>;
    };
    const legacyWrapper = await fs.readFile(path.join(process.cwd(), "openclaw.mjs"), "utf8");

    expect(packageJson.name).toBe(CANONICAL_PACKAGE_NAME);
    expect(packageJson.bin).toMatchObject({
      [CANONICAL_CLI_NAME]: "lcx.mjs",
      [LEGACY_CLI_NAME]: "openclaw.mjs",
    });
    expect(packageJson.files).toEqual(expect.arrayContaining(["lcx.mjs", "openclaw.mjs"]));
    expect(packageJson.exports["./cli-entry"]).toBe("./lcx.mjs");
    expect(packageJson.exports["./legacy-cli-entry"]).toBe("./openclaw.mjs");
    expect(legacyWrapper).toContain('await import("./lcx.mjs");');
    expect(legacyWrapper).not.toContain("dist/entry");
  });

  it("keeps the old package name as an explicit compatibility alias", () => {
    expect(LEGACY_PACKAGE_NAME).toBe("openclaw");
    expect(LEGACY_CLI_NAME).toBe("openclaw");
  });
});
