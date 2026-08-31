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
  },
  {
    id: "feishu_bot_ingress",
    path: "extensions/feishu/src/bot.ts",
    role: "message_adapter_entry",
  },
  {
    id: "feishu_reply_dispatcher",
    path: "extensions/feishu/src/reply-dispatcher.ts",
    role: "message_adapter_entry",
  },
  {
    id: "feishu_transport_sender",
    path: "extensions/feishu/src/send.ts",
    role: "message_adapter_entry",
  },
] as const;

type ProjectionReaderAuditEntry = ProjectionReaderEntry & {
  exists: boolean;
  usesReaderContract: boolean;
  readerIds: string[];
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

async function auditEntry(entry: ProjectionReaderEntry): Promise<ProjectionReaderAuditEntry> {
  try {
    const source = await fs.readFile(path.join(REPO_ROOT, entry.path), "utf8");
    const usesReaderContract = source.includes(READER_CONTRACT);
    return {
      ...entry,
      exists: true,
      usesReaderContract,
      readerIds: usesReaderContract ? readerIdsFromSource(source) : [],
      status: usesReaderContract ? "bound" : "missing_reader_contract",
    };
  } catch {
    return {
      ...entry,
      exists: false,
      usesReaderContract: false,
      readerIds: [],
      status: "missing_entrypoint",
    };
  }
}

async function main(): Promise<void> {
  const entries = await Promise.all(PROJECTION_READER_ENTRIES.map(auditEntry));
  const bound = entries.filter((entry) => entry.status === "bound");
  const missingReaderContract = entries.filter(
    (entry) => entry.status === "missing_reader_contract",
  );
  const missingEntrypoints = entries.filter((entry) => entry.status === "missing_entrypoint");
  const messageAdapters = entries.filter((entry) => entry.role === "message_adapter_entry");
  const boundMessageAdapters = messageAdapters.filter((entry) => entry.status === "bound");
  const coverage = entries.length === 0 ? 1 : bound.length / entries.length;
  const messageAdapterCoverage =
    messageAdapters.length === 0 ? 1 : boundMessageAdapters.length / messageAdapters.length;
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
      messageAdapterTotal: messageAdapters.length,
      messageAdapterBound: boundMessageAdapters.length,
      messageAdapterCoverage,
      messageAdapterCoverageStatus:
        boundMessageAdapters.length === messageAdapters.length ? "complete" : "missing",
      allKnownEntrypointsAudited: missingEntrypoints.length === 0,
      readerContractReadyForAllAdapters: missingReaderContract.length === 0,
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
        ? "Pass a validated projection candidate through the neutral answer boundary, then migrate message adapters one at a time and rerun this audit."
        : "Keep the reader contract mandatory for every new adapter entrypoint.",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
