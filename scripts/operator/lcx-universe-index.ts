import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_WORKSPACE_DIR,
  DEFAULT_WORKSPACE_LOG_DIR,
  LCX_USER_HOME,
  UNIVERSE_INDEX_LATEST_PATH,
} from "./lcx-local-paths.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const STALE_ARTIFACT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LARGE_ARTIFACT_BYTES = 50 * 1024 * 1024;
const EXTERNAL_CHANNEL_RUNTIME_ROOT = path.join(
  LCX_USER_HOME,
  ".openclaw",
  "external-channel-runtime",
  "lcx-s-openclaw",
);

type ArtifactFile = {
  path: string;
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  ageMs: number;
};

type ArtifactInventory = {
  path: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  largestFiles: ArtifactFile[];
  staleFiles: ArtifactFile[];
  skippedDirs: string[];
};

type Options = {
  json: boolean;
  write: boolean;
};

type ExecLinesResult = {
  ok: boolean;
  lines: string[];
  error?: string;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-universe-index.ts [--json] [--no-write]",
      "",
      "Builds the read-only LCX universe index: repo files, dirty state, runtime",
      "artifacts, live sidecar inventory, owner coverage, and garbage candidates.",
      "It may write only lcx-universe-index-latest.json unless --no-write is used.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): Options {
  const options: Options = { json: false, write: true };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-write") {
      options.write = false;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

async function execLines(
  command: string,
  args: string[],
  cwd = repoRoot,
  trimLines = true,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return stdout
      .split("\n")
      .map((line) => (trimLines ? line.trim() : line))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function execLinesWithStatus(
  command: string,
  args: string[],
  cwd = repoRoot,
  trimLines = true,
): Promise<ExecLinesResult> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return {
      ok: true,
      lines: stdout
        .split("\n")
        .map((line) => (trimLines ? line.trim() : line))
        .filter(Boolean),
    };
  } catch (error) {
    return { ok: false, lines: [], error: String(error) };
  }
}

function topLevel(file: string): string {
  return file.split("/")[0] || ".";
}

function countByTopLevel(files: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = topLevel(file);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
}

