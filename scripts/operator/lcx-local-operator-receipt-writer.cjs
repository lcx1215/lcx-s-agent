// Original local operator receipt writer. The shell owns child execution;
// this file only captures original bytes and publishes the existing receipt.
const fs = require("fs");
const path = require("path");

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, parseError: String(error) };
  }
}

function readText(path) {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function findCheck(doctor, name) {
  return Array.isArray(doctor.checks)
    ? doctor.checks.find((check) => check.name === name)
    : undefined;
}

const crypto = require("crypto");
// Collector-assigned identity; child business run identities remain in original stdout.
const collectionRunId = process.env.NODE_COLLECTION_RUN_ID;
if (!/^[a-f0-9-]{36}$/.test(collectionRunId || "")) {
  throw new Error("invalid collection run id");
}
const collectionRelativeDir = `state/local-operator-collections/${collectionRunId}`;
const collectionDir = path.join(process.env.NODE_REPO_ROOT, collectionRelativeDir);
fs.mkdirSync(collectionDir, { recursive: true, mode: 0o700 });
const childFiles = [
  ["doctor", "scripts/operator/lcx-system-doctor.ts", "DOCTOR", "DOCTOR"],
  ["trainingPlan", "scripts/operator/local-brain-training-plan.ts", "PLAN", "PLAN"],
  [
    "governanceAutopilot",
    "scripts/operator/lcx-governance-autopilot.ts",
    "GOVERNANCE",
    "GOVERNANCE",
  ],
  ["mindModel", "scripts/operator/lcx-mind-model.ts", "MIND", "MIND"],
  ["flowGraph", "scripts/operator/lcx-flow-graph.ts", "FLOW", "FLOW"],
  [
    "contextRecovery",
    "scripts/operator/lcx-context-recovery-exam.ts",
    "CONTEXT_RECOVERY",
    "CONTEXT_RECOVERY",
  ],
  [
    "trainingSupervisor",
    "host-installed:lcx-local-operator-loop.sh",
    "TRAINING_SUPERVISOR",
    "TRAINING_SUPERVISOR",
  ],
  ["exam", "scripts/operator/lcx-agent-exam.ts", "EXAM", "EXAM"],
  ["cleanup", "host-installed:lcx-local-operator-loop.sh", "CLEANUP", "CLEANUP"],
];
let remainingBytes = 16 * 1024 * 1024;
function captureChildFile(id, channel, filename) {
  if (!filename || !fs.existsSync(filename)) {
    return { status: "not_emitted" };
  }
  const size = fs.statSync(filename).size;
  if (size > 4 * 1024 * 1024 || size > remainingBytes) {
    return { status: "omitted_budget", bytes: size };
  }
  const bytes = fs.readFileSync(filename);
  if (bytes.length > remainingBytes || bytes.length > 4 * 1024 * 1024) {
    return { status: "omitted_budget", bytes: bytes.length };
  }
  const relativePath = `${collectionRelativeDir}/${id}.${channel}`;
  fs.writeFileSync(path.join(process.env.NODE_REPO_ROOT, relativePath), bytes, {
    mode: 0o600,
    flag: "wx",
  });
  remainingBytes -= bytes.length;
  return {
    status: "captured",
    path: relativePath,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
const children = {};
for (const [id, owner, fileKey, codeKey] of childFiles) {
  children[id] = {
    collectionRunId,
    owner,
    exitCode: Number(process.env[`NODE_${codeKey}_CODE`]),
    stdout: captureChildFile(id, "stdout", process.env[`NODE_${fileKey}_FILE`]),
    stderr: captureChildFile(id, "stderr", process.env[`NODE_${fileKey}_ERR`]),
  };
}
const collectionManifest = {
  schemaVersion: "lcx_local_operator_collection_v1",
  collectionRunId,
  capturedAt: new Date().toISOString(),
  repoRoot: process.env.NODE_REPO_ROOT,
  sourceCommit: process.env.NODE_SOURCE_COMMIT || null,
  writerSourceSha256: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
  children,
  boundary: "original_child_bytes_not_child_business_identity_or_semantic_truth",
};
const manifestRelativePath = `${collectionRelativeDir}/manifest.json`;
const manifestBytes = JSON.stringify(collectionManifest, null, 2) + "\n";
fs.writeFileSync(path.join(process.env.NODE_REPO_ROOT, manifestRelativePath), manifestBytes, {
  mode: 0o600,
  flag: "wx",
});
const collection = {
  runId: collectionRunId,
  manifest: {
    path: manifestRelativePath,
    sha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"),
  },
};

const doctor = readJson(process.env.NODE_DOCTOR_FILE);
const plan = readJson(process.env.NODE_PLAN_FILE);
const exam = readJson(process.env.NODE_EXAM_FILE);
const governanceAutopilot = readJson(process.env.NODE_GOVERNANCE_FILE);
const mindModel = readJson(process.env.NODE_MIND_FILE);
const flowGraph = readJson(process.env.NODE_FLOW_FILE);
const contextRecovery = readJson(process.env.NODE_CONTEXT_RECOVERY_FILE);
const trainingSupervisor = readJson(process.env.NODE_TRAINING_SUPERVISOR_FILE);
const brainCheck = findCheck(doctor, "minimax-brain-training-guard");
const gitCheck = findCheck(doctor, "git-status");
const brain = brainCheck?.summary || {};
const decisions = Array.isArray(plan.decisions)
  ? plan.decisions.map((decision) => ({
      id: decision.id,
      lane: decision.lane,
      severity: decision.severity,
      action: decision.action,
      reason: decision.reason,
      codexRepairEligible: Boolean(decision.codexRepairEligible),
      nextCommand: decision.nextCommand,
    }))
  : [];

function evalSummary(evalRecord) {
  if (!evalRecord?.summary) {
    return undefined;
  }
  return {
    passed: evalRecord.summary.passed,
    total: evalRecord.summary.total,
    passRate: evalRecord.summary.passRate,
    promotionReady: evalRecord.summary.promotionReady,
    failedCaseIds: Array.isArray(evalRecord.summary.failedCaseIds)
      ? evalRecord.summary.failedCaseIds
      : [],
    parseErrorCaseIds: Array.isArray(evalRecord.summary.parseErrorCaseIds)
      ? evalRecord.summary.parseErrorCaseIds
      : [],
    parseRecoveredCaseIds: Array.isArray(evalRecord.summary.parseRecoveredCaseIds)
      ? evalRecord.summary.parseRecoveredCaseIds
      : [],
    adapterPath: evalRecord.adapterPath,
  };
}

const receipt = {
  collection,
  checkedAt: new Date().toISOString(),
  lane: "local_operator_loop",
  source: {
    repoRoot: process.env.NODE_REPO_ROOT,
    commit: process.env.NODE_SOURCE_COMMIT || null,
  },
  mode: /^(true|1|yes)$/i.test(process.env.NODE_OBSERVE_ONLY || "") ? "observe_only" : "scheduled",
  status: /^(true|1|yes)$/i.test(process.env.NODE_OBSERVE_ONLY || "")
    ? "observed_with_skipped_owners"
    : "scheduled_owner_result",
  boundary: "local_observability_only",
  ok:
    Boolean(doctor.ok) &&
    Boolean(plan.ok) &&
    Boolean(governanceAutopilot.ok) &&
    Boolean(mindModel.ok) &&
    Boolean(flowGraph.ok) &&
    Boolean(contextRecovery.ok) &&
    Boolean(trainingSupervisor.ok) &&
    Number(process.env.NODE_CLEANUP_CODE) === 0,
  commands: {
    cleanupExitCode: Number(process.env.NODE_CLEANUP_CODE),
    doctorExitCode: Number(process.env.NODE_DOCTOR_CODE),
    trainingPlanExitCode: Number(process.env.NODE_PLAN_CODE),
    governanceAutopilotExitCode: Number(process.env.NODE_GOVERNANCE_CODE),
    mindModelExitCode: Number(process.env.NODE_MIND_CODE),
    flowGraphExitCode: Number(process.env.NODE_FLOW_CODE),
    contextRecoveryExitCode: Number(process.env.NODE_CONTEXT_RECOVERY_CODE),
    trainingSupervisorExitCode: Number(process.env.NODE_TRAINING_SUPERVISOR_CODE),
    examExitCode: Number(process.env.NODE_EXAM_CODE),
  },
  cleanup: readText(process.env.NODE_CLEANUP_FILE),
  doctor: {
    ok: Boolean(doctor.ok),
    boundary: doctor.boundary,
    passed: doctor.summary?.passed,
    failed: doctor.summary?.failed,
    liveTouched: Boolean(doctor.liveTouched),
  },
  git: gitCheck?.summary
    ? {
        branch: gitCheck.summary.branch,
        dirty: Boolean(gitCheck.summary.dirty),
        totalChanges: gitCheck.summary.counts?.total,
      }
    : undefined,
  training: {
    active: Boolean(brain.active),
    activeProcesses: Array.isArray(brain.activeProcesses) ? brain.activeProcesses : [],
    overlappingHeavyEval: Boolean(brain.overlappingHeavyEval),
    latestGuardStart: brain.latestGuardStart,
    latestStableEval: evalSummary(brain.latestStableEval),
    latestCandidateEval: evalSummary(brain.latestCandidateEval),
    latestTeacher: brain.latestTeacher,
    datasetCounts: brain.latestDataset?.counts,
  },
  trainingSupervisor,
  operatorGuards: {
    skipCleanup: /^(true|1|yes)$/i.test(process.env.NODE_SKIP_CLEANUP || ""),
    skipTrainingRestart: /^(true|1|yes)$/i.test(process.env.NODE_SKIP_TRAINING_RESTART || ""),
  },
  trainingPlan: {
    ok: Boolean(plan.ok),
    boundary: plan.boundary,
    volatileOwner: "local-brain-training-plan",
    digestRole: "compressed_digest_not_realtime_training_authority",
    decisions,
    activeProcessCount: Array.isArray(plan.activeProcesses)
      ? plan.activeProcesses.length
      : undefined,
    latestEval: plan.latestEval
      ? {
          name: plan.latestEval.name,
          passed: plan.latestEval.passed,
          total: plan.latestEval.total,
          promotionReady: plan.latestEval.promotionReady,
          parseRecoveredCaseIds: Array.isArray(plan.latestEval.parseRecoveredCaseIds)
            ? plan.latestEval.parseRecoveredCaseIds
            : [],
        }
      : undefined,
    latestPromotedAdapter: plan.latestPromotedAdapter,
    learningSedimentationBridge: plan.learningSedimentationBridge
      ? {
          candidateCount: plan.learningSedimentationBridge.candidateCount,
          sourceApplyReceiptFiles: plan.learningSedimentationBridge.sourceApplyReceiptFiles,
          nextAction: plan.learningSedimentationBridge.nextAction,
        }
      : undefined,
    codexAutoRepairEligible: Boolean(plan.codexAutoRepair?.eligible),
  },
  governanceAutopilot: {
    ok: Boolean(governanceAutopilot.ok),
    boundary: governanceAutopilot.boundary,
    checkedAt: governanceAutopilot.checkedAt,
    latestStatePath: governanceAutopilot.latestStatePath,
    autoTriggeredOwnerCommands: Array.isArray(governanceAutopilot.autoTriggeredOwnerCommands)
      ? governanceAutopilot.autoTriggeredOwnerCommands
      : [],
    triggerPolicy: governanceAutopilot.triggerPolicy,
    summary: governanceAutopilot.summary,
  },
  mindModel: {
    ok: Boolean(mindModel.ok),
    boundary: mindModel.boundary,
    passed: mindModel.summary?.passed,
    failed: mindModel.summary?.failed,
    total: mindModel.summary?.total,
    masterLanes: mindModel.summary?.masterLanes,
    missingSurfaceFiles: Array.isArray(mindModel.missingSurfaceFiles)
      ? mindModel.missingSurfaceFiles
      : [],
    actionableFailures: Array.isArray(mindModel.actionableFailures)
      ? mindModel.actionableFailures.slice(0, 5)
      : [],
  },
  flowGraph: {
    ok: Boolean(flowGraph.ok),
    boundary: flowGraph.boundary,
    passed: flowGraph.summary?.passed,
    failed: flowGraph.summary?.failed,
    total: flowGraph.summary?.total,
    scenarios: flowGraph.summary?.scenarios,
    nodes: flowGraph.summary?.nodes,
    filters: flowGraph.summary?.filters,
    actionableFailures: Array.isArray(flowGraph.actionableFailures)
      ? flowGraph.actionableFailures.slice(0, 5)
      : [],
  },
  contextRecovery: {
    ok: Boolean(contextRecovery.ok),
    boundary: contextRecovery.boundary,
    compressedContextRecovered: Boolean(contextRecovery.compressedContextRecovered),
    passed: contextRecovery.summary?.passed,
    failed: contextRecovery.summary?.failed,
    total: contextRecovery.summary?.total,
    actionableFailures: Array.isArray(contextRecovery.actionableFailures)
      ? contextRecovery.actionableFailures.slice(0, 5)
      : [],
  },
  exam: exam.skipped
    ? { skipped: true, reason: exam.reason }
    : {
        ok: Boolean(exam.ok),
        summary: exam.summary,
        actionableFailures: exam.actionableFailures,
      },
  errors: {
    doctor: readText(process.env.NODE_DOCTOR_ERR),
    trainingPlan: readText(process.env.NODE_PLAN_ERR),
    governanceAutopilot: readText(process.env.NODE_GOVERNANCE_ERR),
    mindModel: readText(process.env.NODE_MIND_ERR),
    flowGraph: readText(process.env.NODE_FLOW_ERR),
    contextRecovery: readText(process.env.NODE_CONTEXT_RECOVERY_ERR),
    exam: readText(process.env.NODE_EXAM_ERR),
  },
  liveTouched: false,
  providerConfigTouched: false,
  protectedMemoryTouched: false,
};

fs.appendFileSync(process.env.NODE_JSONL, JSON.stringify(receipt) + "\n");
writeJsonAtomically(process.env.NODE_REPO_LATEST, receipt);
writeJsonAtomically(process.env.NODE_LATEST, receipt);
console.log(JSON.stringify(receipt));
