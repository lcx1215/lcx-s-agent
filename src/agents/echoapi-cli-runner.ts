import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveStateDir } from "../config/paths.js";

const execFileAsync = promisify(execFile);

export const ECHOAPI_CLI_PACKAGE = "echoapi-cli" as const;
export const ECHOAPI_CLI_VERSION = "3.0.0" as const;
export const ECHOAPI_CLI_TARBALL_INTEGRITY =
  "sha512-QvZN4pXUs+2jCJviHgsl3qM37D3yKy+X3aG6gEV+hqvbI+EDGlT0/4o7VqQY8Y7Khncsqn13lCiMro/QccEsEg==" as const;

export type EchoApiCliRunOptions = Readonly<{
  ciUrl: string;
  executable?: string;
  timeoutMs?: number;
  outputDir?: string;
  retainReport?: boolean;
  allowExternalHost?: boolean;
}>;

export type EchoApiCliRunReceipt = Readonly<{
  schemaVersion: "lcx_echoapi_cli_run_v2";
  boundary: "echoapi_public_case_runner_research_only";
  target: Readonly<{ hostname: string; pathname: string }>;
  executable: string;
  cliVersion: string;
  cliSource: "canonical_state_root" | "explicit_executable";
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

function echoApiRuntimeRoot(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "runtime", "api-clients", ECHOAPI_CLI_PACKAGE, ECHOAPI_CLI_VERSION);
}

function echoApiExecutablePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "node_modules", ".bin", "echoapi");
}

async function readInstalledVersion(runtimeRoot: string): Promise<string | undefined> {
  try {
    const body = await readFile(
      path.join(runtimeRoot, "node_modules", ECHOAPI_CLI_PACKAGE, "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function bootstrapActiveStateEchoApiCli(): Promise<{ executable: string; version: string }> {
  const runtimeRoot = echoApiRuntimeRoot();
  const executable = echoApiExecutablePath(runtimeRoot);
  const installedVersion = await readInstalledVersion(runtimeRoot);
  if (installedVersion === ECHOAPI_CLI_VERSION) {
    return { executable, version: installedVersion };
  }

  await mkdir(runtimeRoot, { recursive: true });
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    await execFileAsync(
      npmExecutable,
      [
        "install",
        "--prefix",
        runtimeRoot,
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/",
        `${ECHOAPI_CLI_PACKAGE}@${ECHOAPI_CLI_VERSION}`,
      ],
      {
        encoding: "utf8",
        cwd: runtimeRoot,
        env: safeEnvironment(),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
      },
    );
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new Error(
      `failed to install ${ECHOAPI_CLI_PACKAGE}@${ECHOAPI_CLI_VERSION} into the active LCX state root: ${(failure.stderr || failure.message || "npm install failed").trim().slice(0, 2_000)}`,
      { cause: error },
    );
  }

  const finalVersion = await readInstalledVersion(runtimeRoot);
  if (finalVersion !== ECHOAPI_CLI_VERSION) {
    throw new Error(
      `active-state EchoAPI CLI installation did not produce ${ECHOAPI_CLI_PACKAGE}@${ECHOAPI_CLI_VERSION}`,
    );
  }
  await writeFile(
    path.join(runtimeRoot, "lcx-installation.json"),
    `${JSON.stringify(
      {
        schemaVersion: "lcx_echoapi_cli_installation_v1",
        package: ECHOAPI_CLI_PACKAGE,
        version: ECHOAPI_CLI_VERSION,
        tarballIntegrity: ECHOAPI_CLI_TARBALL_INTEGRITY,
        installRoot: runtimeRoot,
        installPolicy: [
          "active_lcx_state_root_owner_only",
          "exact_version_only",
          "npm_registry_pinned",
          "install_scripts_disabled",
          "no_secret_environment_inherited",
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { executable, version: finalVersion };
}

/** Install or reuse the exact EchoAPI CLI in the active LCX state-root owner. */
export async function ensureCanonicalEchoApiCli(): Promise<{
  executable: string;
  version: string;
  installRoot: string;
  tarballIntegrity: string;
}> {
  const installed = await bootstrapActiveStateEchoApiCli();
  return {
    ...installed,
    installRoot: echoApiRuntimeRoot(),
    tarballIntegrity: ECHOAPI_CLI_TARBALL_INTEGRITY,
  };
}

async function resolveExecutable(requested?: string): Promise<{
  executable: string;
  version: string;
  source: EchoApiCliRunReceipt["cliSource"];
}> {
  if (requested?.trim()) {
    return { executable: requested.trim(), version: "unknown", source: "explicit_executable" };
  }

  const activeState = await bootstrapActiveStateEchoApiCli();
  return { ...activeState, source: "canonical_state_root" };
}

export async function runEchoApiCliCase(
  options: EchoApiCliRunOptions,
): Promise<EchoApiCliRunReceipt> {
  const url = validateEchoApiCiUrl(options.ciUrl, options);
  const outputDir = requiredText(
    options.outputDir ?? path.join(resolveStateDir(), "reports", "echoapi"),
    "outputDir",
  );
  await mkdir(outputDir, { recursive: true });
  const resolved = options.executable
    ? await resolveExecutable(options.executable)
    : await resolveExecutable();
  const executable = resolved.executable;
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
    schemaVersion: "lcx_echoapi_cli_run_v2",
    boundary: "echoapi_public_case_runner_research_only",
    target: { hostname: url.hostname, pathname: url.pathname },
    executable,
    cliVersion: resolved.version,
    cliSource: resolved.source,
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
