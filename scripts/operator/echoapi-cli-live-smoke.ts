#!/usr/bin/env node

import { runEchoApiCliCase } from "../../src/agents/echoapi-cli-runner.ts";

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const ciUrl = readFlag(args, "--ci-url");
  if (!args.includes("--live")) {
    process.stdout.write(
      [
        "echoapi-cli-live-smoke: dry mode (no EchoAPI case executed).",
        "Pass --live --ci-url <EchoAPI CI case URL> to execute one real case iteration.",
        "The runner sends no webhook, does not inherit secret environment variables, and does not grant finance or trading authority.",
      ].join("\n"),
    );
    process.stdout.write("\n");
    return 0;
  }
  if (!ciUrl) {
    throw new Error("--ci-url is required with --live");
  }
  const receipt = await runEchoApiCliCase({
    ciUrl,
    executable: readFlag(args, "--executable"),
    outputDir: readFlag(args, "--output-dir"),
    timeoutMs: Number(readFlag(args, "--timeout-ms") ?? 15_000),
    retainReport: args.includes("--retain-report"),
    allowExternalHost: args.includes("--allow-external-host"),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt.passed ? 0 : 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`echoapi_live_smoke_error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
