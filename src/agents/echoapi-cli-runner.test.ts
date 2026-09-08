import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEchoApiCliArgs,
  validateEchoApiCiUrl,
  verifyEchoApiReport,
  runEchoApiCliCase,
} from "./echoapi-cli-runner.js";

describe("EchoAPI CLI runner boundary", () => {
  it("accepts an EchoAPI CI URL and hides its query token from the target receipt shape", () => {
    const url = validateEchoApiCiUrl(
      "https://open.echoapi.com/open/ci/automated_testing?ci_id=public&token=secret",
    );
    expect(url.hostname).toBe("open.echoapi.com");
    expect(url.pathname).toBe("/open/ci/automated_testing");
  });

  it("rejects insecure or unapproved external hosts by default", () => {
    expect(() => validateEchoApiCiUrl("http://open.echoapi.com/ci")).toThrow("HTTPS");
    expect(() => validateEchoApiCiUrl("https://example.com/ci")).toThrow("EchoAPI host");
    expect(() =>
      validateEchoApiCiUrl("https://example.com/ci", { allowExternalHost: true }),
    ).not.toThrow();
  });

  it("builds a real single-iteration CLI invocation without webhooks or shell syntax", () => {
    const args = buildEchoApiCliArgs("https://open.echoapi.com/ci?token=runtime", {
      timeoutMs: 12_345,
      outputDir: "/tmp/lcx-echoapi",
    });
    expect(args).toEqual([
      "run",
      "https://open.echoapi.com/ci?token=runtime",
      "-n",
      "1",
      "-r",
      "json",
      "--timeout-request",
      "12345",
      "--timeout-script",
      "1000",
      "--insecure",
      "0",
      "--out-dir",
      "/tmp/lcx-echoapi",
      "--out-file",
      "lcx-echoapi",
    ]);
    expect(args).not.toContain("--web-hook");
    expect(args.join(" ")).not.toContain("$");
  });
});

describe("EchoAPI actual report verification", () => {
  const counts = { total: 1, success: 1, error: 0 };
  it("requires completed HTTP and assertion successes", () => {
    expect(
      verifyEchoApiReport({ action: "complete", data: { http: counts, assert: counts } }),
    ).toBe(true);
    for (const invalid of [
      null,
      {},
      { action: "complete", data: { http: counts } },
      { action: "complete", data: { http: counts, assert: { total: 0, success: 0, error: 0 } } },
      { action: "complete", data: { http: counts, assert: { total: 1, success: 0, error: 1 } } },
    ]) {
      expect(verifyEchoApiReport(invalid)).toBe(false);
    }
  });
});

it.skipIf(process.platform === "win32")(
  "does not accept a stale report when the CLI exits zero without running a case",
  async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "echoapi-regression-"));
    try {
      const counts = { total: 1, success: 1, error: 0 };
      await writeFile(
        path.join(outputDir, "lcx-echoapi.json"),
        JSON.stringify({ action: "complete", data: { http: counts, assert: counts } }),
      );
      const receipt = await runEchoApiCliCase({
        ciUrl: "https://open.echoapi.com/ci",
        executable: "/usr/bin/true",
        outputDir,
        retainReport: false,
      });
      expect(receipt.passed).toBe(false);
      expect(receipt.reportVerified).toBe(false);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  },
);
