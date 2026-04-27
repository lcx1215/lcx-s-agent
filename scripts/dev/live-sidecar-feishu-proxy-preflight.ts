import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUNTIME_BUNDLE_ROOT } from "./live-sidecar-runtime-bundle.ts";

const DEFAULT_LEGACY_ROOT = "/Users/liuchengxu/Desktop/openclaw";
const DEFAULT_OUTPUT_DIR = "ops/live-handoff/launchagent-candidates";
const FEISHU_PROXY_PLIST = "/Users/liuchengxu/Library/LaunchAgents/ai.openclaw.feishu.proxy.plist";
const RECEIPT_NAME = "live-sidecar-feishu-proxy-preflight-receipt.json";

const REQUIRED_FILES = [
  "feishu_event_proxy.py",
  "run_feishu_proxy.sh",
  "send_feishu_reply.sh",
  "scripts/learning_goal_registry.py",
] as const;

type Args = {
  legacyRoot: string;
  targetRoot: string;
  outputDir: string;
  writeRuntime: boolean;
  smokePort: number;
  json: boolean;
};

type CommandResult = {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
};

export type FeishuProxyPreflightReceipt = {
  schemaVersion: 1;
  generatedAt: string;
  legacyRoot: string;
  targetRoot: string;
  receiptPath: string;
  writeRuntime: boolean;
  readyForLiveInstall: boolean;
  blockedReasons: string[];
  files: Array<{
    relativePath: string;
    legacyExists: boolean;
    targetExists: boolean;
    legacySha256: string | null;
    targetSha256: string | null;
    copied: boolean;
  }>;
  currentLaunchAgent: {
    exists: boolean;
    pointsAtLegacyRoot: boolean;
    pointsAtTargetRoot: boolean;
  };
  smoke: {
    port: number;
    commandResults: CommandResult[];
    health: Record<string, unknown> | null;
  };
  boundary: string[];
};

function parseArgs(argv: string[]): Args {
  const readValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    legacyRoot: path.resolve(readValue("--legacy-root") ?? DEFAULT_LEGACY_ROOT),
    targetRoot: path.resolve(readValue("--target-root") ?? DEFAULT_RUNTIME_BUNDLE_ROOT),
    outputDir: path.resolve(readValue("--output-dir") ?? DEFAULT_OUTPUT_DIR),
    writeRuntime: argv.includes("--write-runtime"),
    smokePort: Number(readValue("--smoke-port") ?? "3012"),
    json: argv.includes("--json"),
  };
}

function sha256IfExists(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function isDesktopPath(filePath: string): boolean {
  return path.resolve(filePath).split(path.sep).includes("Desktop");
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: [command, ...args].join(" "),
    code: result.status,
    stdout: (result.stdout || "").slice(-4000),
    stderr: (result.stderr || "").slice(-4000),
  };
}

