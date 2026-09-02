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
    id: "physical_path_migration",
    lane: "repository_cleanup",
    patterns: [
      /^scripts\/dev\//u,
      /^test\/dev\//u,
      /^ops\/live-handoff\//u,
      /^ops\/external-channel-acceptance-runbook\.md$/u,
      /^vitest\.scripts-dev\.config\.ts$/u,
      /^(?:scripts\/dev|test\/dev|ops\/live-handoff|ops\/external-channel-acceptance-runbook)[^>]* -> .+$/u,
      /^(?:scripts\/operator|test\/operator|ops\/external-channel-(?:history|artifacts))\/$/u,
    ],
    requiredChecks: ["physical-path-scan", "git-diff-check"],
    commands: [
      "rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' '(scripts/dev|test/dev|ops/live-handoff|external-channel-acceptance-runbook)' .",
      "git diff --check",
    ],
    safetyNotes: [
      "Canonical local control paths are scripts/operator, test/operator, and ops/external-channel-*; old paths may appear only as deletion/compatibility evidence during migration.",
    ],
  },
  {
    id: "retired_artifact_cleanup",
    lane: "repository_cleanup",
    patterns: [
      /^\.tmp\/mixprobe-train\.log$/u,
      /^docs\/lcx-capability-review-20260702\.md$/u,
      /^ops\/dev-full-loop-acceptance\/2026-05-(?:05T(?:10-00-26Z-cross-market-local-brain|15-04-30Z-cross-market-local-brain|20-43-40Z-dev-acceptance-local-brain)|06T(?:013538Z|063417Z|114336Z)|07T22-53-39Z-local-memory-activation)\.md$/u,
      /^ops\/paper-learning-audit\/2026-05-06T(?:022029Z|072258Z|122450Z|172709Z)-paper-learning-internalization-audit\.md$/u,
    ],
    requiredChecks: ["cleanup-reference-review", "git-diff-check"],
    commands: ["git diff --check"],
    safetyNotes: [
      "Retired logs and audit receipts are deletion-only artifacts; verify exact paths have no runtime, test, or index references before removal.",
      "Do not extend this lane to ops/external-channel-history or external runtime state; those remain compatibility/history surfaces with active owners.",
    ],
  },
  {
    id: "doctrine_or_runbook",
    lane: "global_doctrine_and_runbook",
    patterns: [
      /^AGENTS\.md$/u,
      /^MEMORY\.md$/u,
      /^\.gitignore$/u,
      /^README\.md$/u,
      /^ops\/local-brain\/README\.md$/u,
      /^ops\/codex_handoff\.md$/u,
      /^ops\/automation\/repair-lock-protocol\.md$/u,
      /^ops\/external-channel-acceptance-runbook\.md$/u,
      /^ops\/lobster-l4-system-map\.md$/u,
      /^docs\/tools\/finance-learning-pipeline-runbook\.md$/u,
      /^docs\/help\/testing\.md$/u,
      /^docs\/tools\/(?:lcx-system-doctor|local-brain-distillation|local-brain-open-evals)\.md$/u,
    ],
    requiredChecks: ["doctrine-consistency", "head-tail-consistency"],
    commands: [
      "node --import tsx scripts/operator/lcx-doctrine-consistency.ts --json",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    headTailRequired: true,
  },
  {
    id: "architecture_supervision_stack",
    lane: "global_doctrine_and_runbook",
    patterns: [
      /^scripts\/operator\/lcx-change-impact-plan\.ts$/u,
      /^scripts\/operator\/lcx-local-paths\.ts$/u,
      /^scripts\/operator\/lcx-context-recovery-exam\.ts$/u,
      /^scripts\/operator\/lcx-agent-exam\.ts$/u,
      /^scripts\/operator\/lcx-commercial-acceptance-harness\.ts$/u,
      /^scripts\/operator\/lcx-doctrine-consistency\.ts$/u,
      /^scripts\/operator\/lcx-external-agent-upgrade-radar\.ts$/u,
      /^scripts\/operator\/lcx-flow-graph\.ts$/u,
      /^scripts\/operator\/lcx-github-cli-capability-inventory\.ts$/u,
      /^scripts\/operator\/lcx-governance-autopilot\.ts$/u,
      /^scripts\/operator\/lcx-head-tail-consistency\.ts$/u,
      /^scripts\/operator\/lcx-live-fadeout-audit\.ts$/u,
      /^scripts\/operator\/lcx-external-channel-binding\.ts$/u,
      /^scripts\/operator\/lcx-mind-model\.ts$/u,
      /^scripts\/operator\/lcx-problem-cluster-radar\.ts$/u,
      /^scripts\/operator\/lcx-provider-council-acceleration\.ts$/u,
      /^scripts\/operator\/lcx-skillopt-lite\.ts$/u,
      /^scripts\/operator\/lcx-system-doctor\.ts$/u,
      /^scripts\/operator\/lcx-ts-python-boundary\.ts$/u,
      /^scripts\/operator\/lcx-universe-index\.ts$/u,
      /^scripts\/operator\/lcx-ontology\.ts$/u,
      /^scripts\/operator\/lcx-projection-reader-audit\.ts$/u,
      /^src\/shared\/lcx-ontology\.ts$/u,
      /^scripts\/generate-lcx-agent-progress-wave\.mjs$/u,
      /^package\.json$/u,
      /^test\/lcx-commercial-acceptance-harness\.test\.ts$/u,
      /^test\/lcx-external-agent-upgrade-radar\.test\.ts$/u,
      /^test\/lcx-github-cli-capability-inventory\.test\.ts$/u,
      /^test\/lcx-governance-autopilot\.test\.ts$/u,
      /^test\/lcx-live-fadeout-audit\.test\.ts$/u,
      /^test\/lcx-external-channel-binding\.test\.ts$/u,
      /^test\/lcx-problem-cluster-radar\.test\.ts$/u,
      /^test\/lcx-provider-council-acceleration\.test\.ts$/u,
      /^test\/lcx-skillopt-lite\.test\.ts$/u,
      /^test\/lcx-ts-python-boundary\.test\.ts$/u,
      /^test\/lcx-universe-index\.test\.ts$/u,
      /^test\/lcx-projection-reader-audit\.test\.ts$/u,
    ],
    requiredChecks: ["head-tail-consistency", "architecture-supervision-tests"],
    commands: [
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
      "node --import tsx scripts/operator/local-brain-training-plan.ts --json",
      "pnpm vitest run test/lcx-change-impact-plan.test.ts test/lcx-flow-graph.test.ts test/lcx-mind-model.test.ts test/lcx-context-recovery-exam.test.ts test/lcx-agent-exam.test.ts test/lcx-problem-cluster-radar.test.ts test/lcx-commercial-acceptance-harness.test.ts test/lcx-governance-autopilot.test.ts test/lcx-external-agent-upgrade-radar.test.ts test/lcx-live-fadeout-audit.test.ts test/lcx-skillopt-lite.test.ts test/lcx-provider-council-acceleration.test.ts test/lcx-ts-python-boundary.test.ts test/lcx-universe-index.test.ts",
    ],
    deferredCommands: ["pnpm vitest run test/local-brain-distill-eval.test.ts"],
    safetyNotes: [
      "Run deferred local-brain-distill-eval tests only after local-brain-training-plan shows no active guard/eval/MLX process; do not create overlapping heavy eval.",
    ],
    headTailRequired: true,
  },
  {
    id: "multi_agent_pattern_shadow",
    lane: "agent_workflow_memory",
    patterns: [
      /^ops\/external-learning\/2026-09-01-multi-agent-pattern-intake\.md$/u,
      /^scripts\/operator\/lcx-multi-agent-pattern-shadow\.ts$/u,
      /^test\/fixtures\/lcx-multi-agent-pattern-shadow-executor\.ts$/u,
      /^test\/lcx-multi-agent-pattern-shadow\.test\.ts$/u,
    ],
    requiredChecks: [
      "multi-agent-pattern-replay",
      "shadow-contract-tests",
      "head-tail-consistency",
    ],
    commands: [
      "node --import tsx scripts/operator/lcx-multi-agent-pattern-shadow.ts --mode replay --pattern all --case single_stock_loss_recovery_risk_triage --json",
      "pnpm vitest run test/lcx-multi-agent-pattern-shadow.test.ts",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    safetyNotes: [
      "Replay is the default verification path; isolated executor/live remains blocked without an explicit executor command and never grants provider, training, or external-channel authority.",
    ],
    headTailRequired: true,
    risk: "elevated",
  },
  {
    id: "logical_agent_pool",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/agents\/logical-agent-pool\.ts$/u,
      /^src\/agents\/logical-agent-pool\.test\.ts$/u,
      /^scripts\/operator\/lcx-logical-agent-pool\.ts$/u,
      /^ops\/local-brain\/logical-agent-pool\.md$/u,
    ],
    requiredChecks: ["logical-agent-pool-tests", "head-tail-consistency"],
    commands: [
      "node --import tsx scripts/operator/lcx-logical-agent-pool.ts --demo --json",
      "pnpm vitest run src/agents/logical-agent-pool.test.ts",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    safetyNotes: [
      "The pool is local orchestration only: one model slot by default, no provider calls, external sender, protected-memory, or trading authority.",
    ],
    headTailRequired: true,
  },
  {
    id: "runtime_skill_package",
    lane: "skill_runtime",
    patterns: [/^skills\//u],
    requiredChecks: ["skill-autocue-tests", "git-diff-check"],
    commands: [
      "pnpm vitest run src/auto-reply/reply/skill-autocue.test.ts src/agents/skills.test.ts",
      "git diff --check",
    ],
    safetyNotes: [
      "Runtime skills are local instructions only; do not grant provider, training, protected-memory, or external-sender authority.",
    ],
  },
  {
    id: "ts_python_boundary",
    lane: "global_doctrine_and_runbook",
    patterns: [/\.pyi?$/u],
    requiredChecks: ["ts-python-boundary"],
    commands: ["node --import tsx scripts/operator/lcx-ts-python-boundary.ts --json"],
    safetyNotes: [
      "Python changes must be classified as keep, wrap, or migrate; TS remains the control plane.",
    ],
  },
  {
    id: "local_brain_micro_surface",
    lane: "qwen_training_or_local_brain",
    patterns: [
      /^scripts\/operator\/local-brain-/u,
      /^scripts\/operator\/minimax-brain-/u,
      /^scripts\/operator\/minimax-provider-quota-saturator\.ts$/u,
      /^scripts\/operator\/minimax-quota-brain-saturator\.ts$/u,
      /^scripts\/operator\/finance-data-gateway-smoke\.ts$/u,
      /^evals\/local-brain\/promptfoo\.yaml$/u,
      /^test\/fixtures\/local-brain-open-eval-provider\.ts$/u,
    ],
    requiredChecks: ["head-tail-consistency", "targeted-local-brain-tests"],
    commands: [
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
      "node --import tsx scripts/operator/local-brain-training-plan.ts --json",
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
      /^scripts\/operator\/module-learning-pipeline-/u,
      /^scripts\/operator\/lcx-learning-sedimentation-bridge\.ts$/u,
      /^scripts\/operator\/lcx-learning-sedimentation-audit\.ts$/u,
      /^scripts\/operator\/lcx-learning-sedimentation-map\.ts$/u,
      /^scripts\/operator\/lcx-module-learning-absorption-gate\.ts$/u,
      /^scripts\/operator\/lcx-self-repair-hands\.ts$/u,
      /^scripts\/operator\/lcx-system-memory-sedimentation-gate\.ts$/u,
      /^src\/agents\/tools\/module-learning-pipeline-/u,
      /^test\/module-learning-pipeline-/u,
      /^test\/lcx-learning-sedimentation-bridge\.test\.ts$/u,
      /^test\/lcx-learning-sedimentation-audit\.test\.ts$/u,
      /^test\/lcx-learning-sedimentation-map\.test\.ts$/u,
      /^test\/lcx-module-learning-absorption-gate\.test\.ts$/u,
      /^test\/lcx-self-repair-hands\.test\.ts$/u,
      /^test\/lcx-system-memory-sedimentation-gate\.test\.ts$/u,
    ],
    requiredChecks: ["head-tail-consistency", "module-learning-tests"],
    commands: [
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
      "pnpm vitest run test/lcx-learning-sedimentation-bridge.test.ts test/lcx-learning-sedimentation-audit.test.ts test/lcx-learning-sedimentation-map.test.ts test/lcx-module-learning-absorption-gate.test.ts test/lcx-self-repair-hands.test.ts test/lcx-system-memory-sedimentation-gate.test.ts src/agents/tools/module-learning-pipeline-plan-tool.test.ts src/agents/tools/module-learning-pipeline-review-tool.test.ts test/module-learning-pipeline-plan-cli.test.ts test/module-learning-pipeline-review-cli.test.ts",
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
      /^src\/agents\/finance-answer-composer\.ts$/u,
      /^src\/agents\/finance-live-market-source\.ts$/u,
      /^src\/agents\/tools\//u,
      /^src\/hooks\/bundled\/lobster-brain-registry\.ts$/u,
      /^scripts\/operator\/lcx-projection-reader-audit\.ts$/u,
      /^src\/cli\/capabilities-cli\.ts$/u,
      /^src\/shared\/global-evidence-projection\.ts$/u,
      /^src\/shared\/global-evidence-projection-read\.ts$/u,
    ],
    requiredChecks: ["head-tail-consistency", "system-prompt-tests"],
    commands: [
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
      "pnpm vitest run src/agents/system-prompt.test.ts",
    ],
    headTailRequired: true,
  },
  {
    id: "external_message_visible_surface",
    lane: "external_message_visible_reply",
    patterns: [
      /^scripts\/operator\/lcx-commercial-answer-pipeline\.ts$/u,
      /^scripts\/operator\/lcx-directed-daily-research-brief\.ts$/u,
      /^scripts\/operator\/lcx-external-short-intent-fuzzer\.ts$/u,
      /^scripts\/operator\/lcx-visible-answer-quality-fuzzer\.ts$/u,
      /^scripts\/operator\/agent-system-loop-smoke\.ts$/u,
      /^extensions\/external\//u,
      /^src\/auto-reply\/reply\/dispatch-from-config\.ts$/u,
      /^src\/auto-reply\/reply\/get-reply-run\.ts$/u,
      /^src\/auto-reply\/reply\/commands-protocol-families\.ts$/u,
      /^src\/auto-reply\/reply\/skill-autocue\.ts$/u,
      /^src\/auto-reply\/reply\/skillopt-autocue\.ts$/u,
      /^src\/auto-reply\/reply\/skillopt-autocue\.test\.ts$/u,
      /^src\/agents\/answer-audit-policy\.ts$/u,
      /^src\/agents\/visible-answer-adoption-gate\.ts$/u,
      /^src\/auto-reply\/reply\/commands-protocol-info\.ts$/u,
      /^extensions\/external\/src\/(?:channel|monitor|protocol|send)\.ts$/u,
      /^src\/commands\/capabilities\/l5-system-eval\.ts$/u,
    ],
    requiredChecks: ["external-regression-tests", "core-external-channel-boundary-check"],
    commands: [
      "pnpm vitest run src/auto-reply/reply/skill-autocue.test.ts src/auto-reply/reply/skillopt-autocue.test.ts",
      "pnpm exec vitest run extensions/external/src/accounts.test.ts extensions/external/src/monitor.test.ts extensions/external/src/protocol.test.ts extensions/external/src/security.test.ts extensions/external/src/send.test.ts",
      "node --import tsx scripts/operator/lcx-external-channel-status.ts --json",
    ],
    risk: "elevated",
  },
  {
    id: "automation_or_operator_loop",
    lane: "local_automation",
    patterns: [
      /^scripts\/operator\/lcx-local-operator/u,
      /^scripts\/operator\/lcx-local-failure-trace\.ts$/u,
      /^scripts\/operator\/lcx-monotonic-data-ledger\.ts$/u,
      /^scripts\/operator\/lcx-automation-repair-lock\.ts$/u,
      /^scripts\/operator\/codex-archive/u,
      /^src\/hooks\/bundled\/operating-(?:daily-workface|loop|weekly-review)\/handler\.ts$/u,
      /^ops\/local-automation/u,
    ],
    requiredChecks: ["automation-smoke", "doctor"],
    commands: ["node --import tsx scripts/operator/lcx-system-doctor.ts --json"],
    risk: "elevated",
  },
  {
    id: "owner_control_room_surface",
    lane: "local_automation",
    patterns: [
      /^apps\/web\//u,
      /^scripts\/operator\/lcx-farm-web-server\.ts$/u,
      /^scripts\/operator\/lcx-owner-brief\.ts$/u,
      /^scripts\/operator\/lcx-owner-control-map\.ts$/u,
      /^scripts\/operator\/lcx-real-cost-ledger\.ts$/u,
      /^test\/lcx-local-failure-trace\.test\.ts$/u,
      /^test\/lcx-monotonic-data-ledger\.test\.ts$/u,
      /^test\/lcx-owner-brief\.test\.ts$/u,
      /^test\/lcx-owner-control-map\.test\.ts$/u,
      /^test\/lcx-real-cost-ledger\.test\.ts$/u,
      /^tmp-lcx-owner-dashboard.*\.png$/u,
    ],
    requiredChecks: ["owner-dashboard-smoke", "observability-tests"],
    commands: [
      "pnpm vitest run test/lcx-local-failure-trace.test.ts test/lcx-monotonic-data-ledger.test.ts test/lcx-owner-brief.test.ts test/lcx-owner-control-map.test.ts test/lcx-real-cost-ledger.test.ts",
      "node --import tsx scripts/operator/lcx-real-cost-ledger.ts --json",
    ],
    safetyNotes: [
      "Owner dashboard files are read-only observability surfaces; screenshots should be deleted or explicitly kept before commit.",
    ],
  },
  {
    id: "macos_owner_control_room",
    lane: "local_automation",
    patterns: [
      /^apps\/macos\/Sources\/OpenClaw\/DebugActions\.swift$/u,
      /^apps\/macos\/Sources\/OpenClaw\/LCXAgentControlRoom\.swift$/u,
      /^apps\/macos\/Sources\/OpenClaw\/LCXAgentControlRoomView\.swift$/u,
      /^apps\/macos\/Sources\/OpenClaw\/MenuContentView\.swift$/u,
      /^apps\/macos\/Tests\/OpenClawIPCTests\/LCXAgentControlRoomTests\.swift$/u,
    ],
    requiredChecks: ["macos-control-room-build-or-test"],
    commands: ["xcodebuild -list"],
    safetyNotes: [
      "macOS control-room files are local UI only; do not treat them as external-channel or legacy live External proof.",
    ],
    risk: "elevated",
  },
  {
    id: "operator_runbook_docs",
    lane: "global_doctrine_and_runbook",
    patterns: [/^ops\/codex-remote-devbox-and-browser-runbook\.md$/u],
    requiredChecks: ["doctrine-consistency"],
    commands: ["node --import tsx scripts/operator/lcx-doctrine-consistency.ts --json"],
  },
  {
    id: "live_or_provider_boundary",
    lane: "local_live_boundary",
    patterns: [
      /^scripts\/operator\/lcx-external-channel-status\.ts$/u,
      /^test\/lcx-external-channel-status\.test\.ts$/u,
      /^scripts\/operator\/lcx-external-channel-compat\.ts$/u,
      /^scripts\/operator\/external-channel-sidecar-runtime-bundle\.ts$/u,
      /^test\/lcx-external-channel-compat-status\.test\.ts$/u,
      /^src\/daemon\/inspect\.ts$/u,
      /^src\/agents\/model-auth/u,
      /^src\/config\//u,
      /^extensions\/external\/src\/(?:send|monitor)\.ts$/u,
      /^scripts\/live/u,
    ],
    requiredChecks: ["explicit-live-boundary-review", "doctor"],
    commands: [
      "node --import tsx scripts/operator/lcx-external-channel-status.ts --json",
      "pnpm vitest run test/lcx-external-channel-compat-status.test.ts",
      "node --import tsx scripts/operator/lcx-system-doctor.ts --json",
    ],
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
      "Usage: node --import tsx scripts/operator/lcx-change-impact-plan.ts [--json] [--changed PATH ...] [--files PATH ...]",
      "",
      "Fast path-based impact plan for micro changes. --changed accepts one PATH per flag;",
      "--files accepts one or more PATH values until the next flag. When explicit files",
      "are omitted, reads git status/diff and recommends the impact-appropriate verification set.",
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
    } else if (arg === "--files") {
      let consumed = 0;
      while (args[index + 1 + consumed] && !args[index + 1 + consumed].startsWith("--")) {
        options.changed.push(args[index + 1 + consumed]);
        consumed += 1;
      }
      if (consumed === 0) {
        usage();
      }
      index += consumed;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      options.changed.push(arg);
    }
  }
  return options;
}

async function gitChangedFiles(): Promise<string[]> {
  const gitRoot = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
  }).catch(() => undefined);
  if (!gitRoot || path.resolve(gitRoot.stdout.trim()) !== repoRoot) {
    return [];
  }

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
  const strayGate = {
    ok: unmatchedFiles.length === 0,
    rule: "every changed file must match at least one owner lane",
    unmatchedChangedFiles: unmatchedFiles,
    nextAction:
      unmatchedFiles.length === 0
        ? "none"
        : "add an owner rule, move the file under an owned path, ignore generated output, or delete the artifact",
  };
  const result = {
    ok: strayGate.ok,
    boundary: "local_change_impact_plan_only",
    checkedAt: new Date().toISOString(),
    changedFiles,
    affectedLanes: [...new Set(impacts.map((impact) => impact.lane))],
    impacts,
    unmatchedFiles,
    strayGate,
    recommendedFastCommands:
      impacts.length > 0
        ? uniqueCommands(impacts)
        : ["git status --short --branch", "git diff --check"],
    deferredCommands,
    safetyNotes,
    escalation: {
      runFullDoctor:
        impacts.some((impact) => impact.risk === "elevated" || impact.headTailRequired) ||
        changedFiles.length > 6 ||
        !strayGate.ok,
      reason: !strayGate.ok
        ? "unmatched changed files are not allowed; every changed file needs one owner lane"
        : impacts.length === 0
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
