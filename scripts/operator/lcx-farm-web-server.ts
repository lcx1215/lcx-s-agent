import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const staticRoot = path.join(repoRoot, "apps/web/lcx-agent-farm");
const stateRoot = path.join(os.homedir(), ".openclaw/workspace/state");

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1] ?? fallback;
}

const port = Number(argValue("--port", process.env.LCX_FARM_WEB_PORT ?? "4788"));
const host = argValue("--host", process.env.LCX_FARM_WEB_HOST ?? "127.0.0.1");

function readJson(filePath: string): JsonObject {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function objectAt(root: JsonObject, ...keys: string[]): JsonObject {
  let current: unknown = root;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return {};
    }
    current = (current as JsonObject)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as JsonObject)
    : {};
}

function stringAt(root: JsonObject, ...keys: string[]): string | undefined {
  let current: unknown = root;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as JsonObject)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function numberAt(root: JsonObject, ...keys: string[]): number | undefined {
  let current: unknown = root;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as JsonObject)[key];
  }
  return typeof current === "number" ? current : undefined;
}

function stringArrayAt(root: JsonObject, ...keys: string[]): string[] {
  let current: unknown = root;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return [];
    }
    current = (current as JsonObject)[key];
  }
  return Array.isArray(current)
    ? current.filter((item): item is string => typeof item === "string")
    : [];
}

