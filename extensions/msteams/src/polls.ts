import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createLcxIdentityWriterPathContract,
  readLcxIdentityWriterRaw,
  rollbackLcxIdentityWriter,
  writeLcxIdentityWriterRawWithReceipt,
  LcxIdentityWriterContractError,
  type LcxIdentityWriteReceipt,
  type LcxIdentityWriterPathContract,
} from "../../../src/config/identity-migration.js";
import type { LcxIdentityMigrationPlan } from "../../../src/config/paths.js";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

export type MSTeamsPollVote = {
  pollId: string;
  selections: string[];
};

export type MSTeamsPoll = {
  id: string;
  question: string;
  options: string[];
  maxSelections: number;
  createdAt: string;
  updatedAt?: string;
  conversationId?: string;
  messageId?: string;
  votes: Record<string, string[]>;
};

export type MSTeamsPollStore = {
  createPoll: (poll: MSTeamsPoll) => Promise<void>;
  getPoll: (pollId: string) => Promise<MSTeamsPoll | null>;
  recordVote: (params: {
    pollId: string;
    voterId: string;
    selections: string[];
  }) => Promise<MSTeamsPoll | null>;
};

export type MSTeamsPollCard = {
  pollId: string;
  question: string;
  options: string[];
  maxSelections: number;
  card: Record<string, unknown>;
  fallbackText: string;
};

export type MSTeamsPollStoreData = {
  version: 1;
  polls: Record<string, MSTeamsPoll>;
};

const STORE_FILENAME = "msteams-polls.json";
const MAX_POLLS = 1000;
const POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeChoiceValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function extractSelections(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeChoiceValue).filter((entry): entry is string => Boolean(entry));
  }
  const normalized = normalizeChoiceValue(value);
  if (!normalized) {
    return [];
  }
  if (normalized.includes(",")) {
    return normalized
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [normalized];
}

function readNestedValue(value: unknown, keys: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key as keyof typeof current];
  }
  return current;
}

function readNestedString(value: unknown, keys: Array<string | number>): string | undefined {
  const found = readNestedValue(value, keys);
  return typeof found === "string" && found.trim() ? found.trim() : undefined;
}

export function extractMSTeamsPollVote(
  activity: { value?: unknown } | undefined,
): MSTeamsPollVote | null {
  const value = activity?.value;
  if (!value || !isRecord(value)) {
    return null;
  }
  const pollId =
    readNestedString(value, ["openclawPollId"]) ??
    readNestedString(value, ["pollId"]) ??
    readNestedString(value, ["openclaw", "pollId"]) ??
    readNestedString(value, ["openclaw", "poll", "id"]) ??
    readNestedString(value, ["data", "openclawPollId"]) ??
    readNestedString(value, ["data", "pollId"]) ??
    readNestedString(value, ["data", "openclaw", "pollId"]);
  if (!pollId) {
    return null;
  }

  const directSelections = extractSelections(value.choices);
  const nestedSelections = extractSelections(readNestedValue(value, ["choices"]));
  const dataSelections = extractSelections(readNestedValue(value, ["data", "choices"]));
  const selections =
    directSelections.length > 0
      ? directSelections
      : nestedSelections.length > 0
        ? nestedSelections
        : dataSelections;

  if (selections.length === 0) {
    return null;
  }

  return {
    pollId,
    selections,
  };
}

