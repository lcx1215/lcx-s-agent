import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;

type SkillEntry = {
  name: string;
  declaredName?: string;
  skillPath: string;
  sha256: string;
  sideEffectClasses: string[];
  manifestStatus?: string;
  primaryMatch: boolean;
};

type AuditOptions = {
  primaryRoot?: string;
  compatibilityRoot?: string;
  manifestPath: string;
  json: boolean;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, "ops", "compatibility", "codex-skills.json");

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-compat-skill-audit.ts --primary-root PATH --compatibility-root PATH [--json]",
      "",
      "Read-only audit for regular Skill copies outside the primary Skill root.",
      "Roots must be supplied by the current runtime profile or environment; this owner does not guess a home directory.",
      "",
      "Options:",
      "  --primary-root PATH        canonical Skill root",
      "  --compatibility-root PATH compatibility Skill root",
      "  --manifest PATH           default ops/compatibility/codex-skills.json",
      "  --json                    emit JSON",
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

function parseArgs(args: string[]): AuditOptions {
  const options: AuditOptions = {
    primaryRoot: process.env.LCX_PRIMARY_SKILL_ROOT,
    compatibilityRoot: process.env.LCX_COMPATIBILITY_SKILL_ROOT,
    manifestPath: DEFAULT_MANIFEST_PATH,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--primary-root") {
      options.primaryRoot = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--compatibility-root") {
      options.compatibilityRoot = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--manifest") {
      options.manifestPath = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function readJson(filePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonRecord;
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function declaredName(skillPath: string): string | undefined {
  const content = fs.readFileSync(skillPath, "utf8");
  const match = /^name:\s*(\S.*?)\s*$/mu.exec(content);
  return match?.[1];
}

function sideEffectClasses(content: string): string[] {
  const classes = new Set<string>();
  if (/\b(send|publish|push|webhook|notify|message|release)\b/iu.test(content)) {
    classes.add("external-write-or-publish");
  }
  if (/\b(rm|delete|remove|kill|overwrite|reset|--force|unlink)\b/iu.test(content)) {
    classes.add("destructive-or-overwriting");
  }
  if (/\b(install|download|curl|npm|pnpm|pip|brew|fetch)\b/iu.test(content)) {
    classes.add("install-or-network");
  }
  if (/\b(branch|worktree|tmux|agent|delegate|parallel|orchestrat)\b/iu.test(content)) {
    classes.add("orchestration-or-git");
  }
  if (classes.size === 0) {
    classes.add("read-only-or-unknown");
  }
  return [...classes].toSorted();
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function regularSkillDirs(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "SKILL.md")))
    .toSorted();
}

function allSkillNames(root: string): Set<string> {
  if (!fs.existsSync(root)) {
    return new Set();
  }
  return new Set(
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name),
  );
}

function manifestEntries(manifestPath: string): Map<string, string | undefined> {
  const manifest = readJson(manifestPath);
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  return new Map(
    entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const record = entry as JsonRecord;
      return typeof record.name === "string"
        ? [[record.name, typeof record.status === "string" ? record.status : undefined]]
        : [];
    }),
  );
}

export function auditCompatibilitySkills(options: AuditOptions): JsonRecord {
  const primaryRoot = options.primaryRoot?.trim();
  const compatibilityRoot = options.compatibilityRoot?.trim();
  const blocked = [
    !primaryRoot ? "primary_skill_root_unresolved" : undefined,
    !compatibilityRoot ? "compatibility_skill_root_unresolved" : undefined,
    primaryRoot && !fs.existsSync(primaryRoot) ? "primary_skill_root_missing" : undefined,
    compatibilityRoot && !fs.existsSync(compatibilityRoot)
      ? "compatibility_skill_root_missing"
      : undefined,
  ].filter((value): value is string => Boolean(value));
  if (blocked.length > 0) {
    return {
      ok: false,
      boundary: "compatibility_skill_registry_only",
      authority: "repo_manifest_is_not_runtime_registration",
      blocked,
      primaryRoot,
      compatibilityRoot,
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
  }

  const manifest = manifestEntries(options.manifestPath);
  const primaryNames = allSkillNames(primaryRoot);
  const entries: SkillEntry[] = regularSkillDirs(compatibilityRoot).map((dir) => {
    const name = path.basename(dir);
    const skillPath = path.join(dir, "SKILL.md");
    const content = fs.readFileSync(skillPath, "utf8");
    return {
      name,
      declaredName: declaredName(skillPath),
      skillPath,
      sha256: sha256(skillPath),
      sideEffectClasses: sideEffectClasses(content),
      manifestStatus: manifest.get(name),
      primaryMatch: primaryNames.has(name),
    };
  });
  const currentNames = new Set(entries.map((entry) => entry.name));
  const missingManifestNames = [...currentNames].filter((name) => !manifest.has(name)).toSorted();
  const unexpectedManifestNames = [...manifest.keys()]
    .filter((name) => !currentNames.has(name))
    .toSorted();
  const declarationMismatches = entries
    .filter((entry) => entry.declaredName !== entry.name)
    .map((entry) => ({ name: entry.name, declaredName: entry.declaredName }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const primaryCollisions = entries
    .filter((entry) => entry.primaryMatch)
    .map((entry) => entry.name)
    .toSorted();
  const reviewRequiredCount = entries.filter(
    (entry) => !entry.sideEffectClasses.includes("read-only-or-unknown"),
  ).length;
  return {
    ok:
      missingManifestNames.length === 0 &&
      unexpectedManifestNames.length === 0 &&
      declarationMismatches.length === 0 &&
      primaryCollisions.length === 0,
    boundary: "compatibility_skill_registry_only",
    authority: "repo_manifest_is_not_runtime_registration",
    policy: "regular_copies_are_compatibility_only_until_individually_rehomed_or_retired",
    primaryRoot,
    compatibilityRoot,
    primarySkillNameCount: primaryNames.size,
    regularCompatibilityCopyCount: entries.length,
    reviewRequiredCount,
    manifestEntryCount: manifest.size,
    missingManifestNames,
    unexpectedManifestNames,
    declarationMismatches,
    primaryCollisions,
    entries,
    nextSafeStep:
      reviewRequiredCount > 0
        ? "review the listed side-effect classes before any exact migration or retirement decision"
        : "keep the registry check in the runtime maintenance path",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

function renderText(audit: JsonRecord): string {
  return (
    [
      `compatibility_skill_audit=${audit.ok === true ? "ok" : "blocked"}`,
      `regularCompatibilityCopyCount=${numberValue(audit.regularCompatibilityCopyCount) ?? 0}`,
      `manifestEntryCount=${numberValue(audit.manifestEntryCount) ?? 0}`,
      `reviewRequiredCount=${numberValue(audit.reviewRequiredCount) ?? 0}`,
      `missingManifestNames=${Array.isArray(audit.missingManifestNames) ? audit.missingManifestNames.join(",") || "none" : "unknown"}`,
      `primaryCollisions=${Array.isArray(audit.primaryCollisions) ? audit.primaryCollisions.join(",") || "none" : "unknown"}`,
      `nextSafeStep=${typeof audit.nextSafeStep === "string" ? audit.nextSafeStep : "resolve blocked inputs"}`,
    ].join("\n") + "\n"
  );
}

export function main(argv = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  const audit = auditCompatibilitySkills(options);
  process.stdout.write(options.json ? `${JSON.stringify(audit, null, 2)}\n` : renderText(audit));
  return audit.ok === true ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
