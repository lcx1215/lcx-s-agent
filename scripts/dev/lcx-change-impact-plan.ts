import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type PathRule = {
  id: string;
  lane: string;
  patterns: RegExp[];
  requiredChecks: string[];
  commands: string[];
  deferredCommands?: string[];
  safetyNotes?: string[];
  headTailRequired?: boolean;
  risk?: "normal" | "elevated";
};

type Impact = {
  id: string;
  lane: string;
  matchedFiles: string[];
  requiredChecks: string[];
  commands: string[];
  deferredCommands: string[];
  safetyNotes: string[];
  headTailRequired: boolean;
  risk: "normal" | "elevated";
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const execFileAsync = promisify(execFile);

const PATH_RULES: PathRule[] = [
  {
    id: "doctrine_or_runbook",
    lane: "global_doctrine_and_runbook",
    patterns: [
      /^AGENTS\.md$/u,
      /^README\.md$/u,
      /^ops\/local-brain\/README\.md$/u,
      /^docs\/tools\/finance-learning-pipeline-runbook\.md$/u,
    ],
    requiredChecks: ["doctrine-consistency", "head-tail-consistency"],
    commands: [
      "node --import tsx scripts/dev/lcx-doctrine-consistency.ts --json",
      "node --import tsx scripts/dev/lcx-head-tail-consistency.ts --json",
    ],
    headTailRequired: true,
  },
  {
    id: "architecture_supervision_stack",
    lane: "global_doctrine_and_runbook",
    patterns: [
      /^scripts\/dev\/lcx-change-impact-plan\.ts$/u,
      /^scripts\/dev\/lcx-local-paths\.ts$/u,
      /^scripts\/dev\/lcx-context-recovery-exam\.ts$/u,
      /^scripts\/dev\/lcx-agent-exam\.ts$/u,
      /^scripts\/dev\/lcx-flow-graph\.ts$/u,
      /^scripts\/dev\/lcx-head-tail-consistency\.ts$/u,
      /^scripts\/dev\/lcx-mind-model\.ts$/u,
      /^scripts\/dev\/lcx-problem-cluster-radar\.ts$/u,
      /^scripts\/dev\/lcx-system-doctor\.ts$/u,
      /^test\/lcx-problem-cluster-radar\.test\.ts$/u,
    ],
    requiredChecks: ["head-tail-consistency", "architecture-supervision-tests"],
    commands: [
      "node --import tsx scripts/dev/lcx-head-tail-consistency.ts --json",
      "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      "pnpm vitest run test/lcx-change-impact-plan.test.ts test/lcx-flow-graph.test.ts test/lcx-mind-model.test.ts test/lcx-context-recovery-exam.test.ts test/lcx-agent-exam.test.ts test/lcx-problem-cluster-radar.test.ts",
    ],
    deferredCommands: ["pnpm vitest run test/local-brain-distill-eval.test.ts"],
    safetyNotes: [
      "Run deferred local-brain-distill-eval tests only after local-brain-training-plan shows no active guard/eval/MLX process; do not create overlapping heavy eval.",
    ],
    headTailRequired: true,
  },
  {
    id: "local_brain_micro_surface",
    lane: "qwen_training_or_local_brain",
    patterns: [
      /^scripts\/dev\/local-brain-/u,
      /^scripts\/dev\/minimax-brain-/u,
      /^scripts\/dev\/minimax-quota-brain-saturator\.ts$/u,
      /^scripts\/dev\/finance-data-gateway-smoke\.ts$/u,
    ],
    requiredChecks: ["head-tail-consistency", "targeted-local-brain-tests"],
    commands: [
      "node --import tsx scripts/dev/lcx-head-tail-consistency.ts --json",
      "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      "pnpm vitest run test/local-brain-contracts.test.ts test/local-brain-training-plan.test.ts",
    ],
    deferredCommands: ["pnpm vitest run test/local-brain-distill-eval.test.ts"],
    safetyNotes: [
      "Run deferred local-brain-distill-eval tests only after local-brain-training-plan shows no active guard/eval/MLX process; do not create overlapping heavy eval.",
    ],
    headTailRequired: true,
  },
  {
    id: "module_learning_memory",
    lane: "memory_sedimentation",
    patterns: [
      /^scripts\/dev\/module-learning-pipeline-/u,
      /^scripts\/dev\/lcx-learning-sedimentation-bridge\.ts$/u,
      /^scripts\/dev\/lcx-learning-sedimentation-audit\.ts$/u,
      /^scripts\/dev\/lcx-learning-sedimentation-map\.ts$/u,
      /^scripts\/dev\/lcx-module-learning-absorption-gate\.ts$/u,
      /^scripts\/dev\/lcx-system-memory-sedimentation-gate\.ts$/u,
      /^src\/agents\/tools\/module-learning-pipeline-/u,
      /^test\/module-learning-pipeline-/u,
      /^test\/lcx-learning-sedimentation-bridge\.test\.ts$/u,
      /^test\/lcx-learning-sedimentation-audit\.test\.ts$/u,
      /^test\/lcx-learning-sedimentation-map\.test\.ts$/u,
      /^test\/lcx-module-learning-absorption-gate\.test\.ts$/u,
      /^test\/lcx-system-memory-sedimentation-gate\.test\.ts$/u,
    ],
    requiredChecks: ["head-tail-consistency", "module-learning-tests"],
    commands: [
      "node --import tsx scripts/dev/lcx-head-tail-consistency.ts --json",
      "pnpm vitest run test/lcx-learning-sedimentation-bridge.test.ts test/lcx-learning-sedimentation-audit.test.ts test/lcx-learning-sedimentation-map.test.ts test/lcx-module-learning-absorption-gate.test.ts test/lcx-system-memory-sedimentation-gate.test.ts src/agents/tools/module-learning-pipeline-plan-tool.test.ts src/agents/tools/module-learning-pipeline-review-tool.test.ts test/module-learning-pipeline-plan-cli.test.ts test/module-learning-pipeline-review-cli.test.ts",
    ],
    headTailRequired: true,
  },
  {
    id: "system_prompt_or_agent_tools",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/agents\/system-prompt\.ts$/u,
      /^src\/agents\/openclaw-tools\.ts$/u,
      /^src\/agents\/finance-brain-orchestration\.ts$/u,
      /^src\/agents\/finance-data-gateway\.ts$/u,
      /^src\/agents\/tools\//u,
    ],
    requiredChecks: ["head-tail-consistency", "system-prompt-tests"],
    commands: [
      "node --import tsx scripts/dev/lcx-head-tail-consistency.ts --json",
      "pnpm vitest run src/agents/system-prompt.test.ts",
    ],
    headTailRequired: true,
  },
  {
    id: "lark_feishu_visible_surface",
    lane: "lark_feishu_visible_reply",
    patterns: [
      /^scripts\/dev\/lcx-commercial-answer-pipeline\.ts$/u,
      /^extensions\/feishu\//u,
      /^src\/auto-reply\/reply\/skill-autocue\.ts$/u,
      /^src\/auto-reply\/reply\/feishu-reply-flow-evidence\.ts$/u,
      /^src\/commands\/capabilities\/lark-/u,
    ],
    requiredChecks: ["lark-regression-tests", "dev-live-boundary-check"],
    commands: [
      "pnpm vitest run extensions/feishu/src/bot.test.ts extensions/feishu/src/lark-api-route-provider.test.ts extensions/feishu/src/real-utterances-regression.test.ts",
      "node --import tsx scripts/dev/lcx-system-doctor.ts --json",
    ],
    risk: "elevated",
  },
  {
    id: "automation_or_operator_loop",
    lane: "local_automation",
    patterns: [
      /^scripts\/dev\/lcx-local-operator/u,
      /^scripts\/dev\/codex-archive/u,
      /^ops\/local-automation/u,
    ],
    requiredChecks: ["automation-smoke", "doctor"],
    commands: ["node --import tsx scripts/dev/lcx-system-doctor.ts --json"],
    risk: "elevated",
  },
  {
    id: "live_or_provider_boundary",
    lane: "dev_live_boundary",
    patterns: [
      /^src\/agents\/model-auth/u,
      /^src\/config\//u,
      /^extensions\/feishu\/src\/.*sender/u,
      /^scripts\/live/u,
    ],
    requiredChecks: ["explicit-live-boundary-review", "doctor"],
    commands: ["node --import tsx scripts/dev/lcx-system-doctor.ts --json"],
    risk: "elevated",
  },
  {
    id: "test_file_changed",
    lane: "test_surface",
    patterns: [/(^|\/)[^/]+\.test\.ts$/u],
    requiredChecks: ["run-changed-tests"],
    commands: [],
  },
];

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-change-impact-plan.ts [--json] [--changed PATH ...]",
      "",
      "Fast path-based impact plan for micro changes. When --changed is omitted,",
      "reads git status/diff and recommends the impact-appropriate verification set.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
  const options: { json: boolean; changed: string[] } = { json: false, changed: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--changed") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        usage();
      }
      options.changed.push(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      options.changed.push(arg);
    }
  }
  return options;
}

