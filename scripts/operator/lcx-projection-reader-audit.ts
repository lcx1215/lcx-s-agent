import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const READER_CONTRACT = "readGlobalEvidenceProjectionForAdapter";

type ProjectionReaderEntry = {
  id: string;
  path: string;
  role: "automation_reader" | "read_only_dashboard" | "answer_boundary" | "message_adapter_entry";
  binding?: "direct" | "delegated_to_neutral_answer_boundary";
};

const PROJECTION_READER_ENTRIES: readonly ProjectionReaderEntry[] = [
  {
    id: "governance_autopilot",
    path: "scripts/operator/lcx-governance-autopilot.ts",
    role: "automation_reader",
  },
  {
    id: "farm_web_dashboard",
    path: "scripts/operator/lcx-farm-web-server.ts",
    role: "read_only_dashboard",
  },
  {
    id: "neutral_answer_boundary",
    path: "src/auto-reply/reply/dispatch-from-config.ts",
    role: "answer_boundary",
    binding: "direct",
  },
] as const;

const COMMON_ANSWER_BOUNDARY = "src/auto-reply/reply/dispatch-from-config.ts";
const COMMON_ROUTER_FILES = new Set([
  "src/auto-reply/dispatch.ts",
  "src/auto-reply/reply/dispatch-from-config.ts",
  "src/auto-reply/reply/provider-dispatcher.ts",
]);

function isTestFile(filePath: string): boolean {
  return /(?:\.test|\.spec)\.ts$/u.test(filePath);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        result.push(absolutePath);
      }
    }
  }
  return result;
}

