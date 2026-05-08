import fs from "node:fs/promises";
import path from "node:path";

type DoctrineCheck = {
  id: string;
  ok: boolean;
  summary: string;
  evidence?: string[];
};

const repoRoot = process.cwd();
const home = process.env.HOME ?? "";
const codexSkillsRoot = process.env.LCX_CODEX_SKILLS_ROOT ?? path.join(home, ".codex", "skills");

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-doctrine-consistency.ts [--json]",
      "",
      "Checks active LCX Agent doctrine entrypoints for drift-prone contradictions.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function linesMatching(text: string, pattern: RegExp): string[] {
  return text
    .split(/\r?\n/u)
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => pattern.test(line))
    .map(({ line, index }) => `${index}: ${line.trim()}`);
}

function checkTextContains(params: {
  id: string;
  text: string | null;
  fileLabel: string;
  required: string[];
  summary: string;
}): DoctrineCheck {
  if (params.text === null) {
    return {
      id: params.id,
      ok: false,
      summary: `${params.fileLabel} missing`,
    };
  }
  const missing = params.required.filter((needle) => !params.text?.includes(needle));
  return {
    id: params.id,
    ok: missing.length === 0,
    summary: params.summary,
    evidence: missing.map((needle) => `missing: ${needle}`),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [
    agents,
    readme,
    runbook,
    distillationDoc,
    packageRaw,
    systemDoctor,
    evalScript,
    planScript,
    baselineSkill,
    evolutionSkill,
    l5Skill,
    l4Skill,
  ] = await Promise.all([
    readOptionalText(path.join(repoRoot, "AGENTS.md")),
    readOptionalText(path.join(repoRoot, "README.md")),
    readOptionalText(path.join(repoRoot, "ops", "local-brain", "README.md")),
    readOptionalText(path.join(repoRoot, "docs", "tools", "local-brain-distillation.md")),
    readOptionalText(path.join(repoRoot, "package.json")),
    readOptionalText(path.join(repoRoot, "scripts", "dev", "lcx-system-doctor.ts")),
    readOptionalText(path.join(repoRoot, "scripts", "dev", "local-brain-distill-eval.ts")),
    readOptionalText(path.join(repoRoot, "scripts", "dev", "local-brain-plan.ts")),
    readOptionalText(path.join(codexSkillsRoot, "lcx-baseline-hardening", "SKILL.md")),
    readOptionalText(path.join(codexSkillsRoot, "lcx-evolution-loop", "SKILL.md")),
    readOptionalText(path.join(codexSkillsRoot, "l5-regression-batterer", "SKILL.md")),
    readOptionalText(path.join(codexSkillsRoot, "l4-regression-batterer", "SKILL.md")),
  ]);

  const activeDocs = [
    ["AGENTS.md", agents],
    ["README.md", readme],
    ["ops/local-brain/README.md", runbook],
    ["docs/tools/local-brain-distillation.md", distillationDoc],
  ] as const;
  const activeCode = [
    ["scripts/dev/local-brain-distill-eval.ts", evalScript],
    ["scripts/dev/local-brain-plan.ts", planScript],
    ["scripts/dev/lcx-system-doctor.ts", systemDoctor],
  ] as const;

  const checks: DoctrineCheck[] = [];

  checks.push(
    checkTextContains({
      id: "l5_skill_primary",
      text: [agents, runbook, evolutionSkill, l5Skill].filter(Boolean).join("\n"),
      fileLabel: "L5 skill entrypoints",
      required: ["l5-regression-batterer", "L5 baseline"],
      summary: "new work should see L5 baseline pressure as the primary regression skill",
    }),
  );

  checks.push(
    checkTextContains({
      id: "l4_legacy_alias_only",
      text: [agents, runbook, evolutionSkill, l4Skill].filter(Boolean).join("\n"),
      fileLabel: "L4 alias entrypoints",
      required: ["legacy compatibility alias", "Prefer the L5 skill"],
      summary: "legacy L4 path must be described as compatibility only",
    }),
  );

  checks.push(
    checkTextContains({
      id: "baseline_failure_family_not_tiny_patch",
      text: [agents, readme, baselineSkill].filter(Boolean).join("\n"),
      fileLabel: "baseline doctrine",
      required: ["failure family", "smallest coherent system upgrade", "over a tiny symptom patch"],
      summary: "baseline hardening should repair shared failure families, not isolated symptoms",
    }),
  );

  checks.push(
    checkTextContains({
      id: "prior_work_reuse_required",
      text: [agents, readme, runbook, baselineSkill].filter(Boolean).join("\n"),
      fileLabel: "reuse doctrine",
      required: ["check whether", "similar mechanism", "Reuse, merge, or extend"],
      summary: "new mechanisms should require prior-work search before adding another path",
    }),
  );

  checks.push(
    checkTextContains({
      id: "current_adapter_selector_required",
      text: [readme, runbook, distillationDoc, evalScript, planScript].filter(Boolean).join("\n"),
      fileLabel: "current adapter entrypoints",
      required: ["latest-passing", "--resolve-current-adapter", "adapterSelectionStatus"],
      summary: "local brain planning/eval should resolve the current adapter through the guard",
    }),
  );

  const staleAdapterMatches = [...activeDocs, ...activeCode].flatMap(([file, text]) =>
    text
      ? linesMatching(
          text,
          /thought-flow-v1-qwen3-0\.6b-taxonomy-v3|local-brain-distill-eval\.ts --summary-only --json/u,
        ).map((line) => `${file}:${line}`)
      : [],
  );
  checks.push({
    id: "no_stale_adapter_or_invalid_eval_command",
    ok: staleAdapterMatches.length === 0,
    summary: "active entrypoints must not advertise stale adapters or invalid eval commands",
    evidence: staleAdapterMatches,
  });

  const allowedL4Line = /l4-regression-batterer|legacy compatibility alias|legacy-path L5/u;
  const l4StageMatches = [...activeDocs, ...activeCode].flatMap(([file, text]) =>
    text
      ? linesMatching(text, /\bL4\b|\bl4\b|\bL3\b|\bl3\b/u)
          .filter((line) => !allowedL4Line.test(line))
          .map((line) => `${file}:${line}`)
      : [],
  );
  checks.push({
    id: "no_active_l3_l4_stage_language",
    ok: l4StageMatches.length === 0,
    summary: "active LCX doctrine and dev entrypoints should not describe the system as L3/L4",
    evidence: l4StageMatches,
  });

  let packageMetadataOk = false;
  const packageEvidence: string[] = [];
  if (packageRaw === null) {
    packageEvidence.push("package.json missing");
  } else {
    const packageJson = JSON.parse(packageRaw) as {
      description?: string;
      homepage?: string;
      bugs?: { url?: string };
      repository?: { url?: string };
      keywords?: string[];
    };
    packageMetadataOk =
      packageJson.description?.includes("LCX Agent") === true &&
      packageJson.repository?.url?.includes("lcx1215/lcx-s-agent") === true &&
      packageJson.homepage?.includes("lcx1215/lcx-s-agent") === true &&
      packageJson.bugs?.url?.includes("lcx1215/lcx-s-agent") === true &&
      packageJson.keywords?.includes("lcx-agent") === true;
    if (!packageMetadataOk) {
      packageEvidence.push("package metadata no longer points at LCX Agent repo identity");
    }
  }
  checks.push({
    id: "package_identity_lcx",
    ok: packageMetadataOk,
    summary: "package metadata should present LCX Agent identity, not upstream repo identity",
    evidence: packageEvidence,
  });

  const l5ScriptPath = path.join(
    codexSkillsRoot,
    "l5-regression-batterer",
    "scripts",
    "l5-regression-batterer.sh",
  );
  const l5ScriptInstalled = (await exists(l5ScriptPath)) && l5Skill !== null;
  checks.push({
    id: "l5_skill_script_installed",
    ok: l5ScriptInstalled,
    summary: "local Codex L5 regression skill should be installed for future windows",
    evidence: l5ScriptInstalled ? [] : [`missing: ${l5ScriptPath}`],
  });

  const failed = checks.filter((check) => !check.ok);
  const result = {
    ok: failed.length === 0,
    boundary: "dev_doctrine_consistency_only",
    checkedAt: new Date().toISOString(),
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      total: checks.length,
    },
    checks,
    actionableFailures: failed.map((check) => `${check.id}: ${check.summary}`),
  };

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx doctrine consistency ${result.ok ? "ok" : "failed"}`,
          `passed=${result.summary.passed} failed=${result.summary.failed} total=${result.summary.total}`,
          ...failed.map((check) => `- ${check.id}: ${check.summary}`),
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

await main();
