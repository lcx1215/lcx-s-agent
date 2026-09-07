import { describe, expect, it } from "vitest";
import { buildEchoApiCliArgs, validateEchoApiCiUrl } from "./echoapi-cli-runner.js";

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
      "--out-dir",
      "/tmp/lcx-echoapi",
      "--out-file",
      "lcx-echoapi",
    ]);
    expect(args).not.toContain("--web-hook");
    expect(args.join(" ")).not.toContain("$");
  });
});
