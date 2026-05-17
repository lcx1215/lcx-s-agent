import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

type CliOptions = {
  json: boolean;
  live: boolean;
  l5: boolean;
  timeoutMs: number;
};

type JsonRecord = Record<string, unknown>;

type CommandResult =
  | {
      ok: true;
      name: string;
      durationMs: number;
      json?: JsonRecord;
      stdoutTail: string;
    }
  | {
      ok: false;
      name: string;
      durationMs: number;
      error: string;
      stdoutTail: string;
      stderrTail: string;
    };

type ExamLane = {
  lane: string;
  status: "pass" | "warn" | "fail" | "not_run";
  severity: "info" | "P3" | "P2" | "P1" | "P0";
  boundary: string;
  evidence: string[];
  issue: string;
  nextAction: string;
};

type CommercialBlueprintItem = {
  id: string;
  order: number;
  title: string;
  ownerLane: string;
  status: "ready" | "blocked" | "needs_live" | "needs_receipts" | "not_run";
  evidence: string[];
  nextAction: string;
};

type ExamReport = {
  ok: boolean;
  boundary: "dev_exam_only" | "dev_exam_with_live_probe";
  checkedAt: string;
  liveTouched: boolean;
  providerConfigTouched: false;
  protectedMemoryTouched: false;
  trainingStarted: false;
  heavyEvalStarted: false;
  lanes: ExamLane[];
  commercialBlueprint: CommercialBlueprintItem[];
  commands: Record<string, CommandResult>;
  summary: {
    pass: number;
    warn: number;
    fail: number;
    notRun: number;
    nextBlocker: string;
  };
};

