import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

type FeatureCheck = {
  id: string;
  ok: boolean;
  summary: string;
  owner: string;
  evidence: Record<string, unknown>;
  nextAction?: string;
};

type LiveReferenceClass =
  | "canonical_external_channel_owner"
  | "legacy_live_compatibility"
  | "openclaw_live_test_or_platform_feature"
  | "historical_ops_receipt"
  | "plain_english_or_unrelated_runtime"
  | "needs_review";

type LiveReferenceSample = {
  file: string;
  line: number;
  text: string;
  classification: LiveReferenceClass;
};

type LiveReferenceInventory = {
  totalMatches: number;
  counts: Record<LiveReferenceClass, number>;
  needsReviewSamples: LiveReferenceSample[];
};

// Keep the retired-token detector itself explicit: these legacy spellings are
// inputs to the audit, never active LCX status vocabulary.
const RETIRED_DEVELOPMENT_STATUS_PATTERN =
  /\bdev-ready\b|\bdev-fixed\b|\bdev-only\b|dev_[a-z]|[a-z]_dev_|dev\/external-channel|\bdev (?:proof|owner|repo|changes?)\b/giu;

const CANONICAL_TERMS = [
  "core-ready",
  "cloud-runtime-ready",
  "external-channel-bound",
  "user-visible-observed",
  "legacy-live-runtime-updated",
  "legacy-live-user-seen",
  "legacy-live-visible-fixed",
] as const;

const CRITICAL_OWNER_FILES = [
  "scripts/operator/lcx-external-channel-binding.ts",
  "scripts/operator/lcx-external-channel-status.ts",
  "scripts/operator/lcx-external-channel-compat.ts",
  "scripts/operator/lcx-commercial-acceptance-harness.ts",
  "scripts/operator/local-brain-training-plan.ts",
  "scripts/operator/lcx-governance-autopilot.ts",
  "scripts/operator/lcx-system-doctor.ts",
  "scripts/operator/lcx-context-recovery-exam.ts",
  "scripts/operator/lcx-flow-graph.ts",
  "scripts/operator/lcx-mind-model.ts",
  "scripts/operator/lcx-skillopt-lite.ts",
  "scripts/operator/lcx-monotonic-data-ledger.ts",
  "scripts/operator/lcx-live-fadeout-audit.ts",
  "skills/agent-runtime-drift-auditor/SKILL.md",
  "AGENTS.md",
  "README.md",
  "ops/local-brain/README.md",
] as const;