async function gitChangedFiles(): Promise<string[]> {
  const [diff, status] = await Promise.all([
    execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: repoRoot }),
    execFileAsync("git", ["status", "--short"], { cwd: repoRoot }),
  ]);
  const changed = new Set(
    diff.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (const line of status.stdout.split(/\r?\n/u)) {
    const file = line.slice(3).trim();
    if (file) {
      changed.add(file);
    }
  }
  return [...changed].toSorted();
}

function normalizeChangedFiles(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].toSorted();
}

function impactFor(files: readonly string[]): Impact[] {
  return PATH_RULES.map((rule) => {
    const matchedFiles = files.filter((file) =>
      rule.patterns.some((pattern) => pattern.test(file)),
    );
    if (matchedFiles.length === 0) {
      return undefined;
    }
    const commands = [...rule.commands];
    if (rule.id === "test_file_changed") {
      commands.push(`pnpm vitest run ${matchedFiles.join(" ")}`);
    }
    return {
      id: rule.id,
      lane: rule.lane,
      matchedFiles,
      requiredChecks: rule.requiredChecks,
      commands,
      deferredCommands: rule.deferredCommands ?? [],
      safetyNotes: rule.safetyNotes ?? [],
      headTailRequired: rule.headTailRequired === true,
      risk: rule.risk ?? "normal",
    };
  }).filter((impact): impact is Impact => impact !== undefined);
}

