import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readFileWithinRoot } from "../../src/infra/fs-safe.js";
import type { LcxRunSnapshot } from "../../src/shared/lcx-run-receipt.js";
import {
  CONSOLIDATION_CLUSTERS,
  CONSOLIDATED_ENTRYPOINT_FAMILIES,
  SHARED_ENTRYPOINT_OWNERS,
} from "./lcx-flow-graph.js";

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
    patterns: [/^src\/cli\/(?:serve-detach|serve-standalone|serve-cli)\.ts$/u],
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
      /^src\/agents\/finance-module-producer-input(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-deribit-collection(?:\.test)?\.ts$/u,
      /^src\/agents\/tools\/finance-market-collection-refresh-tool(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-(?:caseflow(?:-followups)?|forecast-calibration|history-coverage|research-assessment|source-recovery|model-workflow|model-specialist|agent-committee|news-entity|research-evidence|strategy-method-kit|strategy-method-catalog|research-runner|research-batch(?:-runner)?|run-checkpoints|model-checkpoints|outcome-ledger|outcome-backfill|additional-source-adapters|module-composition|module-execution|research-portfolio-plan|free-market-collection-adapters|registered-capability-adapters|market-collection-registry|realtime-source-registry|source-health|data-connectors|connector-evidence|mcp-client|rest-client|answer-grounding-gate|reply-evidence|decision-policy)\.ts$/u,
      /^src\/agents\/tools\/finance-data-connector-inspect-tool\.ts$/u,
      // The read side of the stored research runs. Without it here, the only lane that would
      // claim it is the generic tool-registration rule, which never runs its behaviour test.
      /^src\/agents\/tools\/finance-research-runs-read-tool\.ts$/u,
      /^src\/agents\/tools\/finance-research-run-tool\.ts$/u,
      /^docs\/tools\/finance-research-composition\.md$/u,
      /^src\/agents\/tools\/quant-lab-tool\.ts$/u,
      /^src\/agents\/(?:quant-math-advanced|quant-math-inference|quant-math-foundations|finance-calculation-ledger)\.ts$/u,
      /^scripts\/operator\/lcx-(?:finance-research(?:-run|-batch|-turn)?|finance-paper-rank|caseflow-demo|finance-connector-probe)\.ts$/u,
      /^src\/agents\/configured-finance-model-adapter\.ts$/u,
      /^docs\/experiments\/research\/finance-model-workflow\.md$/u,
      /^scripts\/operator\/finance-strategy-(?:method-benchmark|all-methods)\.ts$/u,
      /^docs\/experiments\/research\/finance-strategy-(?:method-benchmark|all-methods|stress-matrix)-[\d-]+\.md$/u,
    ],
    requiredChecks: ["finance-caseflow-regression", "head-tail-consistency"],
    commands: [
      "pnpm vitest run src/agents/finance-module-producer-input.test.ts",
      "pnpm vitest run src/agents/finance-deribit-collection.test.ts src/agents/tools/finance-market-collection-refresh-tool.test.ts",
      "pnpm vitest run src/agents/finance-additional-source-adapters.test.ts src/agents/finance-module-execution.test.ts src/agents/finance-outcome-backfill.test.ts src/agents/finance-research-portfolio-plan.test.ts",
      "pnpm vitest run src/agents/finance-data-connectors.test.ts src/agents/finance-mcp-client.test.ts src/agents/finance-rest-client.test.ts src/agents/finance-connector-evidence.test.ts src/agents/tools/finance-data-connector-inspect-tool.test.ts src/agents/tools/finance-research-runs-read-tool.test.ts src/agents/finance-answer-grounding-gate.test.ts src/agents/finance-reply-evidence.test.ts src/agents/finance-answer-composer.test.ts src/agents/quant-math-advanced.test.ts src/agents/quant-math-inference.test.ts src/agents/quant-math-foundations.test.ts src/agents/openclaw-tools.quant-lab-registration.test.ts test/finance-decision-pipeline.test.ts test/operator/lcx-finance-connector-probe.test.ts test/lcx-commercial-answer-pipeline-grounding.test.ts test/lcx-quant-lab-scenarios.test.ts test/lcx-quant-lab-paper-portfolios.test.ts",
      "pnpm vitest run src/agents/finance-caseflow.test.ts src/agents/finance-research-runner.test.ts src/agents/finance-research-batch-runner.test.ts src/agents/finance-outcome-ledger.test.ts src/agents/finance-caseflow-followups.test.ts src/agents/finance-history-coverage.test.ts src/agents/finance-forecast-calibration.test.ts src/agents/finance-research-assessment.test.ts",
      "pnpm vitest run src/agents/finance-brain-orchestration.test.ts src/agents/tools/finance-research-run-tool.test.ts src/agents/finance-model-checkpoints.test.ts",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    headTailRequired: true,
    risk: "elevated",
    safetyNotes: [
      "Research, source transport, scheduler binding and external execution remain separate authorities.",
    ],
  },
  {
    id: "commodity_pair_research_replay",
    lane: "finance_research_capability",
    patterns: [
      /^src\/agents\/quant-math-pair-spread\.ts$/u,
      /^docs\/experiments\/research\/commodity-pair-y2501-p2501\/(?:README\.md|capture\.json|input\.csv|replay\.mts|result\.json)$/u,
      /^docs\/experiments\/research\/commodity-pair-y-maturity-panel\/(?:README\.md|capture\.mts|capture\.json|input\.csv|replay\.mts|result\.json)$/u,
    ],
    requiredChecks: ["commodity-pair-replay", "git-diff-check"],
    commands: [
      "node --import tsx docs/experiments/research/commodity-pair-y2501-p2501/replay.mts",
      "node --import tsx docs/experiments/research/commodity-pair-y-maturity-panel/replay.mts",
      "pnpm vitest run src/agents/quant-math-pair-spread.test.ts",
      "git diff --check",
    ],
    safetyNotes: [
      "These exact-contract commodity-pair replays are research-only; their close-price models and assumed costs do not authorize or prove orders, fills, or profitability.",
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
      /^src\/agents\/finance-rule-readiness-state\.ts$/u,
      /^src\/agents\/finance-bar-ledger\.ts$/u,
      /^src\/agents\/finance-state-dir\.ts$/u,
      // The agent-side read surface belongs to this seam as well as to the tool-registration
      // rule: it is where the model sees this book. Without it here, a change to the read
      // tool is gated by head-tail consistency and the system-prompt tests but never by the
      // read tool's own behaviour test.
      /^src\/agents\/tools\/finance-position-ledger-read-tool\.ts$/u,
      // The bar book's agent-facing side. Without it here this file is only claimed by the
      // generic tool-registration rule, which never runs the bar ledger's own behaviour test.
      /^src\/agents\/tools\/finance-bar-ledger-tool\.ts$/u,
      // The bridge from a research conclusion to a mandate verdict. It places no
      // order itself - it resolves a conclusion into an intent the execution entry
      // gates - so it belongs to this seam rather than to the research lane: a
      // change here changes what reaches the single order path.
      /^src\/agents\/finance-research-(?:execution-bridge|conclusion-prompt)\.ts$/u,
      /^scripts\/operator\/lcx-finance-conclusion-to-order\.ts$/u,
      /^scripts\/operator\/lcx-finance-live-execution\.ts$/u,
      /^scripts\/operator\/lcx-finance-position-ledger\.ts$/u,
      /^scripts\/operator\/lcx-finance-thesis-ledger\.ts$/u,
      /^scripts\/operator\/lcx-finance-strategy-rule-ledger\.ts$/u,
      /^scripts\/operator\/lcx-finance-bar-ledger\.ts$/u,
      // The plane's own wiring report. It reads the bar, position and rule books this seam
      // owns and answers whether they agree, so a change to it changes what the system says
      // about its own execution path - not what the research lane samples.
      /^src\/agents\/finance-link-health\.ts$/u,
      /^scripts\/operator\/lcx-finance-link-health\.ts$/u,
    ],
    requiredChecks: ["git-diff-check", "head-tail-consistency"],
    commands: [
      "pnpm vitest run src/agents/finance-execution-adapter.test.ts src/agents/finance-position-ledger.test.ts src/agents/finance-behaviour-profile.test.ts src/agents/finance-thesis-ledger.test.ts src/agents/finance-strategy-rule-ledger.test.ts src/agents/finance-strategy-rule-ledger-read-tool.test.ts src/agents/finance-rule-readiness.test.ts src/agents/finance-rule-readiness-state.test.ts src/agents/finance-bar-ledger.test.ts src/agents/tools/finance-position-ledger-read-tool.test.ts src/agents/tools/finance-bar-ledger-tool.test.ts",
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
    // The unattended cycle: plan, schedule, and the venue order path it can reach.
    //
    // Separate from `finance_live_execution_seam` because that rule is explicitly the declared
    // seam and its ledgers — paper by construction. Everything here can, when a caller asks
    // for it (`--place --venue alpaca`), reach a real venue with a real credential, so the
    // checks have to name the order path rather than assume a simulator behind it.
    id: "finance_unattended_cycle",
    lane: "finance_research_capability",
    patterns: [
      /^src\/agents\/finance-(?:alpaca-(?:activity-contract|history-reconciliation|safety-transport)|broker-profit-feedback|intraday-ledger|owned-protection-exits|trade-economics|tuning-lifecycle)(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-daily-(?:cycle|strategy)\.ts$/u,
      /^src\/agents\/finance-(?:value-assessment|operating-evidence|portfolio-composition|portfolio-cycle)(?:\.test)?\.ts$/u,
      /^test\/operator\/lcx-finance-daily-strategy\.test\.ts$/u,
      /^src\/agents\/finance-cycle-schedule\.ts$/u,
      /^src\/agents\/finance-automatic-lifecycle-feedback\.ts$/u,
      /^src\/agents\/finance-scheduler-(?:lock|process|state)(?:\.test)?\.ts$/u,
      /^test\/operator\/lcx-finance-scheduler(?:-lifecycle)?\.test\.ts$/u,
      /^docs\/tools\/finance-scheduler\.md$/u,
      /^src\/agents\/finance-paper-run\.ts$/u,
      /^src\/agents\/finance-intent-compiler(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-intraday-(?:execution|control-ledger|paper)(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-trade-(?:decision-review|review-evidence|result-recall)(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-expectation-gap(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-night-review-context(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-alpaca-run\.ts$/u,
      /^src\/agents\/finance-alpaca-execution-adapter\.ts$/u,
      /^src\/agents\/finance-(?:alpaca-cycle-controller|broker-reconciliation|protection-coordination|write-transport)(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-execution-safety\.test-support\.ts$/u,
      /^src\/agents\/finance-(?:execution-(?:safety|recovery)|alpaca-(?:history-sync|safety-provider))(?:\.test)?\.ts$/u,
      /^src\/agents\/finance-universe-selection\.ts$/u,
      /^scripts\/operator\/lcx-finance-daily-cycle\.ts$/u,
      /^scripts\/operator\/lcx-finance-scheduler\.ts$/u,
      /^scripts\/operator\/lcx-finance-universe-select\.ts$/u,
      /^scripts\/operator\/lcx-finance-(?:intraday-paper|trade-economics-eval)\.ts$/u,
    ],
    requiredChecks: ["git-diff-check", "head-tail-consistency"],
    commands: [
      "pnpm vitest run src/agents/finance-alpaca-history-reconciliation.test.ts src/agents/finance-alpaca-safety-transport.test.ts src/agents/finance-broker-profit-feedback.test.ts src/agents/finance-intraday-ledger.test.ts src/agents/finance-owned-protection-exits.test.ts src/agents/finance-tuning-lifecycle.test.ts",
      "pnpm vitest run src/agents/finance-intraday-execution.test.ts src/agents/finance-alpaca-cycle-controller.test.ts",
      "pnpm vitest run src/agents/finance-intraday-paper.test.ts src/agents/finance-trade-economics.test.ts test/operator/lcx-finance-trade-economics-eval.test.ts",
      "pnpm vitest run src/agents/finance-intent-compiler.test.ts src/agents/finance-alpaca-run.test.ts",
      "pnpm vitest run src/agents/finance-trade-decision-review.test.ts src/agents/finance-trade-review-evidence.test.ts src/agents/finance-trade-result-recall.test.ts",
      "pnpm vitest run src/agents/finance-value-assessment.test.ts src/agents/finance-portfolio-cycle.test.ts test/operator/lcx-finance-daily-strategy.test.ts src/agents/finance-daily-cycle.test.ts src/agents/finance-cycle-schedule.test.ts src/agents/finance-alpaca-run.test.ts src/agents/finance-alpaca-execution-adapter.test.ts src/agents/finance-universe-selection.test.ts",
      "pnpm vitest run src/agents/finance-execution-safety.test.ts src/agents/finance-execution-recovery.test.ts src/agents/finance-alpaca-safety-provider.test.ts src/agents/finance-alpaca-cycle-controller.test.ts src/agents/finance-alpaca-history-sync.test.ts",
      "pnpm vitest run src/agents/finance-scheduler-lock.test.ts src/agents/finance-scheduler-process.test.ts src/agents/finance-scheduler-state.test.ts src/agents/finance-link-health.test.ts test/operator/lcx-finance-scheduler.test.ts test/operator/lcx-finance-scheduler-lifecycle.test.ts",
      "git diff --check",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
    ],
    headTailRequired: true,
    risk: "elevated",
    safetyNotes: [
      "Placing is opt-in: the cycle plans by default and only sends orders when a caller passes `--place`. A plan is not an order.",
      "Venue credentials are matched to their host locally — a `PK…` key against the live host and an `AK…` key against the paper host are both refused before any request leaves the process.",
      "The venue is the authoritative book: before placing, the cycle reads the venue's open orders and positions and refuses an instrument that already has a working order or whose venue quantity disagrees with the local ledger. A fill the ledger missed is caught here, not remembered here.",
      "A fill is only recorded when the venue reports one (`filledQuantity > 0`); an accepted-but-unfilled order is reported as such and never written as a position.",
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
      /^src\/agents\/finance-source-quota(?:-policy)?\.ts$/u,
      /^src\/agents\/finance-credential-env\.ts$/u,
      /^scripts\/operator\/lcx-finance-source-limit-probe\.ts$/u,
      /^scripts\/operator\/lcx-finance-research-score\.ts$/u,
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
    id: "model_request_metadata_trajectory",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/agents\/model-request-trajectory(?:\.test)?\.ts$/u,
      /^src\/agents\/configured-finance-model-adapter\.ts$/u,
      /^src\/agents\/central-harness\/model-brain\.ts$/u,
      /^src\/agents\/finance-http-body(?:\.test)?\.ts$/u,
      /^src\/agents\/pi-embedded-runner\/run\/attempt\.ts$/u,
      /^scripts\/operator\/lcx-model-trajectory\.ts$/u,
    ],
    requiredChecks: ["model-request-trajectory-tests"],
    commands: [
      "pnpm vitest run src/agents/model-request-trajectory.test.ts src/agents/configured-finance-model-adapter.test.ts src/agents/pi-embedded-runner/run/attempt.test.ts src/agents/pi-embedded-runner/run/attempt.egress.test.ts test/lcx-central-agent.test.ts",
      "pnpm vitest run src/agents/finance-http-body.test.ts src/agents/central-harness/model-body-deadline.test.ts",
    ],
    safetyNotes: [
      "The trajectory records request metadata only; prompt/message bodies, credentials, endpoints, and raw provider errors are never persisted.",
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
      /^src\/shared\/lcx-workflow-process-contracts\.ts$/u,
      /^test\/lcx-flow-handoff(?:-[a-z-]+)?\.test\.ts$/u,
      /^test\/fixtures\/lcx-waterflow-[a-z-]+\.ts$/u,
      /^test\/fixtures\/lcx-universe-deadline-probe\.ts$/u,
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
      "pnpm vitest run test/lcx-universe-index-deadline.test.ts",
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
      /^src\/agents\/(?:local-text-worker|local-vision-vlm)\.ts$/u,
      /^src\/agents\/tools\/local-specialist(?:-contract|-tool)\.ts$/u,
      /^src\/plugins\/lcx-model-fleet\.ts$/u,
      /^scripts\/local-model\/lcx_text_worker\.py$/u,
      /^docs\/tools\/local-data-workers\.md$/u,
      /^src\/agents\/logical-agent-pool\.test\.ts$/u,
      /^scripts\/operator\/lcx-logical-agent-pool\.ts$/u,
      /^ops\/local-brain\/logical-agent-pool\.md$/u,
    ],
    requiredChecks: ["logical-agent-pool-tests", "head-tail-consistency"],
    commands: [
      "node --import tsx scripts/operator/lcx-logical-agent-pool.ts --demo --json",
      "pnpm vitest run src/agents/logical-agent-pool.test.ts",
      "pnpm vitest run src/agents/local-text-worker.test.ts src/agents/tools/local-specialist-tool.test.ts src/agents/local-vision-vlm.test.ts src/plugins/lcx-model-fleet.test.ts",
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
    patterns: [/^skills\//u, /^\.agents\/skills\//u],
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
      /^src\/agents\/(?:self-repair-source-review|self-repair-candidate-review|self-repair-owner-map-feedback|module-learning-application-review)\.ts$/u,
      /^scripts\/operator\/lcx-system-memory-sedimentation-gate\.ts$/u,
      /^src\/agents\/tools\/module-learning-pipeline-/u,
      /^test\/module-learning-pipeline-/u,
      /^test\/lcx-learning-sedimentation-bridge\.test\.ts$/u,
      /^test\/lcx-learning-sedimentation-audit\.test\.ts$/u,
      /^test\/lcx-learning-sedimentation-map\.test\.ts$/u,
      /^test\/lcx-module-learning-absorption-gate\.test\.ts$/u,
      /^test\/lcx-self-repair-hands\.test\.ts$/u,
      /^test\/lcx-system-memory-sedimentation-gate\.test\.ts$/u,
      /^test\/lcx-flow-handoff-(?:learning|memory)\.test\.ts$/u,
      /^test\/fixtures\/lcx-waterflow-(?:learning-probe|memory-correction-probe)\.ts$/u,
      /^src\/agents\/tools\/finance-learning-capability-(?:inspect|apply)-tool\.ts$/u,
    ],
    requiredChecks: ["head-tail-consistency", "module-learning-tests"],
    commands: [
      "pnpm vitest run test/lcx-flow-handoff-module-content-review-nineteenth.test.ts test/lcx-flow-handoff-absorption-content-twentieth.test.ts test/lcx-flow-handoff-self-repair-review.test.ts test/lcx-flow-handoff-self-repair-feedback.test.ts",
      "node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json",
      "pnpm vitest run test/lcx-learning-sedimentation-bridge.test.ts test/lcx-learning-sedimentation-audit.test.ts test/lcx-learning-sedimentation-map.test.ts test/lcx-module-learning-absorption-gate.test.ts test/lcx-self-repair-hands.test.ts src/agents/self-repair-source-review.test.ts test/lcx-system-memory-sedimentation-gate.test.ts src/agents/tools/module-learning-pipeline-plan-tool.test.ts src/agents/tools/module-learning-pipeline-review-tool.test.ts test/module-learning-pipeline-plan-cli.test.ts test/module-learning-pipeline-review-cli.test.ts",
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
      /^src\/agents\/pi-tools(?:\.policy)?\.ts$/u,
      /^src\/agents\/artifact-result-recording\.ts$/u,
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
      "pnpm vitest run src/agents/pi-tools.policy.test.ts src/agents/artifact-result-recording.test.ts src/agents/central-harness/artifact-feedback-eval.test.ts",
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
      /^src\/agents\/finance-reply-evidence\.ts$/u,
      /^src\/agents\/(?:commercial-answer-reply-gate|provider-learning-council)\.ts$/u,
      /^src\/auto-reply\/reply\/agent-runner-execution\.ts$/u,
      /^src\/auto-reply\/reply\/queue\/types\.ts$/u,
      /^src\/auto-reply\/reply\/dispatch-from-config\.ts$/u,
      /^src\/auto-reply\/reply\/get-reply-run\.ts$/u,
      /^src\/auto-reply\/types\.ts$/u,
      /^src\/auto-reply\/reply\/(?:agent-runner(?:\.misc\.runreplyagent\.test)?|followup-runner(?:\.test)?)\.ts$/u,
      /^src\/auto-reply\/reply\/commands-protocol-families\.ts$/u,
      /^src\/auto-reply\/reply\/skill-autocue\.ts$/u,
      /^src\/auto-reply\/reply\/skillopt-autocue\.ts$/u,
      /^src\/auto-reply\/reply\/skillopt-autocue\.test\.ts$/u,
      /^src\/agents\/answer-audit-policy\.ts$/u,
      /^src\/agents\/visible-answer-adoption-gate\.ts$/u,
      /^src\/agents\/provider-council-(?:evidence|handoff\.test)\.ts$/u,
      /^test\/lcx-flow-handoff-(?:external|language)\.test\.ts$/u,
      /^test\/fixtures\/lcx-waterflow-(?:external|language)-probe\.ts$/u,
      /^src\/auto-reply\/reply\/commands-protocol-info\.ts$/u,
      /^extensions\/external\/src\/(?:channel|monitor|protocol|send)\.ts$/u,
      /^src\/commands\/capabilities\/l5-system-eval\.ts$/u,
    ],
    requiredChecks: ["external-regression-tests", "core-external-channel-boundary-check"],
    commands: [
      "pnpm vitest run test/lcx-flow-handoff-finance-reply.test.ts src/agents/provider-learning-council.transport.test.ts src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts src/auto-reply/reply/followup-runner.test.ts",
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
      /^scripts\/operator\/external-channel-sidecar-runtime-freshness\.ts$/u,
      /^test\/lcx-external-channel-compat-status\.test\.ts$/u,
      /^src\/daemon\/inspect\.ts$/u,
      /^src\/agents\/model-(?:auth|egress)/u,
      /^src\/agents\/provider-learning-council\.ts$/u,
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
    // Declared MCP servers. The config is the authorization boundary for spawning a local process
    // or opening a remote connection, so a change here is a capability change, not plumbing:
    // widening it hands the model a new way to run things.
    id: "mcp_connector_surface",
    lane: "local_live_boundary",
    patterns: [
      /^src\/agents\/mcp-(?:client|servers)\.ts$/u,
      // Bar supply ships as a declared MCP server rather than as a one-off fetch script, so the
      // server itself is part of this surface: it is the thing the config authorizes spawning.
      /^scripts\/mcp\/[A-Za-z0-9._-]+\.mjs$/u,
    ],
    requiredChecks: ["explicit-live-boundary-review"],
    commands: [
      "pnpm vitest run src/agents/mcp-servers.test.ts src/agents/mcp-client.test.ts src/agents/tools/mcp-bridge-tools.test.ts",
    ],
    risk: "elevated",
    safetyNotes: [
      "A server is callable only when declared in tools.mcp.servers: the model supplies a name, never a command, a URL or an argv.",
      "stdio children inherit no ambient proxy variables and no session-scoped variables; http egress is explicit-proxy only.",
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
      // The docs mirror the same three outward-facing surfaces, and a stale address there is
      // read and copied by a user just as readily as one in code: where to install from, where
      // to report a vulnerability, and where to ask for help.
      /^docs\/install\/(?:installer|docker|updating)\.md$/u,
      /^docs\/zh-CN\/install\/(?:installer|updating)\.md$/u,
      /^docs\/security\/[^/]+\.md$/u,
      /^docs\/gateway\/security\/index\.md$/u,
      /^docs\/zh-CN\/gateway\/security\/index\.md$/u,
      // Skills docs used to teach `npx clawhub`, which downloads and runs upstream code, and the
      // CLI reference used to end the skills command with the same tip.
      /^docs\/tools\/(?:clawhub|skills)\.md$/u,
      /^docs\/zh-CN\/tools\/(?:clawhub|skills)\.md$/u,
      /^docs\/cli\/index\.md$/u,
      /^docs\/zh-CN\/cli\/index\.md$/u,
      /^docs\/start\/openclaw\.md$/u,
      /^docs\/zh-CN\/start\/openclaw\.md$/u,
      // Issue/PR automation and the issue form reply to users with links. A stale one routes a
      // real person upstream at the exact moment they are asking for help.
      /^\.github\/ISSUE_TEMPLATE\/.+$/u,
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
      /^src\/agents\/subagent-registry-state\.ts$/u,
      /^src\/agents\/subagent-registry\.store\.ts$/u,
      /^src\/agents\/subagent-announce\.ts$/u,
      /^src\/agents\/subagent-announce-queue\.ts$/u,
    ],
    requiredChecks: ["run-changed-tests"],
    commands: [
      "pnpm vitest run src/agents/subagent-registry.announce-loop-guard.test.ts src/agents/subagent-registry-cleanup.test.ts src/agents/subagent-registry.steer-restart.test.ts src/agents/subagent-registry.persistence.test.ts src/agents/subagent-registry-store.corrupt-guard.test.ts src/agents/subagent-announce-queue.test.ts",
    ],
    safetyNotes: [
      "A subagent whose announce was abandoned must stay distinguishable from one that announced: the give-up is recorded on the run as `announceGiveUp`, because a log line nobody reads leaves the run looking delivered.",
      "Announce retries are bounded on purpose (retry budget plus expiry). Do not turn a terminal give-up into an infinite retry.",
      "A registry file that cannot be read is not an empty registry: the load status must be reported and writes must be blocked, otherwise the next persist replaces the only copy of those runs with `{}`.",
    ],
  },
  {
    id: "persisted_state_read_contract",
    lane: "agent_workflow_memory",
    patterns: [
      /^src\/infra\/json-file\.ts$/u,
      /^src\/infra\/device-identity\.ts$/u,
      /^src\/infra\/device-auth-store\.ts$/u,
      /^src\/discord\/monitor\/thread-bindings\.state\.ts$/u,
      /^src\/infra\/exec-approvals\.ts$/u,
      /^src\/secrets\/shared\.ts$/u,
      /^src\/agents\/pi-model-discovery\.ts$/u,
      /^src\/browser\/chrome\.profile-decoration\.ts$/u,
      /^src\/gateway\/server-methods\/chat\.ts$/u,
      /^src\/auto-reply\/reply\/session-fork\.ts$/u,
      /^extensions\/matrix\/src\/matrix\/atomic-json\.ts$/u,
      /^extensions\/matrix\/src\/matrix\/credentials\.ts$/u,
      /^extensions\/matrix\/src\/matrix\/client\/storage\.ts$/u,
      /^extensions\/zalouser\/src\/atomic-json\.ts$/u,
      /^extensions\/zalouser\/src\/zalo-js\.ts$/u,
    ],
    requiredChecks: ["run-changed-tests"],
    commands: [
      "pnpm vitest run src/agents/subagent-registry-store.corrupt-guard.test.ts src/browser/chrome.profile-decoration.unreadable.test.ts src/infra/device-identity.unreadable-guard.test.ts",
      "pnpm vitest run src/discord/monitor/thread-bindings.corrupt-guard.test.ts src/discord/monitor/thread-bindings.state.identity-migration.test.ts",
      "pnpm vitest run extensions/matrix/src/matrix/credentials.identity-migration.test.ts extensions/zalouser/src/accounts.test.ts",
      "pnpm tsx scripts/operator/lcx-persistence-safety-audit.ts --json",
    ],
    safetyNotes: [
      "Reading a JSON state file must keep 'no file' distinct from 'a file that could not be read or parsed'. Callers that write the file back must use `loadJsonFileDetailed`: treating an unreadable file as an empty document and persisting that emptiness destroys the original.",
      "Writing one must go through `saveJsonFile` or another temp-file + rename. `writeFileSync` truncates before it writes, so an interrupted write leaves a truncated file behind — and for these files (device keys, exec approvals, secrets, the pi credential store, Chrome's Preferences) there is no second copy.",
      "Two of these used to be named `safeWriteJson` / `writeJsonFileSecure` while doing the unsafe thing. A helper's name is not evidence; check the write itself.",
    ],
  },
  {
    id: "auth_profile_credential_store",
    lane: "local_live_boundary",
    patterns: [/^src\/agents\/auth-profiles\//u],
    requiredChecks: ["run-changed-tests"],
    commands: [
      "pnpm vitest run src/agents/auth-profiles/unreadable-store.test.ts src/agents/auth-profiles/credential-state.test.ts src/agents/auth-profiles/oauth.test.ts src/agents/auth-profiles/identity-migration.test.ts",
    ],
    safetyNotes: [
      "Credentials are not reproducible: a store that cannot be read must never be overwritten by one rebuilt from auth.json, OAuth or external CLI sync. Report that it could not be read instead of reporting an empty store.",
    ],
  },
  {
    id: "persistence_safety_audit",
    lane: "agent_workflow_memory",
    patterns: [/^scripts\/operator\/lcx-persistence-safety-audit\.ts$/u],
    requiredChecks: ["run-changed-tests"],
    commands: ["pnpm tsx scripts/operator/lcx-persistence-safety-audit.ts --json"],
    safetyNotes: [
      "This audit is the standing detector for two state-destroying shapes: reading a JSON state file with `loadJsonFile` and writing the resulting emptiness back over it, and writing a `.json` state file with `writeFileSync` (which truncates first).",
      "It is a candidate list, not an oracle: a new finding means 'confirm this site', and an exemption must state *why* the site is safe. Do not add an exemption whose reason is only 'known'.",
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
    id: "git_commit_delivery",
    lane: "local_dev_tooling",
    patterns: [
      /^scripts\/committer$/u,
      /^git-hooks\/pre-commit$/u,
      /^scripts\/pre-commit\/(?:run-node-tool\.sh|filter-staged-files\.mjs)$/u,
      /^test\/git-hooks-pre-commit\.test\.ts$/u,
    ],
    requiredChecks: ["git-diff-check", "run-changed-tests"],
    commands: [
      "bash -n scripts/committer",
      "pnpm vitest run test/git-hooks-pre-commit.test.ts",
      "git diff --check",
    ],
    safetyNotes: [
      "Commit hooks may rewrite and stage selected files. Verify the committed content and exact-path index synchronization in an isolated repository; preserve unrelated worktree and index entries. This lane grants no push, merge or deployment authority.",
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
      /^\.github\/workflows\/.+$/u,
      /^package\.json$/u,
      /^vitest[.-][\w.-]*\.ts$/u,
      /^tsdown\.config\.ts$/u,
      /^tsconfig[\w.-]*\.json$/u,
      /^scripts\/(?:check-build-identity\.mjs|write-build-info\.ts)$/u,
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
      "Optional read-only cleanup review: --cleanup-review FILE --review-parent-run-id ID",
      "--review-snapshot-id ID [--review-root-dir DIR]. Host Git identity is read locally;",
      "the source manifest cannot supply expected scope. Review never authorizes cleanup.",
      "Optional selected behavior comparison: --changed PATH --inspect-prior-work",
      "--mechanism-review FILE [--review-root-dir DIR]. This reads actual source and pinned",
      "before/after reports; a merge_candidate is a proposal, never execution authority.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
  const options: {
    json: boolean;
    changed: string[];
    cleanupReview?: string;
    reviewParentRunId?: string;
    reviewSnapshotId?: string;
    reviewRootDir?: string;
    inspectPriorWork?: boolean;
    mechanismReview?: string;
  } = { json: false, changed: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--inspect-prior-work") {
      options.inspectPriorWork = true;
    } else if (arg === "--mechanism-review") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || options.mechanismReview) {
        throw new Error("invalid --mechanism-review");
      }
      options.mechanismReview = value;
      index += 1;
    } else if (
      [
        "--cleanup-review",
        "--review-parent-run-id",
        "--review-snapshot-id",
        "--review-root-dir",
      ].includes(arg)
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      const key =
        arg === "--cleanup-review"
          ? "cleanupReview"
          : arg === "--review-parent-run-id"
            ? "reviewParentRunId"
            : arg === "--review-root-dir"
              ? "reviewRootDir"
              : "reviewSnapshotId";
      if (options[key] !== undefined) {
        throw new Error(`duplicate ${arg}`);
      }
      options[key] = value;
      index += 1;
    } else if (arg.startsWith("--review-") || arg.startsWith("--cleanup-")) {
      throw new Error(`unknown review flag ${arg}`);
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

type ChangedFilesReadback = {
  source: "git" | "explicit_paths";
  status: "observed" | "unavailable";
  reason?: string;
};

type PriorWorkRead = {
  path: string;
  owners: string[];
  old?: { revision: string; path: string; sha256: string; bytes: number };
  current: { path: string; status: "read" | "deleted"; sha256?: string; bytes?: number };
  diff: {
    revision: string;
    path: string;
    sha256: string;
    bytes: number;
    hunks: { oldStart: number; oldCount: number; newStart: number; newCount: number }[];
    publicSymbols: { change: "added" | "removed"; name: string }[];
  };
  disposition:
    | "preserve_existing_path"
    | "unresolved_new_comparison"
    | "deletion_pending_cleanup_review";
};
type PriorWorkResult = {
  status: "observed" | "partial" | "not_observed" | "unknown";
  scope?: {
    changedFilesCount: number;
    eligibleCount: number;
    selectedCount: number;
    focusLimit: number;
  };
  omissions?: { source: "changedFiles"; indices: number[]; budgetIndices: number[] };
  baselineCommit?: string;
  reads: PriorWorkRead[];
  gaps: string[];
  blocksPlan: boolean;
  semanticEquivalence: "not_proven";
  cleanup?: "local_read_or_descendant_cleanup_unconfirmed";
};

/** Read original implementation bytes; expose provenance, never source literals, to governance. */
async function readPriorWork(
  files: string[],
  readback: ChangedFilesReadback,
  impacts: Impact[],
  deadlineAt: number,
  inspectExplicitPaths = false,
): Promise<PriorWorkResult> {
  const result: PriorWorkResult = {
    status: "not_observed",
    reads: [],
    gaps: [],
    blocksPlan: false,
    semanticEquivalence: "not_proven",
  };
  if (readback.source === "explicit_paths" && !inspectExplicitPaths) {
    result.gaps.push("explicit_paths_inventory_only");
    return result;
  }
  if (readback.status !== "observed") {
    return {
      ...result,
      status: "unknown",
      blocksPlan: true,
      gaps: [readback.reason ?? "git_unavailable"],
    };
  }
  const eligible = files.filter(
    (file) =>
      /^(?:src|scripts|extensions)\//u.test(file) &&
      /\.(?:[cm]?[jt]sx?|py|sh)$/u.test(file) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
      !/(?:^|\/)(?:test|tests|fixtures)\//u.test(file),
  );
  const implementations = eligible.slice(0, 16);
  result.scope = {
    changedFilesCount: files.length,
    eligibleCount: eligible.length,
    selectedCount: implementations.length,
    focusLimit: 16,
  };
  result.omissions = {
    source: "changedFiles",
    indices: eligible.slice(16).map((file) => files.indexOf(file)),
    budgetIndices: [],
  };
  if (result.omissions.indices.length) {
    result.gaps.push("prior_work_focus_partial:read_omitted_changedFiles_indices");
  }
  if (!implementations.length) {
    return { ...result, status: "observed" };
  }
  const controller = new AbortController();
  const remaining = () => {
    if (Date.now() >= deadlineAt) {
      controller.abort();
    }
    controller.signal.throwIfAborted();
    return deadlineAt - Date.now();
  };
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    remaining();
    let listener: (() => void) | undefined;
    try {
      const value = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          listener = () => reject(new Error("prior_work_deadline"));
          controller.signal.addEventListener("abort", listener, { once: true });
          if (controller.signal.aborted) {
            listener();
          }
        }),
      ]);
      remaining();
      return value;
    } finally {
      if (listener) {
        controller.signal.removeEventListener("abort", listener);
      }
    }
  };
  const git = async (args: string[], maxBuffer = 128 * 1024) => {
    remaining();
    const response = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: "buffer",
      timeout: Math.min(10_000, remaining()),
      signal: controller.signal,
      killSignal: "SIGKILL",
      maxBuffer,
    });
    remaining();
    return response.stdout;
  };
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const readCurrent = (file: string) => {
    remaining();
    return bounded(
      readFileWithinRoot({
        rootDir: repoRoot,
        relativePath: file,
        rejectHardlinks: true,
        maxBytes: 128 * 1024,
      }),
    );
  };
  let activePath = "";
  try {
    const revision = (await git(["rev-parse", "HEAD"], 256)).toString("utf8").trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) {
      throw new Error("prior_work_revision_unconfirmed");
    }
    result.baselineCommit = revision;
    for (const file of implementations) {
      activePath = file;
      try {
        if (
          path.isAbsolute(file) ||
          file.split("/").some((part) => !part || part === "." || part === "..")
        ) {
          throw new Error("prior_work_path_invalid");
        }
        const tree = await git(["ls-tree", "-z", revision, "--", file], 16 * 1024);
        if (tree.length && !/^100(?:644|755) blob [a-f0-9]+\t/u.test(tree.toString("utf8"))) {
          throw new Error("prior_work_head_not_regular_file");
        }
        const old = tree.length ? await git(["show", `${revision}:${file}`]) : undefined;
        const diffBytes = await git(
          ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", revision, "--", file],
          16 * 1024,
        );
        const diffText = diffBytes.toString("utf8");
        const hunks = [...diffText.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)].map(
          (m) => ({
            oldStart: Number(m[1]),
            oldCount: Number(m[2] ?? 1),
            newStart: Number(m[3]),
            newCount: Number(m[4] ?? 1),
          }),
        );
        const publicSymbols = [
          ...diffText.matchAll(
            /^([+-])export\s+(?:async\s+)?(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]*)/gmu,
          ),
        ].map((m) => ({
          change: m[1] === "+" ? ("added" as const) : ("removed" as const),
          name: m[2],
        }));
        if (
          hunks.length > 32 ||
          publicSymbols.length > 32 ||
          publicSymbols.some((symbol) => symbol.name.length > 128)
        ) {
          throw new Error("prior_work_result_budget_exceeded");
        }
        let current: PriorWorkRead["current"];
        try {
          const opened = await readCurrent(file);
          if (opened.realPath !== path.resolve(repoRoot, file)) {
            throw new Error("prior_work_path_alias");
          }
          current = {
            path: file,
            status: "read",
            sha256: hash(opened.buffer),
            bytes: opened.buffer.length,
          };
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          if (
            code !== "not-found" ||
            !old ||
            !(await git(["diff", "--name-status", revision, "--", file], 1024))
              .toString("utf8")
              .startsWith(`D\t${file}`)
          ) {
            throw error;
          }
          current = { path: file, status: "deleted" };
        }
        const disposition =
          current.status === "deleted"
            ? "deletion_pending_cleanup_review"
            : old
              ? "preserve_existing_path"
              : "unresolved_new_comparison";
        result.reads.push({
          path: file,
          owners: impacts
            .filter((impact) => impact.matchedFiles.includes(file))
            .map((impact) => impact.id),
          ...(old ? { old: { revision, path: file, sha256: hash(old), bytes: old.length } } : {}),
          current,
          diff: {
            revision,
            path: file,
            sha256: hash(diffBytes),
            bytes: diffBytes.length,
            hunks,
            publicSymbols,
          },
          disposition,
        });
        if (!old) {
          result.gaps.push(`prior_HEAD_source_absent:${file}`);
        }
        if (current.status === "deleted") {
          result.gaps.push(`original_cleanup_review_required:${file}`);
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 12 * 1024) {
          result.reads.pop();
          throw new Error("prior_work_result_budget_exceeded");
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const budget =
          code === "too-large" ||
          code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
          (error instanceof Error && error.message === "prior_work_result_budget_exceeded");
        if (!budget || controller.signal.aborted || Date.now() >= deadlineAt) {
          throw error;
        }
        result.omissions.budgetIndices.push(files.indexOf(file));
        result.gaps.push(`prior_work_byte_budget_partial:${file}`);
      }
    }
    for (const read of result.reads) {
      activePath = read.path;
      if (
        hash(
          await git(
            ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", revision, "--", read.path],
            16 * 1024,
          ),
        ) !== read.diff.sha256
      ) {
        throw new Error("prior_work_diff_changed");
      }
      if (read.current.status === "deleted") {
        try {
          await readCurrent(read.path);
          throw new Error("prior_work_source_changed");
        } catch (error) {
          if (
            !(error && typeof error === "object" && "code" in error && error.code === "not-found")
          ) {
            throw error;
          }
        }
      } else if (hash((await readCurrent(read.path)).buffer) !== read.current.sha256) {
        throw new Error("prior_work_source_changed");
      }
    }
    if ((await git(["rev-parse", "HEAD"], 256)).toString("utf8").trim() !== revision) {
      throw new Error("prior_work_revision_changed");
    }
    remaining();
    result.status =
      result.omissions.indices.length || result.omissions.budgetIndices.length
        ? "partial"
        : "observed";
  } catch (error) {
    result.status = "unknown";
    result.blocksPlan = true;
    result.gaps.push(
      controller.signal.aborted || Date.now() >= deadlineAt
        ? `prior_work_deadline:${activePath}`
        : error instanceof Error && error.message.startsWith("prior_work_")
          ? `${error.message}:${activePath}`
          : `prior_work_source_read_unconfirmed:${activePath}`,
    );
    result.cleanup = "local_read_or_descendant_cleanup_unconfirmed";
  } finally {
    clearTimeout(timer);
  }
  return result;
}

type ConsolidationRoute = {
  source: { path: string; sha256: string };
  familyIds: string[];
  ownerPaths: string[];
  ownerSources: { path: string; sha256: string; bytes: number }[];
  sharedApproval?: string;
  disposition: "preserve_existing_owner" | "owner_unresolved";
  gaps: string[];
  semanticEquivalence: "not_proven";
};

/** Apply existing exact ownership declarations to source actually read by this invocation. */
async function readConsolidation(priorWork: PriorWorkResult, deadlineAt: number) {
  const declarationNames = [
    "CONSOLIDATION_CLUSTERS",
    "CONSOLIDATED_ENTRYPOINT_FAMILIES",
    "SHARED_ENTRYPOINT_OWNERS",
  ];
  const result = {
    status: priorWork.status,
    routes: [] as ConsolidationRoute[],
    conflicts: [] as { path: string; reason: string }[],
    blocksPlan: false,
    omittedPriorReadIndices: [] as number[],
    cleanup: undefined as "local_owner_read_cleanup_unconfirmed" | undefined,
    normSource: {
      path: "scripts/operator/lcx-flow-graph.ts",
      exports: declarationNames,
      declarationSha256: createHash("sha256")
        .update(
          JSON.stringify([
            CONSOLIDATION_CLUSTERS,
            CONSOLIDATED_ENTRYPOINT_FAMILIES,
            SHARED_ENTRYPOINT_OWNERS,
          ]),
        )
        .digest("hex"),
      fullFileRead: "not_observed" as const,
    },
    semanticEquivalence: "not_proven" as const,
  };
  const readOwner = async (file: string) => {
    if (Date.now() >= deadlineAt) {
      throw new Error("consolidation_deadline");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opened = await Promise.race([
        readFileWithinRoot({
          rootDir: repoRoot,
          relativePath: file,
          rejectHardlinks: true,
          maxBytes: 128 * 1024,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("consolidation_deadline")),
            deadlineAt - Date.now(),
          );
        }),
      ]);
      if (Date.now() >= deadlineAt || opened.realPath !== path.resolve(repoRoot, file)) {
        throw new Error("consolidation_owner_read_unconfirmed");
      }
      return {
        path: file,
        sha256: createHash("sha256").update(opened.buffer).digest("hex"),
        bytes: opened.buffer.length,
      };
    } finally {
      clearTimeout(timer);
    }
  };
  if (priorWork.status === "unknown" || priorWork.status === "not_observed") {
    return result;
  }
  const ownerReads = new Map<string, Awaited<ReturnType<typeof readOwner>>>();
  const failedOwnerReads = new Map<string, string>();
  for (const read of priorWork.reads) {
    if (read.current.status !== "read" || !read.current.sha256) {
      continue;
    }
    const families = CONSOLIDATED_ENTRYPOINT_FAMILIES.filter((family) =>
      family.allowedPaths.includes(read.path),
    );
    const route: ConsolidationRoute = {
      source: { path: read.path, sha256: read.current.sha256 },
      familyIds: families.map((family) => family.id),
      ownerPaths: [...new Set(families.map((family) => family.ownerPath))],
      ownerSources: [],
      disposition: families.length ? "preserve_existing_owner" : "owner_unresolved",
      gaps: [],
      semanticEquivalence: "not_proven",
    };
    if (!families.length) {
      const watched = CONSOLIDATED_ENTRYPOINT_FAMILIES.filter((family) =>
        family.watchedPathTerms.some((term) =>
          read.path.toLowerCase().includes(term.toLowerCase()),
        ),
      );
      route.gaps.push(
        watched.length
          ? `entrypoint_registration_required:${watched.map((family) => family.id).join(",")}`
          : "canonical_owner_not_declared",
      );
    }
    for (const family of families) {
      if (
        !family.allowedPaths.includes(family.ownerPath) ||
        !CONSOLIDATION_CLUSTERS.some((cluster) => cluster.id === family.ownerCluster)
      ) {
        result.conflicts.push({ path: read.path, reason: `declared_owner_conflict:${family.id}` });
      }
    }
    if (families.length > 1) {
      const shared = SHARED_ENTRYPOINT_OWNERS.find(
        (rule) =>
          rule.path === read.path &&
          [...rule.familyIds].toSorted().join("|") === [...route.familyIds].toSorted().join("|"),
      );
      if (shared) {
        route.sharedApproval = shared.reason;
      } else {
        result.conflicts.push({ path: read.path, reason: "cross_family_share_not_approved" });
      }
    }
    for (const file of route.ownerPaths) {
      try {
        const previousFailure = failedOwnerReads.get(file);
        if (previousFailure) {
          route.gaps.push(previousFailure);
          route.disposition = "owner_unresolved";
          continue;
        }
        const source = ownerReads.get(file) ?? (await readOwner(file));
        ownerReads.set(file, source);
        route.ownerSources.push(source);
        if (file === read.path && source.sha256 !== read.current.sha256) {
          result.conflicts.push({ path: file, reason: "actual_source_changed_after_prior_read" });
          route.disposition = "owner_unresolved";
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const gap =
          code === "too-large"
            ? `owner_body_budget_partial:${file}`
            : `owner_source_read_unconfirmed:${file}`;
        failedOwnerReads.set(file, gap);
        route.gaps.push(gap);
        route.disposition = "owner_unresolved";
        if (Date.now() >= deadlineAt) {
          result.cleanup = "local_owner_read_cleanup_unconfirmed";
        }
      }
    }
    result.routes.push(route);
    if (Buffer.byteLength(JSON.stringify(result)) > 12 * 1024) {
      result.routes.pop();
      result.omittedPriorReadIndices = priorWork.reads
        .slice(priorWork.reads.indexOf(read))
        .map((entry) => priorWork.reads.indexOf(entry));
      result.status = "partial";
      break;
    }
  }
  for (const source of ownerReads.values()) {
    let gap: string | undefined;
    try {
      if ((await readOwner(source.path)).sha256 !== source.sha256) {
        gap = `owner_source_changed:${source.path}`;
        result.conflicts.push({ path: source.path, reason: "actual_owner_source_changed" });
      }
    } catch {
      gap = `owner_source_repin_unconfirmed:${source.path}`;
      if (Date.now() >= deadlineAt) {
        result.cleanup = "local_owner_read_cleanup_unconfirmed";
      }
    }
    if (gap) {
      result.status = "unknown";
      for (const route of result.routes.filter((row) => row.ownerPaths.includes(source.path))) {
        route.gaps.push(gap);
        route.disposition = "owner_unresolved";
      }
    }
  }
  result.blocksPlan = result.conflicts.length > 0;
  if (result.blocksPlan) {
    result.status = "unknown";
  } else if (result.status === "observed" && result.routes.some((route) => route.gaps.length)) {
    result.status = "partial";
  }
  return result;
}

async function gitChangedFiles(deadlineAt = Date.now() + 20_000): Promise<{
  files: string[];
  readback: ChangedFilesReadback;
}> {
  const commandOptions = {
    cwd: repoRoot,
    timeout: Math.max(1, Math.min(10_000, deadlineAt - Date.now())),
    signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
    killSignal: "SIGKILL" as const,
    maxBuffer: 1024 * 1024,
  };
  try {
    const gitRoot = await execFileAsync("git", ["rev-parse", "--show-toplevel"], commandOptions);
    const gitRootPath = gitRoot.stdout.trim();
    if (!gitRootPath || !path.isAbsolute(gitRootPath) || path.resolve(gitRootPath) !== repoRoot) {
      return {
        files: [],
        readback: {
          source: "git",
          status: "unavailable",
          reason: "git_worktree_identity_mismatch",
        },
      };
    }
    const [diff, status] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only", "HEAD"], commandOptions),
      execFileAsync("git", ["status", "--short", "--untracked-files=all"], commandOptions),
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
    if (Date.now() >= deadlineAt) {
      throw new Error("git_collection_deadline");
    }
    return { files: [...changed].toSorted(), readback: { source: "git", status: "observed" } };
  } catch {
    return {
      files: [],
      readback: { source: "git", status: "unavailable", reason: "git_changed_paths_unavailable" },
    };
  }
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

export type CleanupReviewHost = {
  rootDir: string;
  repoRoot: string;
  parentRunId: string;
  snapshot: Pick<LcxRunSnapshot, "snapshotId" | "sourceCommit" | "sourceBranch" | "authorityOwner">;
};
type CleanupSourceRef = { path: string; sha256: string };
type CleanupReviewInput = {
  schemaVersion: 1 | 2;
  governance: CleanupSourceRef;
  sources: {
    universeIndex: CleanupSourceRef;
    mindModel: CleanupSourceRef;
    flowGraph: CleanupSourceRef;
    contextRecovery?: CleanupSourceRef;
  };
  candidates: string[];
};
type CleanupRead = CleanupSourceRef & { pointer: string; value: unknown };
type CleanupDisposition = {
  candidateRef: CleanupSourceRef & { pointer: string };
  candidate: unknown;
  owner: string[];
  disposition: "preserve" | "unknown";
  reason: string;
  missingChecks: string[];
};
export type CleanupReviewResult = {
  status: "reviewed" | "blocked";
  reason: string;
  scope: { parentRunId: string; snapshotId: string; repoRoot: string };
  sourceReads: CleanupRead[];
  dispositions: CleanupDisposition[];
  coverage: "selected_candidates_only";
  cleanupAuthorized: false;
  semanticTruth: "not_proven";
};

function cleanupRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cleanup_review_object_invalid");
  }
  return value as Record<string, unknown>;
}
function cleanupKeys(value: unknown, keys: string[]) {
  const record = cleanupRecord(value);
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error("cleanup_review_schema_invalid");
  }
  return record;
}
function cleanupRef(value: unknown): CleanupSourceRef {
  const ref = cleanupKeys(value, ["path", "sha256"]);
  if (
    typeof ref.path !== "string" ||
    !ref.path ||
    typeof ref.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(ref.sha256)
  ) {
    throw new Error("cleanup_review_reference_invalid");
  }
  return { path: ref.path, sha256: ref.sha256 };
}

type MechanismComparison = {
  status: "reviewed" | "unknown";
  disposition: "preserve" | "merge_candidate" | "unknown";
  reason: string;
  decisionStatus: "selected_comparison_reviewed" | "unresolved_mechanism_comparison";
  targetPath?: string;
  ownerPath?: string;
  checks: { id: string; before: number | boolean; after: number | boolean; changed: boolean }[];
  sourceReads: { path: string; sha256: string; pointer?: string }[];
  coverage: "selected_behavior_reports_only";
  semanticEquivalence: "not_proven";
  sourceMutationAuthorized: false;
};

/** Compare pinned source and selected behavior reports; this never authorizes a source migration. */
export async function reviewMechanismComparison(
  inputValue: unknown,
  host: { rootDir: string; repoRoot: string; deadlineAt?: number },
  routes: ConsolidationRoute[],
): Promise<MechanismComparison> {
  const result: MechanismComparison = {
    status: "unknown",
    disposition: "unknown",
    reason: "mechanism_review_not_completed",
    decisionStatus: "unresolved_mechanism_comparison",
    checks: [],
    sourceReads: [],
    coverage: "selected_behavior_reports_only",
    semanticEquivalence: "not_proven",
    sourceMutationAuthorized: false,
  };
  const deadlineAt = host.deadlineAt ?? Date.now() + 20_000;
  try {
    const input = cleanupKeys(inputValue, [
      "schemaVersion",
      "repoRoot",
      "targetPath",
      "ownerPath",
      "disposition",
      "beforeSource",
      "afterSource",
      "beforeSourceHash",
      "afterSourceHash",
      "beforeInputHash",
      "afterInputHash",
      "checks",
    ]);
    if (
      input.schemaVersion !== "lcx_mechanism_comparison_v1" ||
      input.repoRoot !== host.repoRoot ||
      typeof input.targetPath !== "string" ||
      typeof input.ownerPath !== "string" ||
      !["preserve", "merge_candidate"].includes(String(input.disposition))
    ) {
      throw new Error("mechanism_review_scope_invalid");
    }
    const route = routes.find((row) => row.source.path === input.targetPath);
    if (!route) {
      throw new Error("mechanism_review_source_not_inspected");
    }
    if (
      route.disposition !== "preserve_existing_owner" ||
      route.gaps.length ||
      !route.ownerSources.some((source) => source.path === input.ownerPath)
    ) {
      throw new Error("mechanism_review_original_owner_unconfirmed");
    }
    result.targetPath = input.targetPath;
    result.ownerPath = input.ownerPath;
    const read = async (value: unknown, sourceCode = false) => {
      const ref = sourceCode
        ? cleanupRef(value)
        : (() => {
            const field = cleanupKeys(value, ["path", "sha256", "pointer"]);
            const base = cleanupRef({ path: field.path, sha256: field.sha256 });
            if (
              typeof field.pointer !== "string" ||
              !field.pointer.startsWith("/") ||
              field.pointer.length > 512
            ) {
              throw new Error("mechanism_review_field_invalid");
            }
            return { ...base, pointer: field.pointer };
          })();
      const absolute = path.resolve(host.rootDir, ref.path);
      const rootDir =
        sourceCode &&
        [input.targetPath, input.ownerPath].some(
          (file) => absolute === path.resolve(host.repoRoot, String(file)),
        )
          ? host.repoRoot
          : host.rootDir;
      if (Date.now() >= deadlineAt) {
        throw new Error("mechanism_review_deadline_cleanup_unconfirmed");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let opened: Awaited<ReturnType<typeof readFileWithinRoot>>;
      let expectedRealPath: string | undefined;
      try {
        opened = await Promise.race([
          (async () => {
            expectedRealPath = path.resolve(
              await fs.realpath(rootDir),
              path.relative(rootDir, absolute),
            );
            return readFileWithinRoot({
              rootDir,
              relativePath: path.relative(rootDir, absolute),
              rejectHardlinks: true,
              maxBytes: 128 * 1024,
            });
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("mechanism_review_deadline_cleanup_unconfirmed")),
              Math.max(1, deadlineAt - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (
        createHash("sha256").update(opened.buffer).digest("hex") !== ref.sha256 ||
        opened.realPath !== expectedRealPath
      ) {
        throw new Error("mechanism_review_source_hash_conflict");
      }
      result.sourceReads.push({ ...ref, path: absolute });
      if (sourceCode) {
        return { ref, absolute };
      }
      let data: unknown;
      try {
        data = JSON.parse(opened.buffer.toString("utf8"));
      } catch {
        throw new Error("mechanism_review_report_invalid");
      }
      for (const part of ("pointer" in ref ? String(ref.pointer) : "").slice(1).split("/")) {
        const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
        if (!data || typeof data !== "object" || !Object.hasOwn(data, key)) {
          throw new Error("mechanism_review_report_field_missing");
        }
        data = (data as Record<string, unknown>)[key];
      }
      return data;
    };
    const beforeRef = cleanupRef(input.beforeSource);
    const afterRef = cleanupRef(input.afterSource);
    if (
      !/\.(?:ts|js|mjs|cjs)$/u.test(beforeRef.path) ||
      path.resolve(host.rootDir, afterRef.path) !== path.resolve(host.repoRoot, input.targetPath) ||
      afterRef.sha256 !== route.source.sha256
    ) {
      throw new Error("mechanism_review_current_source_conflict");
    }
    await read(input.beforeSource, true);
    await read(input.afterSource, true);
    const owner = route.ownerSources.find((source) => source.path === input.ownerPath);
    if (!owner) {
      throw new Error("mechanism_review_original_owner_unconfirmed");
    }
    await read({ path: path.resolve(host.repoRoot, owner.path), sha256: owner.sha256 }, true);
    if (
      (await read(input.beforeSourceHash)) !== beforeRef.sha256 ||
      (await read(input.afterSourceHash)) !== afterRef.sha256
    ) {
      throw new Error("mechanism_review_report_source_conflict");
    }
    const beforeInput = await read(input.beforeInputHash);
    const afterInput = await read(input.afterInputHash);
    if (
      typeof beforeInput !== "string" ||
      !/^[a-f0-9]{64}$/u.test(beforeInput) ||
      beforeInput !== afterInput
    ) {
      throw new Error("mechanism_review_behavior_input_conflict");
    }
    if (!Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 8) {
      throw new Error("mechanism_review_behavior_checks_missing");
    }
    const ids = new Set<string>();
    for (const value of input.checks) {
      const check = cleanupKeys(value, [
        "id",
        "before",
        "after",
        "expectedBefore",
        "expectedAfter",
      ]);
      if (
        typeof check.id !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(check.id) ||
        ids.has(check.id)
      ) {
        throw new Error("mechanism_review_behavior_id_invalid");
      }
      ids.add(check.id);
      const before = await read(check.before);
      const after = await read(check.after);
      const scalar = (v: unknown): v is number | boolean =>
        typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
      if (
        !scalar(before) ||
        !scalar(after) ||
        before !== check.expectedBefore ||
        after !== check.expectedAfter
      ) {
        throw new Error("mechanism_review_behavior_expectation_failed");
      }
      result.checks.push({ id: check.id, before, after, changed: before !== after });
    }
    // Repin all actual inputs after the comparison, including unchanged owner identity.
    const actualReads = [...result.sourceReads];
    result.sourceReads = [];
    for (const ref of actualReads) {
      await read(
        "pointer" in ref
          ? { path: ref.path, sha256: ref.sha256, pointer: ref.pointer }
          : { path: ref.path, sha256: ref.sha256 },
        !("pointer" in ref),
      );
    }
    result.status = "reviewed";
    result.decisionStatus = "selected_comparison_reviewed";
    result.disposition = input.disposition as "preserve" | "merge_candidate";
    result.reason =
      "Pinned original ownership and selected before/after behavioral expectations checked; report provenance and whole semantic equivalence remain separate.";
  } catch (error) {
    result.status = "unknown";
    result.disposition = "unknown";
    const reason = error instanceof Error ? error.message : "";
    result.reason = reason.startsWith("mechanism_review_")
      ? reason
      : "mechanism_review_input_or_source_unconfirmed";
  }
  return result;
}
function parseCleanupReviewInput(value: unknown): CleanupReviewInput {
  const input = cleanupKeys(value, ["schemaVersion", "governance", "sources", "candidates"]);
  const sources = cleanupKeys(input.sources, [
    "universeIndex",
    "mindModel",
    "flowGraph",
    ...(input.schemaVersion === 2 ? ["contextRecovery"] : []),
  ]);
  if (
    (input.schemaVersion !== 1 && input.schemaVersion !== 2) ||
    !Array.isArray(input.candidates) ||
    input.candidates.length > 256 ||
    input.candidates.some(
      (pointer) =>
        typeof pointer !== "string" ||
        !/^\/value\/garbageCandidates\/(untrackedRepoFiles|unmatchedChangedFiles|staleRuntimeFiles|largeRuntimeFiles|staleSnapshots)\/(0|[1-9]\d*)$/u.test(
          pointer,
        ),
    ) ||
    new Set(input.candidates).size !== input.candidates.length
  ) {
    throw new Error("cleanup_review_candidates_invalid");
  }
  return {
    schemaVersion: input.schemaVersion,
    governance: cleanupRef(input.governance),
    sources: {
      universeIndex: cleanupRef(sources.universeIndex),
      mindModel: cleanupRef(sources.mindModel),
      flowGraph: cleanupRef(sources.flowGraph),
      ...(input.schemaVersion === 2
        ? { contextRecovery: cleanupRef(sources.contextRecovery) }
        : {}),
    },
    candidates: input.candidates as string[],
  };
}

/** Read original archives; the caller supplies expected scope independently of these sources. */
export async function reviewUniverseCleanup(
  inputValue: unknown,
  host: CleanupReviewHost,
): Promise<CleanupReviewResult> {
  const result: CleanupReviewResult = {
    status: "blocked",
    reason: "cleanup_review_not_completed",
    scope: {
      parentRunId: host.parentRunId,
      snapshotId: host.snapshot?.snapshotId,
      repoRoot: host.repoRoot,
    },
    sourceReads: [],
    dispositions: [],
    coverage: "selected_candidates_only",
    cleanupAuthorized: false,
    semanticTruth: "not_proven",
  };
  try {
    if (
      !host.parentRunId ||
      !host.snapshot?.snapshotId ||
      !host.snapshot.sourceCommit ||
      !host.snapshot.sourceBranch ||
      !host.snapshot.authorityOwner ||
      !path.isAbsolute(host.rootDir) ||
      !path.isAbsolute(host.repoRoot)
    ) {
      throw new Error("cleanup_review_host_scope_missing");
    }
    const input = parseCleanupReviewInput(inputValue);
    const read = async (ref: CleanupSourceRef) => {
      const opened = await readFileWithinRoot({
        rootDir: host.rootDir,
        relativePath: path.relative(host.rootDir, path.resolve(host.rootDir, ref.path)),
        maxBytes: 16 * 1024 * 1024,
      });
      if (createHash("sha256").update(opened.buffer).digest("hex") !== ref.sha256) {
        throw new Error("cleanup_review_hash_conflict");
      }
      return JSON.parse(opened.buffer.toString("utf8")) as unknown;
    };
    const field = (
      body: unknown,
      ref: CleanupSourceRef,
      pointer: string,
      retain = true,
    ): unknown => {
      let value = body;
      for (const key of pointer.slice(1).split("/")) {
        if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
          throw new Error(`cleanup_review_field_missing:${pointer}`);
        }
        value = (value as Record<string, unknown>)[key];
      }
      if (retain) {
        result.sourceReads.push({ ...ref, pointer, value });
      }
      return value;
    };
    const governance = await read(input.governance);
    const predecision = cleanupRecord(governance).schemaVersion === "lcx_agent_artifact_v1";
    const prefix = predecision ? "/value" : "";
    if (
      predecision &&
      (field(governance, input.governance, "/owner") !== "lcx-governance-autopilot" ||
        field(governance, input.governance, "/runId") !== host.parentRunId ||
        field(governance, input.governance, "/value/schemaVersion") !==
          "lcx_central_governance_input_v1" ||
        field(governance, input.governance, "/value/boundary") !==
          "same_cycle_completed_owners_only" ||
        field(governance, input.governance, "/value/phase") !== "before_central_decision")
    ) {
      throw new Error("cleanup_review_predecision_scope_conflict");
    }
    const parent = predecision
      ? undefined
      : cleanupRecord(field(governance, input.governance, "/runReceipt"));
    const snapshot = cleanupRecord(field(governance, input.governance, `${prefix}/snapshot`));
    const matchesSnapshot = (value: unknown) => {
      const actual = cleanupRecord(value);
      return (
        Object.entries(host.snapshot).every(([key, expected]) => actual[key] === expected) &&
        actual.observedAt === snapshot.observedAt
      );
    };
    if (
      field(governance, input.governance, predecision ? "/value/parentRunId" : "/runId") !==
        host.parentRunId ||
      !matchesSnapshot(snapshot) ||
      (parent &&
        (parent.contractVersion !== "lcx_run_receipt_v3" ||
          parent.runId !== host.parentRunId ||
          parent.owner !== "lcx-governance-autopilot" ||
          parent.checkedAt !== snapshot.observedAt ||
          !matchesSnapshot(parent.snapshot)))
    ) {
      throw new Error("cleanup_review_governance_scope_conflict");
    }
    const rows = predecision
      ? Object.values(cleanupRecord(field(governance, input.governance, "/value/byOwner", false)))
      : field(governance, input.governance, "/ownerCommands", false);
    if (!Array.isArray(rows)) {
      throw new Error("cleanup_review_owner_receipts_missing");
    }
    const bodies: Record<string, unknown> = {};
    const sourceIds: Array<keyof CleanupReviewInput["sources"]> = [
      "universeIndex",
      "mindModel",
      "flowGraph",
      ...(input.schemaVersion === 2 ? ["contextRecovery" as const] : []),
    ];
    for (const id of sourceIds) {
      const matches = rows.filter((row) => cleanupRecord(row).id === id);
      if (matches.length !== 1) {
        throw new Error(`cleanup_review_owner_receipt_missing:${id}`);
      }
      const row = cleanupRecord(matches[0]);
      const rowPointer = predecision
        ? `/value/byOwner/${id}`
        : `/ownerCommands/${rows.indexOf(matches[0])}`;
      const receipt = cleanupRecord(
        field(governance, input.governance, `${rowPointer}/runReceipt`),
      );
      if (
        receipt.contractVersion !== "lcx_run_receipt_v3" ||
        receipt.owner !== id ||
        receipt.checkedAt !== snapshot.observedAt ||
        receipt.parentRunId !== host.parentRunId ||
        !matchesSnapshot(receipt.snapshot) ||
        typeof receipt.runId !== "string" ||
        !receipt.runId
      ) {
        throw new Error(`cleanup_review_owner_scope_conflict:${id}`);
      }
      const ref = input.sources[id];
      if (!ref) {
        throw new Error(`cleanup_review_source_ref_missing:${id}`);
      }
      const recording = cleanupRecord(
        field(
          governance,
          input.governance,
          predecision ? `${rowPointer}/compact/artifactEvidence` : `/owners/${id}/artifactEvidence`,
        ),
      );
      if (
        !["registered", "unchanged"].includes(String(recording.status)) ||
        recording.sha256 !== ref.sha256 ||
        recording.relativePath !== `state/artifacts/${ref.sha256}.json` ||
        path.resolve(host.rootDir, String(recording.relativePath)) !==
          path.resolve(host.rootDir, ref.path)
      ) {
        throw new Error(`cleanup_review_artifact_binding_conflict:${id}`);
      }
      const artifact = await read(ref);
      if (
        field(artifact, ref, "/schemaVersion") !== "lcx_agent_artifact_v1" ||
        field(artifact, ref, "/owner") !== id ||
        field(artifact, ref, "/runId") !== receipt.runId
      ) {
        throw new Error(`cleanup_review_artifact_scope_conflict:${id}`);
      }
      const observedAt = field(artifact, ref, "/observedAt");
      const checkedAt = field(artifact, ref, "/value/checkedAt");
      if (
        typeof checkedAt !== "string" ||
        !Number.isFinite(Date.parse(checkedAt)) ||
        observedAt !== new Date(checkedAt).toISOString()
      ) {
        throw new Error(`cleanup_review_source_time_conflict:${id}`);
      }
      if (
        (!predecision && row.parsed !== true) ||
        row.ok !== true ||
        receipt.status !== "passed" ||
        field(artifact, ref, "/value/ok") !== true
      ) {
        throw new Error(`cleanup_review_upstream_quality_failed:${id}`);
      }
      bodies[id] = cleanupRecord(artifact);
      if (id === "contextRecovery") {
        if (
          field(artifact, ref, "/value/boundary") !== "local_context_recovery_exam_only" ||
          field(artifact, ref, "/value/compressedContextRecovered") !== true
        ) {
          throw new Error("cleanup_review_recovery_not_complete");
        }
        const checks = field(artifact, ref, "/value/checks", false);
        if (!Array.isArray(checks) || checks.length === 0) {
          throw new Error("cleanup_review_recovery_checks_missing");
        }
        for (const [index] of checks.entries()) {
          const check = cleanupRecord(checks[index]);
          if (
            typeof check.id !== "string" ||
            !check.id.trim() ||
            field(artifact, ref, `/value/checks/${index}/ok`) !== true
          ) {
            throw new Error(`cleanup_review_recovery_check_failed:${index}`);
          }
        }
      }
    }
    if (
      field(bodies.universeIndex, input.sources.universeIndex, "/value/repoRoot") !== host.repoRoot
    ) {
      throw new Error("cleanup_review_repo_scope_conflict");
    }
    for (const [id, pointers] of [
      ["mindModel", ["/value/lanes", "/value/invariants"]],
      ["flowGraph", ["/value/checks"]],
    ] as const) {
      for (const pointer of pointers) {
        const checks = field(bodies[id], input.sources[id], pointer, false);
        if (!Array.isArray(checks) || checks.length === 0) {
          throw new Error(`cleanup_review_upstream_checks_failed:${id}:${pointer}`);
        }
        for (const [index] of checks.entries()) {
          field(bodies[id], input.sources[id], `${pointer}/${index}/id`);
          if (field(bodies[id], input.sources[id], `${pointer}/${index}/ok`) !== true) {
            throw new Error(`cleanup_review_upstream_checks_failed:${id}:${pointer}/${index}/ok`);
          }
        }
      }
    }
    const candidates = input.candidates.map((pointer) => ({
      pointer,
      candidate: field(bodies.universeIndex, input.sources.universeIndex, pointer),
    }));
    for (const { pointer, candidate } of candidates) {
      const file = typeof candidate === "string" ? candidate : cleanupRecord(candidate).path;
      const relativeFile =
        typeof file === "string" && path.isAbsolute(file)
          ? path.relative(host.repoRoot, file)
          : file;
      const ownedPath =
        typeof relativeFile === "string" &&
        relativeFile &&
        !path.isAbsolute(relativeFile) &&
        !relativeFile.split(/[\\/]/u).includes("..");
      const impacts = ownedPath ? impactFor([relativeFile]) : [];
      result.dispositions.push({
        candidateRef: { ...input.sources.universeIndex, pointer },
        candidate,
        owner: [...new Set(impacts.map((impact) => impact.lane))],
        disposition: impacts.length > 0 ? "preserve" : "unknown",
        reason:
          impacts.length > 0
            ? "Existing owner lane requires preserving this candidate pending executed reference and retention checks; architecture checks prove structure only."
            : "No exact owned repository path; inventory age, size or snapshot staleness cannot establish cleanup eligibility.",
        missingChecks: [
          ...new Set([
            ...impacts.flatMap((impact) => impact.requiredChecks),
            "executed_cleanup_reference_review",
            "retention_and_active_writer_review",
          ]),
        ],
      });
    }
    result.status = "reviewed";
    result.reason =
      "Exact archived sources consumed; conservative selected-candidate dispositions only.";
  } catch (error) {
    result.dispositions = [];
    result.reason = error instanceof Error ? error.message : "cleanup_review_read_failed";
  }
  return result;
}

async function main() {
  const deadlineAt = Date.now() + 20_000;
  const options = parseArgs(process.argv.slice(2));
  let cleanupReview: CleanupReviewResult | undefined;
  if (options.cleanupReview) {
    const rootDir = path.resolve(options.reviewRootDir ?? repoRoot);
    const host: CleanupReviewHost = {
      rootDir,
      repoRoot,
      parentRunId: options.reviewParentRunId ?? "",
      snapshot: {
        snapshotId: options.reviewSnapshotId ?? "",
        sourceCommit: "",
        sourceBranch: "",
        authorityOwner: "lcx-governance-autopilot",
      },
    };
    try {
      const [commit, branch] = await Promise.all([
        execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
        execFileAsync("git", ["branch", "--show-current"], { cwd: repoRoot }),
      ]);
      host.snapshot.sourceCommit = commit.stdout.trim();
      host.snapshot.sourceBranch = branch.stdout.trim();
      const opened = await readFileWithinRoot({
        rootDir,
        relativePath: path.relative(rootDir, path.resolve(rootDir, options.cleanupReview)),
        maxBytes: 256 * 1024,
      });
      cleanupReview = await reviewUniverseCleanup(JSON.parse(opened.buffer.toString("utf8")), host);
    } catch (error) {
      cleanupReview = await reviewUniverseCleanup(undefined, host);
      cleanupReview.reason =
        error instanceof Error ? error.message : "cleanup_review_input_read_failed";
    }
  } else if (
    options.reviewParentRunId ||
    options.reviewSnapshotId ||
    (options.reviewRootDir && !options.mechanismReview)
  ) {
    throw new Error("review scope requires --cleanup-review");
  }
  const collection =
    options.changed.length > 0
      ? {
          files: options.changed,
          readback: { source: "explicit_paths" as const, status: "observed" as const },
        }
      : await gitChangedFiles(deadlineAt);
  const changedFiles = normalizeChangedFiles(collection.files);
  const changedFilesReadback = collection.readback;
  const pathsObserved = changedFilesReadback.status === "observed";
  const impacts = impactFor(changedFiles);
  const deferredCommands = uniqueDeferredCommands(impacts);
  const safetyNotes = uniqueSafetyNotes(impacts);
  const unmatchedFiles = changedFiles.filter(
    (file) => !impacts.some((impact) => impact.matchedFiles.includes(file)),
  );
  const priorWork = await readPriorWork(
    changedFiles,
    changedFilesReadback,
    impacts,
    deadlineAt,
    options.inspectPriorWork,
  );
  const consolidation = await readConsolidation(priorWork, deadlineAt);
  let mechanismReview: MechanismComparison | undefined;
  if (options.mechanismReview) {
    let input: unknown;
    const rootDir = path.resolve(options.reviewRootDir ?? repoRoot);
    try {
      const opened = await readFileWithinRoot({
        rootDir,
        relativePath: path.relative(rootDir, path.resolve(rootDir, options.mechanismReview)),
        rejectHardlinks: true,
        maxBytes: 16 * 1024,
      });
      input = JSON.parse(opened.buffer.toString("utf8"));
    } catch {
      input = undefined;
    }
    mechanismReview = await reviewMechanismComparison(
      input,
      { rootDir, repoRoot, deadlineAt },
      consolidation.routes,
    );
    if (mechanismReview.status === "unknown") {
      for (const route of consolidation.routes.filter(
        (row) => row.source.path === mechanismReview?.targetPath,
      )) {
        route.disposition = "owner_unresolved";
        route.gaps.push(mechanismReview.reason);
      }
    }
  }
  const strayGate = {
    ok:
      pathsObserved &&
      unmatchedFiles.length === 0 &&
      !priorWork.blocksPlan &&
      !consolidation.blocksPlan &&
      (!mechanismReview || mechanismReview.status === "reviewed"),
    ...(mechanismReview ? { mechanismReview } : {}),
    priorWork,
    consolidation,
    rule: "every changed file must match at least one owner lane",
    unmatchedChangedFiles: unmatchedFiles,
    nextAction:
      mechanismReview?.status === "unknown"
        ? mechanismReview.reason
        : !pathsObserved
          ? "restore Git worktree evidence or provide explicit changed paths; unknown is not clean"
          : consolidation.blocksPlan
            ? `resolve declared ownership conflict: ${consolidation.conflicts.map((conflict) => conflict.reason).join(",")}`
            : priorWork.blocksPlan
              ? `restore original implementation comparison: ${priorWork.gaps.join(",")}`
              : unmatchedFiles.length === 0
                ? priorWork.status === "partial"
                  ? "mapping observed; narrow-read priorWork omissions before claiming full comparison"
                  : "none"
                : "add an owner rule, move the file under an owned path, ignore generated output, or delete the artifact",
  };
  const result = {
    ok: strayGate.ok && cleanupReview?.status !== "blocked",
    boundary: "local_change_impact_plan_only",
    checkedAt: new Date().toISOString(),
    changedFiles,
    changedFilesReadback,
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
    ...(mechanismReview ? { mechanismReview } : {}),
    ...(cleanupReview ? { cleanupReview } : {}),
    escalation: {
      runFullDoctor:
        impacts.some((impact) => impact.risk === "elevated" || impact.headTailRequired) ||
        changedFiles.length > 6 ||
        !strayGate.ok,
      reason: !pathsObserved
        ? "Git changed-path evidence is unavailable; no clean-worktree conclusion is possible"
        : !strayGate.ok
          ? priorWork.blocksPlan
            ? "original implementation comparison is incomplete; unknown is not clean"
            : "unmatched changed files are not allowed; every changed file needs one owner lane"
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
          ...(!pathsObserved
            ? [`- blocked: ${changedFilesReadback.reason}; ${strayGate.nextAction}`]
            : []),
          ...result.recommendedFastCommands.map((command) => `- ${command}`),
          ...deferredCommands.map((command) => `- deferred: ${command}`),
          ...safetyNotes.map((note) => `- note: ${note}`),
        ].join("\n") + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