async function readText(relativePath: string): Promise<string> {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

function checkTerms(params: {
  id: string;
  owner: string;
  file: string;
  requiredTerms: readonly string[];
  summary: string;
  text: string;
  nextAction?: string;
}): FeatureCheck {
  const missing = params.requiredTerms.filter((term) => !params.text.includes(term));
  return {
    id: params.id,
    ok: missing.length === 0,
    summary: params.summary,
    owner: params.owner,
    evidence: {
      file: params.file,
      missing,
      requiredTerms: params.requiredTerms,
    },
    nextAction: missing.length > 0 ? params.nextAction : undefined,
  };
}

function classifyLiveReference(file: string, text: string): LiveReferenceClass {
  const lower = `${file}\n${text}`.toLowerCase();
  if (CRITICAL_OWNER_FILES.includes(file as (typeof CRITICAL_OWNER_FILES)[number])) {
    return lower.includes("external-channel") ||
      lower.includes("externalchannel") ||
      lower.includes("user-visible") ||
      lower.includes("legacy") ||
      lower.includes("compatibility")
      ? "canonical_external_channel_owner"
      : "legacy_live_compatibility";
  }
  if (file === "package.json") {
    return lower.includes("external-channel")
      ? "canonical_external_channel_owner"
      : "legacy_live_compatibility";
  }
  if (
    file.startsWith("scripts/operator/external-channel-sidecar") ||
    file.startsWith("test/external-channel-sidecar") ||
    (file.startsWith("scripts/operator/") &&
      !CRITICAL_OWNER_FILES.includes(file as (typeof CRITICAL_OWNER_FILES)[number])) ||
    file === "scripts/operator/lcx-external-channel-compat.ts" ||
    file === "test/lcx-external-channel-compat-status.test.ts"
  ) {
    return "legacy_live_compatibility";
  }
  if (file.startsWith("scripts/")) {
    return "openclaw_live_test_or_platform_feature";
  }
  if (
    file.includes(".live.test.") ||
    file.includes("vitest.live.config") ||
    lower.includes("live_test") ||
    lower.includes("openclaw_live_test") ||
    lower.includes("clawdbot_live_test") ||
    lower.includes("test:live") ||
    lower.includes("live location") ||
    lower.includes("locationislive")
  ) {
    return "openclaw_live_test_or_platform_feature";
  }
  if (
    file.startsWith("ops/external-channel-history/") ||
    file.startsWith("ops/external-channel-artifacts/") ||
    file.startsWith("ops/dev-full-loop-acceptance/") ||
    (file.startsWith("ops/") && file !== "ops/local-brain/README.md")
  ) {
    return "historical_ops_receipt";
  }
  if (
    file.startsWith("extensions/external/") ||
    file.startsWith("src/agents/tools/external-live-probe") ||
    file.startsWith("src/agents/visible-answer-adoption-gate")
  ) {
    return lower.includes("external-channel") ||
      lower.includes("user-visible") ||
      lower.includes("legacy")
      ? "canonical_external_channel_owner"
      : "legacy_live_compatibility";
  }
  if (
    file.startsWith("src/") ||
    file.startsWith("extensions/") ||
    file.startsWith("docs/") ||
    file.startsWith("test/")
  ) {
    return "openclaw_live_test_or_platform_feature";
  }
  if (
    lower.includes("keepalive") ||
    lower.includes("live under") ||
    lower.includes("lives in") ||
    lower.includes("live in ") ||
    lower.includes("can live") ||
    lower.includes("still live")
  ) {
    return "plain_english_or_unrelated_runtime";
  }
  return "needs_review";
}

async function buildLiveReferenceInventory(): Promise<LiveReferenceInventory> {
  let stdout = "";
  try {
    const result = await execFileAsync(
      "git",
      [
        "grep",
        "-nI",
        "-E",
        "(^|[^[:alpha:]])live([^[:alpha:]]|$)|LiveExternal|LIVE_TEST|liveUserSeen|liveRuntime|live-visible|live-user-seen|live_external|live_sidecar|live_sender",
        "--",
        "AGENTS.md",
        "README.md",
        "package.json",
        "scripts",
        "src",
        "extensions",
        "test",
        "ops",
      ],
      {
        cwd: REPO_ROOT,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    const maybe = error as { stdout?: unknown; code?: unknown };
    if (maybe.code === 1 && typeof maybe.stdout === "string") {
      stdout = maybe.stdout;
    } else {
      throw error;
    }
  }

  const counts: Record<LiveReferenceClass, number> = {
    canonical_external_channel_owner: 0,
    legacy_live_compatibility: 0,
    openclaw_live_test_or_platform_feature: 0,
    historical_ops_receipt: 0,
    plain_english_or_unrelated_runtime: 0,
    needs_review: 0,
  };
  const needsReviewSamples: LiveReferenceSample[] = [];
  let totalMatches = 0;

  for (const rawLine of stdout.split("\n")) {
    if (!rawLine.trim()) {
      continue;
    }
    const firstColon = rawLine.indexOf(":");
    const secondColon = firstColon >= 0 ? rawLine.indexOf(":", firstColon + 1) : -1;
    if (firstColon < 0 || secondColon < 0) {
      continue;
    }
    const file = rawLine.slice(0, firstColon);
    const lineText = rawLine.slice(firstColon + 1, secondColon);
    const text = rawLine.slice(secondColon + 1);
    const line = Number.parseInt(lineText, 10);
    const classification = classifyLiveReference(file, text);
    counts[classification] += 1;
    totalMatches += 1;
    if (classification === "needs_review" && needsReviewSamples.length < 20) {
      needsReviewSamples.push({ file, line, text: text.trim().slice(0, 240), classification });
    }
  }

  return { totalMatches, counts, needsReviewSamples };
}

export async function buildLcxLiveFadeoutAudit() {
  const [
    agents,
    readme,
    runbook,
    packageJsonText,
    bindingOwner,
    statusOwner,
    promoteLive,
    commercialAcceptance,
    trainingPlan,
    governanceAutopilot,
    systemDoctor,
    contextRecovery,
    flowGraph,
    mindModel,
    skillOptLite,
    skillOptAutocue,
    runtimeDriftSkill,
  ] = await Promise.all([
    readText("AGENTS.md"),
    readText("README.md"),
    readText("ops/local-brain/README.md"),
    readText("package.json"),
    readText("scripts/operator/lcx-external-channel-binding.ts"),
    readText("scripts/operator/lcx-external-channel-status.ts"),
    readText("scripts/operator/lcx-external-channel-compat.ts"),
    readText("scripts/operator/lcx-commercial-acceptance-harness.ts"),
    readText("scripts/operator/local-brain-training-plan.ts"),
    readText("scripts/operator/lcx-governance-autopilot.ts"),
    readText("scripts/operator/lcx-system-doctor.ts"),
    readText("scripts/operator/lcx-context-recovery-exam.ts"),
    readText("scripts/operator/lcx-flow-graph.ts"),
    readText("scripts/operator/lcx-mind-model.ts"),
    readText("scripts/operator/lcx-skillopt-lite.ts"),
    readText("src/auto-reply/reply/skillopt-autocue.ts"),
    readText("skills/agent-runtime-drift-auditor/SKILL.md"),
  ]);

  const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};

  const activeOwnerText = [
    agents,
    readme,
    runbook,
    bindingOwner,
    statusOwner,
    promoteLive,
    commercialAcceptance,
    trainingPlan,
    governanceAutopilot,
    systemDoctor,
    contextRecovery,
    flowGraph,
    mindModel,
    skillOptLite,
    skillOptAutocue,
    runtimeDriftSkill,
  ].join("\n");

  const checks: FeatureCheck[] = [
    {
      id: "active_local_status_semantics_retired",
      ok: !RETIRED_DEVELOPMENT_STATUS_PATTERN.test(activeOwnerText),
      summary:
        "active doctrine and owner contracts must use core/local/channel states instead of legacy development status semantics",
      owner: "scripts/operator/lcx-live-fadeout-audit.ts",
      evidence: {
        retiredPattern: RETIRED_DEVELOPMENT_STATUS_PATTERN.source,
        allowedExamples: [
          "scripts/operator/",
          "pnpm dev",
          "devDependencies",
          "historical receipts",
        ],
      },
      nextAction:
        "replace active legacy development status semantics with core-ready, core-verified, or local-only while preserving physical paths and historical receipts",
    },
    checkTerms({
      id: "runtime_drift_skill_uses_unified_local_model",
      owner: "skills/agent-runtime-drift-auditor/SKILL.md",
      file: "skills/agent-runtime-drift-auditor/SKILL.md",
      requiredTerms: [
        "canonical repository",
        "linked worktree",
        "external-channel-bound",
        "core-ready",
        "GitHub/GitLab",
        "not a second repository",
      ],
      summary:
        "runtime drift guidance must describe one local system/repository with worktrees and keep remote feature branches at GitHub/GitLab",
      text: runtimeDriftSkill,
      nextAction:
        "rewrite runtime drift guidance around one local system/factory, linked worktrees, and the external-channel boundary",
    }),
    checkTerms({
      id: "doctrine_uses_forward_status_model",
      owner: "AGENTS.md + README.md + ops/local-brain/README.md",
      file: "doctrine_docs",
      requiredTerms: CANONICAL_TERMS,
      summary: "doctrine documents must teach future agents the new status model",
      text: `${agents}\n${readme}\n${runbook}`,
      nextAction:
        "restore core-ready/cloud-runtime-ready/external-channel-bound/user-visible-observed wording",
    }),
    checkTerms({
      id: "cloud_migration_keeps_single_local_core",
      owner: "AGENTS.md + README.md + ops/local-brain/README.md",
      file: "cloud_migration_docs",
      requiredTerms: [
        "local LCX core -> cloud-runtime-ready -> external-channel-bound -> user-visible-observed",
        "one LCX Agent core",
        "supported-region control machine",
        "canonical repo",
        "canonical `~/.openclaw` state",
        "not a second live",
        "not a second runtime truth source",
        "External, WeChat, SMS",
      ],
      summary:
        "cloud migration must keep one local system/factory and one canonical repository; local isolation uses linked worktrees",
      text: `${agents}\n${readme}\n${runbook}`,
      nextAction:
        "restore cloud-runtime-ready wording and the single-core/source-of-truth boundary",
    }),
    checkTerms({
      id: "binding_owner_is_canonical",
      owner: "scripts/operator/lcx-external-channel-binding.ts",
      file: "scripts/operator/lcx-external-channel-binding.ts",
      requiredTerms: [
        "local_external_channel_binding_operator_only",
        "channel_runtime_probe_ok_user_visible_pending",
        "userVisibleObserved",
        "legacyLiveCompatibility",
      ],
      summary: "External channel binding must be owned by the external-channel binding owner",
      text: bindingOwner,
    }),
    checkTerms({
      id: "legacy_promote_live_is_demoted",
      owner: "scripts/operator/lcx-external-channel-compat.ts",
      file: "scripts/operator/lcx-external-channel-compat.ts",
      requiredTerms: [
        "core-ready -> external-channel-bound -> user-visible-observed",
        "legacyLiveRuntimeUpdated",
        "legacyLiveUserSeen",
        "local_external_channel_status_only",
      ],
      summary: "old promote-live status must remain a legacy compatibility surface",
      text: promoteLive,
    }),
    checkTerms({
      id: "external_channel_status_wrapper_is_canonical_readonly",
      owner: "scripts/operator/lcx-external-channel-status.ts",
      file: "scripts/operator/lcx-external-channel-status.ts",
      requiredTerms: [
        "local_external_channel_status_only",
        "legacy_promote_live_status_wrapped_by_external_channel_status",
        "legacyPromoteLiveStatus",
        "canonicalWorktreeDrift",
        "repositoryDrift",
        "liveTouched: false",
      ],
      summary:
        "external-channel status must be the canonical read-only wrapper over legacy promote-live evidence",
      text: statusOwner,
    }),
    checkTerms({
      id: "commercial_acceptance_prefers_binding_owner",
      owner: "scripts/operator/lcx-commercial-acceptance-harness.ts",
      file: "scripts/operator/lcx-commercial-acceptance-harness.ts",
      requiredTerms: [
        "channel_runtime_probe_ok_user_visible_pending",
        "externalChannelBinding",
        "post_migration_external_canary_missing",
        "bindingMissingProof",
      ],
      summary: "commercial acceptance must prefer binding-owner proof over legacy commit drift",
      text: commercialAcceptance,
    }),
    checkTerms({
      id: "training_plan_exports_external_channel_action",
      owner: "scripts/operator/local-brain-training-plan.ts",
      file: "scripts/operator/local-brain-training-plan.ts",
      requiredTerms: [
        "ExternalChannelBindingPlanSnapshot",
        "externalChannelBinding",
        "local_external_channel_binding_plan_only",
        "externalChannelMissingProof",
        "external_channel_binding_ready",
        "route_external_transport_to_selected_clean_answer_path",
      ],
      summary:
        "training plan must expose external-channel readiness as the primary field without starting work",
      text: trainingPlan,
    }),
    checkTerms({
      id: "skillopt_keeps_external_channel_proof_separate",
      owner: "scripts/operator/lcx-skillopt-lite.ts",
      file: "scripts/operator/lcx-skillopt-lite.ts",
      requiredTerms: [
        "externalChannelProofPlan",
        "user-visible-observed proof",
        "external_channel_binding",
      ],
      summary: "SkillOpt can help the next answer but cannot bypass channel/user-visible proof",
      text: skillOptLite,
    }),
    checkTerms({
      id: "flow_and_mind_model_cover_external_channel",
      owner: "scripts/operator/lcx-flow-graph.ts + scripts/operator/lcx-mind-model.ts",
      file: "scripts/operator/lcx-flow-graph.ts + scripts/operator/lcx-mind-model.ts",
      requiredTerms: [
        "external_channel_binding",
        "external_channel_probe_required",
        "external_channel_boundary",
        "user-visible-observed",
      ],
      summary: "architecture exams must model channel fadeout as a first-class waterflow",
      text: `${flowGraph}\n${mindModel}`,
    }),
    checkTerms({
      id: "doctor_runs_live_fadeout_audit",
      owner: "scripts/operator/lcx-system-doctor.ts",
      file: "scripts/operator/lcx-system-doctor.ts",
      requiredTerms: [
        "live-fadeout-audit",
        "scripts/operator/lcx-live-fadeout-audit.ts",
        "externalChannelBinding",
      ],
      summary: "system doctor must include the fadeout audit in normal local checks",
      text: systemDoctor,
    }),
    checkTerms({
      id: "governance_autopilot_runs_live_fadeout_audit",
      owner: "scripts/operator/lcx-governance-autopilot.ts",
      file: "scripts/operator/lcx-governance-autopilot.ts",
      requiredTerms: [
        "liveFadeoutAudit",
        "scripts/operator/lcx-live-fadeout-audit.ts",
        "externalChannelStatus",
        "scripts/operator/lcx-external-channel-status.ts",
        "externalChannelBinding",
      ],
      summary: "governance autopilot must keep fadeout status visible to heartbeats",
      text: governanceAutopilot,
    }),
    checkTerms({
      id: "context_recovery_exposes_live_fadeout_audit",
      owner: "scripts/operator/lcx-context-recovery-exam.ts",
      file: "scripts/operator/lcx-context-recovery-exam.ts",
      requiredTerms: ["scripts/operator/lcx-live-fadeout-audit.ts --json"],
      summary: "new windows must know the fadeout audit owner exists",
      text: contextRecovery,
    }),
    {
      id: "package_scripts_prefer_external_channel_alias",
      ok:
        scripts["lcx:external-channel"] ===
          "node --import tsx scripts/operator/lcx-external-channel-binding.ts --apply --json" &&
        scripts["lcx:external-channel:status"] ===
          "node --import tsx scripts/operator/lcx-external-channel-binding.ts --json" &&
        scripts["lcx:external-channel:status-probe"] ===
          "node --import tsx scripts/operator/lcx-external-channel-status.ts --json --with-probe" &&
        scripts["lcx:external-channel:compat"] ===
          "node --import tsx scripts/operator/lcx-external-channel-compat.ts" &&
        !scripts["lcx:external-channel:legacy-status-probe"] &&
        !scripts["lcx:live"] &&
        !scripts["lcx:live:status"] &&
        !scripts["lcx:live:status:probe"] &&
        !scripts["lcx:promote-live"],
      summary:
        "package-level LCX operator aliases should expose only neutral external-channel commands",
      owner: "package.json",
      evidence: {
        "lcx:external-channel": scripts["lcx:external-channel"],
        "lcx:external-channel:status": scripts["lcx:external-channel:status"],
        "lcx:external-channel:status-probe": scripts["lcx:external-channel:status-probe"],
        "lcx:external-channel:compat": scripts["lcx:external-channel:compat"],
        removedLegacyAliases: [
          "lcx:external-channel:legacy-status-probe",
          "lcx:live",
          "lcx:live:status",
          "lcx:live:status:probe",
          "lcx:promote-live",
        ].filter((name) => scripts[name]),
      },
      nextAction: "remove old live/promote-live aliases and use external-channel commands",
    },
  ];

  const inventory = await buildLiveReferenceInventory();
  const failed = checks.filter((check) => !check.ok);
  const needsReviewCount = inventory.counts.needs_review;
  const referenceFailures =
    needsReviewCount > 0
      ? [
          `live_reference_inventory_needs_review: ${needsReviewCount} live references are outside canonical, legacy, platform, or historical classifications`,
        ]
      : [];

  return {
    ok: failed.length === 0 && referenceFailures.length === 0,
    boundary: "local_live_fadeout_audit_only",
    checkedAt: new Date().toISOString(),
    statusModel: "core-ready -> external-channel-bound -> user-visible-observed",
    repositoryModel:
      "one local LCX system/factory -> one canonical Git repository -> linked worktree",
    remoteBranchModel: "GitHub/GitLab feature branch -> review/publish",
    cloudMigrationModel:
      "local LCX core -> cloud-runtime-ready -> external-channel-bound -> user-visible-observed",
    objective:
      "fade old live wording out of LCX authority while preserving upstream live tests, historical receipts, and temporary sidecar compatibility",
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      total: checks.length,
      liveReferenceMatches: inventory.totalMatches,
      liveReferenceNeedsReview: needsReviewCount,
    },
    checks,
    liveReferenceInventory: inventory,
    actionableFailures: [
      ...failed.map((check) => `${check.id}: ${check.nextAction ?? check.summary}`),
      ...referenceFailures,
    ],
    advisoryWarnings:
      needsReviewCount > 0
        ? [
            "Some live references are outside canonical LCX owners; inspect needsReviewSamples before deleting or renaming because many upstream uses are legitimate.",
          ]
        : [],
    authorityBoundaries: {
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
      trainingStarted: false,
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

function printHuman(result: Awaited<ReturnType<typeof buildLcxLiveFadeoutAudit>>): void {
  console.log(`ok=${result.ok}`);
  console.log(`boundary=${result.boundary}`);
  console.log(`statusModel=${result.statusModel}`);
  console.log(`repositoryModel=${result.repositoryModel}`);
  console.log(`remoteBranchModel=${result.remoteBranchModel}`);
  console.log(`cloudMigrationModel=${result.cloudMigrationModel}`);
  console.log(
    `checks=${result.summary.passed}/${result.summary.total} liveReferenceNeedsReview=${result.summary.liveReferenceNeedsReview}`,
  );
  for (const failure of result.actionableFailures) {
    console.log(`failure=${failure}`);
  }
}

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-live-fadeout-audit.ts [--json]",
      "",
      "Read-only audit for fading legacy live authority into external-channel/user-visible proof.",
    ].join("\n"),
  );
}

const args = process.argv.slice(2);
if (args.some((arg) => arg === "--help" || arg === "-h")) {
  usage();
}
const json = args.includes("--json");
if (args.some((arg) => arg !== "--json")) {
  usage();
}

const result = await buildLcxLiveFadeoutAudit();
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printHuman(result);
}
if (!result.ok) {
  process.exitCode = 1;
}