function parseGitStatus(lines: readonly string[]) {
  const branch = lines.find((line) => line.startsWith("##")) ?? "";
  const entries = lines
    .filter((line) => !line.startsWith("##"))
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const filePath = rawPath.includes(" -> ")
        ? (rawPath.split(" -> ").at(-1) ?? rawPath)
        : rawPath;
      return { status, path: filePath };
    });
  return {
    branch,
    entries,
    changedFiles: entries.map((entry) => entry.path),
    untrackedFiles: entries.filter((entry) => entry.status === "??").map((entry) => entry.path),
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type GovernanceComponentDisposition = "governed_source" | "inventory_only";

type GovernanceComponentRule = {
  id: string;
  patterns: RegExp[];
  category: string;
  routeOwner: string;
  proofSurface: string;
  boundary: string;
  disposition: GovernanceComponentDisposition;
};

type GovernanceComponent = {
  path: string;
  category: string;
  inventoryOwner: "lcx-universe-index";
  routeOwner: string | null;
  proofSurface: string;
  boundary: string;
  disposition: GovernanceComponentDisposition | "review_required";
};

type GovernanceInventoryArea = {
  id: string;
  path: string;
  componentCount: number;
  skippedDirs: string[];
  inventoryOwner: "lcx-universe-index";
  routeOwner: string;
  category: string;
  proofSurface: string;
  boundary: string;
  disposition: "inventory_only";
};

/**
 * Every repository-tracked-and-visible component must land in one explicit governance
 * rule. The inventory owner stays constant; route owners identify the
 * existing lane that is responsible for change/proof decisions.
 */
const GOVERNANCE_COMPONENT_RULES: GovernanceComponentRule[] = [
  {
    id: "repository_test_surface",
    patterns: [/(^|\/)[^/]+\.(?:test|spec)\.[^/]+$/u],
    category: "test",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "focused regression plus lcx-change-impact-plan",
    boundary: "test evidence does not prove runtime, training, or user-visible delivery",
    disposition: "governed_source",
  },
  {
    id: "repository_test_support",
    patterns: [/^test\//u],
    category: "test_support_and_fixture",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "focused regression plus lcx-change-impact-plan",
    boundary: "fixtures and test helpers are not production, training, or user-visible proof",
    disposition: "governed_source",
  },
  {
    id: "codex_auxiliary_surface",
    patterns: [/^\.pi\//u],
    category: "codex_auxiliary_surface",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "targeted auxiliary check plus lcx-change-impact-plan",
    boundary: "Codex auxiliary files do not become LCX runtime, provider, or delivery authority",
    disposition: "governed_source",
  },
  {
    id: "temporary_artifact_surface",
    patterns: [/^\.tmp\//u],
    category: "temporary_artifact",
    routeOwner: "scripts/operator/lcx-universe-index.ts",
    proofSurface: "lcx-universe-index plus exact artifact reference review",
    boundary: "temporary artifacts are inventory-only and never source or runtime authority",
    disposition: "inventory_only",
  },
  {
    id: "editor_configuration_surface",
    patterns: [/^\.vscode\//u],
    category: "editor_configuration",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "git diff --check plus lcx-change-impact-plan",
    boundary:
      "editor configuration does not grant runtime, provider, training, or delivery authority",
    disposition: "governed_source",
  },
  {
    id: "repository_asset_directory",
    patterns: [/^assets\//u],
    category: "repository_asset_and_auxiliary",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "asset-specific check plus lcx-change-impact-plan",
    boundary:
      "assets and bundled helpers are not LCX product, provider, or external-channel authority",
    disposition: "governed_source",
  },
  {
    id: "repository_asset_surface",
    patterns: [/\.(?:png|jpe?g|gif|webp|svg|ico|ttf|woff2?|zip|tgz|tar|mp[34]|mov|pdf)$/iu],
    category: "asset",
    routeOwner: "scripts/operator/lcx-universe-index.ts",
    proofSurface: "lcx-universe-index plus artifact-specific owner when used",
    boundary: "asset inventory is not executable authority or user-visible proof",
    disposition: "inventory_only",
  },
  {
    id: "vendored_dependency_surface",
    patterns: [/^vendor\//u],
    category: "vendored_dependency",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "vendor-specific build/check plus lcx-change-impact-plan",
    boundary:
      "vendored code is governed source inventory but cannot become product, provider, or delivery authority by presence alone",
    disposition: "governed_source",
  },
  {
    id: "src_visible_answer",
    patterns: [/^src\/auto-reply\//u],
    category: "visible_answer_control",
    routeOwner: "src/auto-reply/reply/get-reply-run.ts",
    proofSurface: "visible-answer tests plus external-channel status owner",
    boundary: "core-verified is not user-visible-observed",
    disposition: "governed_source",
  },
  {
    id: "src_shared_contract",
    patterns: [/^src\/shared\//u],
    category: "shared_contract",
    routeOwner: "src/shared/lcx-ontology.ts",
    proofSurface: "lcx-ontology, projection-reader audit, and targeted contract tests",
    boundary: "shared contracts do not become a second workflow or delivery authority",
    disposition: "governed_source",
  },
  {
    id: "src_agent_control",
    patterns: [/^src\/agents\//u],
    category: "agent_control_and_capability",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "targeted agent tests plus flow, head-tail, and system-doctor checks",
    boundary:
      "agent code cannot silently grant provider, training, protected-memory, or external-sender authority",
    disposition: "governed_source",
  },
  {
    id: "src_runtime_boundary",
    patterns: [/^src\/(?:config|daemon|gateway|infra|logging|media|process|runtime)\//u],
    category: "runtime_boundary",
    routeOwner: "scripts/operator/lcx-system-doctor.ts",
    proofSurface: "targeted runtime tests plus lcx-system-doctor",
    boundary: "runtime compatibility is not product, provider, or external-channel authority",
    disposition: "governed_source",
  },
  {
    id: "src_core_runtime",
    patterns: [/^src\//u],
    category: "core_runtime",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "targeted tests plus lcx-change-impact-plan",
    boundary: "local core proof does not prove external binding or user-visible observation",
    disposition: "governed_source",
  },
  {
    id: "operator_local_brain",
    patterns: [/^scripts\/operator\/(?:local-brain|minimax|finance-data-gateway)/u],
    category: "local_brain_implementation",
    routeOwner: "scripts/operator/local-brain-training-plan.ts",
    proofSurface: "local-brain owner checks and head-tail consistency",
    boundary:
      "optional implementation cannot redefine ontology, promotion, provider, or delivery authority",
    disposition: "governed_source",
  },
  {
    id: "operator_governance",
    patterns: [/^scripts\/operator\/lcx-/u],
    category: "operator_governance",
    routeOwner: "scripts/operator/lcx-problem-cluster-radar.ts",
    proofSurface: "owner-specific operator check plus lcx-change-impact-plan",
    boundary: "operator checks are local evidence and do not perform unrequested external effects",
    disposition: "governed_source",
  },
  {
    id: "operator_script",
    patterns: [/^scripts\/operator\//u],
    category: "operator_tooling",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "lcx-change-impact-plan plus focused script check",
    boundary: "script tooling has no authority beyond its named contract",
    disposition: "governed_source",
  },
  {
    id: "script_surface",
    patterns: [/^scripts\//u],
    category: "repository_tooling",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "lcx-change-impact-plan plus focused script check",
    boundary: "repository tooling is not automatically runtime or external authority",
    disposition: "governed_source",
  },
  {
    id: "extension_surface",
    patterns: [/^extensions\//u],
    category: "extension_runtime",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "extension-specific tests plus lcx-change-impact-plan",
    boundary: "an extension is an adapter surface, not a second brain or provider authority",
    disposition: "governed_source",
  },
  {
    id: "application_surface",
    patterns: [/^apps\//u],
    category: "application_surface",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "application-specific tests/build plus lcx-change-impact-plan",
    boundary: "application UI/control evidence is not external-channel user-visible proof",
    disposition: "governed_source",
  },
  {
    id: "ui_surface",
    patterns: [/^ui\//u],
    category: "ui_surface",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "UI-specific tests/build plus lcx-change-impact-plan",
    boundary: "UI output is not a delivery or model-authority claim",
    disposition: "governed_source",
  },
  {
    id: "ops_surface",
    patterns: [/^ops\//u],
    category: "ops_governance_and_artifact",
    routeOwner: "scripts/operator/lcx-mind-model.ts",
    proofSurface: "mind model, head-tail, doctrine, or artifact-specific owner check",
    boundary:
      "ops documentation/artifacts guide or record work; they do not silently mutate runtime",
    disposition: "governed_source",
  },
  {
    id: "documentation_surface",
    patterns: [/^(?:docs|skills)\//u],
    category: "documentation_and_instruction",
    routeOwner: "scripts/operator/lcx-doctrine-consistency.ts",
    proofSurface: "doctrine consistency, head-tail, and lcx-change-impact-plan",
    boundary:
      "documentation and skills are context/instructions, not provider or external-sender authority",
    disposition: "governed_source",
  },
  {
    id: "repository_control_surface",
    patterns: [/^(?:\.github|git-hooks)\//u],
    category: "repository_delivery_control",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "git diff --check plus delivery-specific checks",
    boundary: "repository controls do not prove runtime, training, or external delivery",
    disposition: "governed_source",
  },
  {
    id: "auxiliary_project_surface",
    patterns: [/^(?:Swabble|packages)\//u],
    category: "auxiliary_project",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "project-specific tests/build plus lcx-change-impact-plan",
    boundary: "auxiliary projects are not LCX product or runtime authority by presence alone",
    disposition: "governed_source",
  },
  {
    id: "historical_evidence_surface",
    patterns: [/^(?:audit|changelog|evals|patches)\//u],
    category: "historical_or_evaluation_artifact",
    routeOwner: "scripts/operator/lcx-universe-index.ts",
    proofSurface: "lcx-universe-index plus the owning eval/audit review",
    boundary:
      "historical/evaluation artifacts do not become current runtime or promotion proof by existence",
    disposition: "inventory_only",
  },
  {
    id: "repository_root_control",
    patterns: [/^[^/]+$/u],
    category: "repository_control_file",
    routeOwner: "scripts/operator/lcx-change-impact-plan.ts",
    proofSurface: "lcx-change-impact-plan plus git diff --check",
    boundary:
      "root metadata/config is not an unreviewed provider, training, or external-channel mutation",
    disposition: "governed_source",
  },
];

function governanceRuleFor(file: string): GovernanceComponentRule | undefined {
  return GOVERNANCE_COMPONENT_RULES.find((rule) =>
    rule.patterns.some((pattern) => pattern.test(file)),
  );
}

function buildRepoGovernanceCoverage(
  files: readonly string[],
  inventoryAreas: readonly GovernanceInventoryArea[],
) {
  const components: GovernanceComponent[] = files.toSorted().map((file) => {
    const rule = governanceRuleFor(file);
    if (!rule) {
      return {
        path: file,
        category: "unknown",
        inventoryOwner: "lcx-universe-index" as const,
        routeOwner: null,
        proofSurface: "none; route required before change",
        boundary: "unknown component must block governance completion",
        disposition: "review_required" as const,
      };
    }
    return {
      path: file,
      category: rule.category,
      inventoryOwner: "lcx-universe-index" as const,
      routeOwner: rule.routeOwner,
      proofSurface: rule.proofSurface,
      boundary: rule.boundary,
      disposition: rule.disposition,
    };
  });
  const unknownComponents = components
    .filter((component) => component.disposition === "review_required")
    .map((component) => component.path);
  const governedComponents = components.filter(
    (component) => component.disposition === "governed_source",
  ).length;
  const inventoryOnlyComponents = components.filter(
    (component) => component.disposition === "inventory_only",
  ).length;
  const byCategory = components.reduce<Record<string, number>>((counts, component) => {
    counts[component.category] = (counts[component.category] ?? 0) + 1;
    return counts;
  }, {});
  const byRouteOwner = components.reduce<Record<string, number>>((counts, component) => {
    const owner = component.routeOwner ?? "unknown";
    counts[owner] = (counts[owner] ?? 0) + 1;
    return counts;
  }, {});
  return {
    schemaVersion: "lcx_component_governance_v1",
    scope: "repo_tracked_and_visible_files",
    inventoryOwner: "lcx-universe-index",
    status: unknownComponents.length === 0 ? "complete" : "incomplete",
    summary: {
      totalComponents: components.length,
      governedComponents,
      inventoryOnlyComponents,
      reviewRequiredComponents: unknownComponents.length,
      coverageRate:
        components.length === 0
          ? 1
          : (components.length - unknownComponents.length) / components.length,
      inventoryAreaCount: inventoryAreas.length,
      inventoryAreaComponentCount: inventoryAreas.reduce(
        (sum, area) => sum + area.componentCount,
        0,
      ),
    },
    byCategory: Object.fromEntries(
      Object.entries(byCategory).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    byRouteOwner: Object.fromEntries(
      Object.entries(byRouteOwner).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    unknownComponents,
    components,
    inventoryAreas,
  };
}

function buildGovernanceInventoryAreas(
  entries: readonly {
    id: string;
    inventory: ArtifactInventory;
    routeOwner: string;
    category: string;
    proofSurface: string;
    boundary: string;
  }[],
): GovernanceInventoryArea[] {
  return entries.map(({ id, inventory, routeOwner, category, proofSurface, boundary }) => ({
    id,
    path: inventory.path,
    componentCount: inventory.fileCount,
    skippedDirs: inventory.skippedDirs,
    inventoryOwner: "lcx-universe-index",
    routeOwner,
    category,
    proofSurface,
    boundary,
    disposition: "inventory_only",
  }));
}

async function changeImpactCoverage(files: readonly string[]) {
  if (files.length === 0) {
    return {
      ok: true,
      affectedLanes: [],
      unmatchedFiles: [],
      recommendedFastCommands: [],
      deferredCommands: [],
      source: "no_changed_files",
    };
  }
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/lcx-change-impact-plan.ts",
        "--json",
        "--files",
        ...files,
      ],
      {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    return {
      ok: payload.ok === true,
      affectedLanes: payload.affectedLanes ?? [],
      unmatchedFiles: payload.unmatchedFiles ?? [],
      strayGate: payload.strayGate ?? {
        ok: payload.ok === true && arrayValue(payload.unmatchedFiles).length === 0,
        unmatchedChangedFiles: payload.unmatchedFiles ?? [],
      },
      recommendedFastCommands: payload.recommendedFastCommands ?? [],
      deferredCommands: payload.deferredCommands ?? [],
      source: "lcx-change-impact-plan",
    };
  } catch (error) {
    return {
      ok: false,
      affectedLanes: [],
      unmatchedFiles: files,
      recommendedFastCommands: [],
      deferredCommands: [],
      source: "lcx-change-impact-plan_failed",
      error: String(error),
    };
  }
}

async function walkArtifacts(root: string, nowMs: number): Promise<ArtifactInventory> {
  const skippedDirs: string[] = [];
  const files: ArtifactFile[] = [];
  async function walk(current: string) {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          ["node_modules", ".git", ".venv", "__pycache__", "dist", ".next"].includes(entry.name)
        ) {
          skippedDirs.push(path.relative(root, absolutePath) || entry.name);
          continue;
        }
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(absolutePath).catch(() => undefined);
      if (!stat) {
        continue;
      }
      files.push({
        path: absolutePath,
        relativePath: path.relative(root, absolutePath),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ageMs: Math.max(0, nowMs - stat.mtimeMs),
      });
    }
  }

  const exists = await fs
    .access(root)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return {
      path: root,
      exists: false,
      fileCount: 0,
      totalBytes: 0,
      largestFiles: [],
      staleFiles: [],
      skippedDirs,
    };
  }
  await walk(root);
  return {
    path: root,
    exists: true,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    largestFiles: files.toSorted((a, b) => b.bytes - a.bytes).slice(0, 12),
    staleFiles: files
      .filter((file) => file.ageMs > STALE_ARTIFACT_AGE_MS)
      .toSorted((a, b) => b.ageMs - a.ageMs)
      .slice(0, 20),
    skippedDirs,
  };
}

function staleLatestSnapshot(latest: Record<string, unknown> | undefined, maxAgeMs: number) {
  const checkedAt =
    typeof latest?.checkedAt === "string" ? Date.parse(latest.checkedAt) : undefined;
  if (checkedAt === undefined || Number.isNaN(checkedAt)) {
    return { stale: true, checkedAt: latest?.checkedAt, ageMs: undefined };
  }
  const ageMs = Date.now() - checkedAt;
  return { stale: ageMs < 0 || ageMs > maxAgeMs, checkedAt: latest?.checkedAt, ageMs };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();
  const [trackedInventory, rgFilesRaw, gitStatusLines] = await Promise.all([
    execLinesWithStatus("git", ["ls-files"]),
    execLines("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules"]),
    execLines("git", ["status", "--short", "--branch"], repoRoot, false),
  ]);
  const trackedFiles = trackedInventory.lines;
  const rgFiles = rgFilesRaw.length > 0 ? rgFilesRaw : trackedFiles;
  const repoComponentFiles = [...new Set([...trackedFiles, ...rgFiles])].toSorted();
  const gitStatus = parseGitStatus(gitStatusLines);
  const [
    changeImpact,
    workspaceState,
    workspaceLogs,
    workspaceMemory,
    workspaceTmp,
    liveSidecar,
    latestGovernance,
    latestOperator,
  ] = await Promise.all([
    changeImpactCoverage(gitStatus.changedFiles),
    walkArtifacts(path.join(DEFAULT_WORKSPACE_DIR, "state"), nowMs),
    walkArtifacts(DEFAULT_WORKSPACE_LOG_DIR, nowMs),
    walkArtifacts(path.join(DEFAULT_WORKSPACE_DIR, "memory"), nowMs),
    walkArtifacts(path.join(DEFAULT_WORKSPACE_DIR, "tmp"), nowMs),
    walkArtifacts(EXTERNAL_CHANNEL_RUNTIME_ROOT, nowMs),
    readJson(path.join(DEFAULT_WORKSPACE_DIR, "state", "lcx-governance-autopilot-latest.json")),
    readJson(path.join(DEFAULT_WORKSPACE_DIR, "state", "lcx-local-operator-latest.json")),
  ]);

  const staleSnapshots = [
    {
      id: "lcx-governance-autopilot-latest",
      ...staleLatestSnapshot(latestGovernance, 2 * 60 * 60 * 1000),
    },
    {
      id: "lcx-local-operator-latest",
      ...staleLatestSnapshot(latestOperator, 2 * 60 * 60 * 1000),
    },
  ].filter((snapshot) => snapshot.stale);
  const artifactInventories = [workspaceState, workspaceLogs, workspaceMemory, workspaceTmp];
  const largeRuntimeFiles = artifactInventories.flatMap((inventory) =>
    inventory.largestFiles
      .filter((file) => file.bytes >= LARGE_ARTIFACT_BYTES)
      .map((file) => ({ area: inventory.path, ...file })),
  );
  const staleRuntimeFiles = artifactInventories.flatMap((inventory) =>
    inventory.staleFiles.map((file) => ({ area: inventory.path, ...file })),
  );
  const governanceInventoryAreas = buildGovernanceInventoryAreas([
    {
      id: "workspace_state",
      inventory: workspaceState,
      routeOwner: "scripts/operator/lcx-universe-index.ts",
      category: "workspace_state_inventory",
      proofSurface: "lcx-universe-index plus governance-autopilot owner receipts",
      boundary: "workspace state is evidence inventory, not a second runtime authority",
    },
    {
      id: "workspace_logs",
      inventory: workspaceLogs,
      routeOwner: "scripts/operator/lcx-universe-index.ts",
      category: "workspace_log_inventory",
      proofSurface: "lcx-universe-index plus the log-owning operator",
      boundary: "logs are evidence and diagnostics, not current truth without owner verification",
    },
    {
      id: "workspace_memory",
      inventory: workspaceMemory,
      routeOwner: "scripts/operator/lcx-universe-index.ts",
      category: "workspace_memory_inventory",
      proofSurface: "lcx-universe-index plus memory-sedimentation owners",
      boundary: "stored memory is not learned capability or protected-memory authorization",
    },
    {
      id: "workspace_tmp",
      inventory: workspaceTmp,
      routeOwner: "scripts/operator/lcx-universe-index.ts",
      category: "workspace_temporary_inventory",
      proofSurface: "lcx-universe-index plus exact artifact reference review",
      boundary: "temporary files are not source, runtime, training, or delivery authority",
    },
    {
      id: "live_sidecar",
      inventory: liveSidecar,
      routeOwner: "scripts/operator/lcx-external-channel-status.ts",
      category: "external_channel_runtime_inventory",
      proofSurface: "lcx-universe-index plus lcx-external-channel-status/binding",
      boundary: "sidecar inventory does not prove external-channel-bound or user-visible-observed",
    },
  ]);
  const governanceOwners = arrayValue(latestGovernance?.autoTriggeredOwnerCommands).filter(
    (item): item is string => typeof item === "string",
  );
  const unmatchedChangedFiles = arrayValue(changeImpact.unmatchedFiles);
  const governanceCoverage = buildRepoGovernanceCoverage(
    repoComponentFiles,
    governanceInventoryAreas,
  );
  const routeOwnerPaths = [
    ...new Set([
      ...governanceCoverage.components.flatMap((component) =>
        component.routeOwner ? [component.routeOwner] : [],
      ),
      ...governanceInventoryAreas.map((area) => area.routeOwner),
    ]),
  ];
  const missingRouteOwners = (
    await Promise.all(
      routeOwnerPaths.map(async (routeOwner) => {
        const exists = await fs
          .access(path.join(repoRoot, routeOwner))
          .then(() => true)
          .catch(() => false);
        return exists ? undefined : routeOwner;
      }),
    )
  ).filter((routeOwner): routeOwner is string => typeof routeOwner === "string");
  governanceCoverage.routeOwnerValidation = {
    checked: routeOwnerPaths,
    missing: missingRouteOwners,
  };
  governanceCoverage.status =
    governanceCoverage.status === "complete" && missingRouteOwners.length === 0
      ? "complete"
      : "incomplete";
  const reviewRequiredComponents = governanceCoverage.summary.reviewRequiredComponents;
  const result = {
    ok:
      trackedInventory.ok &&
      changeImpact.ok &&
      unmatchedChangedFiles.length === 0 &&
      governanceCoverage.status === "complete",
    boundary: "local_universe_index_only",
    checkedAt: new Date().toISOString(),
    repoRoot,
    latestStatePath: UNIVERSE_INDEX_LATEST_PATH,
    summary: {
      trackedFiles: trackedFiles.length,
      visibleFiles: rgFiles.length,
      trackedAndVisibleFiles: repoComponentFiles.length,
      dirtyFiles: gitStatus.changedFiles.length,
      untrackedFiles: gitStatus.untrackedFiles.length,
      workspaceArtifactFiles: artifactInventories.reduce(
        (sum, inventory) => sum + inventory.fileCount,
        0,
      ),
      liveSidecarFiles: liveSidecar.fileCount,
      unmatchedChangedFiles: unmatchedChangedFiles.length,
      staleRuntimeCandidates: staleRuntimeFiles.length,
      largeRuntimeCandidates: largeRuntimeFiles.length,
      staleSnapshots: staleSnapshots.length,
      governedRepoComponents: governanceCoverage.summary.governedComponents,
      inventoryOnlyRepoComponents: governanceCoverage.summary.inventoryOnlyComponents,
      reviewRequiredRepoComponents: reviewRequiredComponents,
    },
    repo: {
      branch: gitStatus.branch,
      trackedFileCount: trackedFiles.length,
      trackedInventory: trackedInventory.ok
        ? { ok: true }
        : { ok: false, error: trackedInventory.error },
      visibleFileCount: rgFiles.length,
      trackedAndVisibleFileCount: repoComponentFiles.length,
      dirtyFileCount: gitStatus.changedFiles.length,
      untrackedFileCount: gitStatus.untrackedFiles.length,
      topLevelCounts: countByTopLevel(repoComponentFiles),
      changedFiles: gitStatus.changedFiles,
      untrackedFiles: gitStatus.untrackedFiles,
    },
    ownerCoverage: {
      changeImpact,
      governanceCoverage,
      governanceOwners,
      governanceOwnerCount: governanceOwners.length,
      latestGovernanceBoundary: latestGovernance?.boundary,
      latestOperatorBoundary: latestOperator?.boundary,
    },
    artifacts: {
      workspaceState,
      workspaceLogs,
      workspaceMemory,
      workspaceTmp,
      liveSidecar,
    },
    garbageCandidates: {
      untrackedRepoFiles: gitStatus.untrackedFiles,
      unmatchedChangedFiles,
      staleRuntimeFiles,
      largeRuntimeFiles,
      staleSnapshots,
    },
    nextSafeCommands: !trackedInventory.ok
      ? ["repair Git access, verify git ls-files succeeds, then rerun universe index"]
      : unmatchedChangedFiles.length > 0
        ? [
            "extend scripts/operator/lcx-change-impact-plan.ts for unmatched files, then rerun universe index",
          ]
        : reviewRequiredComponents > 0
          ? [
              "add an explicit governance component rule for every review-required repo component, then rerun universe index",
            ]
          : [
              "node --import tsx scripts/operator/lcx-governance-autopilot.ts --json",
              "node --import tsx scripts/operator/lcx-context-recovery-exam.ts --json",
            ],
    note: "Inventory and governance coverage only: this owner finds files, classifies every repo-visible component, records artifacts, coverage gaps, and cleanup candidates; it never deletes, migrates live runtime, changes provider config, or touches protected memory.",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  if (options.write) {
    await fs.mkdir(path.dirname(UNIVERSE_INDEX_LATEST_PATH), { recursive: true });
    await fs.writeFile(UNIVERSE_INDEX_LATEST_PATH, `${JSON.stringify(result, null, 2)}\n`);
  }

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `LCX universe index: ok=${result.ok}`,
          `tracked=${result.summary.trackedFiles} visible=${result.summary.visibleFiles} dirty=${result.summary.dirtyFiles}`,
          `artifacts=${result.summary.workspaceArtifactFiles} liveSidecar=${result.summary.liveSidecarFiles}`,
          `unmatchedChangedFiles=${result.summary.unmatchedChangedFiles}`,
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

await main();