type CognitiveIntegritySources = {
  doctrine: string;
  localBrainEval: string;
  localBrainEvalTests: string;
  systemPrompt: string;
  moduleLearningReviewTool: string;
  larkSurfaces: string;
  localBrainRunbook: string;
  answerAuditSurfaces: string;
  controlRoomSurfaces: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_CWD = path.resolve(SCRIPT_DIR, "..", "..");

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-agent-exam.ts [--json] [--live] [--l5]",
      "",
      "Read-only judge exam for LCX Agent dev/local lanes.",
      "Default does not touch live, does not start training, and does not run heavy MLX eval.",
      "",
      "Options:",
      "  --json          print JSON",
      "  --live          run Lark/channel probe commands; still does not claim live-visible-fixed",
      "  --l5            run scripts/l5-regression-batterer.sh --local",
      "  --timeout-ms N  per-command timeout, default 120000",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    usage();
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    live: false,
    l5: false,
    timeoutMs: 120_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--l5") {
      options.l5 = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(readValue(args, index));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function commandFailedLane(lane: string, command: CommandResult): ExamLane {
  return {
    lane,
    status: "fail",
    severity: "P1",
    boundary: "dev_observability_only",
    evidence: [`command=${command.name}`, `error=${command.ok ? "none" : command.error}`],
    issue: "这条线路的证据命令自己失败了，不能继续凭感觉判断。",
    nextAction: `先修 ${command.name}，再重新跑 lcx-agent-exam。`,
  };
}

function buildSystemDoctorLane(doctorCommand: CommandResult): ExamLane {
  if (!doctorCommand.ok) {
    return commandFailedLane("system_doctor", doctorCommand);
  }
  const doctor = doctorCommand.json ?? {};
  const summary = asRecord(doctor.summary);
  const failed = numberValue(summary.failed) ?? 0;
  const passed = numberValue(summary.passed) ?? 0;
  const skipped = numberValue(summary.skipped) ?? 0;
  return {
    lane: "system_doctor",
    status: doctor.ok === true && failed === 0 ? "pass" : "fail",
    severity: doctor.ok === true && failed === 0 ? "info" : "P1",
    boundary: stringValue(doctor.boundary, "dev_observability_only"),
    evidence: [
      `ok=${String(doctor.ok)}`,
      `passed=${passed}`,
      `failed=${failed}`,
      `skipped=${skipped}`,
      `liveTouched=${String(doctor.liveTouched === true)}`,
    ],
    issue:
      doctor.ok === true && failed === 0
        ? "基础 doctor 没发现当前 dev 观测面失败。"
        : "基础 doctor 有失败项，其他线路结论必须降级。",
    nextAction:
      doctor.ok === true && failed === 0
        ? "继续看训练、promotion、Lark、模块学习这些细分线路。"
        : "优先修 doctor 失败项，不要宣称系统整体健康。",
  };
}

function buildTrainingLane(planCommand: CommandResult): ExamLane {
  if (!planCommand.ok) {
    return commandFailedLane("training_guard", planCommand);
  }
  const plan = planCommand.json ?? {};
  const activeProcesses = asArray(plan.activeProcesses);
  const latestEval = asRecord(plan.latestEval);
  const latestDataset = asRecord(plan.latestDataset);
  const latestDatasetCounts = asRecord(latestDataset.counts);
  const datasetExamples =
    numberValue(latestDataset.examples) ?? numberValue(latestDatasetCounts.examples) ?? 0;
  const decisions = asArray(plan.decisions);
  const topDecision = asRecord(decisions[0]);
  const latestTeacher = asRecord(plan.latestTeacher);
  const teacherFailures = numberValue(latestTeacher.failures) ?? 0;
  const status = activeProcesses.length > 0 ? (teacherFailures > 0 ? "warn" : "pass") : "warn";
  return {
    lane: "training_guard",
    status,
    severity: status === "pass" ? "info" : "P2",
    boundary: "dev_local_training_only",
    evidence: [
      `activeProcesses=${activeProcesses.length}`,
      `nextDecision=${stringValue(topDecision.id, "unknown")}`,
      `latestEval=${stringValue(latestEval.name)} ${numberValue(latestEval.passed) ?? 0}/${numberValue(latestEval.total) ?? 0}`,
      `datasetExamples=${datasetExamples}`,
      `teacherFailures=${teacherFailures}`,
    ],
    issue:
      activeProcesses.length === 0
        ? "没有看到训练守护进程；如果目标是持续训练，这不是正常状态。"
        : teacherFailures > 0
          ? "训练在跑，但最新 teacher 日志还有失败；这可能是旧日志，也可能是新 failure family。"
          : "训练守护有活动进程，最新 teacher 失败数为 0。",
    nextAction:
      activeProcesses.length === 0
        ? "先按 training-plan 给出的命令恢复唯一一组守护，启动前继续检查 PID，避免重叠训练。"
        : teacherFailures > 0
          ? "等下一轮 MiniMax batch 或手动跑小批 no-live teacher proof，确认 parser 修复后不再出现同类失败。"
          : "保持当前训练，不要启动第二组重叠 MLX/teacher 任务。",
  };
}

function buildPromotionLane(auditCommand: CommandResult): ExamLane {
  if (!auditCommand.ok) {
    return commandFailedLane("qwen_adapter_promotion", auditCommand);
  }
  const audit = auditCommand.json ?? {};
  const latestEval = asRecord(audit.latestEval);
  const selectedEval = asRecord(audit.selectedEval);
  const decision = stringValue(audit.promotionDecision, "unknown");
  const bugs = asArray(audit.realBugsFound);
  const status =
    decision === "safe"
      ? "pass"
      : decision === "hold" || decision === "ambiguous"
        ? "warn"
        : "fail";
  return {
    lane: "qwen_adapter_promotion",
    status,
    severity: status === "pass" ? "info" : status === "warn" ? "P2" : "P1",
    boundary: stringValue(audit.boundary, "dev_local_brain_promotion_audit_only"),
    evidence: [
      `promotionDecision=${decision}`,
      `latestEval=${stringValue(latestEval.name)} ${numberValue(latestEval.passed) ?? 0}/${numberValue(latestEval.total) ?? 0}`,
      `selectedEval=${stringValue(selectedEval.name)} ${numberValue(selectedEval.passed) ?? 0}/${numberValue(selectedEval.total) ?? 0}`,
      `selectedPromotionReady=${String(selectedEval.promotionReady === true)}`,
      `resolverMatchesLatestEval=${String(audit.resolverMatchesLatestEval === true)}`,
      `resolverMatchesLatestPassingEval=${String(audit.resolverMatchesLatestPassingEval === true)}`,
      `realBugsFound=${bugs.join(",") || "none"}`,
    ],
    issue:
      decision === "safe"
        ? "当前 dev 证据支持选择 latest-passing adapter；这不是 live 证明，也不是强行 promotion。"
        : decision === "hold"
          ? "当前训练种子可用于续训，但最新 hardened eval 没放行 strict promotion；这是正确暂停，不是 resolver 崩坏。"
          : "当前 adapter 选择不能安全升级，原因在 realBugsFound 里。",
    nextAction:
      decision === "safe"
        ? "继续保留 promotion audit，后续只在同等 hardened eval 通过时升级。"
        : decision === "hold"
          ? "继续 failure-focus teacher 和 Qwen 训练，等同等 hardened eval 通过后再 promotion。"
          : "先修 resolver/eval/module boundary 的具体 blocker，不要手动提升 adapter。",
  };
}

function buildModuleLearningLane(moduleCommand: CommandResult): ExamLane {
  if (!moduleCommand.ok) {
    return commandFailedLane("module_learning_internalization", moduleCommand);
  }
  const review = moduleCommand.json ?? {};
  const counts = asRecord(review.counts);
  const receiptFiles = numberValue(counts.receiptFiles) ?? 0;
  const weak = numberValue(counts.weakModuleLearning) ?? 0;
  const invalid = numberValue(counts.invalidReceipts) ?? 0;
  const boundaryViolations = numberValue(counts.boundaryViolations) ?? 0;
  const applicationReady = numberValue(counts.applicationReady) ?? 0;
  const evalAbsorbed = numberValue(counts.evalAbsorbed) ?? 0;
  const status =
    boundaryViolations > 0 || invalid > 0
      ? "fail"
      : weak > 0 || receiptFiles === 0 || evalAbsorbed === 0
        ? "warn"
        : "pass";
  return {
    lane: "module_learning_internalization",
    status,
    severity: status === "pass" ? "info" : status === "warn" && weak > 0 ? "P2" : "P3",
    boundary: stringValue(review.boundary, "module_learning_pipeline_review_only"),
    evidence: [
      `receiptFiles=${receiptFiles}`,
      `weakModuleLearning=${weak}`,
      `applicationReady=${applicationReady}`,
      `evalAbsorbed=${evalAbsorbed}`,
      `invalidReceipts=${invalid}`,
      `boundaryViolations=${boundaryViolations}`,
      `updated=${String(review.updated === true)}`,
    ],
    issue:
      status === "pass"
        ? "当前 module-learning review 有 eval_absorbed 收据，且没有发现弱内化或边界违规。"
        : receiptFiles === 0
          ? "今天没有模块学习 review 输入收据；不能说所有模块都已经吸收新知识。"
          : evalAbsorbed === 0
            ? "当前 review 只有非 eval_absorbed 证据，不能把 stored_only/retrieval_ready/application_ready 升级成模块学会。"
            : "模块学习还有弱收据、坏收据或边界违规，不能升级成 eval_absorbed。",
    nextAction:
      status === "pass"
        ? "保留 no-write review 作为每日检查，继续要求 fresh adjacent application。"
        : weak > 0
          ? "补 per-receipt eval/training、fresh adjacent application、keep/downrank/discard 证据，再允许 eval_absorbed。"
          : evalAbsorbed === 0 && receiptFiles > 0
            ? "补 per-receipt eval/training absorption 和 keep/downrank/discard，再从 application_ready 升级。"
            : "补真实 module_learning_pipeline_plan/application/eval 证据，再写 review receipt。",
  };
}

function buildLearningSedimentationInventoryLane(
  auditCommand: CommandResult | undefined,
): ExamLane {
  if (!auditCommand) {
    return {
      lane: "learning_sedimentation_inventory",
      status: "not_run",
      severity: "P3",
      boundary: "dev_learning_sedimentation_audit_not_run",
      evidence: ["lcx-learning-sedimentation-audit not run"],
      issue: "没有读取全局学习沉淀库存，不能区分历史 eval_absorbed 和今天新增 review。",
      nextAction: "跑 lcx-learning-sedimentation-audit，把历史模块吸收库存和当天 review 分开看。",
    };
  }
  if (!auditCommand.ok) {
    return commandFailedLane("learning_sedimentation_inventory", auditCommand);
  }
  const audit = auditCommand.json ?? {};
  const chains = asRecord(audit.chains);
  const modulePipeline = asRecord(chains.moduleLearningPipeline);
  const evalAbsorbed = numberValue(modulePipeline.evalAbsorbed) ?? 0;
  const planReceipts = numberValue(modulePipeline.planReceipts) ?? 0;
  const weak = numberValue(modulePipeline.weakModuleLearning) ?? 0;
  const boundaryViolations = numberValue(modulePipeline.boundaryViolations) ?? 0;
  const status = boundaryViolations > 0 ? "fail" : evalAbsorbed > 0 && weak === 0 ? "pass" : "warn";
  return {
    lane: "learning_sedimentation_inventory",
    status,
    severity: status === "pass" ? "info" : status === "warn" ? "P2" : "P1",
    boundary: stringValue(audit.boundary, "dev_learning_sedimentation_audit_only"),
    evidence: [
      `assessment=${stringValue(audit.assessment, "unknown")}`,
      `planReceipts=${planReceipts}`,
      `evalAbsorbed=${evalAbsorbed}`,
      `weakModuleLearning=${weak}`,
      `boundaryViolations=${boundaryViolations}`,
    ],
    issue:
      status === "pass"
        ? "全局学习沉淀库存里已有模块级 eval_absorbed 证据；这和今天新增 review 输入是两件事。"
        : "全局学习沉淀库存还不能证明模块吸收，或存在弱内化/边界问题。",
    nextAction:
      status === "pass"
        ? "继续让当天 review 只报告新增输入，不要把历史 eval_absorbed 和今天新增混说。"
        : "先修 learning-sedimentation-audit 指出的 gaps，再谈模块吸收。",
  };
}

function hasAll(source: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.every((pattern) =>
    typeof pattern === "string" ? source.includes(pattern) : pattern.test(source),
  );
}

function buildThinkingHierarchyLane(sources?: CognitiveIntegritySources): ExamLane {
  if (!sources) {
    return {
      lane: "thinking_hierarchy_integrity",
      status: "not_run",
      severity: "P2",
      boundary: "static_contract_sources_missing",
      evidence: ["sourceAudit=false"],
      issue: "没有读取思考层契约源码，不能判断复杂题是否会绕过简单前置题。",
      nextAction: "重新跑 lcx-agent-exam，让它读取本地源码契约。",
    };
  }
  const doctrineOk = hasAll(sources.doctrine, [
    "Capability must be monotonic",
    "simple prerequisite eval",
  ]);
  const evalOk = hasAll(sources.localBrainEval, [
    "EVAL_CASE_PREREQUISITES",
    "expandEvalCasesWithPrerequisites",
    "autoIncludedPrerequisiteCaseIds",
    "registeredPrerequisiteRuleCount",
  ]);
  const regressionOk = hasAll(sources.localBrainEvalTests, [
    "runs simple prerequisite cases before complex commodity evals",
    "gates all-domain finance learning behind simple prerequisite evals",
    "requires abstraction-transfer evals to include adjacent prerequisites",
  ]);
  const status = doctrineOk && evalOk && regressionOk ? "pass" : "fail";
  return {
    lane: "thinking_hierarchy_integrity",
    status,
    severity: status === "pass" ? "info" : "P1",
    boundary: "dev_static_cognitive_contract",
    evidence: [
      `doctrineMonotonic=${String(doctrineOk)}`,
      `evalPrerequisiteExpansion=${String(evalOk)}`,
      `regressionProof=${String(regressionOk)}`,
    ],
    issue:
      status === "pass"
        ? "复杂金融/学习/抽象题有简单前置题门禁和回归证据，不能只靠大题分数冒充能力。"
        : "复杂题前置门禁缺失，可能出现大题会说、小题不会做的假聪明。",
    nextAction:
      status === "pass"
        ? "以后新增复杂 eval 时继续强制加 simple prerequisite。"
        : "补 prerequisite 映射和相邻简单题回归，再允许 promotion。",
  };
}

function buildWorkStatusBoundaryLane(sources?: CognitiveIntegritySources): ExamLane {
  if (!sources) {
    return {
      lane: "work_status_boundary_integrity",
      status: "not_run",
      severity: "P2",
      boundary: "static_contract_sources_missing",
      evidence: ["sourceAudit=false"],
      issue: "没有读取工作状态契约源码，不能判断 dev/live/started/completed 是否会混说。",
      nextAction: "重新跑 lcx-agent-exam，让它读取 Lark/status 契约。",
    };
  }
  const larkOk = hasAll(sources.larkSurfaces, [
    "dev-fixed means local implementation or tests only",
    "live-visible-fixed means migrated, built, restarted, probed, and verified through the real Lark/Feishu path",
    "started, running, completed, blocked, or unproven",
  ]);
  const runbookOk = hasAll(sources.localBrainRunbook, [
    "live-visible-fixed",
    "fresh real Lark inbound plus visible reply",
    "Do not call local training or synthetic replay `live-visible-fixed`",
  ]);
  const status = larkOk && runbookOk ? "pass" : "fail";
  return {
    lane: "work_status_boundary_integrity",
    status,
    severity: status === "pass" ? "info" : "P1",
    boundary: "dev_static_workflow_contract",
    evidence: [`larkSurfaceBoundary=${String(larkOk)}`, `runbookBoundary=${String(runbookOk)}`],
    issue:
      status === "pass"
        ? "工作状态有明确边界：dev、probe、live-visible、started/completed 不能混成一个成功词。"
        : "工作状态边界缺失，智能体可能把本地修好、探针通过、真实用户可见混说。",
    nextAction:
      status === "pass"
        ? "继续用真实证据层级汇报，不从聊天记忆直接报成功。"
        : "补 Lark/status/readback 契约和回归，禁止 fake live-fixed。",
  };
}

function buildMemorySedimentationLane(sources?: CognitiveIntegritySources): ExamLane {
  if (!sources) {
    return {
      lane: "memory_sedimentation_integrity",
      status: "not_run",
      severity: "P2",
      boundary: "static_contract_sources_missing",
      evidence: ["sourceAudit=false"],
      issue: "没有读取记忆沉淀契约源码，不能判断未证实学习是否会被写成已学会。",
      nextAction: "重新跑 lcx-agent-exam，让它读取记忆/学习工具契约。",
    };
  }
  const promptOk = hasAll(sources.systemPrompt, [
    "do not describe a run as learned/internalized when the status is not application_ready",
    "retrievalFirstLearning.failedReason",
    "weakLearningIntents.failedReason",
    "usageReceiptPath",
  ]);
  const moduleReviewOk = hasAll(sources.moduleLearningReviewTool, [
    "weakModuleLearning",
    "boundaryViolation",
    "languageCorpusUntouched",
    "protectedMemoryUntouched",
    "providerConfigTouched: false",
  ]);
  const runbookOk = hasAll(sources.localBrainRunbook, [
    "A stored source, summary, or dataset row is not enough",
    "stored_only",
    "application_ready",
    "eval_absorbed",
    "Do not claim Qwen model-internal learning without retained artifacts and eval evidence",
  ]);
  const status = promptOk && moduleReviewOk && runbookOk ? "pass" : "fail";
  return {
    lane: "memory_sedimentation_integrity",
    status,
    severity: status === "pass" ? "info" : "P1",
    boundary: "dev_static_memory_contract",
    evidence: [
      `systemPromptLearningGate=${String(promptOk)}`,
      `moduleReviewBoundary=${String(moduleReviewOk)}`,
      `runbookAbsorptionLabels=${String(runbookOk)}`,
    ],
    issue:
      status === "pass"
        ? "记忆沉淀有分层：存了、可检索、可应用、eval 吸收不能混说，也不能碰 protected memory/live/provider。"
        : "记忆沉淀契约缺失，可能把存储、摘要、检索误写成模型已经学会。",
    nextAction:
      status === "pass"
        ? "继续要求 receipt、failedReason、fresh adjacent application 和 eval/training 证据。"
        : "补 source->receipt->apply->eval_absorbed 的 fail-closed 契约。",
  };
}

function buildAnswerAuditPipelineLane(sources?: CognitiveIntegritySources): ExamLane {
  if (!sources) {
    return {
      lane: "commercial_answer_audit_pipeline",
      status: "not_run",
      severity: "P2",
      boundary: "static_contract_sources_missing",
      evidence: ["sourceAudit=false"],
      issue: "没有读取 Lark 回答审计契约源码，不能判断商用回答流水线是否闭环。",
      nextAction: "重新跑 lcx-agent-exam，让它读取 answer audit 和 reply-flow surfaces。",
    };
  }
  const sourceOk = hasAll(sources.answerAuditSurfaces, [
    "buildLarkAnswerAuditPolicy",
    "dev_commercial_answer_pipeline_only",
    "model_candidate_not_final_authority",
    "candidate_answer_not_final_authority",
    "challenger_only_not_final_authority",
    "answer_audit",
    "terminalDecision",
    "return_failed_reason",
    "local_memory_recall",
    "learning_sedimentation_review",
    "stored_only_is_not_learning",
    "retrieval_apply_eval_review_required",
  ]);
  const runbookOk = hasAll(sources.localBrainRunbook, [
    "bounded feedback",
    "answer audit",
    "model answer",
    "Qwen is challenger",
    "terminal decision",
  ]);
  const status = sourceOk && runbookOk ? "pass" : "fail";
  return {
    lane: "commercial_answer_audit_pipeline",
    status,
    severity: status === "pass" ? "info" : "P1",
    boundary: "dev_static_lark_answer_audit_contract",
    evidence: [`answerAuditSource=${String(sourceOk)}`, `runbookPolicy=${String(runbookOk)}`],
    issue:
      status === "pass"
        ? "商用回答流水线有边界：模型先给候选，本地/Qwen 做有限审计，最后要么采纳可见回复，要么给失败理由。"
        : "回答审计契约缺口会让系统在大模型和本地回路之间无限反复，或者把候选答案直接当最终答案。",
    nextAction:
      status === "pass"
        ? "后续 live 验收要看 answer_audit stage 和真实可见回复，不只看本地源码。"
        : "补 answer audit policy、reply-flow stage、runbook 终止条件和回归。",
  };
}

function buildControlRoomProductLane(sources?: CognitiveIntegritySources): ExamLane {
  if (!sources) {
    return {
      lane: "product_control_room",
      status: "not_run",
      severity: "P2",
      boundary: "static_contract_sources_missing",
      evidence: ["sourceAudit=false"],
      issue: "没有读取 control-room 产品入口契约，不能判断是否成了多入口屎山。",
      nextAction: "重新跑 lcx-agent-exam，让它读取 README、AGENTS、capabilities 和 runbook。",
    };
  }
  const productOk = hasAll(sources.controlRoomSurfaces, [
    "one main control room",
    "control_room_main_lane",
    "specialist detail only on demand",
  ]);
  const convergenceOk = hasAll(sources.localBrainRunbook, [
    "Commercial-grade convergence does not mean deleting useful entrypoints",
    "Converge duplicated authority instead",
    "single factual owner",
  ]);
  const status = productOk && convergenceOk ? "pass" : "fail";
  return {
    lane: "product_control_room",
    status,
    severity: status === "pass" ? "info" : "P1",
    boundary: "dev_static_product_entrypoint_contract",
    evidence: [
      `controlRoomContract=${String(productOk)}`,
      `entrypointConvergence=${String(convergenceOk)}`,
    ],
    issue:
      status === "pass"
        ? "产品入口原则是一个主 control room，加必要专门入口；重复权威要合并，不是删除所有入口。"
        : "control room 和多入口收敛契约不完整，后续容易平行造入口。",
    nextAction:
      status === "pass"
        ? "新增入口前继续用 flow graph 的 consolidated entrypoint families 做 owner 检查。"
        : "补 README/AGENTS/runbook/capabilities 的产品入口和单一事实 owner 契约。",
  };
}

function buildLarkLane(larkCommand: CommandResult | undefined, live: boolean): ExamLane {
  if (!live) {
    return {
      lane: "lark_feishu_visible_loop",
      status: "not_run",
      severity: "info",
      boundary: "not_live_touched",
      evidence: ["--live not supplied", "dev exam did not probe Lark/channel"],
      issue: "默认考试没有触碰真实 Lark/Feishu，所以不能得出 live-visible-fixed。",
      nextAction: "需要 live 证明时再跑 --live，并要求真实入站和可见回复证据。",
    };
  }
  if (!larkCommand) {
    return commandFailedLane("lark_feishu_visible_loop", {
      ok: false,
      name: "lark-loop-diagnose",
      durationMs: 0,
      error: "missing command result",
      stdoutTail: "",
      stderrTail: "",
    });
  }
  if (!larkCommand.ok) {
    return commandFailedLane("lark_feishu_visible_loop", larkCommand);
  }
  const diagnosis = larkCommand.json ?? {};
  const languageCandidates = asRecord(diagnosis.languageCandidates);
  const currentReplay = asRecord(languageCandidates.currentReplay);
  const candidateCount =
    numberValue(currentReplay.candidateCount) ??
    numberValue(languageCandidates.candidateCount) ??
    0;
  const rejectedCount = numberValue(currentReplay.rejectedCount) ?? 0;
  return {
    lane: "lark_feishu_visible_loop",
    status: diagnosis.ok === true ? "warn" : "fail",
    severity: diagnosis.ok === true ? "P3" : "P1",
    boundary: "live_probe_or_channel_diagnose_only",
    evidence: [
      `ok=${String(diagnosis.ok)}`,
      `candidateCount=${candidateCount}`,
      `rejectedCount=${rejectedCount}`,
      "live-visible-fixed=false unless fresh inbound plus matching reply is present",
    ],
    issue:
      diagnosis.ok === true
        ? "Lark/Feishu 诊断可用，但这仍只是诊断或 probe，不等于真实可见回复闭环。"
        : "Lark/Feishu 诊断失败，不能说入口正常。",
    nextAction: "用验收短语做真实入站+回复检查，命中后才能标 live-visible-fixed。",
  };
}

function buildL5Lane(l5Command: CommandResult | undefined, l5: boolean): ExamLane {
  if (!l5) {
    return {
      lane: "l5_regression_battery",
      status: "not_run",
      severity: "info",
      boundary: "not_run_by_default",
      evidence: ["--l5 not supplied"],
      issue: "默认考试不跑完整 L5 battery，避免每次巡检都变成长测试。",
      nextAction:
        "需要大考时运行 lcx-agent-exam --l5 或 scripts/l5-regression-batterer.sh --local。",
    };
  }
  if (!l5Command) {
    return commandFailedLane("l5_regression_battery", {
      ok: false,
      name: "l5-regression-batterer",
      durationMs: 0,
      error: "missing command result",
      stdoutTail: "",
      stderrTail: "",
    });
  }
  return {
    lane: "l5_regression_battery",
    status: l5Command.ok ? "pass" : "fail",
    severity: l5Command.ok ? "info" : "P1",
    boundary: "local_regression_only",
    evidence: [`ok=${String(l5Command.ok)}`, `stdoutTail=${l5Command.stdoutTail.slice(-160)}`],
    issue: l5Command.ok ? "L5 本地回归脚本退出 0。" : "L5 本地回归脚本失败。",
    nextAction: l5Command.ok ? "保留为大考门禁。" : "按失败 family 修，不要逐句补丁。",
  };
}

function buildLiveBoundaryLane(live: boolean, channelCommand: CommandResult | undefined): ExamLane {
  if (!live) {
    return {
      lane: "live_visible_boundary",
      status: "pass",
      severity: "info",
      boundary: "dev_fixed_not_live_fixed",
      evidence: ["liveTouched=false", "providerConfigTouched=false", "trainingStarted=false"],
      issue: "本次 exam 明确没有把 dev 证据升级成 live-visible-fixed。",
      nextAction: "只有 migration/build/restart/probe/真实 Lark 入站回复全有，才改 live 状态。",
    };
  }
  if (!channelCommand) {
    return commandFailedLane("live_visible_boundary", {
      ok: false,
      name: "channels-status-probe",
      durationMs: 0,
      error: "missing command result",
      stdoutTail: "",
      stderrTail: "",
    });
  }
  if (!channelCommand.ok) {
    return commandFailedLane("live_visible_boundary", channelCommand);
  }
  const channel = channelCommand.json ?? {};
  return {
    lane: "live_visible_boundary",
    status: "warn",
    severity: "P2",
    boundary: "probe_fixed_not_live_visible_fixed",
    evidence: [
      `channelProbeOk=${String(channel.ok)}`,
      "freshInboundPlusVisibleReply=not_proven_by_this_command",
    ],
    issue: "channel probe 不是真实用户可见回复证据。",
    nextAction:
      "继续用 acceptance phrase 查真实入站和 outbound_result，缺一个都不能叫 live-visible-fixed。",
  };
}

function buildAutomationLane(planCommand: CommandResult, doctorCommand: CommandResult): ExamLane {
  if (!planCommand.ok || !doctorCommand.ok) {
    return {
      lane: "automation_coordination",
      status: "warn",
      severity: "P2",
      boundary: "dev_automation_evidence_incomplete",
      evidence: [
        `trainingPlanOk=${String(planCommand.ok)}`,
        `doctorOk=${String(doctorCommand.ok)}`,
      ],
      issue: "自动化配合要靠 doctor 和 training-plan 两边证据；现在至少一边缺失。",
      nextAction: "先修失败的观测命令，再判断自动化。",
    };
  }
  const plan = planCommand.json ?? {};
  const doctor = doctorCommand.json ?? {};
  const decisions = asArray(plan.decisions);
  const activeProcesses = asArray(plan.activeProcesses);
  const failed = numberValue(asRecord(doctor.summary).failed) ?? 0;
  return {
    lane: "automation_coordination",
    status: activeProcesses.length > 0 && decisions.length > 0 && failed === 0 ? "pass" : "warn",
    severity: activeProcesses.length > 0 && decisions.length > 0 && failed === 0 ? "info" : "P2",
    boundary: "dev_automation_coordination_only",
    evidence: [
      `activeProcesses=${activeProcesses.length}`,
      `trainingDecisions=${decisions.length}`,
      `doctorFailed=${failed}`,
    ],
    issue:
      activeProcesses.length > 0 && decisions.length > 0 && failed === 0
        ? "自动化有统一 training-plan 决策面，doctor 当前无失败。"
        : "自动化证据不完整，可能是没跑、没收据或 doctor 有失败。",
    nextAction: "保持自动化走 training-plan，不要绕过 repair lock 或另起重叠训练。",
  };
}

function laneById(lanes: ExamLane[], laneId: string): ExamLane | undefined {
  return lanes.find((lane) => lane.lane === laneId);
}

function blueprintStatusFromLane(lane: ExamLane | undefined): CommercialBlueprintItem["status"] {
  if (!lane) {
    return "blocked";
  }
  if (lane.status === "pass") {
    return "ready";
  }
  if (lane.status === "not_run") {
    return "not_run";
  }
  return "blocked";
}

function buildCommercialBlueprint(params: { lanes: ExamLane[]; live: boolean; l5: boolean }) {
  const moduleLane = laneById(params.lanes, "module_learning_internalization");
  const inventoryLane = laneById(params.lanes, "learning_sedimentation_inventory");
  const liveLane = laneById(params.lanes, "live_visible_boundary");
  const larkLane = laneById(params.lanes, "lark_feishu_visible_loop");
  const l5Lane = laneById(params.lanes, "l5_regression_battery");
  const answerLane = laneById(params.lanes, "commercial_answer_audit_pipeline");
  const controlRoomLane = laneById(params.lanes, "product_control_room");
  const moduleLearningStatus =
    inventoryLane?.status === "pass"
      ? "ready"
      : moduleLane?.status === "pass"
        ? "ready"
        : "needs_receipts";

  return [
    {
      id: "live_closure",
      order: 1,
      title: "dev/live 闭环和真实 Lark 验收",
      ownerLane: "live_visible_boundary",
      status:
        params.live && liveLane?.status === "warn" && larkLane?.status !== "fail"
          ? "needs_live"
          : params.live
            ? blueprintStatusFromLane(liveLane)
            : "needs_live",
      evidence: liveLane?.evidence ?? ["live lane missing"],
      nextAction:
        "按 dev-ready -> live-runtime-updated -> live-user-seen 顺序做迁移、重启、probe、真实入站回复验收。",
    },
    {
      id: "module_learning_absorption",
      order: 2,
      title: "模块学习真实吸收证据",
      ownerLane: "learning_sedimentation_inventory",
      status: moduleLearningStatus,
      evidence: [
        ...(inventoryLane?.evidence ?? ["learning sedimentation inventory missing"]),
        ...(moduleLane?.evidence ?? ["module learning lane missing"]),
      ],
      nextAction:
        moduleLearningStatus === "ready"
          ? "保持 no-write review 和 learning-sedimentation audit；新输入继续要求 fresh adjacent application、per-receipt eval/training、keep/downrank/discard。"
          : "补 module_learning_pipeline_plan/review、fresh adjacent application、per-receipt eval/training 和 keep/downrank/discard。",
    },
    {
      id: "l5_runtime_battery",
      order: 3,
      title: "L5 回归和运行时依赖漂移门禁",
      ownerLane: "l5_regression_battery",
      status: params.l5 ? blueprintStatusFromLane(l5Lane) : "not_run",
      evidence: l5Lane?.evidence ?? ["--l5 not supplied"],
      nextAction:
        "需要大考时跑 lcx-agent-exam --l5；doctrine consistency 负责捕捉 L5 skill 脚本 PATH/pnpm 漂移。",
    },
    {
      id: "commercial_answer_audit",
      order: 4,
      title: "商用回答流水线和有限拷打",
      ownerLane: "commercial_answer_audit_pipeline",
      status: blueprintStatusFromLane(answerLane),
      evidence: answerLane?.evidence ?? ["answer audit lane missing"],
      nextAction:
        "保持模型答案是候选、Qwen 是 challenger、本地审计有限轮次，最终采纳可见回复或返回失败理由。",
    },
    {
      id: "live_observability_summary",
      order: 5,
      title: "live 可观测摘要和 Lark 验收入口",
      ownerLane: "lark_feishu_visible_loop",
      status: params.live ? blueprintStatusFromLane(larkLane) : "needs_live",
      evidence: larkLane?.evidence ?? ["lark lane missing"],
      nextAction:
        "live 验收必须落到 lark-loop-diagnose、channel probe、feishu-reply-flow 和真实用户可见回复。",
    },
    {
      id: "product_control_room",
      order: 6,
      title: "产品化 control room 与入口收敛",
      ownerLane: "product_control_room",
      status: blueprintStatusFromLane(controlRoomLane),
      evidence: controlRoomLane?.evidence ?? ["control room lane missing"],
      nextAction:
        "保留必要多入口，但任何新增入口都要有 single factual owner 和 flow-graph consolidated entrypoint family。",
    },
  ] satisfies CommercialBlueprintItem[];
}

export function buildAgentExamReport(params: {
  checkedAt?: string;
  live: boolean;
  l5: boolean;
  doctor: CommandResult;
  trainingPlan: CommandResult;
  promotionAudit: CommandResult;
  moduleLearningReview: CommandResult;
  learningSedimentationAudit?: CommandResult;
  cognitiveIntegritySources?: CognitiveIntegritySources;
  larkDiagnose?: CommandResult;
  channelProbe?: CommandResult;
  l5Battery?: CommandResult;
}): ExamReport {
  const lanes = [
    buildSystemDoctorLane(params.doctor),
    buildTrainingLane(params.trainingPlan),
    buildPromotionLane(params.promotionAudit),
    buildModuleLearningLane(params.moduleLearningReview),
    buildLearningSedimentationInventoryLane(params.learningSedimentationAudit),
    buildThinkingHierarchyLane(params.cognitiveIntegritySources),
    buildWorkStatusBoundaryLane(params.cognitiveIntegritySources),
    buildMemorySedimentationLane(params.cognitiveIntegritySources),
    buildAnswerAuditPipelineLane(params.cognitiveIntegritySources),
    buildControlRoomProductLane(params.cognitiveIntegritySources),
    buildAutomationLane(params.trainingPlan, params.doctor),
    buildLarkLane(params.larkDiagnose, params.live),
    buildLiveBoundaryLane(params.live, params.channelProbe),
    buildL5Lane(params.l5Battery, params.l5),
  ];
  const fail = lanes.filter((lane) => lane.status === "fail").length;
  const warn = lanes.filter((lane) => lane.status === "warn").length;
  const notRun = lanes.filter((lane) => lane.status === "not_run").length;
  const pass = lanes.filter((lane) => lane.status === "pass").length;
  const nextBlocker =
    lanes.find((lane) => lane.status === "fail")?.lane ??
    lanes.find((lane) => lane.status === "warn")?.lane ??
    "none";
  const commercialBlueprint = buildCommercialBlueprint({
    lanes,
    live: params.live,
    l5: params.l5,
  });
  return {
    ok: fail === 0,
    boundary: params.live ? "dev_exam_with_live_probe" : "dev_exam_only",
    checkedAt: params.checkedAt ?? new Date().toISOString(),
    liveTouched: params.live,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    trainingStarted: false,
    heavyEvalStarted: false,
    lanes,
    commercialBlueprint,
    commands: {
      doctor: params.doctor,
      trainingPlan: params.trainingPlan,
      promotionAudit: params.promotionAudit,
      moduleLearningReview: params.moduleLearningReview,
      ...(params.learningSedimentationAudit
        ? { learningSedimentationAudit: params.learningSedimentationAudit }
        : {}),
      ...(params.larkDiagnose ? { larkDiagnose: params.larkDiagnose } : {}),
      ...(params.channelProbe ? { channelProbe: params.channelProbe } : {}),
      ...(params.l5Battery ? { l5Battery: params.l5Battery } : {}),
    },
    summary: {
      pass,
      warn,
      fail,
      notRun,
      nextBlocker,
    },
  };
}

function runCommand(params: {
  name: string;
  command: string;
  args: string[];
  parseJson?: boolean;
  timeoutMs: number;
}): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(params.command, params.args, {
      cwd: WORKTREE_CWD,
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
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        name: params.name,
        durationMs: Date.now() - startedAt,
        error: `${params.name} timed out after ${params.timeoutMs}ms`,
        stdoutTail: stdout.slice(-1_000),
        stderrTail: stderr.slice(-1_000),
      });
    }, params.timeoutMs);
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        name: params.name,
        durationMs: Date.now() - startedAt,
        error: error.message,
        stdoutTail: stdout.slice(-1_000),
        stderrTail: stderr.slice(-1_000),
      });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        resolve({
          ok: false,
          name: params.name,
          durationMs,
          error: `${params.name} exited ${code}`,
          stdoutTail: stdout.slice(-1_000),
          stderrTail: stderr.slice(-1_000),
        });
        return;
      }
      try {
        resolve({
          ok: true,
          name: params.name,
          durationMs,
          json: params.parseJson ? parseJsonObjectFromOutput(stdout) : undefined,
          stdoutTail: stdout.slice(-1_000),
        });
      } catch (error) {
        resolve({
          ok: false,
          name: params.name,
          durationMs,
          error: error instanceof Error ? error.message : String(error),
          stdoutTail: stdout.slice(-1_000),
          stderrTail: stderr.slice(-1_000),
        });
      }
    });
  });
}

