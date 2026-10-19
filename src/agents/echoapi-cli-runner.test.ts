import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEchoApiCliArgs,
  redactEchoApiText,
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

  it("redacts CI query credentials from retained CLI diagnostics", () => {
    const sensitiveUrl =
      "https://open.echoapi.com/open/ci/automated_testing?ci_id=public&token=secret";
    const redacted = redactEchoApiText(
      `request failed ${sensitiveUrl}; token=secret; authorization: Bearer secret`,
      sensitiveUrl,
    );
    expect(redacted).not.toContain("secret");
    expect(redacted).toContain("[REDACTED_QUERY]");
  });
});

describe("EchoAPI known CI credential value redaction", () => {
  it.each([
    {
      url: "https://open.echoapi.com/ci?signature=fixture-query-value",
      value: "fixture-query-value",
    },
    {
      url: "https://open.echoapi.com/ci?signature=fixture%20query%2Fvalue",
      value: "fixture query/value",
    },
    {
      url: "https://open.echoapi.com/ci?signature=fixture%20query%2Fvalue",
      value: "fixture%20query%2Fvalue",
    },
    { url: "https://open.echoapi.com/ci?signature=fixture%20query", value: "fixture+query" },
    { url: "https://open.echoapi.com/ci?signature=fixture%2fquery", value: "fixture%2Fquery" },
    { url: "https://fixture-user:fixture-password@open.echoapi.com/ci", value: "fixture-password" },
    { url: "https://fixture-user:fixture-password@open.echoapi.com/ci", value: "fixture-user" },
    {
      url: "https://open.echoapi.com/ci?signature=https%3A%2F%2Fsecret.example%2Fprivate%3Fsig%3Dfixture",
      value: "https://secret.example/private?sig=fixture",
    },
  ])("removes separately echoed credential value $value", ({ url, value }) => {
    const output = redactEchoApiText(`CLI rejected supplied value [${value}]; status 401`, url);
    expect(output).not.toContain(value);
    expect(output).toContain("status 401");
    expect(output).toBe("CLI rejected supplied value [[REDACTED]]; status 401");
  });

  it("treats query values literally and redacts longer overlapping values first", () => {
    const url =
      "https://open.echoapi.com/ci?secret=fixture&token=fixture-long&signature=literal%2B%5Bvalue%5D.*";
    const output = redactEchoApiText("fixture-long literal+[value].*; unrelated diagnostic", url);
    expect(output).toBe("[REDACTED] [REDACTED]; unrelated diagnostic");
  });

  it.each(["1", "public", "public-reference"])(
    "keeps unrelated diagnostics for a common query identifier %s",
    (value) => {
      const url = `https://open.echoapi.com/ci?ci_id=${value}&token=fixture-credential`;
      const output = redactEchoApiText(
        `HTTP status 401; public endpoint; ${value} diagnostic; ci_id=${value}; supplied value [${value}]; token=fixture-credential`,
        url,
      );
      expect(output).toBe(
        `HTTP status 401; public endpoint; ${value} diagnostic; ci_id=[REDACTED]; supplied value [[REDACTED]]; token=[REDACTED]`,
      );
    },
  );

  it.each(["auth", "authToken", "auth_token", "auth-token"])(
    "redacts a separately echoed auth credential from %s",
    (key) => {
      expect(
        redactEchoApiText(
          "authentication failed for fixture-auth-value; status 401",
          `https://open.echoapi.com/ci?${key}=fixture-auth-value`,
        ),
      ).toBe("authentication failed for [REDACTED]; status 401");
    },
  );

  it("redacts a query identifier after a JSON property separator", () => {
    expect(
      redactEchoApiText(
        '{"error":"invalid","ci_id":"private-project"}',
        "https://open.echoapi.com/ci?ci_id=private-project",
      ),
    ).toBe('{"error":"invalid","ci_id":"[REDACTED]"}');
  });

  it("redacts a short credential without changing an unrelated error code", () => {
    expect(
      redactEchoApiText(
        "HTTP status 401; token=1; supplied value [1]",
        "https://open.echoapi.com/ci?token=1",
      ),
    ).toBe("HTTP status 401; token=[REDACTED]; supplied value [[REDACTED]]");
  });

  it("removes decoded URL credential values", () => {
    const output = redactEchoApiText(
      "credentials were fixture@user and fixture/password",
      "https://fixture%40user:fixture%2Fpassword@open.echoapi.com/ci",
    );
    expect(output).not.toContain("fixture@user");
    expect(output).not.toContain("fixture/password");
  });

  it.skipIf(process.platform === "win32")(
    "redacts separately echoed CI values in the original runner receipt",
    async () => {
      const outputDir = await mkdtemp(path.join(os.tmpdir(), "echoapi-redaction-"));
      const secret = "fixture-diagnostic-query-value";
      try {
        const executable = path.join(outputDir, "fake-echoapi");
        await writeFile(
          executable,
          `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(`CLI rejected supplied value [${secret}]`)});\nprocess.exitCode = 1;\n`,
          { mode: 0o700 },
        );
        const receipt = await runEchoApiCliCase({
          ciUrl: `https://open.echoapi.com/ci?signature=${secret}`,
          executable,
          outputDir,
          retainReport: false,
        });
        expect(receipt.passed).toBe(false);
        expect(receipt.stderr).not.toContain(secret);
        expect(receipt.stderr).toContain("[REDACTED]");
        expect(JSON.stringify(receipt.target)).not.toContain(secret);
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
  );
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
