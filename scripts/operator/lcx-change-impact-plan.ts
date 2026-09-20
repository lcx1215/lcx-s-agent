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
    // `serve` is a first-class entry surface (see AGENTS.md): it is the
    // daemon-free resident agent, so its lifecycle files own a lane of their
    // own instead of falling through `strayGate` as unmatched changes.
    id: "daemon_free_agent_entry",
    lane: "daemon_free_agent_entry",
    patterns: [/^src\/cli\/serve-detach\.ts$/u, /^src\/cli\/serve-standalone\.ts$/u],
    requiredChecks: [],
    commands: ["pnpm vitest run src/cli/serve-detach.test.ts src/cli/serve-cli.test.ts"],
  },
  {
    // Durable recall: per-session digests written at the end of every run, plus
    // read-only recall over the archived transcript store. Both are what let a
    // later session see earlier work without anyone asking for it.
    id: "session_recall",
    lane: "session_recall",
    patterns: [
      /^src\/agents\/rollout-summary\.ts$/u,
      /^src\/agents\/rollout-distill\.ts$/u,
      /^src\/plugins\/runtime\/runtime-tools\.ts$/u,
      /^src\/plugins\/runtime\/types-core\.ts$/u,
      /^extensions\/memory-core\/index\.ts$/u,
    ],
    requiredChecks: [],
    commands: [
      "pnpm vitest run src/agents/rollout-summary.test.ts src/agents/tools/session-history-tool.test.ts",
    ],
  },
  {
    // Memory index: FTS keyword recall is a standalone SQLite capability and
    // must stay usable without an embedding provider, so the config resolution
    // and the index manager own their own lane.
    id: "memory_index_recall",
    lane: "memory_index_recall",
    patterns: [
      /^src\/agents\/memory-search\.ts$/u,
      /^src\/memory\/manager\.ts$/u,
      // The index write path. Keyword recall is a standalone SQLite capability, so indexing
      // must still happen without an embedding provider; these files decide whether it does.
      /^src\/memory\/manager-embedding-ops\.ts$/u,
      /^src\/memory\/manager-sync-ops\.ts$/u,
      /^src\/memory\/internal\.ts$/u,
    ],
    requiredChecks: [],
    commands: ["pnpm vitest run src/memory src/agents/tools/memory-tool.test.ts"],
  },
  {
    id: "finance_caseflow",
    lane: "finance_research_capability",
    patterns: [
      /^src\/agents\/finance-(?:caseflow(?:-followups)?|forecast-calibration|history-coverage|research-assessment|source-recovery|model-workflow|model-specialist|agent-committee|news-entity|research-evidence|strategy-method-kit|strategy-method-catalog|research-runner|research-batch-runner|run-checkpoints|model-checkpoints|outcome-ledger|free-market-collection-adapters|registered-capability-adapters|market-collection-registry|realtime-source-registry|source-health|data-connectors|connector-evidence|mcp-client|rest-client|answer-grounding-gate)\.ts$/u,
      /^src\/agents\/tools\/finance-data-connector-inspect-tool\.ts$/u,
      // The read side of the stored research runs. Without it here, the only lane that would
      // claim it is the generic tool-registration rule, which never runs its behaviour test.
      /^src\/agents\/tools\/finance-research-runs-read-tool\.ts$/u,
      /^src\/agents\/tools\/quant-lab-tool\.ts$/u,
      /^src\/agents\/(?:quant-math-advanced|quant-math-inference|quant-math-foundations|finance-calculation-ledger)\.ts$/u,
      /^scripts\/operator\/lcx-(?:finance-research(?:-run)?|caseflow-demo|finance-connector-probe)\.ts$/u,
      /^src\/agents\/configured-finance-model-adapter\.ts$/u,
      /^docs\/experiments\/research\/finance-model-workflow\.md$/u,
      /^scripts\/operator\/finance-strategy-(?:method-benchmark|all-methods)\.ts$/u,
      /^docs\/experiments\/research\/finance-strategy-(?:method-benchmark|all-methods|stress-matrix)-[\d-]+\.md$/u,
    ],
    requiredChecks: ["finance-caseflow-regression", "head-tail-consistency"],
    commands: [
      "pnpm vitest run src/agents/finance-data-connectors.test.ts src/agents/finance-mcp-client.test.ts src/agents/finance-rest-client.test.ts src/agents/finance-connector-evidence.test.ts src/agents/tools/finance-data-connector-inspect-tool.test.ts src/agents/tools/finance-research-runs-read-tool.test.ts src/agents/finance-answer-grounding-gate.test.ts src/agents/finance-answer-composer.test.ts src/agents/quant-math-advanced.test.ts src/agents/quant-math-inference.test.ts src/agents/quant-math-foundations.test.ts src/agents/openclaw-tools.quant-lab-registration.test.ts test/finance-decision-pipeline.test.ts test/operator/lcx-finance-connector-probe.test.ts test/lcx-commercial-answer-pipeline-grounding.test.ts test/lcx-quant-lab-scenarios.test.ts test/lcx-quant-lab-paper-portfolios.test.ts",
      "pnpm vitest run src/agents/finance-caseflow.test.ts src/agents/finance-research-runner.test.ts src/agents/finance-research-batch-runner.test.ts src/agents/finance-outcome-ledger.test.ts src/agents/finance-caseflow-followups.test.ts src/agents/finance-history-coverage.test.ts src/agents/finance-forecast-calibration.test.ts src/agents/finance-research-assessment.test.ts",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    headTailRequired: true,
    risk: "elevated",
    safetyNotes: [
      "Research, source transport, scheduler binding and external execution remain separate authorities.",
    ],
  },
  {
    id: "finance_live_execution_seam",
    lane: "finance_research_capability",
    patterns: [
      /^src\/agents\/finance-execution-adapter\.ts$/u,
      /^src\/agents\/finance-position-ledger\.ts$/u,
      /^src\/agents\/finance-behaviour-profile\.ts$/u,
      /^src\/agents\/finance-equity-curve\.ts$/u,
      /^src\/agents\/finance-thesis-ledger\.ts$/u,
      /^src\/agents\/finance-strategy-rule-ledger\.ts$/u,
      /^src\/agents\/finance-rule-readiness\.ts$/u,
      /^src\/agents\/finance-bar-ledger\.ts$/u,
      /^src\/agents\/finance-state-dir\.ts$/u,
      // The agent-side read surface belongs to this seam as well as to the tool-registration
      // rule: it is where the model sees this book. Without it here, a change to the read
      // tool is gated by head-tail consistency and the system-prompt tests but never by the
      // read tool's own behaviour test.
      /^src\/agents\/tools\/finance-position-ledger-read-tool\.ts$/u,
      /^scripts\/operator\/lcx-finance-live-execution\.ts$/u,
      /^scripts\/operator\/lcx-finance-position-ledger\.ts$/u,
      /^scripts\/operator\/lcx-finance-thesis-ledger\.ts$/u,
      /^scripts\/operator\/lcx-finance-strategy-rule-ledger\.ts$/u,
      /^scripts\/operator\/lcx-finance-bar-ledger\.ts$/u,
    ],
    requiredChecks: ["git-diff-check", "head-tail-consistency"],
    commands: [
      "pnpm vitest run src/agents/finance-execution-adapter.test.ts src/agents/finance-position-ledger.test.ts src/agents/finance-behaviour-profile.test.ts src/agents/finance-thesis-ledger.test.ts src/agents/finance-strategy-rule-ledger.test.ts src/agents/finance-strategy-rule-ledger-read-tool.test.ts src/agents/finance-rule-readiness.test.ts src/agents/finance-bar-ledger.test.ts src/agents/tools/finance-position-ledger-read-tool.test.ts",
      "git diff --check",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    headTailRequired: true,
    risk: "elevated",
    safetyNotes: [
      "Paper adapter only: this rule covers a declared execution seam and the durable ledger downstream of it, not a venue order path. Credentials, funding and account binding stay separate authorities and are never read, stored or moved here.",
      "The ledger is append-only by construction (SQLite triggers reject UPDATE/DELETE). A record that conflicts with an existing one is refused, never overwritten, so a correction needs a new record rather than an edit.",
      "The equity curve is a pure projection of that stream and computes no metrics. It samples at mark instants only, so any annualised figure requires the caller to declare a period; the ledger holds no daily prices and must not be annualised as if it did.",
      "The instrument allowlist is open by default (`FINANCE_RISK_BUDGET_ANY_INSTRUMENT`). Narrowing is the caller's explicit act: an empty list still admits nothing, and the same check runs at both the budget and the adapter, so `--allow-instrument` continues to bite. Opening this default grants no new authority. A venue adapter (`finance-alpaca-execution-adapter.ts`) reads `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET` and refuses a paper/live key mismatch, so a venue credential path does exist; it is reachable only when a caller names that adapter, and no adapter is wired into any entrypoint by default.",
      "The bar ledger records OHLCV batches and never derives a range it did not observe: `ohlcv` bars carry exchange-aggregated extremes, and a batch compiled from point observations is labelled `point_derived` with its `sampleCount`, so range-based measures (ATR, true drawdown, support/resistance) can decline it instead of returning confident numbers from numbers nobody observed.",
      "The behaviour profile is a pure projection over the same post-`asOf` receipt/mark stream the ledger read reports, so it holds no state and can never disagree with the positions beside it. Its labels are descriptive observations over recorded fills, never advice (`advice` is pinned `false`), and a dimension whose threshold the caller did not declare reports numbers with no label rather than a default.",
      "Rule readiness measures exposure to adverse markets from the **owner-declared** `observedAt` on each lifecycle event, never from the wall-clock write time: a window built on write times is not replayable and silently yields zero observations at a past `asOf`, which reads as 'nothing adverse happened' instead of 'unjudgeable'. Every threshold is opt-in, an undeclared one makes its condition unjudgeable rather than passing, and `ready: null` must never be treated as `false`.",
      'The thesis ledger stores events (`opened`, `transition`) and derives state by replay, so it has no state column to drift: an `asOf` view is a shorter prefix of the same stream. Closing is terminal — there is no re-open path, because `the thesis changed` and `the owner changed their mind` are different claims and only the owner can tell them apart. A thesis confers no execution authority; every record carries `executionAuthority: "none"`.',
    ],
  },
  {
    // The finance plane's non-ledger members: quota bookkeeping, the finance credential
    // store and the probe script that feeds the quota probes. They live beside the ledgers
    // under one resolved root, so a change here can silently move where the whole plane is
    // read from — a missing quota file and a missing receipt both read as "nothing yet".
    id: "finance_state_plane",
    lane: "finance_research_capability",
    patterns: [
      /^src\/agents\/finance-source-quota\.ts$/u,
      /^src\/agents\/finance-credential-env\.ts$/u,
      /^scripts\/operator\/lcx-finance-source-limit-probe\.ts$/u,
    ],
    requiredChecks: [],
    commands: [
      "pnpm vitest run src/agents/finance-state-dir.test.ts src/agents/finance-source-quota.test.ts src/agents/finance-credential-env.test.ts src/agents/finance-source-health.test.ts src/agents/tools/finance-source-health-read-tool.test.ts",
    ],
    risk: "normal",
    safetyNotes: [
      "The credential store is read-only here: this lane never writes, moves or echoes a credential, and a credential is never a substitute for an execution authority.",
    ],
  },
  {
    id: "finance_benchmark_receipts",
    lane: "finance_research_capability",
    patterns: [/^\.artifacts\/finance-strategy\/[^/]+\.json$/u],
    requiredChecks: ["finance-benchmark-math", "git-diff-check"],
    commands: [
      "pnpm vitest run src/agents/finance-strategy-method-benchmark.test.ts",
      "git diff --check",
    ],
    safetyNotes: [
      "Benchmark receipts are retained research evidence, not source, model learning, or execution authority. Inventory all contained files separately; do not publish generated receipts by default.",
    ],
    risk: "normal",
  },
  {
    id: "api_transport_governance",
    lane: "agent_workflow_memory",
    patterns: [/^src\/agents\/api-call-contract\.ts$/u],
    requiredChecks: ["api-transport-tests"],
    commands: [
      "pnpm vitest run src/agents/api-call-contract.test.ts src/agents/finance-research-batch-runner.test.ts",
    ],
    risk: "elevated",
  },
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
      /^CONTRIBUTING\.md$/u,
      /^MEMORY\.md$/u,
      /^\.gitignore$/u,
      /^\.oxfmtrc\.jsonc$/u,
      /^README\.md$/u,
      /^ops\/(?:architecture|engineering)\//u,
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
      /^src\/shared\/lcx-run-receipt(?:\.test)?\.ts$/u,
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
      // The whole intake directory, not one filename: every record here is the same
      // genre (external pattern survey + its teacher-prompt pack). Pinning exact names
      // left sibling intakes unowned, so a new one became a stray the moment it was written.
      /^ops\/external-learning\/[^/]+\.(?:md|json)$/u,
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
      "Files under ops/external-learning/ are research evidence: an intake records what was read and which contract was accepted, and it grants no execution, external-sender, or second-state-root authority by itself.",
    ],
    headTailRequired: true,
    risk: "elevated",
  },
  {
    id: "ide_scaffolding_plans",
    lane: "global_doctrine_and_runbook",
    patterns: [/^\.trae\//u],
    requiredChecks: ["universe-index", "head-tail-consistency"],
    commands: [
      "node --import tsx scripts/operator/lcx-universe-index.ts --json --no-write",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    headTailRequired: true,
  },
  {
    id: "logical_agent_pool",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/agents\/logical-agent-pool\.ts$/u,
      /^src\/agents\/(?:logical-agent-model-router|local-text-model-adapter)\.ts$/u,
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
      /^src\/agents\/subagent-announce\.ts$/u,
      /^src\/agents\/openclaw-tools\.ts$/u,
      /^src\/agents\/tool-catalog\.ts$/u,
      // Decides which tools an LLM may actually call (profiles + the sub-agent deny
      // list + spawn depth). Widening it is a capability change, not a copy edit.
      /^src\/agents\/pi-tools\.policy\.ts$/u,
      /^src\/config\/agent-limits\.ts$/u,
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
    id: "operator_runbook_docs",
    lane: "global_doctrine_and_runbook",
    patterns: [/^ops\/codex-remote-devbox-and-browser-runbook\.md$/u],
    requiredChecks: ["doctrine-consistency"],
    commands: ["node --import tsx scripts/operator/lcx-doctrine-consistency.ts --json"],
  },
  {
    id: "identity_harness_contracts",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/agents\/coding-harness\//u,
      /^src\/agents\/quality-harness(?:-quality|-contract|-findings)?\.ts$/u,
      /^src\/commands\/doctor-config-flow\.ts$/u,
      /^src\/config\/(?:identity-migration|paths)\.ts$/u,
      /^src\/infra\/pairing-files\.ts$/u,
      /^src\/infra\/update-check\.ts$/u,
      /^src\/cli\/update-cli\/progress\.ts$/u,
      /^src\/cli\/update-cli\/(?:status|update-command|wizard)\.ts$/u,
      /^src\/cli\/(?:banner|tagline)\.ts$/u,
    ],
    requiredChecks: ["identity-harness-contract-tests", "git-diff-check"],
    commands: [
      "pnpm vitest run src/agents/quality-harness.test.ts src/agents/coding-harness/codex-acp.test.ts src/config/identity-migration.test.ts src/config/paths.test.ts src/infra/pairing-files.identity-migration.test.ts src/infra/update-check.test.ts src/cli/update-cli/progress.test.ts src/cli/update-cli.test.ts src/cli/banner.test.ts src/cli/tagline.test.ts",
      "git diff --check",
    ],
    safetyNotes: [
      "Identity and harness changes must preserve canonical-state activation, workspace attribution, finance safety, and rollback visibility; no provider, training, or external-channel authority is granted by these checks.",
    ],
  },
  {
    id: "cli_display_surface",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/cli\/(?:docs-cli|update-cli|plugins-cli|browser-cli|webhooks-cli|security-cli)\.ts$/u,
      /^src\/cli\/program\/(?:register\.subclis|command-registry)\.ts$/u,
      /^src\/commands\/(?:status\.command|doctor|doctor-update|doctor-gateway-services|dashboard|configure\.wizard|capabilities)\.ts$/u,
      /^src\/commands\/status-all\/(?:report-lines|diagnosis)\.ts$/u,
      /^src\/auto-reply\/status\.ts$/u,
      /^src\/acp\/(?:client|types)\.ts$/u,
      /^src\/hooks\/hooks-status\.ts$/u,
      /^src\/hooks\/bundled\/[^/]+\/HOOK\.md$/u,
    ],
    requiredChecks: ["cli-display-surface-tests", "git-diff-check"],
    commands: [
      "pnpm vitest run src/cli/program/register.subclis.test.ts src/cli/program/command-registry.test.ts src/cli/program/help.test.ts src/cli/browser-cli.test.ts src/cli/capabilities-cli.test.ts src/cli/hooks-cli.test.ts src/cli/update-cli.test.ts src/commands/status.test.ts src/commands/dashboard.test.ts src/commands/dashboard.links.test.ts src/commands/capabilities.test.ts src/commands/configure.wizard.test.ts src/commands/doctor-gateway-services.test.ts src/acp/client.test.ts",
      "git diff --check",
    ],
    safetyNotes: [
      "CLI display-surface changes are presentational only. Do not rename wire identifiers (HTTP headers, Windows task names, relay user-agent), filesystem paths, manifest schema keys, or paired sentinel strings in the same change; those are compatibility changes and need their own migration.",
    ],
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
      /^src\/agents\/model-(?:auth|egress)/u,
      // The embedded run path asserts the declared model egress route before the first request, so it
      // participates in the same provider boundary as model auth.
      /^src\/agents\/pi-embedded-runner\/run\/attempt\.ts$/u,
      /^src\/config\//u,
      // Documents the provider/model config surface, including the declared egress route.
      /^docs\/gateway\/configuration-reference\.md$/u,
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
    id: "network_egress_authority",
    lane: "local_live_boundary",
    patterns: [
      // `egress-env` writes the ambient variables so dependencies that read nothing else — the
      // Bedrock provider's `new ProxyAgent()` — cannot inherit the host's route.
      /^src\/infra\/net\/(?:fetch-guard|proxy-env|proxy-fetch|ssrf|egress-dispatcher|egress-env)\.ts$/u,
      /^src\/agents\/tools\/web-guarded-fetch\.ts$/u,
      /^src\/agents\/tools\/web-(?:search|fetch|search-citation-redirect)\.ts$/u,
      /^src\/telegram\/fetch\.ts$/u,
      /^src\/slack\/send\.ts$/u,
      // `ws` ignores proxy variables entirely, so these two carry the model proxy declaration
      // explicitly — changing them can re-route model traffic without touching the HTTP path.
      /^src\/agents\/openai-ws-(?:connection|stream)\.ts$/u,
      /^src\/media-understanding\/runner\.entries\.ts$/u,
      /^test\/lcx-egress-authority\.test\.ts$/u,
      // Installs the startup half of the guard, so a `fetch` issued before the first model turn
      // (onboarding probes, doctor checks, provider discovery) cannot follow the host's proxy.
      /^src\/entry\.ts$/u,
      /^docs\/(?:zh-CN\/)?tools\/web\.md$/u,
    ],
    requiredChecks: ["explicit-live-boundary-review"],
    commands: [
      "pnpm vitest run test/lcx-egress-authority.test.ts src/infra/net/fetch-guard.ssrf.test.ts src/infra/net/egress-env.test.ts src/agents/tools/web-guarded-fetch.test.ts src/telegram/fetch.test.ts",
    ],
    risk: "elevated",
    safetyNotes: [
      "Egress routes are declared, never inherited: no module may choose its route from ambient proxy variables.",
    ],
  },
  {
    // Attribution headers (OpenRouter/Perplexity style) are sent on every outbound request, so a
    // stale value there is live behaviour rather than dead text. This product is self-owned and
    // must not identify itself as the upstream project on the wire.
    id: "outbound_product_identity",
    lane: "local_live_boundary",
    patterns: [
      /^src\/infra\/canonical-identity\.ts$/u,
      /^src\/agents\/pi-embedded-runner\/extra-params\.ts$/u,
      // `doctor` prints install instructions for the memory system; pointing them at the upstream
      // repository would send someone there to fetch code.
      /^src\/commands\/doctor-workspace\.ts$/u,
      // User-visible "Website:" / "What now" links. `docs.openclaw.ai` is intentionally left alone
      // until the docs site moves: rewriting those links first would make them dead.
      /^src\/channels\/registry\.ts$/u,
      /^src\/channels\/plugins\/onboarding\/telegram\.ts$/u,
      /^src\/wizard\/onboarding\.finalize\.ts$/u,
      // Extension manifests declare where a channel plugin is installed from. `defaultChoice: "npm"`
      // plus an upstream `npmSpec` fetches upstream code even though the extension ships in-repo.
      /^extensions\/[^/]+\/package\.json$/u,
      // Skills output used to end with a `npx clawhub` tip, and the system prompt used to advertise
      // the upstream skill registry and community server. All three fetch upstream code or send
      // someone upstream, so they belong to the same lane as the outbound headers.
      /^src\/cli\/skills-cli\.format\.ts$/u,
      /^src\/agents\/system-prompt\.ts$/u,
      // Service identity truth: the daemon exposes the product name through the systemd unit name,
      // the `Description=` line users see in `systemctl status`, and the TLS certificate subject.
      // The launchd label, Windows task name and service marker stay as-is on purpose - they are
      // how already-installed instances are recognized, so renaming them strands those installs.
      /^src\/daemon\/constants\.ts$/u,
      /^src\/infra\/tls\/gateway\.ts$/u,
      // The install entrypoint is where a new user is told to fetch code from. If it
      // names the upstream domain, that user installs the upstream product no matter
      // what the rest of the tree claims.
      /^scripts\/install\.sh$/u,
      /^scripts\/install\.ps1$/u,
      /^scripts\/protocol-gen\.ts$/u,
    ],
    requiredChecks: ["run-changed-tests"],
    commands: [
      "pnpm vitest run test/lcx-outbound-identity.test.ts src/agents/pi-embedded-runner-extraparams.test.ts src/agents/tools/web-search.test.ts src/infra/canonical-identity.test.ts src/daemon/constants.test.ts src/agents/pi-tools.policy.test.ts src/channels/registry.helpers.test.ts",
    ],
    safetyNotes: [
      "Outbound identity headers come from the canonical constants, never from a literal naming the upstream project.",
      // The guardrail in `commands` also scans the whole tree for a bare `LCX Agent` token in
      // user-visible copy. Two files are deliberately exempt and must stay that way: registered
      // Windows scheduled-task names, and one regex that keeps accepting legacy input. Renaming
      // either is a behaviour change, not a rename.
      "User-visible copy must not call itself by the upstream product name; type identifiers, the ~/.openclaw path and the docs.openclaw.ai links are out of scope on purpose.",
    ],
  },
  {
    id: "memory_index_store",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/memory\/memory-schema\.ts$/u,
      /^src\/memory\/sqlite-migrations\.ts$/u,
      // The listing that decides which files enter the index, and the sqlite handle that holds
      // it. Both were unowned, so a change to either fell through `strayGate` as unmatched and
      // no lane named what had to hold.
      /^src\/memory\/internal\.ts$/u,
      /^src\/memory\/manager-sync-ops\.ts$/u,
      // The command surface that reports memory health; it is where an unreadable source has to
      // become visible to the operator.
      /^src\/cli\/memory-cli\.ts$/u,
    ],
    requiredChecks: ["run-changed-tests"],
    commands: [
      "pnpm vitest run src/memory/sqlite-migrations.test.ts src/memory/index.test.ts src/memory/internal.test.ts src/memory/memory-index-pragmas.test.ts",
    ],
    safetyNotes: [
      "An unreadable memory source is reported, never dropped: `listMemoryFilesWithDiagnostics` returns the inaccessible ones, the CLI names each with its errno and sets `dirReadable` to null, and sync logs a warning. A genuinely absent path stays silent because it was never a source.",
      "The memory index opens with `busy_timeout`, WAL and `synchronous=FULL`, the same pragmas the finance books use: without them a concurrent writer fails immediately with 'database is locked'.",
    ],
  },
  {
    id: "install_package_rollback",
    lane: "local_build_tooling",
    patterns: [/^src\/infra\/install-package-dir\.ts$/u],
    requiredChecks: ["run-changed-tests"],
    commands: ["pnpm vitest run src/infra/install-package-dir.test.ts"],
    safetyNotes: [
      "A failed install must say whether the previous install was put back: `rollback()` returns what it could not restore and the returned error carries it, so a half-copied target with a stranded backup is never reported as a clean failure.",
    ],
  },
  {
    // The run log is the only receipt an unattended cron job leaves behind, and
    // `unreadable-source` is the one judgement about a failed read that the cron reader and the
    // learning review tools now share. Changing either changes what "nothing happened" means.
    id: "cron_run_log_receipts",
    lane: "local_automation",
    patterns: [/^src\/cron\/run-log\.ts$/u, /^src\/infra\/unreadable-source\.ts$/u],
    requiredChecks: ["run-changed-tests"],
    commands: ["pnpm vitest run src/cron/run-log.test.ts src/cron/run-log.unreadable.test.ts"],
    safetyNotes: [
      "A run log that could not be read is reported as `unreadable` with its errno, never as an empty page: for an unattended job, 'nothing ran' and 'cannot tell' have opposite consequences.",
      "Pruning rewrites the file from whatever it read, so a failed prune read skips the prune and warns — treating it as empty would erase every recorded run.",
    ],
  },
  {
    // The subagent lifecycle registry: spawn, end, cleanup, and the announce that tells the
    // requester a child finished. Every "the parent never heard back" failure lives here.
    id: "subagent_lifecycle_registry",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/agents\/subagent-registry\.ts$/u,
      /^src\/agents\/subagent-registry\.types\.ts$/u,
      /^src\/agents\/subagent-registry-cleanup\.ts$/u,
      /^src\/agents\/subagent-announce\.ts$/u,
      /^src\/agents\/subagent-announce-queue\.ts$/u,
    ],
    requiredChecks: ["run-changed-tests"],
    commands: [
      "pnpm vitest run src/agents/subagent-registry.announce-loop-guard.test.ts src/agents/subagent-registry-cleanup.test.ts src/agents/subagent-registry.steer-restart.test.ts src/agents/subagent-registry.persistence.test.ts src/agents/subagent-announce-queue.test.ts",
    ],
    safetyNotes: [
      "A subagent whose announce was abandoned must stay distinguishable from one that announced: the give-up is recorded on the run as `announceGiveUp`, because a log line nobody reads leaves the run looking delivered.",
      "Announce retries are bounded on purpose (retry budget plus expiry). Do not turn a terminal give-up into an infinite retry.",
    ],
  },
  {
    id: "central_agent_harness",
    lane: "agent_workflow_memory",
    patterns: [/^src\/agents\/central-harness\//u, /^scripts\/operator\/lcx-central-agent\.ts$/u],
    requiredChecks: ["central-agent-harness-tests", "head-tail-consistency"],
    commands: [
      "pnpm vitest run test/lcx-central-agent.test.ts",
      "node --import tsx scripts/operator/lcx-central-agent.ts --dry-run --duration-minutes 1 --json",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    safetyNotes: [
      "The central harness only proposes; deterministic TS gates approve. It never gains provider, external-sender, protected-memory, or trading authority, and its capability tools stay planning-only.",
    ],
  },
  {
    // Hand-run developer tools. Nothing schedules them and nothing imports them:
    // a human runs them by hand, and the live ones additionally need a provider
    // key or a paired device. They still need an owner lane, otherwise a change
    // to one is reported as an unowned stray file.
    id: "developer_manual_tools",
    lane: "local_dev_tooling",
    patterns: [
      /^scripts\/(?:cron_usage_report|debug-claude-usage|firecrawl-compare|generate-secretref-credential-matrix|label-open-issues|readability-basic-compare|sync-moonshot-docs|test-shell-completion|zai-fallback-repro)\.ts$/u,
      /^scripts\/operator\/(?:geospatial-source-live-smoke|ios-node-e2e|test-device-pair-telegram)\.ts$/u,
    ],
    requiredChecks: [],
    commands: ["git diff --check"],
    safetyNotes: [
      "These are hand-run developer tools with no automated gate; some need a live provider key or a paired device. Changing one means running it by hand and stating what was observed. This lane grants no provider, credential, or external-channel authority.",
    ],
  },
  {
    // Root-level build and dependency configuration. Changing one changes how
    // everything is compiled, typed, or installed, but no single downstream
    // check covers it, so the lane records the change and requires a clean diff
    // rather than pretending to verify it.
    id: "build_tooling_and_manifests",
    lane: "local_build_tooling",
    patterns: [
      /^vitest[.-][\w.-]*\.ts$/u,
      /^tsdown\.config\.ts$/u,
      /^tsconfig[\w.-]*\.json$/u,
      /^zizmor\.yml$/u,
      /^pnpm-(?:lock|workspace)\.yaml$/u,
      /^pyproject\.toml$/u,
    ],
    requiredChecks: [],
    commands: ["git diff --check"],
    safetyNotes: [
      "Build and dependency changes affect every package at once. Keep them minimal and reviewable; regenerating lockfiles, bumping versions, or changing published build output is a separate, explicitly authorized change.",
    ],
  },
  {
    // The deployment surface: container images, PaaS manifests, and the podman
    // env file. Nothing here runs automatically, and building or shipping is a
    // separate authority.
    id: "deployment_surface",
    lane: "local_deployment_boundary",
    patterns: [
      /^Dockerfile[\w.-]*$/u,
      /^docker-compose\.yml$/u,
      /^docker-setup\.sh$/u,
      /^setup-podman\.sh$/u,
      /^openclaw\.podman\.env$/u,
      /^fly(?:\.\w+)?\.toml$/u,
      /^render\.yaml$/u,
    ],
    requiredChecks: [],
    commands: ["git diff --check"],
    safetyNotes: [
      "Deployment surface only. Building an image, publishing, deploying, or restarting a service is never triggered by this lane and needs explicit authorization plus a named target.",
    ],
  },
  {
    // Root entrypoints and project-level documents. Entrypoint edits can alter
    // every CLI invocation, so state what was run by hand.
    id: "root_project_surface",
    lane: "local_project_surface",
    patterns: [
      /^(?:lcx|openclaw)\.mjs$/u,
      /^(?:CHANGELOG|CLAUDE|SECURITY|VISION)\.md$/u,
      /^docs\.acp\.md$/u,
      /^LICENSE$/u,
    ],
    requiredChecks: [],
    commands: ["git diff --check"],
    safetyNotes: [
      "Entrypoints and project-level documents. Entrypoint changes affect every CLI invocation and must be exercised by hand; license, security, and vision changes are governance-level and should be called out explicitly.",
    ],
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
    execFileAsync("git", ["status", "--short", "--untracked-files=all"], { cwd: repoRoot }),
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
      // Every test file lives under a tree the main vitest include globs cover
      // (src/**, extensions/**, test/**), so one plain command routes them all.
      const quote = (file: string) =>
        /^[a-zA-Z0-9_./-]+$/u.test(file) ? file : "'" + file.replaceAll("'", "'\"'\"'") + "'";
      if (matchedFiles.length) {
        commands.push(`pnpm vitest run ${matchedFiles.map(quote).join(" ")}`);
      }
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
