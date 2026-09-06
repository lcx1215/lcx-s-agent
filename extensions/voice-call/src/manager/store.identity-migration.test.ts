import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLcxIdentityMigrationPlan } from "lcx-agent/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCallRecordForIdentityMigration,
  createLcxIdentityVoiceCallStoreMigration,
  readVoiceCallStoreForIdentityMigration,
  rollbackVoiceCallStoreIdentityMigration,
  type LcxIdentityVoiceCallStoreMigration,
} from "./store.js";

const roots: string[] = [];

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcx-voice-call-migration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function callRecord() {
  return {
    callId: "call-1",
    providerCallId: "provider-1",
    provider: "mock" as const,
    direction: "outbound" as const,
    state: "answered" as const,
    from: "+15550000000",
    to: "+15550000001",
    startedAt: 1,
    transcript: [],
    processedEventIds: [],
  };
}

describe("voice-call store identity migration writer", () => {
  it("reads legacy calls, appends to canonical state, backs up, and rolls back", async () => {
    const root = await createRoot();
    const legacyPath = path.join(root, ".openclaw", "voice-calls", "calls.jsonl");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify({ callId: "legacy-call" })}\n`, { mode: 0o600 });
    const migration: LcxIdentityVoiceCallStoreMigration = createLcxIdentityVoiceCallStoreMigration({
      migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
    });
    await expect(readVoiceCallStoreForIdentityMigration(migration)).resolves.toContain(
      "legacy-call",
    );
    const receipt = await appendCallRecordForIdentityMigration(migration, callRecord());
    const canonicalPath = path.join(root, ".lcx", "voice-calls", "calls.jsonl");
    expect(await readFile(canonicalPath, "utf8")).toContain("legacy-call");
    expect(await readFile(canonicalPath, "utf8")).toContain("call-1");
    expect(receipt.previous.exists).toBe(false);
    const next = await appendCallRecordForIdentityMigration(migration, {
      ...callRecord(),
      callId: "call-2",
    });
    expect(await readFile(`${canonicalPath}.bak`, "utf8")).toContain("call-1");
    await rollbackVoiceCallStoreIdentityMigration(next);
    expect(await readFile(canonicalPath, "utf8")).not.toContain("call-2");
    expect(await readFile(canonicalPath, "utf8")).toContain("call-1");
    const audit = await readFile(migration.pathContract.auditPath, "utf8");
    expect(audit).toContain('"writer":"channel-local"');
  });

  it("rejects multiple legacy roots", async () => {
    const root = await createRoot();
    for (const dirname of [".openclaw", ".clawdbot"]) {
      const filePath = path.join(root, dirname, "voice-calls", "calls.jsonl");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "legacy\n");
    }
    expect(() =>
      createLcxIdentityVoiceCallStoreMigration({
        migrationPlan: resolveLcxIdentityMigrationPlan({ env: {}, homedir: () => root }),
      }),
    ).toThrowError(expect.objectContaining({ code: "LCX_IDENTITY_SPLIT_STATE" }));
  });
});
