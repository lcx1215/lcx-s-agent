# LCX Agent Repository Contract

LCX Agent is the standalone product at https://github.com/lcx1215/lcx-s-agent.
Historical runtime identifiers are compatibility-only; upstream is lineage, not
another source or release authority. Global collaboration rules apply; this file
adds project contracts. Keep volatile commands, models and incidents in runbooks.

## Finance authority and outcomes

- `research_only` is the compatibility default; `strategy_candidate` and
  `conditional_trade_candidate` produce reviewable candidates. `live_execution`
  requires a declared adapter and authorization for venue, instrument, size and
  run. Autonomous Paper permits repeated instrument/side/size choices within its
  authorized venue, never Live fallback or implied credential/wallet access.
- All orders use the shared gate and existing source, account, venue, funding,
  quote-freshness, risk, deduplication and reconciliation owners. Provider config,
  authentication, training and protected memory have separate authority; code/Git
  work does not authorize changing them.
- Improve opportunity discovery, method composition and outcome feedback without
  fixing one strategy or requiring all modules per trade. Evaluate the whole
  selection process using net outcomes after fees/slippage, drawdown, an investable
  benchmark and out-of-sample evidence, per
  `ops/architecture/finance-automatic-lifecycle-owner-map.md`. Method changes preserve
  execution gates; current gaps are improvement targets, not permanent limits.

## Architecture and evolution

- Treat architecture as an evolvable baseline. Keep adapters replaceable; compare
  new model/harness methods on representative tasks, actual outcomes, tool-result
  adoption, reliability, latency and cost. Allow valid alternative paths; preserve
  invariants with scoped migration and recovery, without duplicating owners or
  execution paths. Partial evidence retains provenance/gaps, not private reasoning.
- Before changing an apparent failure, establish whether it is a defect, intended
  gate/tradeoff, obsolete design or external condition. Consult owner rationale,
  tests and focused history when intent is unclear; current requirements prevail.
- Keep one canonical ontology; relation/state changes require a versioned migration
  manifest. TypeScript owns routing, orchestration, governance, safety and recovery;
  Python supplies engines and numerical/model tools, not a second workflow authority.
- Central Agent Harness (`scripts/operator/lcx-central-agent.ts`,
  `src/agents/central-harness/`) proposes over governance snapshots; TypeScript gates
  approve/block. Each cycle appends `lcx-central-agent-log-latest.jsonl` and refreshes
  `lcx-central-agent-latest.json`. It has no execution authority or permission to
  touch live state, provider config, protected memory or external channels;
  an unavailable brain remains unavailable.
- `gateway` is the resident WebSocket/channel control plane; `serve` is independent
  daemon-free HTTP. State the observed entry and coverage. Daemon-free capabilities
  reuse existing handlers through generic process-local provider seams; missing
  optional capabilities degrade instead of aborting otherwise valid runs.
- Resident deployment requires detached execution and available supervision;
  scheduled autonomy also needs self-scheduling. Signalling an existing process
  does not prove permission to register a supervisor.
- Authorized workers need scope, result responsibility, timeout/cancellation and
  durable receipts.

## Project conventions

- Follow `ops/engineering/LCX-GIT-DELIVERY-STANDARD.md`: parallel writers use isolated
  branches/worktrees; `main`/resolved default remains read-only. One integration
  surface classifies candidates as `merge`, `preserve`, `superseded` or `unknown`.
  No blanket staging, broad cleanup/reset, force-push or silent switching.
- Use the commit helper when available and real author identity. Resolve current
  `origin` and qualify `gh --repo OWNER/REPO`; read `SECURITY.md` for security work
  and current release docs for release work. Project docs exclude live config,
  personal identifiers and host paths.
- Use manifest/lockfile commands and the delivery standard's G0–G3 tiers. Keep
  strict types, avoid `any`/`@ts-nocheck`, follow formatting and do not hand-edit
  generated output/node_modules. Source/tests: `src/`; extensions: `extensions/`;
  docs: `docs/`.
- Validate only as much as the change needs. Reduce unnecessary boundary tests,
  reruns and checks; do not delay delivery out of fear. Reuse unchanged valid
  results; expand only for concrete failures, relevant changes or unresolved
  questions. Preserve targeted permission, trading, side-effect and recovery checks.
- Lazy CLI help and package entry names do not establish runtime wiring; inspect
  registration/argument parsing and scoped execution when that behavior is at issue.
- For a new window continuing complex LCX work, use `lcx-context-recovery-exam`
  when durable-state recovery needs verification, not for every simple task.