async function readCognitiveIntegritySources(): Promise<CognitiveIntegritySources> {
  const read = async (relativePath: string): Promise<string> =>
    fs.readFile(path.join(WORKTREE_CWD, relativePath), "utf8");
  const [
    doctrine,
    localBrainEval,
    localBrainEvalTests,
    systemPrompt,
    moduleLearningReviewTool,
    larkSurfaces,
    localBrainRunbook,
    answerAuditSurfaces,
    controlRoomSurfaces,
  ] = await Promise.all([
    read("AGENTS.md"),
    read("scripts/dev/local-brain-distill-eval.ts"),
    read("test/local-brain-distill-eval.test.ts"),
    read("src/agents/system-prompt.ts"),
    read("src/agents/tools/module-learning-pipeline-review-tool.ts"),
    read("extensions/feishu/src/surfaces.ts"),
    read("ops/local-brain/README.md"),
    Promise.all([
      read("scripts/dev/lcx-commercial-answer-pipeline.ts"),
      read("test/lcx-commercial-answer-pipeline.test.ts"),
      read("extensions/feishu/src/lark-language-handoff-receipts.ts"),
      read("extensions/feishu/src/lark-context-packet.ts"),
      read("extensions/feishu/src/reply-flow-audit.ts"),
      read("src/auto-reply/reply/feishu-reply-flow-evidence.ts"),
    ]).then((parts) => parts.join("\n")),
    Promise.all([
      read("AGENTS.md"),
      read("README.md"),
      read("src/commands/capabilities.ts"),
      read("ops/local-brain/README.md"),
    ]).then((parts) => parts.join("\n")),
  ]);
  return {
    doctrine,
    localBrainEval,
    localBrainEvalTests,
    systemPrompt,
    moduleLearningReviewTool,
    larkSurfaces,
    localBrainRunbook,
    answerAuditSurfaces,
    controlRoomSurfaces,
  };
}