export function buildMSTeamsPollCard(params: {
  question: string;
  options: string[];
  maxSelections?: number;
  pollId?: string;
}): MSTeamsPollCard {
  const pollId = params.pollId ?? crypto.randomUUID();
  const maxSelections =
    typeof params.maxSelections === "number" && params.maxSelections > 1
      ? Math.floor(params.maxSelections)
      : 1;
  const cappedMaxSelections = Math.min(Math.max(1, maxSelections), params.options.length);
  const choices = params.options.map((option, index) => ({
    title: option,
    value: String(index),
  }));
  const hint =
    cappedMaxSelections > 1
      ? `Select up to ${cappedMaxSelections} option${cappedMaxSelections === 1 ? "" : "s"}.`
      : "Select one option.";

  const card = {
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: params.question,
        wrap: true,
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "Input.ChoiceSet",
        id: "choices",
        isMultiSelect: cappedMaxSelections > 1,
        style: "expanded",
        choices,
      },
      {
        type: "TextBlock",
        text: hint,
        wrap: true,
        isSubtle: true,
        spacing: "Small",
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Vote",
        data: {
          openclawPollId: pollId,
          pollId,
        },
        msteams: {
          type: "messageBack",
          text: "openclaw poll vote",
          displayText: "Vote recorded",
          value: { openclawPollId: pollId, pollId },
        },
      },
    ],
  };

  const fallbackLines = [
    `Poll: ${params.question}`,
    ...params.options.map((option, index) => `${index + 1}. ${option}`),
  ];

  return {
    pollId,
    question: params.question,
    options: params.options,
    maxSelections: cappedMaxSelections,
    card,
    fallbackText: fallbackLines.join("\n"),
  };
}

export type MSTeamsPollStoreFsOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
};

function parseTimestamp(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pruneExpired(polls: Record<string, MSTeamsPoll>) {
  const cutoff = Date.now() - POLL_TTL_MS;
  const entries = Object.entries(polls).filter(([, poll]) => {
    const ts = parseTimestamp(poll.updatedAt ?? poll.createdAt) ?? 0;
    return ts >= cutoff;
  });
  return Object.fromEntries(entries);
}

function pruneToLimit(polls: Record<string, MSTeamsPoll>) {
  const entries = Object.entries(polls);
  if (entries.length <= MAX_POLLS) {
    return polls;
  }
  entries.sort((a, b) => {
    const aTs = parseTimestamp(a[1].updatedAt ?? a[1].createdAt) ?? 0;
    const bTs = parseTimestamp(b[1].updatedAt ?? b[1].createdAt) ?? 0;
    return aTs - bTs;
  });
  const keep = entries.slice(entries.length - MAX_POLLS);
  return Object.fromEntries(keep);
}

export function normalizeMSTeamsPollSelections(poll: MSTeamsPoll, selections: string[]) {
  const maxSelections = Math.max(1, poll.maxSelections);
  const mapped = selections
    .map((entry) => Number.parseInt(entry, 10))
    .filter((value) => Number.isFinite(value))
    .filter((value) => value >= 0 && value < poll.options.length)
    .map((value) => String(value));
  const limited = maxSelections > 1 ? mapped.slice(0, maxSelections) : mapped.slice(0, 1);
  return Array.from(new Set(limited));
}

export function createMSTeamsPollStoreFs(params?: MSTeamsPollStoreFsOptions): MSTeamsPollStore {
  const filePath = resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });
  const empty: MSTeamsPollStoreData = { version: 1, polls: {} };

  const readStore = async (): Promise<MSTeamsPollStoreData> => {
    const { value } = await readJsonFile<MSTeamsPollStoreData>(filePath, empty);
    const pruned = pruneToLimit(pruneExpired(value.polls ?? {}));
    return { version: 1, polls: pruned };
  };

  const writeStore = async (data: MSTeamsPollStoreData) => {
    await writeJsonFile(filePath, data);
  };

  const createPoll = async (poll: MSTeamsPoll) => {
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      data.polls[poll.id] = poll;
      await writeStore({ version: 1, polls: pruneToLimit(data.polls) });
    });
  };

  const getPoll = async (pollId: string) =>
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      return data.polls[pollId] ?? null;
    });

  const recordVote = async (params: { pollId: string; voterId: string; selections: string[] }) =>
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      const poll = data.polls[params.pollId];
      if (!poll) {
        return null;
      }
      const normalized = normalizeMSTeamsPollSelections(poll, params.selections);
      poll.votes[params.voterId] = normalized;
      poll.updatedAt = new Date().toISOString();
      data.polls[poll.id] = poll;
      await writeStore({ version: 1, polls: pruneToLimit(data.polls) });
      return poll;
    });

  return { createPoll, getPoll, recordVote };
}

export type LcxIdentityMSTeamsPollMigration = Readonly<{
  pathContract: LcxIdentityWriterPathContract & Readonly<{ writer: "channel-local" }>;
  readStorePath: string;
  writeStorePath: string;
}>;

