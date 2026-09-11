import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { resolveStateDir } from "../config/paths.js";
import { resolveFinanceFetch } from "./finance-live-market-source.js";

const execFileAsync = promisify(execFile);

export const ECHOAPI_CLI_PACKAGE = "echoapi-cli" as const;
export const ECHOAPI_CLI_VERSION = "3.0.0" as const;
export const ECHOAPI_CLI_TARBALL_INTEGRITY =
  "sha512-QvZN4pXUs+2jCJviHgsl3qM37D3yKy+X3aG6gEV+hqvbI+EDGlT0/4o7VqQY8Y7Khncsqn13lCiMro/QccEsEg==" as const;

export type EchoApiCliRunOptions = Readonly<{
  ciUrl?: string;
  builtinPublicCase?: boolean;
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
  reportVerified: boolean;
  source?: Readonly<{
    url: string;
    fetchedAt: string;
    bodySha256: string;
    boundary: "real_public_data_local_snapshot";
  }>;
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
  const reportMode = "json";
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
    "--insecure",
    "0",
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

async function installedExecutableIsUsable(executable: string): Promise<boolean> {
  try {
    const info = await stat(executable);
    if (!info.isFile()) {
      return false;
    }
    await access(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function bootstrapActiveStateEchoApiCli(): Promise<{ executable: string; version: string }> {
  const runtimeRoot = echoApiRuntimeRoot();
  const executable = echoApiExecutablePath(runtimeRoot);
  if (
    (await readInstalledVersion(runtimeRoot)) === ECHOAPI_CLI_VERSION &&
    (await installedExecutableIsUsable(executable))
  ) {
    return { executable, version: ECHOAPI_CLI_VERSION };
  }
  await mkdir(runtimeRoot, { recursive: true });
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const downloadDir = await mkdtemp(path.join(runtimeRoot, ".download-"));
  try {
    const packageSpec = `${ECHOAPI_CLI_PACKAGE}@${ECHOAPI_CLI_VERSION}`;
    const packResult = await execFileAsync(
      npmExecutable,
      [
        "pack",
        packageSpec,
        "--json",
        "--pack-destination",
        downloadDir,
        "--registry",
        "https://registry.npmjs.org/",
      ],
      {
        encoding: "utf8",
        cwd: runtimeRoot,
        env: safeEnvironment(),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    const packMetadata = JSON.parse(packResult.stdout) as Array<{
      filename?: unknown;
      integrity?: unknown;
    }>;
    const packed = packMetadata[0];
    if (!packed || typeof packed.filename !== "string" || typeof packed.integrity !== "string") {
      throw new Error("npm pack returned incomplete artifact metadata");
    }
    if (packed.integrity !== ECHOAPI_CLI_TARBALL_INTEGRITY) {
      throw new Error(
        `EchoAPI CLI tarball integrity changed: expected ${ECHOAPI_CLI_TARBALL_INTEGRITY}, received ${packed.integrity}`,
      );
    }
    const filename = path.basename(packed.filename);
    if (filename !== packed.filename) {
      throw new Error("npm pack returned an unsafe artifact filename");
    }
    const tarballPath = path.join(downloadDir, filename);
    const tarballIntegrity = `sha512-${createHash("sha512")
      .update(await readFile(tarballPath))
      .digest("base64")}`;
    if (tarballIntegrity !== ECHOAPI_CLI_TARBALL_INTEGRITY) {
      throw new Error(
        `EchoAPI CLI downloaded artifact failed integrity verification: expected ${ECHOAPI_CLI_TARBALL_INTEGRITY}, received ${tarballIntegrity}`,
      );
    }
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
        tarballPath,
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
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
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
  if (Boolean(options.ciUrl) === Boolean(options.builtinPublicCase)) {
    throw new Error("Specify exactly one ciUrl or builtinPublicCase");
  }
  if (options.builtinPublicCase) {
    return runBuiltinPublicCase(options);
  }
  const url = validateEchoApiCiUrl(options.ciUrl ?? "", options);
  return executeEchoApiCase(options, url.href, { hostname: url.hostname, pathname: url.pathname });
}

export function verifyEchoApiReport(report: unknown): boolean {
  if (!report || typeof report !== "object") {
    return false;
  }
  const value = report as {
    action?: unknown;
    data?: {
      http?: { total?: number; success?: number; error?: number };
      assert?: { total?: number; success?: number; error?: number };
    };
  };
  return (
    value.action === "complete" &&
    [value.data?.http, value.data?.assert].every(
      (counts) =>
        counts != null &&
        Number.isInteger(counts.total) &&
        (counts.total ?? 0) > 0 &&
        counts.success === counts.total &&
        counts.error === 0,
    )
  );
}

export function redactEchoApiText(value: string, sensitiveUrl?: string): string {
  let redacted = value;
  if (sensitiveUrl) {
    try {
      const parsed = new URL(sensitiveUrl);
      const safeUrl = `${parsed.origin}${parsed.pathname}?[REDACTED_QUERY]`;
      redacted = redacted.split(parsed.href).join(safeUrl);
    } catch {
      // Generic URL redaction below still protects malformed input.
    }
  }
  return redacted
    .replace(/https?:\/\/[^\s"'<>?]+(?:\?[^\s"'<>]*)?/giu, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[REDACTED_QUERY]" : ""}`;
      } catch {
        return url;
      }
    })
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?|bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /(["']?(?:token|api[_-]?key|secret|password)["']?\s*[:=]\s*["']?)[^"',\s}]+/giu,
      "$1[REDACTED]",
    );
}

async function executeEchoApiCase(
  options: EchoApiCliRunOptions,
  caseInput: string,
  target: EchoApiCliRunReceipt["target"],
): Promise<EchoApiCliRunReceipt> {
  const outputDir = requiredText(
    options.outputDir ?? path.join(resolveStateDir(), "reports", "echoapi"),
    "outputDir",
  );
  await mkdir(outputDir, { recursive: true });
  const resolved = options.executable
    ? await resolveExecutable(options.executable)
    : await resolveExecutable();
  const executable = resolved.executable;
  const runDir = await mkdtemp(path.join(outputDir, "run-"));
  const args = buildEchoApiCliArgs(caseInput, {
    timeoutMs: options.timeoutMs,
    outputDir: runDir,
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
  const reportPath = path.join(runDir, "lcx-echoapi.json");
  let reportVerified = false;
  try {
    reportVerified = verifyEchoApiReport(JSON.parse(await readFile(reportPath, "utf8")));
  } catch {
    /* Missing or malformed reports fail closed. */
  }
  if (options.retainReport === false) {
    await rm(runDir, { recursive: true, force: true });
  }
  return {
    schemaVersion: "lcx_echoapi_cli_run_v2",
    boundary: "echoapi_public_case_runner_research_only",
    target,
    executable,
    cliVersion: resolved.version,
    cliSource: resolved.source,
    exitCode,
    passed: exitCode === 0 && reportVerified,
    reportVerified,
    reportPath: options.retainReport === false ? undefined : reportPath,
    stdoutSha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
    stderr: redactEchoApiText(stderr, caseInput).trim().slice(0, 2_000),
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

/** Exercise the real CLI against a bounded snapshot fetched through LCX's public-data transport. */
async function runBuiltinPublicCase(options: EchoApiCliRunOptions): Promise<EchoApiCliRunReceipt> {
  const sourceUrl = "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT";
  const response = await resolveFinanceFetch(undefined, {
    timeoutMs: options.timeoutMs ?? 15_000,
    retry: { attempts: 1 },
  })(sourceUrl);
  if (!response.ok) {
    throw new Error(`Public case source HTTP ${response.status}`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > 16_384) {
    throw new Error("Public case source exceeded size limit");
  }
  const price = JSON.parse(body) as { symbol?: unknown; price?: unknown };
  if (
    price.symbol !== "BTCUSDT" ||
    typeof price.price !== "string" ||
    !Number.isFinite(Number(price.price)) ||
    Number(price.price) <= 0
  ) {
    throw new Error("Invalid public price snapshot");
  }
  const source = {
    url: sourceUrl,
    fetchedAt: new Date().toISOString(),
    bodySha256: createHash("sha256").update(body).digest("hex"),
    boundary: "real_public_data_local_snapshot" as const,
  };
  let hits = 0;
  const server = createServer((request, result) => {
    if (request.method !== "GET" || request.url !== "/market") {
      result.writeHead(404).end();
      return;
    }
    hits++;
    result.setHeader("Content-Type", "application/json");
    result.end(body);
  });
  const outputDir = options.outputDir ?? path.join(resolveStateDir(), "reports", "echoapi");
  await mkdir(outputDir, { recursive: true });
  const caseDir = await mkdtemp(path.join(outputDir, "public-case-"));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local snapshot server failed");
    }
    const casePath = path.join(caseDir, "case.json");
    await writeFile(
      casePath,
      JSON.stringify({
        test_events: [
          {
            event_id: "public-price",
            type: "api",
            enabled: 1,
            data: {
              target_id: "public-price",
              apiData: {
                target_id: "public-price",
                name: "LCX real public price snapshot",
                method: "GET",
                url: `http://127.0.0.1:${address.port}/market`,
                request: {
                  header: { parameter: [] },
                  query: { parameter: [] },
                  body: { mode: "none" },
                  post_tasks: [
                    {
                      type: "assert",
                      enabled: 1,
                      name: "HTTP 200",
                      data: {
                        type: "responseCode",
                        expression: { compareType: "eq", compareValue: "200" },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
        option: {
          scene: "auto_test",
          name: "LCX public finance snapshot",
          iterationCount: 1,
          collection: [],
          env: { environment: {} },
          globals: {},
          cookies: { switch: -1, data: [] },
          system_configs: {},
          enable_sandbox: 1,
        },
      }),
    );
    const receipt = await executeEchoApiCase(options, casePath, {
      hostname: "127.0.0.1",
      pathname: "/market",
    });
    return { ...receipt, passed: receipt.passed && hits > 0, source };
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(caseDir, { recursive: true, force: true });
  }
}
