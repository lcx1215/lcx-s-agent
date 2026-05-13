import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const LCX_USER_HOME = process.env.LCX_USER_HOME ?? "/Users/liuchengxu";
const LOCAL_OPERATOR_LATEST = path.join(
  LCX_USER_HOME,
  ".openclaw",
  "workspace",
  "state",
  "lcx-local-operator-latest.json",
);
const MAX_OPERATOR_STATE_AGE_MS = 3 * 60 * 60 * 1000;

type RecoveryCheck = {
  id: string;
  ok: boolean;
  summary: string;
  evidence?: unknown;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-context-recovery-exam.ts [--json]",
      "",
      "Read-only compressed-context recovery exam. It verifies a future Codex or Claude",
      "window can recover LCX Agent state from durable files instead of chat memory.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8").catch(() => "");
}

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function includesAll(text: string, terms: readonly string[]): boolean {
  const normalized = text.replace(/\s+/gu, " ").toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

function nestedBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function isoAgeMs(value: unknown, nowMs = Date.now()): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return undefined;
  }
  return nowMs - time;
}

async function mindModelCheck(): Promise<RecoveryCheck> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/lcx-mind-model.ts", "--json"],
      { cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown> | undefined;
    return {
      id: "mind_model_recovers_macro_workflow",
      ok: payload.ok === true,
      summary: "lcx-mind-model must pass without chat context",
      evidence: {
        boundary: payload.boundary,
        passed: summary?.passed,
        failed: summary?.failed,
        missingSurfaceFiles: payload.missingSurfaceFiles,
        actionableFailures: payload.actionableFailures,
      },
    };
  } catch (error) {
    return {
      id: "mind_model_recovers_macro_workflow",
      ok: false,
      summary: "lcx-mind-model must pass without chat context",
      evidence: String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [agents, runbook, changeImpact, latestState, mindModel] = await Promise.all([
    readText(path.join(repoRoot, "AGENTS.md")),
    readText(path.join(repoRoot, "ops/local-brain/README.md")),
    readText(path.join(repoRoot, "scripts/dev/lcx-change-impact-plan.ts")),
    readJson(LOCAL_OPERATOR_LATEST),
    mindModelCheck(),
  ]);

  const latestMindModel = latestState?.mindModel as Record<string, unknown> | undefined;
  const latestContextRecovery = latestState?.contextRecovery as Record<string, unknown> | undefined;
  const latestTrainingPlan = latestState?.trainingPlan as Record<string, unknown> | undefined;
  const latestOperatorAgeMs = isoAgeMs(latestState?.checkedAt);

  const checks: RecoveryCheck[] = [
    {
      id: "fixed_evidence_recovery_commands_present",
      ok: includesAll(agents + "\n" + runbook, [
        "ops/local-brain/README.md",
        "lcx-system-doctor",
        "local-brain-training-plan",
        "lcx-local-operator-latest.json",
        "lcx-mind-model",
      ]),
      summary: "AGENTS and runbook must tell a new window how to recover state",
    },
    {
      id: "micro_change_planner_keeps_master_lane",
      ok: includesAll(changeImpact, [
        "PATH_RULES",
        "recommendedFastCommands",
        "headTailRequired",
        "lcx-mind-model",
      ]),
      summary: "micro changes must still map into a master lane and proof set",
    },
    mindModel,
    {
      id: "local_operator_latest_is_readable",
      ok:
        latestState !== undefined &&
        latestState.boundary === "dev_local_observability_only" &&
        nestedBoolean(latestState, "liveTouched") === false &&
        nestedBoolean(latestState, "providerConfigTouched") === false &&
        nestedBoolean(latestState, "protectedMemoryTouched") === false,
      summary: "local operator latest state must be readable and boundary-clean",
      evidence: latestState
        ? {
            checkedAt: latestState.checkedAt,
            ok: latestState.ok,
            boundary: latestState.boundary,
            hasMindModel: latestMindModel !== undefined,
            hasContextRecovery: latestContextRecovery !== undefined,
          }
        : { path: LOCAL_OPERATOR_LATEST, missing: true },
    },
    {
      id: "local_operator_latest_is_fresh",
      ok:
        latestState !== undefined &&
        latestOperatorAgeMs !== undefined &&
        latestOperatorAgeMs >= 0 &&
        latestOperatorAgeMs <= MAX_OPERATOR_STATE_AGE_MS,
      summary: "local operator latest state must be fresh enough for compressed recovery",
      evidence: latestState
        ? {
            checkedAt: latestState.checkedAt,
            operatorStateAgeMs: latestOperatorAgeMs,
            maxOperatorStateAgeMs: MAX_OPERATOR_STATE_AGE_MS,
          }
        : { path: LOCAL_OPERATOR_LATEST, missing: true },
    },
    {
      id: "local_operator_digest_contains_mind_model",
      ok:
        latestState === undefined ||
        (latestMindModel?.boundary === "dev_mind_model_only" &&
          typeof latestMindModel.passed === "number" &&
          typeof latestMindModel.failed === "number" &&
          latestContextRecovery?.boundary === "dev_context_recovery_exam_only"),
      summary: "operator digest should expose mind-model and context-recovery status",
      evidence: {
        mindModel: latestMindModel,
        contextRecovery: latestContextRecovery,
      },
    },
    {
      id: "training_plan_decision_visible_after_recovery",
      ok:
        latestState === undefined ||
        latestTrainingPlan === undefined ||
        Array.isArray(latestTrainingPlan.decisions),
      summary: "compressed recovery must keep the training-plan next decision visible",
      evidence: latestTrainingPlan,
    },
  ];

  const failed = checks.filter((check) => !check.ok);
  const result = {
    ok: failed.length === 0,
    boundary: "dev_context_recovery_exam_only",
    checkedAt: new Date().toISOString(),
    compressedContextRecovered: failed.length === 0,
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      total: checks.length,
    },
    requiredRecoveryCommands: [
      "sed -n '1,220p' ops/local-brain/README.md",
      "node --import tsx scripts/dev/lcx-mind-model.ts --json",
      "node --import tsx scripts/dev/lcx-system-doctor.ts --json",
      "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      "test -f /Users/liuchengxu/.openclaw/workspace/state/lcx-local-operator-latest.json && sed -n '1,220p' /Users/liuchengxu/.openclaw/workspace/state/lcx-local-operator-latest.json",
    ],
    checks,
    actionableFailures: failed.map((check) => `${check.id}: ${check.summary}`),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx context recovery ${result.ok ? "ok" : "failed"}`,
          `passed=${result.summary.passed} failed=${result.summary.failed} total=${result.summary.total}`,
          ...failed.map((check) => `- ${check.id}: ${check.summary}`),
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
