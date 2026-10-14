import type { LcxOntologyWorkflowNodeId, LcxOntologyWorkflowScenarioId } from "./lcx-ontology.js";

/** Describes the existing factory. These contracts are audit data, never dispatch or trading authority. */
export type LcxWorkflowProcessContract = Readonly<{
  entrypoint: string;
  /** Original dispatch/control edges; joined result data is not an input to the dispatched owner. */
  controlEdges?: readonly (readonly [LcxOntologyWorkflowNodeId, LcxOntologyWorkflowNodeId])[];
  stages: readonly Readonly<{
    owner: string;
    nodes: readonly LcxOntologyWorkflowNodeId[];
    input: string;
    output: string;
    preconditions: string;
    evidenceMode: "local_receipt" | "fixture_adapter" | "natural_external" | "natural_model";
    /** Source inventory, not an executed business state or receipt acceptance. */
    implementationStatus?: "existing_source" | "required_unobserved" | "required_not_implemented";
  }>[];
  receiptSurfaces: readonly string[];
  boundary: "descriptive_process_contract_no_execution_authority";
}>;

export const LCX_WORKFLOW_PROCESS_CONTRACTS = {
  finance_caseflow_waterflow: {
    entrypoint: "scripts/operator/lcx-finance-research.ts",
    stages: [
      {
        owner: "src/agents/finance-research-runner.ts",
        nodes: ["research_case", "source_registry", "research_run"],
        input: "Case question, asOf and source-bound module inputs",
        output: "Original research receipt, source statuses and explicit gaps",
        preconditions:
          "No model call or current data may be invented; plan-only is not executed research",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-research-runner.ts",
        nodes: ["review_panel"],
        input: "Executed source receipts and exact evidence passed to committee/quality review",
        output: "Original quality status, artifact, failed gates and explicit evidence gaps",
        preconditions:
          "Quality failure cannot become adoption; model fixtures do not prove real model inference or human signoff",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-caseflow.ts",
        nodes: ["decision_packet"],
        input: "Original research receipt and immutable case identity",
        output: "Frozen decision packet, content fingerprint and provenance edges",
        preconditions:
          "Adoption must agree with retained original status, passed gates and linked evidence; hashes or legal edges alone are insufficient",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-outcome-ledger.ts",
        nodes: ["outcome_ledger"],
        input: "Frozen packet reference, dated observations and original claim/forecast ids",
        output: "Append-only outcome and subsequent readback",
        preconditions:
          "Unknown claims, conflicting recordId or post-cutoff evidence cannot rewrite the packet",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "src/agents/finance-caseflow.test.ts",
      "src/agents/finance-outcome-ledger.test.ts",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  external_finance_research_waterflow: {
    entrypoint: "scripts/operator/lcx-commercial-answer-pipeline.ts",
    stages: [
      {
        owner: "src/agents/finance-brain-orchestration.ts",
        nodes: ["ingress_external_message", "intent_classifier", "local_brain_planner"],
        input: "External ask and language/context boundary",
        output: "Intent-family route with concrete module questions",
        preconditions: "An external ask grants no execution or provider configuration authority",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-research-runner.ts",
        nodes: ["source_registry"],
        input: "Selected targets, source adapters and asOf from the research plan",
        output: "Actual collected batch and its source/quality gaps before module execution",
        preconditions:
          "Unavailable data blocks sourced claims; no forced full source or module run",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-module-execution.ts",
        nodes: ["finance_research_modules"],
        input: "Original planned composition, collected batch, evidence and producer inputs",
        output: "Executed node receipts and evidence consumed by research Quality",
        preconditions:
          "Required module failures retain their admission block; optional learning gaps remain explicit without blocking unrelated causal work",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/tools/finance-learning-capability-apply-tool.ts",
        nodes: ["finance_learning_memory"],
        input: "Source-bound retrieved capability and current question",
        output: "Application receipt tied to original evidence",
        preconditions: "Stored text or global eval cannot stand in for source-specific application",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-module-execution.ts",
        nodes: ["causal_map"],
        input: "Selected causal module, scoped evidence and declared domain producer input",
        output: "Original causal producer and core-inspect result consumed by research Quality",
        preconditions:
          "Missing producer input remains a named gap; Quality consumption does not prove subsequent reply adoption or source truth",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-research-runner.ts",
        nodes: ["review_panel"],
        input: "Original research and executed module evidence plus their unresolved gaps",
        output: "Original Quality answer or failure with decision-dependent feedback",
        preconditions:
          "Quality consumption is distinct from the external reply audit; failed mandatory portfolio prerequisites prevent review from starting",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/pi-embedded-runner/run.ts",
        nodes: ["model_tool_decision"],
        input:
          "Actual bounded research tool feedback and its original receipt hash in the existing model/tool loop",
        output:
          "Next decision to retain valid evidence, change the next tool question, or stop, with the specific reason and remaining gaps",
        preconditions:
          "Review does not mandate re-executing successful modules. Missing optional learning remains distinct from failed mandatory Quality. The existing model adapter owns the choice; offline transport substitutes prove the handoff only, and natural semantic adoption remains separate. No extra calls, budgets or authority are granted",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["control_room_summary"],
        input: "Actual candidate, source snapshot and declared audit options",
        output: "Original adoption/refusal and exact source or quality gaps",
        preconditions:
          "Unsupported numbers block only under the existing explicit grounding option; input identity is not semantic adoption",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/auto-reply/reply/agent-runner.ts",
        nodes: ["visible_reply"],
        input: "Adopted readable answer and declared channel context",
        output: "Local delivery handoff; real inbound/outbound receipt remains separate",
        preconditions:
          "Explicit commercial review, or a host-verified same-run financial reference, binds the native audit to this message, original ask and presentation-filtered final body before the original main or queued reply gate. Its terminal summary supplies actual failure explanations while source and quality failures remain blocked. Ordinary replies retain their original path; local acceptance cannot claim external delivery or semantic correctness",
        evidenceMode: "natural_external",
      },
    ],
    receiptSurfaces: [
      "external-message-channel",
      "finance_learning_capability_apply",
      "review_panel",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  directed_daily_research_brief_waterflow: {
    entrypoint: "scripts/operator/lcx-directed-daily-research-brief.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-directed-daily-research-brief.ts",
        nodes: ["schedule_gate"],
        input: "Independent daily research admission and current clock",
        output: "Due or held daily research attempt",
        preconditions:
          "Explicit requested admission uses the original UTC date convention and an independent host clock/account/run. The original latest or dated archived daily receipt is safely reread and hash pinned; missing or conflicting history, a future date, same-day repetition and an unresolved prior attempt stay held before research. An explicit first attempt requires the original latest receipt to be absent. The optional gate is consumed within the existing caller deadline; original task/batch CLI can load an explicit pinned admission file through the same bounded read seam and records its actual input path/hash. Manual execution without admission remains unobserved for this stage. Original read/review publication preserves independently verified native execution and immutable date archives; a failed or unverified content review remains held even when its prior research execution succeeded. This read gate is not a scheduler, an atomic cross-process claim, a trade permission or proof of natural dispatch",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-directed-daily-research-brief.ts",
        nodes: ["focused_research_universe", "directed_daily_research_brief"],
        input: "Requested date and fixed product universe",
        output: "Focused research task/section contract and local brief",
        preconditions:
          "Default plan/read defines the product and reads frozen cases without dispatching research. Explicit task execution selects one task; explicit batch execution selects all four fixed tasks using pinned requests and an independent parent account/run/date/asOf. A batch shares one total model/API allocation and deadline. Neither creates a schedule or proves the due gate ran. Readable cases remain contentAcceptance=review_required",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-research-runner.ts",
        nodes: [
          "finance_data_gateway",
          "finance_research_modules",
          "source_registry",
          "causal_map",
          "candidate_watchlist",
        ],
        input: "Focused ask, source snapshot and selected modules",
        output: "Source-bound research receipt and watchlist candidate",
        preconditions:
          "Explicit execution calls the original checkpointed research runner and selected registered modules with one total deadline capped at 120 seconds. A four-task batch conservatively allocates the parent's model/API limits without restoring failed allocations; each child receives its bounded allowance and remaining parent deadline. source_registry and causal_map are original runner evidence construction and consumption, not independent workers. Optional learning lookup gaps remain node diagnostics and replan feedback; declared mandatory modules, source and quality gates still govern packet admission. The original third-task host checks the saved watchlist shape, universe and source references before Caseflow persistence. Generic analysis that lacks the required tiers remains a held task, with its original research/quality result preserved; the batch records a failed attempted task rather than claiming it was unexecuted. This requirement is specific to the declared watchlist task, not a new global finance gate. Exhausted and unstarted tasks retain their gaps",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/quality-harness.ts",
        nodes: ["review_panel"],
        input:
          "Original reader sections, exact case/source/date/task scope and daily task requirements",
        output:
          "Original independent content-review result, input fingerprint and unresolved daily coverage",
        preconditions:
          "Explicit task execution passes native module results into the original runner's quality review. Separate explicit brief review consumes eligible returned sections; held sources are not submitted as accepted facts. For batch bindings, the original review CLI reads the explicit hash-pinned batch host and passes it to the same existing reader; it never infers batch identity from a case or grants schedule authority. Readable packets may provide causalHypotheses at their existing supportingAnalysis field. The original review input preserves this bounded field through the existing causal assessment schema, keeps alternatives and disconfirming tests, namespaces references to the same original task sources, and reports invalid structure, unresolved references or exact byte omission; candidate interpretations do not establish identified causality. The original third-task packet may provide the four declared tiers at supportingAnalysis.directedWatchlist. The original reader and input builder pass only that bounded field to the same Quality consumer, bind candidates to the existing universe and source evidence, and report missing structure, unresolved references or absent counterevidence/gaps through actual verification details. An exact legacy third-task ask remains readable but does not bypass these content checks. Other supporting analysis is not forwarded wholesale. Neither becomes a prerequisite for other finance lanes. Structurally valid tiers or legal references do not establish source truth, semantic acceptance or trading authority. A next explicit task can consume bound prior review findings and exact native failed-task gaps through its original controllerEvidence inside the same 120-second deadline. The diagnostic retains a durable review archive, original request/account/task/target/horizon pins and actual review completion time; missing Caseflow stays an upstream gap rather than a market fact. The same independent host is required for single and batch execution recovery. Conflicting sources, future review, missing completion time or a full 24-item context budget are explicitly not consumed. This readback does not automatically retry a held admission. Input identity and scripted responses do not establish natural semantic acceptance; unavailable, rejected or cancelled review stays unresolved",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-directed-daily-research-brief.ts",
        nodes: ["daily_research_packet"],
        input:
          "Executed research receipt with original case/date identity and reviewed quality gates",
        output: "Frozen source-bound decision packet; planned or needs-review remains unadopted",
        preconditions:
          "The original daily owner publishes the whole-day read/review archive through writeBrief; it delegates immutable per-task candidates to the existing buildFinanceCaseRun/saveFinanceCaseRun before the separate day review. It must preserve that distinction: a saved per-task candidate is not an independently accepted whole-day packet. The original reader independently re-reads pinned case bytes; batch bindings also require each case's actual account/run/task/request to match its parent scope. Request and host are repinned before candidate persistence; cancelled or late runs cannot resume delivery and already-started filesystem cleanup remains unconfirmed. Four readable sections are not semantic adoption or learning application; failed independent review stays held and source/module/quality/universe gaps remain visible",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/tools/finance-learning-capability-apply-tool.ts",
        nodes: ["finance_learning_memory"],
        input:
          "Bounded research question, retained guidance and source-bound historical review diagnostics",
        output:
          "Original guidance scaffold or explicit learning-application refusal with a pinned usage receipt",
        preconditions:
          "The existing risk-task module executor calls this read-only guidance tool. A later explicitly requested task may consume the original archived day-packet review through the existing controllerEvidence seam; the exact source-bound finding reaches the same learning query and its native usage receipt, rather than an additional discarded lookup. A safely reread learning refusal permits diagnostic repair questions only when that refusal is the selected section's sole unresolved boundary; failed source, quality, account, hash, date or target checks still prevent consumption. The original structured refusal reaches the existing committee/model evidence as a separate diagnostic, while the blocked node keeps no successful output IDs and allNodesSucceeded remains false. Historical diagnostics remain questions, never adopted market facts, packet acceptance, weight absorption or execution authority. The original 4 KB diagnostic budget retains explicit omitted-field pointers to the immutable review archive, while the original tool's bounded query names the source evidence and remaining fields. Ordinary planning/reading does not dispatch tools, retry a held admission or create a schedule",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "lcx-directed-daily-research-brief-latest",
      "lcx-finance-research-run-latest",
      "finance_data_gateway_snapshot",
      "review_panel",
      "learning_sedimentation_review",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  module_learning_internalization_waterflow: {
    entrypoint: "scripts/operator/module-learning-pipeline-review.ts",
    stages: [
      {
        owner: "src/agents/tools/finance-learning-pipeline-orchestrator-tool.ts",
        nodes: ["source_intake", "source_registry", "actual_reading_scope"],
        input: "Original source and exact read scope",
        output: "Registered source identity, reliability and reading limits",
        preconditions:
          "Original pipeline intake retains actual normalized source/read fields; the separate static source register remains a global coverage obligation. Untrusted/partial sources remain labelled; a URL alone is not reading proof",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/tools/finance-learning-capability-inspect-tool.ts",
        nodes: ["capability_card"],
        input: "Original card plus current source/module-bound active review receipts",
        output:
          "Retrievable effective card with current review status, receipt hash and applicationAllowed",
        preconditions:
          "Review feedback is consumed through effective card readback, not by silently overwriting the stored card. Downrank/discard, conflicting decisions or unreadable review evidence cannot become application-ready; the original apply owner consumes applicationAllowed",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/tools/finance-learning-capability-apply-tool.ts",
        nodes: ["apply_validation"],
        input: "Original effective cards and a concrete application validation query",
        output: "Source-bound application status and original usage receipt",
        preconditions:
          "Current review-blocked cards are excluded; an answer skeleton is not evaluation absorption",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/tools/finance-learning-pipeline-orchestrator-tool.ts",
        nodes: ["retrieval_receipt"],
        input: "Original retrieved cards and already returned application validation summary",
        output: "Original retrieval receipt retaining the application receipt path and summary",
        preconditions:
          "The original pipeline writes this receipt after application validation; missing application evidence remains visible",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/tools/module-learning-pipeline-plan-tool.ts",
        nodes: ["local_brain_eval_absorption"],
        input: "Capability, retrieval, application and source-specific evaluation references",
        output: "Bounded per-source learning plan receipt with missingEvidence",
        preconditions: "Application readiness never substitutes for per-source absorption proof",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/tools/module-learning-pipeline-review-tool.ts",
        nodes: ["module_learning_review", "keep_downrank_discard"],
        input: "Current plan receipts and original source evidence",
        output: "Keep/downrank/discard review and explicit absence/unreadable states",
        preconditions:
          "An absent directory is not an empty run; prior absorbed status must be rechecked",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-module-learning-absorption-gate.ts",
        nodes: ["module_learning_absorption_gate"],
        input: "Current plan/review receipts and hardened eval chronology",
        output: "Ready/hold decision tied to every in-scope source",
        preconditions:
          "Newer timeout, missing review or global-only clean eval keeps absorption held",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "module_learning_pipeline_plan",
      "module_learning_pipeline_review",
      "learning_sedimentation_bridge",
      "learning_sedimentation_audit",
      "learning_sedimentation_map",
      "module_learning_absorption_gate",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  training_failure_feedback_waterflow: {
    entrypoint: "scripts/operator/local-brain-training-plan.ts",
    stages: [
      {
        owner: "scripts/operator/minimax-quota-brain-saturator.ts",
        nodes: ["teacher_quota"],
        input:
          "Original quota limits and source-pinned failure curriculum selected for this guard caller",
        output:
          "Bounded prompt dispatch and terminal quota receipt; a planned call limit alone is not dispatched work",
        preconditions:
          "Quota limits are computed and enforced by the saturator, not teacher-batch. A failed provider payment response ends this run before adaptive retries or further integrity/training steps, even when the batch contains partial accepted samples. The original terminal receipt preserves provider_payment_required across deadline expiry and the original guard consumes its owner/status/stopReason before any serial teacher fallback. Successful content quoting price 402 is not payment evidence",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/minimax-brain-teacher-batch.ts",
        nodes: ["brain_distillation_review"],
        input: "Original guard child workspace, teacher budget and observation clocks",
        output: "Scoped original teacher review; the training planner only observes receipts",
        preconditions:
          "Stale failures and completed quota cannot authorize fresh paid teacher work",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/local-brain-distill-dataset.ts",
        nodes: ["dataset_builder"],
        input: "Reviewed failures and source/permission bounds",
        output: "Dataset manifest and retained train/eval split provenance",
        preconditions: "A candidate packet is not a trained adapter",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/minimax-brain-training-guard.ts",
        nodes: ["qwen_training"],
        input: "Actual guard/trainer receipts and resource occupancy",
        output:
          "Actual trainer result using the current scoped dataset; compatibility node name does not bind a model",
        preconditions:
          "No overlapping training; injected trainer output proves only offline consumption. The original guard owns command deadlines and terminal failure receipts: settled stdout/stderr and timer callbacks cannot rearm cancellation or restore a failed verdict. Sending SIGTERM does not prove that the child or its descendants closed",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/local-brain-distill-eval.ts",
        nodes: ["hardened_eval"],
        input: "Actual candidate adapter and this run's train-slice manifest, after training",
        output: "Hardened and blind evaluation verdict before promotion",
        preconditions: "Mock/file conversion cannot prove trained weights or an evaluation pass",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/minimax-brain-training-guard.ts",
        nodes: ["promotion_gate"],
        input: "This guard round's candidate hardened evaluation and dataset promotion risk",
        output: "Original guard session promotion or rejection before evolution cooldown",
        preconditions:
          "The guard consumes promotionEvalPassed and the dataset-shrink veto before changing its selected adapter. Independent promotion audit observes this decision later and cannot serve as an earlier gate or cooldown input. Offline worker output cannot establish actual trained weights",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/minimax-brain-training-guard.ts",
        nodes: ["adapter_resolver"],
        input: "Original scoped guard evaluation history and exact adapter lineage",
        output: "Latest passing adapter or explicit absence; no forced promotion",
        preconditions:
          "The resolver must actually read the explicitly supplied guard log alongside deduplicated history; a copied default-directory alias cannot establish that handoff. Newer failing/timeout verdict supersedes an older clean one. Independent local-brain-promotion-audit invokes this original resolver and preserves a bounded failed stdout receipt or an explicit readback gap; that later audit is separate read-only evidence, not a replacement execution gate",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/minimax-brain-training-guard.ts",
        nodes: ["evolution_cooldown"],
        input: "Original guard branch completion or explicit failure/backoff",
        output:
          "Separate cooldown start and completed receipts; completion is written only after the original awaited sleep returns",
        preconditions:
          "The next quota round depends on completed waiting, not semantic use of cooldown text. A start row or timestamps alone cannot prove completion. A completion witness must bind the original caller, round, duration and upstream decision to the next actual invocation. A failed branch cooldown is not an evaluation or promotion receipt",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/minimax-brain-failure-curriculum.ts",
        nodes: ["failure_curriculum"],
        input: "Original latest failed evaluation fields consumed by the saturator",
        output: "Specific next teacher prompts from buildFailureCurriculumPrompts",
        preconditions:
          "Budget and source bounds still apply; stale receipts cannot force paid work",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "minimax-brain-training-guard",
      "local-brain-training-plan",
      "candidate_hardened_eval",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  local_to_external_channel_external_waterflow: {
    entrypoint: "scripts/operator/lcx-external-channel-binding.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-external-channel-binding.ts",
        nodes: ["local_change", "local_tests"],
        input:
          "Explicit local verification receipt and independent host test-result pin, checked against the host source root, HEAD and actual changed-file bytes",
        output:
          "Original verified or blocked local handoff with actual read hashes, executed test result and concrete gaps",
        preconditions:
          "Absent intake remains unobserved; supplied missing, mismatched or failed verification prevents ready. Reported pass alone is insufficient; verified local bytes and tests do not grant apply or prove external delivery",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-external-channel-binding.ts",
        nodes: ["external_channel_binding"],
        input: "trainingPlan.externalChannelBinding from the original training-plan CLI",
        output: "Current non-apply readiness/deferred decision and written binding receipt",
        preconditions:
          "Local readiness and compatibility alone do not authorize or prove external binding; status consumption does not prove real external delivery",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-external-channel-status.ts",
        nodes: ["channel_restart_probe", "real_external_inbound", "user_visible_observed"],
        input: "Actual runtime probe and fresh matching inbound/outbound receipts",
        output: "Separately observed binding and user-visible evidence",
        preconditions:
          "A successful probe cannot replace real user-visible inbound/outbound evidence",
        evidenceMode: "natural_external",
      },
    ],
    receiptSurfaces: ["external-channel-binding", "external-message-channel"],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  skillopt_runtime_self_use_waterflow: {
    entrypoint: "scripts/operator/lcx-skillopt-lite.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-skillopt-lite.ts",
        nodes: [
          "hardened_eval",
          "failure_curriculum",
          "skillopt_candidate_edit",
          "skillopt_best_skill",
        ],
        input: "Current eval failures and supervised skill edits",
        output: "Bounded best-skill candidate and pending-eval receipt",
        preconditions: "Case registration or parse recovery cannot claim behavioral improvement",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/auto-reply/reply/skillopt-autocue.ts",
        nodes: ["skillopt_runtime_preflight", "local_tests"],
        input: "Accepted SOP and current question",
        output: "Deterministic preflight context attached to original reply route",
        preconditions:
          "Context injection is not weight absorption; missing accepted SOP remains explicit",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-external-channel-binding.ts",
        nodes: [
          "external_channel_binding",
          "channel_restart_probe",
          "real_external_inbound",
          "user_visible_observed",
        ],
        input: "Local evidence plus actual external runtime receipts",
        output: "Binding decision and separate user-visible proof",
        preconditions: "No restart or real external run is initiated by an offline audit",
        evidenceMode: "natural_external",
      },
    ],
    receiptSurfaces: [
      "lcx-skillopt-lite",
      "skillopt-autocue",
      "lcx-governance-autopilot-latest",
      "lcx-external-channel-binding",
      "external-message-channel",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  compressed_context_recovery_waterflow: {
    entrypoint: "scripts/operator/lcx-context-recovery-exam.ts",
    stages: [
      {
        owner: "src/agents/central-harness/harness-loop.ts",
        nodes: ["new_codex_window"],
        input: "Calling window question and supplied prior tool results",
        output: "Explicit original recovery request and source-bound follow-up judgment",
        preconditions:
          "Offline scripted windows prove delivery only; natural semantic adoption needs an actual later model receipt",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-context-recovery-exam.ts",
        nodes: ["fixed_evidence_recovery", "operator_latest_state"],
        input:
          "Current AGENTS/runbook/source documents, checkout-scoped operator digest and fresh owner command receipts",
        output: "Recoverable state and explicit stale/missing evidence",
        preconditions:
          "The calling window must bind its own task card; this exam does not select one. --handoff success also requires the original handoff sources to be complete and boundary-clean",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-mind-model.ts",
        nodes: ["mind_model"],
        input:
          "Original architecture documents, source terms and canonical ontology; runs beside the other recovery sources",
        output:
          "Original static architecture/authority audit, consumed by the recovery join; it does not consume change-impact results",
        preconditions:
          "A missing optional model is scoped degradation, not universal startup failure",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/local-brain-training-plan.ts",
        nodes: ["training_plan"],
        input: "Original process/eval facts and module review receipts",
        output: "Current volatile training decisions and explicit missing proofs",
        preconditions:
          "Operator digests cannot replace the fresh training owner; unavailable models grant no training or execution authority",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-flow-graph.ts",
        nodes: ["flow_graph"],
        input: "Canonical workflow declarations and source/receipt evidence",
        output: "Structure and offline/natural proof levels separately",
        preconditions: "Structural checks do not prove 28 runtime traversals",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        nodes: ["change_impact_plan"],
        input: "Exact changed paths and known owner rules",
        output: "Original owner lanes, checks and unmatched-file gaps",
        preconditions: "No unowned path may silently disappear from recovery",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/central-harness/harness-loop.ts",
        nodes: ["central_agent_perception"],
        input:
          "Joined original recovery receipt, archived content and requested precise source fields",
        output: "Actual next input carrying source checks, owner gaps and selected content",
        preconditions:
          "Parallel source audits join at recovery; source delivery is not absorption, execution permission or proof of correct judgment",
        evidenceMode: "fixture_adapter",
      },
    ],
    receiptSurfaces: ["lcx-local-operator-latest", "lcx-context-recovery-exam", "lcx-flow-graph"],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  universe_index_total_coverage_waterflow: {
    entrypoint: "scripts/operator/lcx-universe-index.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-context-recovery-exam.ts",
        nodes: ["fixed_evidence_recovery"],
        input: "Bound original source and task recovery evidence",
        output: "Pinned original recovery receipt consumed by the predecision cleanup review",
        preconditions:
          "Recovery and inventories are independent read-only owners; the final review consumes same-cycle recovery checks. RepoRoot and source hashes are not recovery proof",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-universe-index.ts",
        nodes: ["repo_inventory", "artifact_inventory"],
        input: "Original Git/rg inventory and scoped artifact reads in sibling branches",
        output: "Source-completeness statuses, exact changed files and artifact inventories",
        preconditions:
          "Required Git/rg failures and incomplete artifact reads block; optional missing roots keep missing status; no deletion or protected memory mutation is authorized",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        nodes: ["change_impact_plan"],
        input: "Exact changed files from the original Git inventory through --files",
        output: "Original affected lanes, unmatched files and recommended checks",
        preconditions: "Impact analysis does not read Universe dispositions or authorize cleanup",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-universe-index.ts",
        nodes: ["owner_coverage_map"],
        input:
          "Tracked/visible file union and artifact inventory areas, then original route-owner path validation",
        output: "Source owner coverage including actual missing route owners",
        preconditions:
          "Change-impact is a sibling result; it is not an input to buildRepoGovernanceCoverage",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-universe-index.ts",
        nodes: ["universe_index"],
        input: "Original change-impact, inventories and validated owner coverage joined by main",
        output: "Read-only final index and garbageCandidates inventory",
        preconditions:
          "Candidates are inventory only; presence is not review, capability execution or cleanup approval",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-mind-model.ts",
        nodes: ["mind_model"],
        input: "Original static architecture and ontology sources in an independent owner",
        output: "Architecture view for review; no change-impact-to-mind-model receipt is consumed",
        preconditions: "Sibling owner invocation is not serial evidence consumption",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-flow-graph.ts",
        nodes: ["flow_graph"],
        input: "Canonical scenario contracts and optional original handoff references",
        output: "Separate structure and handoff assessment for review",
        preconditions:
          "The flow owner does not consume a mind-model receipt; structure cannot prove actual handoffs",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        nodes: ["cleanup_candidate_review"],
        input:
          "Required exact Universe candidates and independent architecture, flow and context recovery receipts",
        output:
          "Original pinned-source preserve/unknown review, missing checks and bounded decision handoff",
        preconditions:
          "Source consistency is not truth; reviewed inventory never authorizes deletion or merge. Reference, retention and active writer checks remain required",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
    ],
    receiptSurfaces: [
      "lcx-universe-index-latest",
      "lcx-change-impact-plan",
      "lcx-governance-autopilot-latest",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  local_automation_digest_waterflow: {
    entrypoint: "host-installed:lcx-local-operator-loop.sh",
    stages: [
      {
        owner: "host-installed:lcx-local-operator-loop.sh",
        nodes: ["local_operator_loop", "automation_cleanup"],
        input: "Existing host loop invocation and explicit maintenance guards",
        output: "Sibling owner invocations and cleanup status captured in temporary files",
        preconditions:
          "Source audit never executes the host loop or creates automation; skipped cleanup is not completed cleanup",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-governance-autopilot.ts",
        nodes: ["governance_autopilot"],
        input: "Original governance owner inputs; no cleanup result is passed as an argument",
        output: "Original same-cycle owner batch, failure trace and compact summaries",
        preconditions: "Invocation order does not establish consumption of a sibling receipt",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-local-failure-trace.ts",
        nodes: ["local_failure_trace"],
        input: "Actual governance ownerCommands, summary and snapshot",
        output:
          "Failure trace preserving blocked/failed status, source identity and explicit conflicts",
        preconditions:
          "Blocked child receipts cannot become passed when aggregate summary is absent",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-system-doctor.ts",
        nodes: ["system_doctor"],
        input: "Original health sources, independently invoked by the loop",
        output: "Doctor JSON and stderr captured for the final writer",
        preconditions: "Exit zero cannot erase a failed business result",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/local-brain-training-plan.ts",
        nodes: ["training_plan"],
        input: "Original current resource and training receipts",
        output: "Planning decisions read by the loop writer",
        preconditions: "Plan decisions do not execute training",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-mind-model.ts",
        nodes: ["mind_model"],
        input: "Original architecture sources in an independent invocation",
        output: "Architecture JSON read by the loop writer",
        preconditions: "No training-plan receipt is supplied to this sibling",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-flow-graph.ts",
        nodes: ["flow_graph"],
        input: "Canonical source contracts and optional handoff references",
        output: "Structure and handoff JSON read by the loop writer",
        preconditions:
          "No mind-model receipt is supplied; structural checks cannot prove execution",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-context-recovery-exam.ts",
        nodes: ["fixed_evidence_recovery"],
        input: "Original recovery source inventory in an independent invocation",
        output: "Recovery JSON read by the loop writer",
        preconditions: "A source inventory is not proof of natural adoption",
        evidenceMode: "local_receipt",
      },
      {
        owner: "host-installed:lcx-local-operator-loop.sh",
        nodes: ["operator_training_supervisor"],
        input: "Existing process inventory, guard log age and explicit observe/restart guards",
        output: "Original training supervisor JSON; its ok participates in aggregate success",
        preconditions:
          "Reading the host source grants no launchctl or restart authority; skipped restart is explicitly preserved",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-agent-exam.ts",
        nodes: ["operator_agent_exam"],
        input: "Original cadence and observe-only guard from the host loop",
        output: "Actual exam or explicit skipped JSON read by the final writer",
        preconditions: "Skipped cadence is not an executed exam; this audit never starts the exam",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "host-installed:lcx-local-operator-loop.sh",
        nodes: ["operator_latest_receipt"],
        input:
          "Actual temporary doctor, plan, governance, mind, flow, recovery, supervisor and exam files; cleanup status",
        output: "Original double latest writer and append-only operator log",
        preconditions:
          "Writer reads compact governance summary, not raw trace JSON; failed reads or writes remain visible",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-owner-brief.ts",
        nodes: ["operator_digest"],
        input:
          "Explicit --operator-path reads one original latest receipt; source hash, time and repository pins are checked when supplied",
        output:
          "Original JSON and Markdown digest preserving owner failures, governance blockers and source gaps",
        preconditions:
          "Legacy latest has no canonical run identity; rendering is not business acceptance, and this optional caller does not prove natural invocation",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
    ],
    receiptSurfaces: [
      "lcx-local-operator-loop",
      "lcx-governance-autopilot-latest",
      "lcx-local-failure-trace-latest",
      "lcx-local-failure-trace",
      "lcx-owner-brief-latest",
      "lcx-owner-control-map-latest",
      "lcx-local-operator-latest",
      "LCX Agent Operator Digest",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  central_agent_decision_waterflow: {
    entrypoint: "scripts/operator/lcx-central-agent.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-governance-autopilot.ts",
        nodes: ["governance_autopilot"],
        input: "Settled same-cycle original owners and the original shadow reader observation",
        output:
          "Source-bound handoff excluding central self-output, retaining shadow verdict and gap reason",
        preconditions:
          "Unknown owner status or checkedAt outside this cycle is invalid; oversized/failed handoff must not silently fall back to a paid call",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-central-agent.ts",
        nodes: ["central_agent_perception"],
        input:
          "Original handoff including shadow status/verdict/gap, finance state and bounded receipt history",
        output: "12 KB perception with precise named omissions",
        preconditions:
          "Shadow observation checkedAt must belong to this cycle; fresh describes receipt availability, not trial acceptance; old sources are not refreshed by reinjection; broker unknown remains unknown",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/central-harness/model-brain.ts",
        nodes: ["central_agent_brain_proposal"],
        input: "Delivered facts and concrete uncertainty",
        output: "Bounded proposal and source-bound judgment explanation",
        preconditions:
          "HTTP headers are not completed body; deadline/cleanup and late-result boundaries hold",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/central-harness/harness-loop.ts",
        nodes: ["central_agent_gate", "central_agent_latest_receipt"],
        input: "Proposal, actual tool delivery and original TS gates",
        output: "One original receipt, gate result and next-cycle evidenceUse",
        preconditions:
          "Bad hash/scope/cutoff, metadata-only references and lost judgment feedback cannot claim adoption",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "lcx-central-agent-latest",
      "lcx-central-agent-log-latest.jsonl",
      "test/lcx-central-agent.test.ts",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  external_visible_language_waterflow: {
    entrypoint: "extensions/external/src/monitor.ts",
    stages: [
      {
        owner: "extensions/external/src/monitor.ts",
        nodes: ["ingress_external_message"],
        input: "Validated external envelope and account-scoped original reply context",
        output: "Finalized context passed to the original buffered reply dispatcher",
        preconditions: "Ingress acceptance does not establish reply delivery or answer correctness",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["intent_classifier", "local_brain_planner"],
        input: "Ask supplied to the explicit commercial builder branch",
        output: "Original branch needs and planner contract",
        preconditions:
          "The explicit commercial caller computes orchestration from the original ask, then resolveNeeds consumes that actual orchestration. Original processEvidence pins classification and planner inputs without duplicating their bodies. These are post-candidate checks of the same owner, not proof that a model consumed a prior planning contract or that separate workers ran. Unselected default replies do not invoke this builder",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["language_router"],
        input: "Optional reply-host responseLanguage bound to the original message and ask hash",
        output:
          "Original model prompt instruction, candidate language-route result and diagnostic language",
        preconditions:
          "The explicit commercial branch passes the bound language through the existing extraSystemPrompt seam. The original candidate auditor consumes it and blocks only obvious opposite single-language text, then its terminal summary uses the selected language. Mixed, quoted, code-only or numeric-only text remains unconfirmed; script matching does not establish translation or semantic quality. Unselected replies preserve their existing behavior; a stage label or observed Chinese output alone is not routing proof",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["answer_audit_budget"],
        input: "Actual needs-derived Qwen challenge request in the original work order",
        output: "Original review policy and maximum rounds, consumed by the diagnostic summary",
        preconditions:
          "The policy is computed after resolveNeeds. Its diagnostic consumption is not proof of external model quota or enforcement of future rounds. The original reply caller still enforces its own candidate byte limit and cancellation; no additional model round is created",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["control_room_summary"],
        input:
          "Joined original needs, candidate language check, visible-gate verdict and review policy",
        output: "Original terminal summary and retained review-budget metadata",
        preconditions:
          "The summary is generated after candidate review, not before budgeting or presentation. Only a refusal summary supplies the failed visible body; accepted candidates keep their guarded text. Stage execution is not a semantic-quality verdict",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "src/agents/visible-answer-adoption-gate.ts",
        nodes: ["display_text_normalizer", "readability_review", "visible_answer_adoption_gate"],
        input:
          "Candidate text and the original caller's declared presentation or evidence-review mode",
        output: "Presentation-filtered text or the specific caller's evidence-gate refusal",
        preconditions:
          "These are suboperations of the same original adoption function, not independent semantic review. The ingress edge carries original user context, not a claim that ingress generated the candidate; the actual model/candidate source needs its own receipt. Ordinary replies use presentationOnly; finance/council checks remain in their explicit callers. Stopped ordinary payloads are rejected by agent-runner before presentation. Presentation success alone does not verify market facts, authority or source quality. A replaced body within one call is not proof of the required subsequent readability-to-normalization feedback consumer",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/auto-reply/reply/agent-runner.ts",
        nodes: ["reply_flow_audit"],
        input: "Original commercial gate trace and guarded ReplyPayload in the same reply attempt",
        output: "Original terminal audit event and the guarded payload returned to the dispatcher",
        preconditions:
          "The reply owner consumes the whole diagnostic summary in its commercial_answer_terminal_gate event; success does not send summary text to the user. The accepted candidate or refusal body separately reaches the dispatcher and original sender. Event custody is not independent content review, semantic adoption or user-visible delivery; dispatch counts cannot replace the guarded-body handoff",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "extensions/external/src/monitor.ts",
        nodes: ["visible_reply"],
        input: "Original dispatcher payload passed to monitor deliver",
        output: "Original sendExternalMessage transport result and delivery status",
        preconditions:
          "Receiver substitution proves local sender handoff only; lastOutboundAt is metadata, not user-visible observation",
        evidenceMode: "natural_external",
      },
    ],
    receiptSurfaces: [
      "external-message-handoff-receipt",
      "external-message-envelope",
      "external-message-channel",
      "src/agents/visible-answer-adoption-gate.ts#applyVisibleAnswerAdoptionGate",
      "external-channel-status",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  commercial_answer_pipeline_waterflow: {
    entrypoint: "scripts/operator/lcx-commercial-answer-pipeline.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["ingress_external_message", "intent_classifier", "local_brain_planner"],
        input: "Current ask and concrete uncertainty",
        output: "Question-specific planner contract",
        preconditions: "A generic capability intro does not answer an explicit user contract",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/provider-learning-council.ts",
        nodes: [
          "model_council",
          "provider_evidence",
          "minimax_agent_draft",
          "model_candidate_answer",
        ],
        input: "Scoped provider outputs and actual model metadata",
        output: "Candidates with attempted-provider evidence and disagreement",
        preconditions:
          "Use council roles only for a concrete uncertainty or completed council claim; ordinary supplied arithmetic does not require a council or a market snapshot. An optional original caller deadline requests in-process role cancellation, seals timeout even for late success, and reports local operation settlement separately from unconfirmed or remote cleanup; cancelled role results cannot start further council work or be persisted as a completed council. Requested model names, fallback or fabricated outputs do not prove provider success",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/visible-answer-adoption-gate.ts",
        nodes: ["display_text_normalizer"],
        input: "The original final candidate and bound user message",
        output: "Original presentation-filtered candidate text supplied to the commercial audit",
        preconditions:
          "The original commercial reply gate calls presentationOnly before its audit. This is an existing suboperation, not a new worker or semantic source review. A changed body requires actual raw input, original presentation output and subsequent audit-input readback; presentation does not validate provider evidence or authorize trading",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: [
          "answer_audit_budget",
          "local_contract_audit",
          "review_panel",
          "visible_answer_adoption_gate",
          "control_room_summary",
        ],
        input: "Candidate, source/learning facts and bounded challenge budget",
        output: "Adopt/return_failed_reason with concrete reason",
        preconditions:
          "The original reply gate counts final local audits against the original policy and seals exhaustion for the selected message; held partials do not count, and a new host finance run resets automatic selection. Policy allocation and local audit counts do not prove model rewrites or provider rounds occurred or were bounded. Completed council claims require source- and message-bound original role outputs at the shared visible gate",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/auto-reply/reply/agent-runner.ts",
        nodes: ["reply_flow_audit", "visible_reply"],
        input: "Adopted answer and matching channel context",
        output: "Original reply handoff; external proof remains pending",
        preconditions:
          "The explicit commercial option consumes the original native audit terminal before final or queued delivery; interim payloads are held. In the main reply, a current-run finance reference verified against the original source, quality, account and grounding gates also selects that auditor using the original receipt mode and snapshot. Missing legacy mode remains unobserved; unknown mode, unavailable candidate context or a context over 12 KB is an explicit audit gap. The queued entry consumes the same current-run reference through the shared audit gate and retains the original caller ask. Native terminal summaries explain refusals in the actual reply; they are diagnostic fields of the same owner, not an independent review or new authority. Same-run failures seal later text and media; fallback runs clear old failures and discard late old source reads without poisoning the current run. Completed council checks and cancellation retain their existing boundaries. A native final refusal can queue at most 2 KB of safe historical reason codes and original hashes through the existing session event owner. A later original model prompt must actually read the diagnostic with the same host session, a distinct run and matching audit/body hashes before the feedback is observed; a stored event alone is not consumption. Cancellation, missing host identity and old-run callbacks cannot emit. This is reply-context provenance, never a financial account identity or execution authority. The existing 20-event process queue is ephemeral; local shortcuts, restart, overflow and previously constructed queued prompts do not prove consumption. Audit legality is not semantic success; offline substitutes do not prove external delivery",
        evidenceMode: "natural_external",
      },
    ],
    receiptSurfaces: [
      "commercial_answer_pipeline",
      "external_language_handoff_receipt",
      "external_context_packet",
      "review_panel",
      "provider_council_completion_gate",
      "external-message-channel",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  provider_council_evidence_waterflow: {
    entrypoint: "src/agents/provider-learning-council.ts",
    stages: [
      {
        owner: "src/agents/provider-learning-council.ts",
        nodes: ["model_council", "provider_boundary", "provider_evidence"],
        input: "Declared role/model request and local runtime adapter seam",
        output: "Attempted outputs with actual model/transport metadata",
        preconditions:
          "Unknown transport, empty response or requested-only model identity is not provider success",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["source_registry"],
        input: "Original council artifact bytes and expected hash/message identity",
        output: "Exact artifact intake passed to original attribution verifier",
        preconditions:
          "This reader registers council artifact identity; it does not call a primary-fact source registry or verify factual conflicts",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "src/agents/provider-council-evidence.ts",
        nodes: ["source_conflict_review"],
        input: "Exact artifact bytes, source hash, message scope and actual role/model outputs",
        output: "Confirmed role attribution or explicit identity/hash/completion conflict",
        preconditions:
          "verifyProviderCouncilEvidence resolves attribution conflicts only; valid attribution does not establish source trust, correct facts or semantic adoption. A later original reply may consume bound prior attribution gaps from its existing queued runtime prompt, then freshly reverify the supplied artifact; old refusals never approve a new source or claim. Changed candidates leave historical gaps unresolved rather than implying source repair. Internal second-turn challenge is not returned pipeline review feedback",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["review_panel"],
        input: "Original verifier return consumed by buildPipelineResult",
        output: "Original terminal checks, adoption status and explicit reasons",
        preconditions:
          "Skipped/failed/mismatched roles cannot be declared completed. Acceleration rereading the same artifact does not prove consumption by control-room or an outer fact-conflict worker",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "src/agents/commercial-answer-reply-gate.ts",
        nodes: ["control_room_summary"],
        input: "Original returned terminal review actually consumed by the existing reply gate",
        output: "Original terminal summary retained in the reply audit trace and refusal payload",
        preconditions:
          "A pure pipeline return cannot impersonate control-room adoption. The existing reply gate must consume the returned terminal decision and diagnostic summary after review; a failure uses that summary as its guarded body, while success preserves the accepted answer. This local consumer is not source approval, semantic adoption or an external control-room observation",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
    ],
    receiptSurfaces: [
      "learning-council",
      "model-council-provider-evidence",
      "review_panel",
      "lcx-provider-council-acceleration",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  commercial_acceptance_harness_waterflow: {
    entrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    controlEdges: [
      ["local_operator_loop", "system_doctor"],
      ["local_operator_loop", "training_plan"],
      ["local_operator_loop", "mind_model"],
      ["local_operator_loop", "flow_graph"],
      ["local_operator_loop", "external_channel_binding"],
    ],
    stages: [
      {
        owner: "scripts/operator/lcx-commercial-acceptance-harness.ts",
        nodes: ["local_operator_loop"],
        input: "Original caller options or explicitly supplied same-cycle shared snapshots",
        output: "One collector fanout and joined input set, never an additional scheduler",
        preconditions:
          "Shared/exclusive collection are sibling branches. The loop-to-owner edges are original dispatch/control obligations, not joined snapshot data entering children. Owner-to-harness edges require actual returned snapshots consumed by the builder. Captured failed dispatch proves an attempted call only; importing source, callback failure or a host collection UUID does not prove child execution or child business scope",
        evidenceMode: "fixture_adapter",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-system-doctor.ts",
        nodes: ["system_doctor"],
        input: "Original doctor source and process observations",
        output: "Original doctor snapshot read by the acceptance owner",
        preconditions: "Skipped or failed doctor is not a completed health check",
        evidenceMode: "fixture_adapter",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/local-brain-training-plan.ts",
        nodes: ["training_plan"],
        input: "Original training guards, process state and evidence; independent sibling owner",
        output: "Training-plan snapshot read by the acceptance owner",
        preconditions: "Plan-only is not training; a failed child is not evidence of training idle",
        evidenceMode: "fixture_adapter",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-mind-model.ts",
        nodes: ["mind_model"],
        input: "Original architecture sources; independent sibling owner",
        output: "Mind-model snapshot read by the acceptance owner",
        preconditions: "The owner does not consume the training-plan output as its input",
        evidenceMode: "fixture_adapter",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-flow-graph.ts",
        nodes: ["flow_graph"],
        input: "Original static contracts and handoff observations; independent sibling owner",
        output: "Flow snapshot read by the acceptance owner",
        preconditions: "The owner does not consume the mind-model output as its input",
        evidenceMode: "fixture_adapter",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-external-channel-binding.ts",
        nodes: ["external_channel_binding"],
        input: "Original binding state without apply or restart authority",
        output: "Binding snapshot read by the acceptance owner",
        preconditions:
          "Snapshot collection cannot create a binding, restart or real external canary",
        evidenceMode: "natural_external",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-commercial-acceptance-harness.ts",
        nodes: ["commercial_acceptance_harness", "answer_audit_budget"],
        input: "Joined original shared and exclusive owner snapshots",
        output: "Pure acceptance gates and source/provider/error-budget failures",
        preconditions:
          "Doctor collection timeout or nonzero completion cannot validate a retained council payload; council ok must explicitly be true. A different failed doctor check does not erase an independently completed council check. Same-run role output remains required for council completion",
        evidenceMode: "fixture_adapter",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-external-channel-status.ts",
        nodes: ["channel_restart_probe", "real_external_inbound", "user_visible_observed"],
        input: "Fresh independently produced probe, inbound and visible receipts",
        output:
          "Required runtime-bound and user-visible proof, not events produced by this harness",
        preconditions:
          "Reading a status snapshot does not execute a probe or send a canary; missing original events remain blocked",
        evidenceMode: "natural_external",
        implementationStatus: "required_unobserved",
      },
      {
        owner: "scripts/operator/lcx-commercial-acceptance-harness.ts",
        nodes: ["acceptance_eval"],
        input: "Actual product gates and independent visible proof",
        output: "Release-ready/blocked receipt naming original upstream failures",
        preconditions:
          "Missing macro ownership, provider or visible proof blocks acceptance; result feedback and training changes need separate original consumer evidence",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
    ],
    receiptSurfaces: [
      "commercial_acceptance_harness",
      "commercial_answer_pipeline",
      "lcx-problem-cluster-radar",
      "live-promotion",
      "external-message-channel",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  memory_correction_downrank_waterflow: {
    entrypoint: "scripts/operator/lcx-system-memory-sedimentation-gate.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-system-memory-sedimentation-gate.ts",
        nodes: [
          "memory_recall",
          "system_memory_sedimentation_gate",
          "source_registry",
          "source_conflict_review",
        ],
        input:
          "Current recall files, protected status and optional exact correction/source manifest with host account/run scope",
        output: "Recall readiness and concrete stale/conflict blockers",
        preconditions:
          "Inventory readiness is not correction-source review. Explicit review checks original bytes, account/run, source clock and replacement text; dirty/unknown protected memory or failed supplied review blocks reuse. An omitted review is not evidence that this process ran",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-self-repair-hands.ts",
        nodes: ["memory_write_gate", "correction_note", "stale_memory_downrank"],
        input: "Verified correction plus explicit allowlisted local write authority",
        output: "Correction/downrank candidate and retained original version",
        preconditions:
          "Read-only recall grants no write, protected-memory or module-learning authority",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-system-memory-sedimentation-gate.ts",
        nodes: ["review_panel"],
        input: "Correction candidate and source scope",
        output: "Review feedback without claiming module/weight absorption",
        preconditions:
          "Verified provisional downrank identity never approves reuse or source truth. Original write-before-review and actual search-rank reduction still require separate evidence; system-memory presence is separate from source-specific learning proof",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "system_memory_sedimentation_gate",
      "correction_note",
      "stale_memory_rule_downrank",
      "review_panel",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  self_repair_hands_waterflow: {
    entrypoint: "scripts/operator/lcx-self-repair-hands.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-self-repair-hands.ts",
        nodes: ["memory_recall", "source_conflict_review"],
        input:
          "Original owner signals, correction evidence, explicit write policy and optional completed owner-map diagnostic selected by an independent host run/snapshot",
        output: "Original writer source review and optional registered prior-memory readback",
        preconditions:
          "Protected summaries, provider config and external senders remain forbidden. Explicit pinned owner-map feedback only informs observedFailure; source identity stays separate from the new attempt and does not create a replacement rule or grant action authority. Explicit prewrite recall revalidates a pinned prior candidate, source and registered memory_get artifact through /value/text and a current bounded memory_get read; independent old host account/run stays separate from the current attempt. Complete old content enters the original candidate review as provisional evidence; historical stale source remains comparison-only while the new primary source retains its independent freshness gate. Differing content requires review, not an automatic truth verdict. Missing independent recall host on optional latest readback is not_observed, not a new global veto. Default callers without explicit recall binding remain unobserved; source JSON or postwrite reads do not prove prewrite adoption",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-self-repair-hands.ts",
        nodes: ["self_repair_hands"],
        input:
          "Original SelfRepairInput with issue, observed failure and proposed replacement rule",
        output:
          "Sibling correction, training and patch proposals assembled into the original receipt",
        preconditions:
          "Construction precedes writer source review and grants no write, source truth or reuse permission. The sibling builders consume the same original input; they do not read one another's results",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-self-repair-hands.ts",
        nodes: ["self_repair_memory_cleaner", "self_repair_training_case_builder"],
        input: "The same original scoped input independently passed to each candidate builder",
        output: "Correction body and training/eval candidate held in the constructed receipt",
        preconditions:
          "These are same-owner construction branches, not separate workers or executed writes. Original optional processEvidence records independently recomputed actual branch input hashes and only the paths, source references and eligibility consumed by the gate. It does not claim full-body gate review or source truth",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-self-repair-hands.ts",
        nodes: ["memory_write_gate"],
        input:
          "Constructed sibling proposals, original source review and pinned diagnostic feedback",
        output:
          "Original allowlisted writer verdict followed by candidate writes or a blocked receipt",
        preconditions:
          "Proposals are constructed before source review. Original allowed-root checks and explicit write policy remain required; when source or diagnostic requests are supplied, their original freshness and readback gates must pass. Legacy not-requested checks stay unobserved, not verified. A blocked verdict writes only latest/log receipts and never resumes on a late read",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-self-repair-hands.ts",
        nodes: ["correction_note", "training_eval_candidate_packet"],
        input: "Allowed writer verdict and the respective original candidate body",
        output:
          "Actual correction file and training/eval candidate file, then original latest receipt",
        preconditions:
          "Original bounded processEvidence records writer eligibility and submitted body hashes; independent original file readback is required to establish successful writes. Planned paths or stored proposal bodies do not prove file writes. A written candidate is not applied training or model absorption. Candidate-file and latest writes are sequential in one writer; latest serialization is not independent disk readback. Exact file readback and subsequent review remain separate obligations",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-self-repair-hands.ts",
        nodes: ["stale_memory_downrank"],
        input: "Original correction builder's static provisional_downrank metadata",
        output: "Candidate-only memory tier retained in the original receipt",
        preconditions:
          "This is not an executed ranking change. No independent ranking worker or changed retrieval order is demonstrated; preserve that unresolved result instead of inferring it from a correction note or label",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-self-repair-hands.ts",
        nodes: ["self_repair_latest_receipt"],
        input: "Original writer verdict and retained in-memory candidate metadata",
        output:
          "Append-only original repair receipt with retained prior versions, historical diagnostic feedback and independently re-read current feedback references",
        preconditions:
          "Original publication records the candidate-write eligibility used to choose blocked versus write_completed; this is not a content quality verdict or independent disk readback. Repeated signal keys cannot duplicate work or erase prior review boundaries. Default readback retains historical diagnosis separately from current pinned-source checks; source loss cannot be hidden by a prior completed write, and a failed diagnostic attempt never resumes. Readonly latestWrittenReceipt retains the actual root path and byte SHA already read; this observation pin does not verify source truth, host identity or reuse permission",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/self-repair-candidate-review.ts",
        nodes: ["review_panel"],
        input:
          "Explicit same-write original correction, training candidate, patch candidate and source bodies with host scope and SHA-256 identity",
        output:
          "Original quality-harness content review bound to exact input, with source gaps, review findings and unresolved semantic acceptance",
        preconditions:
          "A review work order is not content consumption. Optional caller does not enable paid calls, memory replacement, training or promotion; source consistency never proves truth. Natural invocation remains unobserved",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-governance-autopilot.ts",
        nodes: ["governance_autopilot"],
        input: "Original repair receipt and owner signal identity",
        output:
          "Original compact receipt with current/latest source gaps, diagnostic readback blockers and candidate boundaries for the existing owner map and bounded Central input",
        preconditions:
          "Offline receipts never authorize unattended writes. A native candidate packet is not evidence of its still-required subsequent review; owner-map feedback must not be inferred from an automatic signal that does not consume the map. Historical source, candidate attempt and governance snapshot remain distinct identities. A read-only cross-run handoff requires the candidate root pin and complete source scope in the same owner compact, plus that owner's observe child receipt bound to the current parent run and snapshot; it does not grant account or execution authority",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-owner-control-map.ts",
        nodes: ["owner_coverage_map"],
        input: "Original same-cycle compact repair and owner command receipt",
        output: "Visible source/read blockers, candidate-only limits and original next repair step",
        preconditions:
          "Current block or failed read takes priority over an earlier completed candidate. Latest-source failures are labelled as the latest write, not a new review. Reverse feedback enters a separately identified next candidate, not an earlier candidate in the same snapshot. Optional diagnostic feedback readback retains the original map/governance run and snapshot, revalidates the original reader and candidate file bodies, and never equates the next candidate with a financial account or prior run. Reverse feedback requires the explicit original self-repair consumer's pinned diagnostic receipt; displaying supervision or a valid hash does not prove that consumer ran or repaired the source",
        evidenceMode: "fixture_adapter",
      },
    ],
    receiptSurfaces: [
      "lcx-self-repair-hands-latest",
      "lcx-self-repair-hands-jsonl",
      "lcx-governance-autopilot-latest",
      "lcx-owner-control-map-latest",
      "self_repair_training_candidate",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  finance_data_gateway_waterflow: {
    entrypoint: "src/agents/tools/finance-data-gateway-tool.ts",
    stages: [
      {
        owner: "src/agents/finance-research-runner.ts",
        nodes: ["finance_research_modules"],
        input: "Concrete module question, instrument and asOf",
        output:
          "Declared batch/realtime request consumed by the existing source runner when liveFetch is requested",
        preconditions:
          "Research cannot invent unavailable measurements; selected source adapters and their deadlines remain explicit",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-realtime-source-registry.ts",
        nodes: [
          "primary_market_data_provider",
          "cross_check_market_data_provider",
          "official_reference_data_provider",
        ],
        input: "Original scoped realtime request and selected source adapters",
        output: "Actually returned observations or failed/timed-out attempts",
        preconditions:
          "Offline adapters prove delivery only; declared provider identities do not prove independent upstream truth",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-data-gateway.ts",
        nodes: [
          "finance_data_gateway",
          "normalized_data_snapshot",
          "data_provenance_quality_review",
        ],
        input: "Caller-supplied timestamped fields, units and declared provider roles",
        output:
          "Validated supplied observations and normalized snapshot with missing, conflict and freshness status; not a source collection receipt",
        preconditions:
          "Post-cutoff/future/stale or conflicted fields are excluded or held; declared roles do not prove upstream independence or semantic truth",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-answer-composer.ts",
        nodes: ["causal_map"],
        input: "Normalized facts and quality gaps supplied to the standalone composer",
        output: "Candidate text and grounding report; this utility does not produce a causal map",
        preconditions:
          "The causal_map node has no demonstrated gateway-to-causal-producer caller here; fixture composition cannot close that handoff or prove source truth",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["review_panel"],
        input: "Actual composed candidate and the same source snapshot",
        output:
          "Original terminal adoption/refusal, consumed input fingerprints and concrete failures",
        preconditions:
          "Grounding is blocking only when the caller enables the existing requireGrounding option; an input hash alone is not adoption. Feedback requires the actual terminal result to inform a new or corrected source request",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/central-harness/harness-loop.ts",
        nodes: ["control_room_summary"],
        input:
          "Original terminal result, source conflict and unresolved gaps in the next perception",
        output:
          "Source-specific followup or retained/unresolved judgment in the original tool loop",
        preconditions:
          "Repeated unchanged observations cannot resolve a conflict; offline scripted delivery is separate from natural model adoption",
        evidenceMode: "fixture_adapter",
      },
    ],
    receiptSurfaces: [
      "finance-data-gateway",
      "data_provenance_quality_review",
      "control_room_summary",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  senior_trader_failure_focus_waterflow: {
    entrypoint: "scripts/operator/local-brain-distill-eval.ts",
    stages: [
      {
        owner: "src/agents/module-learning-source-register.ts",
        nodes: ["source_intake", "source_registry"],
        input: "Original source and actual reading bounds",
        output: "Source-scoped registration and learning references",
        preconditions: "Untrusted or missing reading scope stays visible",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-data-gateway.ts",
        nodes: ["finance_data_gateway", "data_provenance_quality_review"],
        input: "Dated field evidence and disagreement",
        output: "Quality/provenance status carried into the capability",
        preconditions: "Current numeric claims require timestamp, unit and source",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/tools/module-learning-pipeline-plan-tool.ts",
        nodes: [
          "capability_card",
          "retrieval_receipt",
          "apply_validation",
          "local_brain_eval_absorption",
        ],
        input: "Per-source retrieval/application/eval artifacts",
        output: "Ready/held learning receipt with evidence references",
        preconditions: "Global eval cannot manufacture adjacent-task or per-source absorption",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/minimax-brain-failure-curriculum.ts",
        nodes: ["failure_curriculum"],
        input: "Original latest failure attempts and exact source case",
        output: "Source-bound failed-case curriculum",
        preconditions: "Newer pass, timeout or invalid attempt cannot resurrect an old failure",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/minimax-quota-brain-saturator.ts",
        nodes: ["teacher_quota"],
        input: "Original quota usage, window limit, reserve and reset timing",
        output: "Planned teacher call limit; planning alone does not dispatch a teacher",
        preconditions:
          "Quota limits are computed and enforced by the saturator, not teacher-batch. A failed provider payment response ends this run before adaptive retries or further integrity/training steps, even when the batch contains partial accepted samples. The original terminal receipt preserves provider_payment_required across deadline expiry and the original guard consumes its owner/status/stopReason before any serial teacher fallback. Successful content quoting price 402 is not payment evidence",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/minimax-brain-teacher-batch.ts",
        nodes: ["brain_distillation_review"],
        input: "Original failed-case curriculum and teacher quota",
        output: "Teacher review with original source fields and explicit gaps",
        preconditions: "Provider work waits natural runs; missing source blocks the review",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/local-brain-distill-dataset.ts",
        nodes: ["dataset_builder"],
        input: "Actual reviewed teacher rows",
        output: "Original dataset manifest",
        preconditions: "Missing or conflicting review is not a usable training row",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/minimax-brain-training-guard.ts",
        nodes: ["qwen_training"],
        input: "Original dataset and resource gates",
        output: "Actual training status and adapter identity",
        preconditions: "Offline fixtures do not prove weights trained",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/local-brain-distill-eval.ts",
        nodes: ["hardened_eval"],
        input: "Actual candidate adapter and frozen evaluation inputs",
        output: "Original hardened evaluation status",
        preconditions: "Missing evaluation or newer timeout blocks promotion",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/minimax-brain-training-guard.ts",
        nodes: ["promotion_gate"],
        input: "Candidate hardened eval and current guard thresholds",
        output: "In-session guard promotion or hold",
        preconditions: "This is the guard session decision; review cannot bypass it",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/minimax-brain-training-guard.ts",
        nodes: ["evolution_cooldown"],
        input: "Settled round status after the healthy evaluation/promotion branch",
        output: "Original resource cooldown and round tail",
        preconditions:
          "Failed/skip branches may cool down early; cooldown is not an evaluation prerequisite",
        evidenceMode: "natural_model",
      },
      {
        owner: "scripts/operator/lcx-commercial-answer-pipeline.ts",
        nodes: ["review_panel", "control_room_summary"],
        input:
          "Required actual quality/application/promotion gaps; current guard-to-review caller remains unobserved",
        output: "Original candidate audit with explicit failed reasons",
        preconditions:
          "Answer review cannot certify model promotion or replace the original promotion gate",
        evidenceMode: "fixture_adapter",
        implementationStatus: "required_unobserved",
      },
    ],
    receiptSurfaces: [
      "local-brain-distill-eval",
      "minimax-brain-training-guard",
      "finance-data-gateway",
      "review_panel",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  similar_engineering_consolidation_waterflow: {
    entrypoint: "scripts/operator/lcx-change-impact-plan.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        nodes: ["local_change", "change_impact_plan"],
        input: "Explicit changed paths or the original bounded Git worktree read",
        output:
          "Affected lanes and reusable checks, plus observed/unavailable changedFilesReadback and original stray gate carried into governance and Central input",
        preconditions:
          "Git failure, foreign or empty worktree root and timeout are unknown, never clean. Explicit paths retain their caller-declared scope; static PATH_RULES are owner inventory, not a prior-work search or completed tests",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        nodes: ["prior_work_search"],
        input:
          "Original Git changed implementation paths, HEAD baseline and current worktree bytes",
        output:
          "Pinned old/current source and diff provenance, bounded production focus and explicit unresolved comparison",
        preconditions:
          "The original main reads actual HEAD and safe current source bytes, computes full diff hashes, hunk locations and public symbol changes, and repins the source, diff and HEAD before reporting observed. Git collection and reads share a 20-second maximum, with each child capped at the original 10 seconds. Ordinary explicit-path inventory remains not_observed for this stage. Test and fixture paths do not occupy the 16-implementation focus; exact omitted changedFiles indices and byte-budget gaps remain partial, not a new global veto. Source/HEAD conflicts, unsafe aliases, unreadable selected sources and deadline failure remain unknown and block the original plan. Raw code literals are not emitted. Existing governance compact forwards the actual diagnostic through strayGate, bounded to 4 KB with original-receipt pointers and whole-field omissions; a terminal blocker precedes earlier partial gaps and the original payload is preserved. Same-path preservation or matching hashes do not prove semantic equivalence, cross-mechanism consolidation or natural model adoption. Confirmed deletion remains pending original cleanup review, never deletion authority",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        nodes: ["similar_mechanism_merge"],
        input:
          "Pinned original source, registered owner and same-input before/after behavior reports",
        output:
          "Selected preserve/merge_candidate/unknown comparison, bounded checks and explicit unproven coverage",
        preconditions:
          "Explicit --inspect-prior-work reads the selected original HEAD/current/diff instead of treating path inventory as comparison. The original owner accepts a pinned same-input before/after behavior report comparison through --mechanism-review, verifies source hashes, original ownership and selected numeric/boolean expectations, and returns preserve, merge_candidate or unknown. A mismatch keeps the requested comparison blocked and reaches the existing stray gate and governance projection. This checks selected report contents, not their execution provenance or whole semantic equivalence; neither matching paths/hashes nor one matched case authorizes source migration",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        nodes: ["single_owner_contract", "parallel_path_reject"],
        input:
          "Actually read source path and existing canonical family, owner and sharing declarations",
        output:
          "Pinned canonical owner sources and explicit preserve/unresolved disposition; declared ownership conflicts block the original plan",
        preconditions:
          "The original main matches exact allowed paths and preserves explicitly approved shared owners. A missing canonical declaration or body budget remains unresolved; source conflicts and unapproved cross-family sharing block. Keyword similarity does not establish duplication. Existing governance compact forwards the actual result to Central with bounded original-receipt pointers. This consumer proves local declared ownership only; missing mechanism comparison, downstream review and natural adoption remain separate gaps",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-mind-model.ts",
        nodes: ["mind_model"],
        input: "Selected source/owner contract",
        output: "Architecture view tied to source",
        preconditions: "Historical intent cannot override present file ownership",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-flow-graph.ts",
        nodes: ["flow_graph"],
        input: "Selected workflow contracts",
        output: "Structural/proof gaps by original owner",
        preconditions: "A source diagram pass never substitutes for a runtime consumer test",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-system-doctor.ts",
        nodes: ["system_doctor"],
        input: "Owned check results and unresolved gaps",
        output: "Visible failure and exact next repair/check",
        preconditions: "Exit zero with missing business proof stays incomplete",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: ["lcx-change-impact-plan", "mind-model-consistency", "flow_graph_exam"],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  external_agent_skill_distillation_waterflow: {
    entrypoint: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
        nodes: ["external_upgrade_radar", "blacktech_mechanism_map"],
        input: "Static candidate and method registration plus existing governance diagnostics",
        output: "Planning-only owner mapping and missing receipt requirements",
        preconditions:
          "Static registration never proves source reading, owner wiring, license clearance, distillation or acceptance",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
        nodes: ["external_agent_source", "source_registry", "license_scope_review"],
        input:
          "Explicit host-scoped local manifest and pinned source/license bodies for a registered candidate",
        output:
          "Actual source bytes, independent registry readback and original License checkpoint blocked/failed receipt",
        preconditions:
          "Default radar remains static; explicit intake reads within the workspace and stops at missing permission. Reading a license or caller-declared version cannot grant trust, installation, security signoff, provider access or distillation authority",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
        nodes: ["actual_reading_scope"],
        input: "License-cleared source and permission scope from the original intake checkpoint",
        output: "Permitted reading scope delivered to the original downstream pattern intake",
        preconditions:
          "Unknown permission stops the native attempt before this downstream node; a read-only source receipt is not permission clearance",
        evidenceMode: "local_receipt",
        implementationStatus: "required_not_implemented",
      },
      {
        owner: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
        nodes: [
          "workflow_distillation",
          "local_skill_candidate",
          "trajectory_or_trace_receipt",
          "security_permission_review",
        ],
        input: "Isolated pattern and scoped replay/permission evidence",
        output: "Reviewable local candidate with trace and concrete proof gaps",
        preconditions: "Copying provider routing or claiming weights learned is forbidden",
        evidenceMode: "local_receipt",
        implementationStatus: "required_not_implemented",
      },
      {
        owner: "src/agents/tools/module-learning-pipeline-review-tool.ts",
        nodes: ["review_panel"],
        input:
          "Explicit pinned local plan, source, license, candidate and application bodies plus independent review-attempt scope",
        output:
          "Original Quality Harness content findings and fresh source-bound review readback; failed or needs_review only",
        preconditions:
          "Optional explicit review does not run by default; a valid reference or model opinion cannot grant license, installation, security signoff or application acceptance. Upstream account/run remains unobserved when absent from the original plan",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-module-learning-absorption-gate.ts",
        nodes: ["acceptance_eval"],
        input: "Original active plan and independently re-read review/evaluation proof",
        output:
          "Proof-completeness hold naming the application acceptance gap and original next owner",
        preconditions:
          "A content diagnosis is not permission or actual skill evaluation; static radar registration does not prove this independent consumer was called in the same native run",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
    ],
    receiptSurfaces: [
      "lcx-external-agent-upgrade-radar",
      "skill_pattern_distillation",
      "agent_workflow_memory",
      "local-brain-distill-eval",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  multi_agent_pattern_shadow_evaluation_waterflow: {
    entrypoint: "scripts/operator/lcx-multi-agent-pattern-shadow.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-multi-agent-pattern-shadow.ts",
        nodes: ["multi_agent_pattern_intake", "shadow_replay"],
        input: "Same versioned case, topology, model policy and cost basis",
        output:
          "Original builtin replay and fingerprinted admission for the declared isolated case",
        preconditions:
          "Replay proves mechanics only; different inputs or invented costs cannot be compared",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-multi-agent-pattern-shadow.ts",
        nodes: ["shadow_isolated_executor", "interruption_recovery_probe"],
        input:
          "Passed original replay preflight and declared executor with cancellation/idempotency contract",
        output: "Isolated run/recovery receipts showing no lost work or duplicate final output",
        preconditions:
          "Legacy mode=live names this isolated phase, not another operation or natural model proof; cached completion must match original case/phase/topology/executor; missing executor, escaped side effect or timeout cleanup remains explicit",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-multi-agent-pattern-shadow.ts",
        nodes: ["pattern_comparison", "review_panel", "acceptance_eval"],
        input:
          "Actual same-scope run and recovery receipts, their comparison and original decision gates",
        output: "Trial/hold recommendation with coverage-specific gaps",
        preconditions:
          "Review consumes the original comparison; retained comparison fields must agree with original runs. Normal-run replay proof must cite matching actual recovery; builtin fixtures cannot fill executor evidence; absent cost basis stays unverified; copied pass cannot bypass original sample/quality/recovery gates or authorize production",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "multi-agent-pattern-intake",
      "lcx-multi-agent-pattern-shadow",
      "lcx-multi-agent-pattern-shadow.jsonl",
      "review_panel",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  logical_agent_pool_waterflow: {
    entrypoint: "scripts/operator/lcx-logical-agent-pool.ts",
    stages: [
      {
        owner: "src/agents/logical-agent-pool.ts",
        nodes: ["logical_agent_pool_intake"],
        input: "Immutable plan, shared fact packet and declared task/role capabilities",
        output: "Plan fingerprint, dependencies and terminal sink",
        preconditions: "Unknown roles/cycles/undeclared side effects fail before execution",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/logical-agent-pool.ts",
        nodes: ["logical_agent_pool_schedule", "logical_agent_task_executor"],
        input: "Validated dependencies, one shared model slot and deadlines",
        output: "Bounded execution with actual dependency results handed to consumers",
        preconditions:
          "Failed parent blocks descendants; unknown cancelled execution quarantines its slot",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/logical-agent-pool.ts",
        nodes: ["logical_agent_pool_terminal"],
        input: "Actual task receipts and sink lineage",
        output: "One completed/failed/cancelled terminal result and durable checkpoint",
        preconditions:
          "Late completion, missing sink or changed facts cannot reuse a stale checkpoint",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "logical-agent-pool",
      "lcx-logical-agent-pool",
      "src/agents/logical-agent-pool.test.ts",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  prediction_market_research_only_waterflow: {
    entrypoint: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
        nodes: [
          "prediction_market_source",
          "source_registry",
          "actual_reading_scope",
          "resolution_criteria_review",
        ],
        input:
          "Explicit pinned market-source body and caller-declared version with independent host account/run",
        output:
          "Actual source bytes, independent registry re-read, full selected reading scope and resolution evidence gaps or unresolved semantic review",
        preconditions:
          "readPredictionMarketResearchIntake keeps safe reads and optional original Quality review in one deadline capped at 120 seconds. Missing clauses, resolution source or dates block a directional conclusion and name exact missing fields. Complete fields do not verify source trust or semantics; actual review findings remain tied to the original body and hash. A source description with gaps is allowed without forcing strategy, fees or backtests; sourceSummaryAllowed never approves quality or direction. Default CLI installs no model adapter and starts no downstream domain or execution work; cancellation/late results stay terminal and read/model cleanup remains unconfirmed",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "src/agents/finance-data-gateway.ts",
        nodes: ["finance_data_gateway", "data_provenance_quality_review"],
        input: "Price/probability fields with observation times and units",
        output:
          "Generic original gateway can normalize snapshots; prediction source caller remains unconnected",
        preconditions:
          "Probability prices are not verified outcomes; stale/conflicting data stays held",
        evidenceMode: "local_receipt",
        implementationStatus: "required_unobserved",
      },
      {
        owner: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
        nodes: ["market_microstructure_review"],
        input:
          "Optional marketMicrostructure fields from the exact pinned binary USD payoff-one source body",
        output:
          "Declared all-in cost, break-even probability and capacity/quote-age/cost gaps delivered to the original optional Quality review",
        preconditions:
          "No fee defaults or execution authority; source trust, sample-out strategy performance and actual fills remain unproven. An ordinary source description does not require this optional cost packet",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
        nodes: ["strategy_experiment_audit"],
        input: "Declared sample-out experiment with outcome and cost evidence",
        output: "Actual experiment result and correction feedback remain missing",
        preconditions: "Quote arithmetic cannot replace a strategy experiment or its outcomes",
        evidenceMode: "local_receipt",
        implementationStatus: "required_not_implemented",
      },
      {
        owner: "scripts/operator/lcx-external-agent-upgrade-radar.ts",
        nodes: ["review_panel", "control_room_summary"],
        input:
          "Same pinned source and internal cost review, plus the original optional resolution Quality result",
        output:
          "Original intake result includes calculated costs and exact gaps/corrections; optional Quality request consumes the cost result",
        preconditions:
          "No adapter is installed by default; local or substituted review cannot prove natural model adoption or strategy performance. No wallet, order, copy-trading or provider-config authority is granted",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
    ],
    receiptSurfaces: [
      "lcx-external-agent-upgrade-radar",
      "finance-data-gateway",
      "source_registry",
      "data_provenance_quality",
      "strategy_experiment_audit",
      "review_panel",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  finance_intraday_paper_waterflow: {
    entrypoint: "scripts/operator/lcx-finance-intraday-paper.ts",
    stages: [
      {
        owner: "src/agents/finance-intraday-ledger.ts",
        nodes: ["intraday_point_in_time_ledger"],
        input: "Source-bound closed bars, cutoff and frozen rule version",
        output: "Validated point-in-time bar sequence",
        preconditions: "Incomplete/post-cutoff/point-derived bars are not valid OHLC observations",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-intraday-paper.ts",
        nodes: ["frozen_intraday_signal", "same_cost_retail_baseline"],
        input: "Closed history, frozen signal and identical cost assumptions",
        output: "Next-bar fills, strategy and same-cost baseline",
        preconditions:
          "No same-bar fill/lookahead; a missing interval cannot become next-bar entry or hide stop/target touches; calendar-excluded sessions remain explicit in the receipt",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-intraday-paper.ts",
        nodes: ["paper_replay_receipt"],
        input: "Actual simulated trades and benchmark/cost results",
        output: "Paper-only return, risk and full-body fingerprinted validation receipt",
        preconditions: "Replay is not a broker fill or an alpha/promotion claim",
        evidenceMode: "local_receipt",
      },
      {
        owner: "scripts/operator/lcx-finance-trade-economics-eval.ts",
        nodes: ["intraday_result_score"],
        input: "Original replay file and caller-declared frozen estimator/cost policy",
        output: "Source-receipt-bound walk-forward economics and cost scenarios",
        preconditions:
          "The full original replay fingerprint must match before selected trades are scored; integrity is not source trust or holdout proof; score-to-rule feedback remains unobserved until an original consumer retains its use",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "finance-intraday-ledger",
      "finance-intraday-paper-receipt",
      "same-cost-retail-baseline",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  finance_live_execution_waterflow: {
    entrypoint: "scripts/operator/lcx-finance-live-execution.ts",
    stages: [
      {
        owner: "src/agents/finance-execution-adapter.ts",
        nodes: ["execution_intent", "explicit_run_authorization", "declared_execution_adapter"],
        input: "Exact account/venue/instrument/size intent and controller/risk authority",
        output: "Approved or refused intent bound to the declared adapter",
        preconditions:
          "Copied labels, research authorization or incomplete ceilings cannot authorize an order",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-execution-safety.ts",
        nodes: ["order_placement", "execution_receipt"],
        input: "Approved intent, fresh native facts and deterministic dedup/safety claims",
        output: "Typed submitted/filled/refused/unknown outcome under a synthetic venue seam",
        preconditions:
          "Broker unknown/recovery incomplete remains blocked; no retry or live fallback",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-position-ledger.ts",
        nodes: ["position_ledger"],
        input: "Typed broker proof and source-bound marks",
        output: "Append-only canonical position/receipt readback",
        preconditions:
          "Submitted orders are not fills; missing marks/fees or another account cannot invent PnL",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "finance-decision-policy",
      "finance-caseflow",
      "finance-outcome-ledger",
      "finance-position-ledger",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  finance_automatic_paper_trading_waterflow: {
    entrypoint: "scripts/operator/lcx-finance-scheduler.ts",
    stages: [
      {
        owner: "scripts/operator/lcx-finance-scheduler.ts",
        nodes: ["schedule_gate", "finance_scheduler"],
        input: "Original schedule, sole owner claim and explicit Paper policy",
        output: "Exactly one admitted cycle with durable attempt/success status",
        preconditions:
          "Configured day research is invoked directly by runDayResearchPreflight; the scheduler pins its native parent/account/asOf and both controller input files in an immutable handoff receipt. The original CLI verifies and reuses those bytes before source/model work, retains their provenance in every research return, and the scheduler requires the same provenance before accepting a candidate or no-allocation result. Provenance equality does not establish market truth, Quality approval or broker authority; candidate/asOf/source/committee/quality/module gates and exact written plan path must pass before execution. Planning-only central output is not accepted. Configured night review consumes its own position/broker/rule sources after accepted settlement or a complete same-run night_sample_source_gate receipt; the latter remains a failed calibration source and a failed whole night cycle. Timeout, malformed receipts, mismatched scope and other failures do not open this branch. Zero new scored outcomes skip tuning; forecast sample availability does not establish portfolio-review source or quality. The legacy path without researchPlan is separate; no actual schedule is created",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-central-agent.ts",
        nodes: ["central_agent_perception"],
        input:
          "Original rule ledger, readiness, scheduler/cycle snapshots and forecast-calibration proposals",
        output: "Read-only automatic lifecycle feedback for independent central supervision",
        preconditions:
          "buildPerception reads buildFinanceAutomaticLifecycleFeedback; this feedback is not a required scheduler caller. Central planning/model unavailability cannot by itself invalidate an otherwise accepted research plan; central has no execution authority",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-research-runner.ts",
        nodes: [
          "finance_research_modules",
          "finance_data_gateway",
          "review_panel",
          "portfolio_candidate",
        ],
        input:
          "Original research CLI input: frozen account/portfolio scope, active rule bodies and source-bound module evidence",
        output:
          "Original candidate receipt, module results, committee/quality gates and optional bounded portfolio plan",
        preconditions:
          "lcx-finance-research-run reads readFinanceActiveStrategyResearchScope from the same finance state root and activeStrategyIds/asOf; rule content determines targets/history scope and enters controllerEvidence. The same original ledger read retains stored and cutoff-projected heads separately, selected rule identities and a canonical body fingerprint. The existing CLI records which account selected those global rules and pins the actual evidence text in controllerRuleUse; the runner checks that packet before source/model work and retains it even on refusal. This provenance is not global rule ownership, source credibility or model adoption. The original qualityRequest.sharedContext.financeModuleExecution passes the module snapshot directly to runQualityHarness; this parameter handoff is separate from the gateway source path, which remains required and unobserved when this attempt only collected data. Quality refusal cannot discharge an unobserved upstream gateway or the independent night branch. Monthly bar summaries are bounded projections. The original module consumer rehydrates daily closes from the same financeStateDir/asOf, verifies instrument, headRef, window, counts and monthly observations, and passes the actual levels to the registered quant tool. Missing or conflicting data propagate as explicit module and prerequisite failures, never as zero risk. The original scheduler's next research preflight may forward independently pinned, age- and account-scoped prior Quality diagnostics through the existing controller file. Its 2 KB projection prioritizes concrete findings over exact native pass summaries, retains original feedback pointers and explicit omissions, and preserves coded failure evidence. These historical diagnostics are not current market facts, an extra retry or proof that a model adopted them. Forwarded files and child arguments alone do not establish consumption. When claiming this feedback was consumed, the original CLI must read the same-attempt evidence and frozen account context, and the original runner input and actual configured-model prompt must retain the source hash and concrete failure. A needs_review return or not_run portfolio prerequisite is an observed refusal, not successful Quality, an adopted plan or trading; the actual written receipt must be independently read back against its producer pin. When portfolioContext is supplied, the original runner checks broker-summary accountScope and any declared account/position snapshot identities against that account and canonical venue before source or model execution. Unknown current account facts remain research gaps, not execution approval; legacy night aggregates without portfolioContext retain their scope. Legal identity alone does not establish source trust or semantic adoption",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-finance-research-run.ts",
        nodes: ["portfolio_plan"],
        input: "Original runner receipt.portfolioPlan and requested portfolio-plan-out path",
        output: "Verified written plan path in the original scheduler summary",
        preconditions:
          "writeVerifiedPortfolioPlan reports the hash of the successfully written original bytes. The scheduler requires that producer pin, current account/asOf and exact path before passing it with its parent attempt to the original daily reader. The reader hashes and parses one read, checks scope before account/provider work and reuses the parsed plan. Parent identity and byte equality are handoff evidence, not execution approval; planned receipts, stale asOf, failed/missing gates or mismatched/inline/mixed plans do not authorize execution",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-execution-adapter.ts",
        nodes: ["execution_intent", "explicit_run_authorization", "declared_execution_adapter"],
        input: "Accepted plan, Paper-only authority and canonical fresh account facts",
        output: "Original placeFinanceOrder intent/authorization/adapter checks or typed refusal",
        preconditions:
          "The original daily CLI binds active monthly target-weight rules and frozen lookbackMonths before generating intent. Research or central proposal authority cannot authorize orders; unknown broker claim remains blocked",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-execution-safety.ts",
        nodes: ["order_placement", "execution_receipt"],
        input:
          "Original approved intent, fresh account facts and deterministic safety/dedup checks",
        output: "Typed submitted/filled/refused/unknown outcome from the declared adapter",
        preconditions:
          "placeFinanceOrder calls withFinanceExecutionSafety around adapter.execute; broker unknown or unconfirmed recovery blocks execution, with no retry/live fallback or forced broker refresh",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-position-ledger.ts",
        nodes: ["position_ledger"],
        input: "Original daily recordCycleFill execution receipt and source-bound position marks",
        output: "Append-only canonical receipt and position readback",
        preconditions:
          "appendFinanceExecutionReceipt/appendFinancePositionMark retain account and receipt identity; submitted orders are not fills and missing fee/mark evidence cannot invent PnL",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-research-batch.ts",
        nodes: ["research_run"],
        input:
          "Explicitly requested original CLI/tool sampling, one resolved finance book, bounded instruments and timestamped directional forecast evidence",
        output: "Original research-samples.jsonl records consumed by night backfill",
        preconditions:
          "runResearchBatch and its original batch CLI/Pi tool already produce samples; the configured day research CLI and daily execution do not call this writer. Rule and bar inputs must use the same declared book as sampling; overriding recordPath alone does not bind those readers. Batch conviction comes from signal fusion, while portfolio budgetFraction/targetWeight is not a prediction probability and cannot create a forecast sample. Legacy forecasts have no account/run binding or explicit horizon; backfill keeps its original 30-day default. This is directional calibration evidence, not a scheduler call or same-account net-trade outcome feedback; sampling remains on demand rather than a mandatory full-pool workflow",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "scripts/operator/lcx-finance-daily-cycle.ts",
        nodes: ["night_settlement", "outcome_ledger"],
        input:
          "Existing research-samples.jsonl directional forecasts and due dated price observations",
        output: "Original backfillOutcomes result and appendScoredOutcomes directional ledger",
        preconditions:
          "Trade fills/marks are not directional forecast samples or net PnL. Missing, unreadable or invalid-JSON samples return night_sample_source_gate with unknown sample count, not a clean empty stream. Prices beyond the settlement cutoff are excluded and reported, leaving unsettled calls pending. No new scored outcomes do not prove a proposal ran; the separate configured night research branch consumes position/broker/rule evidence",
        evidenceMode: "fixture_adapter",
      },
      {
        owner: "src/agents/finance-tuning-lifecycle.ts",
        nodes: ["tuning_proposal", "deterministic_promotion_gate"],
        input: "Original scored directional outcomes and prior calibration floor",
        output:
          "Forecast-calibration proposal result; fresh rows persisted when present, empty promotions and paperExecutionPromotion blocked",
        preconditions:
          "Only new scored outcomes dispatch tuning. When runFinanceTuningLifecycle runs it returns directional_forecast_outcomes_are_not_net_trade_pnl; no automatic rule declaration or activation follows. Net-trade execution promotion is not implemented. This actual refusal is not a source/quality failure or a successful learning loop",
        evidenceMode: "local_receipt",
      },
      {
        owner: "src/agents/finance-strategy-rule-ledger.ts",
        nodes: ["strategy_rule_ledger"],
        input: "Original explicitly declared/activated rule transitions and dated ledger reads",
        output:
          "Canonical active rules consumed by research, daily strategy binding and independent supervision",
        preconditions:
          "declareFinanceStrategyRule/activateFinanceStrategyRule are separate original CLI transitions; night calibration proposals never call them. The absent net-trade promotion-to-rule transition remains a named implementation gap, not an observed handoff",
        evidenceMode: "local_receipt",
      },
    ],
    receiptSurfaces: [
      "lcx-finance-research-run-latest",
      "finance-portfolio-plan",
      "daily-cycle-runs",
      "finance-position-ledger",
      "research-scored",
      "tuning-proposals",
      "finance-strategy-rule-ledger",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
  automation_repair_lock_waterflow: {
    entrypoint: "scripts/operator/lcx-automation-repair-lock.ts",
    stages: [
      {
        owner: "scripts/operator/local-brain-training-plan.ts",
        nodes: ["training_plan"],
        input: "Original training readiness and workload evidence",
        output: "Training plan with overlapping workload and readiness gaps",
        preconditions:
          "This read-only planner emits a selected repair decision and its bounded context in the original acquire command. Generating a command does not acquire a lease or prove natural execution; the original CLI must consume that exact declared input",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-automation-repair-lock.ts",
        nodes: ["schedule_gate", "repair_lock"],
        input:
          "Optional selected training repair context, requested worktree Git state, existing lease and exact repair token",
        output: "One local repair lock or explicit dirty/occupied/unavailable refusal",
        preconditions:
          "The compatibility node schedule_gate describes the original plan-eligibility, worktree and lease-time checks, not an implemented automation due/scheduling caller. An explicit confirmed lane is required before acquisition; unknown lane cannot create a releasable lease. Unreadable Git/lease evidence is never clean/free; allow-dirty does not waive unknown state. The original Git child has a 10-second deadline. A declared plan must match its schema and exact worktree: eligible input and hash remain planningInput; valid but ineligible input and hash remain rejectedPlanningInput with not_eligible, never lease authority. Invalid or foreign-worktree input is not echoed as validated context. This proves input consumption, not training health, source trust or repair execution. Natural invocation and lease-to-check consumers remain unobserved",
        evidenceMode: "local_receipt",
        implementationStatus: "existing_source",
      },
      {
        owner: "scripts/operator/lcx-change-impact-plan.ts",
        nodes: ["local_change", "local_tests"],
        input:
          "Exact changed paths for the original read-only impact mapping; actual patch/check execution also requires an authorized repair actor and the acquired lease",
        output:
          "Read-only owner/check recommendations only; actual local change and executed test receipts are still required",
        preconditions:
          "This source owns impact mapping, not patch application or test execution. The external Codex/manual actor is declared by ops/automation/repair-lock-protocol.md, but no original callable lease-to-patch/check consumer was found. Their repository execution implementation remains required_not_implemented. Declared plans or observer-assembled receipts cannot replace actual authorized execution; the existing external Codex/manual actor may satisfy these obligations with native lease, patch/check, doctor and release receipts without a new automation runner. Preserve changed-path, result and same-attempt evidence. Lock ownership grants no external writes, cleanup or unrelated mutation",
        evidenceMode: "local_receipt",
        implementationStatus: "required_not_implemented",
      },
      {
        owner: "scripts/operator/lcx-system-doctor.ts",
        nodes: ["system_doctor", "operator_latest_receipt"],
        input: "Actual local verification and original owner receipts",
        output:
          "Original doctor findings; same-attempt repair outcome and operator publication still require actual consumer evidence",
        preconditions:
          "The existing host operator writer can publish doctor findings, but sibling doctor/planner snapshots do not prove this serial repair chain or doctor-to-next-planner feedback. Same-attempt repair publication and token release remain unobserved. Local tests do not prove restart, deployment or natural adoption. A timed-out doctor child stays failed even if late output claims success; bounded TERM/KILL and native close observation cannot confirm other resources. cleanup_unconfirmed remains explicit",
        evidenceMode: "local_receipt",
        implementationStatus: "required_unobserved",
      },
    ],
    receiptSurfaces: [
      "lcx-automation-repair-lock",
      "local-brain-training-plan",
      "lcx-local-operator-latest",
    ],
    boundary: "descriptive_process_contract_no_execution_authority",
  },
} as const satisfies Record<LcxOntologyWorkflowScenarioId, LcxWorkflowProcessContract>;