function copyRuntimeFile(legacyRoot: string, targetRoot: string, relativePath: string): void {
  const source = path.join(legacyRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  if (relativePath.endsWith(".sh") || relativePath.endsWith(".py")) {
    fs.chmodSync(target, 0o755);
  }
}

function inspectCurrentLaunchAgent(legacyRoot: string, targetRoot: string) {
  let text = "";
  try {
    text = fs.readFileSync(FEISHU_PROXY_PLIST, "utf8");
  } catch {
    return { exists: false, pointsAtLegacyRoot: false, pointsAtTargetRoot: false };
  }
  return {
    exists: true,
    pointsAtLegacyRoot: text.includes(legacyRoot),
    pointsAtTargetRoot: text.includes(targetRoot),
  };
}

function parseJsonTail(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function runSmoke(targetRoot: string, smokePort: number): FeishuProxyPreflightReceipt["smoke"] {
  const commandResults: CommandResult[] = [];
  commandResults.push(
    run(
      "python3",
      ["-m", "py_compile", "feishu_event_proxy.py", "scripts/learning_goal_registry.py"],
      targetRoot,
    ),
  );
  if (commandResults[0]?.code !== 0) {
    return { port: smokePort, commandResults, health: null };
  }

  const child = spawnSync(
    "bash",
    [
      "-lc",
      [
        `export LOBSTER_PROXY_PORT=${smokePort}`,
        `export OPENCLAW_ROOT=${JSON.stringify(targetRoot)}`,
        `export OPENCLAW_BIN=${JSON.stringify(path.join(targetRoot, "send_feishu_reply.sh"))}`,
        "python3 feishu_event_proxy.py > /tmp/openclaw-feishu-proxy-smoke.out 2> /tmp/openclaw-feishu-proxy-smoke.err & pid=$!",
        "sleep 1",
        `curl -sS --max-time 3 http://127.0.0.1:${smokePort}/healthz`,
        "status=$?",
        "kill $pid >/dev/null 2>&1 || true",
        "wait $pid >/dev/null 2>&1 || true",
        "exit $status",
      ].join("; "),
    ],
    {
      cwd: targetRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const smokeResult = {
    command: `LOBSTER_PROXY_PORT=${smokePort} python3 feishu_event_proxy.py + curl /healthz`,
    code: child.status,
    stdout: (child.stdout || "").slice(-4000),
    stderr: `${child.stderr || ""}\n${readIfExists("/tmp/openclaw-feishu-proxy-smoke.err")}`.slice(
      -4000,
    ),
  };
  commandResults.push(smokeResult);
  return { port: smokePort, commandResults, health: parseJsonTail(smokeResult.stdout) };
}

function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function buildFeishuProxyPreflightReceipt(params: {
  legacyRoot: string;
  targetRoot: string;
  outputDir: string;
  writeRuntime?: boolean;
  smokePort?: number;
  generatedAt?: string;
  runSmokeCheck?: boolean;
}): FeishuProxyPreflightReceipt {
  const legacyRoot = path.resolve(params.legacyRoot);
  const targetRoot = path.resolve(params.targetRoot);
  const outputDir = path.resolve(params.outputDir);
  const blockedReasons: string[] = [];

  if (isDesktopPath(targetRoot)) {
    blockedReasons.push("target root must not be under Desktop");
  }
  for (const relativePath of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(legacyRoot, relativePath))) {
      blockedReasons.push(`legacy proxy dependency missing: ${relativePath}`);
    }
  }

  if (params.writeRuntime && blockedReasons.length === 0) {
    for (const relativePath of REQUIRED_FILES) {
      copyRuntimeFile(legacyRoot, targetRoot, relativePath);
    }
  }

  const files = REQUIRED_FILES.map((relativePath) => {
    const legacyPath = path.join(legacyRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    const legacySha256 = sha256IfExists(legacyPath);
    const targetSha256 = sha256IfExists(targetPath);
    return {
      relativePath,
      legacyExists: fs.existsSync(legacyPath),
      targetExists: fs.existsSync(targetPath),
      legacySha256,
      targetSha256,
      copied: legacySha256 !== null && legacySha256 === targetSha256,
    };
  });
  const currentLaunchAgent = inspectCurrentLaunchAgent(legacyRoot, targetRoot);
  const smoke =
    params.runSmokeCheck === false
      ? { port: params.smokePort ?? 3012, commandResults: [], health: null }
      : runSmoke(targetRoot, params.smokePort ?? 3012);

  const healthOk = smoke.health?.ok === true && smoke.health?.port === (params.smokePort ?? 3012);
  const readyForLiveInstall =
    blockedReasons.length === 0 &&
    files.every((file) => file.copied) &&
    smoke.commandResults.every((result) => result.code === 0) &&
    healthOk;

  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    legacyRoot,
    targetRoot,
    receiptPath: path.join(outputDir, RECEIPT_NAME),
    writeRuntime: Boolean(params.writeRuntime),
    readyForLiveInstall,
    blockedReasons,
    files,
    currentLaunchAgent,
    smoke,
    boundary: [
      "Copies only existing live Feishu/Lark proxy dependencies into the non-Desktop runtime.",
      "Uses an alternate smoke port and does not replace the live 3011 proxy.",
      "Does not modify LaunchAgents.",
      "Does not send Feishu/Lark messages.",
    ],
  };
}

function writeReceipt(receipt: FeishuProxyPreflightReceipt): void {
  fs.mkdirSync(path.dirname(receipt.receiptPath), { recursive: true });
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function renderText(receipt: FeishuProxyPreflightReceipt): string {
  const lines = [
    `feishuProxyPreflight=${receipt.readyForLiveInstall ? "ready" : "blocked"}`,
    `targetRoot=${receipt.targetRoot}`,
    `smokePort=${receipt.smoke.port}`,
    `receiptPath=${receipt.receiptPath}`,
  ];
  for (const reason of receipt.blockedReasons) {
    lines.push(`blockedReason=${reason}`);
  }
  for (const file of receipt.files) {
    lines.push(`${file.relativePath}.copied=${file.copied}`);
  }
  for (const result of receipt.smoke.commandResults) {
    lines.push(`${result.command}=exit_${result.code}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const receipt = buildFeishuProxyPreflightReceipt({
    legacyRoot: args.legacyRoot,
    targetRoot: args.targetRoot,
    outputDir: args.outputDir,
    writeRuntime: args.writeRuntime,
    smokePort: args.smokePort,
  });
  writeReceipt(receipt);
  process.stdout.write(args.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderText(receipt));
  return receipt.readyForLiveInstall ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