export async function runAgentExam(options: CliOptions): Promise<ExamReport> {
  const cognitiveIntegritySourcesPromise = readCognitiveIntegritySources();
  const doctor = await runCommand({
    name: "lcx-system-doctor",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/dev/lcx-system-doctor.ts", "--json"],
    parseJson: true,
    timeoutMs: options.timeoutMs,
  });
  const trainingPlan = await runCommand({
    name: "local-brain-training-plan",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/dev/local-brain-training-plan.ts", "--json"],
    parseJson: true,
    timeoutMs: options.timeoutMs,
  });
  const promotionAudit = await runCommand({
    name: "local-brain-promotion-audit",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/dev/local-brain-promotion-audit.ts", "--json"],
    parseJson: true,
    timeoutMs: options.timeoutMs,
  });
  const moduleLearningReview = await runCommand({
    name: "module-learning-pipeline-review",
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "scripts/dev/module-learning-pipeline-review.ts",
      "--workspace",
      DEFAULT_WORKSPACE_DIR,
      "--no-write",
      "--json",
    ],
    parseJson: true,
    timeoutMs: options.timeoutMs,
  });
  const learningSedimentationAudit = await runCommand({
    name: "lcx-learning-sedimentation-audit",
    command: process.execPath,
    args: ["--import", "tsx", "scripts/dev/lcx-learning-sedimentation-audit.ts", "--json"],
    parseJson: true,
    timeoutMs: options.timeoutMs,
  });
  const cognitiveIntegritySources = await cognitiveIntegritySourcesPromise;

  const [larkDiagnose, channelProbe] = options.live
    ? await Promise.all([
        runCommand({
          name: "lark-loop-diagnose",
          command: "pnpm",
          args: ["--silent", "openclaw", "capabilities", "lark-loop-diagnose", "--json"],
          parseJson: true,
          timeoutMs: options.timeoutMs,
        }),
        runCommand({
          name: "channels-status-probe",
          command: "pnpm",
          args: ["--silent", "openclaw", "channels", "status", "--probe", "--json"],
          parseJson: true,
          timeoutMs: options.timeoutMs,
        }),
      ])
    : [undefined, undefined];

  const l5Battery = options.l5
    ? await runCommand({
        name: "l5-regression-batterer",
        command:
          "/Users/liuchengxu/.codex/skills/l5-regression-batterer/scripts/l5-regression-batterer.sh",
        args: ["--local"],
        timeoutMs: Math.max(options.timeoutMs, 120_000),
      })
    : undefined;

  return buildAgentExamReport({
    live: options.live,
    l5: options.l5,
    doctor,
    trainingPlan,
    promotionAudit,
    moduleLearningReview,
    learningSedimentationAudit,
    cognitiveIntegritySources,
    larkDiagnose,
    channelProbe,
    l5Battery,
  });
}

function renderText(report: ExamReport): string {
  const lines = [
    `LCX Agent exam | ok=${String(report.ok)} boundary=${report.boundary}`,
    `summary pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} not_run=${report.summary.notRun} nextBlocker=${report.summary.nextBlocker}`,
    "",
  ];
  for (const lane of report.lanes) {
    lines.push(
      `${lane.status.toUpperCase()} ${lane.lane} severity=${lane.severity} boundary=${lane.boundary}`,
    );
    lines.push(`  evidence: ${lane.evidence.join(" | ")}`);
    lines.push(`  issue: ${lane.issue}`);
    lines.push(`  next: ${lane.nextAction}`);
  }
  lines.push("", "commercial blueprint:");
  for (const item of report.commercialBlueprint) {
    lines.push(`${item.order}. ${item.status.toUpperCase()} ${item.id} owner=${item.ownerLane}`);
    lines.push(`  evidence: ${item.evidence.join(" | ")}`);
    lines.push(`  next: ${item.nextAction}`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const report = await runAgentExam(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
}