function resolveMSTeamsPollReadRoot(
  migrationPlan: LcxIdentityMigrationPlan,
  existsSync: (candidate: string) => boolean,
): string {
  const writePath = path.join(migrationPlan.writeStateDir, STORE_FILENAME);
  if (existsSync(writePath)) {
    return migrationPlan.writeStateDir;
  }
  const legacyRoots = migrationPlan.readStateDirs.filter((root) => {
    if (path.resolve(root) === path.resolve(migrationPlan.writeStateDir)) {
      return false;
    }
    return existsSync(path.join(root, STORE_FILENAME));
  });
  if (legacyRoots.length > 1) {
    throw new LcxIdentityWriterContractError(
      `MSTeams poll state exists in multiple legacy roots: ${legacyRoots.join(", ")}`,
      "LCX_IDENTITY_SPLIT_STATE",
    );
  }
  return legacyRoots[0] ?? migrationPlan.readStateDir;
}

function resolveCurrentMSTeamsPollMigration(
  migration: LcxIdentityMSTeamsPollMigration,
): LcxIdentityWriterPathContract & Readonly<{ writer: "channel-local" }> {
  const plan = migration.pathContract.migrationPlan;
  if (!plan) {
    return migration.pathContract;
  }
  const readRoot = resolveMSTeamsPollReadRoot(plan, fs.existsSync);
  return createLcxIdentityWriterPathContract({
    writer: "channel-local",
    migrationPlan: plan,
    readPath: path.join(readRoot, STORE_FILENAME),
    writePath: migration.writeStorePath,
    backupPath: migration.pathContract.backupPath,
    auditPath: migration.pathContract.auditPath,
  });
}

export function createLcxIdentityMSTeamsPollMigration(params: {
  migrationPlan: LcxIdentityMigrationPlan;
  existsSync?: (candidate: string) => boolean;
}): LcxIdentityMSTeamsPollMigration {
  if (params.migrationPlan.mode === "explicit-config-override") {
    throw new Error("MSTeams poll migration requires a state-root authority");
  }
  const readRoot = resolveMSTeamsPollReadRoot(
    params.migrationPlan,
    params.existsSync ?? fs.existsSync,
  );
  const writeStorePath = path.join(params.migrationPlan.writeStateDir, STORE_FILENAME);
  const pathContract = createLcxIdentityWriterPathContract({
    writer: "channel-local",
    migrationPlan: params.migrationPlan,
    readPath: path.join(readRoot, STORE_FILENAME),
    writePath: writeStorePath,
  });
  return Object.freeze({
    pathContract,
    readStorePath: pathContract.readPath,
    writeStorePath,
  });
}

function parseMSTeamsPollStore(raw: string | null): MSTeamsPollStoreData {
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<MSTeamsPollStoreData>;
      if (
        parsed.version === 1 &&
        parsed.polls &&
        typeof parsed.polls === "object" &&
        !Array.isArray(parsed.polls)
      ) {
        return { version: 1, polls: parsed.polls as MSTeamsPollStoreData["polls"] };
      }
    } catch {
      // Treat malformed legacy state as empty, matching the runtime reader.
    }
  }
  return { version: 1, polls: {} };
}

export async function readMSTeamsPollStoreForIdentityMigration(
  migration: LcxIdentityMSTeamsPollMigration,
): Promise<MSTeamsPollStoreData> {
  return parseMSTeamsPollStore(
    await readLcxIdentityWriterRaw(resolveCurrentMSTeamsPollMigration(migration)),
  );
}

export async function writeMSTeamsPollStoreForIdentityMigration(
  migration: LcxIdentityMSTeamsPollMigration,
  store: MSTeamsPollStoreData,
  options?: { expectedReadPath?: string; expectedWritePath?: string },
): Promise<LcxIdentityWriteReceipt> {
  return await writeLcxIdentityWriterRawWithReceipt(
    resolveCurrentMSTeamsPollMigration(migration),
    `${JSON.stringify({ version: 1, polls: store.polls }, null, 2)}\n`,
    options,
  );
}

export async function rollbackMSTeamsPollIdentityMigration(
  receipt: LcxIdentityWriteReceipt,
): Promise<void> {
  await rollbackLcxIdentityWriter(receipt);
}
