import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distillRolloutSummaries } from "./rollout-distill.js";
import {
  ROLLOUT_INDEX_REL_PATH,
  ROLLOUT_RAW_REL_PATH,
  ROLLOUT_SUMMARY_REL_DIR,
  buildRolloutSummaryDocument,
  resolveRolloutSummaryDir,
  writeRolloutSummary,
} from "./rollout-summary.js";

const TASK_TOKEN = "ZZQ-TOKEN-ALPHA";
const ANSWER_TOKEN = "ZZQ-TOKEN-OMEGA";

function sampleMessages(): unknown[] {
  return [
    { role: "user", content: [{ type: "text", text: `please fix ${TASK_TOKEN} now` }] },
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: "exec" },
        { type: "toolCall", name: "read" },
        { type: "text", text: `all done ${ANSWER_TOKEN}` },
      ],
    },
  ];
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-rollout-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function listSummaries(): Promise<string[]> {
  try {
    return (await fs.readdir(resolveRolloutSummaryDir(workspace))).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
}

describe("writeRolloutSummary", () => {
  it("writes one digest per session containing the task, outcome and tool steps", async () => {
    const result = await writeRolloutSummary({
      workspaceDir: workspace,
      sessionId: "session-aaaa-1111",
      sessionKey: "agent:main:main",
      agentId: "main",
      runId: "run-1",
      outcome: "success",
      durationMs: 1234,
      messages: sampleMessages(),
    });

    expect(result.ok).toBe(true);
    const names = await listSummaries();
    expect(names).toEqual(["session-aaaa-1111.md"]);

    const raw = await fs.readFile(path.join(resolveRolloutSummaryDir(workspace), names[0]), "utf8");
    expect(raw).toContain("session_id: session-aaaa-1111");
    expect(raw).toContain(TASK_TOKEN);
    expect(raw).toContain(ANSWER_TOKEN);
    expect(raw).toContain("## Key steps");
    expect(raw).toContain("- exec");
    expect(raw).toContain("- read");
  });

  it("rewrites the same file instead of piling up one artifact per run", async () => {
    for (const runId of ["run-1", "run-2", "run-3"]) {
      const res = await writeRolloutSummary({
        workspaceDir: workspace,
        sessionId: "session-bbbb-2222",
        runId,
        outcome: "success",
        messages: sampleMessages(),
      });
      expect(res.ok).toBe(true);
    }
    const names = await listSummaries();
    expect(names).toHaveLength(1);
  });

  it("records failures without inventing a successful outcome", async () => {
    const result = await writeRolloutSummary({
      workspaceDir: workspace,
      sessionId: "session-cccc-3333",
      outcome: "error",
      error: "model timeout",
      messages: sampleMessages(),
    });
    expect(result.ok).toBe(true);
    const raw = await fs.readFile(
      path.join(resolveRolloutSummaryDir(workspace), "session-cccc-3333.md"),
      "utf8",
    );
    expect(raw).toContain("outcome: error");
    expect(raw).toContain("Failed: model timeout");
  });

  it("degrades instead of throwing when the session id is missing", async () => {
    const result = await writeRolloutSummary({
      workspaceDir: workspace,
      outcome: "success",
      messages: sampleMessages(),
    });
    expect(result).toEqual({ ok: false, reason: "sessionId missing" });
    expect(await listSummaries()).toEqual([]);
  });
});

describe("buildRolloutSummaryDocument", () => {
  it("falls back to explicit placeholders when no message text is captured", () => {
    const doc = buildRolloutSummaryDocument({
      sessionId: "session-dddd-4444",
      outcome: "success",
      cwd: "/tmp/ws",
      now: new Date("2026-09-20T00:00:00.000Z"),
      messages: [{ role: "user", content: [] }],
    });
    expect(doc).toContain("(no user message captured)");
    expect(doc).toContain("(no assistant message captured)");
  });
});

describe("distillRolloutSummaries", () => {
  it("builds an index and a raw memory file from the digests", async () => {
    await writeRolloutSummary({
      workspaceDir: workspace,
      sessionId: "session-eeee-5555",
      outcome: "success",
      messages: sampleMessages(),
    });

    const result = await distillRolloutSummaries(workspace);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.count).toBe(1);

    const index = await fs.readFile(path.join(workspace, ROLLOUT_INDEX_REL_PATH), "utf8");
    const raw = await fs.readFile(path.join(workspace, ROLLOUT_RAW_REL_PATH), "utf8");
    expect(index).toContain("session-eeee-5555");
    expect(index).toContain(`${ROLLOUT_SUMMARY_REL_DIR}/session-eeee-5555.md`);
    expect(raw).toContain(TASK_TOKEN);
  });

  it("reports a clear reason when there is nothing to distill", async () => {
    const result = await distillRolloutSummaries(workspace);
    expect(result).toEqual({ ok: false, reason: "no summaries" });
  });
});