function uniqueCommands(impacts: readonly Impact[]): string[] {
  return [
    ...new Set([
      ...impacts.flatMap((impact) => impact.commands),
      "git diff --check",
      "pnpm exec oxfmt --check <touched-files>",
    ]),
  ];
}

function uniqueDeferredCommands(impacts: readonly Impact[]): string[] {
  return [...new Set(impacts.flatMap((impact) => impact.deferredCommands))];
}

function uniqueSafetyNotes(impacts: readonly Impact[]): string[] {
  return [...new Set(impacts.flatMap((impact) => impact.safetyNotes))];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const changedFiles =
    options.changed.length > 0
      ? normalizeChangedFiles(options.changed)
      : normalizeChangedFiles(await gitChangedFiles());
  const impacts = impactFor(changedFiles);
  const deferredCommands = uniqueDeferredCommands(impacts);
  const safetyNotes = uniqueSafetyNotes(impacts);
  const unmatchedFiles = changedFiles.filter(
    (file) => !impacts.some((impact) => impact.matchedFiles.includes(file)),
  );
  const result = {
    ok: true,
    boundary: "dev_change_impact_plan_only",
    checkedAt: new Date().toISOString(),
    changedFiles,
    affectedLanes: [...new Set(impacts.map((impact) => impact.lane))],
    impacts,
    unmatchedFiles,
    recommendedFastCommands:
      impacts.length > 0
        ? uniqueCommands(impacts)
        : ["git status --short --branch", "git diff --check"],
    deferredCommands,
    safetyNotes,
    escalation: {
      runFullDoctor:
        impacts.some((impact) => impact.risk === "elevated" || impact.headTailRequired) ||
        changedFiles.length > 6,
      reason:
        impacts.length === 0
          ? "no mapped impact; inspect manually if files are not trivial"
          : "mapped micro-change lanes produced focused checks",
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx change impact plan files=${changedFiles.length} lanes=${result.affectedLanes.join(",") || "none"}`,
          ...result.recommendedFastCommands.map((command) => `- ${command}`),
          ...deferredCommands.map((command) => `- deferred: ${command}`),
          ...safetyNotes.map((note) => `- note: ${note}`),
        ].join("\n") + "\n",
  );
}

await main();