function usesCommonAnswerBoundary(source: string): boolean {
  const executableSource = stripComments(source);
  return (
    /\bdispatchInboundMessage(?:WithBufferedDispatcher|WithDispatcher)?\s*\(/u.test(
      executableSource,
    ) ||
    /(?:^|\.)dispatchReplyFromConfig\s*\(/u.test(executableSource) ||
    /\bdispatchReplyWith(?:BufferedBlockDispatcher|Dispatcher)\s*\(/u.test(executableSource)
  );
}

function relativeRepoPath(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

async function discoverMessageAdapterEntries(): Promise<ProjectionReaderEntry[]> {
  const candidates = (
    await Promise.all(
      ["src", "extensions"].map((root) => listTypeScriptFiles(path.join(REPO_ROOT, root))),
    )
  ).flat();
  const entries: ProjectionReaderEntry[] = [];
  for (const absolutePath of candidates) {
    const relativePath = relativeRepoPath(absolutePath);
    if (COMMON_ROUTER_FILES.has(relativePath) || isTestFile(relativePath)) {
      continue;
    }
    let source: string;
    try {
      source = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (!usesCommonAnswerBoundary(source)) {
      continue;
    }
    entries.push({
      id: `message_adapter:${relativePath.replace(/\.ts$/u, "").replaceAll("/", ":")}`,
      path: relativePath,
      role: "message_adapter_entry",
      binding: "delegated_to_neutral_answer_boundary",
    });
  }
  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
}

type ProjectionReaderAuditEntry = ProjectionReaderEntry & {
  exists: boolean;
  usesReaderContract: boolean;
  passesAdapterProjectionInput: boolean;
  delegatedToAnswerBoundary: boolean;
  /** Direct source-level contract use; delegation is reported separately. */
  directReaderBinding: boolean;
  bindingMode: "direct" | "delegated_to_neutral_answer_boundary" | "missing";
  readerIds: string[];
  readerIdStrategy: "literal" | "message_context_surface_or_provider";
  status: "bound" | "missing_reader_contract" | "missing_entrypoint";
};

function readerIdsFromSource(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/adapterId:\s*["']([^"']+)["']/gu)]
        .map((match) => match[1]?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

async function auditEntry(
  entry: ProjectionReaderEntry,
  answerBoundaryReady: boolean,
): Promise<ProjectionReaderAuditEntry> {
  try {
    const source = await fs.readFile(path.join(REPO_ROOT, entry.path), "utf8");
    const executableSource = stripComments(source);
    const usesReaderContract = executableSource.includes(READER_CONTRACT);
    const passesAdapterProjectionInput =
      /\bglobalEvidenceProjectionInput\s*:\s*\{[^}]*\badapterId\s*:/su.test(executableSource);
    const delegatedToAnswerBoundary =
      entry.binding === "delegated_to_neutral_answer_boundary" && answerBoundaryReady;
    const directReaderBinding = usesReaderContract || passesAdapterProjectionInput;
    const bindingMode = directReaderBinding
      ? "direct"
      : delegatedToAnswerBoundary
        ? "delegated_to_neutral_answer_boundary"
        : "missing";
    const readerIdStrategy = directReaderBinding
      ? "literal"
      : "message_context_surface_or_provider";
    return {
      ...entry,
      exists: true,
      usesReaderContract,
      passesAdapterProjectionInput,
      delegatedToAnswerBoundary,
      directReaderBinding,
      bindingMode,
      readerIds: directReaderBinding ? readerIdsFromSource(executableSource) : [],
      readerIdStrategy,
      status:
        directReaderBinding || delegatedToAnswerBoundary ? "bound" : "missing_reader_contract",
    };
  } catch {
    return {
      ...entry,
      exists: false,
      usesReaderContract: false,
      passesAdapterProjectionInput: false,
      delegatedToAnswerBoundary: false,
      directReaderBinding: false,
      bindingMode: "missing",
      readerIds: [],
      readerIdStrategy: "message_context_surface_or_provider",
      status: "missing_entrypoint",
    };
  }
}

async function main(): Promise<void> {
  const discoveredMessageAdapters = await discoverMessageAdapterEntries();
  const knownEntries = [
    ...PROJECTION_READER_ENTRIES,
    ...discoveredMessageAdapters.filter(
      (candidate) => !PROJECTION_READER_ENTRIES.some((entry) => entry.path === candidate.path),
    ),
  ];
  const answerBoundarySource = await fs.readFile(
    path.join(REPO_ROOT, COMMON_ANSWER_BOUNDARY),
    "utf8",
  );
  const answerBoundaryReady =
    answerBoundarySource.includes(READER_CONTRACT) &&
    answerBoundarySource.includes("readCanonicalGlobalEvidenceProjectionCandidate");
  const entries = await Promise.all(
    knownEntries.map((entry) => auditEntry(entry, answerBoundaryReady)),
  );
  const bound = entries.filter((entry) => entry.status === "bound");
  const missingReaderContract = entries.filter(
    (entry) => entry.status === "missing_reader_contract",
  );
  const missingEntrypoints = entries.filter((entry) => entry.status === "missing_entrypoint");
  const messageAdapters = entries.filter((entry) => entry.role === "message_adapter_entry");
  const boundMessageAdapters = messageAdapters.filter((entry) => entry.status === "bound");
  const directBound = entries.filter((entry) => entry.directReaderBinding);
  const directMessageAdapters = messageAdapters.filter((entry) => entry.directReaderBinding);
  const delegatedMessageAdapters = messageAdapters.filter(
    (entry) => entry.delegatedToAnswerBoundary,
  );
  const messageAdapterBindingMode =
    directMessageAdapters.length === messageAdapters.length
      ? "direct"
      : directMessageAdapters.length === 0 &&
          delegatedMessageAdapters.length === messageAdapters.length
        ? "delegated_to_neutral_answer_boundary"
        : "mixed";
  const coverage = entries.length === 0 ? 1 : bound.length / entries.length;
  const directCoverage = entries.length === 0 ? 1 : directBound.length / entries.length;
  const messageAdapterCoverage =
    messageAdapters.length === 0 ? 1 : boundMessageAdapters.length / messageAdapters.length;
  const messageAdapterDirectCoverage =
    messageAdapters.length === 0 ? 1 : directMessageAdapters.length / messageAdapters.length;
  const result = {
    ok: missingEntrypoints.length === 0,
    boundary: "local_projection_reader_audit_only",
    checkedAt: new Date().toISOString(),
    contract: READER_CONTRACT,
    entries,
    summary: {
      total: entries.length,
      bound: bound.length,
      missingReaderContract: missingReaderContract.length,
      missingEntrypoints: missingEntrypoints.length,
      coverage,
      coverageStatus: missingReaderContract.length === 0 ? "complete" : "partial",
      directReaderBound: directBound.length,
      directReaderCoverage: directCoverage,
      directReaderCoverageStatus: directBound.length === entries.length ? "complete" : "partial",
      messageAdapterTotal: messageAdapters.length,
      messageAdapterBound: boundMessageAdapters.length,
      messageAdapterCoverage,
      messageAdapterCoverageStatus:
        boundMessageAdapters.length === messageAdapters.length ? "complete" : "missing",
      messageAdapterDirectBound: directMessageAdapters.length,
      messageAdapterDirectCoverage,
      messageAdapterDirectCoverageStatus:
        directMessageAdapters.length === messageAdapters.length ? "complete" : "partial",
      messageAdapterBindingMode,
      allKnownEntrypointsAudited: missingEntrypoints.length === 0,
      readerContractReadyForAllAdapters: missingReaderContract.length === 0,
      answerBoundaryReady,
      discoveredMessageAdapterTotal: discoveredMessageAdapters.length,
    },
    missingReaderContract: missingReaderContract.map((entry) => ({
      id: entry.id,
      path: entry.path,
      role: entry.role,
      nextAction:
        "Provide projection input at the upstream boundary and use the opaque reader contract; do not add sender or fact authority here.",
    })),
    nextAction:
      missingReaderContract.length > 0
        ? "Route each missing communication adapter through the neutral answer boundary and rerun this audit."
        : "Keep every communication adapter on the neutral answer boundary; derive reader identity from surface/provider and keep transport senders fact-blind.",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