function numberMapAt(root: JsonObject, ...keys: string[]): Record<string, number> {
  const value = objectAt(root, ...keys);
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function lastPath(value: string | undefined): string {
  if (!value) {
    return "not available";
  }
  return path.basename(value);
}

function sshConfigStatus(): string {
  const sshConfig = path.join(os.homedir(), ".ssh/config");
  if (!fs.existsSync(sshConfig)) {
    return "missing_ssh_config";
  }
  const raw = fs.readFileSync(sshConfig, "utf8");
  return /^\s*Host\s+\S+/m.test(raw) ? "ssh_hosts_available" : "ssh_config_has_no_concrete_host";
}

function loadSnapshot(): JsonObject {
  const autopilot = readJson(path.join(stateRoot, "lcx-governance-autopilot-latest.json"));
  const digest = readJson(path.join(stateRoot, "lcx-evolution-promotion-digest-latest.json"));
  const ownerBrief = readJson(path.join(stateRoot, "lcx-owner-brief-latest.json"));
  const ownerControlMap = readJson(path.join(stateRoot, "lcx-owner-control-map-latest.json"));
  const localFailureTrace = readJson(path.join(stateRoot, "lcx-local-failure-trace-latest.json"));
  const monotonicLedger = readJson(path.join(stateRoot, "lcx-monotonic-data-ledger-latest.json"));
  const realCostLedger = readJson(path.join(stateRoot, "lcx-real-cost-ledger-latest.json"));
  const summary = objectAt(autopilot, "summary");
  const owners = objectAt(autopilot, "owners");
  const providerCouncilOwner = objectAt(owners, "providerCouncilAcceleration");
  const material = objectAt(digest, "material");
  const candidate = objectAt(material, "latestCandidateEval");
  const activePidCounts = numberMapAt(material, "activePidCounts");
  const providerBlocks = stringArrayAt(material, "providerCouncilAccelerationHardBlocks");
  const providerDailyUseFromDigest = objectAt(material, "providerCouncilAccelerationDailyUse");
  const providerDailyUse =
    Object.keys(providerDailyUseFromDigest).length > 0
      ? providerDailyUseFromDigest
      : objectAt(providerCouncilOwner, "dailyUse");
  const externalChannelMissingProof =
    stringArrayAt(material, "externalChannelMissingProof").length > 0
      ? stringArrayAt(material, "externalChannelMissingProof")
      : stringArrayAt(material, "liveBindingMissingProof");
  const parseRecovered = stringArrayAt(candidate, "parseRecoveredCaseIds");
  const controlItems = Array.isArray(ownerControlMap.items) ? ownerControlMap.items : [];

  return {
    checkedAt: stringAt(digest, "checkedAt") ?? stringAt(autopilot, "checkedAt") ?? "not_available",
    repoDirtyCount:
      numberAt(material, "repoDirtyCount") ?? numberAt(summary, "universeIndexDirtyFiles") ?? 0,
    activePidCounts,
    activeHeavyCount: Object.values(activePidCounts).reduce((sum, count) => sum + count, 0),
    selectedCleanAdapter: lastPath(stringAt(material, "selectedCleanAdapter")),
    candidateAdapter: lastPath(stringAt(candidate, "adapterPath")),
    promotionReady: Boolean(candidate.promotionReady),
    failedCaseIds: stringArrayAt(candidate, "failedCaseIds"),
    parseRecoveredCaseIds: parseRecovered,
    externalChannelStatus:
      stringAt(material, "externalChannelBindingStatus") ??
      stringAt(material, "liveLarkBrainBindingStatus") ??
      "unknown",
    liveStatus:
      stringAt(material, "externalChannelBindingStatus") ??
      stringAt(material, "liveLarkBrainBindingStatus") ??
      "unknown",
    externalChannelMissingProof,
    liveMissingProof: externalChannelMissingProof,
    skillOptStatus:
      stringAt(material, "skillOptLiteStatus") ??
      stringAt(summary, "skillOptLiteStatus") ??
      "unknown",
    skillOptSkills: stringArrayAt(material, "skillOptLiteMatchedSkillIds"),
    blacktechRouted:
      numberAt(material, "externalUpgradeBlacktechAutopilotRoutedCount") ??
      numberAt(summary, "externalUpgradeBlacktechAutopilotRoutedCount") ??
      0,
    blacktechTotal:
      numberAt(material, "externalUpgradeBlacktechMechanismCount") ??
      numberAt(summary, "externalUpgradeBlacktechMechanismCount") ??
      0,
    providerStatus: stringAt(material, "providerCouncilAccelerationStatus") ?? "unknown",
    providerBlocks,
    providerDailyUse,
    ownerBriefHeadline: stringAt(ownerBrief, "headline") ?? "老板总览暂未生成",
    ownerBriefMarkdownPath:
      stringAt(ownerBrief, "latestMarkdownPath") ??
      path.join(stateRoot, "lcx-owner-brief-latest.md"),
    ownerControlMarkdownPath:
      stringAt(ownerControlMap, "latestMarkdownPath") ??
      path.join(stateRoot, "lcx-owner-control-map-latest.md"),
    controlSummary: objectAt(ownerControlMap, "summary"),
    controlItems,
    realCostLedger: {
      summary: objectAt(realCostLedger, "summary"),
      byModel: Array.isArray(realCostLedger.byModel) ? realCostLedger.byModel : [],
      latestMarkdownPath:
        stringAt(realCostLedger, "latestMarkdownPath") ??
        path.join(stateRoot, "lcx-real-cost-ledger-latest.md"),
    },
    failureTrace: {
      result: stringAt(localFailureTrace, "result") ?? "unknown",
      firstFailedGate: stringAt(localFailureTrace, "firstFailedGate") ?? "none",
      canBecomeTrainingMaterial: Boolean(localFailureTrace.canBecomeTrainingMaterial),
      nextSafeAction: stringAt(localFailureTrace, "nextSafeAction") ?? "review_first_failed_gate",
    },
    evolution: {
      datasetExamples:
        numberAt(monotonicLedger, "summary", "datasetExamples") ??
        numberAt(material, "monotonicDataLedgerDatasetExamples") ??
        numberAt(summary, "monotonicDataLedgerDatasetExamples") ??
        0,
      trainSliceWritten:
        numberAt(monotonicLedger, "summary", "trainSliceWritten") ??
        numberAt(material, "monotonicDataLedgerTrainSliceWritten") ??
        numberAt(summary, "monotonicDataLedgerTrainSliceWritten") ??
        0,
      acceptedSkillOptPackets:
        numberAt(monotonicLedger, "summary", "acceptedSkillOptPackets") ??
        numberAt(material, "monotonicDataLedgerAcceptedSkillOptPackets") ??
        numberAt(summary, "monotonicDataLedgerAcceptedSkillOptPackets") ??
        0,
      blockedAdapterCandidates:
        numberAt(monotonicLedger, "summary", "blockedAdapterCandidates") ??
        numberAt(material, "monotonicDataLedgerBlockedAdapterCandidates") ??
        numberAt(summary, "monotonicDataLedgerBlockedAdapterCandidates") ??
        0,
    },
    nextAction:
      stringAt(material, "fastestSafeNextAction") ??
      stringAt(summary, "fastestSafeNextAction") ??
      "refresh_owner_state",
    remoteDevboxStatus: sshConfigStatus(),
    lockedComputerUseStatus: "manual_codex_settings_required",
    webFrontendRole:
      "browser-testable farm dashboard for Codex in-app browser, mobile remote review, screenshots, and read-only control-room visibility",
    notAuthority:
      "Web dashboard is read-only visualization. Owner JSON remains the truth; no external-channel/provider/protected memory authority.",
  };
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body, null, 2));
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (requestUrl.pathname === "/api/farm-snapshot") {
    sendJson(response, 200, loadSnapshot());
    return;
  }

  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const resolved = path.resolve(staticRoot, relativePath);
  if (
    !resolved.startsWith(staticRoot) ||
    !fs.existsSync(resolved) ||
    fs.statSync(resolved).isDirectory()
  ) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentType(resolved),
    "cache-control": "no-store",
  });
  fs.createReadStream(resolved).pipe(response);
});

server.listen(port, host, () => {
  console.log(`LCX Agent Farm web dashboard: http://${host}:${port}`);
});
