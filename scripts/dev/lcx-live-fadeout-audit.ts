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

const CANONICAL_TERMS = [
  "dev-ready",
  "external-channel-bound",
  "user-visible-observed",
  "legacy-live-runtime-updated",
  "legacy-live-user-seen",
  "legacy-live-visible-fixed",
] as const;

const CRITICAL_OWNER_FILES = [
  "scripts/dev/lcx-external-channel-binding.ts",
  "scripts/dev/lcx-external-channel-status.ts",
  "scripts/dev/lcx-promote-live.ts",
  "scripts/dev/lcx-commercial-acceptance-harness.ts",
  "scripts/dev/local-brain-training-plan.ts",
  "scripts/dev/lcx-governance-autopilot.ts",
  "scripts/dev/lcx-system-doctor.ts",
  "scripts/dev/lcx-context-recovery-exam.ts",
  "scripts/dev/lcx-flow-graph.ts",
  "scripts/dev/lcx-mind-model.ts",
  "scripts/dev/lcx-skillopt-lite.ts",
  "scripts/dev/lcx-monotonic-data-ledger.ts",
  "scripts/dev/lcx-live-fadeout-audit.ts",
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
    file.startsWith("scripts/dev/live-sidecar") ||
    file.startsWith("test/live-sidecar") ||
    (file.startsWith("scripts/dev/") &&
      !CRITICAL_OWNER_FILES.includes(file as (typeof CRITICAL_OWNER_FILES)[number])) ||
    file === "scripts/dev/lcx-promote-live.ts" ||
    file === "test/lcx-promote-live-status.test.ts"
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
    file.startsWith("ops/live-handoff/") ||
    file.startsWith("ops/dev-full-loop-acceptance/") ||
    (file.startsWith("ops/") && file !== "ops/local-brain/README.md")
  ) {
    return "historical_ops_receipt";
  }
  if (
    file.startsWith("extensions/feishu/") ||
    file.startsWith("src/agents/tools/feishu-live-probe") ||
    file.startsWith("src/commands/capabilities/lark-loop-diagnose")
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
        "(^|[^[:alpha:]])live([^[:alpha:]]|$)|LiveLark|LIVE_TEST|liveUserSeen|liveRuntime|live-visible|live-user-seen|live_lark|live_sidecar|live_sender",
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
  ] = await Promise.all([
    readText("AGENTS.md"),
    readText("README.md"),
    readText("ops/local-brain/README.md"),
    readText("package.json"),
    readText("scripts/dev/lcx-external-channel-binding.ts"),
    readText("scripts/dev/lcx-external-channel-status.ts"),
    readText("scripts/dev/lcx-promote-live.ts"),
    readText("scripts/dev/lcx-commercial-acceptance-harness.ts"),
    readText("scripts/dev/local-brain-training-plan.ts"),
    readText("scripts/dev/lcx-governance-autopilot.ts"),
    readText("scripts/dev/lcx-system-doctor.ts"),
    readText("scripts/dev/lcx-context-recovery-exam.ts"),
    readText("scripts/dev/lcx-flow-graph.ts"),
    readText("scripts/dev/lcx-mind-model.ts"),
    readText("scripts/dev/lcx-skillopt-lite.ts"),
  ]);

  const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};

  const checks: FeatureCheck[] = [
    checkTerms({
      id: "doctrine_uses_forward_status_model",
      owner: "AGENTS.md + README.md + ops/local-brain/README.md",
      file: "doctrine_docs",
      requiredTerms: CANONICAL_TERMS,
      summary: "doctrine documents must teach future agents the new status model",
      text: `${agents}\n${readme}\n${runbook}`,
      nextAction: "restore dev-ready/external-channel-bound/user-visible-observed wording",
    }),
    checkTerms({
      id: "binding_owner_is_canonical",
      owner: "scripts/dev/lcx-external-channel-binding.ts",
      file: "scripts/dev/lcx-external-channel-binding.ts",
      requiredTerms: [
        "dev_external_channel_binding_operator_only",
        "channel_runtime_probe_ok_user_visible_pending",
        "userVisibleObserved",
        "legacyLiveCompatibility",
      ],
      summary: "Lark channel binding must be owned by the external-channel binding owner",
      text: bindingOwner,
    }),
    checkTerms({
      id: "legacy_promote_live_is_demoted",
      owner: "scripts/dev/lcx-promote-live.ts",
      file: "scripts/dev/lcx-promote-live.ts",
      requiredTerms: [
        "dev-ready -> external-channel-bound -> user-visible-observed",
        "legacyLiveRuntimeUpdated",
        "legacyLiveUserSeen",
        "dev_external_channel_status_only",
      ],
      summary: "old promote-live status must remain a legacy compatibility surface",
      text: promoteLive,
    }),
    checkTerms({
      id: "external_channel_status_wrapper_is_canonical_readonly",
      owner: "scripts/dev/lcx-external-channel-status.ts",
      file: "scripts/dev/lcx-external-channel-status.ts",
      requiredTerms: [
        "dev_external_channel_status_only",
        "legacy_promote_live_status_wrapped_by_external_channel_status",
        "legacyPromoteLiveStatus",
        "liveTouched: false",
      ],
      summary:
        "external-channel status must be the canonical read-only wrapper over legacy promote-live evidence",
      text: statusOwner,
    }),
    checkTerms({
      id: "commercial_acceptance_prefers_binding_owner",
      owner: "scripts/dev/lcx-commercial-acceptance-harness.ts",
      file: "scripts/dev/lcx-commercial-acceptance-harness.ts",
      requiredTerms: [
        "channel_runtime_probe_ok_user_visible_pending",
        "externalChannelBinding",
        "post_migration_lark_canary_missing",
        "bindingMissingProof",
      ],
      summary: "commercial acceptance must prefer binding-owner proof over legacy commit drift",
      text: commercialAcceptance,
    }),
    checkTerms({
      id: "training_plan_exports_external_channel_action",
      owner: "scripts/dev/local-brain-training-plan.ts",
      file: "scripts/dev/local-brain-training-plan.ts",
      requiredTerms: [
        "ExternalChannelBindingPlanSnapshot",
        "externalChannelBinding",
        "dev_external_channel_binding_plan_only",
        "externalChannelMissingProof",
        "lark_external_channel_binding_ready",
        "bind_lark_external_channel_to_selected_clean_brain",
      ],
      summary:
        "training plan must expose external-channel readiness as the primary field without starting work",
      text: trainingPlan,
    }),
    checkTerms({
      id: "skillopt_keeps_external_channel_proof_separate",
      owner: "scripts/dev/lcx-skillopt-lite.ts",
      file: "scripts/dev/lcx-skillopt-lite.ts",
      requiredTerms: [
        "externalChannelProofPlan",
        "user-visible-observed proof",
        "lark_external_channel_binding",
      ],
      summary: "SkillOpt can help the next answer but cannot bypass channel/user-visible proof",
      text: skillOptLite,
    }),
    checkTerms({
      id: "flow_and_mind_model_cover_external_channel",
      owner: "scripts/dev/lcx-flow-graph.ts + scripts/dev/lcx-mind-model.ts",
      file: "scripts/dev/lcx-flow-graph.ts + scripts/dev/lcx-mind-model.ts",
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
      owner: "scripts/dev/lcx-system-doctor.ts",
      file: "scripts/dev/lcx-system-doctor.ts",
      requiredTerms: [
        "live-fadeout-audit",
        "scripts/dev/lcx-live-fadeout-audit.ts",
        "externalChannelBinding",
      ],
      summary: "system doctor must include the fadeout audit in normal dev checks",
      text: systemDoctor,
    }),
    checkTerms({
      id: "governance_autopilot_runs_live_fadeout_audit",
      owner: "scripts/dev/lcx-governance-autopilot.ts",
      file: "scripts/dev/lcx-governance-autopilot.ts",
      requiredTerms: [
        "liveFadeoutAudit",
        "scripts/dev/lcx-live-fadeout-audit.ts",
        "externalChannelStatus",
        "scripts/dev/lcx-external-channel-status.ts",
        "externalChannelBinding",
      ],
      summary: "governance autopilot must keep fadeout status visible to heartbeats",
      text: governanceAutopilot,
    }),
    checkTerms({
      id: "context_recovery_exposes_live_fadeout_audit",
      owner: "scripts/dev/lcx-context-recovery-exam.ts",
      file: "scripts/dev/lcx-context-recovery-exam.ts",
      requiredTerms: ["scripts/dev/lcx-live-fadeout-audit.ts --json"],
      summary: "new windows must know the fadeout audit owner exists",
      text: contextRecovery,
    }),
    {
      id: "package_scripts_prefer_external_channel_alias",
      ok:
        scripts["lcx:external-channel"] ===
          "node --import tsx scripts/dev/lcx-external-channel-binding.ts --apply --json" &&
        scripts["lcx:external-channel:status"] ===
          "node --import tsx scripts/dev/lcx-external-channel-binding.ts --json" &&
        scripts["lcx:external-channel:status-probe"] ===
          "node --import tsx scripts/dev/lcx-external-channel-status.ts --json --with-probe" &&
        scripts["lcx:live"] === "pnpm lcx:external-channel" &&
        scripts["lcx:live:status"] === "pnpm lcx:external-channel:status" &&
        scripts["lcx:live:status:probe"] === "pnpm lcx:external-channel:status-probe" &&
        scripts["lcx:promote-live"] === "node --import tsx scripts/dev/lcx-promote-live.ts",
      summary: "package-level LCX operator aliases should route through external-channel first",
      owner: "package.json",
      evidence: {
        "lcx:external-channel": scripts["lcx:external-channel"],
        "lcx:external-channel:status": scripts["lcx:external-channel:status"],
        "lcx:external-channel:status-probe": scripts["lcx:external-channel:status-probe"],
        "lcx:live": scripts["lcx:live"],
        "lcx:live:status": scripts["lcx:live:status"],
        "lcx:live:status:probe": scripts["lcx:live:status:probe"],
        "lcx:promote-live": scripts["lcx:promote-live"],
      },
      nextAction: "add external-channel scripts and make old lcx:live aliases forward to them",
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
    boundary: "dev_live_fadeout_audit_only",
    checkedAt: new Date().toISOString(),
    statusModel: "dev-ready -> external-channel-bound -> user-visible-observed",
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
      "Usage: node --import tsx scripts/dev/lcx-live-fadeout-audit.ts [--json]",
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
