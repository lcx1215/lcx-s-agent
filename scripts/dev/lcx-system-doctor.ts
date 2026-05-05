import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

type CliOptions = {
  json: boolean;
  deep: boolean;
  live: boolean;
  brainPlan: boolean;
};

type CheckResult = {
  name: string;
  ok: boolean;
  skipped?: boolean;
  durationMs: number;
  summary: Record<string, unknown>;
  error?: string;
};

const DEFAULT_ADAPTER = path.join(
  process.env.HOME ?? ".",
  ".openclaw",
  "local-brain-trainer",
  "adapters",
  "thought-flow-v1-qwen3-0.6b-taxonomy-v3",
);

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-system-doctor.ts [--json] [--deep] [--live] [--brain-plan]",
      "",
      "Summarizes LCX Agent dev observability without touching live surfaces by default.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    deep: false,
    live: false,
    brainPlan: false,
  };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--deep") {
      options.deep = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--brain-plan") {
      options.brainPlan = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function runCommand(params: {
  name: string;
  command: string;
  args: string[];
  parseJson?: boolean;
  cwd?: string;
}): Promise<CheckResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        name: params.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        summary: {},
        error: error.message,
      });
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        resolve({
          name: params.name,
          ok: false,
          durationMs,
          summary: {
            stdoutTail: stdout.slice(-500),
            stderrTail: stderr.slice(-500),
            exitCode: code,
          },
          error: `${params.name} exited ${code}`,
        });
        return;
      }
      try {
        const payload = params.parseJson ? parseJsonObjectFromOutput(stdout) : undefined;
        resolve({
          name: params.name,
          ok: true,
          durationMs,
          summary: payload
            ? summarizeJson(params.name, payload)
            : summarizeText(params.name, stdout),
        });
      } catch (error) {
        resolve({
          name: params.name,
          ok: false,
          durationMs,
          summary: {
            stdoutTail: stdout.slice(-500),
            stderrTail: stderr.slice(-500),
          },
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}

function summarizeText(name: string, stdout: string): Record<string, unknown> {
  if (name === "git-status") {
    return summarizeGitStatus(stdout);
  }
  return {
    stdoutTail: stdout.trim().slice(-500),
  };
}

function summarizeGitStatus(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const branch = lines.find((line) => line.startsWith("##")) ?? "";
  const entries = lines.filter((line) => !line.startsWith("##"));
  const modified = entries.filter((line) => line.startsWith(" M") || line.startsWith("M "));
  const added = entries.filter((line) => line.startsWith("A "));
  const deleted = entries.filter((line) => line.startsWith(" D") || line.startsWith("D "));
  const untracked = entries.filter((line) => line.startsWith("??"));
  const renamed = entries.filter((line) => line.startsWith("R "));
  const conflicted = entries.filter((line) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line));
  return {
    branch,
    dirty: entries.length > 0,
    counts: {
      modified: modified.length,
      added: added.length,
      deleted: deleted.length,
      renamed: renamed.length,
      untracked: untracked.length,
      conflicted: conflicted.length,
      total: entries.length,
    },
    modified: modified.map((line) => line.slice(3)).slice(0, 12),
    untracked: untracked.map((line) => line.slice(3)).slice(0, 12),
    conflicted: conflicted.map((line) => line.slice(3)).slice(0, 12),
  };
}

function summarizeJson(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (name === "local-brain-dataset") {
    return {
      ok: payload.ok,
      counts: payload.counts,
      sourceKinds: payload.sourceKinds,
      notTouched: payload.notTouched,
    };
  }
  if (name === "local-brain-smoke") {
    return {
      ok: payload.ok,
      counts: payload.counts,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
    };
  }
  if (name === "local-brain-eval") {
    return {
      ok: payload.ok,
      summary: payload.summary,
      adapterPath: payload.adapterPath,
    };
  }
  if (name === "local-brain-plan") {
    const plan =
      payload.plan && typeof payload.plan === "object"
        ? (payload.plan as Record<string, unknown>)
        : {};
    return {
      ok: payload.ok,
      primaryModules: plan.primary_modules,
      missingData: plan.missing_data,
      liveTouched: payload.liveTouched,
      providerConfigTouched: payload.providerConfigTouched,
      durableMemoryTouched: payload.durableMemoryTouched,
    };
  }
  if (name === "lark-loop-diagnose" || name === "channels-status-probe") {
    return payload;
  }
  return payload;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function entrypointCheck(): Promise<CheckResult> {
  const startedAt = Date.now();
  const entries = [
    "scripts/dev/agent-system-loop-smoke.ts",
    "scripts/dev/lark-brain-language-loop-smoke.ts",
    "scripts/dev/lark-brain-distillation-candidate-smoke.ts",
    "scripts/dev/lark-brain-distillation-review.ts",
    "scripts/dev/finance-learning-pipeline-smoke.ts",
    "scripts/dev/local-brain-distill-dataset.ts",
    "scripts/dev/local-brain-distill-smoke.ts",
    "scripts/dev/local-brain-distill-eval.ts",
    "scripts/dev/local-brain-plan.ts",
    "src/commands/capabilities/lark-loop-diagnose.ts",
  ];
  const missing = [];
  for (const entry of entries) {
    if (!(await fileExists(path.join(process.cwd(), entry)))) {
      missing.push(entry);
    }
  }
  return {
    name: "observability-entrypoints",
    ok: missing.length === 0,
    durationMs: Date.now() - startedAt,
    summary: {
      checked: entries.length,
      missing,
    },
    error: missing.length > 0 ? "missing observability entrypoints" : undefined,
  };
}

function skipped(name: string, reason: string): CheckResult {
  return {
    name,
    ok: true,
    skipped: true,
    durationMs: 0,
    summary: { reason },
  };
}

function actionableFailures(checks: CheckResult[]): string[] {
  return checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: ${check.error ?? "failed"}`);
}

const options = parseArgs(process.argv.slice(2));
const checks: CheckResult[] = [];

checks.push(
  await runCommand({
    name: "git-status",
    command: "git",
    args: ["status", "--short", "--branch"],
  }),
);
checks.push(await entrypointCheck());
checks.push(
  await runCommand({
    name: "brain-distillation-candidate-smoke",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/dev/lark-brain-distillation-candidate-smoke.ts"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "brain-distillation-review-dry-run",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/dev/lark-brain-distillation-review.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "local-brain-dataset",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/dev/local-brain-distill-dataset.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  await runCommand({
    name: "local-brain-smoke",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/dev/local-brain-distill-smoke.ts", "--json"],
    parseJson: true,
  }),
);
checks.push(
  options.brainPlan || options.deep
    ? await runCommand({
        name: "local-brain-plan",
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "scripts/dev/local-brain-plan.ts",
          "--ask",
          "我想研究QQQ和TLT的风险切换，先拆内部模块，不要给交易建议。",
          "--json",
        ],
        parseJson: true,
      })
    : skipped("local-brain-plan", "use --brain-plan or --deep; MLX generation is slower"),
);

if (options.deep) {
  checks.push(
    await runCommand({
      name: "local-brain-eval",
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-eval.ts",
        "--model",
        "Qwen/Qwen3-0.6B",
        "--adapter",
        DEFAULT_ADAPTER,
        "--json",
      ],
      parseJson: true,
    }),
  );
  checks.push(
    await runCommand({
      name: "build",
      command: "pnpm",
      args: ["build"],
    }),
  );
} else {
  checks.push(skipped("local-brain-eval", "use --deep; MLX generation is intentionally slower"));
  checks.push(skipped("build", "use --deep for full TypeScript/build verification"));
}

if (options.live) {
  checks.push(
    await runCommand({
      name: "lark-loop-diagnose",
      command: "pnpm",
      args: ["--silent", "openclaw", "capabilities", "lark-loop-diagnose", "--json"],
      parseJson: true,
    }),
  );
  checks.push(
    await runCommand({
      name: "channels-status-probe",
      command: "pnpm",
      args: ["--silent", "openclaw", "channels", "status", "--probe", "--json"],
      parseJson: true,
    }),
  );
} else {
  checks.push(skipped("lark-loop-diagnose", "use --live; default doctor does not touch live Lark"));
  checks.push(
    skipped("channels-status-probe", "use --live; default doctor does not probe live channels"),
  );
}

checks.push(
  await runCommand({
    name: "diff-check",
    command: "git",
    args: ["diff", "--check"],
  }),
);

const failures = actionableFailures(checks);
const result = {
  ok: failures.length === 0,
  boundary: "dev_observability_only",
  deep: options.deep,
  live: options.live,
  brainPlan: options.brainPlan,
  liveTouched: options.live,
  checkedAt: new Date().toISOString(),
  summary: {
    passed: checks.filter((check) => check.ok && !check.skipped).length,
    skipped: checks.filter((check) => check.skipped).length,
    failed: checks.filter((check) => !check.ok).length,
    total: checks.length,
  },
  checks,
  actionableFailures: failures,
};

const gitSummary = checks.find((check) => check.name === "git-status")?.summary;
const gitCounts = gitSummary && typeof gitSummary === "object" ? gitSummary.counts : undefined;
const skippedChecks = checks.filter((check) => check.skipped).map((check) => check.name);

process.stdout.write(
  options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : [
        `lcx system doctor ${result.ok ? "ok" : "failed"}`,
        `passed=${result.summary.passed} skipped=${result.summary.skipped} failed=${result.summary.failed}`,
        gitCounts && typeof gitCounts === "object"
          ? `git dirty=${String((gitSummary as Record<string, unknown>).dirty)} counts=${JSON.stringify(gitCounts)}`
          : undefined,
        skippedChecks.length > 0 ? `skipped=${skippedChecks.join(",")}` : undefined,
        ...failures.map((failure) => `- ${failure}`),
      ]
        .filter(Boolean)
        .join("\n") + "\n",
);

process.exitCode = result.ok ? 0 : 1;
