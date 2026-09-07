import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type EchoApiCliRunOptions = Readonly<{
  ciUrl: string;
  executable?: string;
  timeoutMs?: number;
  outputDir?: string;
  retainReport?: boolean;
  allowExternalHost?: boolean;
}>;

export type EchoApiCliRunReceipt = Readonly<{
  schemaVersion: "lcx_echoapi_cli_run_v1";
  boundary: "echoapi_public_case_runner_research_only";
  target: Readonly<{ hostname: string; pathname: string }>;
  executable: string;
  exitCode: number;
  passed: boolean;
  reportPath?: string;
  stdoutSha256: string;
  stderr: string;
  policy: readonly string[];
}>;

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  return normalized;
}

export function validateEchoApiCiUrl(
  rawUrl: string,
  options: { allowExternalHost?: boolean } = {},
): URL {
  const url = new URL(requiredText(rawUrl, "ciUrl"));
  if (url.protocol !== "https:") {
    throw new Error("EchoAPI ciUrl must use HTTPS");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    !options.allowExternalHost &&
    !hostname.endsWith(".echoapi.com") &&
    hostname !== "echoapi.com"
  ) {
    throw new Error("EchoAPI ciUrl host must be an EchoAPI host unless allowExternalHost=true");
  }
  return url;
}

export function buildEchoApiCliArgs(
  ciUrl: string,
  options: { timeoutMs?: number; outputDir: string; retainReport?: boolean },
): string[] {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  const reportMode = options.retainReport === false ? "cli" : "json";
  return [
    "run",
    ciUrl,
    "-n",
    "1",
    "-r",
    reportMode,
    "--timeout-request",
    String(Math.round(timeoutMs)),
    "--timeout-script",
    "1000",
    "--out-dir",
    options.outputDir,
    "--out-file",
    "lcx-echoapi",
  ];
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowedKeys = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NODE_PATH"];
  return Object.fromEntries(
    allowedKeys.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

async function resolveExecutable(requested?: string): Promise<string> {
  if (requested?.trim()) {
    return requested.trim();
  }
  for (const candidate of ["echoapi", "echoapi-cli"]) {
    try {
      await execFileAsync("which", [candidate], { encoding: "utf8" });
      return candidate;
    } catch {
      // Try the next supported installation name.
    }
  }
  throw new Error(
    "EchoAPI CLI not installed; install or expose echoapi/echoapi-cli before live use",
  );
}

export async function runEchoApiCliCase(
  options: EchoApiCliRunOptions,
): Promise<EchoApiCliRunReceipt> {
  const url = validateEchoApiCiUrl(options.ciUrl, options);
  const outputDir = requiredText(options.outputDir ?? ".echoapi-reports", "outputDir");
  const executable = await resolveExecutable(options.executable);
  const args = buildEchoApiCliArgs(options.ciUrl, {
    timeoutMs: options.timeoutMs,
    outputDir,
    retainReport: options.retainReport,
  });
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      env: safeEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      timeout: (options.timeoutMs ?? 15_000) + 5_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    exitCode = typeof failure.code === "number" ? failure.code : 1;
    stdout = failure.stdout ?? "";
    stderr = failure.stderr || failure.message || "EchoAPI CLI failed";
  }
  return {
    schemaVersion: "lcx_echoapi_cli_run_v1",
    boundary: "echoapi_public_case_runner_research_only",
    target: { hostname: url.hostname, pathname: url.pathname },
    executable,
    exitCode,
    passed: exitCode === 0,
    reportPath: options.retainReport === false ? undefined : `${outputDir}/lcx-echoapi.json`,
    stdoutSha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
    stderr: stderr.trim().slice(0, 2_000),
    policy: [
      "one_iteration_only",
      "no_webhook_argument_sent",
      "no_client_certificate_arguments_sent",
      "no_shell_interpolation",
      "only_minimal_non_secret_environment_inherited",
      "research_only_no_trade_or_wallet_authority",
    ],
  };
}
